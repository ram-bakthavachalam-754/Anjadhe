/**
 * Journal UI - Rendering
 *
 * Three-pane layout (2026-07-20): this file renders the left filter nav
 * and the middle timeline column. The right pane (the always-editable
 * entry) is driven by JournalApp directly. The old diary-book layout is
 * retired.
 */

const JournalUI = {
    /**
     * Render the timeline + sidebar.
     * @param {Array} entries - Filtered entries (newest-first)
     */
    render(entries) {
        const listContainer = document.getElementById('journal-container');
        const emptyState = document.getElementById('journal-empty');

        this.renderSidebar(ProfileManager.filterByActiveProfile(JournalApp.entries));

        if (!listContainer) return;
        if (entries.length === 0) {
            listContainer.style.display = 'none';
            if (emptyState) emptyState.style.display = 'block';
            return;
        }
        if (emptyState) emptyState.style.display = 'none';
        listContainer.style.display = 'flex';

        const groups = this.groupByMonth(entries);
        listContainer.innerHTML = groups.map(group => this.renderMonthGroup(group)).join('');
        this.attachEventListeners();
    },

    /**
     * Group entries by month
     */
    groupByMonth(entries) {
        const groups = {};
        entries.forEach(entry => {
            const date = new Date(entry.date);
            const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
            const label = date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
            if (!groups[key]) {
                groups[key] = { key, label, entries: [] };
            }
            groups[key].entries.push(entry);
        });
        return Object.values(groups);
    },

    renderMonthGroup(group) {
        return `
            <div class="journal-month-group">
                <div class="journal-month-header">${group.label}</div>
                ${group.entries.map(entry => this.renderEntry(entry)).join('')}
            </div>
        `;
    },

    /**
     * One timeline row: day/weekday gutter, mood + two-line preview,
     * a small photo thumb when the entry carries media.
     */
    renderEntry(entry) {
        const date = new Date(entry.date);
        const day = date.getDate();
        const weekday = date.toLocaleDateString('en-US', { weekday: 'short' });
        const moodInfo = this.getMoodInfo(entry.mood);
        const preview = this.stripHtml(entry.content);
        const selected = JournalApp.currentEntryId === entry.id;

        // First image's stored thumbnail, if any media rides along.
        const mediaIds = JournalApp._mediaIdsIn(entry.content);
        let thumb = '';
        let mediaMark = '';
        if (mediaIds.length) {
            for (const id of mediaIds) {
                const m = JournalApp._getMedia(id);
                if (m && m.kind === 'image' && m.thumb) {
                    thumb = `<img class="journal-entry-thumb" src="${m.thumb}" alt="">`;
                    break;
                }
            }
            if (!thumb) mediaMark = `<span class="journal-entry-media-mark" title="Has media">&#127909;</span>`;
        }

        return `
            <div class="journal-entry ${selected ? 'is-selected' : ''}" data-entry-id="${entry.id}">
                <div class="journal-entry-date">
                    <div class="journal-day">${day}</div>
                    <div class="journal-weekday">${weekday}</div>
                </div>
                <div class="journal-entry-body">
                    <div class="journal-entry-topline">
                        <span class="journal-entry-mood" title="${moodInfo.label}">${moodInfo.icon}</span>
                        <div class="journal-entry-preview">${preview || '<em>Empty entry</em>'}</div>
                    </div>
                    ${entry.tags.length > 0 ? `
                        <div class="journal-entry-meta">
                            <div class="journal-entry-tags">
                                ${entry.tags.map(tag => `
                                    <span class="journal-tag">#${UIUtils.escapeHtml(tag)}</span>
                                `).join('')}
                            </div>
                            ${mediaMark}
                        </div>
                    ` : (mediaMark ? `<div class="journal-entry-meta">${mediaMark}</div>` : '')}
                </div>
                ${thumb}
            </div>
        `;
    },

    attachEventListeners() {
        document.querySelectorAll('#journal-container .journal-entry').forEach(el => {
            el.addEventListener('click', () => {
                JournalApp.openEditor(el.dataset.entryId);
            });
        });
    },

    /**
     * Update only the selection highlight (cheap path for entry swaps).
     */
    updateSelection() {
        document.querySelectorAll('#journal-container .journal-entry').forEach(el => {
            el.classList.toggle('is-selected', el.dataset.entryId === JournalApp.currentEntryId);
        });
    },

    /**
     * Render sidebar: filters, mood breakdown, tag cloud, stats
     */
    renderSidebar(allEntries) {
        this.renderFilterCounts(allEntries);
        this.renderMoodFilters(allEntries);
        this.renderTagCloud(allEntries);
        this.renderStats(allEntries);
    },

    renderFilterCounts(entries) {
        const now = new Date();
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

        const countAll = document.getElementById('journal-count-all');
        const countWeek = document.getElementById('journal-count-week');
        const countMonth = document.getElementById('journal-count-month');

        if (countAll) countAll.textContent = entries.length;
        if (countWeek) countWeek.textContent = entries.filter(e => new Date(e.date) >= weekAgo).length;
        if (countMonth) countMonth.textContent = entries.filter(e => new Date(e.date) >= monthAgo).length;

        const filterList = document.getElementById('journal-filter-list');
        if (filterList) {
            filterList.querySelectorAll('.journal-filter-item').forEach(i => {
                i.classList.toggle('active', i.dataset.filter === JournalApp.filterBy);
            });
            if (!filterList.dataset.bound) {
                filterList.dataset.bound = 'true';
                filterList.addEventListener('click', (e) => {
                    const item = e.target.closest('.journal-filter-item');
                    if (!item) return;
                    JournalApp.filterBy = item.dataset.filter;
                    // Clear mood and tag filters when switching date filter
                    JournalApp.moodFilter = null;
                    JournalApp.tagFilter = null;
                    JournalApp.render();
                });
            }
        }
    },

    renderMoodFilters(entries) {
        const container = document.getElementById('journal-mood-filter-list');
        if (!container) return;

        const moodCounts = {};
        entries.forEach(e => {
            moodCounts[e.mood] = (moodCounts[e.mood] || 0) + 1;
        });

        const moods = [
            { value: 'amazing', icon: '&#128516;', label: 'Amazing' },
            { value: 'happy', icon: '&#128522;', label: 'Happy' },
            { value: 'neutral', icon: '&#128528;', label: 'Neutral' },
            { value: 'sad', icon: '&#128546;', label: 'Sad' },
            { value: 'stressed', icon: '&#128560;', label: 'Stressed' }
        ];

        container.innerHTML = moods
            .filter(m => moodCounts[m.value])
            .map(m => `
                <div class="journal-mood-filter-item ${JournalApp.moodFilter === m.value ? 'active' : ''}" data-mood="${m.value}">
                    <span class="journal-mood-filter-icon">${m.icon}</span>
                    <span class="journal-mood-filter-label">${m.label}</span>
                    <span class="journal-mood-filter-count">${moodCounts[m.value]}</span>
                </div>
            `).join('');

        if (!container.dataset.bound) {
            container.dataset.bound = 'true';
            container.addEventListener('click', (e) => {
                const item = e.target.closest('.journal-mood-filter-item');
                if (!item) return;
                const mood = item.dataset.mood;
                JournalApp.moodFilter = JournalApp.moodFilter === mood ? null : mood;
                JournalApp.render();
            });
        }
    },

    renderTagCloud(entries) {
        const container = document.getElementById('journal-tag-cloud');
        if (!container) return;

        const tagCounts = {};
        entries.forEach(e => {
            e.tags.forEach(tag => {
                tagCounts[tag] = (tagCounts[tag] || 0) + 1;
            });
        });

        const tags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);

        if (tags.length === 0) {
            container.innerHTML = '<span class="journal-tag-cloud-empty">No tags yet</span>';
            return;
        }

        container.innerHTML = tags.map(([tag]) => `
            <span class="journal-tag-cloud-item ${JournalApp.tagFilter === tag ? 'active' : ''}" data-tag="${UIUtils.escapeHtml(tag)}">#${UIUtils.escapeHtml(tag)}</span>
        `).join('');

        if (!container.dataset.bound) {
            container.dataset.bound = 'true';
            container.addEventListener('click', (e) => {
                const item = e.target.closest('.journal-tag-cloud-item');
                if (!item) return;
                const tag = item.dataset.tag;
                JournalApp.tagFilter = JournalApp.tagFilter === tag ? null : tag;
                JournalApp.render();
            });
        }
    },

    renderStats(entries) {
        const container = document.getElementById('journal-stats');
        if (!container) return;

        const streak = this.calculateStreak(entries);
        const now = new Date();
        const thisMonthEntries = entries.filter(e => {
            const d = new Date(e.date);
            return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        }).length;

        container.innerHTML = `
            <div class="journal-stat">
                <span class="journal-stat-value">${streak}</span>
                <span class="journal-stat-label">Day streak</span>
            </div>
            <div class="journal-stat">
                <span class="journal-stat-value">${thisMonthEntries}</span>
                <span class="journal-stat-label">This month</span>
            </div>
            <div class="journal-stat">
                <span class="journal-stat-value">${entries.length}</span>
                <span class="journal-stat-label">Total entries</span>
            </div>
        `;
    },

    /**
     * Calculate writing streak (consecutive days with entries)
     */
    calculateStreak(entries) {
        if (entries.length === 0) return 0;

        const dates = new Set();
        entries.forEach(e => {
            const d = new Date(e.date);
            dates.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
        });

        let streak = 0;
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const checkDate = new Date(today);
        const todayKey = `${checkDate.getFullYear()}-${checkDate.getMonth()}-${checkDate.getDate()}`;
        if (!dates.has(todayKey)) {
            checkDate.setDate(checkDate.getDate() - 1);
            const yesterdayKey = `${checkDate.getFullYear()}-${checkDate.getMonth()}-${checkDate.getDate()}`;
            if (!dates.has(yesterdayKey)) return 0;
        }

        while (true) {
            const key = `${checkDate.getFullYear()}-${checkDate.getMonth()}-${checkDate.getDate()}`;
            if (dates.has(key)) {
                streak++;
                checkDate.setDate(checkDate.getDate() - 1);
            } else {
                break;
            }
        }

        return streak;
    },

    /**
     * Strip HTML tags and get plain text (media contributes nothing).
     */
    stripHtml(html) {
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        tmp.querySelectorAll('img, video').forEach(el => el.remove());
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
     * Get mood information
     */
    getMoodInfo(mood) {
        const moods = {
            amazing: { icon: '\u{1F604}', label: 'Amazing' },
            happy: { icon: '\u{1F60A}', label: 'Happy' },
            neutral: { icon: '\u{1F610}', label: 'Neutral' },
            sad: { icon: '\u{1F622}', label: 'Sad' },
            stressed: { icon: '\u{1F630}', label: 'Stressed' }
        };
        return moods[mood] || moods.neutral;
    }
};
