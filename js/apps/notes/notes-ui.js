/**
 * Notes UI - Rendering with Tag System
 *
 * Three-pane layout (2026-07-20): this file renders the left filter nav
 * and the middle list column. The right pane (the always-editable note)
 * is driven by NotesApp directly.
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
     * Render sidebar: filters, tags
     */
    renderSidebar(allNotes, tags, currentFilter) {
        this.renderFilters(allNotes, currentFilter);
        this.renderTagFilters(allNotes, tags, currentFilter);
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
     * Render the list column. Pinned notes get their own section rung
     * when the list mixes pinned and unpinned.
     */
    renderNotes(notes, tags) {
        const container = document.getElementById('notes-container');
        const emptyState = document.getElementById('notes-empty');
        if (!container) return;

        if (notes.length === 0) {
            container.style.display = 'none';
            if (emptyState) emptyState.style.display = 'block';
            return;
        }

        if (emptyState) emptyState.style.display = 'none';
        container.style.display = 'flex';
        container.className = 'notes-list';

        const pinned = notes.filter(n => n.pinned);
        const rest = notes.filter(n => !n.pinned);
        const section = (label, items) => `
            <div class="notes-section">
                <div class="notes-section-header">${label}<span class="notes-section-count">${items.length}</span></div>
                ${items.map(note => this.renderNoteListItem(note, tags)).join('')}
            </div>
        `;
        container.innerHTML = (pinned.length && rest.length)
            ? section('Pinned', pinned) + section('Notes', rest)
            : notes.map(note => this.renderNoteListItem(note, tags)).join('');

        this.attachEventListeners();
    },

    // Small template markers for non-blank notes in the list column.
    _templateMark(note, template) {
        if (template === 'prompt') return NoteTemplates.get('prompt').icon;
        if (template === 'assistant') return NoteTemplates.get('assistant').icon;
        if (template === 'feed') return NoteTemplates.get('feed').icon;
        if (template === 'book') return NoteTemplates.get('book').icon;
        return '';
    },

    /**
     * One list-column row: title + date line, then a dimmed preview line.
     * Selection (NotesApp.currentNoteId) renders as the surface-fill state.
     */
    renderNoteListItem(note, tags) {
        const preview = this.stripHtml(note.content);
        const template = (typeof NoteTemplates !== 'undefined') ? NoteTemplates.resolve(note) : 'blank';
        const mark = this._templateMark(note, template);
        const selected = NotesApp.currentNoteId === note.id;

        return `
            <div class="notes-list-item ${selected ? 'is-selected' : ''}" data-note-id="${note.id}" data-template="${template}">
                <div class="notes-list-line">
                    <span class="notes-list-title">${mark ? `<span class="notes-list-mark">${mark}</span> ` : ''}${UIUtils.escapeHtml(note.title)}</span>
                    <button class="note-action-btn pin-btn ${note.pinned ? 'is-pinned' : ''}" data-note-id="${note.id}" title="${note.pinned ? 'Unpin' : 'Pin'}" aria-label="${note.pinned ? 'Unpin note' : 'Pin note'}">&#128204;</button>
                    <span class="notes-list-date">${UIUtils.formatDate(note.modifiedAt)}</span>
                </div>
                ${preview ? `<div class="notes-list-preview">${preview}</div>` : ''}
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
        return UIUtils.escapeHtml((tmp.textContent || tmp.innerText || '').trim().slice(0, 300));
    },

    /**
     * Attach event listeners to list rows
     */
    attachEventListeners() {
        document.querySelectorAll('#notes-container .notes-list-item').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('.pin-btn')) return;
                NotesApp.openEditor(el.dataset.noteId);
            });
        });

        document.querySelectorAll('#notes-container .pin-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                NotesApp.togglePin(btn.dataset.noteId);
            });
        });
    },

    /**
     * Update only the selection highlight in the list column (cheap path
     * used when switching notes — avoids a full list rebuild).
     */
    updateSelection() {
        document.querySelectorAll('#notes-container .notes-list-item').forEach(el => {
            el.classList.toggle('is-selected', el.dataset.noteId === NotesApp.currentNoteId);
        });
    }
};
