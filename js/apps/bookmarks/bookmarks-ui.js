/**
 * Bookmarks UI
 * Renders bookmark cards/list, groups sidebar, and handles UI interactions
 * Matches Notes UI patterns for consistency
 */

const BookmarksUI = {
    get viewMode() {
        return StorageManager.get('bookmarks-view-mode') || 'grid';
    },
    set viewMode(val) {
        StorageManager.set('bookmarks-view-mode', val);
    },

    render(bookmarks, app) {
        const container = document.getElementById('bookmarks-container');
        const emptyState = document.getElementById('bookmarks-empty');

        if (!container) return;

        if (bookmarks.length === 0) {
            container.innerHTML = '';
            container.style.display = 'none';
            if (emptyState) emptyState.style.display = '';
            return;
        }

        container.style.display = '';
        if (emptyState) emptyState.style.display = 'none';

        if (this.viewMode === 'list') {
            container.className = 'bookmarks-list';
            container.innerHTML = bookmarks.map(b => this.renderListItem(b)).join('');
        } else {
            container.className = 'bookmarks-grid';
            container.innerHTML = bookmarks.map(b => this.renderCard(b)).join('');
        }

        this.attachCardListeners(app);
    },

    renderCard(bookmark) {
        const domain = this.getDomain(bookmark.url);
        const tagsHtml = (bookmark.tags || []).map(t =>
            `<span class="bookmark-card-tag">${UIUtils.escapeHtml(t)}</span>`
        ).join('');

        return `
            <div class="bookmark-card" data-id="${bookmark.id}">
                <div class="bookmark-card-header">
                    <img class="bookmark-favicon" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32" alt="" onerror="this.style.display='none'">
                    <div class="bookmark-card-title">${UIUtils.escapeHtml(bookmark.title || 'Untitled')}</div>
                </div>
                ${bookmark.description ? `<div class="bookmark-card-desc">${UIUtils.escapeHtml(bookmark.description)}</div>` : ''}
                <div class="bookmark-card-footer">
                    ${tagsHtml ? `<div class="bookmark-card-tags">${tagsHtml}</div>` : '<span></span>'}
                    <span class="bookmark-card-domain">${UIUtils.escapeHtml(domain)}</span>
                </div>
            </div>
        `;
    },

    renderListItem(bookmark) {
        const domain = this.getDomain(bookmark.url);
        const tagsHtml = (bookmark.tags || []).map(t =>
            `<span class="bookmarks-list-tag">${UIUtils.escapeHtml(t)}</span>`
        ).join('');
        const date = bookmark.modifiedAt ? new Date(bookmark.modifiedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';

        return `
            <div class="bookmarks-list-item" data-id="${bookmark.id}">
                <img class="bookmark-favicon" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32" alt="" onerror="this.style.display='none'">
                <div class="bookmarks-list-body">
                    <div class="bookmarks-list-title">${UIUtils.escapeHtml(bookmark.title || 'Untitled')}</div>
                    ${bookmark.description ? `<div class="bookmarks-list-preview">${UIUtils.escapeHtml(bookmark.description)}</div>` : ''}
                    <div class="bookmarks-list-meta">
                        <span class="bookmarks-list-domain">${UIUtils.escapeHtml(domain)}</span>
                        ${tagsHtml ? `<div class="bookmarks-list-tags">${tagsHtml}</div>` : ''}
                    </div>
                </div>
                <span class="bookmarks-list-date">${date}</span>
            </div>
        `;
    },

    getDomain(url) {
        try {
            return new URL(url).hostname.replace('www.', '');
        } catch {
            return url || '';
        }
    },

    attachCardListeners(app) {
        document.querySelectorAll('.bookmark-card, .bookmarks-list-item').forEach(card => {
            card.addEventListener('click', () => {
                app.openViewer(card.dataset.id);
            });
        });
    },

    renderGroups(app) {
        const container = document.getElementById('bookmarks-group-list');
        if (!container) return;

        const profileBookmarks = app.getFilteredBookmarks();
        const allCount = profileBookmarks.length;
        const ungroupedCount = profileBookmarks.filter(b => !b.group).length;

        let html = `
            <div class="bookmarks-filter-item ${app.currentGroup === 'all' ? 'active' : ''}" data-group="all">
                <span class="bookmarks-filter-name">All</span>
                <span class="bookmarks-filter-count">${allCount}</span>
            </div>
        `;

        const profileGroups = app.groups.filter(g => profileBookmarks.some(b => b.group === g.name));
        profileGroups.forEach(g => {
            const count = profileBookmarks.filter(b => b.group === g.name).length;
            html += `
                <div class="bookmarks-filter-item ${app.currentGroup === g.name ? 'active' : ''}" data-group="${UIUtils.escapeHtml(g.name)}">
                    <span class="bookmarks-filter-name">${UIUtils.escapeHtml(g.name)}</span>
                    <span class="bookmarks-filter-count">${count}</span>
                    <button class="bookmarks-group-delete" data-group="${UIUtils.escapeHtml(g.name)}" title="Delete group">&times;</button>
                </div>
            `;
        });

        if (ungroupedCount > 0 && app.groups.length > 0) {
            html += `
                <div class="bookmarks-filter-item ${app.currentGroup === 'ungrouped' ? 'active' : ''}" data-group="ungrouped">
                    <span class="bookmarks-filter-name">Ungrouped</span>
                    <span class="bookmarks-filter-count">${ungroupedCount}</span>
                </div>
            `;
        }

        container.innerHTML = html;

        // Group click handlers
        container.querySelectorAll('.bookmarks-filter-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.classList.contains('bookmarks-group-delete')) return;
                app.currentGroup = item.dataset.group;
                app.render();
            });
        });

        // Group delete handlers
        container.querySelectorAll('.bookmarks-group-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                app.deleteGroup(btn.dataset.group);
            });
        });

        // Render stats
        this.renderStats(app);
    },

    renderStats(app) {
        const container = document.getElementById('bookmarks-stats');
        if (!container) return;

        const total = app.bookmarks.length;
        const groups = app.groups.length;
        const tags = new Set();
        app.bookmarks.forEach(b => (b.tags || []).forEach(t => tags.add(t)));

        container.innerHTML = `
            <div class="bookmarks-stat">
                <span class="bookmarks-stat-value">${total}</span>
                <span class="bookmarks-stat-label">Bookmarks</span>
            </div>
            <div class="bookmarks-stat">
                <span class="bookmarks-stat-value">${groups}</span>
                <span class="bookmarks-stat-label">Groups</span>
            </div>
            <div class="bookmarks-stat">
                <span class="bookmarks-stat-value">${tags.size}</span>
                <span class="bookmarks-stat-label">Tags</span>
            </div>
        `;
    },

    setupViewToggle(app) {
        const toggle = document.getElementById('bookmarks-view-toggle');
        if (!toggle) return;

        // Restore saved state
        toggle.querySelectorAll('.bookmarks-view-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.view === this.viewMode);
        });

        toggle.querySelectorAll('.bookmarks-view-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                toggle.querySelectorAll('.bookmarks-view-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.viewMode = btn.dataset.view;
                app.render();
            });
        });
    }
};
