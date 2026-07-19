/**
 * Journal App - Data Management
 */

const JournalApp = {
    entries: [],
    currentEntryId: null,
    searchQuery: '',
    filterBy: 'all',
    moodFilter: null,
    tagFilter: null,
    hasUnsavedChanges: false,

    // Diary view state (device-local, not synced)
    viewMode: 'diary',     // 'list' | 'diary' — diary is the default layout
    diaryIndex: 0,         // index into filtered entries (newest-first)
    diaryOpen: false,      // has the cover been opened?
    diaryView: 'entry',    // 'entry' | 'toc' — what's showing inside the opened book
    contentPage: 0,        // current content spread within the active entry (0-based)

    VIEW_MODE_STORAGE_KEY: 'journal-view-mode',

    /**
     * Initialize the journal app
     */
    init() {
        this.loadEntries();
        this.loadViewMode();
        this.setupEventListeners();
        this.render(); // Render entries when app opens
    },

    /**
     * Load preferred view mode from localStorage (per-device, not synced).
     */
    loadViewMode() {
        try {
            const saved = localStorage.getItem(this.VIEW_MODE_STORAGE_KEY);
            if (saved === 'diary' || saved === 'list') {
                this.viewMode = saved;
            }
        } catch (_) {
            // localStorage unavailable — fall back to default
        }
    },

    /**
     * Persist the current view mode to localStorage.
     */
    saveViewMode() {
        try {
            localStorage.setItem(this.VIEW_MODE_STORAGE_KEY, this.viewMode);
        } catch (_) { /* ignore */ }
    },

    /**
     * Load entries from storage
     */
    loadEntries() {
        const data = StorageManager.get('journal');
        // Normalize so every entry has the fields the renderer assumes — entries
        // created on other devices (e.g. the phone) may omit `tags`, and an
        // unguarded `entry.tags.forEach`/`.map` would otherwise crash the whole
        // journal render (count still shows, but nothing loads).
        this.entries = (data?.entries || []).map(e => ({ ...e, tags: Array.isArray(e.tags) ? e.tags : [] }));
    },

    /**
     * Save entries to storage
     */
    saveEntries() {
        StorageManager.set('journal', { entries: this.entries });
        AppManager.updateStats();
    },

    /**
     * Setup event listeners
     */
    setupEventListeners() {
        // Add entry button - remove old listener first
        const addBtn = document.getElementById('add-journal-btn');
        const newAddBtn = addBtn.cloneNode(true);
        addBtn.parentNode.replaceChild(newAddBtn, addBtn);
        newAddBtn.addEventListener('click', () => {
            this.openEditor();
        });

        // Search input
        const searchInput = document.getElementById('journal-search');
        const newSearchInput = searchInput.cloneNode(true);
        searchInput.parentNode.replaceChild(newSearchInput, searchInput);
        newSearchInput.addEventListener('input', UIUtils.debounce((e) => {
            this.searchQuery = e.target.value.toLowerCase();
            // Filter changed — reset diary position so we don't land on a
            // stale index
            this.diaryIndex = 0;
            this.contentPage = 0;
            this.render();
        }, 300));

        // View toggle (list / diary)
        const viewToggle = document.getElementById('journal-view-toggle');
        if (viewToggle) {
            const newViewToggle = viewToggle.cloneNode(true);
            viewToggle.parentNode.replaceChild(newViewToggle, viewToggle);
            newViewToggle.addEventListener('click', (e) => {
                const btn = e.target.closest('.journal-view-toggle-btn');
                if (!btn) return;
                this.setViewMode(btn.dataset.view);
            });
        }

        // Arrow-key page flipping in diary view (bound once, at the
        // document level, and guarded by view/mode state each time).
        if (!this._diaryKeyNavBound) {
            this._diaryKeyNavBound = true;
            document.addEventListener('keydown', (e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;

                // Only when the journal app is the active view, the
                // diary layout is selected, and the book is open.
                const journalView = document.getElementById('journal-view');
                if (!journalView || !journalView.classList.contains('active')) return;
                if (this.viewMode !== 'diary' || !this.diaryOpen) return;
                // In the TOC, let arrow keys behave normally (scroll)
                if (this.diaryView !== 'entry') return;

                // Don't hijack keystrokes while the user is typing in
                // the search input or any other editable element.
                const t = e.target;
                if (t && (t.matches('input, textarea, select') || t.isContentEditable)) return;

                // Also skip if a modifier is held (cursor-word nav etc.)
                if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;

                e.preventDefault();
                // Pages first, then entries.
                // Right arrow = forward in reading order (next content
                // page, spilling to newer entry when at the last page).
                // Left arrow = backward (previous content page, spilling
                // to older entry when at the first page).
                if (e.key === 'ArrowLeft') {
                    this.navigateContent(-1);
                } else {
                    this.navigateContent(1);
                }
            });
        }

        // Editor save button
        const editorSaveBtn = document.getElementById('journal-editor-save-btn');
        if (editorSaveBtn) {
            const newEditorSaveBtn = editorSaveBtn.cloneNode(true);
            editorSaveBtn.parentNode.replaceChild(newEditorSaveBtn, editorSaveBtn);
            newEditorSaveBtn.addEventListener('click', () => {
                this.saveCurrentEntry();
            });
        }

        // Editor delete button
        const editorDeleteBtn = document.getElementById('journal-editor-delete-btn');
        if (editorDeleteBtn) {
            const newEditorDeleteBtn = editorDeleteBtn.cloneNode(true);
            editorDeleteBtn.parentNode.replaceChild(newEditorDeleteBtn, editorDeleteBtn);
            newEditorDeleteBtn.addEventListener('click', () => {
                this.deleteCurrentEntry();
            });
        }

        // Viewer edit button
        const viewerEditBtn = document.getElementById('journal-viewer-edit-btn');
        if (viewerEditBtn) {
            const newViewerEditBtn = viewerEditBtn.cloneNode(true);
            viewerEditBtn.parentNode.replaceChild(newViewerEditBtn, viewerEditBtn);
            newViewerEditBtn.addEventListener('click', () => {
                this.openEditorFromViewer();
            });
        }

        // Viewer delete button
        const viewerDeleteBtn = document.getElementById('journal-viewer-delete-btn');
        if (viewerDeleteBtn) {
            const newViewerDeleteBtn = viewerDeleteBtn.cloneNode(true);
            viewerDeleteBtn.parentNode.replaceChild(newViewerDeleteBtn, viewerDeleteBtn);
            newViewerDeleteBtn.addEventListener('click', () => {
                this.deleteCurrentEntry();
            });
        }
    },

    /**
     * Create a new entry
     * @param {Object} entryData
     * @returns {Object} Created entry
     */
    createEntry(entryData) {
        const entry = {
            id: UIUtils.generateId(),
            content: entryData.content || '',
            mood: entryData.mood || 'neutral',
            tags: entryData.tags || [],
            profile: entryData.profile || ProfileManager.getProfileForNewItem(),
            date: entryData.date || new Date().toISOString(),
            createdAt: new Date().toISOString(),
            modifiedAt: new Date().toISOString()
        };

        this.entries.unshift(entry);
        this.saveEntries();
        if (typeof AnalyticsManager !== 'undefined') {
            AnalyticsManager.record('journal.entry_written');
        }
        return entry;
    },

    /**
     * Update an entry
     * @param {string} id - Entry ID
     * @param {Object} updates - Fields to update
     */
    updateEntry(id, updates) {
        const index = this.entries.findIndex(e => e.id === id);
        if (index !== -1) {
            this.entries[index] = {
                ...this.entries[index],
                ...updates,
                modifiedAt: new Date().toISOString()
            };
            this.saveEntries();
            // Invalidate any cached pagination for this entry so the
            // diary re-measures after an edit. The new modifiedAt key
            // would miss the cache anyway, but this keeps the map tidy.
            if (typeof JournalUI !== 'undefined' && JournalUI.invalidatePaginationCache) {
                JournalUI.invalidatePaginationCache(id);
            }
            // Reset content-page so we don't land mid-entry on a page
            // that may no longer exist after the edit.
            this.contentPage = 0;
        }
    },

    /**
     * Delete an entry
     * @param {string} id - Entry ID
     */
    async deleteEntry(id) {
        const confirmed = await UIUtils.confirm(
            'Delete Entry',
            'Are you sure you want to delete this journal entry?',
            '🗑️'
        );

        if (confirmed) {
            this.entries = this.entries.filter(e => e.id !== id);
            this.saveEntries();
            if (typeof JournalUI !== 'undefined' && JournalUI.invalidatePaginationCache) {
                JournalUI.invalidatePaginationCache(id);
            }
            this.contentPage = 0;
            this.render();
            UIUtils.showToast('Entry deleted', 'success');
        }
    },

    /**
     * Get filtered entries
     * @returns {Array} Filtered entries
     */
    getFilteredEntries() {
        let filtered = ProfileManager.filterByActiveProfile([...this.entries]);

        // Apply search filter
        if (this.searchQuery) {
            filtered = filtered.filter(entry =>
                entry.content.toLowerCase().includes(this.searchQuery) ||
                entry.tags.some(tag => tag.toLowerCase().includes(this.searchQuery))
            );
        }

        // Apply date filter
        const now = new Date();
        if (this.filterBy === 'week') {
            const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            filtered = filtered.filter(entry => new Date(entry.date) >= weekAgo);
        } else if (this.filterBy === 'month') {
            const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            filtered = filtered.filter(entry => new Date(entry.date) >= monthAgo);
        }

        // Apply mood filter
        if (this.moodFilter) {
            filtered = filtered.filter(entry => entry.mood === this.moodFilter);
        }

        // Apply tag filter
        if (this.tagFilter) {
            filtered = filtered.filter(entry => entry.tags.includes(this.tagFilter));
        }

        // Sort by date (newest first)
        filtered.sort((a, b) => new Date(b.date) - new Date(a.date));

        return filtered;
    },

    /**
     * Switch between list and diary layouts.
     * @param {string} mode - 'list' | 'diary'
     */
    setViewMode(mode) {
        if (mode !== 'list' && mode !== 'diary') return;
        if (this.viewMode === mode) return;
        this.viewMode = mode;
        // Always start the diary closed so the cover shows
        this.diaryOpen = false;
        this.diaryIndex = 0;
        this.diaryView = 'entry';
        this.contentPage = 0;
        this.saveViewMode();
        this.render();
    },

    /**
     * Open the diary book (cover -> first page).
     */
    openDiaryBook() {
        this.diaryOpen = true;
        this.diaryIndex = 0;
        this.diaryView = 'entry';
        this.contentPage = 0;
        this.render();
    },

    /**
     * Close the diary book, returning to the cover.
     */
    closeDiaryBook() {
        this.diaryOpen = false;
        this.diaryView = 'entry';
        this.contentPage = 0;
        this.render();
    },

    /**
     * Navigate between diary entries. No-op while the table of
     * contents is showing. Resets contentPage to 0 on the new entry.
     * @param {number} delta - +1 = older entry, -1 = newer entry
     */
    navigateDiary(delta) {
        if (this.diaryView !== 'entry') return;
        const filtered = this.getFilteredEntries();
        const next = this.diaryIndex + delta;
        if (next < 0 || next >= filtered.length) return;
        this.diaryIndex = next;
        this.contentPage = 0;
        this.render();
    },

    /**
     * "Pages first, then entries" navigation. Attempts to advance the
     * content-page within the current entry; if we're at the edge,
     * spills over to the prev/next entry.
     *
     * @param {number} delta  +1 = next page (or next entry if at last page)
     *                        -1 = previous page (or previous entry if at first page)
     */
    navigateContent(delta) {
        if (this.diaryView !== 'entry') return;

        const entries = this.getFilteredEntries();
        const entry = entries[this.diaryIndex];
        if (!entry) return;

        // Figure out how many content pages the current entry has by
        // asking JournalUI's cache. If the cache doesn't have it yet
        // (e.g. first keystroke before first render), fall back to 1
        // page and let the renderer recompute on the next render.
        const pageCount = this._getContentPageCount(entry);

        const nextPage = this.contentPage + delta;

        if (nextPage >= 0 && nextPage < pageCount) {
            this.contentPage = nextPage;
            this.render();
            return;
        }

        // Overflowed the current entry — spill to adjacent entry.
        if (delta > 0) {
            // Newer direction (index - 1)
            if (this.diaryIndex > 0) {
                this.diaryIndex -= 1;
                this.contentPage = 0;
                this.render();
            }
        } else {
            // Older direction (index + 1)
            if (this.diaryIndex < entries.length - 1) {
                this.diaryIndex += 1;
                this.contentPage = 0;
                this.render();
            }
        }
    },

    /**
     * Return the number of content-spread pages for a given entry,
     * relying on the JournalUI pagination cache when available.
     */
    _getContentPageCount(entry) {
        if (typeof JournalUI === 'undefined' || !JournalUI._paginationCache) return 1;
        for (const [key, chunks] of JournalUI._paginationCache) {
            if (key.startsWith(`${entry.id}|${entry.modifiedAt}|`)) {
                return Math.max(1, Math.ceil(chunks.length / 2));
            }
        }
        return 1;
    },

    /**
     * Show the table of contents inside the book.
     */
    showDiaryContents() {
        if (!this.diaryOpen) this.diaryOpen = true;
        this.diaryView = 'toc';
        this.render();
    },

    /**
     * Jump to a specific entry from the table of contents.
     * @param {number} index - Index into the currently filtered list
     */
    jumpToDiaryEntry(index) {
        const filtered = this.getFilteredEntries();
        if (index < 0 || index >= filtered.length) return;
        this.diaryIndex = index;
        this.diaryView = 'entry';
        this.contentPage = 0;
        this.render();
    },

    /**
     * Return from the TOC to the last-viewed entry.
     */
    hideDiaryContents() {
        this.diaryView = 'entry';
        this.render();
    },

    /**
     * Open viewer for existing entry (read-only)
     */
    openViewer(entryId) {
        if (!entryId) return;

        this.currentEntryId = entryId;
        const entry = this.entries.find(e => e.id === entryId);
        if (!entry) return;

        AppManager.setDetailHash('journal', 'view', entryId);

        // Hide journal view, show viewer view
        document.getElementById('journal-view').classList.remove('active');
        document.getElementById('journal-viewer-view').classList.add('active');

        // Render breadcrumb
        const entryDate = new Date(entry.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        Breadcrumb.render('journal-viewer-breadcrumb', [
            { label: 'Journal', action: () => this.closeViewer() },
            { label: entry.title || entryDate }
        ]);

        // Display entry content
        const date = new Date(entry.date);
        const formattedDate = date.toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
        document.getElementById('journal-viewer-date').textContent = formattedDate;
        document.getElementById('journal-viewer-content').innerHTML = entry.content;

        // Mood pill — same chip style as the editor's mood trigger.
        const moodInfo = JournalUI.getMoodInfo(entry.mood);
        document.getElementById('journal-viewer-mood-display').innerHTML = `
            <span class="journal-mood-pill">
                <span class="journal-mood-icon">${moodInfo.icon}</span>
                <span class="journal-mood-label">${moodInfo.label}</span>
            </span>
        `;

        // Reading time at 220 wpm.
        const tmp = document.createElement('div');
        tmp.innerHTML = entry.content || '';
        const text = (tmp.textContent || '').trim();
        const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
        const readingMinutes = words > 0 ? Math.max(1, Math.round(words / 220)) : 0;
        const readingLabel = words === 0
            ? '0 words'
            : (readingMinutes <= 1 ? `${words} word${words === 1 ? '' : 's'}` : `${words} words · ${readingMinutes} min read`);
        document.getElementById('journal-viewer-readtime').textContent = readingLabel;

        // Tags as inline pills inside the meta strip (read-only).
        const tagsContainer = document.getElementById('journal-viewer-tags');
        tagsContainer.innerHTML = entry.tags.map(tag => `
            <span class="tag-item tag-item--readonly">${UIUtils.escapeHtml(tag)}</span>
        `).join('');
    },

    /**
     * Close viewer and return to journal list
     */
    closeViewer() {
        document.getElementById('journal-viewer-view').classList.remove('active');
        document.getElementById('journal-view').classList.add('active');
        this.currentEntryId = null;
        AppManager.setDetailHash('journal', null, null);
        this.render();
    },

    /**
     * Open editor from viewer
     */
    openEditorFromViewer() {
        const entryId = this.currentEntryId;
        document.getElementById('journal-viewer-view').classList.remove('active');
        this.openEditor(entryId);
    },

    /**
     * Get local date string in YYYY-MM-DD format
     * @param {Date} date - Date object (defaults to now)
     * @returns {string} Date string
     */
    getLocalDateString(date = new Date()) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    },

    /**
     * Mark as unsaved
     */
    markAsUnsaved() {
        this.hasUnsavedChanges = true;
        this.updateSaveStatus('unsaved');
    },

    /**
     * Update save status indicator (icon + label).
     */
    updateSaveStatus(status) {
        const statusEl = document.getElementById('journal-save-status');
        if (!statusEl) return;
        const label = statusEl.querySelector('.journal-save-label');

        statusEl.dataset.state = status;
        if (status === 'saving') {
            if (label) label.textContent = 'Saving';
            statusEl.title = 'Saving…';
            statusEl.setAttribute('aria-label', 'Saving');
        } else if (status === 'saved') {
            if (label) label.textContent = 'Saved';
            statusEl.title = 'Saved';
            statusEl.setAttribute('aria-label', 'Saved');
            this.hasUnsavedChanges = false;
        } else if (status === 'unsaved') {
            if (label) label.textContent = 'Unsaved';
            statusEl.title = 'Unsaved changes';
            statusEl.setAttribute('aria-label', 'Unsaved changes');
        }
    },

    /**
     * Auto-save current entry
     */
    autoSave() {
        if (this.currentEntryId || RichEditor.getText().trim().length > 0) {
            this.updateSaveStatus('saving');
            setTimeout(() => {
                this.saveCurrentEntry(true);
                this.updateSaveStatus('saved');
            }, 1000);
        }
    },

    /**
     * Open editor for new or existing entry
     */
    openEditor(entryId = null) {
        this.currentEntryId = entryId;
        this._currentMood = 'neutral';

        // Hide other views, show editor view
        document.getElementById('journal-view').classList.remove('active');
        document.getElementById('journal-viewer-view').classList.remove('active');
        document.getElementById('journal-editor-view').classList.add('active');

        // Render breadcrumb
        const entry = entryId ? this.entries.find(e => e.id === entryId) : null;
        const label = entry ? (entry.title || new Date(entry.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })) : 'New Entry';
        Breadcrumb.render('journal-editor-breadcrumb', [
            { label: 'Journal', action: () => this.closeEditor() },
            { label }
        ]);

        // Initialize rich text editor with v2 features. No permanent
        // toolbar — the floating selection toolbar, slash menu, and
        // markdown shortcuts replace it.
        RichEditor.init('journal-content-input', null, () => {
            this.markAsUnsaved();
            this.autoSave();
        }, {
            selectionToolbar: true,
            markdownShortcuts: true,
            slashMenu: true,
            linkPopover: true,
            onWordCount: ({ words, readingMinutes }) => {
                const el = document.getElementById('journal-word-count');
                if (!el) return;
                if (words === 0) {
                    el.textContent = '0 words';
                } else if (readingMinutes <= 1) {
                    el.textContent = `${words} word${words === 1 ? '' : 's'}`;
                } else {
                    el.textContent = `${words} words · ${readingMinutes} min read`;
                }
            }
        });

        // Track date changes; the visible label is a button that opens
        // the (visually hidden) native date picker.
        const dateInput = document.getElementById('journal-date-input');
        const oldTrigger = document.getElementById('journal-date-trigger');

        // Replace the trigger up front so listener re-binding can't
        // stack across re-opens. We re-query the display span AFTER the
        // replace — the cloned node is a fresh DOM element and the old
        // reference would be orphaned.
        let dateTrigger = oldTrigger;
        if (oldTrigger) {
            const fresh = oldTrigger.cloneNode(true);
            oldTrigger.parentNode.replaceChild(fresh, oldTrigger);
            dateTrigger = fresh;
        }

        const renderDateLabel = () => {
            const display = document.getElementById('journal-date-display');
            if (!display) return;
            const v = dateInput.value;
            if (!v) { display.textContent = 'Today'; return; }
            const [y, m, d] = v.split('-').map(Number);
            const dt = new Date(y, m - 1, d, 12, 0, 0);
            const today = this.getLocalDateString();
            const yest = (() => {
                const t = new Date(); t.setDate(t.getDate() - 1);
                return this.getLocalDateString(t);
            })();
            if (v === today) display.textContent = 'Today';
            else if (v === yest) display.textContent = 'Yesterday';
            else display.textContent = dt.toLocaleDateString(undefined, {
                weekday: 'short', month: 'short', day: 'numeric',
                year: dt.getFullYear() === new Date().getFullYear() ? undefined : 'numeric'
            });
        };

        dateInput.addEventListener('input', () => {
            renderDateLabel();
            this.markAsUnsaved();
        });
        dateInput.addEventListener('change', renderDateLabel);

        if (dateTrigger) {
            dateTrigger.addEventListener('click', () => {
                if (typeof dateInput.showPicker === 'function') {
                    try { dateInput.showPicker(); return; } catch (_) { /* fall through */ }
                }
                dateInput.focus();
                dateInput.click();
            });
        }
        // Initial label render after the value is set further down.
        this._renderDateLabel = renderDateLabel;

        // Load entry data if editing
        if (entryId) {
            const entry = this.entries.find(e => e.id === entryId);
            if (entry) {
                document.getElementById('journal-date-input').value = this.getLocalDateString(new Date(entry.date));
                RichEditor.setHTML(entry.content);
                this._setEditorMood(entry.mood || 'neutral');
                this.renderEditorTags(entry.tags || []);
            }
        } else {
            document.getElementById('journal-date-input').value = this.getLocalDateString();
            RichEditor.clear();
            this._setEditorMood('neutral');
            this.renderEditorTags([]);
        }
        // Render the friendly date label now that the value is set.
        if (this._renderDateLabel) this._renderDateLabel();

        // Wire up the mood popover, tags input, focus mode toggle, and
        // current-paragraph tracker.
        this._setupMoodPopover();
        this.setupEditorTagsInput();
        this._setupFocusMode();
        this._setupCurrentParagraphTracker();

        // Reset save dot
        this.updateSaveStatus('saved');

        // Focus content input
        setTimeout(() => {
            document.getElementById('journal-content-input').focus();
        }, 100);
    },

    /**
     * Render the mood trigger button in the metadata strip.
     */
    _setEditorMood(mood) {
        this._currentMood = mood;
        const info = (typeof JournalUI !== 'undefined' && JournalUI.getMoodInfo)
            ? JournalUI.getMoodInfo(mood)
            : { icon: '○', label: 'Mood' };
        const iconEl = document.getElementById('journal-mood-icon');
        const labelEl = document.getElementById('journal-mood-label');
        if (iconEl) iconEl.textContent = info.icon;
        if (labelEl) labelEl.textContent = info.label;
    },

    /**
     * Wire up the mood popover: click trigger to open, click an option
     * to set, click outside or Esc to close.
     */
    _setupMoodPopover() {
        const trigger = document.getElementById('journal-mood-trigger');
        const popover = document.getElementById('journal-mood-popover');
        if (!trigger || !popover) return;

        // Render mood options into popover.
        popover.innerHTML = this.renderMoodSelector(this._currentMood || 'neutral');

        const open = () => {
            // Position below the trigger.
            const r = trigger.getBoundingClientRect();
            popover.hidden = false;
            const pr = popover.getBoundingClientRect();
            let top = r.bottom + 6;
            let left = r.left;
            const margin = 8;
            if (left + pr.width > window.innerWidth - margin) left = window.innerWidth - margin - pr.width;
            popover.style.top = `${top}px`;
            popover.style.left = `${left}px`;
            trigger.setAttribute('aria-expanded', 'true');
        };

        const close = () => {
            popover.hidden = true;
            trigger.setAttribute('aria-expanded', 'false');
        };

        // Replace any prior listeners by cloning the trigger.
        const fresh = trigger.cloneNode(true);
        trigger.parentNode.replaceChild(fresh, trigger);
        fresh.addEventListener('click', (e) => {
            e.stopPropagation();
            if (popover.hidden) open(); else close();
        });

        popover.addEventListener('click', (e) => {
            const opt = e.target.closest('.mood-option');
            if (!opt) return;
            const mood = opt.dataset.mood;
            popover.querySelectorAll('.mood-option').forEach(o => o.classList.toggle('selected', o === opt));
            this._setEditorMood(mood);
            this.markAsUnsaved();
            close();
        });

        // Outside click / Esc — bound once, with state-guarded handlers.
        if (!this._moodOutsideBound) {
            this._moodOutsideBound = true;
            document.addEventListener('mousedown', (e) => {
                const pop = document.getElementById('journal-mood-popover');
                const trg = document.getElementById('journal-mood-trigger');
                if (!pop || pop.hidden) return;
                if (pop.contains(e.target) || (trg && trg.contains(e.target))) return;
                pop.hidden = true;
                if (trg) trg.setAttribute('aria-expanded', 'false');
            });
            document.addEventListener('keydown', (e) => {
                if (e.key !== 'Escape') return;
                const pop = document.getElementById('journal-mood-popover');
                if (pop && !pop.hidden) {
                    pop.hidden = true;
                    const trg = document.getElementById('journal-mood-trigger');
                    if (trg) trg.setAttribute('aria-expanded', 'false');
                }
            });
        }
    },

    /**
     * Focus mode toggle. Adds [data-focus-mode="true"] to the editor
     * view and lets CSS dim chrome + non-current paragraphs. Esc exits.
     */
    _setupFocusMode() {
        const btn = document.getElementById('journal-focus-mode-btn');
        const view = document.getElementById('journal-editor-view');
        if (!btn || !view) return;

        const setMode = (on) => {
            view.dataset.focusMode = on ? 'true' : 'false';
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
            btn.title = on ? 'Exit focus mode (F or Esc)' : 'Focus mode (F)';
        };

        // Start unfocused unless previously persisted on this device.
        const persisted = localStorage.getItem('journal-focus-mode') === 'true';
        setMode(persisted);

        const fresh = btn.cloneNode(true);
        btn.parentNode.replaceChild(fresh, btn);
        fresh.addEventListener('click', () => {
            const next = view.dataset.focusMode !== 'true';
            setMode(next);
            try { localStorage.setItem('journal-focus-mode', String(next)); } catch (_) { /* ignore */ }
        });

        // Keyboard: F toggles when not in an input, Esc exits.
        if (!this._focusModeKeyBound) {
            this._focusModeKeyBound = true;
            document.addEventListener('keydown', (e) => {
                const v = document.getElementById('journal-editor-view');
                if (!v || !v.classList.contains('active')) return;
                const t = e.target;
                const inEditable = t && (t.matches('input, textarea, select') || t.isContentEditable);

                if (e.key === 'Escape' && v.dataset.focusMode === 'true' && !inEditable) {
                    e.preventDefault();
                    v.dataset.focusMode = 'false';
                    const b = document.getElementById('journal-focus-mode-btn');
                    if (b) b.setAttribute('aria-pressed', 'false');
                    try { localStorage.setItem('journal-focus-mode', 'false'); } catch (_) { /* ignore */ }
                    return;
                }
                if ((e.key === 'f' || e.key === 'F') && !inEditable && !e.metaKey && !e.ctrlKey && !e.altKey) {
                    e.preventDefault();
                    const next = v.dataset.focusMode !== 'true';
                    v.dataset.focusMode = next ? 'true' : 'false';
                    const b = document.getElementById('journal-focus-mode-btn');
                    if (b) b.setAttribute('aria-pressed', next ? 'true' : 'false');
                    try { localStorage.setItem('journal-focus-mode', String(next)); } catch (_) { /* ignore */ }
                }
            });
        }
    },

    /**
     * Mark the block-level element containing the caret with `.is-focused`
     * so focus-mode CSS can dim its siblings. We rebind the listener each
     * time openEditor() runs, since RichEditor.destroy() rips down the
     * editor element on close.
     */
    _setupCurrentParagraphTracker() {
        const editor = document.getElementById('journal-content-input');
        if (!editor) return;

        const update = () => {
            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0) return;
            const range = sel.getRangeAt(0);
            if (!editor.contains(range.startContainer)) return;
            // Walk up to the direct child of the editor — that's the
            // "block" we highlight. (Skips inline parents like <strong>.)
            let n = range.startContainer.nodeType === Node.TEXT_NODE
                ? range.startContainer.parentNode
                : range.startContainer;
            while (n && n.parentNode !== editor) {
                n = n.parentNode;
                if (!n) return;
            }
            if (!n) return;
            // Apply class to this block, remove from siblings.
            for (const child of editor.children) {
                child.classList.toggle('is-focused', child === n);
            }
        };

        // Replace any prior handler.
        if (this._paragraphTrackerHandler) {
            document.removeEventListener('selectionchange', this._paragraphTrackerHandler);
        }
        this._paragraphTrackerHandler = update;
        document.addEventListener('selectionchange', update);

        // Initial tick so the first block lights up immediately.
        setTimeout(update, 0);
    },

    /**
     * Close editor and return to journal list
     */
    closeEditor() {
        // Save before closing
        this.saveCurrentEntry(true);

        // Destroy rich editor
        RichEditor.destroy();

        // Tear down the per-open paragraph tracker so it doesn't keep
        // firing against a torn-down editor. Focus-mode key listener is
        // global and stays bound (guarded by view-active check inside).
        if (this._paragraphTrackerHandler) {
            document.removeEventListener('selectionchange', this._paragraphTrackerHandler);
            this._paragraphTrackerHandler = null;
        }

        if (typeof TagPicker !== 'undefined') TagPicker.close();

        document.getElementById('journal-editor-view').classList.remove('active');
        document.getElementById('journal-view').classList.add('active');
        this.currentEntryId = null;
        this.render();
    },

    /**
     * Render tags in editor
     */
    renderEditorTags(tags = []) {
        const container = document.getElementById('journal-tags-container');
        const addBtn = document.getElementById('journal-tag-add-btn');

        // Clear existing tags; keep the add button + hidden input
        container.querySelectorAll('.tag-item').forEach(tag => tag.remove());

        tags.forEach(tag => {
            const tagElement = this._buildTagPill(tag);
            container.insertBefore(tagElement, addBtn);
        });
    },

    _buildTagPill(tag) {
        const el = document.createElement('span');
        el.className = 'tag-item';
        el.innerHTML = `
            ${UIUtils.escapeHtml(tag)}
            <button class="tag-remove" data-tag="${UIUtils.escapeHtml(tag)}">×</button>
        `;
        el.querySelector('.tag-remove').addEventListener('click', () => {
            el.remove();
        });
        return el;
    },

    /**
     * Wire the "+ Add tag" button to TagPicker. Suggestions = union of all
     * tag names already used across journal entries, so the user can
     * recall or coin tags consistently.
     */
    setupEditorTagsInput() {
        const addBtn = document.getElementById('journal-tag-add-btn');
        const tagsContainer = document.getElementById('journal-tags-container');
        if (!addBtn || !tagsContainer) return;
        const newBtn = addBtn.cloneNode(true);
        addBtn.parentNode.replaceChild(newBtn, addBtn);

        newBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (typeof TagPicker === 'undefined') return;
            const suggestions = this._getAllJournalTags();
            const selected = Array.from(tagsContainer.querySelectorAll('.tag-item'))
                .map(el => (el.firstChild?.textContent || '').trim())
                .filter(Boolean);
            TagPicker.open({
                anchor: newBtn,
                suggestions,
                selected,
                placeholder: 'Search or create…',
                onAdd: (name) => {
                    const trimmed = String(name || '').trim();
                    if (!trimmed) return;
                    if (selected.includes(trimmed)) return;
                    tagsContainer.insertBefore(this._buildTagPill(trimmed), newBtn);
                    selected.push(trimmed);
                }
            });
        });
    },

    _getAllJournalTags() {
        const set = new Set();
        for (const e of this.entries) {
            (e.tags || []).forEach(t => { if (t) set.add(t); });
        }
        return Array.from(set).sort((a, b) => a.localeCompare(b));
    },

    /**
     * Render mood selector
     * @param {string} selectedMood
     * @returns {string} HTML
     */
    renderMoodSelector(selectedMood) {
        const moods = [
            { value: 'amazing', icon: '😄', label: 'Amazing' },
            { value: 'happy', icon: '😊', label: 'Happy' },
            { value: 'neutral', icon: '😐', label: 'Neutral' },
            { value: 'sad', icon: '😢', label: 'Sad' },
            { value: 'stressed', icon: '😰', label: 'Stressed' }
        ];

        return moods.map(mood => `
            <div class="mood-option ${mood.value === selectedMood ? 'selected' : ''}" data-mood="${mood.value}">
                <span class="mood-option-icon">${mood.icon}</span>
                <span class="mood-option-label">${mood.label}</span>
            </div>
        `).join('');
    },

    /**
     * Render a tag
     * @param {string} tag
     * @returns {string} HTML
     */
    renderTag(tag) {
        return `
            <span class="tag-item">
                ${UIUtils.escapeHtml(tag)}
                <button class="tag-remove" data-tag="${UIUtils.escapeHtml(tag)}">×</button>
            </span>
        `;
    },

    /**
     * Save current entry
     */
    saveCurrentEntry(silent = false) {
        const dateString = document.getElementById('journal-date-input').value;
        const content = RichEditor.getHTML().trim();
        // Mood is held in component state by _setEditorMood(); the
        // popover may not be open at save time, so we don't read DOM.
        const mood = this._currentMood || 'neutral';
        const tags = Array.from(document.querySelectorAll('#journal-tags-container .tag-item'))
            .map(tag => tag.textContent.replace('×', '').trim());
        const profile = ProfileManager.getProfileForNewItem();

        if (!content || content === '<p></p>' || content === '<br>') {
            UIUtils.showToast('Please write something', 'error');
            return;
        }

        // Convert date string to local date at noon to avoid timezone issues
        const [year, month, day] = dateString.split('-').map(Number);
        const localDate = new Date(year, month - 1, day, 12, 0, 0);
        const date = localDate.toISOString();

        if (this.currentEntryId) {
            // Update existing entry
            this.updateEntry(this.currentEntryId, { date, content, mood, tags, profile });
            if (!silent) {
                this.updateSaveStatus('saved');
                UIUtils.showToast('Entry updated', 'success');
            }
        } else {
            // Create new entry only if there's content
            if (content && content !== '<p></p>' && content !== '<br>') {
                const newEntry = this.createEntry({ date, content, mood, tags, profile });
                this.currentEntryId = newEntry.id;
                // In diary mode, open the book to the newly-created entry
                this.diaryIndex = 0;
                this.diaryOpen = true;
                if (!silent) {
                    this.updateSaveStatus('saved');
                    UIUtils.showToast('Entry created', 'success');
                }
            }
        }

        if (!silent) {
            this.closeEditor();
        }
    },

    /**
     * Delete current entry
     */
    async deleteCurrentEntry() {
        if (!this.currentEntryId) return;

        const confirmed = await UIUtils.confirm(
            'Delete Entry',
            'Are you sure you want to delete this journal entry?',
            '🗑️'
        );

        if (confirmed) {
            const deletedId = this.currentEntryId;
            this.entries = this.entries.filter(e => e.id !== deletedId);
            this.saveEntries();
            if (typeof JournalUI !== 'undefined' && JournalUI.invalidatePaginationCache) {
                JournalUI.invalidatePaginationCache(deletedId);
            }
            this.contentPage = 0;
            UIUtils.showToast('Entry deleted', 'success');

            // Close both viewer and editor, return to journal list
            document.getElementById('journal-viewer-view').classList.remove('active');
            document.getElementById('journal-editor-view').classList.remove('active');
            document.getElementById('journal-view').classList.add('active');
            this.currentEntryId = null;
            this.render();
        }
    },



    /**
     * Render entries
     */
    render() {
        Breadcrumb.render('journal-breadcrumb', [
            { label: 'Journal' }
        ]);
        JournalUI.render(this.getFilteredEntries());
    }
};

// Register app
AppManager.register('journal', JournalApp);

// AgentContext provider — exposes the currently-open journal entry. The
// content is user-authored, so it's trusted (unlike Browse / Email).
// Returns null on the list view; the agent's global briefing already
// summarizes recent journal activity, so we only inject the full text
// when the user is actively reading or writing one entry.
if (typeof AgentContext !== 'undefined') {
    AgentContext.register('journal', () => {
        const id = JournalApp.currentEntryId;
        if (!id) return null;
        const entry = (JournalApp.entries || []).find(e => e && e.id === id);
        if (!entry) return null;

        const plain = String(entry.content || '')
            .replace(/<\/?(p|div|br|h[1-6]|li)[^>]*>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        const tags = (entry.tags || []).join(', ');
        return {
            recordKey: 'journal:' + entry.id,
            recordLabel: entry.date || 'Journal entry',
            title: 'CURRENT JOURNAL ENTRY',
            body: `The user is viewing or writing the journal entry below. The entry is available as context, not a constraint:

- When the user's question or instruction refers to "this entry", "the entry", "what I wrote", etc., work with the text below. (You can read and create journal entries via tools, but editing the current entry happens in the editor — suggest changes in chat and let the user apply them.)
- For general questions, answer normally without pivoting back to the entry.

Date: ${entry.date || 'unknown'}
Mood: ${entry.mood || 'not set'}
Tags: ${tags || 'none'}

Content:
${plain || '(empty)'}`,
            suggestedPrompts: [
                'What is the main theme here?',
                'Reflect on this entry',
                'Suggest a follow-up question to explore'
            ]
        };
    });
}
