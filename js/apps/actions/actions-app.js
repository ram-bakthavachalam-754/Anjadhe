/**
 * Actions App — the front door of the Focus → Goals → Tasks framework.
 *
 * Two tabs only (docs/POSITIONING.md "Part 1: Actions"): TASKS — this view,
 * a left nav of time slices (Today / Tomorrow / This Week / This Month) and
 * focus areas, with the selected task list on the right — and PLAN (the
 * Focus workspace: areas → goals → tasks). Today keeps its role as the
 * front door: it is the default selection, and quick add, calendar events,
 * assistant filing suggestions, and the weekly review all live here.
 * Actions is a frontend over EXISTING synced data: it owns no storage key,
 * and the `schedule` / `goals` / `focus` / `links` blobs are untouched
 * ("rename the surface, not the keys").
 *
 * Nav items are also drop targets: drag a task row onto a focus area to
 * file it there, or onto Today / Tomorrow to reschedule it.
 */

const ActionsApp = {
    _bound: false,
    _completedExpanded: false,   // in-memory only: "N done" disclosure
    _view: 'tasks',              // 'tasks' | 'review' (weekly review flow)
    // Left-nav selection: a time slice or a focus area. Per-window state
    // (sessionStorage) so Cmd+R restores it, like the Plan view state.
    _sel: { type: 'time', id: 'today' },
    _selKey: 'anjadhe.actions.selection',
    REVIEW_DUE_DAYS: 7,
    CALENDAR_STALE_MS: 15 * 60 * 1000,
    // Assistant filing: unfiled/undated actions per batched LLM call.
    FILING_AI_BATCH: 20,
    _filing: false,
    // Repeat kinds that recur on a day rhythm — expanded per-day in the
    // week view, but kept OUT of the month view (a daily habit × 25 rows
    // would drown the one-time work; same call schedule's Upcoming makes).
    DAY_REPEATS: ['daily', 'weekdays', 'weekly', 'custom'],

    init() {
        this._ensureData();
        this._restoreSel();
        this._bindOnce();
        NavResizer.attach({
            layoutSel: '#actions-view .actions-layout',
            resizerId: 'actions-nav-resizer',
            cssVar: '--actions-nav-width',
            storageKey: 'actions-nav-width',
            defaultW: 188,
        });
    },

    /**
     * Apps init lazily on first openApp, so when Actions is the first thing
     * opened, ScheduleApp/CalendarApp have never loaded. Both loadData()s are
     * cheap synchronous reads and idempotent, so hydrate on every render
     * (same defensive pattern CalendarApp.render uses for ScheduleApp).
     */
    _ensureData() {
        ScheduleApp.loadData();
        CalendarApp.loadData();
    },

    _openTaskId: null,   // inline task detail open in the right pane

    _restoreSel() {
        try {
            const raw = window.sessionStorage.getItem(this._selKey);
            if (!raw) return;
            const s = JSON.parse(raw);
            if (s && (s.type === 'time' || s.type === 'focus') && s.id) this._sel = s;
        } catch (_) {}
    },

    select(sel) {
        this._closeInlineTask();
        this._sel = sel;
        this._view = 'tasks';
        this._completedExpanded = false;
        try { window.sessionStorage.setItem(this._selKey, JSON.stringify(sel)); } catch (_) {}
        this.render();
    },

    render() {
        this._ensureData();

        // A selected focus area may have been deleted (or synced away).
        if (this._sel.type === 'focus' && !this._focusArea(this._sel.id)) {
            this._sel = { type: 'time', id: 'today' };
        }

        this._syncViewChrome();

        if (this._view === 'review') {
            Breadcrumb.render('actions-breadcrumb', [
                { label: 'Actions', action: () => this.showToday() },
                { label: 'Weekly Review' }
            ]);
            ActionsReview.render();
            return;
        }

        // Inline task detail: keep it up while the editor is genuinely open
        // in our host (renders fired by background passes must not tear it
        // down). Adopt whatever task the editor holds — Duplicate switches
        // it to the copy in place. When the editor closed (back crumb,
        // delete), fall through to the list.
        if (this._openTaskId) {
            const host = document.getElementById('actions-task-detail');
            if (ScheduleApp.currentItemId && ScheduleApp._embedHost === host) {
                this._openTaskId = ScheduleApp.currentItemId;
                this._renderNav();
                const item = ScheduleApp.scheduleItems.find(i => i.id === this._openTaskId);
                Breadcrumb.render('actions-breadcrumb', [
                    { label: 'Actions', action: () => this.showToday() },
                    { label: this._selLabel(), action: () => this.showTasks() },
                    { label: item ? item.title : 'Task' }
                ]);
                return;
            }
            this._closeInlineTask();
            this._syncViewChrome();
        }

        this._renderNav();
        Breadcrumb.render('actions-breadcrumb', [
            { label: 'Actions', action: () => this.showToday() },
            { label: this._selLabel() }
        ]);

        if (this._sel.type === 'focus') {
            this._renderAreaView();
            return;
        }
        if (this._sel.id === 'later') {
            this._renderLaterView();
            return;
        }
        if (this._sel.id !== 'today') {
            this._renderRangeView();
            return;
        }

        // --- Today: the front door, unchanged in substance ---
        // Both flags false: the Tasks app keeps its sidebar filter and search
        // in memory, and Today must never silently inherit them.
        const groups = ScheduleApp.getGroupedItems({ applySidebarFilter: false, applySearch: false });
        const events = this._todayEvents();

        this._renderDateLine(groups, events);
        this._renderList(groups);
        this._renderEvents(events);
        this._maybeBackgroundSync();
        // Assistant filing runs behind the paint, like the email bundle pass.
        setTimeout(() => this._fileActions(), 800);
    },

    _selLabel() {
        if (this._sel.type === 'focus') {
            const area = this._focusArea(this._sel.id);
            return area ? area.title : 'Focus area';
        }
        return { today: 'Today', tomorrow: 'Tomorrow', week: 'This Week', month: 'This Month', later: 'Later' }[this._sel.id] || 'Today';
    },

    _focusAreas() {
        return ProfileManager.filterByActiveProfile((StorageManager.get('focus')?.focusItems) || []);
    },

    _focusArea(id) {
        return this._focusAreas().find(f => f.id === id) || null;
    },

    // Show/hide the list vs task-detail vs review chrome. The left nav
    // stays up for the inline task detail — only the review hides it.
    _syncViewChrome() {
        const inReview = this._view === 'review';
        const inTask = !inReview && !!this._openTaskId;
        for (const id of ['actions-date-line', 'actions-today-container', 'actions-events-container']) {
            const el = document.getElementById(id);
            if (el) el.style.display = (inReview || inTask) ? 'none' : '';
        }
        const nav = document.getElementById('actions-nav');
        if (nav) nav.style.display = inReview ? 'none' : '';
        const quickAdd = document.querySelector('#actions-view .actions-quick-add-wrap');
        if (quickAdd) quickAdd.style.display = (inReview || inTask) ? 'none' : '';
        const review = document.getElementById('actions-review-container');
        if (review) review.style.display = inReview ? '' : 'none';
        const taskHost = document.getElementById('actions-task-detail');
        if (taskHost) taskHost.style.display = inTask ? '' : 'none';
        document.querySelectorAll('#actions-view .actions-hub-btn').forEach(btn => {
            btn.classList.toggle('is-active', btn.dataset.dest === 'tasks');
        });
    },

    // The Tasks tab, on the Today selection (the front door + review exit).
    showToday() {
        this._closeInlineTask();
        this._view = 'tasks';
        this._sel = { type: 'time', id: 'today' };
        this.render();
    },

    showTasks() {
        this._closeInlineTask();
        this._view = 'tasks';
        this.render();
    },

    showReview() {
        this._closeInlineTask();
        this._view = 'review';
        ActionsReview.start();
        this.render();
    },

    // Review is "due" after 7 days — surfaced as a quiet link, never a nag.
    _reviewDue() {
        const last = StorageManager.get('actionsSettings')?.lastReviewAt;
        if (!last) return true;
        return (Date.now() - new Date(last).getTime()) > this.REVIEW_DUE_DAYS * 86400000;
    },

    // --- Left nav (time slices + focus areas) ---

    _renderNav() {
        const nav = document.getElementById('actions-nav');
        if (!nav) return;
        const counts = this._navCounts();
        const isSel = (type, id) => this._sel.type === type && this._sel.id === id;

        const timeItems = [
            { id: 'today', label: 'Today', count: counts.today, drop: 'date:today' },
            { id: 'tomorrow', label: 'Tomorrow', count: counts.tomorrow, drop: 'date:tomorrow' },
            { id: 'week', label: 'This Week', count: counts.week, drop: null },
            { id: 'month', label: 'This Month', count: counts.month, drop: null },
            { id: 'later', label: 'Later', count: counts.later, drop: null },
        ];
        let html = '<div class="actions-nav-section">' + timeItems.map(t => `
            <button type="button" class="actions-nav-item${isSel('time', t.id) ? ' is-active' : ''}"
                    data-nav-time="${t.id}"${t.drop ? ` data-drop="${t.drop}"` : ''}>
                <span class="actions-nav-label">${t.label}</span>
                ${t.count ? `<span class="actions-nav-count">${t.count}</span>` : ''}
            </button>`).join('') + '</div>';

        // Focus areas, under their group labels when the user has named
        // groups (a single Ungrouped bucket needs no label). Reads straight
        // from storage so the nav works even if the Plan app never
        // initialized this session. Areas link to Plan for editing.
        const areas = this._focusAreas();
        if (areas.length > 0) {
            const byGroup = new Map();
            for (const a of areas) {
                const g = (typeof a.group === 'string' && a.group.trim()) || '';
                if (!byGroup.has(g)) byGroup.set(g, []);
                byGroup.get(g).push(a);
            }
            const named = [...byGroup.keys()].filter(g => g !== '');
            const order = [...named, ...(byGroup.has('') ? [''] : [])];
            const showLabels = named.length > 0;

            html += '<div class="actions-nav-header">Focus areas</div>';
            for (const g of order) {
                if (showLabels) html += `<div class="actions-nav-group">${UIUtils.escapeHtml(g || 'Ungrouped')}</div>`;
                html += byGroup.get(g).map(a => `
                    <button type="button" class="actions-nav-item actions-nav-area${isSel('focus', a.id) ? ' is-active' : ''}"
                            data-nav-focus="${a.id}" data-drop="focus:${a.id}" title="${UIUtils.escapeHtml(a.title)}">
                        <span class="actions-nav-dot" style="background:${a.color || '#4A90A4'}"></span>
                        <span class="actions-nav-label">${UIUtils.escapeHtml(a.title)}</span>
                        ${counts.areas.get(a.id) ? `<span class="actions-nav-count">${counts.areas.get(a.id)}</span>` : ''}
                    </button>`).join('');
            }
        }

        nav.innerHTML = html;
    },

    _navCounts() {
        const groups = ScheduleApp.getGroupedItems({ applySidebarFilter: false, applySearch: false });
        const later = this._laterItems();
        const counts = {
            today: groups.overdue.length + groups.todayActive.length,
            tomorrow: this._rangeItems('tomorrow').total,
            week: this._rangeItems('week').total,
            month: this._rangeItems('month').total,
            later: later.total,
            areas: new Map(),
        };
        // Per-area open-task counts from the direct focus links.
        const { taskFocus } = ScheduleApp.buildTaskLinkIndex();
        for (const item of ProfileManager.filterByActiveProfile(ScheduleApp.scheduleItems)) {
            const set = taskFocus.get(item.id);
            if (!set || TaskListUI.isCompleted(item)) continue;
            for (const fid of set) counts.areas.set(fid, (counts.areas.get(fid) || 0) + 1);
        }
        return counts;
    },

    // --- Time-slice data (Tomorrow / This Week / This Month) ---

    _isoOf(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },

    _isoAddDays(iso, n) {
        const d = new Date(iso + 'T00:00:00');
        d.setDate(d.getDate() + n);
        return this._isoOf(d);
    },

    // The literal calendar reading: This Week = today through the coming
    // Sunday, This Month = today through the month's last day.
    _rangeDates(id) {
        const today = ScheduleApp.getLocalToday();
        if (id === 'tomorrow') return [this._isoAddDays(today, 1)];
        const d = new Date(today + 'T00:00:00');
        let end;
        if (id === 'week') {
            end = this._isoAddDays(today, (7 - d.getDay()) % 7);
        } else {
            end = this._isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 0));
        }
        const dates = [];
        for (let iso = today; iso <= end; iso = this._isoAddDays(iso, 1)) dates.push(iso);
        return dates;
    },

    // Open items occurring on a date: one-time tasks dated there (not yet
    // resolved) plus recurring occurrences (today's already-done ones drop).
    _openItemsOn(dateStr, { includeDayRepeats = true } = {}) {
        const today = ScheduleApp.getLocalToday();
        return ProfileManager.filterByActiveProfile(ScheduleApp.scheduleItems).filter(item => {
            if (!item.title) return false;
            const repeating = item.repeat && item.repeat !== 'none';
            if (!repeating) {
                return item.scheduledDate === dateStr
                    && !item.lastCompletedDate
                    && !ScheduleApp.lastAbandonedDate(item);
            }
            if (!includeDayRepeats && this.DAY_REPEATS.includes(item.repeat)) return false;
            if (!ScheduleApp.occursOn(item, dateStr)) return false;
            if (dateStr === today && (ScheduleApp.isCompletedToday(item) || ScheduleApp.isAbandonedToday(item))) return false;
            return true;
        }).sort((a, b) => this._startMins(a) - this._startMins(b));
    },

    _rangeItems(id) {
        const includeDayRepeats = id !== 'month';
        const days = this._rangeDates(id)
            .map(date => ({ date, items: this._openItemsOn(date, { includeDayRepeats }) }))
            .filter(d => d.items.length > 0);
        return { days, total: days.reduce((n, d) => n + d.items.length, 0) };
    },

    _renderRangeView() {
        const { days, total } = this._rangeItems(this._sel.id);
        const today = ScheduleApp.getLocalToday();
        const tomorrow = this._isoAddDays(today, 1);

        this._renderHeadLine(this._selLabel(), [`${total} to do`]);

        const container = document.getElementById('actions-today-container');
        if (container) {
            let html = '';
            for (const day of days) {
                const heading = day.date === today ? 'Today'
                    : day.date === tomorrow ? 'Tomorrow'
                    : ScheduleUI.formatLaterDateHeading(day.date, today);
                html += `
                    <div class="actions-section">
                        <div class="actions-section-header">${UIUtils.escapeHtml(heading)} <span class="actions-section-count">${day.items.length}</span></div>
                        ${day.items.map(item => this._renderRow(item, {})).join('')}
                    </div>`;
            }
            if (days.length === 0) {
                html = `<div class="actions-empty">Nothing scheduled for ${this._selLabel().toLowerCase()}. Add an action above, or open Plan to line up your goals.</div>`;
            } else if (this._sel.id === 'month'
                && ProfileManager.filterByActiveProfile(ScheduleApp.scheduleItems).some(i => this.DAY_REPEATS.includes(i.repeat))) {
                html += '<div class="actions-range-note">Daily and weekly repeating tasks show in Today and This Week.</div>';
            }
            container.innerHTML = html;
        }
        const events = document.getElementById('actions-events-container');
        if (events) events.innerHTML = '';
    },

    // --- Later view (beyond this month + the undated backlog) ---

    // Dated beyond the current month: one-time tasks past month-end, plus
    // monthly/annual repeats whose next occurrence is past it (day-based
    // repeats stay in Today/This Week, as in the month view). Undated
    // one-time tasks form the "No date" backlog beneath.
    _laterItems() {
        const today = ScheduleApp.getLocalToday();
        const d = new Date(today + 'T00:00:00');
        const monthEnd = this._isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 0));

        const dated = [];
        const noDate = [];
        for (const item of ProfileManager.filterByActiveProfile(ScheduleApp.scheduleItems)) {
            if (!item.title) continue;
            const repeating = item.repeat && item.repeat !== 'none';
            if (repeating) {
                if (this.DAY_REPEATS.includes(item.repeat)) continue;
                const next = ScheduleApp.nextOccurrenceDate(item, today);
                if (next && next > monthEnd) dated.push({ item, date: next });
                continue;
            }
            if (item.lastCompletedDate || ScheduleApp.lastAbandonedDate(item)) continue;
            if (!item.scheduledDate) noDate.push(item);
            else if (item.scheduledDate > monthEnd) dated.push({ item, date: item.scheduledDate });
        }
        dated.sort((a, b) => a.date.localeCompare(b.date) || this._startMins(a.item) - this._startMins(b.item));
        noDate.sort((a, b) => (a.title || '').localeCompare(b.title || ''));

        // Group the dated ones by month for scannable headings.
        const months = [];
        for (const entry of dated) {
            const key = entry.date.slice(0, 7);
            let bucket = months[months.length - 1];
            if (!bucket || bucket.key !== key) {
                const md = new Date(entry.date + 'T00:00:00');
                bucket = { key, label: md.toLocaleDateString([], { month: 'long', year: 'numeric' }), entries: [] };
                months.push(bucket);
            }
            bucket.entries.push(entry);
        }
        return { months, noDate, total: dated.length + noDate.length };
    },

    _renderLaterView() {
        const { months, noDate, total } = this._laterItems();
        const today = ScheduleApp.getLocalToday();
        this._renderHeadLine('Later', [`${total} to do`]);

        const container = document.getElementById('actions-today-container');
        if (container) {
            let html = '';
            for (const m of months) {
                html += `
                    <div class="actions-section">
                        <div class="actions-section-header">${UIUtils.escapeHtml(m.label)} <span class="actions-section-count">${m.entries.length}</span></div>
                        ${m.entries.map(({ item, date }) =>
                            this._renderRow(item, { dateLabel: ScheduleUI.formatRelativeDate(date, today) })).join('')}
                    </div>`;
            }
            if (noDate.length > 0) {
                html += `
                    <div class="actions-section">
                        <div class="actions-section-header">No date <span class="actions-section-count">${noDate.length}</span></div>
                        ${noDate.map(item => this._renderRow(item, {})).join('')}
                    </div>`;
            }
            if (!html) {
                html = '<div class="actions-empty">Nothing scheduled beyond this month, and no undated backlog. Clean horizon.</div>';
            }
            container.innerHTML = html;
        }
        const events = document.getElementById('actions-events-container');
        if (events) events.innerHTML = '';
    },

    // --- Focus-area view ---

    _renderAreaView() {
        const area = this._focusArea(this._sel.id);
        const subtree = ScheduleApp.getFocusSubtreeIds(area.id, this._focusAreas());
        const { taskFocus, taskGoals } = ScheduleApp.buildTaskLinkIndex();
        const linked = ProfileManager.filterByActiveProfile(ScheduleApp.scheduleItems).filter(item => {
            const set = taskFocus.get(item.id);
            if (!set) return false;
            for (const fid of set) if (subtree.has(fid)) return true;
            return false;
        });

        const today = ScheduleApp.getLocalToday();
        const byUrgency = (a, b) =>
            (a.scheduledDate || '9999').localeCompare(b.scheduledDate || '9999')
            || this._startMins(a) - this._startMins(b)
            || (a.title || '').localeCompare(b.title || '');
        const done = linked.filter(i => TaskListUI.isCompleted(i, today));
        const todo = linked.filter(i => !TaskListUI.isCompleted(i, today)).sort(byUrgency);

        // Group open tasks under the area's goals (status-sorted, same order
        // as Plan), with a "No goal" bucket for loose ones — the area view
        // reads as a mini plan, not a flat pile.
        const goals = LinkManager.getGoalsForFocus(area.id);
        const buckets = goals.map(g => ({ goal: g, items: [] }));
        const byGoalId = new Map(buckets.map(b => [b.goal.itemId, b]));
        const loose = [];
        for (const item of todo) {
            const gset = taskGoals.get(item.id);
            let placed = null;
            if (gset) for (const gid of gset) { if (byGoalId.has(gid)) { placed = byGoalId.get(gid); break; } }
            if (placed) placed.items.push(item);
            else loose.push(item);
        }
        const goalSections = buckets.filter(b => b.items.length > 0);

        this._renderHeadLine(area.title, [`${todo.length} to do`], {
            dotColor: area.color || '#4A90A4',
            trailing: '<button class="actions-review-nudge" id="actions-open-plan" title="Open this focus area in Plan">Open in Plan &#8594;</button>',
        });

        const container = document.getElementById('actions-today-container');
        if (container) {
            const row = (item) => {
                const repeating = item.repeat && item.repeat !== 'none';
                const dateLabel = repeating
                    ? ScheduleUI.getRepeatLabel(item)
                    : (item.scheduledDate ? ScheduleUI.formatRelativeDate(item.scheduledDate, today) : '');
                const late = !repeating && item.scheduledDate && item.scheduledDate < today;
                // The section header already names the goal — a per-row goal
                // chip would repeat it down every line.
                return this._renderRow(item, { dateLabel, late, noGoalChip: true });
            };
            let html = '';
            for (const { goal, items } of goalSections) {
                html += `
                    <div class="actions-section">
                        <button class="actions-section-header actions-goal-heading" data-open-goal="${goal.itemId}" title="Open this goal in Plan">
                            <span class="ftree-gdot ${goal.status || 'not-started'}"></span>
                            ${UIUtils.escapeHtml(goal.title)} <span class="actions-section-count">${items.length}</span>
                        </button>
                        ${items.map(row).join('')}
                    </div>`;
            }
            if (loose.length > 0) {
                // Alone it needs no label; next to goal sections it does.
                const label = goalSections.length > 0 ? 'No goal' : 'To do';
                html += `
                    <div class="actions-section">
                        <div class="actions-section-header">${label} <span class="actions-section-count">${loose.length}</span></div>
                        ${loose.map(item => this._renderRow(item, {
                            dateLabel: (item.repeat && item.repeat !== 'none')
                                ? ScheduleUI.getRepeatLabel(item)
                                : (item.scheduledDate ? ScheduleUI.formatRelativeDate(item.scheduledDate, today) : ''),
                            late: !(item.repeat && item.repeat !== 'none') && item.scheduledDate && item.scheduledDate < today,
                        })).join('')}
                    </div>`;
            }
            if (todo.length === 0) {
                html += `<div class="actions-empty">No open tasks in ${UIUtils.escapeHtml(area.title)}. Add one above &mdash; it files here automatically.</div>`;
            }
            if (done.length > 0) {
                html += `
                    <div class="actions-section">
                        <button class="actions-completed-toggle" id="actions-completed-toggle" aria-expanded="${this._completedExpanded}">
                            ${this._completedExpanded ? '&#9662;' : '&#9656;'} ${done.length} done
                        </button>
                        ${this._completedExpanded
                            ? done.map(item => this._renderRow(item, { completed: true })).join('')
                            : ''}
                    </div>`;
            }
            container.innerHTML = html;
        }
        const events = document.getElementById('actions-events-container');
        if (events) events.innerHTML = '';
    },

    // --- Data helpers ---

    // Google events only: getEventsForDate also returns schedule-task
    // pseudo-events (source 'schedule', no account) — those are already
    // rendered as action rows, so keeping them here would duplicate tasks.
    _todayEvents() {
        if (CalendarApp.getAccounts().length === 0) return [];
        return CalendarApp.getEventsForDate(new Date()).filter(e => e.account);
    },

    // --- Rendering ---

    // Head line for non-Today selections: same hero treatment, no review link.
    _renderHeadLine(title, summaryParts, { dotColor = null, trailing = '' } = {}) {
        const el = document.getElementById('actions-date-line');
        if (!el) return;
        el.innerHTML = `<span class="actions-date">${dotColor ? `<span class="actions-nav-dot actions-date-dot" style="background:${dotColor}"></span>` : ''}${UIUtils.escapeHtml(title)}</span>` +
            `<span class="actions-date-summary">${UIUtils.escapeHtml(summaryParts.join(' · '))}</span>` +
            trailing;
    },

    _renderDateLine(groups, events) {
        const el = document.getElementById('actions-date-line');
        if (!el) return;
        const today = new Date();
        const dateStr = today.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
        const parts = [];
        const open = groups.todayActive.length + groups.overdue.length;
        parts.push(`${open} to do`);
        if (groups.todayCompleted.length) parts.push(`${groups.todayCompleted.length} done`);
        if (events.length) parts.push(`${events.length} event${events.length === 1 ? '' : 's'}`);
        // Review's permanent home: a quiet right-aligned link on Today's date
        // line, slightly emphasized once a review is due.
        el.innerHTML = `<span class="actions-date">${UIUtils.escapeHtml(dateStr)}</span>` +
            `<span class="actions-date-summary">${UIUtils.escapeHtml(parts.join(' · '))}</span>` +
            `<button class="actions-review-nudge${this._reviewDue() ? ' is-due' : ''}" id="actions-review-nudge">Weekly review &#8594;</button>`;
    },

    _renderList(groups) {
        const container = document.getElementById('actions-today-container');
        if (!container) return;
        const todayStr = ScheduleApp.getLocalToday();
        let html = '';

        if (groups.overdue.length > 0) {
            html += `
                <div class="actions-section">
                    <div class="actions-section-header actions-section-overdue">Overdue <span class="actions-section-count">${groups.overdue.length}</span>
                        <button class="actions-overdue-pushall" id="actions-overdue-pushall" title="Move all overdue tasks to today">Push to today</button>
                    </div>
                    ${this._renderOverdueGroups(groups.overdue, todayStr)}
                </div>`;
        }

        if (groups.todayActive.length > 0) {
            // Timed items read as a chronology (sorted by start, or end for
            // deadline-only items); untimed ones sink into their own quiet
            // "Anytime" block instead of interleaving.
            const timed = groups.todayActive
                .filter(i => i.startTime || i.endTime)
                .sort((a, b) => this._startMins(a) - this._startMins(b));
            const untimed = groups.todayActive.filter(i => !i.startTime && !i.endTime);
            if (timed.length > 0) {
                html += `
                <div class="actions-section">
                    <div class="actions-section-header">Today</div>
                    ${timed.map(item => this._renderRow(item, {})).join('')}
                </div>`;
            }
            if (untimed.length > 0) {
                html += `
                <div class="actions-section">
                    <div class="actions-section-header">${timed.length > 0 ? 'Anytime' : 'Today'} <span class="actions-section-count">${untimed.length}</span></div>
                    ${untimed.map(item => this._renderRow(item, {})).join('')}
                </div>`;
            }
        } else if (groups.overdue.length === 0) {
            const doneCount = groups.todayCompleted.length;
            html += `
                <div class="actions-empty">
                    ${doneCount > 0
                        ? `All clear for today &mdash; ${doneCount} action${doneCount === 1 ? '' : 's'} done. Well played.`
                        : 'Nothing scheduled for today. Add an action above, or open Plan to line up your goals.'}
                </div>`;
        }

        if (groups.todayCompleted.length > 0) {
            const n = groups.todayCompleted.length;
            html += `
                <div class="actions-section">
                    <button class="actions-completed-toggle" id="actions-completed-toggle" aria-expanded="${this._completedExpanded}">
                        ${this._completedExpanded ? '&#9662;' : '&#9656;'} ${n} done today
                    </button>
                    ${this._completedExpanded
                        ? groups.todayCompleted.map(item => this._renderRow(item, { completed: true })).join('')
                        : ''}
                </div>`;
        }

        // Assistant suggestions for actions NOT already on screen (unfiled
        // mail-derived or backlog items usually sit in Later/no-date). Rows
        // shown above carry their chips inline instead.
        const onScreen = new Set([
            ...groups.overdue, ...groups.todayActive, ...groups.todayCompleted,
        ].map(i => i.id));
        const suggested = this._pendingSuggestionItems().filter(i => !onScreen.has(i.id));
        if (suggested.length > 0) {
            const todayStr2 = ScheduleApp.getLocalToday();
            html += `
                <div class="actions-section">
                    <div class="actions-section-header">Assistant suggestions <span class="actions-section-count">${suggested.length}</span></div>
                    ${suggested.map(item => this._renderRow(item, {
                        dateLabel: item.scheduledDate ? ScheduleUI.formatRelativeDate(item.scheduledDate, todayStr2) : ''
                    })).join('')}
                </div>`;
        }

        container.innerHTML = html;
    },

    // Numeric sort key — stored times aren't reliably zero-padded
    // ("2:00" vs "02:00"), so string comparison mis-orders them. Deadline-only
    // items sort by their end time.
    _startMins(item) {
        const t = item.startTime || item.endTime;
        if (!t) return -1;
        const [h, m] = String(t).split(':').map(Number);
        return (h || 0) * 60 + (m || 0);
    },

    // Overdue subgroups by the date each item was due, so the day is said once
    // as a heading instead of repeated down every row — and the row gutter is
    // free to hold the time alone. Oldest first; recurring items with no
    // scheduledDate sink to the bottom.
    _renderOverdueGroups(items, todayStr) {
        const byDate = new Map();
        for (const item of items) {
            const key = item.scheduledDate || '';
            if (!byDate.has(key)) byDate.set(key, []);
            byDate.get(key).push(item);
        }
        const dates = [...byDate.keys()].sort((a, b) =>
            a === '' ? 1 : b === '' ? -1 : a.localeCompare(b));

        return dates.map(date => {
            const rows = byDate.get(date).sort((a, b) => this._startMins(a) - this._startMins(b));
            const heading = date ? this._overdueHeading(date, todayStr) : 'No date';
            return `
                <div class="actions-date-group">
                    <div class="actions-date-heading">${UIUtils.escapeHtml(heading)}</div>
                    ${rows.map(item => this._renderRow(item, { overdue: true })).join('')}
                </div>`;
        }).join('');
    },

    // "Yesterday" for the common case, an explicit weekday+date beyond that —
    // "6 days ago" is harder to act on than "Friday, Jul 10" when replanning.
    _overdueHeading(dateStr, todayStr) {
        const date = new Date(dateStr + 'T00:00:00');
        const today = new Date(todayStr + 'T00:00:00');
        const diffDays = Math.round((date - today) / 86400000);
        if (diffDays === -1) return 'Yesterday';
        return ScheduleUI.formatLaterDateHeading(dateStr, todayStr);
    },

    // Pending assistant suggestions render as tentative "?" chips with
    // one-tap confirm/dismiss — filing is always explicit, never silent.
    _renderSuggestChips(item) {
        let html = '';
        if (item.suggestionState === 'pending' && item.suggestedGoalId) {
            const meta = LinkManager.getItemMeta('goals', item.suggestedGoalId);
            if (meta) {
                html += `<span class="actions-suggest-chip" title="Assistant suggestion: file under ${UIUtils.escapeHtml(meta.title)}">
                    &#8594; ${UIUtils.escapeHtml(meta.title)}?
                    <button class="actions-suggest-act" data-act="goal-yes" data-item-id="${item.id}" title="File under this goal">&#10003;</button>
                    <button class="actions-suggest-act" data-act="goal-no" data-item-id="${item.id}" title="Don't file">&#10005;</button>
                </span>`;
            }
        }
        if (item.dateSuggestionState === 'pending' && item.suggestedDate) {
            const label = ScheduleUI.formatRelativeDate(item.suggestedDate, ScheduleApp.getLocalToday());
            html += `<span class="actions-suggest-chip" title="Assistant suggestion: schedule for ${UIUtils.escapeHtml(item.suggestedDate)}">
                ${UIUtils.escapeHtml(label)}?
                <button class="actions-suggest-act" data-act="date-yes" data-item-id="${item.id}" title="Schedule for this date">&#10003;</button>
                <button class="actions-suggest-act" data-act="date-no" data-item-id="${item.id}" title="Leave undated">&#10005;</button>
            </span>`;
        }
        return html;
    },

    // A list row shows when a thing STARTS. "by 4:00 PM" (deadline-only) keeps
    // its shape — there the end time is the whole meaning.
    _rowTime(item) {
        const start = ScheduleUI.formatTime(item.startTime);
        if (start) return start;
        const end = ScheduleUI.formatTime(item.endTime);
        return end ? `by ${end}` : '';
    },

    _renderRow(item, { dateLabel = '', completed = false, overdue = false, late = false, noGoalChip = false } = {}) {
        const goal = noGoalChip ? null : LinkManager.getGoalForTask(item.id);

        // The gutter holds exactly ONE atom and never wraps: two of them at
        // this width spill onto a second line, and the ragged row heights pull
        // the titles off a shared baseline. The date wins only where it IS the
        // point (area views, suggestions for off-screen items); everywhere
        // else the section or date heading already says the day, so the time
        // shows. Ranges collapse to the start — the end time lives in the
        // tooltip and the detail view, as in Todoist/Reminders.
        const time = this._rowTime(item);
        const fullTime = ScheduleUI.formatTimeRange(item.startTime, item.endTime);
        let metaHtml = '';
        if (dateLabel) {
            metaHtml = `<span class="actions-row-date${late ? ' is-late' : ''}">${UIUtils.escapeHtml(dateLabel)}</span>`;
        } else if (time) {
            const tip = fullTime && fullTime !== time
                ? ` title="${UIUtils.escapeHtml(fullTime.replace('–', ' – '))}"` : '';
            metaHtml = `<span class="actions-row-time"${tip}>${UIUtils.escapeHtml(time)}</span>`;
        }

        return `
            <div class="actions-row ${completed ? 'is-done' : ''}" data-item-id="${item.id}" draggable="true">
                <!-- No stopPropagation here: rows use ONE delegated container
                     listener, and its checkbox branch returns before the
                     row-open branch — stopping the event would kill the toggle. -->
                <label class="actions-check-label">
                    <input type="checkbox" class="actions-check" data-item-id="${item.id}" ${completed ? 'checked' : ''}>
                </label>
                <!-- Gutter always renders (even empty) — a fixed column keeps
                     every title starting at the same x across the list. -->
                <div class="actions-row-meta">${metaHtml}</div>
                <span class="actions-row-title">${UIUtils.escapeHtml(item.title)}</span>
                <div class="actions-row-badges">
                    ${overdue ? `<button class="actions-push-today" data-item-id="${item.id}" title="Move to today">&#8594; Today</button>` : ''}
                    ${goal ? `<button class="actions-goal-chip" data-goal-id="${goal.itemId}" title="Goal: ${UIUtils.escapeHtml(goal.title)}">${UIUtils.escapeHtml(goal.title)}</button>` : ''}
                    ${completed ? '' : this._renderSuggestChips(item)}
                    ${item.source === 'email' ? `<span class="actions-email-badge" title="From: ${UIUtils.escapeHtml(item.sourceEmailFrom || 'email')}">&#9993; Email</span>` : ''}
                </div>
            </div>`;
    },

    _renderEvents(events) {
        const container = document.getElementById('actions-events-container');
        if (!container) return;
        if (CalendarApp.getAccounts().length === 0 || events.length === 0) {
            container.innerHTML = '';
            return;
        }
        container.innerHTML = `
            <div class="actions-section">
                <div class="actions-section-header">Today&rsquo;s events</div>
                ${events.map(e => `
                    <div class="actions-event-row">
                        <span class="actions-event-time">${UIUtils.escapeHtml(this._fmtEventTime(e))}</span>
                        <span class="actions-event-title">${UIUtils.escapeHtml(e.summary || '(no title)')}</span>
                    </div>`).join('')}
            </div>`;
    },

    _fmtEventTime(e) {
        if (e.allDay) return 'All day';
        const fmt = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        return e.end ? `${fmt(e.start)} – ${fmt(e.end)}` : fmt(e.start);
    },

    // Refresh the calendar cache in the background when it's stale, then
    // repaint events if the user is still here. Never blocks first paint —
    // render always draws from the local cache first.
    _maybeBackgroundSync() {
        if (CalendarApp.getAccounts().length === 0 || CalendarApp.isSyncing) return;
        const last = CalendarApp.lastSyncTime ? new Date(CalendarApp.lastSyncTime).getTime() : 0;
        if (Date.now() - last < this.CALENDAR_STALE_MS) return;
        CalendarApp.syncEvents().then(() => {
            if (AppManager.currentApp === 'actions' && this._view === 'tasks'
                && this._sel.type === 'time' && this._sel.id === 'today') {
                this._renderEvents(this._todayEvents());
            }
        }).catch(() => { /* syncEvents toasts on its own */ });
    },

    // --- Assistant filing (goal-link + date suggestions) ---
    //
    // The assistant is the organizer, not the user: a background batched LLM
    // pass (same one-brain routing as email insights, template:
    // EmailApp.classifyBundlesWithAI) suggests a goal for unfiled actions and
    // a date for undated ones. Suggestions are chips the user confirms or
    // dismisses — never auto-applied, never invisible. Verdicts persist on
    // the item (suggestionState / dateSuggestionState) so nothing is re-asked.

    _filingEnabled() {
        return StorageManager.get('actionsSettings')?.aiFiling !== false;
    },

    // Open goals for the active profile, straight from storage so the pass
    // works even if GoalsApp never initialized this session.
    _openGoals() {
        const goals = StorageManager.get('goals')?.goals || [];
        return ProfileManager.filterByActiveProfile(goals).filter(g => g.status !== 'completed');
    },

    // One link-index pass (never getGoalForTask per task — that re-reads the
    // link table every call). Only calm, one-time items are candidates.
    _filingCandidates() {
        const { taskFocus, taskGoals } = ScheduleApp.buildTaskLinkIndex();
        const items = ProfileManager.filterByActiveProfile(ScheduleApp.scheduleItems)
            .filter(i => i.title && (!i.repeat || i.repeat === 'none') && !i.lastCompletedDate);
        const unlinked = (i) => !(taskGoals.get(i.id)?.size) && !(taskFocus.get(i.id)?.size);
        return items.filter(i =>
            (i.suggestionState === undefined && unlinked(i)) ||
            (i.dateSuggestionState === undefined && !i.scheduledDate)
        ).map(i => ({
            item: i,
            wantGoal: i.suggestionState === undefined && unlinked(i),
            wantDate: i.dateSuggestionState === undefined && !i.scheduledDate,
        }));
    },

    async _fileActions() {
        if (this._filing || !this._filingEnabled()) return;
        const goals = this._openGoals();
        const candidates = this._filingCandidates()
            // Without open goals only date suggestions make sense.
            .filter(c => (goals.length > 0 && c.wantGoal) || c.wantDate)
            .slice(0, this.FILING_AI_BATCH);
        if (candidates.length === 0) return;

        this._filing = true;
        let succeeded = false;
        try {
            const today = ScheduleApp.getLocalToday();
            const goalLines = goals.map((g, i) =>
                `G${i + 1}: ${g.title}${g.description ? ` — ${String(g.description).slice(0, 100)}` : ''}`
            ).join('\n');
            const taskLines = candidates.map((c, i) =>
                `${i + 1}. ${c.item.title}${c.item.scheduledDate ? ` (scheduled ${c.item.scheduledDate})` : ' (no date)'}`
            ).join('\n');

            const result = await LLMLogger.call('actions-filing', {
                model: AgentService.model,
                // JSON-constrained sampling (see email bundles) — prose-wrapped
                // output from small models must not kill the pass.
                format: 'json',
                logTag: 'actions-filing',
                messages: [
                    {
                        role: 'system',
                        content: `You are a personal task-filing assistant. Today is ${today}.

The user's open goals:
${goalLines || '(none)'}

For each numbered task below, decide:
- "goal": the goal id (G1, G2, ...) the task CLEARLY serves, or "none". Most everyday tasks serve no listed goal — when unsure, use "none".
- "date": only for tasks marked (no date), and ONLY when the task text clearly implies a timeframe — a specific day, event, or deadline. Format YYYY-MM-DD. Omit "date" otherwise.

Respond ONLY with a JSON object mapping each task number to its verdict, e.g. {"1":{"goal":"G2"},"2":{"goal":"none","date":"${today}"}}.`
                    },
                    { role: 'user', content: taskLines }
                ],
                stream: false
            });

            if (result?.error) {
                console.warn('[actions] filing call failed:', result.error);
                return;
            }
            const content = result?.message?.content || '';
            const map = LLMLogger.extractJsonObject(content);
            if (!map) {
                console.warn('[actions] filing returned unparseable output:', content.slice(0, 200));
                return;
            }

            candidates.forEach((c, i) => {
                const v = map[String(i + 1)] || {};
                if (c.wantGoal) {
                    const goal = this._validGoalRef(v.goal, goals);
                    if (goal) {
                        c.item.suggestedGoalId = goal.id;
                        c.item.suggestionState = 'pending';
                    } else {
                        c.item.suggestionState = 'none';
                    }
                }
                if (c.wantDate) {
                    const date = this._validSuggestedDate(v.date, today);
                    if (date) {
                        c.item.suggestedDate = date;
                        c.item.dateSuggestionState = 'pending';
                    } else {
                        c.item.dateSuggestionState = 'none';
                    }
                }
            });
            ScheduleApp.saveData();
            succeeded = true;
            if (AppManager.currentApp === 'actions') this.render();
        } catch (err) {
            console.warn('[actions] filing pass failed:', err?.message);
        } finally {
            this._filing = false;
        }

        // More candidates and this batch worked? Keep draining quietly.
        if (succeeded && this._filingCandidates().length > 0) {
            setTimeout(() => this._fileActions(), 3000);
        }
    },

    // Floor-model defense: only accept verdicts we can verify.
    _validGoalRef(ref, goals) {
        if (typeof ref !== 'string') return null;
        const m = ref.trim().match(/^[Gg](\d+)$/);
        if (!m) return null;
        return goals[parseInt(m[1], 10) - 1] || null;
    },

    _validSuggestedDate(date, today) {
        if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
        if (isNaN(new Date(date + 'T00:00:00'))) return null;
        const horizon = new Date(today + 'T00:00:00');
        horizon.setDate(horizon.getDate() + 365);
        const max = `${horizon.getFullYear()}-${String(horizon.getMonth() + 1).padStart(2, '0')}-${String(horizon.getDate()).padStart(2, '0')}`;
        return (date >= today && date <= max) ? date : null;
    },

    // Items with a pending suggestion, for the "Assistant suggestions"
    // section (unfiled actions mostly live in Later/no-date, which Today
    // doesn't otherwise show). Done or deliberately skipped actions are
    // out: filing chips on a finished task are noise, even if its
    // suggestion was never answered. (Suggestion states only ever land on
    // one-time items — _filingCandidates — so lastCompletedDate means done
    // for good here, not "done today".)
    _pendingSuggestionItems() {
        return ProfileManager.filterByActiveProfile(ScheduleApp.scheduleItems)
            .filter(i => i.suggestionState === 'pending' || i.dateSuggestionState === 'pending')
            .filter(i => !i.lastCompletedDate && !ScheduleApp.lastAbandonedDate(i));
    },

    // --- Interactions (all bound once; rows use delegation) ---

    _bindOnce() {
        if (this._bound) return;
        this._bound = true;

        // Hub strip: Tasks is this view; Plan opens the Focus workspace.
        document.querySelectorAll('#actions-view .actions-hub-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const dest = btn.dataset.dest;
                if (dest === 'tasks' || dest === 'today') this.showTasks();
                else if (dest) AppManager.openApp(dest);
            });
        });

        // Left nav: selection clicks + task-row drops (file / reschedule).
        const nav = document.getElementById('actions-nav');
        if (nav) {
            nav.addEventListener('click', (e) => {
                const time = e.target.closest('[data-nav-time]');
                if (time) { this.select({ type: 'time', id: time.dataset.navTime }); return; }
                const focus = e.target.closest('[data-nav-focus]');
                if (focus) this.select({ type: 'focus', id: focus.dataset.navFocus });
            });
            nav.addEventListener('dragover', (e) => {
                const target = e.target.closest('[data-drop]');
                if (!target) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                nav.querySelectorAll('.is-drop').forEach(el => { if (el !== target) el.classList.remove('is-drop'); });
                target.classList.add('is-drop');
            });
            nav.addEventListener('dragleave', (e) => {
                const target = e.target.closest('[data-drop]');
                if (target && !target.contains(e.relatedTarget)) target.classList.remove('is-drop');
            });
            nav.addEventListener('drop', (e) => {
                const target = e.target.closest('[data-drop]');
                if (!target) return;
                e.preventDefault();
                target.classList.remove('is-drop');
                this._handleNavDrop(target.dataset.drop, e.dataTransfer.getData('text/plain'));
            });
        }

        // Review nudge / open-in-Plan on the head line (re-rendered each
        // paint, so delegate).
        document.getElementById('actions-date-line')?.addEventListener('click', (e) => {
            if (e.target.closest('#actions-review-nudge')) { this.showReview(); return; }
            if (e.target.closest('#actions-open-plan') && this._sel.type === 'focus') {
                const areaId = this._sel.id;
                AppManager.openApp('focus');
                setTimeout(() => FocusApp.selectNode('area', areaId), 0);
            }
        });

        // Weekly review: one delegated listener for nav + verdicts.
        document.getElementById('actions-review-container')?.addEventListener('click', (e) => {
            ActionsReview.handleClick(e);
        });

        // Quick-add with live parse preview.
        const input = document.getElementById('actions-quick-add');
        if (input) {
            input.addEventListener('input', () => this._updateQuickAddPreview(input.value));
            input.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                this._quickAdd(input);
            });
        }

        // Delegated row interactions.
        const container = document.getElementById('actions-today-container');
        if (container) {
            container.addEventListener('dragstart', (e) => {
                const row = e.target.closest('.actions-row');
                if (!row) return;
                e.dataTransfer.setData('text/plain', row.dataset.itemId);
                e.dataTransfer.effectAllowed = 'move';
            });
            container.addEventListener('click', (e) => {
                // Push-to-today: per-row chip on overdue rows, and the bulk
                // button on the Overdue section header (the shared sidebar
                // filter must not apply from here).
                const pushToday = e.target.closest('.actions-push-today');
                if (pushToday) {
                    ScheduleApp.rescheduleTask(pushToday.dataset.itemId, 'today');
                    this.render();
                    return;
                }
                if (e.target.closest('#actions-overdue-pushall')) {
                    ScheduleApp.rescheduleAllOverdue({ applySidebarFilter: false });
                    this.render();
                    return;
                }
                const check = e.target.closest('.actions-check');
                if (check) {
                    ScheduleApp.toggleComplete(check.dataset.itemId);
                    this.render();
                    return;
                }
                const chip = e.target.closest('.actions-goal-chip');
                if (chip) {
                    const goalId = chip.dataset.goalId;
                    AppManager.openApp('focus');
                    setTimeout(() => FocusApp.selectNode('goal', goalId), 0);
                    return;
                }
                // Goal section headings in the area view open the goal in Plan.
                const goalHeading = e.target.closest('[data-open-goal]');
                if (goalHeading) {
                    const goalId = goalHeading.dataset.openGoal;
                    AppManager.openApp('focus');
                    setTimeout(() => FocusApp.selectNode('goal', goalId), 0);
                    return;
                }
                const toggle = e.target.closest('#actions-completed-toggle');
                if (toggle) {
                    this._completedExpanded = !this._completedExpanded;
                    this.render();
                    return;
                }
                const suggestBtn = e.target.closest('.actions-suggest-act');
                if (suggestBtn) {
                    this._handleSuggestAction(suggestBtn.dataset.act, suggestBtn.dataset.itemId);
                    return;
                }
                const row = e.target.closest('.actions-row');
                if (row) this._openTaskEditor(row.dataset.itemId);
            });
        }
    },

    // Open a task's FULL editor inline in the right pane — the left nav
    // stays put, no view switch, no flicker. The editor DOM is moved into
    // the host (ScheduleApp.embedEditor); init() is cheap and idempotent
    // (openApp runs it on every open too) and wires the editor's buttons
    // in sessions where the schedule view itself was never opened.
    _openTaskEditor(id) {
        ScheduleApp.init();
        this._openTaskId = id;
        ScheduleApp.embedEditor(document.getElementById('actions-task-detail'));
        this._syncViewChrome();
        ScheduleApp.openEditor(id, { origin: 'actions', embedded: true });
        this._renderNav();
        const item = ScheduleApp.scheduleItems.find(i => i.id === id);
        Breadcrumb.render('actions-breadcrumb', [
            { label: 'Actions', action: () => this.showToday() },
            { label: this._selLabel(), action: () => this.showTasks() },
            { label: item ? item.title : 'Task' }
        ]);
    },

    // Tear down the inline task detail (nav click, back, delete): hand the
    // editor DOM back to its own view so full-page opens still work.
    _closeInlineTask() {
        if (!this._openTaskId) return;
        this._openTaskId = null;
        ScheduleApp.restoreEditorHome();
    },

    // A row dropped on a nav item: focus areas file the task there, Today /
    // Tomorrow reschedule it. Same primitives as the click paths.
    _handleNavDrop(drop, taskId) {
        if (!drop || !taskId) return;
        const item = ScheduleApp.scheduleItems.find(i => i.id === taskId);
        if (!item) return;
        const [kind, value] = drop.split(':');
        if (kind === 'date') {
            ScheduleApp.rescheduleTask(taskId, value);
            this.render();
        } else if (kind === 'focus') {
            const area = this._focusArea(value);
            if (!area) return;
            LinkManager.addLink('focus', value, 'schedule', taskId);
            UIUtils.showToast(`Filed under ${area.title}`, 'success');
            this.render();
        }
    },

    /**
     * Wire an Actions hub strip embedded in another rung's header (Plan,
     * plus the legacy Goals/Schedule views) — same markup as the Actions
     * view's own strip, with that rung's button carrying is-active.
     * Clone-replace so repeated init passes don't stack listeners.
     */
    wireHubNav(viewId) {
        document.querySelectorAll(`#${viewId} .actions-hub-btn`).forEach(btn => {
            const newBtn = btn.cloneNode(true);
            btn.parentNode.replaceChild(newBtn, btn);
            newBtn.addEventListener('click', () => {
                const dest = newBtn.dataset.dest;
                if (!dest || newBtn.classList.contains('is-active')) return;
                if (dest === 'tasks' || dest === 'today') {
                    AppManager.openApp('actions');
                    this.showTasks();
                } else {
                    AppManager.openApp(dest);
                }
            });
        });
    },

    // Confirm/dismiss an assistant filing suggestion. Accepting a goal uses
    // the TaskListUI.createLinkedTask recipe: link to the goal AND to the
    // goal's focus area, so the workspace tree stays consistent.
    _handleSuggestAction(act, itemId) {
        const item = ScheduleApp.scheduleItems.find(i => i.id === itemId);
        if (!item) return;

        if (act === 'goal-yes' && item.suggestedGoalId) {
            const meta = LinkManager.getItemMeta('goals', item.suggestedGoalId);
            LinkManager.addLink('goals', item.suggestedGoalId, 'schedule', item.id);
            const fa = LinkManager.getFocusForItem('goals', item.suggestedGoalId);
            if (fa) LinkManager.addLink('focus', fa.itemId, 'schedule', item.id);
            item.suggestionState = 'accepted';
            if (meta) UIUtils.showToast(`Filed under ${meta.title}`, 'success');
        } else if (act === 'goal-no') {
            item.suggestionState = 'dismissed';
        } else if (act === 'date-yes' && item.suggestedDate) {
            item.scheduledDate = item.suggestedDate;
            item.modifiedAt = new Date().toISOString();
            item.dateSuggestionState = 'accepted';
            UIUtils.showToast(`Scheduled for ${ScheduleUI.formatRelativeDate(item.suggestedDate, ScheduleApp.getLocalToday())}`, 'success');
        } else if (act === 'date-no') {
            item.dateSuggestionState = 'dismissed';
        } else {
            return;
        }
        ScheduleApp.saveData();
        this.render();
    },

    _quickAdd(input) {
        const raw = input.value.trim();
        if (!raw) return;
        // quickAddDetached = load guard + sidebar-filter neutralization.
        const newId = ScheduleApp.quickAddDetached(raw);
        if (newId) {
            // Adding while looking at a focus area files the task there —
            // the selection IS the context, same as the Tasks page filter.
            if (this._sel.type === 'focus' && this._focusArea(this._sel.id)) {
                LinkManager.addLink('focus', this._sel.id, 'schedule', newId);
            }
            input.value = '';
            this._updateQuickAddPreview('');
            // Land on the new task's detail page (origin: actions so the
            // breadcrumb/back returns here), same as opening a row.
            this._openTaskEditor(newId);
        }
    },

    // Same chip preview as the Tasks quick-add (reuses its CSS classes).
    _updateQuickAddPreview(raw) {
        const el = document.getElementById('actions-quick-add-preview');
        if (!el) return;
        const trimmed = (raw || '').trim();
        if (!trimmed) { el.hidden = true; el.innerHTML = ''; return; }
        const parsed = ScheduleQuickParse.parse(trimmed, ScheduleApp.getLocalToday());
        if (!parsed.hasParse) { el.hidden = true; el.innerHTML = ''; return; }
        const chips = parsed.chips.map(c =>
            `<span class="schedule-parse-chip">${UIUtils.escapeHtml(c.label)}</span>`).join('');
        const title = parsed.title.trim()
            ? `<span class="schedule-parse-preview-title">&#8594; <strong>${UIUtils.escapeHtml(parsed.title.trim())}</strong></span>`
            : `<span class="schedule-parse-preview-title">Add a task name</span>`;
        el.innerHTML = chips + title;
        el.hidden = false;
    }
};

AppManager.register('actions', ActionsApp);

// AgentContext provider — a compact TODAY VIEW block. The global briefing
// already includes today's tasks in detail, so this stays at summary
// altitude: counts plus the open titles, to anchor "what should I do first"
// style asks while the user is looking at the Tasks tab.
if (typeof AgentContext !== 'undefined') {
    AgentContext.register('actions', () => {
        if (!Array.isArray(ScheduleApp.scheduleItems) || ScheduleApp.scheduleItems.length === 0) return null;
        const g = ScheduleApp.getGroupedItems({ applySidebarFilter: false, applySearch: false });
        const open = [...g.overdue, ...g.todayActive];
        if (open.length === 0 && g.todayCompleted.length === 0) return null;

        const lines = open.slice(0, 15).map(i => {
            const time = i.startTime ? ` at ${i.startTime}` : '';
            const overdue = g.overdue.includes(i) ? ' (overdue)' : '';
            return `- ${i.title}${time}${overdue}`;
        }).join('\n');

        const pendingSuggestions = ActionsApp._pendingSuggestionItems().length;
        return {
            title: 'TODAY VIEW',
            body: `The user is looking at their Tasks view in Actions: ${g.overdue.length} overdue, ${g.todayActive.length} due today, ${g.todayCompleted.length} completed today${pendingSuggestions ? `, ${pendingSuggestions} assistant filing suggestion${pendingSuggestions === 1 ? '' : 's'} awaiting confirmation` : ''}.

Open actions:
${lines || '(none)'}`,
            suggestedPrompts: [
                'What should I do first today?',
                'Help me plan my day around these',
                'Which of these can wait until tomorrow?'
            ]
        };
    });
}
