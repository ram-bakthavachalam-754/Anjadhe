/**
 * Bookmarks App
 * Save, organize, and search bookmarks with groups and tags
 */

const BookmarksApp = {
    bookmarks: [],
    groups: [],
    currentBookmarkId: null,
    autoLinkContext: null, // [{app, itemId}, ...] — auto-link new bookmarks to these items
    currentGroup: 'all',
    currentSearch: '',
    currentSort: 'modified',

    init() {
        this.loadData();
        this.setupEventListeners();
        BookmarksUI.setupViewToggle(this);
        this.render();
    },

    loadData() {
        const data = StorageManager.get('bookmarks');
        // Normalize so a phone-created bookmark (or a malformed blob shape) can't
        // crash the renderer — drop non-objects, coerce strings, default tags.
        this.bookmarks = (Array.isArray(data?.bookmarks) ? data.bookmarks : [])
            .filter(b => b && typeof b === 'object')
            .map(b => ({
                ...b,
                title: typeof b.title === 'string' ? b.title : '',
                url: typeof b.url === 'string' ? b.url : '',
                description: typeof b.description === 'string' ? b.description : '',
                tags: Array.isArray(b.tags) ? b.tags : [],
            }));
        this.groups = Array.isArray(data?.groups) ? data.groups : [];
    },

    saveData() {
        StorageManager.set('bookmarks', {
            bookmarks: this.bookmarks,
            groups: this.groups
        });
        AppManager.updateStats();
    },

    setupEventListeners() {
        // Add bookmark button
        const addBtn = document.getElementById('add-bookmark-btn');
        const newAddBtn = addBtn.cloneNode(true);
        addBtn.parentNode.replaceChild(newAddBtn, addBtn);
        newAddBtn.addEventListener('click', () => this.openEditor());

        // Search
        const searchInput = document.getElementById('bookmarks-search');
        const newSearch = searchInput.cloneNode(true);
        searchInput.parentNode.replaceChild(newSearch, searchInput);
        newSearch.value = this.currentSearch;
        newSearch.addEventListener('input', (e) => {
            this.currentSearch = e.target.value;
            this.render();
        });

        // Sort
        const sortSelect = document.getElementById('bookmarks-sort');
        const newSort = sortSelect.cloneNode(true);
        sortSelect.parentNode.replaceChild(newSort, sortSelect);
        newSort.value = this.currentSort;
        newSort.addEventListener('change', (e) => {
            this.currentSort = e.target.value;
            this.render();
        });

        // Create group button
        const createGroupBtn = document.getElementById('create-bookmark-group-btn');
        const newCreateGroupBtn = createGroupBtn.cloneNode(true);
        createGroupBtn.parentNode.replaceChild(newCreateGroupBtn, createGroupBtn);
        newCreateGroupBtn.addEventListener('click', () => this.createGroup());

        // Editor save button
        const editorSaveBtn = document.getElementById('bookmark-editor-save-btn');
        const newEditorSaveBtn = editorSaveBtn.cloneNode(true);
        editorSaveBtn.parentNode.replaceChild(newEditorSaveBtn, editorSaveBtn);
        newEditorSaveBtn.addEventListener('click', () => this.saveCurrentBookmark());

        // Editor delete button
        const editorDeleteBtn = document.getElementById('bookmark-editor-delete-btn');
        const newEditorDeleteBtn = editorDeleteBtn.cloneNode(true);
        editorDeleteBtn.parentNode.replaceChild(newEditorDeleteBtn, editorDeleteBtn);
        newEditorDeleteBtn.addEventListener('click', () => this.deleteCurrentBookmark());

        // Viewer back button
        // Viewer edit button
        const viewerEditBtn = document.getElementById('bookmark-viewer-edit-btn');
        const newViewerEditBtn = viewerEditBtn.cloneNode(true);
        viewerEditBtn.parentNode.replaceChild(newViewerEditBtn, viewerEditBtn);
        newViewerEditBtn.addEventListener('click', () => {
            const id = this.currentBookmarkId;
            this.closeViewer();
            this.openEditor(id);
        });

        // Viewer open URL button
        const viewerOpenBtn = document.getElementById('bookmark-viewer-open-btn');
        const newViewerOpenBtn = viewerOpenBtn.cloneNode(true);
        viewerOpenBtn.parentNode.replaceChild(newViewerOpenBtn, viewerOpenBtn);
        newViewerOpenBtn.addEventListener('click', () => {
            const bookmark = this.bookmarks.find(b => b.id === this.currentBookmarkId);
            if (bookmark?.url) {
                this.openInBrowser(bookmark.url);
            }
        });

        // Viewer delete button
        const viewerDeleteBtn = document.getElementById('bookmark-viewer-delete-btn');
        const newViewerDeleteBtn = viewerDeleteBtn.cloneNode(true);
        viewerDeleteBtn.parentNode.replaceChild(newViewerDeleteBtn, viewerDeleteBtn);
        newViewerDeleteBtn.addEventListener('click', () => this.deleteCurrentBookmark());

        // URL input auto-fetch title
        const urlInput = document.getElementById('bookmark-url-input');
        const newUrlInput = urlInput.cloneNode(true);
        urlInput.parentNode.replaceChild(newUrlInput, urlInput);
        newUrlInput.addEventListener('blur', () => this.fetchTitleFromUrl());

        // Tag input
        const tagInput = document.getElementById('bookmark-tag-input');
        const newTagInput = tagInput.cloneNode(true);
        tagInput.parentNode.replaceChild(newTagInput, tagInput);
        newTagInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.addTag(e.target.value.trim());
                e.target.value = '';
            }
        });
    },

    async fetchTitleFromUrl() {
        const urlInput = document.getElementById('bookmark-url-input');
        const titleInput = document.getElementById('bookmark-title-input');
        const url = urlInput.value.trim();

        if (!url || titleInput.value.trim()) return;

        try {
            new URL(url);
        } catch {
            return;
        }

        titleInput.placeholder = 'Fetching title...';
        try {
            const result = await window.electronNet.fetchUrlTitle(url);
            if (result?.title && !titleInput.value.trim()) {
                // Decode HTML entities
                const doc = new DOMParser().parseFromString(result.title, 'text/html');
                titleInput.value = doc.body.textContent || result.title;
            }
        } catch {
            // Silently fail
        }
        titleInput.placeholder = 'Bookmark title...';
    },

    getFilteredBookmarks() {
        let filtered = ProfileManager.filterByActiveProfile([...this.bookmarks]);

        // Filter by group
        if (this.currentGroup !== 'all') {
            if (this.currentGroup === 'ungrouped') {
                filtered = filtered.filter(b => !b.group);
            } else {
                filtered = filtered.filter(b => b.group === this.currentGroup);
            }
        }

        // Filter by search
        if (this.currentSearch) {
            const q = this.currentSearch.toLowerCase();
            filtered = filtered.filter(b =>
                (b.title || '').toLowerCase().includes(q) ||
                (b.url || '').toLowerCase().includes(q) ||
                (b.description || '').toLowerCase().includes(q) ||
                (b.tags || []).some(t => t.toLowerCase().includes(q))
            );
        }

        // Sort
        switch (this.currentSort) {
            case 'created':
                filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
                break;
            case 'title':
                filtered.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
                break;
            case 'modified':
            default:
                filtered.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
                break;
        }

        return filtered;
    },

    openEditor(bookmarkId = null, opts = {}) {
        this.currentBookmarkId = bookmarkId;
        this._editorOrigin = opts.origin || null;

        document.getElementById('bookmarks-view').classList.remove('active');
        document.getElementById('bookmark-viewer-view').classList.remove('active');
        document.getElementById('bookmark-editor-view').classList.add('active');

        // Render breadcrumb
        const existing = bookmarkId ? this.bookmarks.find(b => b.id === bookmarkId) : null;
        Breadcrumb.render('bookmark-editor-breadcrumb', this._buildBookmarkCrumbs(bookmarkId, existing?.title || 'New Bookmark'));

        const titleInput = document.getElementById('bookmark-title-input');
        const urlInput = document.getElementById('bookmark-url-input');
        const descInput = document.getElementById('bookmark-description-input');
        const groupSelect = document.getElementById('bookmark-group-select');
        const notesInput = document.getElementById('bookmark-notes-input');
        const deleteBtn = document.getElementById('bookmark-editor-delete-btn');

        // Clear tags display
        this.renderEditorTags([]);

        if (bookmarkId) {
            const bookmark = this.bookmarks.find(b => b.id === bookmarkId);
            if (bookmark) {
                titleInput.value = bookmark.title || '';
                urlInput.value = bookmark.url || '';
                descInput.value = bookmark.description || '';
                notesInput.value = bookmark.notes || '';
                this.renderEditorTags(bookmark.tags || []);
                this.renderEditorGroups(bookmark.group || '');
                deleteBtn.style.display = '';
            }
        } else {
            titleInput.value = '';
            urlInput.value = '';
            descInput.value = '';
            notesInput.value = '';
            this.renderEditorGroups('');
            deleteBtn.style.display = 'none';
        }

        // New group button in editor sidebar
        const newGroupBtn = document.getElementById('bookmark-editor-new-group-btn');
        if (newGroupBtn) {
            const freshBtn = newGroupBtn.cloneNode(true);
            newGroupBtn.parentNode.replaceChild(freshBtn, newGroupBtn);
            freshBtn.addEventListener('click', async () => {
                const name = prompt('Group name:');
                if (!name || !name.trim()) return;
                const trimmed = name.trim();
                if (this.groups.some(g => g.name.toLowerCase() === trimmed.toLowerCase())) {
                    UIUtils.showToast('Group already exists', 'error');
                    return;
                }
                this.groups.push({ name: trimmed, createdAt: new Date().toISOString() });
                this.saveData();
                this.renderEditorGroups(trimmed);
            });
        }

        setTimeout(() => urlInput.focus(), 100);
    },

    closeEditor() {
        const origin = this._editorOrigin;
        this._editorOrigin = null;

        document.getElementById('bookmark-editor-view').classList.remove('active');
        this.currentBookmarkId = null;
        this.autoLinkContext = null;

        if (origin && typeof origin === 'object' && origin.app) {
            LinkedItemsUI.navigateToItem(origin.app, origin.itemId);
            return;
        }

        document.getElementById('bookmarks-view').classList.add('active');
        this.render();
    },

    openViewer(bookmarkId) {
        this.currentBookmarkId = bookmarkId;
        const bookmark = this.bookmarks.find(b => b.id === bookmarkId);
        if (!bookmark) return;

        document.getElementById('bookmarks-view').classList.remove('active');
        document.getElementById('bookmark-viewer-view').classList.add('active');

        Breadcrumb.render('bookmark-viewer-breadcrumb', this._buildBookmarkCrumbs(bookmarkId, bookmark.title));

        document.getElementById('bookmark-viewer-title').textContent = bookmark.title || 'Untitled';
        document.getElementById('bookmark-viewer-url').innerHTML = `<a href="#" class="bookmark-url-link">${UIUtils.escapeHtml(bookmark.url || '')}</a>`;
        document.getElementById('bookmark-viewer-description').textContent = bookmark.description || '';

        const notesLabel = document.getElementById('bookmark-viewer-notes-label');
        const notesEl = document.getElementById('bookmark-viewer-notes');
        if (bookmark.notes) {
            notesLabel.style.display = '';
            notesEl.textContent = bookmark.notes;
            notesEl.style.display = '';
        } else {
            notesLabel.style.display = 'none';
            notesEl.style.display = 'none';
        }

        // Meta: group + tags
        const metaParts = [];
        if (bookmark.group) metaParts.push(`<span class="bookmark-meta-group">${UIUtils.escapeHtml(bookmark.group)}</span>`);
        (bookmark.tags || []).forEach(tag => {
            metaParts.push(`<span class="bookmark-meta-tag">${UIUtils.escapeHtml(tag)}</span>`);
        });
        document.getElementById('bookmark-viewer-meta').innerHTML = metaParts.join('');

        const date = new Date(bookmark.createdAt);
        document.getElementById('bookmark-viewer-date').textContent = `Added ${date.toLocaleDateString()}`;

        // URL click handler
        const urlLink = document.querySelector('.bookmark-url-link');
        if (urlLink) {
            urlLink.addEventListener('click', (e) => {
                e.preventDefault();
                if (bookmark.url) {
                    this.openInBrowser(bookmark.url);
                }
            });
        }
    },

    // Open a bookmark in the in-app Browse sub-app (keeps pages on-device
    // and consistent with the rest of the app) instead of the system browser.
    openInBrowser(url) {
        if (!url) return;
        if (typeof AppManager !== 'undefined') AppManager.openApp('browse');
        // Defer so the Browse view is active before we drive its address bar.
        setTimeout(() => {
            if (typeof BrowseApp !== 'undefined' && BrowseApp._submitUrl) {
                BrowseApp._submitUrl(url);
            } else if (window.electronAuth && window.electronAuth.openExternal) {
                window.electronAuth.openExternal(url); // fallback
            }
        }, 50);
    },

    closeViewer() {
        document.getElementById('bookmark-viewer-view').classList.remove('active');
        document.getElementById('bookmarks-view').classList.add('active');
        this.currentBookmarkId = null;
        this.render();
    },

    renderEditorGroups(selectedGroup) {
        const container = document.getElementById('bookmark-group-list');
        if (!container) return;

        let html = `
            <label class="editor-theme-item">
                <input type="radio" name="bookmark-group" class="editor-tag-checkbox" value="" ${!selectedGroup ? 'checked' : ''}>
                <span class="editor-theme-name">None</span>
            </label>
        `;

        this.groups.forEach(g => {
            html += `
                <label class="editor-theme-item">
                    <input type="radio" name="bookmark-group" class="editor-tag-checkbox" value="${UIUtils.escapeHtml(g.name)}" ${selectedGroup === g.name ? 'checked' : ''}>
                    <span class="editor-theme-name">${UIUtils.escapeHtml(g.name)}</span>
                </label>
            `;
        });

        container.innerHTML = html;
    },

    getEditorTags() {
        const container = document.getElementById('bookmark-editor-tags');
        return Array.from(container.querySelectorAll('.bookmark-tag-pill'))
            .map(el => el.dataset.tag);
    },

    renderEditorTags(tags) {
        const container = document.getElementById('bookmark-editor-tags');
        const input = container.querySelector('#bookmark-tag-input') || container.querySelector('input');

        // Remove existing pills
        container.querySelectorAll('.bookmark-tag-pill').forEach(el => el.remove());

        tags.forEach(tag => {
            const pill = document.createElement('span');
            pill.className = 'bookmark-tag-pill';
            pill.dataset.tag = tag;
            pill.innerHTML = `${UIUtils.escapeHtml(tag)} <button type="button" class="tag-remove">&times;</button>`;
            container.insertBefore(pill, input);

            pill.querySelector('.tag-remove').addEventListener('click', () => {
                pill.remove();
            });
        });
    },

    addTag(tag) {
        if (!tag) return;
        const existing = this.getEditorTags();
        if (existing.includes(tag)) return;
        const tags = [...existing, tag];
        this.renderEditorTags(tags);
    },

    saveCurrentBookmark() {
        const title = document.getElementById('bookmark-title-input').value.trim();
        const url = document.getElementById('bookmark-url-input').value.trim();
        const description = document.getElementById('bookmark-description-input').value.trim();
        const selectedRadio = document.querySelector('#bookmark-group-list input[name="bookmark-group"]:checked');
        const group = selectedRadio ? selectedRadio.value : '';
        const notes = document.getElementById('bookmark-notes-input').value.trim();
        const tags = this.getEditorTags();
        const profile = ProfileManager.getProfileForNewItem();

        if (!url) {
            UIUtils.showToast('Please enter a URL', 'error');
            return;
        }

        const displayTitle = title || url;

        if (this.currentBookmarkId) {
            const bookmark = this.bookmarks.find(b => b.id === this.currentBookmarkId);
            if (bookmark) {
                bookmark.title = displayTitle;
                bookmark.url = url;
                bookmark.description = description;
                bookmark.group = group || null;
                bookmark.notes = notes;
                bookmark.tags = tags;
                bookmark.profile = profile;
                bookmark.modifiedAt = new Date().toISOString();
            }
        } else {
            const newId = UIUtils.generateId();
            this.bookmarks.push({
                id: newId,
                title: displayTitle,
                url,
                description,
                group: group || null,
                notes,
                tags,
                profile,
                createdAt: new Date().toISOString(),
                modifiedAt: new Date().toISOString()
            });

            // Auto-link if context was set (e.g., creating bookmark from focus/goal/task view)
            if (this.autoLinkContext) {
                for (const ctx of this.autoLinkContext) {
                    LinkManager.addLink(ctx.app, ctx.itemId, 'bookmarks', newId);
                }
                this.autoLinkContext = null;
            }
        }

        const wasEditing = !!this.currentBookmarkId;
        this.saveData();
        this.closeEditor();
        UIUtils.showToast(wasEditing ? 'Bookmark updated' : 'Bookmark added', 'success');
    },

    async deleteCurrentBookmark() {
        if (!this.currentBookmarkId) return;

        const confirmed = await UIUtils.confirm(
            'Delete Bookmark',
            'Are you sure you want to delete this bookmark?',
            ''
        );

        if (confirmed) {
            this.bookmarks = this.bookmarks.filter(b => b.id !== this.currentBookmarkId);
            this.saveData();

            const editorActive = document.getElementById('bookmark-editor-view').classList.contains('active');
            const viewerActive = document.getElementById('bookmark-viewer-view').classList.contains('active');

            if (editorActive) this.closeEditor();
            else if (viewerActive) this.closeViewer();

            UIUtils.showToast('Bookmark deleted', 'success');
        }
    },

    async createGroup() {
        const name = prompt('Group name:');
        if (!name || !name.trim()) return;

        const trimmed = name.trim();
        if (this.groups.some(g => g.name === trimmed)) {
            UIUtils.showToast('Group already exists', 'error');
            return;
        }

        this.groups.push({ name: trimmed, createdAt: new Date().toISOString() });
        this.saveData();
        this.render();
        UIUtils.showToast('Group created', 'success');
    },

    async deleteGroup(groupName) {
        const confirmed = await UIUtils.confirm(
            'Delete Group',
            `Delete "${groupName}"? Bookmarks in this group will become ungrouped.`,
            ''
        );

        if (confirmed) {
            this.groups = this.groups.filter(g => g.name !== groupName);
            this.bookmarks.forEach(b => {
                if (b.group === groupName) b.group = null;
            });
            if (this.currentGroup === groupName) this.currentGroup = 'all';
            this.saveData();
            this.render();
            UIUtils.showToast('Group deleted', 'success');
        }
    },

    render() {
        Breadcrumb.render('bookmarks-breadcrumb', [
            { label: 'Bookmarks' }
        ]);
        const filtered = this.getFilteredBookmarks();
        BookmarksUI.render(filtered, this);
        BookmarksUI.renderGroups(this);
    },

    _buildBookmarkCrumbs(bookmarkId, title) {
        const crumbs = [];

        // Existing bookmarks read links from storage; brand-new bookmarks
        // (bookmarkId null) derive crumbs from autoLinkContext.
        let focusArea = null;
        let goalCrumb = null;
        if (bookmarkId) {
            focusArea = LinkManager.getFocusForItem('bookmarks', bookmarkId);
            const goalLinks = LinkManager.getLinksForApp('bookmarks', bookmarkId, 'goals');
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
            crumbs.push({ label: 'Bookmarks', action: () => this.closeViewer() || this.closeEditor() });
        }
        crumbs.push({ label: title || 'Untitled' });
        return crumbs;
    }
};

AppManager.register('bookmarks', BookmarksApp);

// AgentContext provider — exposes the bookmark currently being viewed
// or edited. Returns null on the list view; the bookmark URL/title
// alone is small enough that we just include it directly without
// fetching the page (Browse already handles full-page extraction).
if (typeof AgentContext !== 'undefined') {
    AgentContext.register('bookmarks', () => {
        const id = BookmarksApp.currentBookmarkId;
        if (!id) return null;
        const b = (BookmarksApp.bookmarks || []).find(x => x && x.id === id);
        if (!b) return null;

        const tags = (b.tags || []).join(', ');
        return {
            recordKey: 'bookmarks:' + b.id,
            recordLabel: b.title || b.url || '(bookmark)',
            title: 'CURRENT BOOKMARK',
            body: `The user is viewing or editing the bookmark below. To open the linked page in the embedded browser they can switch to the Browse sub-app and paste the URL.

Title: ${b.title || '(untitled)'}
URL: ${b.url || '(no url)'}
Group: ${b.group || 'ungrouped'}
Tags: ${tags || 'none'}
Bookmark id: ${b.id}

Description:
${b.description || '(none)'}

Notes:
${b.notes || '(none)'}`,
            suggestedPrompts: [
                'Why might I have saved this?',
                'Suggest similar reads',
                'Summarize what this is about'
            ]
        };
    });
}
