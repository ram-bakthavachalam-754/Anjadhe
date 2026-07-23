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
    // Two INDEPENDENT filter dimensions — a time window and a focus scope —
    // so "Today" and "Health" compose instead of replacing each other.
    // time: 'today'|'tomorrow'|'week'|'month'|'later'|null (null = any date)
    // focus: an area id | 'unassigned' | null (null = any area)
    // Both null is normalized back to the Today default.
    _sel: { time: 'today', focus: null },
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
            if (!s) return;
            if (s.type && s.id) { this._sel = this._normalizeSel(s); return; } // pre-compose shape
            if ('time' in s || 'focus' in s) this._sel = this._normalizeSel(s);
        } catch (_) {}
    },

    // Accepts both the current {time, focus} shape and the legacy
    // {type, id} single-selection shape (older sessionStorage, external
    // callers), and enforces the invariant: never both null.
    _normalizeSel(sel) {
        let s;
        if (sel && sel.type) {
            s = sel.type === 'time' ? { time: sel.id, focus: null }
                : sel.type === 'unassigned' ? { time: null, focus: 'unassigned' }
                : { time: null, focus: sel.id };
        } else {
            s = { time: sel?.time ?? null, focus: sel?.focus ?? null };
        }
        const TIMES = ['today', 'tomorrow', 'week', 'month', 'later', 'all'];
        if (s.time && !TIMES.includes(s.time)) s.time = 'today';
        // Time is never null internally: 'all' is the explicit no-window
        // value (its own nav row). No filters at all → the Today default.
        if (!s.time) s.time = s.focus ? 'all' : 'today';
        return s;
    },

    select(sel) {
        this._closeInlineTask();
        this._sel = this._normalizeSel(sel);
        this._view = 'tasks';
        this._completedExpanded = false;
        this._persistSel();
        this.render();
    },

    _persistSel() {
        try { window.sessionStorage.setItem(this._selKey, JSON.stringify(this._sel)); } catch (_) {}
    },

    // Nav clicks toggle their own dimension and leave the other alone.
    // Re-clicking the active time window falls back to All time (= no
    // window); re-clicking All time is a no-op — it already is the fallback.
    // EXCEPT from the inline task detail: there, clicking the active item
    // means "back to that list", never "clear the filter".
    _toggleTime(id) {
        if (this._openTaskId && this._sel.time === id) { this.select({ ...this._sel }); return; }
        const next = (this._sel.time === id && id !== 'all') ? 'all' : id;
        this.select({ time: next, focus: this._sel.focus });
    },

    _toggleFocus(id) {
        if (this._openTaskId && this._sel.focus === id) { this.select({ ...this._sel }); return; }
        this.select({ time: this._sel.time, focus: this._sel.focus === id ? null : id });
    },

    render() {
        this._ensureData();
        this._reconcileSuggestions();

        // A selected focus area may have been deleted (or synced away).
        if (this._sel.focus && this._sel.focus !== 'unassigned' && !this._focusArea(this._sel.focus)) {
            this._sel = this._normalizeSel({ time: this._sel.time, focus: null });
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
                // No breadcrumb here either: the left nav stays up, and
                // clicking any nav item closes the detail back to a list.
                this._renderNav();
                return;
            }
            this._closeInlineTask();
            this._syncViewChrome();
        }

        this._renderNav();
        // No breadcrumb on list views — the selection pill in the main pane
        // (see _renderSelLine) is the single statement of what's showing.
        // Review and the inline task detail keep theirs: there the trail IS
        // the way back.

        // All time → the all-dates views. With a real time window, the focus
        // scope (if any) applies as a per-item predicate on top.
        const pred = this._focusPredicate();
        if (this._sel.time === 'all') {
            if (this._sel.focus === 'unassigned') this._renderUnassignedView();
            else if (this._sel.focus) this._renderAreaView();
            else this._renderAllView();
            return;
        }
        if (this._sel.time === 'later') {
            this._renderLaterView(pred);
            return;
        }
        if (this._sel.time !== 'today') {
            this._renderRangeView(pred);
            return;
        }

        // --- Today: the front door, unchanged in substance ---
        // Both flags false: the Tasks app keeps its sidebar filter and search
        // in memory, and Today must never silently inherit them.
        let groups = ScheduleApp.getGroupedItems({ applySidebarFilter: false, applySearch: false });
        if (pred) {
            groups = {
                ...groups,
                overdue: groups.overdue.filter(pred),
                todayActive: groups.todayActive.filter(pred),
                todayCompleted: groups.todayCompleted.filter(pred),
            };
        }
        // Calendar events aren't tasks and carry no focus links — they only
        // belong on the unscoped Today view.
        const events = pred ? [] : this._todayEvents();

        this._renderDateLine(groups, events);
        this._renderList(groups);
        this._renderEvents(events);
        this._maybeBackgroundSync();
        // Assistant filing runs behind the paint, like the email bundle pass.
        setTimeout(() => this._fileActions(), 800);
    },

    _timeLabel() {
        return { today: 'Today', tomorrow: 'Tomorrow', week: 'This Week', month: 'This Month', later: 'Later', all: 'All time' }[this._sel.time] || null;
    },

    _focusLabel() {
        if (!this._sel.focus) return null;
        if (this._sel.focus === 'unassigned') return 'No focus area';
        const area = this._focusArea(this._sel.focus);
        return area ? area.title : 'Focus area';
    },

    _selLabel() {
        return [this._timeLabel(), this._focusLabel()].filter(Boolean).join(' · ') || 'Today';
    },

    /** Per-item predicate for the focus dimension; null when unscoped. */
    _focusPredicate() {
        const f = this._sel.focus;
        if (!f) return null;
        const { taskFocus, taskGoals } = ScheduleApp.buildTaskLinkIndex();
        if (f === 'unassigned') {
            return (i) => !(taskFocus.get(i.id)?.size) && !(taskGoals.get(i.id)?.size);
        }
        const subtree = ScheduleApp.getFocusSubtreeIds(f, this._focusAreas());
        return (i) => {
            const set = taskFocus.get(i.id);
            if (!set) return false;
            for (const fid of set) if (subtree.has(fid)) return true;
            return false;
        };
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
        // Breadcrumb only in the review flow — list views state their
        // selection via the pills in the main pane, and the task detail
        // keeps the left nav up (any nav click is the way back).
        const title = document.querySelector('#actions-view > .app-header-bar > .app-view-title');
        if (title) title.style.display = inReview ? '' : 'none';
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
        const taskBack = document.getElementById('actions-task-back');
        if (taskBack) taskBack.style.display = inTask ? '' : 'none';
        document.querySelectorAll('#actions-view .actions-hub-btn').forEach(btn => {
            btn.classList.toggle('is-active', btn.dataset.dest === 'tasks');
        });
    },

    // The Tasks tab, on the Today selection (the front door + review exit).
    showToday() {
        this._closeInlineTask();
        this._view = 'tasks';
        this._sel = { time: 'today', focus: null };
        this._persistSel();
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
        const isSel = (dim, id) => this._sel[dim] === id;

        const timeItems = [
            { id: 'today', label: 'Today', count: counts.today, drop: 'date:today' },
            { id: 'tomorrow', label: 'Tomorrow', count: counts.tomorrow, drop: 'date:tomorrow' },
            { id: 'week', label: 'This Week', count: counts.week, drop: null },
            { id: 'month', label: 'This Month', count: counts.month, drop: null },
            { id: 'later', label: 'Later', count: counts.later, drop: null },
            { id: 'all', label: 'All time', count: counts.all, drop: null },
        ];
        let html = '<div class="actions-nav-header">Dates</div>';
        html += '<div class="actions-nav-section">' + timeItems.map(t => `
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

            // The escape hatch: tasks filed under no area (and no goal) are
            // invisible in every area view above — give them a row of their
            // own so nothing can hide. Hollow dot = absence of a color.
            html += `
                <button type="button" class="actions-nav-item actions-nav-area actions-nav-unfiled${isSel('focus', 'unassigned') ? ' is-active' : ''}"
                        data-nav-unassigned="1" title="Tasks not filed under any focus area">
                    <span class="actions-nav-dot" style="background:transparent;box-shadow:inset 0 0 0 1.5px var(--color-text-tertiary)"></span>
                    <span class="actions-nav-label">No focus area</span>
                    ${counts.unassigned ? `<span class="actions-nav-count">${counts.unassigned}</span>` : ''}
                </button>`;
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
            all: 0,
            areas: new Map(),
            unassigned: 0,
        };
        // Per-area open-task counts from the direct focus links; unassigned =
        // no focus AND no goal link (same definition as the Tasks sidebar's
        // unassigned filter in ScheduleApp._taskPassesFilter).
        const { taskFocus, taskGoals } = ScheduleApp.buildTaskLinkIndex();
        for (const item of ProfileManager.filterByActiveProfile(ScheduleApp.scheduleItems)) {
            if (!item.title || TaskListUI.isCompleted(item) || TaskListUI.isAbandoned(item)) continue;
            counts.all++;
            const set = taskFocus.get(item.id);
            if (set) { for (const fid of set) counts.areas.set(fid, (counts.areas.get(fid) || 0) + 1); }
            if ((!set || set.size === 0) && !(taskGoals.get(item.id)?.size)) counts.unassigned++;
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

    _rangeItems(id, pred = null) {
        const includeDayRepeats = id !== 'month';
        const days = this._rangeDates(id)
            .map(date => ({ date, items: this._openItemsOn(date, { includeDayRepeats }).filter(i => !pred || pred(i)) }))
            .filter(d => d.items.length > 0);
        return { days, total: days.reduce((n, d) => n + d.items.length, 0) };
    },

    // Resolved counterpart of _openItemsOn: items whose occurrence on the
    // date ended done/abandoned (one-time tasks: resolved whenever).
    _resolvedItemsOn(dateStr, { includeDayRepeats = true } = {}) {
        return ProfileManager.filterByActiveProfile(ScheduleApp.scheduleItems).filter(item => {
            if (!item.title) return false;
            const repeating = item.repeat && item.repeat !== 'none';
            if (!repeating) {
                return item.scheduledDate === dateStr
                    && !!(item.lastCompletedDate || ScheduleApp.lastAbandonedDate(item));
            }
            if (!includeDayRepeats && this.DAY_REPEATS.includes(item.repeat)) return false;
            if (!ScheduleApp.occursOn(item, dateStr)) return false;
            return !!(item.history && item.history[dateStr]);
        });
    },

    // The collapsed "N done" disclosure every list view shares.
    _doneSectionHtml(done) {
        if (!done.length) return '';
        return `
            <div class="actions-section">
                <button class="actions-completed-toggle" id="actions-completed-toggle" aria-expanded="${this._completedExpanded}">
                    ${this._completedExpanded ? '&#9662;' : '&#9656;'} ${done.length} done
                </button>
                ${this._completedExpanded ? done.map(item => this._renderRow(item, { completed: true })).join('') : ''}
            </div>`;
    },

    _renderRangeView(pred = null) {
        const { days, total } = this._rangeItems(this._sel.time, pred);
        const today = ScheduleApp.getLocalToday();
        const tomorrow = this._isoAddDays(today, 1);

        // Resolved tasks whose date falls in this window, deduped (a
        // repeating task can occur on several days of the range).
        const includeDayRepeats = this._sel.time !== 'month';
        const doneSeen = new Set();
        const done = [];
        for (const date of this._rangeDates(this._sel.time)) {
            for (const item of this._resolvedItemsOn(date, { includeDayRepeats })) {
                if (pred && !pred(item)) continue;
                if (doneSeen.has(item.id)) continue;
                doneSeen.add(item.id);
                done.push(item);
            }
        }

        const parts = [`${total} to do`];
        if (done.length) parts.push(`${done.length} done`);
        this._renderSelLine(parts);

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
            } else if (this._sel.time === 'month'
                && ProfileManager.filterByActiveProfile(ScheduleApp.scheduleItems).some(i => this.DAY_REPEATS.includes(i.repeat))) {
                html += '<div class="actions-range-note">Daily and weekly repeating tasks show in Today and This Week.</div>';
            }
            html += this._doneSectionHtml(done);
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
    _laterItems(pred = null) {
        const today = ScheduleApp.getLocalToday();
        const d = new Date(today + 'T00:00:00');
        const monthEnd = this._isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 0));

        const dated = [];
        const noDate = [];
        const done = [];
        for (const item of ProfileManager.filterByActiveProfile(ScheduleApp.scheduleItems)) {
            if (!item.title) continue;
            if (pred && !pred(item)) continue;
            const repeating = item.repeat && item.repeat !== 'none';
            if (repeating) {
                if (this.DAY_REPEATS.includes(item.repeat)) continue;
                const next = ScheduleApp.nextOccurrenceDate(item, today);
                if (next && next > monthEnd) dated.push({ item, date: next });
                continue;
            }
            if (item.lastCompletedDate || ScheduleApp.lastAbandonedDate(item)) {
                // Resolved tasks that belonged to this horizon (beyond the
                // month, or the undated backlog).
                if (!item.scheduledDate || item.scheduledDate > monthEnd) done.push(item);
                continue;
            }
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
        return { months, noDate, done, total: dated.length + noDate.length };
    },

    _renderLaterView(pred = null) {
        const { months, noDate, done, total } = this._laterItems(pred);
        const today = ScheduleApp.getLocalToday();
        const parts = [`${total} to do`];
        if (done.length) parts.push(`${done.length} done`);
        this._renderSelLine(parts);

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
            html += this._doneSectionHtml(done);
            container.innerHTML = html;
        }
        const events = document.getElementById('actions-events-container');
        if (events) events.innerHTML = '';
    },

    // --- Focus-area view ---

    _renderAreaView() {
        const area = this._focusArea(this._sel.focus);
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
        // Abandoned counts as done — resolved, just with the honest label.
        const isResolved = (i) => TaskListUI.isCompleted(i, today) || TaskListUI.isAbandoned(i, today);
        const done = linked.filter(isResolved);
        const todo = linked.filter(i => !isResolved(i)).sort(byUrgency);

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

        this._renderSelLine([`${todo.length} to do`]);

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
            html += this._doneSectionHtml(done);
            container.innerHTML = html;
        }
        const events = document.getElementById('actions-events-container');
        if (events) events.innerHTML = '';
    },

    // --- All-dates flat views (All time, and No focus area) ---

    _renderUnassignedView() {
        const { taskFocus, taskGoals } = ScheduleApp.buildTaskLinkIndex();
        const unassigned = ProfileManager.filterByActiveProfile(ScheduleApp.scheduleItems).filter(item =>
            item.title && !(taskFocus.get(item.id)?.size) && !(taskGoals.get(item.id)?.size));
        this._renderFlatView(unassigned,
            '<div class="actions-empty">Every open task is filed under a focus area. Drag a task onto an area in the sidebar to file it; new tasks added here stay unfiled.</div>');
    },

    _renderAllView() {
        const items = ProfileManager.filterByActiveProfile(ScheduleApp.scheduleItems).filter(i => i.title);
        this._renderFlatView(items,
            '<div class="actions-empty">No tasks yet. Add an action above to get started.</div>');
    },

    // Shared body: urgency-sorted open list + the collapsed done section.
    _renderFlatView(items, emptyHtml) {
        const today = ScheduleApp.getLocalToday();
        const byUrgency = (a, b) =>
            (a.scheduledDate || '9999').localeCompare(b.scheduledDate || '9999')
            || this._startMins(a) - this._startMins(b)
            || (a.title || '').localeCompare(b.title || '');
        const isResolved = (i) => TaskListUI.isCompleted(i, today) || TaskListUI.isAbandoned(i, today);
        const done = items.filter(isResolved);
        const todo = items.filter(i => !isResolved(i)).sort(byUrgency);

        const parts = [`${todo.length} to do`];
        if (done.length) parts.push(`${done.length} done`);
        this._renderSelLine(parts);

        const container = document.getElementById('actions-today-container');
        if (container) {
            let html = '';
            if (todo.length > 0) {
                html += `
                    <div class="actions-section">
                        <div class="actions-section-header">To do <span class="actions-section-count">${todo.length}</span></div>
                        ${todo.map(item => this._renderRow(item, {
                            dateLabel: (item.repeat && item.repeat !== 'none')
                                ? ScheduleUI.getRepeatLabel(item)
                                : (item.scheduledDate ? ScheduleUI.formatRelativeDate(item.scheduledDate, today) : ''),
                            late: !(item.repeat && item.repeat !== 'none') && item.scheduledDate && item.scheduledDate < today,
                        })).join('')}
                    </div>`;
            } else {
                html += emptyHtml;
            }
            html += this._doneSectionHtml(done);
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

    // The selection pills ARE the page heading: each active filter dimension
    // (time window, focus scope) restated as its own dismissible chip at the
    // top of the main pane, so the pane always says what it's showing without
    // a breadcrumb and a title repeating each other. The × on a pill clears
    // just that dimension; the resting default (Today alone) has no ×.
    _renderSelLine(summaryParts) {
        const el = document.getElementById('actions-date-line');
        if (!el) return;
        const sel = this._sel;
        const pill = (label, { dot = '', clear = null } = {}) =>
            `<span class="actions-sel-pill">${dot}<span class="actions-sel-pill-label">${UIUtils.escapeHtml(label)}</span>` +
            (clear ? `<button class="actions-sel-clear" data-sel-clear="${clear}" title="Remove this filter" aria-label="Remove ${UIUtils.escapeHtml(label)} filter">&times;</button>` : '') +
            `</span>`;

        let html = '';
        if (sel.time) {
            // No × on the resting default (Today alone) or on All time —
            // clearing the time dimension IS All time, so an × there would
            // be circular. Clearing a real window falls back to All time.
            const dismissible = sel.time !== 'all' && !(sel.time === 'today' && !sel.focus);
            html += pill(this._timeLabel(), { clear: dismissible ? 'time' : null });
        }
        if (sel.focus) {
            const area = sel.focus === 'unassigned' ? null : this._focusArea(sel.focus);
            const dot = sel.focus === 'unassigned'
                ? `<span class="actions-nav-dot" style="background:transparent;box-shadow:inset 0 0 0 1.5px var(--color-text-tertiary)"></span>`
                : `<span class="actions-nav-dot" style="background:${(area && area.color) || '#4A90A4'}"></span>`;
            html += pill(this._focusLabel(), { dot, clear: 'focus' });
        }

        // Right-aligned action: Edit Plan whenever an area is in scope;
        // otherwise the weekly-review link on the plain Today view.
        let trailing = '';
        if (sel.focus && sel.focus !== 'unassigned') {
            trailing = '<button class="actions-review-nudge" id="actions-open-plan" title="Edit this focus area in Plan">Edit Plan</button>';
        } else if (sel.time === 'today' && !sel.focus) {
            trailing = `<button class="actions-review-nudge${this._reviewDue() ? ' is-due' : ''}" id="actions-review-nudge">Weekly review &#8594;</button>`;
        }

        el.innerHTML = html +
            `<span class="actions-date-summary">${UIUtils.escapeHtml(summaryParts.join(' · '))}</span>` +
            trailing;
    },

    _renderDateLine(groups, events) {
        const today = new Date();
        const parts = [today.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })];
        const open = groups.todayActive.length + groups.overdue.length;
        parts.push(`${open} to do`);
        if (groups.todayCompleted.length) parts.push(`${groups.todayCompleted.length} done`);
        if (events.length) parts.push(`${events.length} event${events.length === 1 ? '' : 's'}`);
        this._renderSelLine(parts);
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
                    <span class="actions-suggest-label">Suggested:</span> ${UIUtils.escapeHtml(meta.title)}?
                    <button class="actions-suggest-act" data-act="goal-yes" data-item-id="${item.id}" title="File under this goal">&#10003;</button>
                    <button class="actions-suggest-act" data-act="goal-no" data-item-id="${item.id}" title="Don't file">&#10005;</button>
                </span>`;
            }
        }
        if (item.dateSuggestionState === 'pending' && item.suggestedDate) {
            const label = ScheduleUI.formatRelativeDate(item.suggestedDate, ScheduleApp.getLocalToday());
            html += `<span class="actions-suggest-chip" title="Assistant suggestion: schedule for ${UIUtils.escapeHtml(item.suggestedDate)}">
                <span class="actions-suggest-label">Suggested:</span> ${UIUtils.escapeHtml(label)}?
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
                     every title starting at the same x across the list.
                     data-edit-date anchors the row menu's native date picker. -->
                <div class="actions-row-meta" data-edit-date="${item.id}">${metaHtml}</div>
                <span class="actions-row-title">${UIUtils.escapeHtml(item.title)}</span>
                <div class="actions-row-badges">
                    ${overdue ? `<button class="actions-push-today" data-item-id="${item.id}" title="Move to today">&#8594; Today</button>` : ''}
                    ${goal ? `<button class="actions-goal-chip" data-goal-id="${goal.itemId}" title="Goal: ${UIUtils.escapeHtml(goal.title)}">${UIUtils.escapeHtml(goal.title)}</button>` : ''}
                    ${completed ? '' : this._renderSuggestChips(item)}
                    ${item.source === 'email' ? `<span class="actions-email-badge" title="From: ${UIUtils.escapeHtml(item.sourceEmailFrom || 'email')}">&#9993; Email</span>` : ''}
                    <button type="button" class="task-row-menu actions-row-menu" data-item-id="${item.id}" title="More actions">&#8943;</button>
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
                && this._sel.time === 'today' && !this._sel.focus) {
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
            .filter(i => i.title && (!i.repeat || i.repeat === 'none')
                && !i.lastCompletedDate && !ScheduleApp.lastAbandonedDate(i));
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
        // Circuit breaker (same as email bundles): a failing batch keeps its
        // suggestionState undefined, so it would be re-sent verbatim on every
        // render. Three consecutive failures parks the pass until next launch.
        if ((this._filingFailures || 0) >= 3) return;
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
                // The verdict map is small; without a cap a thinking model ran
                // this pass 4096 tokens / 4+ minutes with nothing to show.
                maxTokens: 700,
                // No hidden reasoning — see email bundles: <think> overruns
                // the cap and content comes back empty every time.
                think: false,
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
            this._filingFailures = succeeded ? 0 : (this._filingFailures || 0) + 1;
            if (this._filingFailures === 3) {
                console.warn('[actions] filing failed 3× in a row — pausing until next launch');
            }
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

    // A pending suggestion is void once the user has done the filing
    // themselves — linked a goal (any goal, via the detail page's picker
    // or a drag) or set a date. Mark it superseded so the chip disappears
    // and the filing pass never re-asks; the state persists on the item,
    // like accepted/dismissed. Without this, a stale "→ Goal?" chip sits
    // next to the real goal chip forever.
    _reconcileSuggestions() {
        const pending = ScheduleApp.scheduleItems.filter(i =>
            i.suggestionState === 'pending' || i.dateSuggestionState === 'pending');
        if (pending.length === 0) return;
        const { taskGoals } = ScheduleApp.buildTaskLinkIndex();
        let changed = false;
        for (const item of pending) {
            if (item.suggestionState === 'pending' && taskGoals.get(item.id)?.size) {
                item.suggestionState = 'superseded';
                changed = true;
            }
            if (item.dateSuggestionState === 'pending' && item.scheduledDate) {
                item.dateSuggestionState = 'superseded';
                changed = true;
            }
        }
        if (changed) ScheduleApp.saveData();
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

    // --- Search (tasks + goals + focus areas → their detail pages) ---

    SEARCH_CAP: 6,   // rows shown per group; the header count says the rest

    _searchMatches(q) {
        const tasks = ProfileManager.filterByActiveProfile(ScheduleApp.scheduleItems)
            .filter(i => i.title && i.title.toLowerCase().includes(q))
            .map(item => ({ item, done: TaskListUI.isCompleted(item) || TaskListUI.isAbandoned(item) }))
            .sort((a, b) => (a.done - b.done) || a.item.title.localeCompare(b.item.title));
        const goals = ProfileManager.filterByActiveProfile(StorageManager.get('goals')?.goals || [])
            .filter(g => g.title && g.title.toLowerCase().includes(q))
            .sort((a, b) => a.title.localeCompare(b.title));
        const areas = this._focusAreas()
            .filter(a => a.title && a.title.toLowerCase().includes(q))
            .sort((a, b) => a.title.localeCompare(b.title));
        return { tasks, goals, areas };
    },

    _renderSearchResults() {
        const input = document.getElementById('actions-search');
        const panel = document.getElementById('actions-search-results');
        if (!input || !panel) return;
        const q = input.value.trim().toLowerCase();
        if (!q) {
            panel.hidden = true;
            panel.innerHTML = '';
            return;
        }

        this._ensureData();
        const { tasks, goals, areas } = this._searchMatches(q);
        const today = ScheduleApp.getLocalToday();

        const section = (label, total, rows) => rows.length === 0 ? '' : `
            <div class="actions-search-section">
                <div class="actions-search-header">${label}${total > rows.length ? ` <span class="actions-search-count">${total}</span>` : ''}</div>
                ${rows.join('')}
            </div>`;

        const taskRows = tasks.slice(0, this.SEARCH_CAP).map(({ item, done }) => {
            const repeating = item.repeat && item.repeat !== 'none';
            const meta = repeating ? ScheduleUI.getRepeatLabel(item)
                : (item.scheduledDate ? ScheduleUI.formatRelativeDate(item.scheduledDate, today) : '');
            return `
                <button type="button" class="actions-search-row${done ? ' is-done' : ''}" data-kind="task" data-id="${item.id}">
                    <span class="actions-search-title">${UIUtils.escapeHtml(item.title)}</span>
                    ${meta ? `<span class="actions-search-meta">${UIUtils.escapeHtml(meta)}</span>` : ''}
                </button>`;
        });
        const goalRows = goals.slice(0, this.SEARCH_CAP).map(g => `
            <button type="button" class="actions-search-row" data-kind="goal" data-id="${g.id}">
                <span class="ftree-gdot ${g.status || 'not-started'}"></span>
                <span class="actions-search-title">${UIUtils.escapeHtml(g.title)}</span>
            </button>`);
        const areaRows = areas.slice(0, this.SEARCH_CAP).map(a => `
            <button type="button" class="actions-search-row" data-kind="focus" data-id="${a.id}">
                <span class="actions-nav-dot" style="background:${a.color || '#4A90A4'}"></span>
                <span class="actions-search-title">${UIUtils.escapeHtml(a.title)}</span>
            </button>`);

        panel.innerHTML =
            section('Tasks', tasks.length, taskRows) +
            section('Goals', goals.length, goalRows) +
            section('Focus areas', areas.length, areaRows)
            || '<div class="actions-search-empty">No matches</div>';
        panel.hidden = false;
    },

    // Arrow-key highlight: move .is-active through the rows, wrapping at
    // the ends. A re-render (typing) rebuilds the panel, which clears it.
    _moveSearchActive(dir) {
        const panel = document.getElementById('actions-search-results');
        if (!panel || panel.hidden) return;
        const rows = [...panel.querySelectorAll('.actions-search-row')];
        if (rows.length === 0) return;
        const cur = rows.findIndex(r => r.classList.contains('is-active'));
        const next = cur === -1
            ? (dir > 0 ? 0 : rows.length - 1)
            : (cur + dir + rows.length) % rows.length;
        rows.forEach((r, i) => r.classList.toggle('is-active', i === next));
        rows[next].scrollIntoView({ block: 'nearest' });
    },

    _closeSearch({ clear = false } = {}) {
        const input = document.getElementById('actions-search');
        const panel = document.getElementById('actions-search-results');
        if (clear && input) input.value = '';
        if (panel) { panel.hidden = true; panel.innerHTML = ''; }
    },

    _openSearchResult(kind, id) {
        this._closeSearch({ clear: true });
        if (kind === 'task') {
            // Works from anywhere, including the review flow.
            this._view = 'tasks';
            this._openTaskEditor(id);
        } else if (kind === 'goal') {
            // Same route as the goal chips: the goal's node in Plan.
            AppManager.openApp('focus');
            setTimeout(() => FocusApp.selectNode('goal', id), 0);
        } else if (kind === 'focus') {
            this.select({ time: null, focus: id });
        }
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
                if (time) { this._toggleTime(time.dataset.navTime); return; }
                const un = e.target.closest('[data-nav-unassigned]');
                if (un) { this._toggleFocus('unassigned'); return; }
                const focus = e.target.closest('[data-nav-focus]');
                if (focus) this._toggleFocus(focus.dataset.navFocus);
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

        // Back to the list from the inline task detail — same route as the
        // editor's own back paths (closeEditor with origin 'actions' lands
        // on the Actions list with the selection intact). Esc works too,
        // unless focus is in a form field.
        document.getElementById('actions-task-back')?.addEventListener('click', () => {
            ScheduleApp.closeEditor();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || !this._openTaskId || AppManager.currentApp !== 'actions') return;
            const t = e.target;
            if (t && (t.matches('input, textarea, select') || t.isContentEditable)) return;
            if (document.querySelector('.modal-overlay, .task-menu')) return;
            ScheduleApp.closeEditor();
        });

        // Review nudge / Edit Plan / pill dismiss on the selection line
        // (re-rendered each paint, so delegate).
        document.getElementById('actions-date-line')?.addEventListener('click', (e) => {
            if (e.target.closest('#actions-review-nudge')) { this.showReview(); return; }
            const clear = e.target.closest('[data-sel-clear]');
            if (clear) {
                const dim = clear.dataset.selClear;
                this.select({ time: dim === 'time' ? null : this._sel.time, focus: dim === 'focus' ? null : this._sel.focus });
                return;
            }
            if (e.target.closest('#actions-open-plan') && this._sel.focus && this._sel.focus !== 'unassigned') {
                const areaId = this._sel.focus;
                AppManager.openApp('focus');
                setTimeout(() => FocusApp.selectNode('area', areaId), 0);
            }
        });

        // Weekly review: one delegated listener for nav + verdicts.
        document.getElementById('actions-review-container')?.addEventListener('click', (e) => {
            ActionsReview.handleClick(e);
        });

        // Header search: live dropdown; arrows move the highlight, Enter
        // opens the highlighted (or top) result, Escape clears, clicking
        // anywhere else dismisses.
        const search = document.getElementById('actions-search');
        const searchResults = document.getElementById('actions-search-results');
        if (search) {
            search.addEventListener('input', () => this._renderSearchResults());
            search.addEventListener('focus', () => this._renderSearchResults());
            search.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    this._closeSearch({ clear: true });
                    search.blur();
                } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();   // keep the caret still
                    this._moveSearchActive(e.key === 'ArrowDown' ? 1 : -1);
                } else if (e.key === 'Enter') {
                    const row = searchResults?.querySelector('.actions-search-row.is-active')
                        || searchResults?.querySelector('.actions-search-row');
                    if (row) this._openSearchResult(row.dataset.kind, row.dataset.id);
                }
            });
        }
        if (searchResults) {
            searchResults.addEventListener('click', (e) => {
                const row = e.target.closest('.actions-search-row');
                if (row) this._openSearchResult(row.dataset.kind, row.dataset.id);
            });
        }
        document.addEventListener('click', (e) => {
            if (searchResults && !searchResults.hidden && !e.target.closest('.actions-search-wrap')) {
                this._closeSearch();
            }
        });
        // Cmd/Ctrl+F focuses the search whenever Actions is the open app
        // (no Electron menu item claims the accelerator). Select any old
        // query so typing starts fresh.
        document.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey
                && e.key.toLowerCase() === 'f' && AppManager.currentApp === 'actions') {
                e.preventDefault();
                search?.focus();
                search?.select();
            }
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
                // ⋯ opens the same row menu as the Plan task lists — quick
                // edits (date, rename, delete) without leaving the list.
                const menuBtn = e.target.closest('.actions-row-menu');
                if (menuBtn) {
                    const rect = menuBtn.getBoundingClientRect();
                    this._openRowMenu(menuBtn.dataset.itemId, { x: rect.right, y: rect.bottom + 4 }, menuBtn.closest('.actions-row'));
                    return;
                }
                const row = e.target.closest('.actions-row');
                if (row) this._openTaskEditor(row.dataset.itemId);
            });
            // Right-click anywhere on a row opens the same menu (parity with
            // the Plan task lists).
            container.addEventListener('contextmenu', (e) => {
                const row = e.target.closest('.actions-row');
                if (!row) return;
                e.preventDefault();
                this._openRowMenu(row.dataset.itemId, { x: e.clientX, y: e.clientY }, row);
            });
        }
    },

    // TaskListUI's anchored row menu (Open · Set date · Rename · Delete),
    // wired to this page's editor and repaint.
    _openRowMenu(taskId, at, rowEl) {
        if (typeof TaskListUI === 'undefined') return;
        TaskListUI.openMenu(taskId, at, {
            onOpenTask: (id) => this._openTaskEditor(id),
            allowDelete: true,
            onChanged: () => { ScheduleApp.loadData(); this.render(); },
            extraItems: [{
                label: 'Rename',
                act: () => TaskListUI.beginTitleEdit(taskId, rowEl?.querySelector('.actions-row-title'), {
                    onChanged: () => { ScheduleApp.loadData(); this.render(); },
                }),
            }],
        });
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
        // The page being viewed is the date context: adding on the Tomorrow
        // page schedules for tomorrow, on Later for the undated backlog —
        // unless the text itself names a date, which always wins. Today,
        // This Week, This Month, and focus areas keep the today default so
        // the new task stays visible in the view it was added from.
        const opts = {};
        if (this._sel.time === 'tomorrow') {
            opts.defaultDate = this._isoAddDays(ScheduleApp.getLocalToday(), 1);
        } else if (this._sel.time === 'later') {
            opts.defaultDate = '';
        }
        // quickAddDetached = load guard + sidebar-filter neutralization.
        const newId = ScheduleApp.quickAddDetached(raw, opts);
        if (newId) {
            // Adding while looking at a focus area files the task there —
            // the selection IS the context, same as the Tasks page filter.
            if (this._sel.focus && this._sel.focus !== 'unassigned' && this._focusArea(this._sel.focus)) {
                LinkManager.addLink('focus', this._sel.focus, 'schedule', newId);
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
