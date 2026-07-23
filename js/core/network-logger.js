/**
 * Network Logger — transparency log for every outbound network call.
 *
 * Goal: let the user see exactly which servers this app talks to, including
 * traffic the developer didn't write directly (electron-updater, bundled
 * libraries, etc.).
 *
 * Two capture layers, both in the main process:
 *   1. A monkey-patch of Node's http/https `request`/`get`. This catches ALL
 *      main-process traffic regardless of who initiated it — llama-server, Anthropic,
 *      Google OAuth/Gmail/Calendar, Yahoo Finance, remote-config, the
 *      auto-updater, the tracker blocklist refresh, and any third-party module.
 *   2. Electron `session.defaultSession.webRequest` (wired from main.js) for
 *      renderer `fetch()` calls (analytics ping, portfolio price chart).
 *
 * Privacy: only metadata is stored — method, host, path (query string
 * stripped), status, duration, byte counts, and error. Request/response
 * headers and bodies are NEVER recorded, so auth tokens, OAuth codes, and
 * mail/PII never land in this log. It is capped, machine-local, and excluded
 * from iCloud sync (see SYNC_EXCLUDE_KEYS in main.js).
 */

const http = require('http');
const https = require('https');

const MAX_LOGS = 300;
const PERSIST_DEBOUNCE_MS = 4000;

const NetworkLogger = {
    logs: [],
    _store: null,
    _storageKey: 'network-logs',
    _persistTimer: null,
    _installed: false,

    /** Patch http/https as early as possible. Safe to call once. */
    install() {
        if (this._installed) return;
        this._installed = true;
        this._patchModule(http, 'http:');
        this._patchModule(https, 'https:');
    },

    /**
     * Give the logger the SQLite-backed kv store so it can load prior logs
     * and persist new ones. Called once main's dataStore is ready.
     */
    attachStore(store) {
        this._store = store;
        try {
            const saved = store.get(this._storageKey);
            if (Array.isArray(saved)) this.logs = saved.slice(0, MAX_LOGS);
        } catch (e) {
            console.warn('[net-log] load failed:', e && e.message);
        }
    },

    getLogs() {
        return this.logs;
    },

    clear() {
        this.logs = [];
        this._persistNow();
    },

    // ── internals ──

    _add(entry) {
        this.logs.unshift(entry);
        if (this.logs.length > MAX_LOGS) this.logs.length = MAX_LOGS;
        this._schedulePersist();
    },

    _schedulePersist() {
        if (!this._store || this._persistTimer) return;
        this._persistTimer = setTimeout(() => {
            this._persistTimer = null;
            this._persistNow();
        }, PERSIST_DEBOUNCE_MS);
    },

    _persistNow() {
        if (!this._store) return;
        try {
            this._store.set(this._storageKey, this.logs);
        } catch (e) {
            console.warn('[net-log] persist failed:', e && e.message);
        }
    },

    /** Best-effort, human-readable label for a host. */
    _classify(host) {
        const h = (host || '').toLowerCase();
        if (h === '127.0.0.1' || h === 'localhost' || h === '::1') return 'Local AI engine';
        if (h.includes('api.anthropic.com')) return 'Anthropic';
        if (h.includes('oauth2.googleapis.com')) return 'Google OAuth';
        if (h.includes('gmail.googleapis.com')) return 'Gmail';
        if (h.includes('googleapis.com')) return 'Google API';
        if (h.includes('finance.yahoo.com') || h.endsWith('yahoo.com')) return 'Yahoo Finance';
        if (h.includes('githubusercontent.com')) return 'Remote Config';
        if (h.includes('github.com') || h.includes('github-releases') || h.includes('githubassets')) return 'App Update';
        if (h.includes('api.tavily.com')) return 'Tavily Search';
        if (h.includes('search.brave.com')) return 'Brave Search';
        if (h.includes('easylist')) return 'Tracker Blocklist';
        if (h.includes('workers.dev') && h.includes('anjadhe')) return 'Analytics';
        return 'Other';
    },

    _newEntry(fields) {
        return Object.assign({
            id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
            timestamp: new Date().toISOString(),
            source: 'main',
            method: 'GET',
            protocol: 'https:',
            host: '',
            port: null,
            path: '/',
            hadQuery: false,
            service: 'Other',
            status: null,
            ok: false,
            durationMs: null,
            reqBytes: 0,
            resBytes: null,
            error: null
        }, fields);
    },

    /**
     * Record a renderer-side request observed via Electron webRequest.
     * Called from main.js's defaultSession hook.
     */
    recordWeb({ url, method, statusCode, start, error }) {
        try {
            const u = new URL(url);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
            this._add(this._newEntry({
                source: 'renderer',
                method: method || 'GET',
                protocol: u.protocol,
                host: u.hostname,
                port: u.port ? Number(u.port) : null,
                path: u.pathname || '/',
                hadQuery: !!u.search,
                service: this._classify(u.hostname),
                status: statusCode || null,
                ok: error ? false : (statusCode ? statusCode >= 200 && statusCode < 400 : true),
                durationMs: start ? Date.now() - start : null,
                error: error || null
            }));
        } catch { /* ignore malformed urls */ }
    },

    _patchModule(mod, protocolDefault) {
        const self = this;
        const origRequest = mod.request;
        mod.request = function (...args) {
            const req = origRequest.apply(this, args);
            try { self._instrument(req, args, protocolDefault); } catch { /* never break the request */ }
            return req;
        };
        // Node's `get` calls the module-local `request`, not the property we
        // just replaced, so it must be re-pointed at our patched request.
        const origGet = mod.get;
        if (typeof origGet === 'function') {
            mod.get = function (...args) {
                const req = mod.request.apply(this, args);
                req.end();
                return req;
            };
        }
    },

    _parseTarget(args, protocolDefault) {
        // Signatures: request(url[, options][, cb]) or request(options[, cb]).
        let urlArg = null;
        let options = {};
        for (const a of args) {
            if (typeof a === 'function') continue;
            if (typeof a === 'string') { urlArg = a; continue; }
            if (a instanceof URL) { urlArg = a.href; continue; }
            if (a && typeof a === 'object') options = a;
        }

        let protocol = protocolDefault;
        let host = '';
        let port = null;
        let rawPath = '/';

        try {
            if (urlArg) {
                const u = new URL(urlArg);
                protocol = u.protocol;
                host = u.hostname;
                port = u.port ? Number(u.port) : null;
                rawPath = (u.pathname || '/') + (u.search || '');
            }
            if (options && typeof options === 'object') {
                if (options.protocol) protocol = options.protocol;
                host = options.hostname || options.host || host;
                if (options.port) port = Number(options.port);
                if (options.path) rawPath = options.path;
            }
        } catch { /* fall through with defaults */ }

        const qIdx = rawPath.indexOf('?');
        const hadQuery = qIdx !== -1;
        const path = hadQuery ? rawPath.slice(0, qIdx) : rawPath;
        const method = (options && options.method) ? String(options.method).toUpperCase() : 'GET';

        return { protocol, host: (host || '').replace(/^\[|\]$/g, ''), port, path: path || '/', hadQuery, method };
    },

    _instrument(req, args, protocolDefault) {
        const t = this._parseTarget(args, protocolDefault);
        const start = Date.now();
        let reqBytes = 0;
        let done = false;
        const self = this;

        const countChunk = (chunk, enc) => {
            try {
                if (chunk && typeof chunk !== 'function') {
                    reqBytes += Buffer.byteLength(chunk, typeof enc === 'string' ? enc : undefined);
                }
            } catch { /* ignore */ }
        };

        const origWrite = req.write;
        req.write = function (chunk, enc, cb) { countChunk(chunk, enc); return origWrite.apply(this, arguments); };
        const origEnd = req.end;
        req.end = function (chunk, enc, cb) { countChunk(chunk, enc); return origEnd.apply(this, arguments); };

        const finish = (status, error, resBytes) => {
            if (done) return;
            done = true;
            self._add(self._newEntry({
                source: 'main',
                method: t.method,
                protocol: t.protocol,
                host: t.host,
                port: t.port,
                path: t.path,
                hadQuery: t.hadQuery,
                service: self._classify(t.host),
                status: status || null,
                ok: error ? false : (status ? status >= 200 && status < 400 : true),
                durationMs: Date.now() - start,
                reqBytes,
                resBytes: (resBytes != null && Number.isFinite(resBytes)) ? resBytes : null,
                error: error || null
            }));
        };

        req.on('response', (res) => {
            const cl = parseInt(res.headers && res.headers['content-length'], 10);
            const size = Number.isFinite(cl) ? cl : null;
            // 'end'/'close' are passive listeners — they don't switch the
            // stream to flowing mode, so the real consumer is unaffected.
            res.on('end', () => finish(res.statusCode, null, size));
            res.on('close', () => finish(res.statusCode, null, size));
            res.on('aborted', () => finish(res.statusCode, 'aborted', size));
        });
        req.on('error', (e) => finish(null, (e && (e.message || String(e))) || 'error'));
        req.on('timeout', () => finish(null, 'timeout'));
        // Safety net: if the socket closes without a response or error event.
        req.on('close', () => finish(null, null));
    }
};

module.exports = NetworkLogger;
