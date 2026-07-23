const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');

/**
 * LlamaCppManager — the local AI engine.
 *
 * Runs llama.cpp's `llama-server`, which exposes an OpenAI-compatible
 * /v1/chat/completions endpoint — so chat traffic reuses the exact
 * openaiRequest/openaiStreamRequest path the custom-server provider uses,
 * pointed at 127.0.0.1:<port>. There is no model registry and
 * no daemon that hot-swaps models: one server process serves one GGUF file,
 * so switching models means restarting the process (ensureModel handles it).
 *
 * Everything lives under ~/.anjadhe_llamacpp/ — deliberately OUTSIDE
 * ANJADHE_DATA_ROOT, following the ~/.ollama precedent: model weights are
 * multi-gigabyte machine assets, not app data, and blank-slate testing
 * shouldn't force a 7 GB re-download.
 *   engine/       extracted llama.cpp release binaries (llama-server + dylibs)
 *   models/       downloaded *.gguf files
 *   models.json   catalog-name -> {file} map for GGUFs we downloaded
 */
const LlamaCppManager = {
    process: null,
    port: 18434,          // dedicated port, away from Ollama's 11434-11440 and the custom-server scan list
    isReady: false,
    loadedModel: null,    // catalog name served by the running process
    loadedCtx: 0,         // -c value the running process was started with
    apiKey: null,         // per-spawn random key — see _spawn
    _quitting: false,
    _loading: null,       // in-flight ensureModel promise — coalesces racing callers
    _cachedBinaryPath: null,
    _cachedVersion: null,
    onActivity: null,     // (state, modelName) — set by main.js for the AI Activity feed

    _notifyActivity(state, modelName) {
        try { if (this.onActivity) this.onActivity(state, modelName); } catch { /* feed is best-effort */ }
    },

    home: path.join(os.homedir(), '.anjadhe_llamacpp'),
    get engineDir() { return path.join(this.home, 'engine'); },
    get modelsDir() { return path.join(this.home, 'models'); },
    get mapFile() { return path.join(this.home, 'models.json'); },

    /**
     * Find llama-server: our managed install first, then PATH / Homebrew for
     * users who already have llama.cpp. Same GUI-app PATH caveat as Ollama.
     */
    getBinaryPath() {
        // Cached once found — this runs on every status poll and the PATH
        // lookup below is an execSync (blocks the main process). A miss is
        // never cached so a fresh install is still detected.
        if (this._cachedBinaryPath && fs.existsSync(this._cachedBinaryPath)) {
            return this._cachedBinaryPath;
        }
        const found = this._findBinaryPath();
        if (found) this._cachedBinaryPath = found;
        return found;
    },

    _findBinaryPath() {
        const managed = path.join(this.engineDir, 'llama-server');
        if (fs.existsSync(managed)) return managed;
        try {
            const cmd = process.platform === 'win32' ? 'where llama-server' : 'which llama-server';
            const systemPath = execSync(cmd, { encoding: 'utf8' }).trim().split('\n')[0];
            if (systemPath && fs.existsSync(systemPath)) return systemPath;
        } catch {}
        const candidates = [
            '/opt/homebrew/bin/llama-server',   // Homebrew Apple Silicon
            '/usr/local/bin/llama-server'       // Homebrew Intel / manual
        ];
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) return candidate;
        }
        return null;
    },

    /** GET /health — llama-server returns 503 while loading, 200 when ready. */
    _checkHealth(port, timeoutMs = 2000) {
        return new Promise((resolve) => {
            const req = http.request({
                hostname: '127.0.0.1', port, path: '/health', method: 'GET', timeout: timeoutMs
            }, (res) => {
                res.resume();
                if (res.statusCode === 200) resolve('ready');
                else if (res.statusCode === 503) resolve('loading');
                else resolve('other');
            });
            req.on('error', () => resolve('free'));
            req.on('timeout', () => { req.destroy(); resolve('free'); });
            req.end();
        });
    },

    /**
     * Probe an endpoint that requires OUR api key (GET /v1/models). /health
     * can't tell our server from a stale llama-server orphaned by a crashed
     * session — both answer 200 — but only the process we just spawned knows
     * this spawn's key, so an authenticated 200 is proof of identity.
     */
    _checkOwn(port, timeoutMs = 2000) {
        return new Promise((resolve) => {
            const req = http.request({
                hostname: '127.0.0.1', port, path: '/v1/models', method: 'GET', timeout: timeoutMs,
                headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}
            }, (res) => { res.resume(); resolve(res.statusCode); });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.end();
        });
    },

    /**
     * Wait for the server WE spawned to finish loading the model. A 12B Q4
     * GGUF takes tens of seconds to map + upload to Metal, so this is
     * generous: the clock only counts while the process is alive. Requires
     * an authenticated 200 (see _checkOwn) — a plain /health 200 could be a
     * leftover server from a previous session answering on our port.
     */
    async _waitForReady(port, retries = 180) {
        for (let i = 0; i < retries; i++) {
            if (!this.process) return false; // crashed during load
            if ((await this._checkOwn(port)) === 200) return true;
            await new Promise(r => setTimeout(r, 1000));
        }
        return false;
    },

    /**
     * Reclaim our dedicated port from a stale llama-server. Happens when a
     * previous app session died without will-quit (force quit, crash, or the
     * old pre-coalescing thrash bug leaking a process reference): the orphan
     * keeps the model's RAM and the port, and it's useless to us — every
     * spawn mints a fresh api key, so the orphan rejects our requests.
     * Only processes that answer /health like a llama-server are touched.
     */
    async _reclaimPort(port) {
        const status = await this._checkHealth(port);
        if (status === 'free') return true;
        if (status !== 'ready' && status !== 'loading') return false; // not a llama-server — leave it alone
        let pids = [];
        try {
            // -sTCP:LISTEN: the listener only. A bare tcp:<port> also lists
            // CLIENTS with an open connection to the port — including this
            // very process right after the health probe above.
            pids = execSync(`/usr/sbin/lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number);
        } catch {}
        pids = pids.filter(pid => pid !== process.pid);
        if (!pids.length) return false;
        console.log(`[llamacpp] Reclaiming port ${port} from stale llama-server (pid ${pids.join(', ')})`);
        for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
        for (let i = 0; i < 20; i++) {
            // eslint-disable-next-line no-await-in-loop
            if ((await this._checkHealth(port)) === 'free') return true;
            if (i === 10) for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
            // eslint-disable-next-line no-await-in-loop
            await new Promise(r => setTimeout(r, 500));
        }
        return (await this._checkHealth(port)) === 'free';
    },

    /**
     * Derive the -c (context) value. llama-server's default (-c 0) loads the
     * model's FULL trained context — 256K on gemma4:12b, which alone would
     * exhaust a 16 GB Mac's unified memory. So an explicit cap is mandatory.
     * Uses the user's numCtx override when set, else RAM tiers.
     *
     * These tiers MUST return the same value as AgentService.autoNumCtx for
     * every RAM size — one process serves one (model, ctx) pair, so any
     * caller resolving a DIFFERENT auto value restarts the server and pays a
     * full model reload. That exact bug shipped once: chat sent the agent's
     * 16K on a 24–32 GB Mac while engine-side background calls (email
     * insights) resolved 32K here, so the server thrashed a ~60 s reload on
     * nearly every alternation and every AI call felt minutes-slow.
     */
    _resolveCtx(numCtx) {
        if (numCtx && Number.isFinite(numCtx) && numCtx > 0) return Math.floor(numCtx);
        const totalMemGB = Math.round(os.totalmem() / 1024 / 1024 / 1024);
        if (totalMemGB <= 8) return 4096;
        if (totalMemGB <= 32) return 16384;
        return 32768;
    },

    _spawn(binaryPath, port, ggufPath, alias, ctx) {
        // Fresh random key per spawn. Without one llama-server answers any
        // origin (CORS *), so a hostile web page in a browser could reach the
        // localhost endpoint; the key closes that. /health stays keyless, so
        // readiness checks are unaffected.
        this.apiKey = crypto.randomBytes(24).toString('hex');
        const args = [
            '-m', ggufPath,
            '--host', '127.0.0.1',
            '--port', String(port),
            '-c', String(ctx),
            '-ngl', '99',          // offload every layer to Metal/GPU
            '--jinja',             // model's chat template — required for tool calling
            '--alias', alias,      // /v1 model id = catalog name, so params.model matches
            '--api-key', this.apiKey,
            // Prefill/latency tuning. The agent ships a multi-thousand-token
            // prefix (system prompt + tool schemas) on every conversation, so
            // prompt-eval speed and cache reuse dominate perceived latency:
            '-ub', '1024',         // bigger physical batch ≈ faster prompt eval on Metal
            '--cache-reuse', '256', // KV-shift partial prefix reuse when the tool list drifts between turns
                                    // (probe-verified on b10015: a mid-prefix byte change re-prefills only
                                    // ~200 tokens instead of everything after it; works with q8_0 KV)
            // Host-RAM prompt cache (--cache-idle-slots is on by default and
            // REQUIRES this): when the email-insights slot takes a task, the
            // idle chat slot's KV state parks here and restores on the next
            // message instead of re-prefilling. The build's default cap is
            // 8192 MiB — reckless next to a 7 GB model on a 16 GB Mac (a 12B
            // model's parked KV runs ~100-200 KB/token, so states are hundreds
            // of MB each, and macOS swap costs more than a re-prefill). Cap by
            // RAM tier: room for ~1 parked prefix on 16 GB, a few on bigger
            // machines.
            '--cache-ram', String(Math.round(os.totalmem() / 1024 / 1024 / 1024) <= 16 ? 1024 : 4096),
            // 8-bit KV cache (needs flash attention on): halves cache memory
            // per token vs f16 with imperceptible quality cost — same setting
            // Ollama runs (OLLAMA_KV_CACHE_TYPE=q8_0). This is what pays for
            // the doubled RAM tiers in _resolveCtx (16K on a 16 GB Mac).
            '-fa', 'on',
            '-ctk', 'q8_0',
            '-ctv', 'q8_0',
            '-np', '2',            // chat + one background task (email insights) without evicting each other's prompt cache
            // An explicit -np disables the unified KV pool, which SPLITS -c
            // across slots (8192 became 4096/request — real chats overflowed).
            // Unified restores the full window per slot, shared as one pool.
            '--kv-unified',
            '--no-webui'
        ];
        const child = spawn(binaryPath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false
        });
        child.stdout.on('data', (d) => console.log('[llamacpp]', d.toString().trim()));
        child.stderr.on('data', (d) => console.log('[llamacpp]', d.toString().trim()));
        child.on('exit', (code) => {
            console.log(`[llamacpp] Process exited with code ${code}`);
            // Only report a stop when the exiting process was still the
            // current one — a restart's old process exits after the new spawn
            // took over, and reporting that would look like an unload.
            if (this.process === child || this.process === null) {
                this._notifyActivity('stopped', alias);
            }
            this.process = null;
            this.isReady = false;
            this.loadedModel = null;
            // No auto-restart: a llama-server exit usually means the model
            // didn't fit or the GGUF is bad — restarting would thrash RAM.
        });
        return child;
    },

    /**
     * Make sure llama-server is running and serving `modelName` with the
     * wanted context size. Restarts the process on model or ctx change.
     * Returns true when the server is ready to take requests.
     *
     * Concurrent callers coalesce: on a fresh boot the startup prewarm, the
     * warm-on-intent, the readiness poll and the user's first chat can all
     * land here within seconds. Without the guard each would stop() the
     * other's half-loaded server and respawn — minutes of load thrash for a
     * 7 GB model. Instead, everyone waits for the load in flight, and only
     * starts a new one if it finished serving something else.
     */
    async ensureModel(modelName, numCtx) {
        const ctx = this._resolveCtx(numCtx);
        while (this._loading) {
            await this._loading.catch(() => {});
        }
        if (this.isReady && this.process && this.loadedModel === modelName && this.loadedCtx === ctx) {
            return true;
        }
        this._loading = this._loadModel(modelName, ctx);
        try {
            return await this._loading;
        } finally {
            this._loading = null;
        }
    },

    async _loadModel(modelName, ctx) {
        const binaryPath = this.getBinaryPath();
        if (!binaryPath) throw new Error('llama.cpp engine is not installed');
        const entry = this._readMap()[modelName];
        // Allow raw GGUFs the user dropped into models/ (name = filename)
        const ggufPath = entry
            ? path.join(this.modelsDir, entry.file)
            : path.join(this.modelsDir, modelName);
        if (!fs.existsSync(ggufPath)) {
            throw new Error(`Model "${modelName}" is not downloaded for the llama.cpp engine`);
        }

        if (this.process) {
            this.stop(false);
            // Wait for the dying process to release the port — spawning while
            // it's still bound makes the new server exit on EADDRINUSE.
            for (let i = 0; i < 20; i++) {
                // eslint-disable-next-line no-await-in-loop
                if ((await this._checkHealth(this.port)) === 'free') break;
                // eslint-disable-next-line no-await-in-loop
                await new Promise(r => setTimeout(r, 500));
            }
        }
        // The port may still be held by a llama-server we don't own (orphan
        // from a dead session) — kill it, or as a last resort move to a
        // nearby port so the new spawn doesn't die on EADDRINUSE.
        if ((await this._checkHealth(this.port)) !== 'free') {
            await this._reclaimPort(this.port);
            if ((await this._checkHealth(this.port)) !== 'free') {
                for (let p = 18435; p <= 18440; p++) {
                    // eslint-disable-next-line no-await-in-loop
                    if ((await this._checkHealth(p)) === 'free') {
                        console.log(`[llamacpp] Port ${this.port} is taken — using ${p}`);
                        this.port = p;
                        break;
                    }
                }
            }
        }
        this._quitting = false;

        console.log(`[llamacpp] Starting llama-server: ${modelName} (ctx ${ctx})`);
        this._notifyActivity('loading', modelName);
        this.process = this._spawn(binaryPath, this.port, ggufPath, modelName, ctx);
        const ready = await this._waitForReady(this.port);
        if (ready) {
            this.isReady = true;
            this.loadedModel = modelName;
            this.loadedCtx = ctx;
            console.log(`[llamacpp] Ready on port ${this.port} (${modelName})`);
            this._notifyActivity('ready', modelName);
        } else {
            if (this.process) { this.process.kill(); this.process = null; }
            this._notifyActivity('load-failed', modelName);
            throw new Error(`llama-server failed to load ${modelName}`);
        }
        return ready;
    },

    /** Stop the managed server. quitting=true also blocks future respawns. */
    stop(quitting = true) {
        if (quitting) this._quitting = true;
        if (this.process) {
            console.log('[llamacpp] Stopping managed process');
            this.process.kill('SIGTERM');
            const pid = this.process.pid;
            setTimeout(() => {
                try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {}
            }, 5000);
            this.process = null;
        }
        this.isReady = false;
        this.loadedModel = null;
    },

    getVersion() {
        if (this._cachedVersion) return this._cachedVersion;
        const binaryPath = this.getBinaryPath();
        if (!binaryPath) return null;
        try {
            // llama-server prints "version: NNNN (sha)" on stderr. execSync —
            // hence the cache; the readiness indicator polls status often.
            const out = execSync(`"${binaryPath}" --version 2>&1`, { encoding: 'utf8' });
            const m = out.match(/version:\s*(\S+)/);
            this._cachedVersion = m ? m[1] : null;
            return this._cachedVersion;
        } catch { return null; }
    },

    _readMap() {
        try { return JSON.parse(fs.readFileSync(this.mapFile, 'utf8')) || {}; } catch { return {}; }
    },

    _writeMap(map) {
        fs.mkdirSync(this.home, { recursive: true });
        fs.writeFileSync(this.mapFile, JSON.stringify(map, null, 2), 'utf8');
    },

    /**
     * List downloaded models, Ollama-shaped ({models: [{name, size}]}) so the
     * settings/setup UI can treat both engines the same. Includes any *.gguf
     * the user dropped into models/ by hand (name = filename).
     */
    async listModels() {
        const map = this._readMap();
        const models = [];
        const seenFiles = new Set();
        for (const [name, entry] of Object.entries(map)) {
            const p = path.join(this.modelsDir, entry.file);
            if (!fs.existsSync(p)) continue; // deleted out-of-band
            seenFiles.add(entry.file);
            models.push({ name, size: fs.statSync(p).size });
        }
        try {
            for (const f of fs.readdirSync(this.modelsDir)) {
                if (!f.endsWith('.gguf') || seenFiles.has(f)) continue;
                models.push({ name: f, size: fs.statSync(path.join(this.modelsDir, f)).size });
            }
        } catch {}
        return { models };
    },

    /**
     * Download a GGUF with progress + resume. `gguf` comes from the model
     * catalog entry ({url, file}); progress callback gets the same
     * {status, percent, completed, total} shape as OllamaManager.pullModel
     * so both engines share the UI code. Resumes a partial download via a
     * Range request against the .part file.
     */
    async pullModel(modelName, gguf, onProgress) {
        if (!gguf || !gguf.url || !gguf.file) {
            throw Object.assign(new Error(`No GGUF source known for "${modelName}"`), { fatal: true });
        }
        fs.mkdirSync(this.modelsDir, { recursive: true });
        const finalPath = path.join(this.modelsDir, gguf.file);
        const partPath = finalPath + '.part';
        if (fs.existsSync(finalPath)) {
            const map = this._readMap();
            map[modelName] = { file: gguf.file };
            this._writeMap(map);
            if (onProgress) onProgress({ status: 'Done', percent: 100, completed: null, total: null });
            return { success: true };
        }

        const MAX_ATTEMPTS = 6;
        let lastErr;
        for (let n = 1; n <= MAX_ATTEMPTS; n++) {
            try {
                await this._downloadWithResume(gguf.url, partPath, onProgress);
                // Verify BEFORE the .part becomes the real file — a bad
                // download must never land in models/ (llama.cpp would parse
                // it) or get recorded in the map. On mismatch, drop the .part.
                if (onProgress) onProgress({ status: 'Verifying', percent: null, completed: null, total: null });
                try {
                    await this._verifyDigest(partPath, gguf.sha256, `Model "${modelName}"`);
                } catch (ve) {
                    try { fs.unlinkSync(partPath); } catch {}
                    throw ve;
                }
                fs.renameSync(partPath, finalPath);
                const map = this._readMap();
                map[modelName] = { file: gguf.file };
                this._writeMap(map);
                if (onProgress) onProgress({ status: 'Done', percent: 100, completed: null, total: null });
                return { success: true };
            } catch (e) {
                lastErr = e;
                if (e && e.fatal) throw e;
                if (n < MAX_ATTEMPTS) {
                    if (onProgress) onProgress({ status: 'Reconnecting, your progress is saved', percent: null, completed: null, total: null });
                    // eslint-disable-next-line no-await-in-loop
                    await new Promise(r => setTimeout(r, Math.min(15000, 2000 * n)));
                }
            }
        }
        throw lastErr || new Error('Model download failed');
    },

    /**
     * SHA-256 of a file, streamed (these are up to multi-GB, so never
     * read whole into memory). Returns lowercase hex.
     */
    _sha256File(filePath) {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            const rs = fs.createReadStream(filePath);
            rs.on('error', reject);
            rs.on('data', (chunk) => hash.update(chunk));
            rs.on('end', () => resolve(hash.digest('hex')));
        });
    },

    /**
     * Integrity gate (SECURITY-AUDIT.md M4): a downloaded artifact is a
     * native binary (engine) or model weights we execute/parse, so a
     * compromised CDN asset or rogue CA would otherwise be RCE. When the
     * catalog pins a SHA-256, verify before use and DELETE + fail on a
     * mismatch. When no hash is pinned (older catalog entry), we can't
     * verify — proceed but warn, so we don't brick downloads before every
     * entry carries a digest. `expected` may be prefixed 'sha256:'.
     * @returns {Promise<{verified:boolean, skipped:boolean}>}
     */
    async _verifyDigest(filePath, expected, label) {
        const want = String(expected || '').trim().replace(/^sha256:/i, '').toLowerCase();
        if (!want) {
            console.warn(`[llamacpp] ${label}: no SHA-256 pinned in catalog — integrity NOT verified`);
            return { verified: false, skipped: true };
        }
        const got = await this._sha256File(filePath);
        if (got !== want) {
            const err = new Error(
                `${label} failed integrity check — expected sha256 ${want}, got ${got}. ` +
                `The download was rejected and deleted.`);
            err.fatal = true;      // no retry: a hash mismatch won't fix itself
            err.integrity = true;
            throw err;
        }
        console.log(`[llamacpp] ${label}: sha256 verified`);
        return { verified: true, skipped: false };
    },

    /** One download attempt, resuming from the .part file's current size. */
    _downloadWithResume(url, partPath, onProgress) {
        const https = require('https');
        const STALL_MS = 120000;
        return new Promise((resolve, reject) => {
            const startAt = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
            const doRequest = (requestUrl, redirectsRemaining, offset) => {
                const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
                const req = https.get(requestUrl, { headers, timeout: 30000 }, (res) => {
                    if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                        res.resume();
                        if (redirectsRemaining <= 0) { reject(new Error('Too many redirects')); return; }
                        const nextUrl = new URL(res.headers.location, requestUrl).toString();
                        doRequest(nextUrl, redirectsRemaining - 1, offset);
                        return;
                    }
                    // 200 on a Range request = server ignored the range; start over
                    const resumed = res.statusCode === 206;
                    if (res.statusCode !== 200 && !resumed) {
                        res.resume();
                        const err = new Error(`Download failed: HTTP ${res.statusCode}`);
                        if (res.statusCode === 404 || res.statusCode === 401 || res.statusCode === 403) err.fatal = true;
                        reject(err);
                        return;
                    }
                    let downloaded = resumed ? offset : 0;
                    let total = parseInt(res.headers['content-length'] || '0', 10) || null;
                    if (total && resumed) total += offset;

                    const ws = fs.createWriteStream(partPath, resumed ? { flags: 'a' } : {});
                    let lastReport = 0;
                    res.on('data', (chunk) => {
                        downloaded += chunk.length;
                        const now = Date.now();
                        if (onProgress && now - lastReport > 250) {
                            lastReport = now;
                            onProgress({
                                status: 'Downloading',
                                percent: total ? Math.round((downloaded / total) * 100) : null,
                                completed: downloaded,
                                total
                            });
                        }
                    });
                    ws.on('error', (e) => { req.destroy(); reject(e); });
                    ws.on('finish', () => ws.close(() => resolve()));
                    res.on('error', (e) => { ws.destroy(); reject(e); });
                    res.pipe(ws);
                });
                req.on('error', reject);
                // Inactivity timeout — silence means a stalled socket; the
                // retry loop resumes from the .part file.
                req.setTimeout(STALL_MS, () => { req.destroy(new Error('Download stalled')); });
            };
            doRequest(url, 5, startAt);
        });
    },

    /** Delete a downloaded model (and its map entry). */
    async deleteModel(modelName) {
        if (this.loadedModel === modelName) this.stop(false);
        const map = this._readMap();
        const entry = map[modelName];
        const file = entry ? entry.file : modelName;
        try { fs.unlinkSync(path.join(this.modelsDir, file)); } catch {}
        if (entry) { delete map[modelName]; this._writeMap(map); }
        return { success: true };
    },

    /**
     * Download + install the llama.cpp engine (a ~11 MB tar.gz of
     * llama-server + dylibs from the llama.cpp GitHub releases) into
     * engine/. The archive holds one versioned top-level folder
     * (llama-bNNNNN/); its contents are flattened into engine/ so the
     * binary path stays stable across versions. Quarantine is stripped —
     * the release binaries are unsigned and Gatekeeper would otherwise
     * block the spawn. macOS-only, like Ollama's installFromUrl.
     */
    async installFromUrl(url, onProgress, expectedSha256) {
        if (process.platform !== 'darwin') {
            throw new Error('Automatic install is only supported on macOS.');
        }
        if (!url) throw new Error('No install URL provided');

        const tmpFile = path.join(os.tmpdir(), `llamacpp-engine-${Date.now()}.tar.gz`);
        const extractDir = path.join(os.tmpdir(), `llamacpp-extract-${Date.now()}`);
        try {
            if (onProgress) onProgress({ phase: 'download', percent: 0, message: 'Connecting...' });
            await this._downloadWithResume(url, tmpFile, (p) => {
                if (onProgress) onProgress({ phase: 'download', percent: p.percent, downloaded: p.completed, total: p.total, message: 'Downloading llama.cpp engine...' });
            });

            // Verify the archive BEFORE we extract, execute, or strip
            // quarantine from it — this binary is spawned, so an unverified
            // tarball is the RCE path M4 flags. A mismatch throws (fatal) and
            // the finally block deletes the tmp file; nothing reaches engine/.
            if (onProgress) onProgress({ phase: 'verify', message: 'Verifying engine...' });
            await this._verifyDigest(tmpFile, expectedSha256, 'llama.cpp engine');

            if (onProgress) onProgress({ phase: 'extract', message: 'Extracting engine...' });
            fs.mkdirSync(extractDir, { recursive: true });
            execSync(`/usr/bin/tar -xzf "${tmpFile}" -C "${extractDir}"`, { encoding: 'utf8' });

            // Locate the folder containing llama-server (top level or one deep)
            let srcDir = null;
            if (fs.existsSync(path.join(extractDir, 'llama-server'))) {
                srcDir = extractDir;
            } else {
                for (const d of fs.readdirSync(extractDir)) {
                    if (fs.existsSync(path.join(extractDir, d, 'llama-server'))) {
                        srcDir = path.join(extractDir, d);
                        break;
                    }
                }
            }
            if (!srcDir) throw new Error('llama-server not found in the downloaded archive');

            if (onProgress) onProgress({ phase: 'install', message: 'Installing engine...' });
            fs.rmSync(this.engineDir, { recursive: true, force: true });
            fs.mkdirSync(this.engineDir, { recursive: true });
            execSync(`/bin/cp -R "${srcDir}/." "${this.engineDir}/"`);
            try { execSync(`/usr/bin/xattr -dr com.apple.quarantine "${this.engineDir}"`); } catch {}

            // Sanity: the binary must run (also catches arch mismatches)
            const version = this.getVersion();
            if (!version) throw new Error('Installed llama-server does not run on this machine');

            if (onProgress) onProgress({ phase: 'done', message: 'Install complete', percent: 100 });
            return { success: true, path: this.engineDir, version };
        } finally {
            try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
            try { fs.unlinkSync(tmpFile); } catch {}
        }
    }
};

module.exports = LlamaCppManager;
