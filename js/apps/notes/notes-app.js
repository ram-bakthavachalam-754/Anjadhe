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
    viewMode: 'grid',
    hasUnsavedChanges: false,

    // Book-mode runtime handles (TOC re-render, scroll-spy). Tracked so
    // we can tear them down cleanly when leaving book mode or the view.
    _bookEditorInputHandler: null,
    _bookEditorScrollHandler: null,
    _bookViewerScrollHandler: null,
    _bookViewerKeyHandler: null,
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
        this.loadViewMode();
        this.setupEventListeners();
        this.render();
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
     * Load view mode preference from storage
     */
    loadViewMode() {
        const prefs = StorageManager.get('notesPrefs');
        this.viewMode = prefs?.viewMode || 'grid';
    },

    /**
     * Save view mode preference to storage
     */
    saveViewMode() {
        StorageManager.set('notesPrefs', { viewMode: this.viewMode });
    },

    /**
     * Toggle between grid and list view
     */
    toggleViewMode() {
        this.viewMode = this.viewMode === 'grid' ? 'list' : 'grid';
        this.saveViewMode();
        this.render();
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

        // Search input
        const searchInput = document.getElementById('notes-search');
        const newSearchInput = searchInput.cloneNode(true);
        searchInput.parentNode.replaceChild(newSearchInput, searchInput);
        newSearchInput.addEventListener('input', UIUtils.debounce((e) => {
            this.searchQuery = e.target.value.toLowerCase();
            this.render();
        }, 300));

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

        // Editor save button
        const editorSaveBtn = document.getElementById('editor-save-btn');
        if (editorSaveBtn) {
            const newEditorSaveBtn = editorSaveBtn.cloneNode(true);
            editorSaveBtn.parentNode.replaceChild(newEditorSaveBtn, editorSaveBtn);
            newEditorSaveBtn.addEventListener('click', () => {
                // When opened from another app's detail page, Save should
                // return the user there. closeEditor() saves first, so no
                // need to call saveCurrentNote() separately.
                if (this._editorOrigin) {
                    this.closeEditor();
                } else {
                    this.saveCurrentNote();
                }
            });
        }

        // Editor delete button
        const editorDeleteBtn = document.getElementById('editor-delete-btn');
        if (editorDeleteBtn) {
            const newEditorDeleteBtn = editorDeleteBtn.cloneNode(true);
            editorDeleteBtn.parentNode.replaceChild(newEditorDeleteBtn, editorDeleteBtn);
            newEditorDeleteBtn.addEventListener('click', () => {
                this.deleteCurrentNote();
            });
        }


        // Viewer edit button
        const viewerEditBtn = document.getElementById('viewer-edit-btn');
        if (viewerEditBtn) {
            const newViewerEditBtn = viewerEditBtn.cloneNode(true);
            viewerEditBtn.parentNode.replaceChild(newViewerEditBtn, viewerEditBtn);
            newViewerEditBtn.addEventListener('click', () => {
                this.openEditorFromViewer();
            });
        }

        // Viewer export-PDF button
        const viewerPdfBtn = document.getElementById('viewer-pdf-btn');
        if (viewerPdfBtn) {
            const newViewerPdfBtn = viewerPdfBtn.cloneNode(true);
            viewerPdfBtn.parentNode.replaceChild(newViewerPdfBtn, viewerPdfBtn);
            newViewerPdfBtn.addEventListener('click', () => this.exportCurrentNotePdf(newViewerPdfBtn));
        }

        // Viewer delete button
        const viewerDeleteBtn = document.getElementById('viewer-delete-btn');
        if (viewerDeleteBtn) {
            const newViewerDeleteBtn = viewerDeleteBtn.cloneNode(true);
            viewerDeleteBtn.parentNode.replaceChild(newViewerDeleteBtn, viewerDeleteBtn);
            newViewerDeleteBtn.addEventListener('click', () => {
                this.deleteCurrentNote();
            });
        }

        // Viewer pin button
        const viewerPinBtn = document.getElementById('viewer-pin-btn');
        if (viewerPinBtn) {
            const newViewerPinBtn = viewerPinBtn.cloneNode(true);
            viewerPinBtn.parentNode.replaceChild(newViewerPinBtn, viewerPinBtn);
            newViewerPinBtn.addEventListener('click', () => {
                if (this.currentNoteId) this.togglePin(this.currentNoteId);
            });
        }
    },

    /**
     * Toggle pin state for a note. Re-renders the list and, if the viewer
     * is showing this note, refreshes its pin button label.
     */
    togglePin(noteId) {
        const note = this.notes.find(n => n.id === noteId);
        if (!note) return;
        note.pinned = !note.pinned;
        note.modifiedAt = new Date().toISOString();
        this.saveNotes();
        if (document.getElementById('note-viewer-view')?.classList.contains('active') &&
            this.currentNoteId === noteId) {
            this.updateViewerPinButton(note.pinned);
        }
        this.render();
    },

    updateViewerPinButton(pinned) {
        const btn = document.getElementById('viewer-pin-btn');
        if (!btn) return;
        btn.textContent = pinned ? '📌 Pinned' : '📌 Pin';
        btn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
    },

    /**
     * Open viewer for existing note (read-only)
     */
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

    openViewer(noteId, opts = {}) {
        if (!noteId) return;

        this.currentNoteId = noteId;
        this._viewerOrigin = opts.origin || null;
        const note = this.notes.find(n => n.id === noteId);
        if (!note) return;

        AppManager.setDetailHash('notes', 'view', noteId);

        // Hide notes view, show viewer view
        document.getElementById('notes-view').classList.remove('active');
        document.getElementById('note-viewer-view').classList.add('active');

        // Render breadcrumb
        this.renderViewerBreadcrumb(noteId, note.title);

        document.getElementById('viewer-note-title').textContent = note.title;
        document.getElementById('viewer-note-date').textContent = 'Modified ' + UIUtils.formatDateTime(note.modifiedAt);
        const contentEl = document.getElementById('viewer-note-content');
        contentEl.innerHTML = this._safeNoteHtml(note.content);

        // Apply template chrome (TOC sidebar, chapter numbering, etc.).
        const template = NoteTemplates.resolve(note);
        this.currentTemplate = template;
        this.currentBookNumbered = note.bookNumbered !== false;
        this.currentBookLayout = note.bookLayout === 'paged' ? 'paged' : 'scroll';
        this.currentBookChapterIndex = 0;
        this.currentPrompt = NotePrompts.config(note);
        this._applyViewerTemplateChrome(template, this.currentBookNumbered, this.currentBookLayout);
        if (template === 'book') this._setupBookViewer();
        else this._teardownBookViewer();
        if (template === 'prompt') this._setupPromptViewer();

        // Reading time at 220 wpm.
        const tmp = document.createElement('div');
        tmp.innerHTML = note.content || '';
        const text = (tmp.textContent || '').trim();
        const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
        const readingMinutes = words > 0 ? Math.max(1, Math.round(words / 220)) : 0;
        const readEl = document.getElementById('viewer-note-readtime');
        if (readEl) readEl.textContent = readingMinutes ? `${readingMinutes} min read` : '';

        this.renderViewerTags(note.tags);
        this.updateViewerPinButton(!!note.pinned);

        // Display linked items (read-only)
        this.renderViewerLinks(noteId);

        // Double-click anywhere in the content drops into edit mode at
        // that exact spot — much faster than scrolling back to the Edit
        // button after reading partway down.
        this._setupViewerDblClickEdit();

        // Drag-selecting a word (or 2-3 word phrase) shows a "Define"
        // pill — opens the dictionary popover for the selected text.
        // Suppress on dbl-click so the pill doesn't flash before the
        // dbl-click-to-edit handoff tears the viewer down.
        if (typeof WordLookup !== 'undefined') {
            WordLookup.attachSelectionTrigger(contentEl, { suppressOnDblClick: true });
        }
    },

    renderViewerLinks(noteId) {
        const container = document.getElementById('note-viewer-links');
        if (!container) return;

        const resolved = LinkManager.resolveLinks('notes', noteId);
        const sections = [
            { app: 'focus', label: 'Focus area' },
            { app: 'goals', label: 'Goal' },
            { app: 'schedule', label: 'Task' },
            { app: 'portfolio', label: 'Portfolio' }
        ];

        let html = '';
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

        container.innerHTML = html;

        // Click to navigate
        container.querySelectorAll('.note-viewer-link-item').forEach(el => {
            el.addEventListener('click', () => {
                LinkedItemsUI.navigateToItem(el.dataset.app, el.dataset.itemId);
            });
        });
    },

    /**
     * Close viewer and return to notes list (or to the origin that opened it)
     */
    closeViewer() {
        const origin = this._viewerOrigin;
        this._viewerOrigin = null;
        this._teardownBookViewer();
        this._teardownViewerDblClickEdit();
        if (typeof WordLookup !== 'undefined') {
            const contentEl = document.getElementById('viewer-note-content');
            WordLookup.detachSelectionTrigger(contentEl);
            WordLookup.dismiss();
        }

        document.getElementById('note-viewer-view').classList.remove('active');
        this.currentNoteId = null;
        this.currentTemplate = 'blank';
        AppManager.setDetailHash('notes', null, null);

        if (origin && typeof origin === 'object' && origin.app) {
            LinkedItemsUI.navigateToItem(origin.app, origin.itemId);
            return;
        }

        document.getElementById('notes-view').classList.add('active');
        this.render();
    },

    /**
     * Open editor from viewer. Forwards the viewer's origin to the editor
     * so Save/Delete from the editor can still return to the source.
     * `opts.caretOffset` (optional) is the text offset within the note's
     * content where the caret should land, so dbl-click-to-edit can drop
     * the user where they were reading instead of jumping to the end.
     */
    openEditorFromViewer(opts = {}) {
        const noteId = this.currentNoteId;
        const origin = this._viewerOrigin;
        this._viewerOrigin = null;
        this._teardownViewerDblClickEdit();
        if (typeof WordLookup !== 'undefined') {
            const contentEl = document.getElementById('viewer-note-content');
            WordLookup.detachSelectionTrigger(contentEl);
            WordLookup.dismiss();
        }
        document.getElementById('note-viewer-view').classList.remove('active');
        const editorOpts = {};
        if (origin) editorOpts.origin = origin;
        if (typeof opts.caretOffset === 'number' && opts.caretOffset >= 0) {
            editorOpts.caretOffset = opts.caretOffset;
        }
        // Carry the viewer's active chapter into the editor so a user who
        // hit Edit while reading chapter 5 doesn't get bounced back to
        // chapter 1. (Dbl-click-to-edit handles this via caretOffset.)
        if (this.currentTemplate === 'book' && this.currentBookLayout === 'paged') {
            editorOpts.chapterIndex = this.currentBookChapterIndex;
        }
        this.openEditor(noteId, editorOpts);
    },

    /**
     * Double-click anywhere in the rendered note content to drop into
     * edit mode at that spot. Easier than hunting for the Edit button in
     * the header — especially when the user has scrolled deep into the
     * note. Anchor clicks are left alone so links still navigate.
     */
    _setupViewerDblClickEdit() {
        const content = document.getElementById('viewer-note-content');
        if (!content) return;
        this._teardownViewerDblClickEdit();
        this._viewerDblClickHandler = (e) => {
            if (e.target && e.target.closest && e.target.closest('a')) return;

            // Resolve where the user clicked into a text offset within
            // the content root. Prefer the live selection (browsers
            // select the word the user double-clicked); fall back to
            // caretRangeFromPoint when nothing is selected (e.g. dbl-
            // click on whitespace between paragraphs).
            let offset = -1;
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0 && content.contains(sel.anchorNode)) {
                offset = this._textOffsetFromRange(content, sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
            }
            if (offset < 0 && document.caretRangeFromPoint) {
                const r = document.caretRangeFromPoint(e.clientX, e.clientY);
                if (r && content.contains(r.startContainer)) {
                    offset = this._textOffsetFromRange(content, r.startContainer, r.startOffset);
                }
            }
            this.openEditorFromViewer({ caretOffset: offset });
        };
        content.addEventListener('dblclick', this._viewerDblClickHandler);
    },

    _teardownViewerDblClickEdit() {
        const content = document.getElementById('viewer-note-content');
        if (content && this._viewerDblClickHandler) {
            content.removeEventListener('dblclick', this._viewerDblClickHandler);
        }
        this._viewerDblClickHandler = null;
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
     * Render viewer tags as inline pills inside the meta strip. Empty
     * collapses cleanly via CSS `:empty`.
     */
    renderViewerTags(noteTags = []) {
        const container = document.getElementById('viewer-tags-list');
        if (!container) return;
        if (!noteTags.length) { container.innerHTML = ''; return; }
        container.innerHTML = noteTags.map(tag => `
            <button type="button" class="tag-item tag-item--clickable" data-tag="${UIUtils.escapeHtml(tag)}" title="Filter notes by &ldquo;${UIUtils.escapeHtml(tag)}&rdquo;">${UIUtils.escapeHtml(tag)}</button>
        `).join('');
        container.querySelectorAll('[data-tag]').forEach(el => {
            el.addEventListener('click', () => {
                this.currentFilter = el.dataset.tag;
                this._viewerOrigin = null; // ensure closeViewer returns to the notes list, not the original opener
                this.closeViewer();
            });
        });
    },

    /**
     * Open editor for new or existing note.
     *
     * `opts.template` is honored only for brand-new notes. Existing notes
     * read their template from storage (use `setCurrentNoteTemplate()` to
     * convert in place).
     */
    openEditor(noteId = null, opts = {}) {
        this.currentNoteId = noteId;
        this._editorOrigin = opts.origin || null;
        this.pendingTemplate = null;

        document.getElementById('notes-view').classList.remove('active');
        document.getElementById('note-viewer-view').classList.remove('active');
        document.getElementById('note-editor-view').classList.add('active');

        const note = noteId ? this.notes.find(n => n.id === noteId) : null;
        this.renderEditorBreadcrumb(noteId, note?.title);

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
        this._setupCurrentParagraphTracker();
        if (template === 'book') this._setupBookEditor();
        else if (template === 'prompt') this._setupPromptEditor();
        this.updateSaveStatus('saved');

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
                        window.scrollTo({ top: 0 });
                    }
                }
            } else {
                newTitleInput.focus();
                window.scrollTo({ top: 0 });
            }
        }, 100);
    },

    /**
     * Close editor and return to notes list
     */
    closeEditor() {
        // Save before closing
        this.saveCurrentNote();

        RichEditor.destroy();

        // Tear down focus-mode + paragraph tracker
        if (this._focusModeHandler) {
            document.removeEventListener('keydown', this._focusModeHandler);
            this._focusModeHandler = null;
        }
        if (this._paragraphTrackerHandler) {
            document.removeEventListener('selectionchange', this._paragraphTrackerHandler);
            this._paragraphTrackerHandler = null;
        }
        const editorView = document.getElementById('note-editor-view');
        if (editorView) editorView.removeAttribute('data-focus-mode');

        if (typeof TagPicker !== 'undefined') TagPicker.close();
        if (typeof WordLookup !== 'undefined') WordLookup.dismiss();
        this._teardownBookEditor();
        this._teardownPromptEditor();

        const origin = this._editorOrigin;
        this._editorOrigin = null;

        document.getElementById('note-editor-view').classList.remove('active');
        this.currentNoteId = null;
        this.currentTemplate = 'blank';
        this.pendingTemplate = null;
        this.currentPrompt = null;
        this.autoLinkContext = null;

        if (origin && typeof origin === 'object' && origin.app) {
            LinkedItemsUI.navigateToItem(origin.app, origin.itemId);
            return;
        }

        document.getElementById('notes-view').classList.add('active');
        this.render();
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
        };
        newBtn.addEventListener('click', toggle);

        this._focusModeHandler = (e) => {
            if (e.key === 'f' || e.key === 'F') {
                const target = e.target;
                const editing = target?.closest?.('input, textarea, [contenteditable="true"]');
                if (editing) return;
                if (view.classList.contains('active')) toggle();
            }
        };
        document.addEventListener('keydown', this._focusModeHandler);
    },

    /**
     * Highlights the current paragraph (`.is-focused`) so the dim-other-text
     * effect during focus mode reads cleanly.
     */
    _setupCurrentParagraphTracker() {
        const editor = document.getElementById('note-content-editor');
        if (!editor) return;

        const update = () => {
            const sel = window.getSelection();
            if (!sel || !sel.anchorNode) return;
            let node = sel.anchorNode;
            if (node.nodeType === 3) node = node.parentNode;
            if (!editor.contains(node)) return;
            // Walk up to a direct child of the editor.
            while (node && node.parentNode && node.parentNode !== editor) {
                node = node.parentNode;
            }
            editor.querySelectorAll('.is-focused').forEach(el => el.classList.remove('is-focused'));
            if (node && node.classList) node.classList.add('is-focused');
        };

        this._paragraphTrackerHandler = update;
        document.addEventListener('selectionchange', update);
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
        const content = this._sanitizeBookViewArtifacts(RichEditor.getHTML());
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
        // A newly-enabled offline prompt should start producing without
        // waiting for the next scheduler poll.
        if (this.currentTemplate === 'prompt' && typeof PromptFeed !== 'undefined' && PromptFeed.onPromptsChanged) {
            PromptFeed.onPromptsChanged();
        }
        if (!silent) {
            this.updateSaveStatus('saved');
            UIUtils.showToast('Note saved', 'success');
        }
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

            const editorActive = document.getElementById('note-editor-view').classList.contains('active');
            if (editorActive) this.closeEditor();
            else this.closeViewer();

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
    },

    _applyViewerTemplateChrome(template, numbered = true, layout = 'scroll') {
        const frame = document.getElementById('note-viewer-frame');
        if (frame) {
            frame.setAttribute('data-template', template);
            if (numbered) frame.removeAttribute('data-book-numbered');
            else frame.setAttribute('data-book-numbered', 'false');
            if (layout === 'paged') frame.setAttribute('data-book-layout', 'paged');
            else frame.removeAttribute('data-book-layout');
        }
        const content = document.getElementById('viewer-note-content');
        if (content) {
            content.setAttribute('data-template', template);
            if (numbered) content.removeAttribute('data-book-numbered');
            else content.setAttribute('data-book-numbered', 'false');
        }
        const label = document.getElementById('viewer-note-template');
        const sep = document.querySelector('.note-viewer-template-sep');
        if (template === 'book') {
            if (label) label.innerHTML = `<span class="note-template-pill"><span class="note-template-pill-icon">${NoteTemplates.get('book').icon}</span> Book</span>`;
            if (sep) sep.style.display = '';
        } else if (template === 'prompt') {
            if (label) label.innerHTML = `<span class="note-template-pill"><span class="note-template-pill-icon">${NoteTemplates.get('prompt').icon}</span> Prompt</span>`;
            if (sep) sep.style.display = '';
        } else if (template === 'assistant') {
            if (label) label.innerHTML = `<span class="note-template-pill"><span class="note-template-pill-icon">${NoteTemplates.get('assistant').icon}</span> AI Assistant</span>`;
            if (sep) sep.style.display = '';
        } else if (template === 'feed') {
            if (label) label.innerHTML = `<span class="note-template-pill"><span class="note-template-pill-icon">${NoteTemplates.get('feed').icon}</span> Prompt Feed</span>`;
            if (sep) sep.style.display = '';
        } else {
            if (label) label.innerHTML = '';
            if (sep) sep.style.display = 'none';
        }
        this._updateLayoutBtnState('viewer', layout);
    },

    // Wire the viewer's run-actions row for a prompt note. The row is shown
    // via CSS only for [data-template="prompt"]; here we just bind buttons
    // and toggle the offline-only "Run now" button.
    _setupPromptViewer() {
        const cfg = NotePrompts.config(this.notes.find(n => n.id === this.currentNoteId));
        const replace = (id, handler) => {
            const el = document.getElementById(id);
            if (!el) return;
            const fresh = el.cloneNode(true);
            el.parentNode.replaceChild(fresh, el);
            fresh.addEventListener('click', handler);
            return fresh;
        };
        replace('note-prompt-run-agent-viewer', () => {
            const note = this.notes.find(n => n.id === this.currentNoteId);
            if (note) NotePrompts.runInAgent(note);
        });
        replace('note-prompt-run-browser-viewer', () => {
            const note = this.notes.find(n => n.id === this.currentNoteId);
            if (note) NotePrompts.runInBrowser(note);
        });
        const runNow = replace('note-prompt-run-now-viewer', () => {
            if (this.currentNoteId && typeof PromptFeed !== 'undefined') PromptFeed.runNow(this.currentNoteId);
        });
        if (runNow) runNow.hidden = !cfg.offline;
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
     * state. `scope` is 'editor' or 'viewer' — each view has its own button.
     */
    _updateLayoutBtnState(scope, layout) {
        const id = scope === 'viewer' ? 'note-book-layout-btn-viewer' : 'note-book-layout-btn';
        const btn = document.getElementById(id);
        if (!btn) return;
        const paged = layout === 'paged';
        btn.classList.toggle('is-active', paged);
        btn.setAttribute('aria-pressed', paged ? 'true' : 'false');
    },

    /**
     * Wire the per-note layout toggle in either the editor or viewer.
     * Switching swaps the rendering immediately and (for editor) marks
     * the note as unsaved so the choice persists with autosave.
     */
    _setupLayoutToggle(scope) {
        const id = scope === 'viewer' ? 'note-book-layout-btn-viewer' : 'note-book-layout-btn';
        const btn = document.getElementById(id);
        if (!btn) return;
        const fresh = btn.cloneNode(true);
        btn.parentNode.replaceChild(fresh, btn);
        this._updateLayoutBtnState(scope, this.currentBookLayout);
        fresh.addEventListener('click', () => {
            const next = this.currentBookLayout === 'paged' ? 'scroll' : 'paged';
            this.setBookLayout(next, scope);
        });
    },

    /**
     * Switch the active book note between scroll and paged layouts.
     * `originScope` is the view that initiated the switch — used so the
     * other view's toggle button (if visible) also reflects the change.
     */
    setBookLayout(layout, originScope = 'editor') {
        const next = layout === 'paged' ? 'paged' : 'scroll';
        if (next === this.currentBookLayout) return;
        this.currentBookLayout = next;

        if (originScope === 'viewer') {
            this._applyViewerTemplateChrome(this.currentTemplate, this.currentBookNumbered, next);
            // Re-run the viewer setup so scroll-spy / paged tagging swap.
            this._setupBookViewer();
            // Persist directly — viewer has no autosave loop to ride on.
            if (this.currentNoteId) {
                const note = this.notes.find(n => n.id === this.currentNoteId);
                if (note) {
                    note.bookLayout = next;
                    note.modifiedAt = new Date().toISOString();
                    this.saveNotes();
                }
            }
        } else {
            this._applyEditorTemplateChrome(this.currentTemplate, this.currentBookNumbered, next);
            this._setupBookEditor();
            this.markAsUnsaved();
            this.autoSave();
        }
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
            this._bookEditorScrollHandler = () => this._updateActiveTocItem('editor');
            window.addEventListener('scroll', this._bookEditorScrollHandler, { passive: true });
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
            window.scrollTo({ top: 0, behavior: 'auto' });
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
        // Account for the fixed titlebar (38px) plus a little breathing room.
        const targetY = h1.getBoundingClientRect().top + window.scrollY - 60;
        window.scrollTo({ top: targetY, behavior: 'smooth' });
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

        const threshold = 120;
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

    // -----------------------------
    // Book viewer — TOC + prev/next
    // -----------------------------

    _setupBookViewer() {
        this._teardownBookViewer();
        const content = document.getElementById('viewer-note-content');
        const list = document.getElementById('note-book-toc-list-viewer');
        if (!content || !list) return;
        const chapters = NoteTemplates.extractChaptersFromElement(content);
        this._paintTocList(list, chapters, 'viewer');
        this._applyTocWidth(this._loadTocWidth());
        this._setupTocResizer('note-book-toc-resizer-viewer', 'note-viewer-frame');
        this._setupLayoutToggle('viewer');

        if (this.currentBookLayout === 'paged') {
            this._applyPagedView('viewer', this.currentBookChapterIndex || 0);
            // Left/Right arrows turn pages in paged reading mode. Safe in
            // the viewer because its content isn't editable; we still skip
            // when typing into the search box or any other input/textarea,
            // and let modifier combos (Cmd-Left = nav back, etc.) through.
            this._bookViewerKeyHandler = (e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
                const t = e.target;
                if (t && (t.matches?.('input, textarea, [contenteditable="true"]') || t.isContentEditable)) return;
                // Only act when the viewer view is the active surface.
                if (!document.getElementById('note-viewer-view')?.classList.contains('active')) return;
                e.preventDefault();
                this._stepChapter('viewer', e.key === 'ArrowLeft' ? -1 : 1);
            };
            document.addEventListener('keydown', this._bookViewerKeyHandler);
        } else {
            this._bookViewerScrollHandler = () => this._updateActiveTocItem('viewer');
            window.addEventListener('scroll', this._bookViewerScrollHandler, { passive: true });
            this._updateActiveTocItem('viewer');
        }

        this._wireChapterPager('viewer');
    },

    _teardownBookViewer() {
        if (this._bookViewerScrollHandler) {
            window.removeEventListener('scroll', this._bookViewerScrollHandler);
            this._bookViewerScrollHandler = null;
        }
        if (this._bookViewerKeyHandler) {
            document.removeEventListener('keydown', this._bookViewerKeyHandler);
            this._bookViewerKeyHandler = null;
        }
        this._clearPagedView('viewer');
        const nav = document.getElementById('note-book-chapter-nav');
        if (nav) nav.style.display = 'none';
    },

    _updateViewerChapterNav(activeIdx, total) {
        // Backwards-compatible wrapper — scroll-mode scroll-spy still calls
        // through to this. Delegates to the unified pager updater.
        this._updateChapterPager('viewer', activeIdx, total);
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
     * Clamp width to [MIN, MAX] and push it onto BOTH frames' inline
     * style as a CSS custom property. Writing to both frames at once
     * keeps the editor and viewer visually in sync, so switching
     * between them never reflows.
     */
    _applyTocWidth(width) {
        const w = Math.round(Math.min(this.TOC_WIDTH_MAX, Math.max(this.TOC_WIDTH_MIN, width)));
        ['note-editor-frame', 'note-viewer-frame'].forEach(id => {
            const frame = document.getElementById(id);
            if (frame) frame.style.setProperty('--note-book-toc-width', w + 'px');
        });
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
        if (document.getElementById('note-editor-view').classList.contains('active')) {
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

        if (document.getElementById('note-editor-view')?.classList.contains('active')) {
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
        Breadcrumb.render('notes-breadcrumb', [
            { label: 'Notes' }
        ]);
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
                if (document.getElementById('note-viewer-view').classList.contains('active')) this.closeViewer();
                else if (document.getElementById('note-editor-view').classList.contains('active')) this.closeEditor();
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
                if (document.getElementById('note-viewer-view').classList.contains('active')) this.closeViewer();
                else if (document.getElementById('note-editor-view').classList.contains('active')) this.closeEditor();
            }});
        }
        return crumbs;
    },

    renderViewerBreadcrumb(noteId) {
        Breadcrumb.render('note-viewer-breadcrumb', this._buildNoteCrumbs(noteId, this._viewerOrigin));
    },

    renderEditorBreadcrumb(noteId) {
        Breadcrumb.render('note-editor-breadcrumb', this._buildNoteCrumbs(noteId, this._editorOrigin));
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
