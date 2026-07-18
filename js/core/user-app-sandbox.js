/**
 * UserAppSandbox — real isolation for user-built CODE apps (SECURITY-AUDIT.md H3).
 *
 * The problem: the legacy path runs an app's app.js with
 *   new Function('anjadhe', body).call(window, surface)
 * in the main renderer. A new Function body executes in the renderer's global
 * scope, so it can reach window.electronStore / window.electronEmail / every
 * other bridge regardless of what we pass it — the manifest `reads` gate is
 * decorative. There is no in-renderer way to remove those globals from its
 * scope, so an LLM-written (or shared) app can silently read all your data or
 * send mail / run shell.
 *
 * The fix: run each code app in a sandboxed <iframe> with `sandbox="allow-scripts"`
 * and NO `allow-same-origin`. That gives the frame a unique OPAQUE origin with
 * no preload — window.parent.electron* is blocked by the cross-origin barrier,
 * and the frame has no IPC surface of its own. The app talks to the host only
 * through a narrow postMessage bridge that THIS module brokers: storage is
 * namespaced to the app, readData returns only the manifest-declared `reads`,
 * registerTool is proxied, and email/calendar/fs/shell are simply never exposed.
 * The manifest finally becomes an enforced boundary.
 *
 * Gated by the off-by-default `sandboxUserApps` feature flag. Spec apps (pure
 * JSON, no code) don't need this and keep rendering host-side.
 *
 * The guest runtime (`_guestMain`) is authored as a normal function so it is
 * lint/`node --check`-validated, then inlined into the iframe via .toString().
 * It must be fully self-contained: it may reference only iframe globals
 * (window, document, fetch, postMessage) plus SpecRenderer/AppSpec when the
 * host inlines them — never this module's scope.
 */

// ── Guest runtime (runs INSIDE the sandboxed iframe) ──────────────────────────
function _guestMain() {
    'use strict';
    var BOOT = window.__ANJADHE_APP__ || {};
    var MANIFEST = BOOT.manifest || {};
    var APP_ID = MANIFEST.id;
    var APP_JS = BOOT.js || '';
    var host = window.parent;

    var toolHandlers = {};   // name -> handler(args)
    var appObj = null;
    var storageSnap = {};    // synchronous local cache of this app's storage
    var readsSnap = {};      // manifest-declared reads snapshots

    function post(msg) { msg.__anjadheGuest = true; msg.id = APP_ID; host.postMessage(msg, '*'); }
    function logError(m) { try { post({ type: 'error', message: String(m) }); } catch (e) {} }

    function escapeHtml(t) {
        return String(t == null ? '' : t)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    var ui = {
        escapeHtml: escapeHtml,
        toast: function (message, type) {
            post({ type: 'toast', message: String(message == null ? '' : message), kind: type || 'success' });
        },
        debounce: function (fn, ms) {
            var t; ms = ms || 250;
            return function () {
                var args = arguments, self = this;
                clearTimeout(t);
                t = setTimeout(function () { fn.apply(self, args); }, ms);
            };
        },
        fetchJson: async function (url, opts) {
            opts = opts || {};
            var timeoutMs = opts.timeoutMs || 10000;
            var rest = {};
            for (var k in opts) { if (k !== 'timeoutMs') rest[k] = opts[k]; }
            var controller = new AbortController();
            var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
            try {
                var merged = Object.assign({}, rest, { signal: controller.signal });
                var res = await fetch(url, merged);
                if (!res.ok) throw new Error('Request failed (' + res.status + ')');
                return await res.json();
            } catch (e) {
                throw new Error(e.name === 'AbortError' ? 'Request timed out' : (e.message || 'Network request failed'));
            } finally {
                clearTimeout(timer);
            }
        },
        // Ported verbatim from anjadhe-sdk.js (self-contained DOM widget).
        autocomplete: function (input, opts) {
            if (!input) return;
            opts = opts || {};
            var search = opts.search, onSelect = opts.onSelect, renderItem = opts.renderItem;
            var minChars = opts.minChars || 2, debounceMs = opts.debounceMs || 250;
            if (typeof search !== 'function' || typeof onSelect !== 'function') return;
            var hostEl = input.parentElement || input;
            if (getComputedStyle(hostEl).position === 'static') hostEl.style.position = 'relative';
            var menu = document.createElement('div');
            menu.className = 'anjadhe-ac-menu';
            menu.hidden = true;
            hostEl.appendChild(menu);
            var items = [], active = -1, seq = 0;
            function close() { menu.hidden = true; menu.innerHTML = ''; items = []; active = -1; }
            function place() {
                menu.style.top = (input.offsetTop + input.offsetHeight) + 'px';
                menu.style.left = input.offsetLeft + 'px';
                menu.style.width = input.offsetWidth + 'px';
            }
            function choose(i) {
                var it = items[i];
                if (!it) return;
                close(); input.value = '';
                try { onSelect(it); } catch (e) { logError('autocomplete onSelect: ' + e.message); }
            }
            function showStatus(text, kind) {
                items = []; active = -1; menu.innerHTML = '';
                var row = document.createElement('div');
                row.className = 'anjadhe-ac-status' + (kind ? ' anjadhe-ac-' + kind : '');
                row.textContent = text;
                menu.appendChild(row); place(); menu.hidden = false;
            }
            function paint() {
                menu.innerHTML = '';
                items.forEach(function (it, i) {
                    var row = document.createElement('div');
                    row.className = 'anjadhe-ac-item' + (i === active ? ' active' : '');
                    row.textContent = renderItem ? String(renderItem(it)) : String(it.label || it.title || it.name || it);
                    row.addEventListener('mousedown', function (e) { e.preventDefault(); choose(i); });
                    menu.appendChild(row);
                });
                if (items.length) { place(); menu.hidden = false; } else { close(); }
            }
            var run = ui.debounce(async function (q) {
                var mySeq = ++seq;
                showStatus('Searching…', 'loading');
                try {
                    var results = await search(q);
                    if (mySeq !== seq) return;
                    items = Array.isArray(results) ? results.slice(0, 8) : [];
                    active = -1;
                    if (!items.length) { showStatus('No results', 'empty'); return; }
                    paint();
                } catch (e) {
                    if (mySeq !== seq) return;
                    showStatus('Search failed', 'error');
                }
            }, debounceMs);
            input.addEventListener('input', function () {
                var q = input.value.trim();
                if (q.length < minChars) { close(); return; }
                showStatus('Searching…', 'loading'); run(q);
            });
            input.addEventListener('keydown', function (e) {
                if (menu.hidden) return;
                if (e.key === 'Escape') { close(); return; }
                if (!items.length) return;
                if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); paint(); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); paint(); }
                else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(active); }
            });
            document.addEventListener('click', function (e) { if (!hostEl.contains(e.target)) close(); });
        }
    };

    var Spec = {
        render: function (container, components, ctx) {
            if (typeof SpecRenderer === 'undefined' || !SpecRenderer.mount) {
                logError('Anjadhe.Spec is not available in sandbox mode');
                return;
            }
            if (!container || !Array.isArray(components)) return;
            SpecRenderer.mount(components, container, ctx || {
                storage: { get: function () { return null; }, set: function () {}, delete: function () {} },
                rerender: function () {}
            });
        }
    };

    function makeStorage() {
        return {
            get: function (key) { return (storageSnap && (key in storageSnap)) ? storageSnap[key] : null; },
            set: function (key, value) { storageSnap[key] = value; post({ type: 'storage-set', key: key, value: value }); return true; },
            delete: function (key) { delete storageSnap[key]; post({ type: 'storage-delete', key: key }); return true; },
            all: function () { return Object.assign({}, storageSnap); }
        };
    }

    // The global Anjadhe object app.js references, plus shims for the few host
    // globals SpecRenderer/generated code may reach for (navigation only).
    var Anjadhe = {
        version: 1,
        registerApp: function (app) {
            if (!app || typeof app !== 'object') { logError('registerApp() needs an object'); return; }
            appObj = app;
        },
        navigate: function (name) { post({ type: 'navigate', name: String(name) }); },
        showDashboard: function () { post({ type: 'dashboard' }); },
        ui: ui,
        Spec: Spec,
        storageFor: function () { return makeStorage(); }
    };
    window.Anjadhe = Anjadhe;
    window.AppManager = { openApp: function (n) { post({ type: 'navigate', name: String(n) }); }, showDashboard: function () { post({ type: 'dashboard' }); } };
    window.UIUtils = { escapeHtml: escapeHtml, showToast: ui.toast };
    // open_url from Spec: window.open is blocked in the sandbox — broker it.
    var _open = window.open;
    window.open = function (url) { post({ type: 'open-url', url: String(url || '') }); return null; };

    function makeSurface() {
        return {
            id: APP_ID,
            manifest: MANIFEST,
            storage: makeStorage(),
            navigate: function (name) { post({ type: 'navigate', name: String(name) }); },
            registerTool: function (definition, handler) {
                // OpenAI-style: { type:'function', function:{ name, … } } — same
                // shape AgentTools.register requires on the host side.
                var fn = definition && definition.function;
                if (!fn || !fn.name || typeof handler !== 'function') {
                    logError('registerTool(definition, handler) needs a named definition and a handler');
                    return;
                }
                toolHandlers[fn.name] = handler;
                post({ type: 'register-tool', definition: definition });
            },
            readData: function (name) {
                if ((MANIFEST.reads || []).indexOf(name) === -1) {
                    throw new Error('Declare reads:["' + name + '"] in manifest.json to read that app data');
                }
                return (name in readsSnap) ? readsSnap[name] : null;
            }
        };
    }

    function showErrorCard(e) {
        var v = document.getElementById(APP_ID + '-view');
        if (!v) return;
        v.innerHTML = '';
        var card = document.createElement('div');
        card.className = 'user-app-error';
        var p1 = document.createElement('p');
        p1.textContent = 'This app hit an error while loading.';
        var p2 = document.createElement('p');
        p2.className = 'user-app-error-detail';
        p2.textContent = (e && e.message) || String(e);
        card.appendChild(p1); card.appendChild(p2);
        v.appendChild(card);
    }

    function safeCall(method) {
        if (appObj && typeof appObj[method] === 'function') {
            try { appObj[method](); }
            catch (e) { logError(method + '(): ' + ((e && e.message) || e)); if (method === 'render') showErrorCard(e); }
        }
    }

    function runApp() {
        var surface = makeSurface();
        try {
            // Same shape as the host's new Function('anjadhe', body).call(window,…),
            // but `window` here is the ISOLATED iframe realm with no bridges.
            (new Function('anjadhe', APP_JS)).call(window, surface);
        } catch (e) { logError('app.js: ' + ((e && e.message) || e)); showErrorCard(e); return; }
        if (!appObj) { logError('app.js did not call Anjadhe.registerApp()'); return; }
        appObj.anjadhe = surface;
        safeCall('init');
        safeCall('render');
    }

    window.addEventListener('message', function (e) {
        var d = e.data;
        if (!d || d.__anjadheHost !== true) return;
        if (e.source !== host) return;   // only trust the host window
        if (d.type === 'init') {
            storageSnap = d.storage || {};
            readsSnap = d.reads || {};
            runApp();
        } else if (d.type === 'render') {
            safeCall('render');
        } else if (d.type === 'storage-changed') {
            if (d.storage) storageSnap = d.storage;
            safeCall('render');
        } else if (d.type === 'theme') {
            if (d.theme) document.documentElement.setAttribute('data-theme', String(d.theme));
            else document.documentElement.removeAttribute('data-theme');
        } else if (d.type === 'tool-call') {
            var h = toolHandlers[d.name];
            if (!h) { post({ type: 'tool-result', callId: d.callId, error: 'unknown tool ' + d.name }); return; }
            Promise.resolve().then(function () { return h(d.args || {}); }).then(
                function (result) { post({ type: 'tool-result', callId: d.callId, result: result }); },
                function (err) { post({ type: 'tool-result', callId: d.callId, error: (err && err.message) || String(err) }); }
            );
        }
    });

    post({ type: 'ready' });
}

// ── Host side ─────────────────────────────────────────────────────────────────
const UserAppSandbox = {
    _records: {},        // appId -> { id, dir, manifest, iframe, keywords, pendingTools, toolCallSeq }
    _listening: false,
    _specSrc: undefined, // inlined SpecRenderer+AppSpec source, or '' if unavailable

    /**
     * Fetch the Spec engine source once so `Anjadhe.Spec.render` works inside
     * the isolated frame (SpecRenderer only needs Anjadhe.navigate, which the
     * guest provides), and the host design system (core + components CSS) so
     * apps see the same variables/base styles they'd get in the host document.
     * Called before mounting when the flag is on.
     */
    async preload() {
        if (this._specSrc !== undefined) return;
        try {
            const [appSpec, specRenderer] = await Promise.all([
                fetch('js/core/app-spec.js').then(r => r.text()),
                fetch('js/core/spec-renderer.js').then(r => r.text())
            ]);
            this._specSrc = appSpec + '\n;\n' + specRenderer + '\n';
        } catch (e) {
            console.warn('[user-app-sandbox] Spec preload failed; Anjadhe.Spec disabled in sandbox:', e);
            this._specSrc = '';
        }
        try {
            const [core, components, spec] = await Promise.all([
                fetch('css/core.css').then(r => r.text()),
                fetch('css/components.css').then(r => r.text()),
                fetch('css/spec-renderer.css').then(r => r.text())
            ]);
            this._baseCss = core + '\n' + components + '\n' + spec + '\n';
        } catch (e) {
            console.warn('[user-app-sandbox] design-system CSS preload failed; user apps will render unstyled:', e);
            this._baseCss = '';
        }
    },

    /**
     * Mount a code app in a sandboxed iframe. Returns the host-side proxy that
     * AppManager treats as the app object (init/render post to the guest).
     */
    mountCodeApp(manifest, entry, opts = {}) {
        const id = manifest.id;
        const iframe = document.createElement('iframe');
        iframe.id = `${id}-view`;
        iframe.className = 'view app-view user-app-frame';
        // No allow-same-origin: opaque origin, cannot reach window.parent.electron*.
        iframe.setAttribute('sandbox', 'allow-scripts');
        iframe.setAttribute('title', manifest.name || id);
        (opts.previewParent || document.getElementById('app-views')).appendChild(iframe);

        const record = {
            id, dir: entry.dir, manifest, iframe,
            keywords: opts.keywords || [],
            pendingTools: new Map(),
            toolCallSeq: 0
        };
        this._records[id] = record;
        this._ensureListener();

        // Stage the composed guest HTML with main, then point the frame at its
        // OWN origin (anjadhe-userapp://<id>) so the guest uses its own CSP.
        // srcdoc would make the frame an about:srcdoc document that inherits the
        // main window's strict script-src and blocks the guest's inline scripts.
        const html = this._buildGuestHtml(manifest, entry);
        const staged = (window.electronApps && window.electronApps.stage)
            ? window.electronApps.stage(id, html)
            : Promise.reject(new Error('user-app staging is unavailable'));
        Promise.resolve(staged).then(() => {
            // A hot reload may have torn this record down before staging resolved.
            if (this._records[id] === record) {
                iframe.src = `anjadhe-userapp://${encodeURIComponent(id)}/index.html`;
            }
        }).catch((e) => {
            console.error(`[user-app ${id}] failed to stage sandbox HTML:`, e);
            window.electronApps?.logError?.(entry.dir, `sandbox stage: ${e.message}`);
        });

        return {
            _sandboxed: true,
            id,
            manifest,
            init() { /* guest self-inits when it receives the host 'init' message */ },
            render() { UserAppSandbox._post(id, { type: 'render' }); }
        };
    },

    unmount(id) {
        const r = this._records[id];
        if (!r) return;
        for (const p of r.pendingTools.values()) clearTimeout(p.timer);
        r.pendingTools.clear();
        delete this._records[id];
        try { window.electronApps?.unstage?.(id); } catch (e) {}
        // The iframe element (#<id>-view), AgentTools.unregisterBySource, the
        // <style> and the tile are removed by AppManager._unmountUserApp.
    },

    _buildGuestHtml(manifest, entry) {
        const css = entry.css || '';
        const baseCss = this._baseCss || '';
        const boot = this._safeJson({ manifest, js: entry.js || '' });
        const spec = this._specSrc || '';
        const guest = `(${_guestMain.toString()})();`;
        // Bake the current theme into the document so dark mode applies before
        // first paint; runtime changes arrive via the 'theme' message.
        const theme = document.documentElement.getAttribute('data-theme') || '';
        const themeAttr = /^[a-z-]*$/.test(theme) && theme ? ' data-theme="' + theme + '"' : '';
        // The guest CSP is lenient on script (the app legitimately runs arbitrary
        // code, incl. new Function) and network (public API calls) — that is NOT
        // the security boundary. Isolation comes from the opaque sandbox origin,
        // which blocks all access to the host and its bridges.
        // fonts.googleapis.com mirrors the host's own Nunito/Inter <link>.
        const csp = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; "
            + "style-src 'unsafe-inline' https://fonts.googleapis.com; img-src * data: blob:; font-src * data:; "
            + "media-src * data: blob:; connect-src *; frame-src 'none'; base-uri 'none'; form-action 'none'";
        return '<!doctype html><html' + themeAttr + '><head><meta charset="utf-8">'
            + '<meta http-equiv="Content-Security-Policy" content="' + csp + '">'
            + '<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@300;400;600;700&family=Inter:wght@400;500;600;700&family=Kalam:wght@300;400;700&display=swap" rel="stylesheet">'
            // Host design system first, so the app's own rules can override it —
            // same cascade order as the legacy in-document path.
            + '<style>' + baseCss + '</style>'
            + '<style>html,body{margin:0;padding:0;height:100%;background:transparent;}</style>'
            + '<style>' + css + '</style></head><body>'
            + '<div id="' + manifest.id + '-view" class="view app-view active"></div>'
            + '<script>window.__ANJADHE_APP__=' + boot + ';<\/script>'
            + (spec ? '<script>' + spec + '<\/script>' : '')
            + '<script>' + guest + '<\/script>'
            + '</body></html>';
    },

    // JSON with `<` neutralized so app.js containing "</script>" can't break out
    // of the boot <script> tag.
    _safeJson(obj) {
        return JSON.stringify(obj).replace(/</g, '\\u003c');
    },

    _post(id, msg) {
        const r = this._records[id];
        if (!r || !r.iframe.contentWindow) return;
        r.iframe.contentWindow.postMessage(Object.assign({ __anjadheHost: true }, msg), '*');
    },

    _ensureListener() {
        if (this._listening) return;
        this._listening = true;
        window.addEventListener('message', (e) => this._onMessage(e));
        // Follow the host theme toggle so guest [data-theme] variables track it.
        new MutationObserver(() => {
            const theme = document.documentElement.getAttribute('data-theme') || '';
            for (const id in this._records) this._post(id, { type: 'theme', theme });
        }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    },

    _onMessage(e) {
        const d = e.data;
        if (!d || d.__anjadheGuest !== true) return;
        // Route by SOURCE identity, never by the id in the message — this stops
        // one app's frame from impersonating another app.
        let record = null;
        for (const id in this._records) {
            if (this._records[id].iframe.contentWindow === e.source) { record = this._records[id]; break; }
        }
        if (!record) return;
        const id = record.id;
        switch (d.type) {
            case 'ready':
                this._sendInit(record);
                break;
            case 'register-tool':
                this._registerGuestTool(record, d.definition);
                break;
            case 'storage-set':
                this._storageWrite(id, d.key, d.value, false);
                break;
            case 'storage-delete':
                this._storageWrite(id, d.key, undefined, true);
                break;
            case 'navigate':
                if (d.name) AppManager.openApp(String(d.name));
                break;
            case 'dashboard':
                AppManager.showDashboard();
                break;
            case 'toast':
                try { UIUtils.showToast(String(d.message == null ? '' : d.message), d.kind || 'success'); } catch (err) {}
                break;
            case 'open-url':
                this._openExternal(d.url);
                break;
            case 'tool-result': {
                const pend = record.pendingTools.get(d.callId);
                if (pend) {
                    record.pendingTools.delete(d.callId);
                    clearTimeout(pend.timer);
                    if (d.error) pend.reject(new Error(String(d.error)));
                    else pend.resolve(d.result);
                }
                break;
            }
            case 'error':
                console.error(`[user-app ${id}]`, d.message);
                window.electronApps?.logError?.(record.dir, `sandbox: ${String(d.message || '')}`);
                break;
        }
    },

    _sendInit(record) {
        const manifest = record.manifest;
        const storage = StorageManager.get(`userapp-${manifest.id}`) || {};
        const reads = {};
        for (const name of (manifest.reads || [])) {
            const data = StorageManager.get(name);
            reads[name] = data == null ? null : JSON.parse(JSON.stringify(data));
        }
        this._post(manifest.id, { type: 'init', storage, reads, keywords: record.keywords });
    },

    _storageWrite(id, key, value, isDelete) {
        const ns = `userapp-${id}`;
        const blob = StorageManager.get(ns) || {};
        if (isDelete) delete blob[key];
        else blob[key] = value;
        StorageManager.set(ns, blob);
    },

    _registerGuestTool(record, definition) {
        const name = definition?.function?.name;
        if (!name) return;
        const id = record.id;
        AgentTools.register(
            definition,
            async (args) => UserAppSandbox._callGuestTool(id, name, args),
            { source: id, keywords: record.keywords }
        );
    },

    _callGuestTool(id, name, args) {
        const r = this._records[id];
        if (!r) return Promise.reject(new Error('app is not loaded'));
        const callId = `${id}:${++r.toolCallSeq}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                r.pendingTools.delete(callId);
                reject(new Error(`Tool "${name}" timed out`));
            }, 30000);
            r.pendingTools.set(callId, { resolve, reject, timer });
            this._post(id, { type: 'tool-call', callId, name, args: args || {} });
        });
    },

    _openExternal(url) {
        const safe = (typeof UIUtils !== 'undefined' && UIUtils.safeHref) ? UIUtils.safeHref(url) : url;
        if (!/^https?:/i.test(String(safe))) return;   // OS only ever gets http(s)
        try { window.open(safe, '_blank', 'noopener'); } catch (e) {}
    }
};

if (typeof window !== 'undefined') window.UserAppSandbox = UserAppSandbox;
if (typeof module !== 'undefined' && module.exports) module.exports = { UserAppSandbox, _guestMain };
