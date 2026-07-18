/**
 * Journal UI - Rendering
 */

const JournalUI = {
    // Cache of paginated content per entry. Keyed by
    // `${entryId}|${modifiedAt}|${width}x${height}` so any edit or
    // viewport change naturally produces a miss.
    _paginationCache: new Map(),

    /**
     * Render journal entries. Routes between list and diary layouts
     * based on JournalApp.viewMode.
     * @param {Array} entries - Entries to render
     */
    render(entries) {
        const listContainer = document.getElementById('journal-container');
        const diaryContainer = document.getElementById('journal-diary-container');
        const emptyState = document.getElementById('journal-empty');

        // Sidebar always renders (filters apply to both views)
        this.renderSidebar(ProfileManager.filterByActiveProfile(JournalApp.entries));

        // Keep toolbar toggle in sync with state
        this.updateViewToggle();

        if (entries.length === 0) {
            listContainer.style.display = 'none';
            diaryContainer.style.display = 'none';
            emptyState.style.display = 'block';
            return;
        }
        emptyState.style.display = 'none';

        if (JournalApp.viewMode === 'diary') {
            listContainer.style.display = 'none';
            diaryContainer.style.display = 'flex';
            this.renderDiary(entries);
        } else {
            listContainer.style.display = 'flex';
            diaryContainer.style.display = 'none';
            this.renderList(entries);
        }
    },

    /**
     * Reflect current viewMode on the toolbar toggle buttons.
     */
    updateViewToggle() {
        const toggle = document.getElementById('journal-view-toggle');
        if (!toggle) return;
        toggle.querySelectorAll('.journal-view-toggle-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === JournalApp.viewMode);
        });
    },

    /**
     * Render list (timeline) view.
     * @param {Array} entries
     */
    renderList(entries) {
        const container = document.getElementById('journal-container');

        // Group entries by month
        const groups = this.groupByMonth(entries);
        container.innerHTML = groups.map(group => this.renderMonthGroup(group)).join('');

        this.attachEventListeners();
    },

    /**
     * Group entries by month
     * @param {Array} entries
     * @returns {Array} Array of { label, entries }
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

    /**
     * Render a month group
     * @param {Object} group - { label, entries }
     * @returns {string} HTML
     */
    renderMonthGroup(group) {
        return `
            <div class="journal-month-group">
                <div class="journal-month-header">${group.label}</div>
                ${group.entries.map(entry => this.renderEntry(entry)).join('')}
            </div>
        `;
    },

    /**
     * Render a single journal entry row
     * @param {Object} entry
     * @returns {string} HTML
     */
    renderEntry(entry) {
        const date = new Date(entry.date);
        const day = date.getDate();
        const weekday = date.toLocaleDateString('en-US', { weekday: 'short' });
        const moodInfo = this.getMoodInfo(entry.mood);
        const preview = this.stripHtml(entry.content);

        return `
            <div class="journal-entry" data-entry-id="${entry.id}">
                <div class="journal-entry-date">
                    <div class="journal-day">${day}</div>
                    <div class="journal-weekday">${weekday}</div>
                </div>
                <div class="journal-entry-mood" title="${moodInfo.label}">${moodInfo.icon}</div>
                <div class="journal-entry-body">
                    <div class="journal-entry-preview">${preview}</div>
                    ${entry.tags.length > 0 ? `
                        <div class="journal-entry-meta">
                            <div class="journal-entry-tags">
                                ${entry.tags.map(tag => `
                                    <span class="journal-tag">#${UIUtils.escapeHtml(tag)}</span>
                                `).join('')}
                            </div>
                        </div>
                    ` : ''}
                </div>
                <div class="journal-entry-actions">
                    <button class="journal-action-btn edit-btn" data-entry-id="${entry.id}" title="Edit">&#9998;</button>
                    <button class="journal-action-btn delete-btn" data-entry-id="${entry.id}" title="Delete">&#215;</button>
                </div>
            </div>
        `;
    },

    /**
     * Render sidebar: filters, mood breakdown, tag cloud, stats
     * @param {Array} allEntries - All entries (unfiltered)
     */
    renderSidebar(allEntries) {
        this.renderFilterCounts(allEntries);
        this.renderMoodFilters(allEntries);
        this.renderTagCloud(allEntries);
        this.renderStats(allEntries);
    },

    /**
     * Render filter counts in sidebar
     */
    renderFilterCounts(entries) {
        const now = new Date();
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

        const allCount = entries.length;
        const weekCount = entries.filter(e => new Date(e.date) >= weekAgo).length;
        const monthCount = entries.filter(e => new Date(e.date) >= monthAgo).length;

        const countAll = document.getElementById('journal-count-all');
        const countWeek = document.getElementById('journal-count-week');
        const countMonth = document.getElementById('journal-count-month');

        if (countAll) countAll.textContent = allCount;
        if (countWeek) countWeek.textContent = weekCount;
        if (countMonth) countMonth.textContent = monthCount;

        // Setup filter click handlers
        const filterList = document.getElementById('journal-filter-list');
        if (filterList && !filterList.dataset.bound) {
            filterList.dataset.bound = 'true';
            filterList.addEventListener('click', (e) => {
                const item = e.target.closest('.journal-filter-item');
                if (!item) return;
                filterList.querySelectorAll('.journal-filter-item').forEach(i => i.classList.remove('active'));
                item.classList.add('active');
                JournalApp.filterBy = item.dataset.filter;
                // Clear mood and tag filters when switching date filter
                JournalApp.moodFilter = null;
                JournalApp.tagFilter = null;
                JournalApp.diaryIndex = 0;
                JournalApp.contentPage = 0;
                JournalApp.render();
            });
        }
    },

    /**
     * Render mood filter buttons
     */
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
                if (JournalApp.moodFilter === mood) {
                    JournalApp.moodFilter = null;
                } else {
                    JournalApp.moodFilter = mood;
                }
                JournalApp.diaryIndex = 0;
                JournalApp.contentPage = 0;
                JournalApp.render();
            });
        }
    },

    /**
     * Render tag cloud
     */
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
                if (JournalApp.tagFilter === tag) {
                    JournalApp.tagFilter = null;
                } else {
                    JournalApp.tagFilter = tag;
                }
                JournalApp.diaryIndex = 0;
                JournalApp.contentPage = 0;
                JournalApp.render();
            });
        }
    },

    /**
     * Render stats
     */
    renderStats(entries) {
        const container = document.getElementById('journal-stats');
        if (!container) return;

        const totalEntries = entries.length;

        // Calculate streak
        const streak = this.calculateStreak(entries);

        // Entries this month
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
                <span class="journal-stat-value">${totalEntries}</span>
                <span class="journal-stat-label">Total entries</span>
            </div>
        `;
    },

    /**
     * Calculate writing streak (consecutive days with entries)
     */
    calculateStreak(entries) {
        if (entries.length === 0) return 0;

        // Get unique dates (normalized to day)
        const dates = new Set();
        entries.forEach(e => {
            const d = new Date(e.date);
            dates.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
        });

        let streak = 0;
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const checkDate = new Date(today);
        // Check if today has an entry, otherwise start from yesterday
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
     * Strip HTML tags and get plain text
     * @param {string} html
     * @returns {string}
     */
    stripHtml(html) {
        const tmp = document.createElement('div');
        tmp.innerHTML = html;

        tmp.querySelectorAll('p, div, br, h1, h2, h3, li').forEach(el => {
            if (el.tagName === 'BR') {
                el.replaceWith('\n');
            } else {
                el.insertAdjacentText('afterend', '\n');
            }
        });

        return UIUtils.escapeHtml(tmp.textContent || tmp.innerText || '');
    },

    /**
     * Get mood information
     * @param {string} mood
     * @returns {Object}
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
    },

    /**
     * Render diary (book-style) view.
     * Shows a closed cover initially; once opened, shows a two-page
     * spread with one entry per spread and prev/next navigation.
     * @param {Array} entries - Filtered entries (sorted newest-first)
     */
    renderDiary(entries) {
        const container = document.getElementById('journal-diary-container');

        if (entries.length === 0) {
            container.innerHTML = '<div class="journal-diary-empty">No entries match the current filters.</div>';
            return;
        }

        // Clamp diaryIndex if it is out of range due to filter changes
        if (JournalApp.diaryIndex >= entries.length) {
            JournalApp.diaryIndex = 0;
        }
        if (JournalApp.diaryIndex < 0) {
            JournalApp.diaryIndex = 0;
        }

        if (!JournalApp.diaryOpen) {
            container.innerHTML = this.renderDiaryCover();
            this.attachDiaryCoverListeners();
            return;
        }

        if (JournalApp.diaryView === 'toc') {
            container.innerHTML = this.renderDiaryContents(entries);
            this.attachDiaryContentsListeners();
            return;
        }

        const entry = entries[JournalApp.diaryIndex];

        // Two-pass render so we can measure the real page-content
        // dimensions before paginating. First, render the spread with
        // empty content — this gives us the exact inner size of
        // .diary-page-content. Then compute pagination, pick the chunk
        // for the current contentPage, and patch it in.
        container.innerHTML = this.renderDiarySpread(entry, JournalApp.diaryIndex, entries.length, {
            chunkHtml: '',
            totalContentPages: 1,
            contentPage: 0
        });

        const contentEl = container.querySelector('.diary-page .diary-page-content');

        if (contentEl) {
            const w = contentEl.clientWidth;
            const h = contentEl.clientHeight;
            // Ignore sub-pixel zero readings (container hidden briefly)
            if (w > 0 && h > 0) {
                const pages = this.paginateEntryContent(entry, w, h);
                const totalContentPages = Math.max(1, pages.length);

                // Clamp contentPage into range
                if (JournalApp.contentPage < 0) JournalApp.contentPage = 0;
                if (JournalApp.contentPage >= totalContentPages) {
                    JournalApp.contentPage = totalContentPages - 1;
                }

                const chunk = pages[JournalApp.contentPage] || '';

                // Re-render with final chunk + footer pager controls
                container.innerHTML = this.renderDiarySpread(entry, JournalApp.diaryIndex, entries.length, {
                    chunkHtml: chunk,
                    totalContentPages,
                    contentPage: JournalApp.contentPage
                });
            }
        }

        this.attachDiarySpreadListeners();
    },

    /**
     * Render the closed diary cover.
     * @returns {string} HTML
     */
    renderDiaryCover() {
        return `
            <div class="diary-counter" aria-hidden="true">&nbsp;</div>
            <div class="diary-book">
                <div class="diary-cover" id="diary-cover" tabindex="0" role="button" aria-label="Open diary">
                    <div class="diary-cover-title">Journal</div>
                    <div class="diary-cover-rule"></div>
                    <div class="diary-cover-author">A. N. Jadhe</div>
                    <div class="diary-cover-hint">Click to open</div>
                </div>
            </div>
        `;
    },

    /**
     * Render the opened single-page diary view for one entry.
     *
     * Content is paginated upstream; this function just lays out the
     * provided chunk and renders the pager + footer metadata. Tags,
     * edit/delete, and prev/next entry controls always appear in the
     * footer regardless of content-page depth.
     *
     * @param {Object} entry
     * @param {number} index - Current entry index (0-based)
     * @param {number} total - Total entries in current filter
     * @param {Object} pageInfo
     * @param {string} pageInfo.chunkHtml - HTML for the page content
     * @param {number} pageInfo.totalContentPages - Number of pages for this entry
     * @param {number} pageInfo.contentPage - Current content-page index (0-based)
     * @returns {string} HTML
     */
    renderDiarySpread(entry, index, total, pageInfo) {
        const { chunkHtml, totalContentPages, contentPage } = pageInfo;

        const date = new Date(entry.date);
        const weekday = date.toLocaleDateString('en-US', { weekday: 'long' });
        const dateLabel = date.toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric'
        });
        const moodInfo = this.getMoodInfo(entry.mood);

        const tagsHtml = entry.tags && entry.tags.length > 0 ? `
            <div class="diary-page-tags">
                ${entry.tags.map(tag => `
                    <span class="diary-page-tag">#${UIUtils.escapeHtml(tag)}</span>
                `).join('')}
            </div>
        ` : '';

        // Entries ordered newest-first, so index 0 = newest.
        // "Older" arrow advances index (goes back in time);
        // "Newer" arrow decreases index (comes forward in time).
        const hasOlder = index < total - 1;
        const hasNewer = index > 0;

        const hasMoreContent = contentPage < totalContentPages - 1;
        const hasPrevContent = contentPage > 0;

        const continuedHtml = contentPage > 0
            ? `<span class="diary-page-header-continued">continued</span>`
            : '';

        const prevPagerHtml = hasPrevContent
            ? `<button class="diary-pager-link align-left" id="diary-prev-content-btn">&larr; Previous page</button>`
            : `<span></span>`;

        const nextPagerHtml = hasMoreContent
            ? `<button class="diary-pager-link" id="diary-next-content-btn">See more &rarr;</button>`
            : `<span></span>`;

        const pagerHtml = (hasPrevContent || hasMoreContent)
            ? `<div class="diary-page-pager">${prevPagerHtml}${nextPagerHtml}</div>`
            : '';

        const contentCounterLabel = totalContentPages > 1
            ? `Entry ${index + 1} of ${total} &middot; Page ${contentPage + 1} of ${totalContentPages}`
            : `Entry ${index + 1} of ${total}`;

        return `
            <button class="diary-close-btn" id="diary-close-btn" title="Close book">Close book</button>
            <div class="diary-counter">${contentCounterLabel}</div>
            <div class="diary-spread" id="diary-spread">
                <div class="diary-page">
                    <div class="diary-page-header">
                        <div class="diary-page-date">
                            <span class="diary-page-date-weekday">${weekday}</span>
                            ${dateLabel}
                            ${continuedHtml}
                        </div>
                        <div class="diary-page-header-right">
                            ${tagsHtml}
                            <div class="diary-page-mood" title="${moodInfo.label}">${moodInfo.icon}</div>
                        </div>
                    </div>
                    <div class="diary-page-content">${chunkHtml}</div>
                    <div class="diary-page-footer">
                        ${pagerHtml}
                        <div class="diary-page-actions">
                            <div class="diary-entry-actions">
                                <button class="diary-entry-action-btn" id="diary-edit-btn" data-entry-id="${entry.id}">Edit</button>
                                <button class="diary-entry-action-btn" id="diary-delete-btn" data-entry-id="${entry.id}">Delete</button>
                            </div>
                            <div class="diary-page-nav">
                                <button class="diary-page-nav-btn diary-page-nav-btn-wide" id="diary-toc-btn" title="Table of contents" aria-label="Table of contents">Contents</button>
                                <button class="diary-page-nav-btn" id="diary-older-btn" ${hasOlder ? '' : 'disabled'} title="Older entry" aria-label="Older entry">&#x2039;</button>
                                <button class="diary-page-nav-btn" id="diary-newer-btn" ${hasNewer ? '' : 'disabled'} title="Newer entry" aria-label="Newer entry">&#x203A;</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    },

    /**
     * Render the table of contents spread inside the book.
     * @param {Array} entries - Currently filtered entries
     * @returns {string} HTML
     */
    renderDiaryContents(entries) {
        const total = entries.length;
        const totalLabel = total === 1 ? '1 entry' : `${total} entries`;

        const groups = this.groupByMonth(entries);

        const groupsHtml = groups.map(group => {
            const rows = group.entries.map(entry => {
                const globalIndex = entries.indexOf(entry);
                const date = new Date(entry.date);
                const day = date.getDate();
                const weekday = date.toLocaleDateString('en-US', { weekday: 'short' });
                const moodInfo = this.getMoodInfo(entry.mood);
                const previewText = this.stripHtml(entry.content).trim().substring(0, 70);
                const isActive = globalIndex === JournalApp.diaryIndex;
                return `
                    <div class="diary-toc-entry${isActive ? ' active' : ''}" data-diary-index="${globalIndex}" role="button" tabindex="0">
                        <span class="diary-toc-day">${day}</span>
                        <span class="diary-toc-weekday">${weekday}</span>
                        <span class="diary-toc-mood" title="${moodInfo.label}">${moodInfo.icon}</span>
                        <span class="diary-toc-preview">${previewText || '<em>empty entry</em>'}</span>
                    </div>
                `;
            }).join('');
            return `
                <div class="diary-toc-month">
                    <div class="diary-toc-month-header">${group.label}</div>
                    ${rows}
                </div>
            `;
        }).join('');

        return `
            <button class="diary-close-btn" id="diary-close-btn" title="Close book">Close book</button>
            <div class="diary-counter">Contents &mdash; ${totalLabel}</div>
            <div class="diary-spread">
                <div class="diary-page diary-toc-page">
                    <div class="diary-toc-header">
                        <div class="diary-toc-title">Contents</div>
                        <button class="diary-entry-action-btn" id="diary-toc-back-btn">&larr; Back to entry</button>
                    </div>
                    <div class="diary-toc-list">
                        ${groupsHtml}
                    </div>
                </div>
            </div>
        `;
    },

    /**
     * Attach click/keyboard handlers for the TOC spread.
     */
    attachDiaryContentsListeners() {
        const closeBtn = document.getElementById('diary-close-btn');
        if (closeBtn) closeBtn.addEventListener('click', () => JournalApp.closeDiaryBook());

        const backBtn = document.getElementById('diary-toc-back-btn');
        if (backBtn) backBtn.addEventListener('click', () => JournalApp.hideDiaryContents());

        document.querySelectorAll('.diary-toc-entry').forEach(row => {
            const idx = parseInt(row.dataset.diaryIndex, 10);
            if (Number.isNaN(idx)) return;
            row.addEventListener('click', () => JournalApp.jumpToDiaryEntry(idx));
            row.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    JournalApp.jumpToDiaryEntry(idx);
                }
            });
        });
    },

    /**
     * Paginate an entry's HTML into fixed-size chunks that each fit
     * into a single diary page's content area.
     *
     * Strategy: render the source HTML into an off-screen measurer
     * with the exact page-content dimensions and typography. Walk
     * top-level children one at a time and move them into "bucket"
     * nodes until the measurer overflows; then finalize the bucket
     * and start a fresh one. For single nodes that are themselves
     * too tall to fit on any page, fall back to a binary-search
     * word split of their text content (preserving the wrapping
     * element's tag/attrs, but not inner markup — rare in journals).
     *
     * @param {Object} entry - Journal entry (uses id, modifiedAt, content)
     * @param {number} widthPx - Page content area width in pixels
     * @param {number} heightPx - Page content area height in pixels
     * @returns {string[]} Array of HTML chunks, one per page
     */
    paginateEntryContent(entry, widthPx, heightPx) {
        const cacheKey = `${entry.id}|${entry.modifiedAt}|${widthPx}x${heightPx}`;
        if (this._paginationCache.has(cacheKey)) {
            return this._paginationCache.get(cacheKey);
        }

        const html = (entry.content || '').trim();
        if (!html) {
            this._paginationCache.set(cacheKey, ['']);
            return [''];
        }

        const measurer = this._createContentMeasurer(widthPx, heightPx);
        const source = document.createElement('div');
        source.innerHTML = html;

        const pages = [];
        let bucket = document.createElement('div');
        measurer.appendChild(bucket);

        const fits = () => measurer.scrollHeight <= heightPx + 1;
        const resetBucket = () => {
            bucket = document.createElement('div');
            measurer.innerHTML = '';
            measurer.appendChild(bucket);
        };

        // Safety counter — an infinite loop here would freeze the UI
        let safety = 5000;

        while (source.firstChild && safety-- > 0) {
            const node = source.firstChild;
            source.removeChild(node);
            bucket.appendChild(node);

            if (fits()) continue;

            // This node overflowed the page. Take it out again.
            bucket.removeChild(node);

            if (bucket.children.length === 0) {
                // Single oversized node — try to split it by text
                const remainder = this._splitNodeByWords(node, measurer, bucket, heightPx);
                if (remainder) {
                    pages.push(bucket.innerHTML);
                    resetBucket();
                    source.insertBefore(remainder, source.firstChild);
                } else {
                    // Couldn't split (no text content) — place alone and
                    // accept the overflow
                    bucket.appendChild(node);
                    pages.push(bucket.innerHTML);
                    resetBucket();
                }
            } else {
                // Finalize the current bucket and retry this node on a
                // fresh page
                pages.push(bucket.innerHTML);
                resetBucket();
                source.insertBefore(node, source.firstChild);
            }
        }

        if (bucket.innerHTML.trim() !== '') {
            pages.push(bucket.innerHTML);
        }
        if (pages.length === 0) {
            pages.push('');
        }

        document.body.removeChild(measurer);
        this._paginationCache.set(cacheKey, pages);
        return pages;
    },

    /**
     * Create a hidden measuring container with the same typography
     * and dimensions as a real .diary-page-content area.
     */
    _createContentMeasurer(widthPx, heightPx) {
        const m = document.createElement('div');
        m.style.cssText = `
            position: fixed;
            left: -99999px;
            top: 0;
            width: ${widthPx}px;
            max-width: ${widthPx}px;
            min-width: ${widthPx}px;
            height: auto;
            font-family: 'Inter', var(--font-sans);
            font-size: 16px;
            line-height: 34px;
            padding: 0;
            margin: 0;
            box-sizing: border-box;
            visibility: hidden;
            word-wrap: break-word;
            overflow-wrap: break-word;
        `;
        // Apply the same child-element styles as .diary-page-content by
        // setting class on an inner wrapper — but measurer needs no
        // class; inline styles above suffice for text measurement.
        document.body.appendChild(m);
        return m;
    },

    /**
     * Binary-search split an oversized element node by words. Returns
     * a new node containing the leftover words, or null if even one
     * word doesn't fit. The original node is emptied and left in the
     * bucket as the "fit" portion.
     */
    _splitNodeByWords(node, measurer, bucket, maxHeight) {
        if (node.nodeType !== 1) return null;
        const text = node.textContent || '';
        if (!text.trim()) return null;

        const tokens = text.split(/(\s+)/); // keep whitespace tokens
        const clone = node.cloneNode(false);
        bucket.appendChild(clone);

        let lo = 0;
        let hi = tokens.length;
        let best = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            clone.textContent = tokens.slice(0, mid).join('');
            if (measurer.scrollHeight <= maxHeight + 1) {
                best = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }

        if (best === 0) {
            bucket.removeChild(clone);
            return null;
        }

        clone.textContent = tokens.slice(0, best).join('');
        const remainder = node.cloneNode(false);
        remainder.textContent = tokens.slice(best).join('');
        return remainder;
    },

    /**
     * Drop cached pagination for a given entry (call on save/delete).
     */
    invalidatePaginationCache(entryId) {
        if (!entryId) {
            this._paginationCache.clear();
            return;
        }
        for (const key of this._paginationCache.keys()) {
            if (key.startsWith(`${entryId}|`)) {
                this._paginationCache.delete(key);
            }
        }
    },

    /**
     * Attach click handler to the closed cover so tapping it opens the book.
     */
    attachDiaryCoverListeners() {
        const cover = document.getElementById('diary-cover');
        if (!cover) return;
        cover.addEventListener('click', () => JournalApp.openDiaryBook());
        cover.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                JournalApp.openDiaryBook();
            }
        });
    },

    /**
     * Attach click handlers for the opened spread: close, prev/next,
     * edit, delete.
     */
    attachDiarySpreadListeners() {
        const closeBtn = document.getElementById('diary-close-btn');
        if (closeBtn) closeBtn.addEventListener('click', () => JournalApp.closeDiaryBook());

        const olderBtn = document.getElementById('diary-older-btn');
        if (olderBtn) olderBtn.addEventListener('click', () => JournalApp.navigateDiary(1));

        const newerBtn = document.getElementById('diary-newer-btn');
        if (newerBtn) newerBtn.addEventListener('click', () => JournalApp.navigateDiary(-1));

        const tocBtn = document.getElementById('diary-toc-btn');
        if (tocBtn) tocBtn.addEventListener('click', () => JournalApp.showDiaryContents());

        const nextContentBtn = document.getElementById('diary-next-content-btn');
        if (nextContentBtn) nextContentBtn.addEventListener('click', () => JournalApp.navigateContent(1));

        const prevContentBtn = document.getElementById('diary-prev-content-btn');
        if (prevContentBtn) prevContentBtn.addEventListener('click', () => JournalApp.navigateContent(-1));

        const editBtn = document.getElementById('diary-edit-btn');
        if (editBtn) editBtn.addEventListener('click', () => {
            JournalApp.openEditor(editBtn.dataset.entryId);
        });

        const deleteBtn = document.getElementById('diary-delete-btn');
        if (deleteBtn) deleteBtn.addEventListener('click', () => {
            JournalApp.deleteEntry(deleteBtn.dataset.entryId);
        });
    },

    /**
     * Attach event listeners to entries
     */
    attachEventListeners() {
        document.querySelectorAll('.journal-entry').forEach(entry => {
            entry.addEventListener('click', (e) => {
                if (e.target.closest('.journal-entry-actions')) return;
                const entryId = entry.dataset.entryId;
                JournalApp.openViewer(entryId);
            });
        });

        document.querySelectorAll('.journal-entry .edit-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const entryId = btn.dataset.entryId;
                JournalApp.openEditor(entryId);
            });
        });

        document.querySelectorAll('.journal-entry .delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const entryId = btn.dataset.entryId;
                JournalApp.deleteEntry(entryId);
            });
        });
    }
};
