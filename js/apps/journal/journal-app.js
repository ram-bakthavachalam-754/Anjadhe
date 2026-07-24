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

    // Three-pane runtime state: whether an editor session is live in the
    // right pane (drives teardown when switching entries).
    _paneSessionActive: false,

    /**
     * Initialize the journal app
     */
    init() {
        this.loadEntries();
        this.setupEventListeners();
        this._setupLinkHandler();
        this._bindGlobalKeys();

        // The always-editable entry host is declared at top level in
        // index.html; adopt it into the third pane on first init.
        const pane = document.getElementById('journal-entry-pane');
        const host = document.getElementById('journal-editor-view');
        if (pane && host && host.parentElement !== pane) pane.appendChild(host);

        NavResizer.attach({
            layoutSel: '#journal-view .journal-layout',
            resizerId: 'journal-nav-resizer',
            cssVar: '--journal-nav-width',
            storageKey: 'journal-nav-width',
            defaultW: 188,
        });
        NavResizer.attach({
            layoutSel: '#journal-view .journal-layout',
            resizerId: 'journal-list-resizer',
            cssVar: '--journal-list-width',
            storageKey: 'journal-list-width',
            defaultW: 300,
            min: 220,
            max: 480,
        });

        // Re-entering the app (init runs on every openApp): re-load the
        // selected entry from storage, or clear if it's gone.
        if (this.currentEntryId) {
            if (this.entries.some(e => e.id === this.currentEntryId)) {
                this._loadEntryIntoPane(this.currentEntryId);
            } else {
                this._clearSelection();
            }
        }
        this.render();
    },

    // Anchor handling inside the editable entry: external links open in
    // the in-app Browse tab on Cmd/Ctrl+click (a plain click keeps the
    // caret for editing). Document-level and wired once.
    _setupLinkHandler() {
        if (this._linkHandlerWired) return;
        this._linkHandlerWired = true;
        document.addEventListener('click', (e) => {
            const a = e.target && e.target.closest && e.target.closest('#journal-editor-view a[href]');
            if (!a) return;
            const href = a.getAttribute('href');
            if (!href || !/^https?:/i.test(href)) return;
            if (!(e.metaKey || e.ctrlKey)) return;
            e.preventDefault();
            const entryId = this.currentEntryId;
            if (typeof AppManager !== 'undefined' && AppManager.openInBrowse) {
                AppManager.openInBrowse(href, {
                    label: 'Back to Journal',
                    onBack: () => {
                        AppManager.openApp('journal');
                        if (entryId) setTimeout(() => this.openEditor(entryId), 60);
                    }
                });
            } else if (window.electronAuth?.openExternal) {
                window.electronAuth.openExternal(href);
            }
        });
    },

    // Cmd/Ctrl+F focuses the timeline search whenever Journal is the open
    // app — mirrors Notes and Actions.
    _bindGlobalKeys() {
        if (this._globalKeysWired) return;
        this._globalKeysWired = true;
        document.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey
                && e.key.toLowerCase() === 'f' && AppManager.currentApp === 'journal') {
                e.preventDefault();
                const s = document.getElementById('journal-search');
                if (s) { s.focus(); s.select(); }
            }
        });
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

        // Search input — as-you-type, with keyboard navigation through
        // the timeline rows (Arrow keys + Enter, Escape clears).
        const searchInput = document.getElementById('journal-search');
        const newSearchInput = searchInput.cloneNode(true);
        searchInput.parentNode.replaceChild(newSearchInput, searchInput);
        newSearchInput.addEventListener('input', UIUtils.debounce((e) => {
            this.searchQuery = e.target.value.toLowerCase();
            this.render();
        }, 200));
        newSearchInput.addEventListener('keydown', (e) => this._searchKeydown(e, newSearchInput));

        // Quick capture — Enter creates today's entry seeded with the line
        // and drops the caret into its body.
        const capture = document.getElementById('journal-capture');
        if (capture) {
            const newCapture = capture.cloneNode(true);
            capture.parentNode.replaceChild(newCapture, capture);
            newCapture.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                const text = newCapture.value.trim();
                if (!text) return;
                e.preventDefault();
                const entry = this.createEntry({
                    content: `<p>${UIUtils.escapeHtml(text)}</p>`,
                });
                newCapture.value = '';
                this.openEditor(entry.id);
            });
        }

        // Pane header buttons.
        const replaceBtn = (id, handler) => {
            const el = document.getElementById(id);
            if (!el) return null;
            const fresh = el.cloneNode(true);
            el.parentNode.replaceChild(fresh, el);
            fresh.addEventListener('click', handler);
            return fresh;
        };
        replaceBtn('journal-editor-delete-btn', () => this.deleteCurrentEntry());
        replaceBtn('journal-photo-btn', () => document.getElementById('journal-photo-input')?.click());
        replaceBtn('journal-video-btn', () => document.getElementById('journal-video-input')?.click());
        this._setupMediaCapture();
    },

    /**
     * Arrow keys walk the timeline from the search box; Enter opens the
     * row under the cursor (or the first result); Escape clears.
     */
    _searchKeydown(e, input) {
        if (e.key === 'Escape') {
            input.value = '';
            this.searchQuery = '';
            input.blur();
            this.render();
            return;
        }
        const rows = Array.from(document.querySelectorAll('#journal-container .journal-entry'));
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
            if (row) this.openEditor(row.dataset.entryId);
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
            const gone = this.entries.find(e => e.id === id);
            this.entries = this.entries.filter(e => e.id !== id);
            this.saveEntries();
            if (gone) this._gcMedia(gone.content);
            if (this.currentEntryId === id) {
                this.hasUnsavedChanges = false;
                this._clearSelection();
            } else {
                this.render();
            }
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
     * Legacy entry point (deep links, cross-app rows) — the viewer is
     * gone; everything opens in the editable pane.
     */
    openViewer(entryId) {
        if (!entryId) return;
        this.openEditor(entryId);
    },

    closeViewer() {
        this.closeEditor();
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
     * Open an entry in the always-editable pane (or start a new draft
     * when `entryId` is null). Ensures the Journal app is the active
     * view first, so cross-app callers land correctly.
     */
    openEditor(entryId = null) {
        if (typeof AppManager !== 'undefined' && AppManager.currentApp !== 'journal') {
            AppManager.openApp('journal', false);
        }
        this._loadEntryIntoPane(entryId);
    },

    _loadEntryIntoPane(entryId = null) {
        // Flush the outgoing session before swapping entries.
        if (this._paneSessionActive && this.hasUnsavedChanges) this.saveCurrentEntry(true);
        this._teardownEntrySession();

        this.currentEntryId = entryId;
        this._currentMood = 'neutral';
        this._paneSessionActive = true;

        const host = document.getElementById('journal-editor-view');
        const emptyState = document.getElementById('journal-entry-empty');
        if (host) host.hidden = false;
        if (emptyState) emptyState.hidden = true;

        AppManager.setDetailHash('journal', entryId ? 'view' : null, entryId || null);
        const entry = entryId ? this.entries.find(e => e.id === entryId) : null;
        JournalUI.updateSelection();

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
        // the (visually hidden) native date picker. Clone the input so
        // listeners can't stack across pane loads.
        const oldDateInput = document.getElementById('journal-date-input');
        const dateInput = oldDateInput.cloneNode(true);
        oldDateInput.parentNode.replaceChild(dateInput, oldDateInput);
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
            this.autoSave();
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

        // Load entry data if editing. Media elements are stored "dry"
        // (src stripped, bytes in their own storage keys) — hydrate on
        // the way in.
        if (entryId && entry) {
            dateInput.value = this.getLocalDateString(new Date(entry.date));
            RichEditor.setHTML(this._hydrateMediaHtml(entry.content));
            this._setEditorMood(entry.mood || 'neutral');
            this.renderEditorTags(entry.tags || []);
        } else {
            dateInput.value = this.getLocalDateString();
            RichEditor.clear();
            this._setEditorMood('neutral');
            this.renderEditorTags([]);
        }
        // Render the friendly date label now that the value is set.
        if (this._renderDateLabel) this._renderDateLabel();

        // Wire up the mood popover, tags input, and maximize toggle.
        this._setupMoodPopover();
        this.setupEditorTagsInput();
        this._setupFocusMode();

        // Reset save dot
        this.updateSaveStatus('saved');

        // Scroll the pane back to the top and focus the writing surface.
        const paneEl = document.getElementById('journal-entry-pane');
        if (paneEl) paneEl.scrollTop = 0;
        window.scrollTo({ top: 0 });
        setTimeout(() => {
            document.getElementById('journal-content-input')?.focus({ preventScroll: true });
        }, 100);
    },

    /**
     * Tear down the live editor session. Does NOT save — callers flush
     * first when they need to.
     */
    _teardownEntrySession() {
        if (!this._paneSessionActive) return;
        RichEditor.destroy();
        if (typeof TagPicker !== 'undefined') TagPicker.close();
        const pop = document.getElementById('journal-mood-popover');
        if (pop) pop.hidden = true;
        this._paneSessionActive = false;
    },

    _clearSelection() {
        this._teardownEntrySession();
        this.currentEntryId = null;
        this.hasUnsavedChanges = false;

        const host = document.getElementById('journal-editor-view');
        if (host) host.hidden = true;
        const emptyState = document.getElementById('journal-entry-empty');
        if (emptyState) emptyState.hidden = false;
        document.getElementById('journal-view')?.classList.remove('journal-maximized');

        AppManager.setDetailHash('journal', null, null);
        if (AppManager.currentApp === 'journal') this.render();
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
            this.autoSave();
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
     * Maximize toggle (the ⛶ button, or F): the nav + timeline columns
     * give way so the entry takes the full frame. Pure layout — no
     * dimming (matches the Notes behavior).
     */
    _setupFocusMode() {
        const btn = document.getElementById('journal-focus-mode-btn');
        const view = document.getElementById('journal-view');
        if (!btn || !view) return;

        const fresh = btn.cloneNode(true);
        btn.parentNode.replaceChild(fresh, btn);
        const sync = () => {
            const on = view.classList.contains('journal-maximized');
            fresh.setAttribute('aria-pressed', on ? 'true' : 'false');
            fresh.classList.toggle('is-active', on);
        };
        fresh.addEventListener('click', () => {
            view.classList.toggle('journal-maximized');
            sync();
        });
        sync();

        // F toggles when not typing.
        if (!this._focusModeKeyBound) {
            this._focusModeKeyBound = true;
            document.addEventListener('keydown', (e) => {
                if (e.key !== 'f' && e.key !== 'F') return;
                if (e.metaKey || e.ctrlKey || e.altKey) return;
                if (AppManager.currentApp !== 'journal' || !this._paneSessionActive) return;
                const t = e.target;
                if (t && (t.matches('input, textarea, select') || t.isContentEditable)) return;
                e.preventDefault();
                document.getElementById('journal-view')?.classList.toggle('journal-maximized');
                const b = document.getElementById('journal-focus-mode-btn');
                if (b) {
                    const on = document.getElementById('journal-view').classList.contains('journal-maximized');
                    b.setAttribute('aria-pressed', on ? 'true' : 'false');
                    b.classList.toggle('is-active', on);
                }
            });
        }
    },

    /**
     * Deselect the open entry: save, tear the session down, show the
     * empty pane.
     */
    closeEditor() {
        if (this._paneSessionActive) this.saveCurrentEntry(true);
        this._clearSelection();
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
            this.markAsUnsaved();
            this.autoSave();
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
                    this.markAsUnsaved();
                    this.autoSave();
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
     * Save current entry. Media elements go into storage "dry" — src
     * stripped, bytes living in their own journalMedia_<id> keys — so
     * the entries blob stays light no matter how many photos ride along.
     */
    saveCurrentEntry(silent = true) {
        if (!this._paneSessionActive) return;
        const dateString = document.getElementById('journal-date-input').value;
        // Read our own element rather than RichEditor.getHTML() —
        // RichEditor is a singleton shared with Notes, and a late save
        // timer must never read whichever surface it is bound to now.
        const editorEl = document.getElementById('journal-content-input');
        const content = this._dehydrateMediaHtml((editorEl ? editorEl.innerHTML : '').trim());
        // Mood is held in component state by _setEditorMood(); the
        // popover may not be open at save time, so we don't read DOM.
        const mood = this._currentMood || 'neutral';
        const tags = Array.from(document.querySelectorAll('#journal-tags-container .tag-item'))
            .map(tag => tag.textContent.replace('×', '').trim());
        const profile = ProfileManager.getProfileForNewItem();

        const empty = !content || content === '<p></p>' || content === '<br>';

        // Convert date string to local date at noon to avoid timezone issues
        const [year, month, day] = (dateString || this.getLocalDateString()).split('-').map(Number);
        const localDate = new Date(year, month - 1, day, 12, 0, 0);
        const date = localDate.toISOString();

        if (this.currentEntryId) {
            this.updateEntry(this.currentEntryId, { date, content, mood, tags, profile });
        } else if (!empty) {
            // A draft becomes a real entry on its first non-empty save.
            const newEntry = this.createEntry({ date, content, mood, tags, profile });
            this.currentEntryId = newEntry.id;
        } else {
            return; // empty draft — nothing to persist yet
        }

        if (AppManager.currentApp === 'journal' && this.currentEntryId) {
            AppManager.setDetailHash('journal', 'view', this.currentEntryId);
        }
        this._renderListSoon();
        if (!silent) this.updateSaveStatus('saved');
    },

    /**
     * Debounced list refresh — autosave fires every second while typing.
     */
    _renderListSoon() {
        if (this._listRefreshTimer) clearTimeout(this._listRefreshTimer);
        this._listRefreshTimer = setTimeout(() => {
            this._listRefreshTimer = null;
            if (AppManager.currentApp === 'journal') this.render();
        }, 400);
    },

    /**
     * Delete current entry
     */
    async deleteCurrentEntry() {
        if (!this.currentEntryId) return;
        this.deleteEntry(this.currentEntryId);
    },

    // ============================================================
    // Media — photos and videos inside entries.
    //
    // Bytes live OUTSIDE the entries blob, one StorageManager key per
    // item (journalMedia_<id>), so they sync across Macs exactly once
    // and the per-keystroke autosave never rewrites megabytes. Entry
    // content keeps only <img|video data-media="id"> markers; src is
    // hydrated on load and stripped on save.
    // ============================================================

    IMAGE_MAX_DIM: 1600,       // longest edge after downscale
    IMAGE_QUALITY: 0.82,       // JPEG quality
    THUMB_MAX_DIM: 240,        // list-row thumbnail
    VIDEO_MAX_BYTES: 25 * 1024 * 1024,

    _setupMediaCapture() {
        const wireInput = (id, handler) => {
            const el = document.getElementById(id);
            if (!el) return;
            const fresh = el.cloneNode(true);
            el.parentNode.replaceChild(fresh, el);
            fresh.addEventListener('change', () => {
                handler(Array.from(fresh.files || []));
                fresh.value = '';
            });
        };
        wireInput('journal-photo-input', (files) => this._addImageFiles(files));
        wireInput('journal-video-input', (files) => files[0] && this._addVideoFile(files[0]));

        // Paste + drag-drop onto the writing surface. Capture phase so the
        // image path outruns RichEditor's own paste handler (which only
        // understands text). Bound once — the editor element persists.
        const editor = document.getElementById('journal-content-input');
        if (!editor || editor.dataset.mediaBound) return;
        editor.dataset.mediaBound = 'true';

        editor.addEventListener('paste', (e) => {
            const files = Array.from(e.clipboardData?.files || [])
                .filter(f => f.type.startsWith('image/'));
            if (!files.length) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            this._addImageFiles(files);
        }, true);

        editor.addEventListener('dragover', (e) => {
            if (Array.from(e.dataTransfer?.items || []).some(i => i.kind === 'file')) {
                e.preventDefault();
            }
        });
        editor.addEventListener('drop', (e) => {
            const files = Array.from(e.dataTransfer?.files || []);
            if (!files.length) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            const images = files.filter(f => f.type.startsWith('image/'));
            const videos = files.filter(f => f.type.startsWith('video/'));
            if (images.length) this._addImageFiles(images);
            if (videos.length) this._addVideoFile(videos[0]);
        }, true);
    },

    async _addImageFiles(files) {
        if (!this._paneSessionActive) return;
        for (const file of files) {
            if (!file.type.startsWith('image/')) continue;
            try {
                const { data, thumb } = await this._downscaleImage(file);
                const id = this._storeMedia({ kind: 'image', type: 'image/jpeg', data, thumb });
                this._insertMediaElement('img', id, data);
            } catch (err) {
                console.warn('[journal] image import failed:', err);
                UIUtils.showToast('Could not add that image', 'error');
            }
        }
    },

    async _addVideoFile(file) {
        if (!this._paneSessionActive || !file) return;
        if (!/^video\/(mp4|webm)$/i.test(file.type)) {
            UIUtils.showToast('Videos must be mp4 or webm', 'error');
            return;
        }
        if (file.size > this.VIDEO_MAX_BYTES) {
            UIUtils.showToast(`Video too large — keep it under ${Math.round(this.VIDEO_MAX_BYTES / 1024 / 1024)}MB`, 'error');
            return;
        }
        try {
            const data = await this._fileToDataUri(file);
            const id = this._storeMedia({ kind: 'video', type: file.type, data, thumb: null });
            this._insertMediaElement('video', id, data);
        } catch (err) {
            console.warn('[journal] video import failed:', err);
            UIUtils.showToast('Could not add that video', 'error');
        }
    },

    _fileToDataUri(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = () => reject(r.error);
            r.readAsDataURL(file);
        });
    },

    /** Downscale to IMAGE_MAX_DIM (JPEG) + a small thumb for list rows. */
    async _downscaleImage(file) {
        const raw = await this._fileToDataUri(file);
        const img = await new Promise((resolve, reject) => {
            const i = new Image();
            i.onload = () => resolve(i);
            i.onerror = () => reject(new Error('unreadable image'));
            i.src = raw;
        });
        const scaleTo = (maxDim, quality) => {
            const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
            const w = Math.max(1, Math.round(img.width * scale));
            const h = Math.max(1, Math.round(img.height * scale));
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            return canvas.toDataURL('image/jpeg', quality);
        };
        return {
            data: scaleTo(this.IMAGE_MAX_DIM, this.IMAGE_QUALITY),
            thumb: scaleTo(this.THUMB_MAX_DIM, 0.7),
        };
    },

    _storeMedia(media) {
        const id = UIUtils.generateId();
        StorageManager.set(`journalMedia_${id}`, { id, createdAt: new Date().toISOString(), ...media });
        return id;
    },

    _getMedia(id) {
        return StorageManager.get(`journalMedia_${id}`);
    },

    /** Insert an <img>/<video> at the caret (or append) and persist. */
    _insertMediaElement(tag, mediaId, src) {
        const editor = document.getElementById('journal-content-input');
        if (!editor) return;
        const el = document.createElement(tag);
        el.setAttribute('data-media', mediaId);
        el.src = src;
        if (tag === 'video') {
            el.controls = true;
            el.preload = 'metadata';
        }

        const sel = window.getSelection();
        if (sel && sel.rangeCount && editor.contains(sel.getRangeAt(0).startContainer)) {
            const range = sel.getRangeAt(0);
            range.collapse(false);
            range.insertNode(el);
            const after = document.createRange();
            after.setStartAfter(el);
            after.collapse(true);
            sel.removeAllRanges();
            sel.addRange(after);
        } else {
            editor.appendChild(el);
        }
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        this.markAsUnsaved();
        this.autoSave();
    },

    /** Resolve data-media markers back to playable/viewable src. */
    _hydrateMediaHtml(html) {
        if (!html || !html.includes('data-media')) return html;
        const wrap = document.createElement('div');
        wrap.innerHTML = html;
        wrap.querySelectorAll('[data-media]').forEach(el => {
            const media = this._getMedia(el.getAttribute('data-media'));
            if (media && media.data) {
                el.setAttribute('src', media.data);
                el.classList.remove('is-media-missing');
            } else {
                // Bytes not on this Mac yet (sync in flight) — mark as
                // pending rather than showing a broken element.
                el.removeAttribute('src');
                el.classList.add('is-media-missing');
            }
            if (el.tagName === 'VIDEO') el.setAttribute('controls', '');
        });
        return wrap.innerHTML;
    },

    /** Strip media bytes before persisting entry content. */
    _dehydrateMediaHtml(html) {
        if (!html || !html.includes('data-media')) return html;
        const wrap = document.createElement('div');
        wrap.innerHTML = html;
        wrap.querySelectorAll('[data-media]').forEach(el => {
            el.removeAttribute('src');
            el.classList.remove('is-media-missing');
            if (el.getAttribute('class') === '') el.removeAttribute('class');
        });
        return wrap.innerHTML;
    },

    /** Media ids referenced by a chunk of entry HTML. */
    _mediaIdsIn(html) {
        const ids = [];
        const re = /data-media="([^"]+)"/g;
        let m;
        while ((m = re.exec(html || ''))) ids.push(m[1]);
        return ids;
    },

    /** Drop media keys no longer referenced by any entry. */
    _gcMedia(deletedContent) {
        const ids = this._mediaIdsIn(deletedContent);
        if (!ids.length) return;
        const stillUsed = new Set();
        for (const e of this.entries) {
            for (const id of this._mediaIdsIn(e.content)) stillUsed.add(id);
        }
        for (const id of ids) {
            if (!stillUsed.has(id)) StorageManager.clear(`journalMedia_${id}`);
        }
    },

    /**
     * Render entries
     */
    render() {
        Breadcrumb.render('journal-breadcrumb', [
            { label: 'Journal', action: () => { if (this._paneSessionActive) this.closeEditor(); } }
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
