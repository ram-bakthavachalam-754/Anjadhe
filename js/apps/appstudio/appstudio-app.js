/**
 * App Studio — manage your self-built Anjadhe apps (docs/PLATFORM.md).
 *
 * Management surface, not a builder: the AI Assistant is the one agent that
 * builds and edits apps (docs/COWORK_AGENT.md "Consolidating the three
 * agents"). This view lists the user's apps (gallery on the left), runs the
 * selected one live in the right pane (its real #<id>-view is parented there
 * via AppManager.previewIn), and hands "Create" / "Edit with AI" off to the
 * assistant, which drives the build engine and streams progress into the
 * chat. Power users can still point a terminal coding agent at the apps
 * folder directly.
 */

const AppStudioApp = {
    _lastAppId: null,   // most recently built app (set by the assistant's build card)
    _target: '',        // app selected in the gallery

    init() {},

    // Inline stroke icons, same visual language as Maker and the launcher.
    _icon(name, size = 15) {
        const paths = {
            app: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
            expand: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
            reset: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
            trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
            list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
            chart: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
            tool: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'
        };
        return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.app}</svg>`;
    },

    // "/Users/you/Anjadhe/apps" → "~/Anjadhe/apps" for display.
    _homePath(dir) {
        return String(dir || '').replace(/^\/Users\/[^/]+/, '~');
    },

    _kindChipsHtml() {
        return `<div class="appstudio-intro-kinds">
            <span class="appstudio-kind-chip">${this._icon('chart', 14)} Tracker</span>
            <span class="appstudio-kind-chip">${this._icon('list', 14)} List</span>
            <span class="appstudio-kind-chip">${this._icon('app', 14)} Log</span>
            <span class="appstudio-kind-chip">${this._icon('tool', 14)} Little tool</span>
        </div>`;
    },

    /**
     * The app currently shown in the right pane: the most recently built
     * one if any, else the one the user picked in the gallery. Null when
     * neither exists yet (empty placeholder).
     */
    _previewTarget() {
        const id = this._lastAppId || this._target || null;
        if (!id) return null;
        // Only preview ids the AppManager has actually mounted — guards
        // against stale state after a delete + render race.
        return AppManager.apps[id] ? id : null;
    },

    async render() {
        const view = document.getElementById('appstudio-view');
        if (!view) return;
        const esc = UIUtils.escapeHtml;

        // Move any previewed user-app view back out before we wipe the DOM —
        // otherwise innerHTML = ... orphans the element and previewIn() can't
        // find it again afterward.
        AppManager.clearAllPreviews?.();

        const status = window.electronApps?.status ? await window.electronApps.status() : { enabled: false };

        if (!status.enabled) {
            view.innerHTML = `
                <div class="appstudio appstudio-enable">
                    <div class="appstudio-enable-card">
                        <h1 class="appstudio-enable-title">App Studio</h1>
                        <p class="appstudio-enable-sub">Describe a small app to the assistant &mdash; a tracker, a list, a little tool &mdash; and it becomes a real app on your home page, with its own saved data.</p>
                        ${this._kindChipsHtml()}
                        <button id="appstudio-enable-btn" class="primary-btn">Enable App Building</button>
                        <p class="appstudio-enable-note">Enabling creates the apps folder on this Mac. You can also point a terminal coding agent at it &mdash; the folder's AGENTS.md explains everything.</p>
                    </div>
                </div>`;
            document.getElementById('appstudio-enable-btn').onclick = async () => {
                const result = await window.electronApps.enable();
                if (!result.ok) {
                    UIUtils.showToast(`Could not enable app building: ${result.error}`, 'error');
                    return;
                }
                this.render();
            };
            return;
        }

        const apps = await window.electronApps.list();
        const previewId = this._previewTarget();
        const previewName = previewId
            ? (AppManager.apps[previewId]?.anjadhe?.manifest?.name || previewId)
            : null;

        view.innerHTML = `
            <div class="appstudio appstudio-split">
                <section class="appstudio-pane appstudio-side">
                    <header class="appstudio-header">
                        <h1>App Studio</h1>
                        <p class="appstudio-subtitle">Small apps with their own saved data &mdash; built by the assistant.</p>
                    </header>
                    <button id="appstudio-create-btn" class="primary-btn appstudio-create-btn">Create an app with AI</button>
                    <div id="appstudio-build-banner" class="appstudio-build-banner" hidden></div>
                    ${this._renderAppsList(apps)}
                    <p class="appstudio-hint">Plain code in <button id="appstudio-folder-link" class="appstudio-link" title="Open ${esc(status.dir)} — its AGENTS.md explains the format for any coding agent">${esc(this._homePath(status.dir))}</button></p>
                </section>
                <section class="appstudio-pane appstudio-preview-pane">
                    <header class="appstudio-preview-header">
                        <div class="appstudio-preview-headinfo">
                            <span class="appstudio-preview-title">${previewName ? `<strong>${esc(previewName)}</strong>` : 'Preview'}</span>
                            ${previewId ? `<span class="appstudio-preview-meta">${this._previewMetaHtml(previewId)}</span>` : ''}
                        </div>
                        ${previewId
                            ? `<span class="appstudio-preview-actions">${this._previewActionsHtml()}</span>`
                            : ''}
                    </header>
                    <div id="appstudio-preview" class="appstudio-preview">
                        ${previewId ? '' : this._renderPreviewEmpty(apps?.length || 0)}
                    </div>
                </section>
            </div>`;

        document.getElementById('appstudio-folder-link').onclick = () => window.electronApps.openFolder();
        document.getElementById('appstudio-create-btn').onclick = () => this._createWithAI();
        this._wireBuildBanner();
        this._wireAppsList(view);

        this._wirePreviewActions();

        // Mount the previewed app into the right pane. Done after render so
        // the preview container exists in the DOM.
        if (previewId) {
            const pane = document.getElementById('appstudio-preview');
            if (pane) AppManager.previewIn(previewId, pane);
        }
    },

    // Live "Building an app…" banner, painted every second from BuildStatus
    // while this view is visible. When the in-flight build lands, the whole
    // view re-renders once so the new/updated app appears in the list.
    _buildBannerTimer: null,

    _wireBuildBanner() {
        clearInterval(this._buildBannerTimer);
        const esc = UIUtils.escapeHtml;
        let wasBuilding = false;
        const paint = () => {
            const el = document.getElementById('appstudio-build-banner');
            const viewActive = document.getElementById('appstudio-view')?.classList.contains('active');
            if (!el || !el.isConnected) { clearInterval(this._buildBannerTimer); return; }
            if (!viewActive) return;   // keep state, skip painting while hidden
            const bs = (typeof BuildStatus !== 'undefined') ? BuildStatus.current : null;
            const building = !!(bs && bs.status === 'building' && bs.kind === 'app');
            if (building) {
                wasBuilding = true;
                const step = bs.steps[bs.steps.length - 1]?.text || 'Starting…';
                const sec = Math.floor((Date.now() - bs.startedAt) / 1000);
                const elapsed = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
                el.hidden = false;
                el.innerHTML = `
                    <span class="agent-warming-spinner" aria-hidden="true"></span>
                    <span class="appstudio-build-banner-text">Building an app… <span class="appstudio-build-banner-step">${esc(step)}</span></span>
                    <span class="appstudio-build-banner-elapsed">${elapsed}</span>
                    <button type="button" class="appstudio-build-banner-open">Watch in chat</button>`;
                el.querySelector('.appstudio-build-banner-open').onclick = () => AppManager.openApp('agent');
            } else {
                el.hidden = true;
                if (wasBuilding) {
                    // The build just finished while the user was here —
                    // refresh so the new/updated app shows in the list.
                    wasBuilding = false;
                    clearInterval(this._buildBannerTimer);
                    this.render();
                }
            }
        };
        paint();
        this._buildBannerTimer = setInterval(paint, 1000);
    },

    /**
     * The selected app's action set, shown in the preview header (the list
     * rows themselves carry no buttons). All handlers resolve the target at
     * click time via _previewTarget(). One labeled action, then quiet icon
     * buttons — the same toolbar voice as Maker.
     */
    _previewActionsHtml() {
        return `
            <button id="appstudio-ai-btn" class="appstudio-act-primary" title="Chat with the assistant about this app">Edit with AI</button>
            <span class="appstudio-act-sep" aria-hidden="true"></span>
            <button id="appstudio-open-btn" class="appstudio-act-icon" title="Open full-screen" aria-label="Open full-screen">${this._icon('expand')}</button>
            <button id="appstudio-preview-reset" class="appstudio-act-icon" title="Clear this app's saved data" aria-label="Clear this app's saved data">${this._icon('reset')}</button>
            <button id="appstudio-remove-btn" class="appstudio-act-icon appstudio-act-danger" title="Delete this app" aria-label="Delete this app">${this._icon('trash')}</button>`;
    },

    // "todo-tracker · v2 · Mac + iPhone" under the preview title.
    _previewMetaHtml(id) {
        const esc = UIUtils.escapeHtml;
        const manifest = AppManager.apps[id]?.anjadhe?.manifest || {};
        const portable = typeof AppManifest !== 'undefined'
            && AppManifest.portabilityOf(manifest.entry) === 'portable';
        return [
            esc(id),
            manifest.version ? 'v' + esc(String(manifest.version)) : '',
            portable ? 'Mac + iPhone' : 'Mac only'
        ].filter(Boolean).join(' · ');
    },

    // Right-pane placeholder: a quiet pointer when apps exist, a fuller
    // introduction (what App Studio makes + honest model note) when none do.
    _renderPreviewEmpty(count) {
        if (count > 0) {
            return `<div class="appstudio-preview-empty">
                <p class="appstudio-preview-empty-title">Nothing open</p>
                <p class="appstudio-preview-empty-hint">Choose an app from the list to run it here.</p>
            </div>`;
        }
        return `<div class="appstudio-preview-empty appstudio-intro">
            <h2 class="appstudio-intro-title">Build an app of your own</h2>
            <p class="appstudio-intro-sub">Describe it to the assistant &mdash; it becomes a real app on your home page, with its own saved data.</p>
            ${this._kindChipsHtml()}
            <p class="appstudio-intro-note">Quality follows the assistant's model: a small local model handles simple tracker-style apps &mdash; a larger model on your own server or API key builds much better ones.</p>
        </div>`;
    },

    _wirePreviewActions() {
        const wire = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
        wire('appstudio-open-btn', () => { const id = this._previewTarget(); if (id) AppManager.openApp(id); });
        wire('appstudio-ai-btn', () => this._editWithAI());
        wire('appstudio-preview-reset', () => this._resetPreviewData());
        wire('appstudio-remove-btn', () => { const id = this._previewTarget(); if (id) this._confirmRemove(id); });
    },

    /**
     * Update just the right pane without rebuilding the gallery side. Used
     * when the selection changes so the list doesn't lose scroll position.
     */
    _refreshPreview() {
        const pane = document.getElementById('appstudio-preview');
        if (!pane) return;
        AppManager.clearAllPreviews?.();
        const previewId = this._previewTarget();
        // Update the header label + meta line.
        const titleEl = document.querySelector('.appstudio-preview-title');
        const headinfoEl = document.querySelector('.appstudio-preview-headinfo');
        const headerEl = document.querySelector('.appstudio-preview-header');
        let metaEl = document.querySelector('.appstudio-preview-meta');
        if (previewId) {
            const name = AppManager.apps[previewId]?.anjadhe?.manifest?.name || previewId;
            if (titleEl) titleEl.innerHTML = `<strong>${UIUtils.escapeHtml(name)}</strong>`;
            if (headinfoEl) {
                if (!metaEl) {
                    metaEl = document.createElement('span');
                    metaEl.className = 'appstudio-preview-meta';
                    headinfoEl.appendChild(metaEl);
                }
                metaEl.innerHTML = this._previewMetaHtml(previewId);
            }
            if (headerEl) {
                let actions = headerEl.querySelector('.appstudio-preview-actions');
                if (!actions) {
                    actions = document.createElement('span');
                    actions.className = 'appstudio-preview-actions';
                    headerEl.appendChild(actions);
                }
                actions.innerHTML = this._previewActionsHtml();
                this._wirePreviewActions();
            }
            pane.innerHTML = '';
            AppManager.previewIn(previewId, pane);
        } else {
            if (titleEl) titleEl.textContent = 'Preview';
            metaEl?.remove();
            document.querySelector('.appstudio-preview-actions')?.remove();
            const count = document.querySelectorAll('.appstudio-app-row').length;
            pane.innerHTML = this._renderPreviewEmpty(count);
        }
        // Selection highlight in the gallery.
        document.querySelectorAll('.appstudio-app-row').forEach(row => {
            row.classList.toggle('is-active', row.dataset.dir === (this._target || this._lastAppId));
        });
    },

    /**
     * Wipe the previewed app's saved data and re-render it. Useful while
     * iterating — the preview is the real app, so submitting forms creates
     * real records that may not be what you want to keep.
     */
    async _resetPreviewData() {
        const id = this._previewTarget();
        if (!id) return;
        const ok = await UIUtils.confirm(
            `Reset ${id} data?`,
            `Clears every record the previewed app has saved. Code and design are kept.`
        );
        if (!ok) return;
        StorageManager.set(`userapp-${id}`, {});
        try { AppManager.apps[id]?.render?.(); } catch (e) { console.error(e); }
        UIUtils.showToast(`${id} data cleared`, 'success');
    },

    /**
     * "Edit with AI" — hand off to the one assistant. The docked panel opens
     * over App Studio, and the AgentContext provider (bottom of this file)
     * scopes the conversation to the selected app so the agent drives
     * edit_app with the right id.
     */
    _editWithAI(dir) {
        if (dir) {
            this._target = dir;
            this._lastAppId = null; // the explicit pick wins over the last build
            this._refreshPreview();
        }
        if (typeof AgentUI !== 'undefined' && AgentUI.open) AgentUI.open();
    },

    /**
     * "Create an app with AI" — hand off to the assistant with a fresh,
     * build-scoped conversation. Selection is cleared first so the context
     * provider doesn't attach the chat to an existing app's record.
     */
    _createWithAI() {
        this._target = '';
        this._lastAppId = null;
        this._refreshPreview();
        if (typeof AgentService !== 'undefined' && AgentService.openBuildConversation) {
            AgentService.openBuildConversation();
        }
        if (typeof AgentUI !== 'undefined' && AgentUI.open) AgentUI.open();
    },

    _renderAppsList(apps) {
        const esc = UIUtils.escapeHtml;
        if (!apps?.length) {
            return `<div class="appstudio-apps">
                <h2 class="appstudio-apps-title">Your apps</h2>
                <p class="appstudio-apps-empty">Nothing yet &mdash; whatever the assistant builds for you appears here.</p>
            </div>`;
        }
        const selected = this._target || this._lastAppId;
        const rows = apps.map(a => {
            const broken = !!a.error;
            const name = broken ? a.dir : (a.manifest?.name || a.dir);
            // Manifest icons are user data (often an emoji); fall back to the
            // neutral grid glyph so every tile is filled.
            const icon = broken ? '&#9888;' : (a.manifest?.icon || this._icon('app'));
            // Portability: spec apps (app.spec.json) run on Mac + iPhone; code
            // apps (app.js) are Mac only. Surfaced so the user knows where an
            // app runs, and which apps the iOS companion will sync
            // (docs/PLATFORM.md).
            const portable = !broken && typeof AppManifest !== 'undefined'
                && AppManifest.portabilityOf(a.manifest?.entry) === 'portable';
            const meta = broken
                ? `<span class="appstudio-app-broken">${esc(a.error)}</span>`
                : `<span class="appstudio-app-meta">${[
                    esc(a.dir),
                    a.manifest?.version ? 'v' + esc(a.manifest.version) : '',
                    portable ? 'Mac + iPhone' : 'Mac only'
                ].filter(Boolean).join(' · ')}</span>`;
            // Rows are just the app identity — all actions for the selected
            // app (Open / Edit with AI / Reset / Remove) live in the preview
            // header. Broken apps can't mount into the preview, so they keep
            // an inline Remove as their only way out.
            return `<div class="appstudio-app-row${a.dir === selected ? ' is-active' : ''}${broken ? ' is-broken' : ''}" data-dir="${esc(a.dir)}" role="button" tabindex="0" title="${esc(name)}">
                <span class="appstudio-app-icon">${icon}</span>
                <span class="appstudio-app-main">
                    <span class="appstudio-app-name">${esc(name)}</span>
                    ${meta}
                </span>
                ${broken ? `<span class="appstudio-app-actions">
                    <button data-action="remove" class="appstudio-app-remove" title="Delete this app">Remove</button>
                </span>` : ''}
            </div>`;
        }).join('');
        return `<div class="appstudio-apps">
            <h2 class="appstudio-apps-title">Your apps</h2>
            <div class="appstudio-apps-list">${rows}</div>
        </div>`;
    },

    _wireAppsList(view) {
        const list = view.querySelector('.appstudio-apps');
        if (!list) return;
        const select = (dir) => {
            this._target = dir;
            this._lastAppId = null;
            this._refreshPreview();
        };
        list.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-action]');
            const dir = e.target.closest('.appstudio-app-row')?.dataset.dir;
            if (!dir) return;
            if (!btn) { select(dir); return; }   // row click = run in preview
            if (btn.dataset.action === 'remove') this._confirmRemove(dir);  // broken rows only
        });
        list.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                const row = e.target.closest('.appstudio-app-row');
                if (row && !e.target.closest('button')) { e.preventDefault(); select(row.dataset.dir); }
            }
        });
    },

    _confirmRemove(dir) {
        let modal;
        modal = Modal.create({
            title: `Remove ${dir}?`,
            content: `<p>This deletes the app and its code from this Mac — and, via sync, from your other Macs. The app's saved data is kept (remove it later from Settings &rarr; Data Usage if you want it gone too).</p>`,
            buttons: [
                { text: 'Cancel', className: 'secondary-btn' },
                { text: 'Remove App', className: 'primary-btn', onClick: async () => {
                    modal.close();
                    const result = await window.electronApps.deleteFolder(dir);
                    if (result?.error) {
                        UIUtils.showToast(`Could not remove ${dir}: ${result.error}`, 'error');
                        return;
                    }
                    if (this._target === dir) this._target = '';
                    if (this._lastAppId === dir) this._lastAppId = null;
                    // The watcher unmounts it and writes the sync tombstone;
                    // give that a beat, then refresh the view.
                    UIUtils.showToast(`Removed ${dir}`, 'success');
                    setTimeout(() => this.render(), 900);
                } }
            ]
        });
    }
};

AppManager.register('appstudio', AppStudioApp);

// AgentContext provider — exposes the app currently previewed/targeted in
// App Studio so the assistant (docked panel or "Edit with AI") opens a
// conversation scoped to that app and knows to drive edit_app with the
// right id. Returns null when nothing is selected.
if (typeof AgentContext !== 'undefined') {
    AgentContext.register('appstudio', () => {
        // Unlike _previewTarget(), don't require the app to be mounted —
        // a broken app can't preview but can absolutely be edited by the
        // agent ("fix my water app").
        const id = AppStudioApp._lastAppId || AppStudioApp._target || null;
        if (!id) return null;
        const mounted = AppManager.apps[id];
        const name = mounted?.anjadhe?.manifest?.name || id;

        return {
            recordKey: 'userapp:' + id,
            recordLabel: name,
            title: 'CURRENT BUILT APP',
            body: `The user is in App Studio looking at their self-built app "${name}" (appId: ${id}).
- To change this app, call edit_app with appId "${id}" and a complete description of the change.
- Only use create_app if they clearly want a NEW, different app.`,
            suggestedPrompts: [
                'Add a feature to this app',
                'Change how it looks',
                'Something is broken — fix it'
            ]
        };
    });
}
