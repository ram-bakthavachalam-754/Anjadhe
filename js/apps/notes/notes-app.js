/**
 * Notes App - Data Management with Tag System
 */

const NotesApp = {
    notes: [],
    tags: [],
    currentNoteId: null,
    currentTemplate: 'blank', // template of the currently open note in editor/viewer
    pendingTemplate: null,    // template chosen for a brand-new note before it has an id
    currentBookNumbered: true, // per-note "number chapters" preference; default on
    currentBookLayout: 'scroll', // per-note: 'scroll' (long page) or 'paged' (one chapter visible)
    currentBookChapterIndex: 0,  // active chapter in paged layout (editor + viewer share this)
    currentPrompt: null,         // prompt-template run config { target, offline, interval, web }
    autoLinkContext: null, // [{app, itemId}, ...] — auto-link new notes to these items
    currentFilter: 'all',
    searchQuery: '',
    sortBy: 'modified',
    hasUnsavedChanges: false,

    // Three-pane runtime state: whether an editor session is live in the
    // right pane (drives teardown when switching notes).
    _paneSessionActive: false,

    // Book-mode runtime handles (TOC re-render, scroll-spy). Tracked so
    // we can tear them down cleanly when leaving book mode or the view.
    _bookEditorInputHandler: null,
    _bookEditorScrollHandler: null,
    _bookTocRenderTimer: null,

    // Resizable TOC sidebar — mirrors the Tasks left-nav resizer. Width
    // is per-machine (screen sizes differ across Macs) so it lives in
    // localStorage rather than the sync journal.
    TOC_WIDTH_KEY: 'notes-book-toc-width',
    TOC_WIDTH_DEFAULT: 260,
    TOC_WIDTH_MIN: 180,
    TOC_WIDTH_MAX: 480,

    /**
     * Initialize the notes app
     */
    init() {
        this.loadNotes();
        this.loadTags();
        // One-time fold of the old standalone Prompts library into notes as
        // prompt-template notes. Runs after notes+tags are loaded (it writes
        // to both) and is a no-op once the `prompts` blob is flagged.
        this.migratePromptsToNotes();
        this.setupEventListeners();
        this._setupLinkHandler();
        this._bindGlobalKeys();
        this._setupWikiLinks();

        // The always-editable note host is declared at top level in
        // index.html; adopt it into the third pane on first init.
        const pane = document.getElementById('notes-note-pane');
        const host = document.getElementById('note-editor-view');
        if (pane && host && host.parentElement !== pane) pane.appendChild(host);

        NavResizer.attach({
            layoutSel: '#notes-view .notes-layout',
            resizerId: 'notes-nav-resizer',
            cssVar: '--notes-nav-width',
            storageKey: 'notes-nav-width',
            defaultW: 188,
        });
        NavResizer.attach({
            layoutSel: '#notes-view .notes-layout',
            resizerId: 'notes-list-resizer',
            cssVar: '--notes-list-width',
            storageKey: 'notes-list-width',
            defaultW: 300,
            min: 220,
            max: 480,
        });

        // Re-entering the app (init runs on every openApp): if a note was
        // selected, re-load it from storage — a sync may have refreshed it;
        // if it's gone (deleted on another Mac), fall back to the empty pane.
        if (this.currentNoteId) {
            if (this.notes.some(n => n.id === this.currentNoteId)) {
                this._loadNoteIntoPane(this.currentNoteId);
            } else {
                this._clearSelection();
            }
        }
        this.render();
    },

    // Anchor handling inside the editable note. Wiki links (#note:<id>)
    // navigate on plain click; external links open in the in-app Browse
    // tab on Cmd/Ctrl+click (a plain click keeps the caret for editing).
    // Document-level and wired once.
    _setupLinkHandler() {
        if (this._linkHandlerWired) return;
        this._linkHandlerWired = true;
        document.addEventListener('click', (e) => {
            const a = e.target && e.target.closest && e.target.closest('#note-editor-view a[href]');
            if (!a) return;
            const href = a.getAttribute('href') || '';

            if (href.startsWith('#note:')) {
                e.preventDefault();
                const id = href.slice('#note:'.length);
                if (this.notes.some(n => n.id === id)) this.openEditor(id);
                else UIUtils.showToast('Linked note no longer exists', 'error');
                return;
            }

            if (!/^https?:/i.test(href)) return;
            if (!(e.metaKey || e.ctrlKey)) return; // plain click = edit the text
            e.preventDefault();
            const noteId = this.currentNoteId;
            if (typeof AppManager !== 'undefined' && AppManager.openInBrowse) {
                AppManager.openInBrowse(href, {
                    label: 'Back to Notes',
                    onBack: () => {
                        AppManager.openApp('notes');
                        if (noteId) setTimeout(() => this.openEditor(noteId), 60);
                    }
                });
            } else if (window.electronAuth?.openExternal) {
                window.electronAuth.openExternal(href);
            }
        });
    },

    // Cmd/Ctrl+F focuses the list search whenever Notes is the open app —
    // mirrors the Actions app shortcut.
    _bindGlobalKeys() {
        if (this._globalKeysWired) return;
        this._globalKeysWired = true;
        document.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey
                && e.key.toLowerCase() === 'f' && AppManager.currentApp === 'notes') {
                e.preventDefault();
                const s = document.getElementById('notes-search');
                if (s) { s.focus(); s.select(); }
            }
        });
    },

    /**
     * Load notes from storage
     */
    loadNotes() {
        const data = StorageManager.get('notes');
        // Coerce strings so a phone-created note (or any malformed record) can't
        // crash the search/sort paths (title/content .toLowerCase()/.localeCompare()).
        // `tags` is defaulted by migrateOldNotes() below.
        this.notes = (data?.notes || []).map(n => ({
            ...n,
            title: typeof n.title === 'string' ? n.title : '',
            content: typeof n.content === 'string' ? n.content : '',
        }));

        // Migrate old color-based notes to tag system
        this.migrateOldNotes();
    },

    /**
     * Load tags from storage
     */
    loadTags() {
        const data = StorageManager.get('tags');
        this.tags = data?.tags || this.getDefaultTags();
    },

    /**
     * Get default tags
     */
    getDefaultTags() {
        return [
            { id: 'tag_work', name: 'work', profile: 'default' },
            { id: 'tag_personal', name: 'personal', profile: 'default' },
            { id: 'tag_ideas', name: 'ideas', profile: 'default' },
            { id: 'tag_important', name: 'important', profile: 'default' }
        ];
    },

    /**
     * Tags belonging to the active profile. Tags are a per-profile library
     * (each carries a `profile` field, defaulting to 'default') so one
     * profile's tags never surface in another's sidebar or picker.
     */
    activeProfileTags() {
        return ProfileManager.filterByActiveProfile(this.tags);
    },

    /**
     * Migrate old color-based notes
     */
    migrateOldNotes() {
        let migrated = false;
        this.notes.forEach(note => {
            if (note.color && !note.tags) {
                note.tags = [];
                migrated = true;
                delete note.color;
            }
            if (!note.tags) {
                note.tags = [];
            }
        });
        if (migrated) {
            this.saveNotes();
        }
    },

    /**
     * One-time migration: fold the old standalone Prompts library (the
     * `prompts` storage blob) into notes as prompt-template notes so no
     * data is lost when the separate app is retired.
     *
     * - Each prompt becomes a note REUSING the prompt's id, so the offline
     *   feed (`promptFeed.runs`/`items`, keyed by prompt id) keeps pointing
     *   at the right note without any remap.
     * - The prompt's plain-text body is wrapped in paragraphs as note HTML.
     * - Run config moves to `note.prompt = { target, offline, interval, web }`.
     * - The prompt tag library is merged into the notes tag library by
     *   case-insensitive name.
     * - The `prompts` blob is left intact (for rollback) but flagged
     *   `_migratedToNotes` so this runs exactly once.
     */
    migratePromptsToNotes() {
        const blob = StorageManager.get('prompts');
        if (!blob || blob._migratedToNotes) return;
        const oldPrompts = Array.isArray(blob.prompts) ? blob.prompts : [];
        const oldTags = Array.isArray(blob.tags) ? blob.tags : [];

        const existingIds = new Set(this.notes.map(n => n.id));
        const esc = (s) => String(s || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const bodyToHtml = (body) => (String(body || '').trim()
            ? String(body).split(/\n{2,}/).map(p =>
                `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')
            : '');

        let changed = false;
        oldPrompts.forEach(p => {
            if (!p || !p.id || existingIds.has(p.id)) return; // de-dupe / re-run safety
            this.notes.unshift({
                id: p.id,
                title: p.title || 'Untitled prompt',
                content: bodyToHtml(p.body),
                tags: Array.isArray(p.tags) ? p.tags.slice() : [],
                template: 'prompt',
                prompt: {
                    target: p.defaultTarget === 'browser' ? 'browser' : 'agent',
                    offline: !!p.offline,
                    interval: p.interval || 'daily',
                    web: !!p.web
                },
                profile: p.profile || 'default',
                pinned: false,
                createdAt: p.createdAt || new Date().toISOString(),
                modifiedAt: p.modifiedAt || new Date().toISOString()
            });
            existingIds.add(p.id);
            changed = true;
        });

        // Merge prompt tags into the notes tag library (by lowercase name).
        const known = new Set(this.tags.map(t => t.name.toLowerCase()));
        oldTags.forEach(t => {
            if (!t || !t.name) return;
            if (known.has(t.name.toLowerCase())) return;
            this.tags.push({ id: UIUtils.generateId(), name: t.name, profile: ProfileManager.getProfileForNewItem(), createdAt: t.createdAt || new Date().toISOString() });
            known.add(t.name.toLowerCase());
            changed = true;
        });

        if (changed) {
            this.saveNotes();
            this.saveTags();
        }
        // Flag the source blob so the migration never repeats.
        StorageManager.set('prompts', { ...blob, _migratedToNotes: true });
    },

    /**
     * Save notes to storage
     */
    saveNotes() {
        StorageManager.set('notes', { notes: this.notes });
        AppManager.updateStats();
    },

    /**
     * Create a note in one step from a title + plain-text body, without
     * opening the editor. Used by the titlebar quick-capture action so a
     * note can be jotted from anywhere. Plain-text body is converted to
     * simple HTML (the note content field is rendered as HTML). Returns the
     * new note id, or null if there was nothing to save.
     *
     * Callers may run before the Notes view has ever been opened, so load
     * first — otherwise the unshift below would save over stored notes.
     */
    /**
     * Convert a plain-text body into the simple HTML the note content field
     * stores: blank-line-separated blocks become paragraphs, single newlines
     * become <br>. Shared by quick-capture create and the editor handoff.
     */
    plainTextToHtml(body = '') {
        body = (body || '').trim();
        if (!body) return '';
        return body.split(/\n{2,}/).map(p =>
            `<p>${UIUtils.escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
    },

    createNote(title = '', body = '') {
        title = (title || '').trim();
        body = (body || '').trim();
        if (!title && !body) return null;
        if (this.notes.length === 0) this.loadNotes();

        const content = this.plainTextToHtml(body);

        const newNote = {
            id: UIUtils.generateId(),
            title: title || 'Untitled',
            content,
            tags: [],
            template: 'blank',
            bookNumbered: true,
            bookLayout: 'scroll',
            profile: ProfileManager.getProfileForNewItem(),
            pinned: false,
            createdAt: new Date().toISOString(),
            modifiedAt: new Date().toISOString()
        };
        this.notes.unshift(newNote);
        this.saveNotes();
        // Refresh the list if the user happens to be looking at it.
        if (typeof AppManager !== 'undefined' && AppManager.currentApp === 'notes') {
            this.render();
        }
        return newNote.id;
    },

    /**
     * Save tags to storage
     */
    saveTags() {
        StorageManager.set('tags', { tags: this.tags });
    },

    /**
     * Setup event listeners
     */
    setupEventListeners() {
        // Add note button — main click opens a blank note (preserves
        // muscle memory); the caret opens a template chooser.
        const addBtn = document.getElementById('add-note-btn');
        const newAddBtn = addBtn.cloneNode(true);
        addBtn.parentNode.replaceChild(newAddBtn, addBtn);
        newAddBtn.addEventListener('click', () => {
            this.openEditor(null, { template: 'blank' });
        });

        // "New Prompt" button — only visible while the Prompts filter is
        // active (see render()). Opens a blank note pre-set to the prompt
        // template so the user doesn't have to pick it from the caret menu.
        const addPromptBtn = document.getElementById('add-prompt-btn');
        if (addPromptBtn) {
            const newAddPromptBtn = addPromptBtn.cloneNode(true);
            addPromptBtn.parentNode.replaceChild(newAddPromptBtn, addPromptBtn);
            newAddPromptBtn.addEventListener('click', () => {
                this.openEditor(null, { template: 'prompt' });
            });
        }

        const templateCaret = document.getElementById('add-note-template-btn');
        if (templateCaret) {
            const newCaret = templateCaret.cloneNode(true);
            templateCaret.parentNode.replaceChild(newCaret, templateCaret);
            newCaret.addEventListener('click', (e) => {
                e.stopPropagation();
                this._openNewNoteTemplateMenu(newCaret);
            });
        }

        // Search input — full-text as-you-type, with keyboard navigation
        // through the result rows (Arrow keys + Enter, Escape clears).
        const searchInput = document.getElementById('notes-search');
        const newSearchInput = searchInput.cloneNode(true);
        searchInput.parentNode.replaceChild(newSearchInput, searchInput);
        newSearchInput.addEventListener('input', UIUtils.debounce((e) => {
            this.searchQuery = e.target.value.toLowerCase();
            this.render();
        }, 200));
        newSearchInput.addEventListener('keydown', (e) => this._searchKeydown(e, newSearchInput));

        // Quick capture — Enter creates a note titled with the line and
        // drops the caret into its body.
        const capture = document.getElementById('notes-capture');
        if (capture) {
            const newCapture = capture.cloneNode(true);
            capture.parentNode.replaceChild(newCapture, capture);
            newCapture.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                const title = newCapture.value.trim();
                if (!title) return;
                e.preventDefault();
                const id = this.createNote(title, '');
                newCapture.value = '';
                if (id) this.openEditor(id);
            });
        }

        // Sort select
        const sortSelect = document.getElementById('notes-sort');
        const newSortSelect = sortSelect.cloneNode(true);
        sortSelect.parentNode.replaceChild(newSortSelect, sortSelect);
        newSortSelect.addEventListener('change', (e) => {
            this.sortBy = e.target.value;
            this.render();
        });

        // Create tag button
        const createTagBtn = document.getElementById('create-theme-btn');
        if (createTagBtn) {
            const newCreateTagBtn = createTagBtn.cloneNode(true);
            createTagBtn.parentNode.replaceChild(newCreateTagBtn, createTagBtn);
            newCreateTagBtn.addEventListener('click', () => {
                this.showTagForm();
            });
        }

        // Pane header buttons: pin, show-on-home, PDF export, delete.
        const replaceBtn = (id, handler) => {
            const el = document.getElementById(id);
            if (!el) return null;
            const fresh = el.cloneNode(true);
            el.parentNode.replaceChild(fresh, el);
            fresh.addEventListener('click', handler);
            return fresh;
        };
        replaceBtn('note-pin-btn', () => {
            if (this.currentNoteId) this.togglePin(this.currentNoteId);
        });
        replaceBtn('note-home-btn', () => {
            if (this.currentNoteId) this.toggleShowOnHome(this.currentNoteId);
        });
        const pdfBtn = replaceBtn('note-pdf-btn', () => this.exportCurrentNotePdf(pdfBtn));
        replaceBtn('editor-delete-btn', () => this.deleteCurrentNote());

        // Side-panel toggles (book chapters / prompt settings). Panels are
        // collapsed by default; the choice persists per machine.
        replaceBtn('note-book-toc-toggle', () => this._togglePanel('book'));
        replaceBtn('note-prompt-config-toggle', () => this._togglePanel('prompt'));
    },

    // ── Collapsible side panels (book TOC, prompt config) ──

    _panelOpen(kind) {
        try { return localStorage.getItem(`notes-panel-${kind}`) === '1'; } catch (_) { return false; }
    },

    _togglePanel(kind) {
        const open = !this._panelOpen(kind);
        try { localStorage.setItem(`notes-panel-${kind}`, open ? '1' : '0'); } catch (_) { /* ignore */ }
        this._applyPanelState();
    },

    /**
     * Reflect the stored open/closed preference for the current template's
     * side panel on the frame attribute (CSS shows/hides the panel) and on
     * the toggle buttons' pressed state.
     */
    _applyPanelState() {
        const frame = document.getElementById('note-editor-frame');
        if (!frame) return;
        const template = frame.getAttribute('data-template');
        const collapsible = template === 'book' || template === 'prompt';
        const open = collapsible && this._panelOpen(template);
        if (open) frame.setAttribute('data-panel-open', 'true');
        else frame.removeAttribute('data-panel-open');

        const sync = (id, kind) => {
            const btn = document.getElementById(id);
            if (!btn) return;
            const on = this._panelOpen(kind);
            btn.classList.toggle('is-active', on);
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        };
        sync('note-book-toc-toggle', 'book');
        sync('note-prompt-config-toggle', 'prompt');
    },

    /**
     * Arrow keys walk the list from the search box; Enter opens the row
     * under the cursor (or the first result); Escape clears the query.
     */
    _searchKeydown(e, input) {
        if (e.key === 'Escape') {
            input.value = '';
            this.searchQuery = '';
            input.blur();
            this.render();
            return;
        }
        const rows = Array.from(document.querySelectorAll('#notes-container .notes-list-item'));
        if (!rows.length) return;
        const cur = rows.findIndex(r => r.classList.contains('is-cursor'));
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const next = e.key === 'ArrowDown'
                ? Math.min(rows.length - 1, cur + 1)
                : Math.max(0, (cur < 0 ? rows.length : cur) - 1);
            rows.forEach(r => r.classList.remove('is-cursor'));
            rows[next].classList.add('is-cursor');
            rows[next].scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const row = cur >= 0 ? rows[cur] : rows[0];
            if (row) this.openEditor(row.dataset.noteId);
        }
    },

    /**
     * Toggle pin state for a note.
     */
    togglePin(noteId) {
        const note = this.notes.find(n => n.id === noteId);
        if (!note) return;
        note.pinned = !note.pinned;
        note.modifiedAt = new Date().toISOString();
        this.saveNotes();
        if (this.currentNoteId === noteId) this._updatePinButton(note.pinned);
        this.render();
    },

    toggleShowOnHome(noteId) {
        const note = this.notes.find(n => n.id === noteId);
        if (!note) return;
        note.showOnHome = !note.showOnHome;
        note.modifiedAt = new Date().toISOString();
        this.saveNotes();
        if (this.currentNoteId === noteId) this._updateHomeButton(note.showOnHome);
        this.render();
        UIUtils.showToast(note.showOnHome ? 'Note added to home page' : 'Note removed from home page', 'success');
    },

    _updatePinButton(pinned) {
        const btn = document.getElementById('note-pin-btn');
        if (!btn) return;
        btn.innerHTML = pinned ? '&#128204; Pinned' : '&#128204; Pin';
        btn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
    },

    _updateHomeButton(on) {
        const btn = document.getElementById('note-home-btn');
        if (!btn) return;
        btn.innerHTML = on ? '&#8962; On Home' : '&#8962; Home';
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    },

    /**
     * Export the open note as a PDF: wrap title + content in a print-
     * friendly standalone page and hand it to the generic HTML→PDF IPC
     * (hidden sandboxed window, JS disabled).
     */
    async exportCurrentNotePdf(btn) {
        const note = this.notes.find(n => n.id === this.currentNoteId);
        if (!note || !window.electronExport?.htmlToPdf) return;
        const esc = (t) => UIUtils.escapeHtml(t || '');
        const html = `<!doctype html><html><head><meta charset="utf-8"><style>
            @page { margin: 20mm 18mm; }
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                   color: #1a1a1a; line-height: 1.65; font-size: 12pt; max-width: 46rem; margin: 0 auto; }
            h1.doc-title { font-size: 22pt; margin: 0 0 4pt; }
            .doc-date { color: #666; font-size: 9pt; margin: 0 0 18pt; }
            h1, h2, h3 { line-height: 1.3; page-break-after: avoid; }
            img { max-width: 100%; }
            pre, code { font-family: ui-monospace, Menlo, monospace; font-size: 10pt; background: #f5f5f5; }
            pre { padding: 8pt; overflow-wrap: break-word; white-space: pre-wrap; }
            blockquote { border-left: 3px solid #ccc; margin-left: 0; padding-left: 12pt; color: #444; }
            table { border-collapse: collapse; } td, th { border: 1px solid #ccc; padding: 4pt 8pt; }
            a { color: inherit; }
        </style></head><body>
            <h1 class="doc-title">${esc(note.title)}</h1>
            <p class="doc-date">${esc(UIUtils.formatDateTime(note.modifiedAt))}</p>
            ${this._safeNoteHtml(note.content)}
        </body></html>`;
        if (btn) btn.disabled = true;
        try {
            const res = await window.electronExport.htmlToPdf({ html, title: note.title });
            if (res?.ok) UIUtils.showToast(`PDF saved: ${res.path}`, 'success', 5000);
            else if (res?.error) UIUtils.showToast(`Export failed: ${res.error}`, 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    },

    // L3: note content is stored HTML and rendered via innerHTML. RichEditor
    // sanitizes on paste, but a note synced from another Mac (or an older
    // build) could carry unsanitized markup — sanitize again on every render
    // so a stored <img onerror> / <script> can never execute here.
    _safeNoteHtml(content) {
        const html = content || '';
        return (typeof RichEditor !== 'undefined' && RichEditor.sanitizeHtml)
            ? RichEditor.sanitizeHtml(html) : html;
    },

    /**
     * Legacy entry point (deep links, cross-app link rows, the feed).
     * The read-only viewer is gone — everything opens in the editable pane.
     */
    openViewer(noteId, opts = {}) {
        if (!noteId) return;
        this.openEditor(noteId, opts);
    },

    /**
     * Connections cluster below the note: backlinks ("Linked from"),
     * locally-computed related notes, cross-app links, and the prompt ↔
     * feed cross-references ported from the old viewer.
     */
    _renderConnections(noteId) {
        const container = document.getElementById('note-connections');
        if (!container) return;
        if (!noteId) { container.innerHTML = ''; return; }
        const current = this.notes.find(n => n.id === noteId);
        if (!current) { container.innerHTML = ''; return; }

        let head = '';
        const noteRow = (n) => `
            <div class="note-viewer-link-item" data-note-id="${n.id}">
                <span class="note-conn-title">${UIUtils.escapeHtml(n.title || 'Untitled')}</span>
                <span class="note-conn-date">${UIUtils.formatDate(n.modifiedAt)}</span>
            </div>`;

        // Backlinks — notes whose body wiki-links to this one.
        const needle = `#note:${noteId}`;
        const backlinks = this.notes
            .filter(n => n.id !== noteId && (n.content || '').includes(needle))
            .sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
        if (backlinks.length) {
            head += `<div class="note-viewer-link-section">
                <h4 class="note-viewer-link-label">Linked from</h4>
                ${backlinks.map(noteRow).join('')}
            </div>`;
        }

        // Related notes — notes sharing at least one tag, with the
        // matching tags shown so the connection is self-explanatory.
        const related = this._relatedNotes(current, 5)
            .filter(n => !backlinks.some(b => b.id === n.id));
        if (related.length) {
            const relatedRow = (n) => `
                <div class="note-viewer-link-item" data-note-id="${n.id}">
                    <span class="note-conn-title">${UIUtils.escapeHtml(n.title || 'Untitled')}</span>
                    <span class="note-conn-tags">${(n._sharedTags || []).map(t =>
                        `<span class="note-conn-tag">#${UIUtils.escapeHtml(t)}</span>`).join(' ')}</span>
                    <span class="note-conn-date">${UIUtils.formatDate(n.modifiedAt)}</span>
                </div>`;
            head += `<div class="note-viewer-link-section">
                <h4 class="note-viewer-link-label">Related notes</h4>
                ${related.map(relatedRow).join('')}
            </div>`;
        }

        this._renderCrossAppConnections(container, noteId, head);
    },

    _renderCrossAppConnections(container, noteId, head) {

        const resolved = LinkManager.resolveLinks('notes', noteId);
        const sections = [
            { app: 'focus', label: 'Focus area' },
            { app: 'goals', label: 'Goal' },
            { app: 'schedule', label: 'Task' },
            { app: 'portfolio', label: 'Portfolio' }
        ];

        let html = head || '';
        for (const section of sections) {
            const items = resolved[section.app] || [];
            if (items.length === 0) continue;

            html += `<div class="note-viewer-link-section">
                <h4 class="note-viewer-link-label">${section.label}</h4>`;
            for (const item of items) {
                html += `<div class="note-viewer-link-item" data-app="${section.app}" data-item-id="${item.itemId}">
                    <span>${UIUtils.escapeHtml(item.title)}</span>
                </div>`;
            }
            html += '</div>';
        }

        // Prompt ↔ feed-post cross-links. A feed post IS a note generated by
        // a prompt note (note.feed.promptId), so the two are made reachable
        // from each other: an output links to its prompt, a prompt lists its
        // recent outputs. These are derived, not LinkManager links.
        const note = this.notes.find(n => n.id === noteId);
        const tplOf = (n) => (typeof NoteTemplates !== 'undefined' ? NoteTemplates.resolve(n) : n && n.template);
        if (note && tplOf(note) === 'feed' && note.feed && note.feed.promptId) {
            const promptNote = this.notes.find(n => n.id === note.feed.promptId);
            if (promptNote) {
                html += `<div class="note-viewer-link-section">
                    <h4 class="note-viewer-link-label">Prompt</h4>
                    <div class="note-viewer-link-item" data-note-id="${promptNote.id}">
                        <span>${UIUtils.escapeHtml(promptNote.title || 'Untitled prompt')}</span>
                    </div>
                </div>`;
            }
        } else if (note && tplOf(note) === 'prompt') {
            const outputs = this.notes
                .filter(n => tplOf(n) === 'feed' && n.feed && n.feed.promptId === noteId)
                .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
                .slice(0, 10);
            if (outputs.length) {
                // Mini feed cards (home-feed look, fewer characters): a meta
                // line plus a short clamped text preview, each opening the run.
                const preview = (o) => {
                    if (o.feed && o.feed.error) return o.feed.error;
                    const tmp = document.createElement('div');
                    tmp.innerHTML = o.content || '';
                    const text = (tmp.textContent || '').replace(/\s+/g, ' ').trim();
                    return text.length > 180 ? text.slice(0, 180).trimEnd() + '…' : text;
                };
                html += `<div class="note-viewer-link-section">
                    <h4 class="note-viewer-link-label">Feed posts</h4>
                    <div class="note-prompt-runs">`;
                for (const o of outputs) {
                    const when = o.createdAt
                        ? new Date(o.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                        : '';
                    const model = (o.feed && o.feed.model)
                        ? String(o.feed.model).split('/').pop().replace(/\.gguf$/i, '')
                        : '';
                    html += `<article class="note-prompt-run" data-note-id="${o.id}" title="Open this post">
                        <div class="note-prompt-run-meta">${UIUtils.escapeHtml(when)}${model ? ' &middot; ' + UIUtils.escapeHtml(model) : ''}</div>
                        <p class="note-prompt-run-preview">${UIUtils.escapeHtml(preview(o))}</p>
                    </article>`;
                }
                html += '</div></div>';
            }
        }

        container.innerHTML = html;

        // Click to navigate
        container.querySelectorAll('.note-viewer-link-item, .note-prompt-run').forEach(el => {
            el.addEventListener('click', () => {
                if (el.dataset.noteId) {
                    this.openEditor(el.dataset.noteId);
                    return;
                }
                LinkedItemsUI.navigateToItem(el.dataset.app, el.dataset.itemId);
            });
        });
    },

    /**
     * Legacy alias — callers that used to close the read-only viewer.
     */
    closeViewer() {
        this.closeEditor();
    },

    /**
     * Map a (node, offset) inside `root` to a single integer character
     * index over root's concatenated text. Returns -1 if the node isn't
     * inside root. Used by the dbl-click-to-edit handoff so we can
     * locate the same spot inside the editor's contenteditable, which
     * is a freshly built DOM tree with different node identity.
     */
    _textOffsetFromRange(root, targetNode, targetOffset) {
        if (!root || !targetNode || !root.contains(targetNode)) return -1;
        let offset = 0;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        let node;
        while ((node = walker.nextNode())) {
            if (node === targetNode) return offset + Math.min(targetOffset, node.length);
            offset += node.length;
        }
        // If the target was an element node (e.g. dbl-click outside any
        // text), fall back to the offset accumulated so far.
        return offset;
    },

    /**
     * Inverse of _textOffsetFromRange: place a collapsed caret at the
     * given text offset inside `root`. Returns the text node the caret
     * landed in (or the last text node if `offset` overshoots), or null
     * if the root has no text at all.
     */
    _placeCaretAtTextOffset(root, offset) {
        if (!root) return null;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        let node, lastNode = null;
        let remaining = Math.max(0, offset);
        while ((node = walker.nextNode())) {
            lastNode = node;
            if (remaining <= node.length) {
                const range = document.createRange();
                range.setStart(node, remaining);
                range.collapse(true);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
                return node;
            }
            remaining -= node.length;
        }
        if (lastNode) {
            const range = document.createRange();
            range.setStart(lastNode, lastNode.length);
            range.collapse(true);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        }
        return lastNode;
    },

    /**
     * Open a note in the always-editable pane (or start a new draft when
     * `noteId` is null). Ensures the Notes app is the active view first,
     * so cross-app callers (deep links, the assistant, link rows) land
     * correctly.
     *
     * `opts.template` is honored only for brand-new notes. Existing notes
     * read their template from storage (use `setCurrentNoteTemplate()` to
     * convert in place).
     */
    openEditor(noteId = null, opts = {}) {
        if (typeof AppManager !== 'undefined' && AppManager.currentApp !== 'notes') {
            AppManager.openApp('notes', false);
        }
        this._loadNoteIntoPane(noteId, opts);
    },

    /** The note pane — the scroll container on wide windows. */
    _paneEl() {
        return document.getElementById('notes-note-pane');
    },

    /** Scroll the note back to its top (pane scroll on wide windows,
     *  page scroll in the stacked fallback — resetting both is safe). */
    _scrollPaneTop() {
        const pane = this._paneEl();
        if (pane) pane.scrollTop = 0;
        window.scrollTo({ top: 0 });
    },

    _loadNoteIntoPane(noteId = null, opts = {}) {
        // Flush the outgoing session before swapping notes.
        if (this._paneSessionActive && this.hasUnsavedChanges) this.saveCurrentNote(true);
        this._teardownEditorSession();

        this.currentNoteId = noteId;
        this._editorOrigin = opts.origin || null;
        this.pendingTemplate = null;
        this._paneSessionActive = true;

        const host = document.getElementById('note-editor-view');
        const emptyState = document.getElementById('notes-note-empty');
        if (host) host.hidden = false;
        if (emptyState) emptyState.hidden = true;

        AppManager.setDetailHash('notes', noteId ? 'view' : null, noteId || null);

        const note = noteId ? this.notes.find(n => n.id === noteId) : null;
        this.renderEditorBreadcrumb(noteId, note?.title);
        NotesUI.updateSelection();

        // Resolve the effective template: existing notes use their stored
        // template; new notes use opts.template (default 'blank').
        const template = note ? NoteTemplates.resolve(note) : (opts.template || 'blank');
        this.currentTemplate = template;
        if (!note) this.pendingTemplate = template;
        // Numbering: default ON; legacy and existing book notes without
        // the field stay numbered (back-compat with the original ship).
        this.currentBookNumbered = note ? (note.bookNumbered !== false) : true;
        // Layout: default 'scroll' (long page); 'paged' shows one chapter.
        this.currentBookLayout = (note && note.bookLayout === 'paged') ? 'paged' : 'scroll';
        // Caller (e.g. viewer→editor handoff) can preselect the chapter
        // so a paged edit picks up where the reader left off.
        const optChapter = (typeof opts.chapterIndex === 'number' && opts.chapterIndex >= 0)
            ? opts.chapterIndex : 0;
        this.currentBookChapterIndex = optChapter;
        // Prompt-template run config (defaults for a new note).
        this.currentPrompt = NotePrompts.config(note);
        this._applyEditorTemplateChrome(template, this.currentBookNumbered, this.currentBookLayout);

        // RichEditor v2: selection toolbar, slash menu, markdown shortcuts,
        // link popover, and live word count emission.
        RichEditor.init('note-content-editor', null, () => {
            this.markAsUnsaved();
            this.autoSave();
        }, {
            selectionToolbar: true,
            markdownShortcuts: true,
            slashMenu: true,
            linkPopover: true,
            onWordCount: ({ words }) => {
                const el = document.getElementById('note-word-count');
                if (el) el.textContent = `${words} word${words === 1 ? '' : 's'}`;
            }
        });

        const titleInput = document.getElementById('note-title-input');
        const newTitleInput = titleInput.cloneNode(true);
        titleInput.parentNode.replaceChild(newTitleInput, titleInput);
        const autosizeTitle = () => {
            newTitleInput.style.height = 'auto';
            newTitleInput.style.height = newTitleInput.scrollHeight + 'px';
        };
        newTitleInput.addEventListener('input', () => {
            autosizeTitle();
            this.markAsUnsaved();
        });
        // Title is semantically single-line; Enter moves focus to the body
        // instead of inserting a newline.
        newTitleInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const editor = document.getElementById('note-content-editor');
                if (editor) editor.focus();
            }
        });

        // Load note state
        if (noteId && note) {
            newTitleInput.value = note.title;
            RichEditor.setHTML(note.content);
            this._renderEditorTagPills(note.tags || []);
        } else {
            // Quick-capture handoff can prefill the title/body (opts.title,
            // opts.content as HTML) so "expand" carries over what was typed.
            newTitleInput.value = opts.title || '';
            const seed = NoteTemplates.get(template).seed();
            if (opts.content) RichEditor.setHTML(opts.content);
            // Seed brand-new notes with template-provided starter content
            // (e.g. a "Chapter 1" H1 for the book template). Blank stays
            // empty so it matches the today behavior exactly.
            else if (seed.content) RichEditor.setHTML(seed.content);
            else RichEditor.clear();
            this._renderEditorTagPills([]);
        }
        autosizeTitle();

        this._setupEditorTagPicker();
        this._setupEditorTemplateMenu();
        this._setupEditorFocusMode();
        if (template === 'book') this._setupBookEditor();
        else if (template === 'prompt') this._setupPromptEditor();
        this.updateSaveStatus('saved');

        // Connections (existing notes only; a fresh draft has nothing
        // to link against yet).
        this._renderConnections(noteId);
        this._updatePinButton(!!note?.pinned);
        this._updateHomeButton(!!note?.showOnHome);

        // For a new note (no title yet) focus the title; for existing
        // notes land in the content editor — at a specific text offset
        // if the caller supplied one (dbl-click-to-edit), otherwise at
        // the end so the user can resume writing. The caretOffset path
        // also keeps the user at their current scroll position by
        // scrolling the caret into view instead of jumping to the top.
        const caretOffset = (typeof opts.caretOffset === 'number' && opts.caretOffset >= 0)
            ? opts.caretOffset : null;
        setTimeout(() => {
            autosizeTitle();
            if (noteId && note) {
                const editor = document.getElementById('note-content-editor');
                if (editor) {
                    editor.focus({ preventScroll: true });
                    if (caretOffset != null) {
                        // In paged book layout, the editor only shows one
                        // chapter — swap to the one containing this offset
                        // BEFORE placing the caret, otherwise the caret
                        // would land inside a hidden chapter.
                        if (this.currentTemplate === 'book' && this.currentBookLayout === 'paged') {
                            const targetChapter = this._chapterIndexForTextOffset(editor, caretOffset);
                            this._applyPagedView('editor', targetChapter);
                        }
                        const placed = this._placeCaretAtTextOffset(editor, caretOffset);
                        const anchorEl = (placed && placed.parentElement) || editor;
                        anchorEl.scrollIntoView({ block: 'center', behavior: 'auto' });
                    } else {
                        const range = document.createRange();
                        range.selectNodeContents(editor);
                        range.collapse(false);
                        const sel = window.getSelection();
                        sel.removeAllRanges();
                        sel.addRange(range);
                        this._scrollPaneTop();
                    }
                }
            } else {
                newTitleInput.focus();
                this._scrollPaneTop();
            }
        }, 100);
    },

    /**
     * Deselect the open note: save, tear the session down, show the
     * empty pane — or return to the origin app when one opened us.
     */
    closeEditor() {
        if (this._paneSessionActive) this.saveCurrentNote(true);
        const origin = this._editorOrigin;
        this._editorOrigin = null;
        this._clearSelection();
        if (origin && typeof origin === 'object' && origin.app) {
            LinkedItemsUI.navigateToItem(origin.app, origin.itemId);
        }
    },

    /**
     * Tear down the live editor session (listeners, template chrome).
     * Does NOT save — callers flush first when they need to.
     */
    _teardownEditorSession() {
        if (!this._paneSessionActive) return;
        RichEditor.destroy();

        if (this._focusModeHandler) {
            document.removeEventListener('keydown', this._focusModeHandler);
            this._focusModeHandler = null;
        }
        const host = document.getElementById('note-editor-view');
        if (host) host.removeAttribute('data-focus-mode');
        document.getElementById('notes-view')?.classList.remove('notes-maximized');

        if (typeof TagPicker !== 'undefined') TagPicker.close();
        if (typeof WordLookup !== 'undefined') WordLookup.dismiss();
        this._closeWikiMenu();
        this._teardownBookEditor();
        this._teardownPromptEditor();
        this._paneSessionActive = false;
    },

    _clearSelection() {
        this._teardownEditorSession();
        this.currentNoteId = null;
        this.currentTemplate = 'blank';
        this.pendingTemplate = null;
        this.currentPrompt = null;
        this.autoLinkContext = null;
        this.hasUnsavedChanges = false;

        const host = document.getElementById('note-editor-view');
        if (host) host.hidden = true;
        const emptyState = document.getElementById('notes-note-empty');
        if (emptyState) emptyState.hidden = false;

        AppManager.setDetailHash('notes', null, null);
        if (AppManager.currentApp === 'notes') this.render();
    },

    /**
     * Mark as unsaved
     */
    markAsUnsaved() {
        this.hasUnsavedChanges = true;
        this.updateSaveStatus('unsaved');
    },

    /**
     * Three-state save indicator: saved | saving | unsaved.
     * Mirrors the journal editor for visual consistency.
     */
    updateSaveStatus(status) {
        const statusEl = document.getElementById('note-save-status');
        if (!statusEl) return;
        statusEl.dataset.state = status;
        const label = statusEl.querySelector('.note-save-label');
        if (!label) return;
        if (status === 'saving') label.textContent = 'Saving…';
        else if (status === 'saved') { label.textContent = 'Saved'; this.hasUnsavedChanges = false; }
        else if (status === 'unsaved') label.textContent = 'Unsaved';
    },

    /**
     * Render selected-tag pills inside the meta strip. The "+ Add tag"
     * button stays at the end so the cluster reads tag, tag, tag, +Add.
     */
    _renderEditorTagPills(tags = []) {
        const container = document.getElementById('note-tags-container');
        const addBtn = document.getElementById('note-tag-add-btn');
        if (!container || !addBtn) return;

        container.querySelectorAll('.tag-item').forEach(t => t.remove());
        tags.forEach(tag => {
            container.insertBefore(this._buildTagPill(tag), addBtn);
        });
    },

    _buildTagPill(tag) {
        const el = document.createElement('span');
        el.className = 'tag-item';
        el.dataset.tagName = tag;
        el.innerHTML = `
            ${UIUtils.escapeHtml(tag)}
            <button type="button" class="tag-remove" aria-label="Remove tag">×</button>
        `;
        el.querySelector('.tag-remove').addEventListener('click', () => {
            el.remove();
            this.markAsUnsaved();
            this.autoSave();
        });
        return el;
    },

    _getSelectedEditorTagPills() {
        return Array.from(document.querySelectorAll('#note-tags-container .tag-item'))
            .map(el => el.dataset.tagName)
            .filter(Boolean);
    },

    /**
     * Wire the "+ Add tag" button to TagPicker. Existing tags from the
     * notes tag library show as pickable rows; typing a name not in the
     * library creates it in the library and attaches it.
     */
    _setupEditorTagPicker() {
        const addBtn = document.getElementById('note-tag-add-btn');
        if (!addBtn) return;
        const newBtn = addBtn.cloneNode(true);
        addBtn.parentNode.replaceChild(newBtn, addBtn);

        newBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (typeof TagPicker === 'undefined') return;
            TagPicker.open({
                anchor: newBtn,
                suggestions: this.activeProfileTags().map(t => t.name).sort((a, b) => a.localeCompare(b)),
                selected: this._getSelectedEditorTagPills(),
                placeholder: 'Search or create…',
                onAdd: (name) => this._attachTagToCurrentNote(name)
            });
        });
    },

    _attachTagToCurrentNote(name) {
        const trimmed = String(name || '').trim();
        if (!trimmed) return;
        // Promote to the active profile's library if it's new there
        // (case-insensitive match). A same-named tag in another profile
        // doesn't count — each profile keeps its own copy.
        const existing = this.activeProfileTags().find(t => t.name.toLowerCase() === trimmed.toLowerCase());
        let tagName = existing ? existing.name : trimmed;
        if (!existing) {
            this.tags.push({ id: UIUtils.generateId(), name: tagName, profile: ProfileManager.getProfileForNewItem(), createdAt: new Date().toISOString() });
            this.saveTags();
        }
        const current = this._getSelectedEditorTagPills();
        if (current.includes(tagName)) return;
        const container = document.getElementById('note-tags-container');
        const addBtn = document.getElementById('note-tag-add-btn');
        container.insertBefore(this._buildTagPill(tagName), addBtn);
        this.markAsUnsaved();
        this.autoSave();
    },

    _setupEditorFocusMode() {
        const btn = document.getElementById('note-focus-mode-btn');
        const view = document.getElementById('note-editor-view');
        if (!btn || !view) return;
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);

        const toggle = () => {
            const on = view.getAttribute('data-focus-mode') === 'true';
            view.setAttribute('data-focus-mode', on ? 'false' : 'true');
            newBtn.classList.toggle('is-active', !on);
            // Maximize: the nav + list columns give way so the note takes
            // the full frame (this is what the button promises).
            document.getElementById('notes-view')?.classList.toggle('notes-maximized', !on);
        };
        newBtn.addEventListener('click', toggle);

        this._focusModeHandler = (e) => {
            if (e.key === 'f' || e.key === 'F') {
                const target = e.target;
                const editing = target?.closest?.('input, textarea, [contenteditable="true"]');
                if (editing) return;
                // The host is a pane now, not a routed view — act only when
                // it's visible inside the active Notes app.
                if (!view.hidden && AppManager.currentApp === 'notes') toggle();
            }
        };
        document.addEventListener('keydown', this._focusModeHandler);
    },

    /**
     * Auto-save current note
     */
    autoSave() {
        if (this.currentNoteId || RichEditor.getText().trim().length > 0) {
            this.updateSaveStatus('saving');
            setTimeout(() => {
                this.saveCurrentNote(true);
                this.updateSaveStatus('saved');
            }, 1000);
        }
    },

    /**
     * Save current note being edited
     */
    saveCurrentNote(silent = false) {
        const title = document.getElementById('note-title-input').value.trim() || 'Untitled';
        // Read our own element rather than RichEditor.getHTML() — RichEditor
        // is a singleton shared with Journal, and a late save timer must
        // never read whichever surface it is bound to now.
        const editorEl = document.getElementById('note-content-editor');
        const content = this._sanitizeBookViewArtifacts(editorEl ? editorEl.innerHTML : '');
        const selectedTags = this._getSelectedEditorTagPills();
        const profile = ProfileManager.getProfileForNewItem();

        if (this.currentNoteId) {
            // Update existing note
            const note = this.notes.find(n => n.id === this.currentNoteId);
            if (note) {
                note.title = title;
                note.content = content;
                note.tags = selectedTags;
                note.template = this.currentTemplate || NoteTemplates.resolve(note);
                note.bookNumbered = this.currentBookNumbered;
                note.bookLayout = this.currentBookLayout;
                if (note.template === 'prompt') note.prompt = this.currentPrompt || NotePrompts.config(note);
                note.profile = profile;
                note.modifiedAt = new Date().toISOString();
            }
        } else {
            // Create new note only if there's content
            if (content.trim().length > 0 || title !== 'Untitled') {
                const newNote = {
                    id: UIUtils.generateId(),
                    title,
                    content,
                    tags: selectedTags,
                    template: this.pendingTemplate || this.currentTemplate || 'blank',
                    bookNumbered: this.currentBookNumbered,
                    bookLayout: this.currentBookLayout,
                    profile,
                    pinned: false,
                    createdAt: new Date().toISOString(),
                    modifiedAt: new Date().toISOString()
                };
                if (newNote.template === 'prompt') {
                    newNote.prompt = this.currentPrompt || { ...NotePrompts.DEFAULTS };
                }
                this.notes.unshift(newNote);
                this.currentNoteId = newNote.id;
                this.pendingTemplate = null;

                // Auto-link if context was set (e.g., creating note from focus/goal/task view)
                if (this.autoLinkContext) {
                    for (const ctx of this.autoLinkContext) {
                        LinkManager.addLink(ctx.app, ctx.itemId, 'notes', newNote.id);
                    }
                    this.autoLinkContext = null;
                }
            }
        }

        this.saveNotes();
        // A newly-enabled background prompt should start producing without
        // waiting for the next scheduler poll.
        if (this.currentTemplate === 'prompt' && typeof PromptFeed !== 'undefined' && PromptFeed.onPromptsChanged) {
            PromptFeed.onPromptsChanged();
        }
        // Keep the list column and hash in step with the pane. The hash is
        // only touched while Notes is the active app — a late autosave
        // timer must not stomp another app's URL.
        if (AppManager.currentApp === 'notes' && this.currentNoteId) {
            AppManager.setDetailHash('notes', 'view', this.currentNoteId);
        }
        this._renderListSoon();
        if (!silent) {
            this.updateSaveStatus('saved');
            UIUtils.showToast('Note saved', 'success');
        }
    },

    /**
     * Debounced list refresh — autosave fires every second while typing;
     * rebuilding the list (title/preview/sort order) at that rate is
     * wasteful and would eat the search cursor.
     */
    _renderListSoon() {
        if (this._listRefreshTimer) clearTimeout(this._listRefreshTimer);
        this._listRefreshTimer = setTimeout(() => {
            this._listRefreshTimer = null;
            if (AppManager.currentApp === 'notes') this.render();
        }, 400);
    },

    /**
     * Delete current note
     */
    async deleteCurrentNote() {
        if (!this.currentNoteId) return;

        const confirmed = await UIUtils.confirm(
            'Delete Note',
            'Are you sure you want to delete this note?',
            '🗑️'
        );

        if (confirmed) {
            LinkManager.removeAllLinksForItem('notes', this.currentNoteId);
            this.notes = this.notes.filter(n => n.id !== this.currentNoteId);
            this.saveNotes();

            // The note is gone — skip any outgoing-save flush.
            this.hasUnsavedChanges = false;
            this._editorOrigin = null;
            this._clearSelection();

            UIUtils.showToast('Note deleted', 'success');
        }
    },

    // ============================================================
    // Templates — book mode chrome, picker menus, chapter navigation.
    // See js/apps/notes/note-templates.js for the registry.
    // ============================================================

    /**
     * Toggle the editor's template-specific chrome (frame attr drives
     * the TOC sidebar + chapter numbering via CSS). Also updates the
     * inline "Template: …" label in the meta strip.
     */
    _applyEditorTemplateChrome(template, numbered = true, layout = 'scroll') {
        const frame = document.getElementById('note-editor-frame');
        if (frame) {
            frame.setAttribute('data-template', template);
            // Propagate the numbering flag to the frame too so the TOC
            // sidebar (a sibling of the content root) can hide its own
            // chapter numbers via a single ancestor selector.
            if (numbered) frame.removeAttribute('data-book-numbered');
            else frame.setAttribute('data-book-numbered', 'false');
            // Layout drives whether the writing column shows all chapters
            // (scroll) or just one (paged). CSS hides .book-chapter-hidden
            // descendants only when this attribute is set.
            if (layout === 'paged') frame.setAttribute('data-book-layout', 'paged');
            else frame.removeAttribute('data-book-layout');
        }
        const editor = document.getElementById('note-content-editor');
        if (editor) {
            editor.setAttribute('data-template', template);
            // The CSS uses :not([data-book-numbered="false"]) so we only
            // need to set the attribute when numbering is off.
            if (numbered) editor.removeAttribute('data-book-numbered');
            else editor.setAttribute('data-book-numbered', 'false');
        }
        const def = NoteTemplates.get(template);
        const iconEl = document.getElementById('note-template-btn-icon');
        const labelEl = document.getElementById('note-template-btn-label');
        if (iconEl) iconEl.innerHTML = def.icon;
        if (labelEl) labelEl.textContent = def.label;
        this._updateNumberedBtnState(numbered);
        this._updateLayoutBtnState('editor', layout);
        this._applyPanelState();
    },

    /**
     * Reflect the current numbering setting in the toggle button's
     * pressed state. Listener wiring happens in _setupEditorNumberedToggle.
     */
    _updateNumberedBtnState(numbered) {
        const btn = document.getElementById('note-book-numbered-btn');
        if (!btn) return;
        btn.classList.toggle('is-active', !!numbered);
        btn.setAttribute('aria-pressed', numbered ? 'true' : 'false');
    },

    _setupEditorNumberedToggle() {
        const btn = document.getElementById('note-book-numbered-btn');
        if (!btn) return;
        const fresh = btn.cloneNode(true);
        btn.parentNode.replaceChild(fresh, btn);
        this._updateNumberedBtnState(this.currentBookNumbered);
        fresh.addEventListener('click', () => {
            this.currentBookNumbered = !this.currentBookNumbered;
            this._applyEditorTemplateChrome(this.currentTemplate, this.currentBookNumbered, this.currentBookLayout);
            this.markAsUnsaved();
            this.autoSave();
        });
    },

    /**
     * Reflect the current paged/scroll preference in the toggle's pressed
     * state.
     */
    _updateLayoutBtnState(scope, layout) {
        const btn = document.getElementById('note-book-layout-btn');
        if (!btn) return;
        const paged = layout === 'paged';
        btn.classList.toggle('is-active', paged);
        btn.setAttribute('aria-pressed', paged ? 'true' : 'false');
    },

    /**
     * Wire the per-note layout toggle. Switching swaps the rendering
     * immediately and marks the note as unsaved so the choice persists
     * with autosave.
     */
    _setupLayoutToggle(scope) {
        const btn = document.getElementById('note-book-layout-btn');
        if (!btn) return;
        const fresh = btn.cloneNode(true);
        btn.parentNode.replaceChild(fresh, btn);
        this._updateLayoutBtnState('editor', this.currentBookLayout);
        fresh.addEventListener('click', () => {
            const next = this.currentBookLayout === 'paged' ? 'scroll' : 'paged';
            this.setBookLayout(next);
        });
    },

    /**
     * Switch the active book note between scroll and paged layouts.
     */
    setBookLayout(layout) {
        const next = layout === 'paged' ? 'paged' : 'scroll';
        if (next === this.currentBookLayout) return;
        this.currentBookLayout = next;
        this._applyEditorTemplateChrome(this.currentTemplate, this.currentBookNumbered, next);
        this._setupBookEditor();
        this.markAsUnsaved();
        this.autoSave();
    },

    /**
     * Popover menu for the "+ New Note" caret. Lets the user create a
     * note with a non-default template.
     */
    _openNewNoteTemplateMenu(anchor) {
        this._openTemplateMenu(anchor, NoteTemplates.resolve({}), (template) => {
            this.openEditor(null, { template });
        });
    },

    /**
     * Inline "Template: …" button in the editor meta strip. Lets the user
     * convert the current note's template in place — chapters are H1s, so
     * the content is preserved either way.
     */
    _setupEditorTemplateMenu() {
        const btn = document.getElementById('note-template-btn');
        if (!btn) return;
        const fresh = btn.cloneNode(true);
        btn.parentNode.replaceChild(fresh, btn);
        fresh.addEventListener('click', (e) => {
            e.stopPropagation();
            this._openTemplateMenu(fresh, this.currentTemplate, (template) => {
                this.setCurrentNoteTemplate(template);
            });
        });
    },

    /**
     * Render and anchor a small popover that lists available templates.
     * The picked template is passed to `onPick(id)`. Closing handled by
     * outside-click / Escape / a second click on the anchor.
     */
    _openTemplateMenu(anchor, currentId, onPick) {
        // Close any existing menu first so a second caret-click toggles.
        const existing = document.getElementById('note-template-menu');
        if (existing) {
            existing.remove();
            if (anchor) anchor.setAttribute('aria-expanded', 'false');
            if (existing._anchor === anchor) return; // toggle-off
        }

        const menu = document.createElement('div');
        menu.id = 'note-template-menu';
        menu.className = 'note-template-menu';
        menu.setAttribute('role', 'menu');
        menu._anchor = anchor;
        menu.innerHTML = NoteTemplates.list().filter(def => !def.system || def.id === currentId).map(def => `
            <button type="button" class="note-template-menu-item ${def.id === currentId ? 'is-current' : ''}" role="menuitem" data-template-id="${def.id}">
                <span class="note-template-menu-icon">${def.icon}</span>
                <span class="note-template-menu-body">
                    <span class="note-template-menu-label">${UIUtils.escapeHtml(def.label)}${def.id === currentId ? '  &middot;  current' : ''}</span>
                    <span class="note-template-menu-desc">${UIUtils.escapeHtml(def.description)}</span>
                </span>
            </button>
        `).join('');

        document.body.appendChild(menu);
        if (anchor) anchor.setAttribute('aria-expanded', 'true');

        // Position below the anchor, right-aligned so it doesn't clip
        // off the right edge when the anchor sits near the toolbar end.
        const rect = anchor.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const top = rect.bottom + window.scrollY + 6;
        let left = rect.right + window.scrollX - menuRect.width;
        if (left < 8) left = 8;
        menu.style.top = `${top}px`;
        menu.style.left = `${left}px`;

        const close = () => {
            menu.remove();
            if (anchor) anchor.setAttribute('aria-expanded', 'false');
            document.removeEventListener('click', onDocClick, true);
            document.removeEventListener('keydown', onKey, true);
        };
        const onDocClick = (e) => {
            if (!menu.contains(e.target) && e.target !== anchor) close();
        };
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        // defer so the click that opened us doesn't immediately close it
        setTimeout(() => {
            document.addEventListener('click', onDocClick, true);
            document.addEventListener('keydown', onKey, true);
        }, 0);

        menu.querySelectorAll('.note-template-menu-item').forEach(item => {
            item.addEventListener('click', () => {
                const id = item.dataset.templateId;
                close();
                onPick(id);
            });
        });
    },

    /**
     * Convert the currently-open editor note to a different template.
     * Content stays put — H1 chapters render the same in both modes.
     */
    setCurrentNoteTemplate(template) {
        const def = NoteTemplates.get(template);
        if (!def || template === this.currentTemplate) return;

        const previous = this.currentTemplate;
        this.currentTemplate = template;
        if (!this.currentNoteId) this.pendingTemplate = template;
        this._applyEditorTemplateChrome(template, this.currentBookNumbered, this.currentBookLayout);

        // Leaving a template tears down its chrome; entering one sets it up.
        if (previous === 'book') this._teardownBookEditor();
        if (previous === 'prompt') this._teardownPromptEditor();

        if (template === 'book') {
            // Seed an empty editor with a Chapter 1 H1 so the TOC has
            // something to anchor on. An editor with prior content keeps
            // it untouched — any existing H1s become chapters.
            const editor = document.getElementById('note-content-editor');
            const hasContent = editor && editor.textContent.trim().length > 0;
            if (editor && !hasContent) {
                RichEditor.setHTML(NoteTemplates.get('book').seed().content);
            }
            this._setupBookEditor();
        } else if (template === 'prompt') {
            this.currentPrompt = this.currentPrompt || { ...NotePrompts.DEFAULTS };
            this._setupPromptEditor();
        }

        this.markAsUnsaved();
        this.autoSave();
        UIUtils.showToast(`Switched to ${def.label}`, 'success');
    },

    // -----------------------------
    // Book editor — TOC + scroll-spy
    // -----------------------------

    _setupBookEditor() {
        this._teardownBookEditor();
        const editor = document.getElementById('note-content-editor');
        if (!editor) return;

        this._renderEditorToc();
        this._applyTocWidth(this._loadTocWidth());
        this._setupTocResizer('note-book-toc-resizer-editor', 'note-editor-frame');
        this._setupEditorNumberedToggle();
        this._setupLayoutToggle('editor');

        // Re-render the TOC whenever the editor content changes. Debounced
        // to avoid thrashing on every keystroke during a chapter rename.
        // In paged mode we also re-tag chapters and follow the cursor if
        // a new H1 puts it in a different chapter.
        this._bookEditorInputHandler = () => {
            if (this._bookTocRenderTimer) clearTimeout(this._bookTocRenderTimer);
            this._bookTocRenderTimer = setTimeout(() => {
                this._renderEditorToc();
                if (this.currentBookLayout === 'paged') {
                    // Re-tag first so chapter indices reflect any new H1s
                    // the user just typed; otherwise _chapterIndexForCursor
                    // would read a stale tag and we'd switch to the wrong
                    // chapter.
                    this._tagChaptersInRoot(editor);
                    const cursorIdx = this._chapterIndexForCursor(editor);
                    const idx = cursorIdx >= 0 ? cursorIdx : this.currentBookChapterIndex;
                    this._applyPagedView('editor', idx);
                }
            }, 120);
        };
        editor.addEventListener('input', this._bookEditorInputHandler);

        if (this.currentBookLayout === 'paged') {
            // Show only one chapter at a time. Start at chapter 0; for an
            // editor opened via dbl-click-to-edit, the caretOffset will be
            // honored separately and may switch to a different chapter.
            this._applyPagedView('editor', this.currentBookChapterIndex || 0);
        } else {
            // Scroll-spy: highlight the active chapter as the user scrolls.
            // The pane owns the scroll on wide windows; the stacked fallback
            // still scrolls the page — listen on both.
            this._bookEditorScrollHandler = () => this._updateActiveTocItem('editor');
            window.addEventListener('scroll', this._bookEditorScrollHandler, { passive: true });
            this._paneEl()?.addEventListener('scroll', this._bookEditorScrollHandler, { passive: true });
        }

        // Editor pager (prev/next chapter). Wired in both modes so users
        // can hop chapters without scrolling either way.
        this._wireChapterPager('editor');

        const addBtn = document.getElementById('note-book-add-chapter-btn');
        if (addBtn) {
            const fresh = addBtn.cloneNode(true);
            addBtn.parentNode.replaceChild(fresh, addBtn);
            fresh.addEventListener('click', () => this._addChapter());
        }
    },

    _teardownBookEditor() {
        const editor = document.getElementById('note-content-editor');
        if (editor && this._bookEditorInputHandler) {
            editor.removeEventListener('input', this._bookEditorInputHandler);
        }
        this._bookEditorInputHandler = null;
        if (this._bookEditorScrollHandler) {
            window.removeEventListener('scroll', this._bookEditorScrollHandler);
            this._paneEl()?.removeEventListener('scroll', this._bookEditorScrollHandler);
            this._bookEditorScrollHandler = null;
        }
        if (this._bookTocRenderTimer) {
            clearTimeout(this._bookTocRenderTimer);
            this._bookTocRenderTimer = null;
        }
        // Drop any paged-view artifacts so the editor renders normally
        // on the next open (or when switching templates away from book).
        this._clearPagedView('editor');
        const nav = document.getElementById('note-book-chapter-nav-editor');
        if (nav) nav.style.display = 'none';
    },

    // -----------------------------
    // Prompt template — config panel
    // -----------------------------

    // Wire the editor's prompt config aside to `this.currentPrompt`. All
    // controls live in static markup; cloneNode drops any stale listener
    // from a previous open, mirroring the tag/template-menu wiring.
    _setupPromptEditor() {
        const cfg = this.currentPrompt || (this.currentPrompt = { ...NotePrompts.DEFAULTS });

        const replace = (id) => {
            const el = document.getElementById(id);
            if (!el) return null;
            const fresh = el.cloneNode(true);
            el.parentNode.replaceChild(fresh, el);
            return fresh;
        };

        const target = replace('note-prompt-target');
        if (target) {
            target.value = cfg.target;
            target.addEventListener('change', () => {
                cfg.target = target.value === 'browser' ? 'browser' : 'agent';
                this.markAsUnsaved(); this.autoSave();
            });
        }

        const opts = document.getElementById('note-prompt-offline-opts');
        const runNowIds = ['note-prompt-run-now', 'note-prompt-run-now-viewer'];
        const syncOffline = () => {
            if (opts) opts.hidden = !cfg.offline;
            runNowIds.forEach(rid => { const b = document.getElementById(rid); if (b) b.hidden = !cfg.offline; });
        };

        const offline = replace('note-prompt-offline');
        if (offline) {
            offline.checked = !!cfg.offline;
            offline.addEventListener('change', () => {
                cfg.offline = offline.checked;
                syncOffline();
                this.markAsUnsaved(); this.autoSave();
            });
        }

        const interval = replace('note-prompt-interval');
        if (interval) {
            interval.value = cfg.interval;
            interval.addEventListener('change', () => {
                cfg.interval = interval.value;
                this.markAsUnsaved(); this.autoSave();
            });
        }

        const web = replace('note-prompt-web');
        if (web) {
            web.checked = !!cfg.web;
            web.addEventListener('change', () => {
                cfg.web = web.checked;
                this.markAsUnsaved(); this.autoSave();
            });
        }

        const context = replace('note-prompt-context');
        if (context) {
            context.checked = !!cfg.useContext;
            context.addEventListener('change', () => {
                cfg.useContext = context.checked;
                this.markAsUnsaved(); this.autoSave();
            });
        }

        syncOffline();

        const runAgent = replace('note-prompt-run-agent');
        if (runAgent) runAgent.addEventListener('click', () => this._runCurrentPrompt('agent'));
        const runBrowser = replace('note-prompt-run-browser');
        if (runBrowser) runBrowser.addEventListener('click', () => this._runCurrentPrompt('browser'));
        const runNow = replace('note-prompt-run-now');
        if (runNow) runNow.addEventListener('click', () => this._runCurrentPromptNow());
    },

    _teardownPromptEditor() {
        // Listeners are dropped via cloneNode on the next setup; there are no
        // global handlers or timers to clean up here.
    },

    // Run the currently-open prompt note. Save first so the latest body and
    // config are what actually run.
    _runCurrentPrompt(target) {
        this.saveCurrentNote(true);
        const note = this.notes.find(n => n.id === this.currentNoteId);
        if (!note || !NotePrompts.bodyText(note)) { UIUtils.showToast('Prompt is empty', 'error'); return; }
        if (target === 'browser') NotePrompts.runInBrowser(note);
        else NotePrompts.runInAgent(note);
    },

    _runCurrentPromptNow() {
        this.saveCurrentNote(true);
        if (this.currentNoteId && typeof PromptFeed !== 'undefined') PromptFeed.runNow(this.currentNoteId);
    },

    _renderEditorToc() {
        const editor = document.getElementById('note-content-editor');
        const list = document.getElementById('note-book-toc-list-editor');
        if (!editor || !list) return;
        const chapters = NoteTemplates.extractChaptersFromElement(editor);
        this._paintTocList(list, chapters, 'editor');
        this._updateActiveTocItem('editor');
    },

    _paintTocList(listEl, chapters, scope) {
        if (chapters.length === 0) {
            listEl.innerHTML = `<p class="note-book-toc-empty">No chapters yet. ${scope === 'editor' ? 'Use <em>+ Add Chapter</em> or type <code>#</code> at the start of a line.' : ''}</p>`;
            return;
        }
        listEl.innerHTML = chapters.map(c => `
            <button type="button" class="note-book-toc-item" data-chapter-index="${c.index}" title="${UIUtils.escapeHtml(c.title)}">
                <span class="note-book-toc-num">${c.index + 1}</span>
                <span class="note-book-toc-title">${UIUtils.escapeHtml(c.title)}</span>
            </button>
        `).join('');
        listEl.querySelectorAll('.note-book-toc-item').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.chapterIndex, 10);
                this._setActiveChapter(scope, idx);
            });
        });
    },

    /**
     * Single entry point for "go to chapter N" — in scroll mode this is a
     * smooth scroll to the chapter heading; in paged mode it swaps which
     * chapter is visible.
     */
    _setActiveChapter(scope, index) {
        if (this.currentBookLayout === 'paged') {
            this._applyPagedView(scope, index);
            // Snap to top so the new "page" starts at the top of the view.
            this._scrollPaneTop();
            if (scope === 'editor') {
                const root = document.getElementById('note-content-editor');
                const h1 = root && root.querySelectorAll('h1')[index];
                if (h1) {
                    const range = document.createRange();
                    range.selectNodeContents(h1);
                    range.collapse(true);
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                    root.focus({ preventScroll: true });
                }
            }
        } else {
            this._scrollToChapter(index, scope);
        }
    },

    _scrollToChapter(index, scope) {
        const rootId = scope === 'viewer' ? 'viewer-note-content' : 'note-content-editor';
        const root = document.getElementById(rootId);
        if (!root) return;
        const h1 = root.querySelectorAll('h1')[index];
        if (!h1) return;
        // The pane owns the scroll on wide windows; scrollIntoView finds
        // the right container either way (scroll-margin-top adds headroom).
        h1.scrollIntoView({ block: 'start', behavior: 'smooth' });
        if (scope === 'editor') {
            // Place the caret at the start of the chapter title so the
            // user can immediately rename or start typing.
            const range = document.createRange();
            range.selectNodeContents(h1);
            range.collapse(true);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            root.focus({ preventScroll: true });
        }
    },

    // -----------------------------
    // Paged layout — show one chapter at a time.
    //
    // Chapters are derived from H1 boundaries in the same flat HTML the
    // scroll layout uses; the only DOM mutation is a transient
    // .book-chapter-hidden class on each direct child whose chapter
    // isn't currently active. This means the underlying note.content
    // never changes shape based on layout, and switching modes is
    // instant + non-destructive.
    // -----------------------------

    /**
     * Tag each direct child of `root` with the index of the chapter it
     * belongs to. Uses `querySelectorAll('h1')` so chapters stay aligned
     * with the TOC even when H1s are nested inside wrapper elements
     * (e.g. pasted content where each chapter sits inside its own div).
     *
     * Algorithm: walk direct children left-to-right. A child either
     *   - IS the next H1 in document order, or contains it → start of a
     *     new chapter; tag = that H1's index.
     *   - Otherwise → continuation of the previous chapter.
     * When a single wrapper contains multiple H1s we accept the start
     * (subsequent nested chapters live in the same wrapper). Rare in
     * practice; fixable later by flattening on save.
     */
    _tagChaptersInRoot(root) {
        if (!root) return 0;
        const allH1s = Array.from(root.querySelectorAll('h1'));
        const total = allH1s.length;
        const children = Array.from(root.children);

        if (total === 0) {
            children.forEach(c => { c.dataset.chapterIndex = '0'; });
            return 0;
        }

        let currentChapter = 0;
        let nextH1Idx = 0;
        children.forEach(child => {
            if (nextH1Idx < total) {
                const h1 = allH1s[nextH1Idx];
                if (h1 === child || child.contains(h1)) {
                    currentChapter = nextH1Idx;
                    nextH1Idx++;
                    // Absorb any further H1s also nested inside this same
                    // wrapper — they share a tag with the chapter that
                    // started here.
                    while (nextH1Idx < total && child.contains(allH1s[nextH1Idx])) {
                        nextH1Idx++;
                    }
                }
            }
            child.dataset.chapterIndex = String(currentChapter);
        });
        return total;
    },

    /**
     * Show only the chapter at `activeIdx` inside the editor or viewer
     * content root. Other chapters get .book-chapter-hidden (CSS hides
     * them). Also updates the TOC active item and the pager.
     */
    _applyPagedView(scope, activeIdx) {
        const rootId = scope === 'viewer' ? 'viewer-note-content' : 'note-content-editor';
        const root = document.getElementById(rootId);
        if (!root) return;
        const total = this._tagChaptersInRoot(root);
        // When the note has no H1 yet, just show everything — paged mode
        // is a no-op until the user adds a chapter.
        const safeTotal = Math.max(total, 1);
        const idx = Math.max(0, Math.min(safeTotal - 1, activeIdx || 0));
        this.currentBookChapterIndex = idx;
        Array.from(root.children).forEach(child => {
            const ci = parseInt(child.dataset.chapterIndex || '0', 10);
            child.classList.toggle('book-chapter-hidden', total > 0 && ci !== idx);
        });
        this._setTocActiveIndex(scope, idx);
        this._updateChapterPager(scope, idx, safeTotal);
    },

    /**
     * Strip transient paged-view bookkeeping (`data-chapter-index`,
     * `book-chapter-hidden`, the empty `class=""` left behind when the
     * class is removed) from HTML before persisting. Keeps note.content
     * stable across view mode changes and free of UI-only attributes.
     */
    _sanitizeBookViewArtifacts(html) {
        if (!html) return html;
        const wrap = document.createElement('div');
        wrap.innerHTML = html;
        wrap.querySelectorAll('[data-chapter-index]').forEach(el => {
            el.removeAttribute('data-chapter-index');
        });
        wrap.querySelectorAll('.book-chapter-hidden').forEach(el => {
            el.classList.remove('book-chapter-hidden');
        });
        // Drop empty class= attributes left over from the removal above.
        wrap.querySelectorAll('[class=""]').forEach(el => {
            el.removeAttribute('class');
        });
        return wrap.innerHTML;
    },

    /** Remove all paged-view artifacts from a content root. */
    _clearPagedView(scope) {
        const rootId = scope === 'viewer' ? 'viewer-note-content' : 'note-content-editor';
        const root = document.getElementById(rootId);
        if (!root) return;
        Array.from(root.children).forEach(child => {
            child.classList.remove('book-chapter-hidden');
        });
    },

    /**
     * Map the current selection inside `root` to the chapter index the
     * caret is inside. Returns -1 when there is no selection in root.
     */
    _chapterIndexForCursor(root) {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return -1;
        const range = sel.getRangeAt(0);
        if (!root.contains(range.startContainer)) return -1;
        let node = range.startContainer;
        while (node && node.parentNode !== root) node = node.parentNode;
        if (!node || !node.dataset) return -1;
        const v = parseInt(node.dataset.chapterIndex || '', 10);
        return Number.isFinite(v) ? v : -1;
    },

    /**
     * Map a text offset (over the concatenated text of the full content)
     * to the chapter index that offset falls in. Used by dbl-click-to-edit
     * so the editor opens with the same chapter visible.
     */
    _chapterIndexForTextOffset(root, offset) {
        if (!root) return 0;
        const total = this._tagChaptersInRoot(root);
        if (total === 0) return 0;
        let acc = 0;
        let lastIdx = 0;
        for (const child of Array.from(root.children)) {
            const len = (child.textContent || '').length;
            const ci = parseInt(child.dataset.chapterIndex || '0', 10);
            if (offset <= acc + len) return ci;
            acc += len;
            lastIdx = ci;
        }
        return lastIdx;
    },

    _setTocActiveIndex(scope, idx) {
        const listId = scope === 'viewer' ? 'note-book-toc-list-viewer' : 'note-book-toc-list-editor';
        const list = document.getElementById(listId);
        if (!list) return;
        list.querySelectorAll('.note-book-toc-item').forEach((el, i) => {
            el.classList.toggle('active', i === idx);
        });
    },

    /**
     * Wire prev/next buttons in either pager. Both scopes share the same
     * step logic; in paged mode it swaps the visible chapter, in scroll
     * mode it smooth-scrolls.
     */
    _wireChapterPager(scope) {
        const ids = scope === 'viewer'
            ? { prev: 'note-book-prev-chapter', next: 'note-book-next-chapter' }
            : { prev: 'note-book-prev-chapter-editor', next: 'note-book-next-chapter-editor' };
        const prev = document.getElementById(ids.prev);
        const next = document.getElementById(ids.next);
        if (prev) {
            const fresh = prev.cloneNode(true);
            prev.parentNode.replaceChild(fresh, prev);
            fresh.addEventListener('click', () => this._stepChapter(scope, -1));
        }
        if (next) {
            const fresh = next.cloneNode(true);
            next.parentNode.replaceChild(fresh, next);
            fresh.addEventListener('click', () => this._stepChapter(scope, 1));
        }
    },

    /**
     * Highlight the currently-visible chapter in the TOC. Heuristic: the
     * active chapter is the last H1 whose top is at or above a small
     * threshold below the titlebar — i.e. the one most recently scrolled
     * past or currently being read.
     */
    _updateActiveTocItem(scope) {
        const rootId = scope === 'viewer' ? 'viewer-note-content' : 'note-content-editor';
        const listId = scope === 'viewer' ? 'note-book-toc-list-viewer' : 'note-book-toc-list-editor';
        const root = document.getElementById(rootId);
        const list = document.getElementById(listId);
        if (!root || !list) return;
        const headings = Array.from(root.querySelectorAll('h1'));
        if (headings.length === 0) return;

        // "Currently read" = the last H1 at or above a line just below the
        // pane's top edge (viewport coords work for the page-scroll
        // fallback too, where the pane top goes negative as you scroll).
        const paneTop = this._paneEl()?.getBoundingClientRect().top ?? 0;
        const threshold = Math.max(120, paneTop + 60);
        let activeIdx = 0;
        for (let i = 0; i < headings.length; i++) {
            const top = headings[i].getBoundingClientRect().top;
            if (top - threshold <= 0) activeIdx = i;
            else break;
        }
        list.querySelectorAll('.note-book-toc-item').forEach((el, i) => {
            el.classList.toggle('active', i === activeIdx);
        });
        this._updateChapterPager(scope, activeIdx, headings.length);
    },

    /**
     * Insert a new chapter at the end of the editor and drop the caret
     * inside its blank paragraph so the user can start typing immediately.
     */
    _addChapter() {
        const editor = document.getElementById('note-content-editor');
        if (!editor) return;
        const n = editor.querySelectorAll('h1').length + 1;

        const h1 = document.createElement('h1');
        h1.textContent = `Chapter ${n}`;
        const p = document.createElement('p');
        p.innerHTML = '<br>';
        editor.appendChild(h1);
        editor.appendChild(p);

        // Move the caret into the new paragraph; smooth-scroll so the
        // user actually sees what was just added even on a long doc.
        const range = document.createRange();
        range.selectNodeContents(p);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        editor.focus({ preventScroll: true });
        h1.scrollIntoView({ behavior: 'smooth', block: 'start' });

        this._renderEditorToc();
        // In paged mode, swap visible chapter to the just-added one so the
        // user can immediately start typing into it instead of seeing the
        // previous chapter (which still holds the cursor visually).
        if (this.currentBookLayout === 'paged') {
            this._applyPagedView('editor', n - 1);
        }
        this.markAsUnsaved();
        this.autoSave();
    },

    /**
     * Update prev/next + position indicator for the editor or viewer pager.
     * Hidden when the note has <2 chapters or isn't using the book template.
     */
    _updateChapterPager(scope, activeIdx, total) {
        const ids = scope === 'viewer'
            ? { nav: 'note-book-chapter-nav', prev: 'note-book-prev-chapter', next: 'note-book-next-chapter',
                prevTitle: 'note-book-prev-chapter-title', nextTitle: 'note-book-next-chapter-title',
                position: 'note-book-chapter-position-viewer', rootId: 'viewer-note-content' }
            : { nav: 'note-book-chapter-nav-editor', prev: 'note-book-prev-chapter-editor', next: 'note-book-next-chapter-editor',
                prevTitle: 'note-book-prev-chapter-title-editor', nextTitle: 'note-book-next-chapter-title-editor',
                position: 'note-book-chapter-position-editor', rootId: 'note-content-editor' };
        const nav = document.getElementById(ids.nav);
        if (!nav) return;
        const root = document.getElementById(ids.rootId);
        const headings = root ? Array.from(root.querySelectorAll('h1')) : [];
        // In the editor, only show the pager in book mode with >1 chapter.
        const show = headings.length > 1;
        nav.style.display = show ? 'flex' : 'none';
        if (!show) return;

        const prev = document.getElementById(ids.prev);
        const next = document.getElementById(ids.next);
        const prevTitle = document.getElementById(ids.prevTitle);
        const nextTitle = document.getElementById(ids.nextTitle);
        const position = document.getElementById(ids.position);
        if (prev) {
            const has = activeIdx > 0;
            prev.disabled = !has;
            prev.style.visibility = has ? 'visible' : 'hidden';
            if (has && prevTitle) prevTitle.textContent = (headings[activeIdx - 1]?.textContent || '').trim();
        }
        if (next) {
            const has = activeIdx < total - 1;
            next.disabled = !has;
            next.style.visibility = has ? 'visible' : 'hidden';
            if (has && nextTitle) nextTitle.textContent = (headings[activeIdx + 1]?.textContent || '').trim();
        }
        // Position indicator ("3 / 12") — shown in paged mode only; scroll
        // mode would just look noisy under fluid scrolling.
        if (position) {
            if (this.currentBookLayout === 'paged') {
                position.textContent = `${activeIdx + 1} / ${total}`;
                position.style.display = '';
            } else {
                position.style.display = 'none';
            }
        }
    },

    _stepChapter(scope, delta) {
        // Backwards-compat: if called with a single argument (legacy paths),
        // assume viewer scope.
        if (typeof scope === 'number') { delta = scope; scope = 'viewer'; }
        const rootId = scope === 'viewer' ? 'viewer-note-content' : 'note-content-editor';
        const root = document.getElementById(rootId);
        if (!root) return;
        const headings = Array.from(root.querySelectorAll('h1'));
        if (headings.length === 0) return;
        let activeIdx;
        if (this.currentBookLayout === 'paged') {
            activeIdx = this.currentBookChapterIndex || 0;
        } else {
            // Recompute active index right now so two quick clicks both land.
            const threshold = 120;
            activeIdx = 0;
            for (let i = 0; i < headings.length; i++) {
                const top = headings[i].getBoundingClientRect().top;
                if (top - threshold <= 0) activeIdx = i;
                else break;
            }
        }
        const target = Math.max(0, Math.min(headings.length - 1, activeIdx + delta));
        this._setActiveChapter(scope, target);
    },

    // -----------------------------
    // Resizable TOC sidebar — mirrors Tasks left-nav resizer.
    // Editor + viewer share one width preference (consistent feel
    // across views; one drag updates both).
    // -----------------------------

    _loadTocWidth() {
        let width = this.TOC_WIDTH_DEFAULT;
        try {
            const raw = parseInt(localStorage.getItem(this.TOC_WIDTH_KEY), 10);
            if (Number.isFinite(raw)) width = raw;
        } catch (_) { /* ignore */ }
        return width;
    },

    /**
     * Clamp width to [MIN, MAX] and push it onto the frame's inline
     * style as a CSS custom property.
     */
    _applyTocWidth(width) {
        const w = Math.round(Math.min(this.TOC_WIDTH_MAX, Math.max(this.TOC_WIDTH_MIN, width)));
        const frame = document.getElementById('note-editor-frame');
        if (frame) frame.style.setProperty('--note-book-toc-width', w + 'px');
        return w;
    },

    _saveTocWidth(width) {
        try { localStorage.setItem(this.TOC_WIDTH_KEY, String(width)); } catch (_) { /* ignore */ }
    },

    /**
     * Wire the drag handle for the given scope (editor or viewer).
     * Drag updates width live; mouse-up persists; double-click resets.
     *
     * Direction is inverted versus the Tasks left nav: the TOC sits on
     * the right, so dragging the handle RIGHT shrinks the TOC (writing
     * column gets wider), and dragging LEFT grows it.
     */
    _setupTocResizer(resizerId, frameId) {
        const resizer = document.getElementById(resizerId);
        if (!resizer) return;
        const fresh = resizer.cloneNode(true);
        resizer.parentNode.replaceChild(fresh, resizer);

        const currentWidth = () => {
            const frame = document.getElementById(frameId);
            const w = parseInt(frame?.style.getPropertyValue('--note-book-toc-width'), 10);
            return Number.isFinite(w) ? w : this.TOC_WIDTH_DEFAULT;
        };

        let startX = 0;
        let startWidth = 0;

        const onMove = (e) => {
            // TOC is on the right edge: rightward drag shrinks, leftward grows.
            this._applyTocWidth(startWidth - (e.clientX - startX));
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            fresh.classList.remove('dragging');
            document.body.classList.remove('note-book-toc-resizing');
            this._saveTocWidth(currentWidth());
        };

        fresh.addEventListener('mousedown', (e) => {
            e.preventDefault();
            startX = e.clientX;
            startWidth = currentWidth();
            fresh.classList.add('dragging');
            document.body.classList.add('note-book-toc-resizing');
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        fresh.addEventListener('dblclick', () => {
            this._saveTocWidth(this._applyTocWidth(this.TOC_WIDTH_DEFAULT));
        });
    },

    // ============================================================
    // Wiki links — [[ autocomplete in the editor, stored as
    // <a href="#note:<id>"> anchors (the sanitizer keeps #-hrefs).
    // ============================================================

    _wikiCtx: null,

    _setupWikiLinks() {
        if (this._wikiWired) return;
        this._wikiWired = true;

        // Input on the editor element (it is never replaced, only re-inited
        // by RichEditor) drives the menu open/close/update cycle.
        const editor = document.getElementById('note-content-editor');
        if (editor) {
            editor.addEventListener('input', () => this._updateWikiMenu());
        }

        // Capture-phase document keydown outruns RichEditor's handlers
        // while the menu is open.
        document.addEventListener('keydown', (e) => {
            const menu = document.getElementById('note-wiki-menu');
            if (!menu) return;
            if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'ArrowDown') this._moveWikiCursor(1);
            else if (e.key === 'ArrowUp') this._moveWikiCursor(-1);
            else if (e.key === 'Escape') this._closeWikiMenu();
            else this._pickWikiItem(menu.querySelector('.note-wiki-item.is-active') || menu.querySelector('.note-wiki-item'));
        }, true);

        document.addEventListener('click', (e) => {
            if (!e.target.closest('#note-wiki-menu') && !e.target.closest('#note-content-editor')) {
                this._closeWikiMenu();
            }
        });
    },

    /** The "[[query" fragment immediately before the caret, if any. */
    _wikiContext() {
        const editor = document.getElementById('note-content-editor');
        if (!editor) return null;
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
        const node = sel.anchorNode;
        if (!node || node.nodeType !== 3 || !editor.contains(node)) return null;
        if (node.parentElement && node.parentElement.closest('a')) return null;
        const upto = node.textContent.slice(0, sel.anchorOffset);
        const m = upto.match(/\[\[([^\[\]\n]{0,60})$/);
        if (!m) return null;
        return { node, endOffset: sel.anchorOffset, query: m[1], length: m[0].length };
    },

    _updateWikiMenu() {
        const ctx = this._wikiContext();
        if (!ctx) { this._closeWikiMenu(); return; }
        this._wikiCtx = ctx;

        const q = ctx.query.trim().toLowerCase();
        const candidates = ProfileManager.filterByActiveProfile(this.notes)
            .filter(n => n.id !== this.currentNoteId && NoteTemplates.resolve(n) !== 'feed')
            .map(n => ({ n, t: (n.title || '').toLowerCase() }))
            .filter(x => !q || x.t.includes(q))
            .sort((a, b) => {
                const as = q && a.t.startsWith(q) ? 0 : 1;
                const bs = q && b.t.startsWith(q) ? 0 : 1;
                if (as !== bs) return as - bs;
                return new Date(b.n.modifiedAt) - new Date(a.n.modifiedAt);
            })
            .slice(0, 8);

        const createRow = ctx.query.trim()
            ? `<button type="button" class="note-wiki-item note-wiki-create" data-create="1">
                   <span class="note-wiki-title">+ Create &ldquo;${UIUtils.escapeHtml(ctx.query.trim())}&rdquo;</span>
               </button>`
            : '';
        if (!candidates.length && !createRow) { this._closeWikiMenu(); return; }

        let menu = document.getElementById('note-wiki-menu');
        if (!menu) {
            menu = document.createElement('div');
            menu.id = 'note-wiki-menu';
            menu.className = 'note-wiki-menu';
            menu.setAttribute('role', 'listbox');
            document.body.appendChild(menu);
        }
        menu.innerHTML = candidates.map((x, i) => `
            <button type="button" class="note-wiki-item ${i === 0 ? 'is-active' : ''}" data-note-id="${x.n.id}">
                <span class="note-wiki-title">${UIUtils.escapeHtml(x.n.title || 'Untitled')}</span>
                <span class="note-wiki-date">${UIUtils.formatDate(x.n.modifiedAt)}</span>
            </button>
        `).join('') + createRow;
        if (!menu.querySelector('.is-active')) menu.querySelector('.note-wiki-item')?.classList.add('is-active');

        // Anchor at the caret; a collapsed range can report a zero rect, so
        // fall back to the caret's parent element.
        const sel = window.getSelection();
        let rect = sel.getRangeAt(0).getBoundingClientRect();
        if (!rect || (!rect.width && !rect.height && !rect.top)) {
            rect = ctx.node.parentElement?.getBoundingClientRect() || { bottom: 100, left: 100 };
        }
        menu.style.top = (rect.bottom + window.scrollY + 4) + 'px';
        menu.style.left = Math.max(8, Math.min(rect.left + window.scrollX, window.innerWidth - 330)) + 'px';

        menu.querySelectorAll('.note-wiki-item').forEach(item => {
            // mousedown — fire before the editor loses the selection.
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                this._pickWikiItem(item);
            });
        });
    },

    _moveWikiCursor(delta) {
        const menu = document.getElementById('note-wiki-menu');
        if (!menu) return;
        const items = Array.from(menu.querySelectorAll('.note-wiki-item'));
        if (!items.length) return;
        const cur = items.findIndex(i => i.classList.contains('is-active'));
        const next = Math.max(0, Math.min(items.length - 1, cur + delta));
        items.forEach(i => i.classList.remove('is-active'));
        items[next].classList.add('is-active');
        items[next].scrollIntoView({ block: 'nearest' });
    },

    _pickWikiItem(item) {
        if (!item) return;
        if (item.dataset.create) {
            const title = (this._wikiCtx?.query || '').trim() || 'Untitled';
            const id = this.createNote(title, ' ');
            this._insertWikiLink(id, title);
        } else {
            const n = this.notes.find(nn => nn.id === item.dataset.noteId);
            this._insertWikiLink(item.dataset.noteId, n?.title || 'Untitled');
        }
    },

    _insertWikiLink(noteId, title) {
        const ctx = this._wikiCtx;
        this._closeWikiMenu();
        if (!ctx || !noteId) return;
        const editor = document.getElementById('note-content-editor');
        if (!editor || !editor.contains(ctx.node)) return;

        const range = document.createRange();
        range.setStart(ctx.node, Math.max(0, ctx.endOffset - ctx.length));
        range.setEnd(ctx.node, Math.min(ctx.endOffset, ctx.node.length));
        range.deleteContents();

        const a = document.createElement('a');
        a.setAttribute('href', '#note:' + noteId);
        a.textContent = title;
        range.insertNode(a);
        const space = document.createTextNode(' ');
        a.parentNode.insertBefore(space, a.nextSibling);

        const sel = window.getSelection();
        const after = document.createRange();
        after.setStart(space, 1);
        after.collapse(true);
        sel.removeAllRanges();
        sel.addRange(after);
        editor.focus({ preventScroll: true });

        this.markAsUnsaved();
        this.autoSave();
    },

    _closeWikiMenu() {
        document.getElementById('note-wiki-menu')?.remove();
        this._wikiCtx = null;
    },

    // ============================================================
    // Related notes — shared tags, nothing else. Tags are explicit,
    // user-curated topic markers, so the section is transparent and
    // predictable: a note appears here iff it shares at least one tag,
    // ranked by how many it shares, then by recency. Each row carries
    // the matching tags so the "why" is visible.
    // ============================================================

    _relatedNotes(note, limit = 5) {
        const myTags = new Set(note.tags || []);
        if (!myTags.size) return [];

        return ProfileManager.filterByActiveProfile(this.notes)
            .filter(n => n.id !== note.id && NoteTemplates.resolve(n) !== 'feed')
            .map(n => {
                const shared = (n.tags || []).filter(t => myTags.has(t));
                return { n, shared };
            })
            .filter(x => x.shared.length > 0)
            .sort((a, b) => {
                if (b.shared.length !== a.shared.length) return b.shared.length - a.shared.length;
                return new Date(b.n.modifiedAt) - new Date(a.n.modifiedAt);
            })
            .slice(0, limit)
            .map(x => ({ ...x.n, _sharedTags: x.shared }));
    },

    /**
     * Create or edit tag
     */
    showTagForm(tag = null) {
        const isEdit = !!tag;
        const title = isEdit ? 'Edit Tag' : 'New Tag';

        const modal = Modal.create({
            title,
            content: `
                <form class="theme-form" id="tag-form">
                    <div class="form-group">
                        <label class="form-label">Tag Name</label>
                        <input 
                            type="text" 
                            id="tag-name-input" 
                            placeholder="e.g., work, personal, ideas"
                            value="${tag ? UIUtils.escapeHtml(tag.name) : ''}"
                            required
                        >
                    </div>
                </form>
            `,
            buttons: [
                {
                    text: 'Cancel',
                    className: 'secondary-btn',
                    onClick: () => modal.close()
                },
                {
                    text: isEdit ? 'Save' : 'Create',
                    className: 'primary-btn',
                    onClick: () => {
                        const form = document.getElementById('tag-form');
                        if (form.checkValidity()) {
                            this.handleTagSubmit(tag?.id, modal);
                        } else {
                            form.reportValidity();
                        }
                    }
                }
            ]
        });
    },

    /**
     * Handle tag form submission
     */
    handleTagSubmit(tagId, modal) {
        const name = document.getElementById('tag-name-input').value.trim().toLowerCase();

        if (!name) {
            UIUtils.showToast('Please enter a tag name', 'error');
            return;
        }

        const duplicate = this.activeProfileTags().find(t => t.name === name && t.id !== tagId);
        if (duplicate) {
            UIUtils.showToast(`A tag named "${name}" already exists`, 'error');
            return;
        }

        if (tagId) {
            // Update existing tag
            const tag = this.tags.find(t => t.id === tagId);
            if (tag) {
                tag.name = name;
            }
        } else {
            // Create new tag in the active profile's library
            const newTag = {
                id: UIUtils.generateId(),
                name,
                profile: ProfileManager.getProfileForNewItem(),
                createdAt: new Date().toISOString()
            };
            this.tags.push(newTag);
        }

        this.saveTags();
        modal.close();
        this.render();

        // Re-render editor tag pills (a renamed tag may need updating).
        if (this._paneSessionActive) {
            this._renderEditorTagPills(this._getSelectedEditorTagPills());
        }

        UIUtils.showToast(tagId ? 'Tag updated' : 'Tag created', 'success');
    },

    async deleteTag(tagId) {
        const tag = this.tags.find(t => t.id === tagId);
        if (!tag) return;

        // Tags are per-profile, so only strip this name from notes in the
        // same profile — a same-named tag in another profile is separate.
        const profileNotes = ProfileManager.filterByActiveProfile(this.notes);
        const usageCount = profileNotes.reduce(
            (n, note) => n + (note.tags && note.tags.includes(tag.name) ? 1 : 0),
            0
        );
        const detail = usageCount > 0
            ? `This will remove "${tag.name}" from ${usageCount} note${usageCount === 1 ? '' : 's'}.`
            : `"${tag.name}" is not in use.`;
        const confirmed = await UIUtils.confirm('Delete Tag', `${detail} The notes themselves will not be deleted.`);
        if (!confirmed) return;

        this.tags = this.tags.filter(t => t.id !== tagId);

        if (usageCount > 0) {
            profileNotes.forEach(note => {
                if (note.tags && note.tags.includes(tag.name)) {
                    note.tags = note.tags.filter(t => t !== tag.name);
                    note.modifiedAt = new Date().toISOString();
                }
            });
            this.saveNotes();
        }

        if (this.currentFilter === tag.name) {
            this.currentFilter = 'all';
        }

        this.saveTags();
        this.render();

        if (this._paneSessionActive) {
            // The deleted tag may have been attached — drop it from selected pills.
            const remaining = this._getSelectedEditorTagPills().filter(t => t !== tag.name);
            this._renderEditorTagPills(remaining);
        }

        UIUtils.showToast('Tag deleted', 'success');
    },

    /**
     * Get filtered and sorted notes
     */
    getFilteredNotes() {
        let filtered = ProfileManager.filterByActiveProfile([...this.notes]);

        // Apply filter
        if (this.currentFilter === 'pinned') {
            filtered = filtered.filter(note => note.pinned);
        } else if (this.currentFilter === 'on-home') {
            filtered = filtered.filter(note => note.showOnHome);
        } else if (this.currentFilter === 'prompt') {
            filtered = filtered.filter(note => NotePrompts.isPrompt(note));
        } else if (this.currentFilter === 'assistant') {
            filtered = filtered.filter(note => NoteTemplates.resolve(note) === 'assistant');
        } else if (this.currentFilter === 'feed') {
            filtered = filtered.filter(note => NoteTemplates.resolve(note) === 'feed');
        } else if (this.currentFilter === 'untagged') {
            filtered = filtered.filter(note => !note.tags || note.tags.length === 0);
        } else if (this.currentFilter !== 'all') {
            filtered = filtered.filter(note => note.tags && note.tags.includes(this.currentFilter));
        }

        // Feed posts are machine-generated on a schedule (up to 20 kept per
        // prompt) — in the general buckets they'd bury real notes, so only
        // their own filter and explicit user flags (pinned / on-home) show
        // them.
        if (!['feed', 'pinned', 'on-home'].includes(this.currentFilter)) {
            filtered = filtered.filter(note => NoteTemplates.resolve(note) !== 'feed');
        }

        // Apply search filter
        if (this.searchQuery) {
            filtered = filtered.filter(note =>
                note.title.toLowerCase().includes(this.searchQuery) ||
                note.content.toLowerCase().includes(this.searchQuery)
            );
        }

        // Sort notes
        filtered.sort((a, b) => {
            // Pinned notes always on top
            if (a.pinned && !b.pinned) return -1;
            if (!a.pinned && b.pinned) return 1;

            // Then sort by selected criteria
            switch (this.sortBy) {
                case 'created':
                    return new Date(b.createdAt) - new Date(a.createdAt);
                case 'title':
                    return a.title.localeCompare(b.title);
                case 'modified':
                default:
                    return new Date(b.modifiedAt) - new Date(a.modifiedAt);
            }
        });

        return filtered;
    },

    /**
     * Render notes
     */
    render() {
        Breadcrumb.render('notes-breadcrumb', this._buildNoteCrumbs(this.currentNoteId, this._editorOrigin));
        // Surface a dedicated "New Prompt" button while browsing prompts so
        // creating another prompt is one click, not a trip through the
        // template caret menu.
        const addPromptBtn = document.getElementById('add-prompt-btn');
        if (addPromptBtn) addPromptBtn.hidden = this.currentFilter !== 'prompt';
        NotesUI.render(this.getFilteredNotes(), this.activeProfileTags(), this.currentFilter);
    },

    _buildNoteCrumbs(noteId, origin = null) {
        // Note title is intentionally omitted from the breadcrumb — the
        // title is already the most prominent thing on the page itself.
        const crumbs = [];

        // Breadcrumb reflects how the user got here, not what the note
        // is linked to. If they opened a note from the Notes list (no
        // cross-app origin), keep the breadcrumb anchored at "Notes"
        // even when the note is linked to a goal or focus area. Only
        // show the hierarchical path when the user actually drilled in
        // from another app.
        const fromOtherApp = origin && origin.app && origin.app !== 'notes';
        const hasAutoLink = !noteId && Array.isArray(this.autoLinkContext) && this.autoLinkContext.length > 0;
        if (!fromOtherApp && !hasAutoLink) {
            crumbs.push({ label: 'Notes', action: () => {
                if (this._paneSessionActive) this.closeEditor();
            }});
            return crumbs;
        }

        // Existing notes read links from storage; brand-new notes (noteId
        // null) derive crumbs from autoLinkContext, since the real links
        // don't exist until save.
        let focusArea = null;
        let goalCrumb = null;
        if (noteId) {
            focusArea = LinkManager.getFocusForItem('notes', noteId);
            const goalLinks = LinkManager.getLinksForApp('notes', noteId, 'goals');
            if (goalLinks.length > 0) {
                const goalMeta = LinkManager.getItemMeta('goals', goalLinks[0].itemId);
                if (goalMeta) goalCrumb = { itemId: goalLinks[0].itemId, title: goalMeta.title };
            }
        } else if (Array.isArray(this.autoLinkContext)) {
            for (const ctx of this.autoLinkContext) {
                if (ctx.app === 'focus' && !focusArea) {
                    const meta = LinkManager.getItemMeta('focus', ctx.itemId);
                    if (meta) focusArea = { itemId: ctx.itemId, title: meta.title, color: meta.color };
                } else if (ctx.app === 'goals' && !goalCrumb) {
                    const meta = LinkManager.getItemMeta('goals', ctx.itemId);
                    if (meta) goalCrumb = { itemId: ctx.itemId, title: meta.title };
                }
            }
            if (goalCrumb && !focusArea) {
                const fa = LinkManager.getFocusForItem('goals', goalCrumb.itemId);
                if (fa) focusArea = fa;
            }
        }

        if (focusArea) {
            crumbs.push({ label: 'Focus', action: () => AppManager.openApp('focus') });
            crumbs.push({ label: focusArea.title, action: () => { AppManager.openApp('focus'); setTimeout(() => FocusApp.navigateTo(focusArea.itemId), 0); } });
            if (goalCrumb) {
                crumbs.push({ label: goalCrumb.title, action: () => { AppManager.openApp('goals'); setTimeout(() => GoalsApp.openViewer(goalCrumb.itemId), 0); } });
            }
        } else if (goalCrumb) {
            crumbs.push({ label: 'Plan', action: () => AppManager.openApp('focus') });
            crumbs.push({ label: goalCrumb.title, action: () => { AppManager.openApp('goals'); setTimeout(() => GoalsApp.openViewer(goalCrumb.itemId), 0); } });
        } else {
            crumbs.push({ label: 'Notes', action: () => {
                if (this._paneSessionActive) this.closeEditor();
            }});
        }
        return crumbs;
    },

    // The page-level breadcrumb carries the trail now (there is no separate
    // editor view). When a note was opened from another app the origin path
    // (Focus / area / goal) renders here so the user can step back.
    renderEditorBreadcrumb(noteId) {
        Breadcrumb.render('notes-breadcrumb', this._buildNoteCrumbs(noteId, this._editorOrigin));
    }
};

// Register app
AppManager.register('notes', NotesApp);

// AgentContext provider — exposes the currently-open note (if any) so the
// assistant can answer questions like "make this clearer" or "summarize
// this note" without the user having to paste anything. When no note is
// open (the list view, or right after closing the editor) returns null
// so the agent falls back to its briefing instead of injecting empty
// context.
if (typeof AgentContext !== 'undefined') {
    AgentContext.register('notes', () => {
        const id = NotesApp.currentNoteId;
        if (!id) return null;
        const note = (NotesApp.notes || []).find(n => n && n.id === id);
        if (!note) return null;

        // Strip HTML tags from rich-editor content for the LLM. The full
        // styling isn't useful in a system prompt and inflates token
        // count — plain text reads better and matches how the agent's
        // own get_note tool returns content (AgentTools._noteText).
        const plain = String(note.content || '')
            .replace(/<\/?(p|div|br|h[1-6]|li)[^>]*>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        const tags = (note.tags || []).join(', ');
        const template = (typeof NoteTemplates !== 'undefined') ? NoteTemplates.resolve(note) : 'blank';
        const chapters = template === 'book' && typeof NoteTemplates !== 'undefined'
            ? NoteTemplates.extractChapters(note.content)
            : [];
        const templateLine = template === 'book' && chapters.length
            ? `Template: Book (${chapters.length} chapter${chapters.length === 1 ? '' : 's'}: ${chapters.map((c, i) => `${i + 1}. ${c.title}`).join(' · ')})`
            : `Template: ${template === 'book' ? 'Book' : 'Blank'}`;
        return {
            recordKey: 'notes:' + note.id,
            recordLabel: note.title || '(untitled note)',
            title: 'CURRENT NOTE',
            body: `The user is currently viewing or editing the note below in the Notes sub-app. The note is available as context, not a hard constraint:

- When their question or instruction refers to "this note", "the note", "what I wrote", etc., or is clearly about its content, work with the text below. To save edits, call the update_note tool with id: ${note.id}.
- When their question is general or unrelated to the note, answer normally from your own knowledge. Do not pivot back to the note's content after a brief mention.

Title: ${note.title || '(untitled)'}
Tags: ${tags || 'none'}
${templateLine}
Modified: ${note.modifiedAt || 'unknown'}

Content:
${plain || '(empty)'}`,
            suggestedPrompts: [
                'Make this clearer',
                'Summarize this note',
                'Suggest improvements'
            ]
        };
    });
}
