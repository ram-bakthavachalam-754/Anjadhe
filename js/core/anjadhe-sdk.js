/**
 * window.Anjadhe — the platform SDK that user-built apps code against.
 *
 * User apps (folders under ~/Anjadhe/apps/, see docs/PLATFORM.md) never touch
 * window.electronStore or other preload APIs directly; this object is their
 * entire surface. Keeping the contract narrow is what makes it documentable
 * for coding agents and enforceable later (the v1 trust model is API-shaped,
 * not a hard sandbox — see "Open questions" in docs/PLATFORM.md).
 *
 * Contract for app.js:
 *   Anjadhe.registerApp({ init() {...}, render() {...} })
 * After registration AppManager attaches `this.anjadhe` to the app object:
 *   { id, manifest, storage, navigate, registerTool }
 * `render()` should draw into the `#<id>-view` container.
 */

const Anjadhe = {
    version: 1,

    // Set by AppManager._mountUserApp around the evaluation of an app's
    // script; registerApp deposits the app object here. Null outside a load.
    _pending: null,

    /**
     * Called exactly once from a user app's app.js at script-evaluation time.
     */
    registerApp(app) {
        const ctx = this._pending;
        if (!ctx) {
            console.error('Anjadhe.registerApp() may only be called while a user app is loading');
            return;
        }
        if (ctx.registered) {
            console.error(`User app "${ctx.manifest.id}" called Anjadhe.registerApp() more than once`);
            return;
        }
        if (!app || typeof app !== 'object') {
            console.error(`User app "${ctx.manifest.id}" passed a non-object to Anjadhe.registerApp()`);
            return;
        }
        ctx.registered = true;
        ctx.app = app;
    },

    navigate(appName) {
        AppManager.openApp(appName);
    },

    showDashboard() {
        AppManager.showDashboard();
    },

    /**
     * Per-app scoped key/value storage. One blob per app under the store key
     * `app_userapp-<id>` — which means user-app data flows through iCloud
     * sync and backups exactly like built-in app data, with no extra wiring.
     */
    storageFor(appId) {
        const ns = `userapp-${appId}`;
        return {
            get(key) {
                const blob = StorageManager.get(ns) || {};
                return key in blob ? blob[key] : null;
            },
            set(key, value) {
                const blob = StorageManager.get(ns) || {};
                blob[key] = value;
                return StorageManager.set(ns, blob);
            },
            delete(key) {
                const blob = StorageManager.get(ns) || {};
                delete blob[key];
                return StorageManager.set(ns, blob);
            },
            all() {
                return StorageManager.get(ns) || {};
            }
        };
    },

    ui: {
        escapeHtml(text) {
            return UIUtils.escapeHtml(text);
        },

        // Brief feedback toast (reuses the host's toast). type: success|error|info.
        toast(message, type = 'success') {
            try { UIUtils.showToast(message, type); } catch {}
        },

        // Debounce a function — essential for text-driven lookups so a request
        // doesn't fire on every keystroke.
        debounce(fn, ms = 250) {
            let t;
            return function (...args) {
                clearTimeout(t);
                t = setTimeout(() => fn.apply(this, args), ms);
            };
        },

        /**
         * fetch a URL and return parsed JSON, with a timeout and normalized
         * errors so callers can just try/catch. Use for public, CORS-enabled
         * web APIs (e.g. Open Library). Throws Error('…') on failure.
         */
        async fetchJson(url, opts = {}) {
            const { timeoutMs = 10000, ...rest } = opts;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const res = await fetch(url, { ...rest, signal: controller.signal });
                if (!res.ok) throw new Error(`Request failed (${res.status})`);
                return await res.json();
            } catch (e) {
                throw new Error(e.name === 'AbortError' ? 'Request timed out' : (e.message || 'Network request failed'));
            } finally {
                clearTimeout(timer);
            }
        },

        /**
         * Attach debounced async autocomplete to a text input — the fiddly
         * widget (dropdown, keyboard nav, outside-click dismiss, stale-result
         * guarding) so app code only supplies the data and the action:
         *   Anjadhe.ui.autocomplete(input, {
         *     search:   async q => [ {label, ...}, ... ],   // your fetch
         *     onSelect: item => { ...save it, rerender... },
         *     renderItem?: item => 'text',  // defaults to item.label/title
         *     minChars?: 2, debounceMs?: 250
         *   });
         * The input's parent is used to position the menu — keep the input in
         * its own container.
         */
        autocomplete(input, opts = {}) {
            if (!input) return;
            const { search, onSelect, renderItem, minChars = 2, debounceMs = 250 } = opts;
            if (typeof search !== 'function' || typeof onSelect !== 'function') return;

            const host = input.parentElement || input;
            if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
            const menu = document.createElement('div');
            menu.className = 'anjadhe-ac-menu';
            menu.hidden = true;
            host.appendChild(menu);

            let items = [];
            let active = -1;
            let seq = 0;
            const close = () => { menu.hidden = true; menu.innerHTML = ''; items = []; active = -1; };
            const place = () => {
                menu.style.top = (input.offsetTop + input.offsetHeight) + 'px';
                menu.style.left = input.offsetLeft + 'px';
                menu.style.width = input.offsetWidth + 'px';
            };
            const choose = (i) => {
                const it = items[i];
                if (!it) return;
                close();
                input.value = '';
                try { onSelect(it); } catch (e) { console.error('[autocomplete] onSelect threw:', e); }
            };
            // A single non-selectable row: "Searching…", "No results", errors.
            const showStatus = (text, kind) => {
                items = [];
                active = -1;
                menu.innerHTML = '';
                const row = document.createElement('div');
                row.className = 'anjadhe-ac-status' + (kind ? ` anjadhe-ac-${kind}` : '');
                row.textContent = text;
                menu.appendChild(row);
                place();
                menu.hidden = false;
            };
            const paint = () => {
                menu.innerHTML = '';
                items.forEach((it, i) => {
                    const row = document.createElement('div');
                    row.className = 'anjadhe-ac-item' + (i === active ? ' active' : '');
                    row.textContent = renderItem ? String(renderItem(it)) : String(it.label || it.title || it.name || it);
                    row.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); });
                    menu.appendChild(row);
                });
                if (items.length) { place(); menu.hidden = false; } else { close(); }
            };
            const run = this.debounce(async (q) => {
                const mySeq = ++seq;
                showStatus('Searching…', 'loading');
                try {
                    const results = await search(q);
                    if (mySeq !== seq) return; // a newer query superseded this one
                    items = Array.isArray(results) ? results.slice(0, 8) : [];
                    active = -1;
                    if (!items.length) { showStatus('No results', 'empty'); return; }
                    paint();
                } catch {
                    if (mySeq !== seq) return;
                    showStatus('Search failed', 'error');
                }
            }, debounceMs);

            input.addEventListener('input', () => {
                const q = input.value.trim();
                if (q.length < minChars) { close(); return; }
                // Immediate feedback even before the debounced fetch fires.
                showStatus('Searching…', 'loading');
                run(q);
            });
            input.addEventListener('keydown', (e) => {
                if (menu.hidden) return;
                if (e.key === 'Escape') { close(); return; }
                if (!items.length) return; // a status row is showing — nothing to navigate
                if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); paint(); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); paint(); }
                else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(active); }
            });
            document.addEventListener('click', (e) => { if (!host.contains(e.target)) close(); });
        }
    },

    /**
     * Spec components as a library that code apps can call into. Same
     * vocabulary as standalone spec apps (paragraph, section, summary_grid,
     * list, table, form, record_list — see SpecRenderer + AppSpec), but
     * usable as building blocks inside an app.js render().
     *
     * Usage from a user app:
     *   Anjadhe.Spec.render(container, components, {
     *       storage: anjadhe.storage,
     *       rerender: () => this.render()
     *   });
     *
     * Form submits and record_list deletes call ctx.rerender() so the host
     * app re-paints; storage is the per-app scoped object.
     */
    Spec: {
        render(container, components, ctx) {
            if (!container || !Array.isArray(components)) return;
            SpecRenderer.mount(components, container, ctx || {
                storage: { get: () => null, set: () => {}, delete: () => {} },
                rerender: () => {}
            });
        }
    }
};
