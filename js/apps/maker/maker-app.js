/**
 * Maker — manage the self-contained web artifacts (research documents and
 * mini-apps) the AI Assistant builds, rendered live in a sandboxed <webview>.
 *
 * Management surface, not a builder: the assistant is the one agent that
 * creates and edits artifacts (docs/COWORK_AGENT.md "Consolidating the three
 * agents"). This view lists the artifacts (gallery on the left), shows the
 * selected one in a <webview> pointed at anjadhe-artifact://<id>/index.html —
 * NOT a registered Anjadhe app, just files on disk served through the
 * contained scheme defined in main.js — and hands "Create" / "Edit with AI"
 * off to the assistant. The "Maker remembers" block lists durable build
 * preferences, which live in the agent's MemoryManager (source 'maker').
 */

const MakerApp = {
    _currentId: null,   // artifact shown in the preview
    _target: '',        // gallery selection (kept in sync with _currentId)
    _webview: null,
    _lastList: [],      // cached for the AgentContext provider

    init() {},

    // Inline stroke icons, same visual language as the launcher tiles.
    _icon(name, size = 15) {
        const paths = {
            doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
            presentation: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
            app: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
            page: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
            reload: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
            pdf: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
            external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
            folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
            trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
            pencil: '<path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>'
        };
        return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.doc}</svg>`;
    },

    _kindLabel(kind) {
        return kind === 'app' ? 'App'
            : kind === 'presentation' ? 'Presentation'
            : kind === 'doc' ? 'Document' : 'Artifact';
    },

    _kindIcon(kind) {
        return this._icon(kind === 'app' ? 'app' : kind === 'presentation' ? 'presentation' : 'doc');
    },

    _fmtDate(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        const opts = { month: 'short', day: 'numeric' };
        if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
        return d.toLocaleDateString(undefined, opts);
    },

    // "/Users/you/Anjadhe/artifacts" → "~/Anjadhe/artifacts" for display.
    _homePath(dir) {
        return String(dir || '').replace(/^\/Users\/[^/]+/, '~');
    },

    async render() {
        const view = document.getElementById('maker-view');
        if (!view) return;
        const esc = UIUtils.escapeHtml;
        this._webview = null;

        const status = window.electronArtifacts?.status ? await window.electronArtifacts.status() : { enabled: false };

        if (!status.enabled) {
            view.innerHTML = `
                <div class="maker maker-enable">
                    <div class="maker-enable-card">
                        <h1 class="maker-enable-title">Maker</h1>
                        <p class="maker-enable-sub">Ask the assistant for a document, a web page, a presentation, or a small app &mdash; Maker keeps what it builds as plain files on this Mac.</p>
                        <div class="maker-intro-kinds">
                            <span class="maker-kind-chip">${this._icon('doc', 14)} Document</span>
                            <span class="maker-kind-chip">${this._icon('page', 14)} Web page</span>
                            <span class="maker-kind-chip">${this._icon('presentation', 14)} Presentation</span>
                            <span class="maker-kind-chip">${this._icon('app', 14)} Small app</span>
                        </div>
                        <button id="maker-enable-btn" class="primary-btn">Enable Maker</button>
                        <p class="maker-enable-note">Enabling creates the artifacts folder. Everything Maker builds stays there &mdash; yours to open, export, or delete.</p>
                    </div>
                </div>`;
            document.getElementById('maker-enable-btn').onclick = async () => {
                const result = await window.electronArtifacts.enable();
                if (!result.ok) { UIUtils.showToast(`Could not enable Maker: ${result.error}`, 'error'); return; }
                this.render();
            };
            return;
        }

        const listRes = await window.electronArtifacts.list();
        const artifacts = listRes?.artifacts || [];
        this._lastList = artifacts;

        const previewId = this._previewTarget(artifacts);
        const previewArt = previewId ? artifacts.find(a => a.id === previewId) : null;
        const previewMeta = previewArt
            ? [this._kindLabel(previewArt.kind), this._fmtDate(previewArt.createdAt)].filter(Boolean).join(' · ')
            : '';

        view.innerHTML = `
            <div class="maker maker-split">
                <section class="maker-pane maker-side">
                    <header class="maker-header">
                        <h1>Maker</h1>
                        <p class="maker-subtitle">Documents, pages, presentations, and small apps &mdash; built by the assistant.</p>
                    </header>
                    <button id="maker-create-btn" class="primary-btn maker-create-btn">Create with AI</button>
                    ${this._renderArtifactsList(artifacts)}
                    ${this._renderMemory()}
                    <p class="maker-hint">Plain files in <button id="maker-folder-link" class="maker-link" title="Open ${esc(status.dir)}">${esc(this._homePath(status.dir))}</button></p>
                </section>
                <section class="maker-pane maker-preview-pane">
                    <header class="maker-preview-header">
                        <div class="maker-preview-headinfo">
                            <span class="maker-preview-title"${previewArt ? ' id="maker-preview-name" role="button" tabindex="0" title="Rename this artifact"' : ''}>
                                ${previewArt ? `<strong>${esc(previewArt.title || previewId)}</strong><span class="maker-preview-pencil">${this._icon('pencil', 12)}</span>` : 'Preview'}
                            </span>
                            ${previewArt ? `<span class="maker-preview-meta">${previewMeta}</span>` : ''}
                        </div>
                        ${previewId ? `
                            <span class="maker-preview-actions">
                                <button id="maker-ai-btn" class="maker-act-primary" title="Chat with the assistant about this artifact">Edit with AI</button>
                                <span class="maker-act-sep" aria-hidden="true"></span>
                                <button id="maker-reload-btn" class="maker-act-icon" title="Reload the preview" aria-label="Reload the preview">${this._icon('reload')}</button>
                                <button id="maker-pdf-btn" class="maker-act-icon" title="Export as PDF" aria-label="Export as PDF">${this._icon('pdf')}</button>
                                <button id="maker-browser-btn" class="maker-act-icon" title="Open in your browser" aria-label="Open in your browser">${this._icon('external')}</button>
                                <button id="maker-folder-btn" class="maker-act-icon" title="Show files in Finder" aria-label="Show files in Finder">${this._icon('folder')}</button>
                                <button id="maker-remove-btn" class="maker-act-icon maker-act-danger" title="Delete this artifact" aria-label="Delete this artifact">${this._icon('trash')}</button>
                            </span>` : ''}
                    </header>
                    <div id="maker-preview" class="maker-preview">
                        ${previewId ? '' : this._renderPreviewEmpty(artifacts.length)}
                    </div>
                </section>
            </div>`;

        document.getElementById('maker-folder-link').onclick = () => window.electronArtifacts.openFolder(null);
        document.getElementById('maker-create-btn').onclick = () => this._createWithAI();
        this._wireArtifactsList(view);
        this._wireMemory(view);
        this._wirePreviewActions(previewId, previewArt ? (previewArt.title || previewId) : '');

        if (previewId) this._mountPreview(previewId);
    },

    // Right-pane placeholder: a quiet pointer when artifacts exist, a fuller
    // introduction (what Maker makes + honest model note) when none do yet.
    _renderPreviewEmpty(count) {
        if (count > 0) {
            return `<div class="maker-preview-empty">
                <p class="maker-preview-empty-title">Nothing open</p>
                <p class="maker-preview-empty-hint">Choose an artifact from the list to preview it here.</p>
            </div>`;
        }
        return `<div class="maker-preview-empty maker-intro">
            <h2 class="maker-intro-title">Make something of your own</h2>
            <p class="maker-intro-sub">Describe it to the assistant and it builds the file right here.</p>
            <div class="maker-intro-kinds">
                <span class="maker-kind-chip">${this._icon('doc', 14)} Document</span>
                <span class="maker-kind-chip">${this._icon('page', 14)} Web page</span>
                <span class="maker-kind-chip">${this._icon('presentation', 14)} Presentation</span>
                <span class="maker-kind-chip">${this._icon('app', 14)} Small app</span>
            </div>
            <p class="maker-intro-note">Quality follows the assistant's model: a small local model keeps artifacts simple &mdash; a larger model on your own server or API key builds much better ones.</p>
        </div>`;
    },

    // The artifact to show in the right pane, if it still exists.
    _previewTarget(artifacts) {
        const id = this._currentId || this._target || null;
        if (!id) return null;
        return (artifacts || []).some(a => a.id === id) ? id : null;
    },

    // Create (or repoint) the preview webview. No `src` at attach time — the
    // main-process guard only inspects the attach-time src — then point it at
    // the artifact through the contained scheme after it's in the DOM.
    _mountPreview(id) {
        const pane = document.getElementById('maker-preview');
        if (!pane) return;
        pane.innerHTML = '';
        const wv = document.createElement('webview');
        wv.className = 'maker-webview';
        wv.setAttribute('partition', 'persist:maker');
        // A real load failure (e.g. index.html missing) surfaces here instead
        // of a silent blank pane. ERR_ABORTED (-3) fires on a normal reload
        // race and is not a real error.
        wv.addEventListener('did-fail-load', (e) => {
            if (e.errorCode === -3) return;
            console.warn('[maker] preview failed to load', id, e.errorCode, e.errorDescription, e.validatedURL);
            pane.innerHTML = `<div class="maker-preview-empty">
                <p class="maker-preview-empty-title">Couldn't load this artifact's preview</p>
                <p class="maker-preview-empty-hint">It may have no index.html yet, or the build is still in progress.</p>
            </div>`;
        });
        pane.appendChild(wv);
        this._webview = wv;
        // Assign src after attach so the guard doesn't rewrite it to about:blank.
        requestAnimationFrame(() => {
            try { wv.src = `anjadhe-artifact://${id}/index.html`; } catch (e) { console.warn('[maker] preview src failed', e); }
        });
    },

    _wirePreviewActions(previewId, currentName) {
        const reload = document.getElementById('maker-reload-btn');
        if (reload) reload.onclick = () => { if (this._webview) try { this._webview.reload(); } catch {} };
        const nameEl = document.getElementById('maker-preview-name');
        if (nameEl) {
            nameEl.onclick = () => previewId && this._renameArtifact(previewId, currentName);
            nameEl.onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && previewId) { e.preventDefault(); this._renameArtifact(previewId, currentName); } };
        }
        // "Edit with AI" hands off to the one assistant: the docked panel
        // opens over Maker, and the AgentContext provider (bottom of this
        // file) scopes the conversation to this artifact.
        const ai = document.getElementById('maker-ai-btn');
        if (ai) ai.onclick = () => {
            if (!previewId) return;
            this._currentId = previewId;
            if (typeof AgentUI !== 'undefined' && AgentUI.open) AgentUI.open();
        };
        const pdf = document.getElementById('maker-pdf-btn');
        if (pdf) pdf.onclick = async () => {
            if (!previewId) return;
            pdf.disabled = true;
            try {
                const res = await window.electronArtifacts.exportPdf(previewId);
                if (res?.ok) UIUtils.showToast(`PDF saved: ${res.path}`, 'success', 5000);
                else if (res?.error) UIUtils.showToast(`Export failed: ${res.error}`, 'error');
                // canceled → silent
            } finally {
                pdf.disabled = false;
            }
        };
        const browser = document.getElementById('maker-browser-btn');
        if (browser) browser.onclick = () => previewId && window.electronArtifacts.openExternal(previewId);
        const folder = document.getElementById('maker-folder-btn');
        if (folder) folder.onclick = () => previewId && window.electronArtifacts.openFolder(previewId);
        const remove = document.getElementById('maker-remove-btn');
        if (remove) remove.onclick = () => previewId && this._confirmRemove(previewId);
    },

    /**
     * "Create with AI" — hand off to the assistant with a fresh, build-scoped
     * conversation. Selection is cleared first so the context provider
     * doesn't attach the chat to an existing artifact's record.
     */
    _createWithAI() {
        this._currentId = null;
        this._target = '';
        if (typeof AgentService !== 'undefined' && AgentService.openBuildConversation) {
            AgentService.openBuildConversation();
        }
        if (typeof AgentUI !== 'undefined' && AgentUI.open) AgentUI.open();
    },

    // Durable build preferences the agent has learned (e.g. "make sources
    // links"). Stored in the agent's MemoryManager (source 'maker') — shown
    // here so the user can see what shapes every new build and forget
    // anything wrong. The assistant's memory tools manage the same entries.
    _renderMemory() {
        const memory = (typeof MakerService !== 'undefined' && MakerService.getMemory) ? MakerService.getMemory() : [];
        if (!memory.length) return '';
        const esc = UIUtils.escapeHtml;
        const rows = memory.map(m => `
            <div class="maker-mem-row" data-id="${esc(m.id)}">
                <span class="maker-mem-icon">&#9733;</span>
                <span class="maker-mem-text">${esc(m.text)}</span>
                <button class="maker-mem-remove" data-action="forget" title="Forget this preference">&times;</button>
            </div>`).join('');
        return `<div class="maker-mem">
            <h2 class="maker-mem-title">Maker remembers</h2>
            <p class="maker-mem-hint">Preferences applied to every new build. Tell the assistant a lasting preference during a build and it saves one here.</p>
            ${rows}
        </div>`;
    },

    _wireMemory(view) {
        const block = view.querySelector('.maker-mem');
        if (!block) return;
        block.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-action="forget"]');
            if (!btn) return;
            const id = btn.closest('.maker-mem-row')?.dataset.id;
            if (!id) return;
            MakerService.forget(id);
            this.render();
        });
    },

    _renderArtifactsList(artifacts) {
        const esc = UIUtils.escapeHtml;
        if (!artifacts?.length) {
            return `<div class="maker-arts">
                <h2 class="maker-arts-title">Your artifacts</h2>
                <p class="maker-arts-empty">Nothing yet &mdash; whatever the assistant builds for you appears here.</p>
            </div>`;
        }
        const rows = artifacts.map(a => {
            const active = a.id === this._currentId ? ' is-active' : '';
            const meta = [this._kindLabel(a.kind), this._fmtDate(a.createdAt)].filter(Boolean).join(' · ');
            return `<div class="maker-art-row${active}" data-id="${esc(a.id)}" role="button" tabindex="0" title="${esc(a.title || a.id)}">
                <span class="maker-art-icon">${this._kindIcon(a.kind)}</span>
                <span class="maker-art-main">
                    <span class="maker-art-name-text">${esc(a.title || a.id)}</span>
                    <span class="maker-art-meta">${meta}</span>
                </span>
            </div>`;
        }).join('');
        return `<div class="maker-arts">
            <h2 class="maker-arts-title">Your artifacts</h2>
            <div class="maker-arts-list">${rows}</div>
        </div>`;
    },

    _wireArtifactsList(view) {
        const list = view.querySelector('.maker-arts');
        if (!list) return;
        const select = (row) => {
            const id = row?.dataset.id;
            if (id) this._selectArtifact(id);
        };
        list.addEventListener('click', (e) => select(e.target.closest('.maker-art-row')));
        list.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                const row = e.target.closest('.maker-art-row');
                if (row) { e.preventDefault(); select(row); }
            }
        });
    },

    // Clicking a card opens that artifact in the right pane and makes it the
    // selection the assistant's "Edit with AI" context points at.
    async _selectArtifact(id) {
        this._currentId = id;
        this._target = id;
        await this.render();
    },

    // Rename an artifact. The name is just the display title in its metadata,
    // so the user can rename freely to organize — it doesn't touch the folder
    // id or any files.
    _renameArtifact(id, currentName) {
        const esc = UIUtils.escapeHtml;
        let modal;
        const doSave = async () => {
            const val = (document.getElementById('maker-rename-input')?.value || '').trim();
            if (!val) { UIUtils.showToast('Name cannot be empty', 'error'); return; }
            modal.close();
            const res = await window.electronArtifacts.setMeta(id, { title: val });
            if (res?.error) { UIUtils.showToast(`Could not rename: ${res.error}`, 'error'); return; }
            await this.render();
        };
        modal = Modal.create({
            title: 'Rename artifact',
            content: `<p class="maker-rename-hint">A name to help you organize your artifacts.</p>
                <input id="maker-rename-input" class="maker-rename-input" type="text" maxlength="200"
                    value="${esc(currentName || '')}" placeholder="Artifact name" />`,
            buttons: [
                { text: 'Cancel', className: 'secondary-btn' },
                { text: 'Save', className: 'primary-btn', onClick: doSave }
            ]
        });
        setTimeout(() => {
            const input = document.getElementById('maker-rename-input');
            if (input) {
                input.focus();
                input.select();
                input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } });
            }
        }, 50);
    },

    _confirmRemove(id) {
        let modal;
        modal = Modal.create({
            title: `Remove ${id}?`,
            content: `<p>This deletes the artifact and its files from this Mac. This can't be undone.</p>`,
            buttons: [
                { text: 'Cancel', className: 'secondary-btn' },
                { text: 'Remove', className: 'primary-btn', onClick: async () => {
                    modal.close();
                    const result = await window.electronArtifacts.delete(id);
                    if (result?.error) { UIUtils.showToast(`Could not remove ${id}: ${result.error}`, 'error'); return; }
                    if (this._currentId === id) this._currentId = null;
                    if (this._target === id) this._target = '';
                    UIUtils.showToast(`Removed ${id}`, 'success');
                    this.render();
                } }
            ]
        });
    }
};

AppManager.register('maker', MakerApp);

// AgentContext provider — exposes the artifact currently shown in Maker so
// the assistant (docked panel / "Edit with AI") opens a conversation scoped
// to it and knows to drive edit_artifact with the right id. Returns null
// when nothing is selected.
if (typeof AgentContext !== 'undefined') {
    AgentContext.register('maker', () => {
        const id = MakerApp._currentId || MakerApp._target || null;
        if (!id) return null;
        const art = (MakerApp._lastList || []).find(a => a && a.id === id);
        const title = art?.title || id;

        return {
            recordKey: 'artifact:' + id,
            recordLabel: title,
            title: 'CURRENT ARTIFACT',
            body: `The user is in Maker looking at their artifact "${title}" (artifactId: ${id}).
- To change this artifact, call edit_artifact with artifactId "${id}" and a complete description of the change.
- Only use create_artifact if they clearly want a NEW, separate artifact.`,
            suggestedPrompts: [
                'Improve this artifact',
                'Change the styling',
                'Add a section'
            ]
        };
    });
}
