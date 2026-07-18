/**
 * Notes UI - Rendering with Tag System
 */

const NotesUI = {
    /**
     * Render notes list with sidebar
     * @param {Array} notes - Notes to render
     * @param {Array} tags - Available tags
     * @param {string} currentFilter - Current filter
     */
    render(notes, tags, currentFilter) {
        this.renderSidebar(ProfileManager.filterByActiveProfile(NotesApp.notes), tags, currentFilter);
        this.renderNotes(notes, tags);
    },

    /**
     * Render sidebar: filters, tags, stats
     */
    renderSidebar(allNotes, tags, currentFilter) {
        this.renderFilters(allNotes, currentFilter);
        this.renderTagFilters(allNotes, tags, currentFilter);
        this.renderStats(allNotes);
    },

    /**
     * Render main filter list (All, Pinned, On Home)
     */
    renderFilters(notes, currentFilter) {
        const container = document.getElementById('notes-filter-list');
        if (!container) return;

        const pinnedCount = notes.filter(n => n.pinned).length;
        const homeCount = notes.filter(n => n.showOnHome).length;
        const promptCount = notes.filter(n => NotePrompts.isPrompt(n)).length;
        const assistantCount = notes.filter(n => NoteTemplates.resolve(n) === 'assistant').length;
        const feedCount = notes.filter(n => NoteTemplates.resolve(n) === 'feed').length;

        container.innerHTML = `
            <div class="notes-filter-item ${currentFilter === 'all' ? 'active' : ''}" data-filter="all">
                <span class="notes-filter-name">All Notes</span>
                <span class="notes-filter-count">${notes.length - feedCount}</span>
            </div>
            ${promptCount > 0 ? `
                <div class="notes-filter-item ${currentFilter === 'prompt' ? 'active' : ''}" data-filter="prompt">
                    <span class="notes-filter-name">Prompts</span>
                    <span class="notes-filter-count">${promptCount}</span>
                </div>
            ` : ''}
            ${feedCount > 0 ? `
                <div class="notes-filter-item ${currentFilter === 'feed' ? 'active' : ''}" data-filter="feed">
                    <span class="notes-filter-name">Prompt Feed</span>
                    <span class="notes-filter-count">${feedCount}</span>
                </div>
            ` : ''}
            ${assistantCount > 0 ? `
                <div class="notes-filter-item ${currentFilter === 'assistant' ? 'active' : ''}" data-filter="assistant">
                    <span class="notes-filter-name">AI Assistant</span>
                    <span class="notes-filter-count">${assistantCount}</span>
                </div>
            ` : ''}
            ${pinnedCount > 0 ? `
                <div class="notes-filter-item ${currentFilter === 'pinned' ? 'active' : ''}" data-filter="pinned">
                    <span class="notes-filter-name">Pinned</span>
                    <span class="notes-filter-count">${pinnedCount}</span>
                </div>
            ` : ''}
            ${homeCount > 0 ? `
                <div class="notes-filter-item ${currentFilter === 'on-home' ? 'active' : ''}" data-filter="on-home">
                    <span class="notes-filter-name">On Home</span>
                    <span class="notes-filter-count">${homeCount}</span>
                </div>
            ` : ''}
        `;

        if (!container.dataset.bound) {
            container.dataset.bound = 'true';
            container.addEventListener('click', (e) => {
                const item = e.target.closest('.notes-filter-item');
                if (!item) return;
                NotesApp.currentFilter = item.dataset.filter;
                NotesApp.render();
            });
        }
    },

    /**
     * Render tag filter list
     */
    renderTagFilters(notes, tags, currentFilter) {
        const container = document.getElementById('notes-tag-filter-list');
        if (!container) return;

        const tagCounts = {};
        notes.forEach(note => {
            if (note.tags) {
                note.tags.forEach(tagName => {
                    tagCounts[tagName] = (tagCounts[tagName] || 0) + 1;
                });
            }
        });

        // Feed posts are hidden from the untagged bucket (see
        // NotesApp.getFilteredNotes), so keep them out of its count too.
        const untaggedCount = notes.filter(n => (!n.tags || n.tags.length === 0)
            && NoteTemplates.resolve(n) !== 'feed').length;

        // Show all tags — including those with zero notes, so newly created
        // tags are immediately discoverable. Sort: most-used first, then
        // alphabetical, so unused tags sink to the bottom without hiding.
        const sortedTags = [...tags].sort((a, b) => {
            const diff = (tagCounts[b.name] || 0) - (tagCounts[a.name] || 0);
            if (diff !== 0) return diff;
            return a.name.localeCompare(b.name);
        });
        container.innerHTML = sortedTags.map(tag => {
            const count = tagCounts[tag.name] || 0;
            const safeName = UIUtils.escapeHtml(tag.name);
            return `
            <div class="notes-filter-item notes-tag-filter-row ${currentFilter === tag.name ? 'active' : ''}" data-filter="${safeName}" data-tag-id="${tag.id}">
                <span class="notes-filter-name">${safeName}</span>
                <span class="notes-filter-count">${count}</span>
                <div class="notes-tag-actions">
                    <button class="notes-tag-action" data-tag-action="edit" data-tag-id="${tag.id}" title="Rename tag" aria-label="Rename tag">&#9998;</button>
                    <button class="notes-tag-action" data-tag-action="delete" data-tag-id="${tag.id}" title="Delete tag" aria-label="Delete tag">&times;</button>
                </div>
            </div>
        `;
        }).join('') + (untaggedCount > 0 ? `
            <div class="notes-filter-item ${currentFilter === 'untagged' ? 'active' : ''}" data-filter="untagged">
                <span class="notes-filter-name">Untagged</span>
                <span class="notes-filter-count">${untaggedCount}</span>
            </div>
        ` : '');

        if (!container.dataset.bound) {
            container.dataset.bound = 'true';
            container.addEventListener('click', (e) => {
                const actionBtn = e.target.closest('[data-tag-action]');
                if (actionBtn) {
                    e.stopPropagation();
                    const tagId = actionBtn.dataset.tagId;
                    if (actionBtn.dataset.tagAction === 'edit') {
                        const tag = NotesApp.tags.find(t => t.id === tagId);
                        if (tag) NotesApp.showTagForm(tag);
                    } else if (actionBtn.dataset.tagAction === 'delete') {
                        NotesApp.deleteTag(tagId);
                    }
                    return;
                }
                const item = e.target.closest('.notes-filter-item');
                if (!item) return;
                NotesApp.currentFilter = item.dataset.filter;
                NotesApp.render();
            });
        }
    },

    /**
     * Render stats section
     */
    renderStats(notes) {
        const container = document.getElementById('notes-stats');
        if (!container) return;

        const totalNotes = notes.length;
        const totalTags = new Set(notes.flatMap(n => n.tags || [])).size;

        // Recently modified (last 7 days)
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const recentCount = notes.filter(n => new Date(n.modifiedAt) >= weekAgo).length;

        container.innerHTML = `
            <div class="notes-stat">
                <span class="notes-stat-value">${totalNotes}</span>
                <span class="notes-stat-label">Total notes</span>
            </div>
            <div class="notes-stat">
                <span class="notes-stat-value">${recentCount}</span>
                <span class="notes-stat-label">Modified this week</span>
            </div>
            <div class="notes-stat">
                <span class="notes-stat-value">${totalTags}</span>
                <span class="notes-stat-label">Tags in use</span>
            </div>
        `;
    },

    /**
     * Render notes in current view mode
     * @param {Array} notes - Notes to render
     * @param {Array} tags - Available tags
     */
    renderNotes(notes, tags) {
        const container = document.getElementById('notes-container');
        const emptyState = document.getElementById('notes-empty');

        // Update view toggle active state
        this.updateViewToggle();

        if (notes.length === 0) {
            container.style.display = 'none';
            emptyState.style.display = 'block';
            return;
        }

        emptyState.style.display = 'none';

        if (NotesApp.viewMode === 'list') {
            container.style.display = 'flex';
            container.className = 'notes-list';
            container.innerHTML = notes.map(note => this.renderNoteListItem(note, tags)).join('');
        } else {
            container.style.display = 'grid';
            container.className = 'notes-grid';
            container.innerHTML = notes.map(note => this.renderNoteCard(note, tags)).join('');
        }

        this.attachEventListeners();
    },

    /**
     * Update view toggle button states
     */
    updateViewToggle() {
        const toggle = document.getElementById('notes-view-toggle');
        if (!toggle) return;

        toggle.querySelectorAll('.notes-view-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === NotesApp.viewMode);
        });

        if (!toggle.dataset.bound) {
            toggle.dataset.bound = 'true';
            toggle.addEventListener('click', (e) => {
                const btn = e.target.closest('.notes-view-btn');
                if (!btn || btn.dataset.view === NotesApp.viewMode) return;
                NotesApp.viewMode = btn.dataset.view;
                NotesApp.saveViewMode();
                NotesApp.render();
            });
        }
    },

    /**
     * Render a single note card
     * @param {Object} note
     * @param {Array} tags - Available tags
     * @returns {string} HTML
     */
    // Chip shown on assistant-written note cards.
    assistantChip() {
        return `<span class="note-template-chip" title="Created by the AI Assistant">${NoteTemplates.get('assistant').icon} AI Assistant</span>`;
    },

    // Chip shown on prompt-feed note cards (scheduled-run outputs).
    feedChip() {
        return `<span class="note-template-chip" title="Generated by a scheduled prompt">${NoteTemplates.get('feed').icon} Prompt Feed</span>`;
    },

    // Chip shown on prompt-template note cards: "⚡ Prompt" plus an offline
    // badge ("⏱ daily · web") when the prompt runs on a schedule.
    promptChip(note) {
        const cfg = NotePrompts.config(note);
        const icon = NoteTemplates.get('prompt').icon;
        const offline = cfg.offline
            ? ` <span class="note-template-chip note-template-chip-offline" title="Runs offline on a schedule">&#9201; ${NotePrompts.intervalLabel(cfg.interval)}${cfg.web ? ' &middot; web' : ''}</span>`
            : '';
        return `<span class="note-template-chip" title="Prompt template">${icon} Prompt</span>${offline}`;
    },

    renderNoteCard(note, tags) {
        const noteTags = note.tags ? note.tags.map(tagName =>
            tags.find(t => t.name === tagName)
        ).filter(Boolean) : [];

        const template = (typeof NoteTemplates !== 'undefined') ? NoteTemplates.resolve(note) : 'blank';
        const chapters = template === 'book' && typeof NoteTemplates !== 'undefined'
            ? NoteTemplates.extractChapters(note.content)
            : [];
        const bookChip = template === 'book'
            ? `<span class="note-template-chip" title="Book template">${NoteTemplates.get('book').icon} ${chapters.length} chapter${chapters.length === 1 ? '' : 's'}</span>`
            : '';
        const templateChip = bookChip || (template === 'prompt' ? this.promptChip(note) : (template === 'assistant' ? this.assistantChip() : (template === 'feed' ? this.feedChip() : '')));

        return `
            <div class="note-card ${note.pinned ? 'pinned' : ''}" data-note-id="${note.id}" data-template="${template}">
                ${(noteTags.length > 0 || templateChip) ? `
                    <div class="note-card-meta-row">
                        ${templateChip}
                        ${noteTags.map(tag => `
                            <span class="note-theme-badge">
                                ${UIUtils.escapeHtml(tag.name)}
                            </span>
                        `).join('')}
                    </div>
                ` : ''}
                <div class="note-header">
                    <h3 class="note-title">${UIUtils.escapeHtml(note.title)}</h3>
                    <div class="note-actions">
                        <button class="note-action-btn home-btn" data-note-id="${note.id}" title="${note.showOnHome ? 'Remove from Home' : 'Show on Home'}">
                            ${note.showOnHome ? '&#8962;' : '&#9744;'}
                        </button>
                        <button class="note-action-btn pin-btn" data-note-id="${note.id}" title="${note.pinned ? 'Unpin' : 'Pin'}" aria-label="${note.pinned ? 'Unpin note' : 'Pin note'}">&#128204;</button>
                        <button class="note-action-btn edit-btn" data-note-id="${note.id}" title="Edit">
                            &#9998;
                        </button>
                        <button class="note-action-btn delete-btn" data-note-id="${note.id}" title="Delete">
                            &#215;
                        </button>
                    </div>
                </div>
                <div class="note-content note-content-preview">${note.content}</div>
                <div class="note-footer">
                    <span class="note-date">${UIUtils.formatDate(note.modifiedAt)}</span>
                </div>
            </div>
        `;
    },

    /**
     * Render a single note as a list row
     * @param {Object} note
     * @param {Array} tags - Available tags
     * @returns {string} HTML
     */
    renderNoteListItem(note, tags) {
        const noteTags = note.tags ? note.tags.filter(tagName =>
            tags.some(t => t.name === tagName)
        ) : [];

        const preview = this.stripHtml(note.content);
        const template = (typeof NoteTemplates !== 'undefined') ? NoteTemplates.resolve(note) : 'blank';
        const chapters = template === 'book' && typeof NoteTemplates !== 'undefined'
            ? NoteTemplates.extractChapters(note.content)
            : [];
        const bookChip = template === 'book'
            ? `<span class="note-template-chip" title="Book template">${NoteTemplates.get('book').icon} ${chapters.length} chapter${chapters.length === 1 ? '' : 's'}</span>`
            : '';
        const templateChip = bookChip || (template === 'prompt' ? this.promptChip(note) : (template === 'assistant' ? this.assistantChip() : (template === 'feed' ? this.feedChip() : '')));

        return `
            <div class="notes-list-item ${note.pinned ? 'pinned' : ''}" data-note-id="${note.id}" data-template="${template}">
                <div class="notes-list-body">
                    <div class="notes-list-title">${UIUtils.escapeHtml(note.title)}</div>
                    <div class="notes-list-preview">${preview}</div>
                    ${(noteTags.length > 0 || templateChip) ? `
                        <div class="notes-list-meta">
                            <div class="notes-list-tags">
                                ${templateChip}
                                ${noteTags.map(tag => `<span class="notes-list-tag">#${UIUtils.escapeHtml(tag)}</span>`).join('')}
                            </div>
                        </div>
                    ` : ''}
                </div>
                <span class="notes-list-date">${UIUtils.formatDate(note.modifiedAt)}</span>
                <div class="notes-list-actions">
                    <button class="note-action-btn pin-btn" data-note-id="${note.id}" title="${note.pinned ? 'Unpin' : 'Pin'}" aria-label="${note.pinned ? 'Unpin note' : 'Pin note'}">&#128204;</button>
                    <button class="note-action-btn edit-btn" data-note-id="${note.id}" title="Edit">&#9998;</button>
                    <button class="note-action-btn delete-btn" data-note-id="${note.id}" title="Delete">&#215;</button>
                </div>
            </div>
        `;
    },

    /**
     * Strip HTML to plain text for list preview
     * @param {string} html
     * @returns {string}
     */
    stripHtml(html) {
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        tmp.querySelectorAll('p, div, br, h1, h2, h3, li').forEach(el => {
            if (el.tagName === 'BR') {
                el.replaceWith(' ');
            } else {
                el.insertAdjacentText('afterend', ' ');
            }
        });
        return UIUtils.escapeHtml((tmp.textContent || tmp.innerText || '').trim());
    },

    /**
     * Attach event listeners to note cards/list items
     */
    attachEventListeners() {
        // Click on card or list item to view
        document.querySelectorAll('.note-card, .notes-list-item').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('.note-actions, .notes-list-actions')) return;
                const noteId = el.dataset.noteId;
                NotesApp.openViewer(noteId);
            });
        });

        document.querySelectorAll('.home-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const noteId = btn.dataset.noteId;
                this.toggleShowOnHome(noteId);
            });
        });

        document.querySelectorAll('.pin-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const noteId = btn.dataset.noteId;
                this.togglePin(noteId);
            });
        });

        document.querySelectorAll('.note-card .edit-btn, .notes-list-item .edit-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const noteId = btn.dataset.noteId;
                NotesApp.openEditor(noteId);
            });
        });

        document.querySelectorAll('.note-card .delete-btn, .notes-list-item .delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const noteId = btn.dataset.noteId;
                this.deleteNote(noteId);
            });
        });
    },

    /**
     * Toggle show on home status
     */
    toggleShowOnHome(noteId) {
        const note = NotesApp.notes.find(n => n.id === noteId);
        if (note) {
            note.showOnHome = !note.showOnHome;
            NotesApp.saveNotes();
            NotesApp.render();
            UIUtils.showToast(note.showOnHome ? 'Note added to home page' : 'Note removed from home page', 'success');
        }
    },

    /**
     * Toggle pin status
     */
    togglePin(noteId) {
        NotesApp.togglePin(noteId);
    },

    /**
     * Delete note
     */
    async deleteNote(noteId) {
        const confirmed = await UIUtils.confirm(
            'Delete Note',
            'Are you sure you want to delete this note?',
            '&#128465;'
        );

        if (confirmed) {
            NotesApp.notes = NotesApp.notes.filter(n => n.id !== noteId);
            NotesApp.saveNotes();
            NotesApp.render();
            UIUtils.showToast('Note deleted', 'success');
        }
    }
};
