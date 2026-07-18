/**
 * Schedule App
 * Manages time-based daily schedule items with repeat options
 * Items are grouped: Today, This Week, Later
 */

const ScheduleApp = {
    scheduleItems: [],
    currentItemId: null,
    searchQuery: '',
    autoLinkContext: null, // [{app, itemId}, ...] — auto-link new tasks to these items
    activeFilter: { type: 'all', id: null }, // sidebar filter: 'all'|'unassigned'|'focus'|'goal'
    expandedNavIds: new Set(),               // transient: which focus nodes are expanded in the sidebar tree
    viewMode: 'agenda',                      // right-pane mode: 'agenda' (date-grouped) | 'list' (status-grouped backlog)

    // Draggable width of the Tasks filter sidebar (px). Persisted per-machine
    // in localStorage — screen sizes differ across Macs, so this preference is
    // intentionally kept out of the sync journal.
    NAV_WIDTH_KEY: 'schedule-nav-width',
    NAV_WIDTH_DEFAULT: 216,
    NAV_WIDTH_MIN: 160,
    NAV_WIDTH_MAX: 420,

    init() {
        this.loadData();
        this.setupEventListeners();
        this.loadNavWidth();
        this.render();
    },

    loadData() {
        const data = StorageManager.get('schedule');
        // Normalize so records created on other devices (e.g. the phone) that
        // omit fields can't crash the renderer — coerce strings and default
        // arrays/repeat that the render/search/sort paths access unguarded.
        this.scheduleItems = (data?.scheduleItems || []).map(t => ({
            ...t,
            title: typeof t.title === 'string' ? t.title : '',
            description: typeof t.description === 'string' ? t.description : '',
            startTime: typeof t.startTime === 'string' ? t.startTime : '',
            repeat: t.repeat || 'none',
            repeatDays: Array.isArray(t.repeatDays) ? t.repeatDays : [],
            reminderDaysBefore: Array.isArray(t.reminderDaysBefore) ? t.reminderDaysBefore : [],
            // Per-occurrence record: { 'YYYY-MM-DD': 'done' | 'abandoned' }.
            // Written going forward by toggleComplete / toggleAbandoned.
            history: (t.history && typeof t.history === 'object' && !Array.isArray(t.history)) ? t.history : {},
        }));
    },

    saveData() {
        // Merge into the existing blob rather than replacing it — the schedule
        // key also holds emailActionLedger (dedup ledger for email-derived
        // tasks). A bare { scheduleItems } write would wipe it on every edit,
        // letting deleted email tasks resurrect on the next email sync.
        const data = StorageManager.get('schedule') || {};
        StorageManager.set('schedule', { ...data, scheduleItems: this.scheduleItems });
        AppManager.updateStats();
    },

    setupEventListeners() {
        // Add task button
        const addBtn = document.getElementById('add-schedule-btn');
        const newAddBtn = addBtn.cloneNode(true);
        addBtn.parentNode.replaceChild(newAddBtn, addBtn);
        newAddBtn.addEventListener('click', () => {
            this.openEditor();
        });

        // Actions hub strip in the Tasks header — Tasks is a rung inside the
        // Actions door (one door, a ladder behind it), so the same strip the
        // Actions view shows lets the user hop between altitudes without
        // going back through the breadcrumb.
        ActionsApp.wireHubNav('schedule-view');

        // Pomodoro launcher in the Tasks header. The Pomodoro app is
        // always task-scoped, so we removed it from the home launcher
        // and surface it here next to + New Task instead.
        const pomBtn = document.getElementById('schedule-pomodoro-btn');
        if (pomBtn) {
            const newPomBtn = pomBtn.cloneNode(true);
            pomBtn.parentNode.replaceChild(newPomBtn, pomBtn);
            newPomBtn.addEventListener('click', () => {
                AppManager.openApp('pomodoro');
            });
        }

        // Editor save button
        const saveBtn = document.getElementById('schedule-editor-save-btn');
        const newSaveBtn = saveBtn.cloneNode(true);
        saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
        newSaveBtn.addEventListener('click', () => {
            this.saveCurrentItem();
        });

        // Editor duplicate button
        const duplicateBtn = document.getElementById('schedule-editor-duplicate-btn');
        if (duplicateBtn) {
            const newDuplicateBtn = duplicateBtn.cloneNode(true);
            duplicateBtn.parentNode.replaceChild(newDuplicateBtn, duplicateBtn);
            newDuplicateBtn.addEventListener('click', () => {
                this.duplicateCurrentItem();
            });
        }

        // Editor delete button
        const deleteBtn = document.getElementById('schedule-editor-delete-btn');
        const newDeleteBtn = deleteBtn.cloneNode(true);
        deleteBtn.parentNode.replaceChild(newDeleteBtn, deleteBtn);
        newDeleteBtn.addEventListener('click', () => {
            this.deleteCurrentItem();
        });

        // Editor complete toggle
        const completeBtn = document.getElementById('schedule-editor-complete-btn');
        if (completeBtn) {
            const newCompleteBtn = completeBtn.cloneNode(true);
            completeBtn.parentNode.replaceChild(newCompleteBtn, completeBtn);
            newCompleteBtn.addEventListener('click', () => {
                if (!this.currentItemId) return;
                this.toggleComplete(this.currentItemId);
                this._updateEditorCompletionSection();
            });
        }

        // Editor abandon toggle — records "deliberately not done" for today
        const abandonBtn = document.getElementById('schedule-editor-abandon-btn');
        if (abandonBtn) {
            const newAbandonBtn = abandonBtn.cloneNode(true);
            abandonBtn.parentNode.replaceChild(newAbandonBtn, abandonBtn);
            newAbandonBtn.addEventListener('click', () => {
                if (!this.currentItemId) return;
                this.toggleAbandoned(this.currentItemId);
                this._updateEditorCompletionSection();
            });
        }

        // Repeat type change
        const repeatSelect = document.getElementById('schedule-repeat-select');
        const newRepeatSelect = repeatSelect.cloneNode(true);
        repeatSelect.parentNode.replaceChild(newRepeatSelect, repeatSelect);
        newRepeatSelect.addEventListener('change', (e) => {
            this.updateRepeatOptions(e.target.value);
        });

        // Search input
        const searchInput = document.getElementById('schedule-search');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.searchQuery = e.target.value.toLowerCase();
                this.render();
            });
        }

        // Reminder add dropdown
        this._setupReminderAddListener();

        // Focus button in editor — hands the task to the Pomodoro app, which
        // drives this item's timer for the length of a focus session.
        const focusBtn = document.getElementById('schedule-focus-btn');
        if (focusBtn) {
            const newFocusBtn = focusBtn.cloneNode(true);
            focusBtn.parentNode.replaceChild(newFocusBtn, focusBtn);
            newFocusBtn.addEventListener('click', () => {
                if (this.currentItemId && typeof PomodoroApp !== 'undefined') {
                    PomodoroApp.startForTask(this.currentItemId);
                }
            });
        }

        // Timer reset button in editor
        const timerResetBtn = document.getElementById('schedule-timer-reset-btn');
        if (timerResetBtn) {
            const newTimerReset = timerResetBtn.cloneNode(true);
            timerResetBtn.parentNode.replaceChild(newTimerReset, timerResetBtn);
            newTimerReset.addEventListener('click', async () => {
                if (this.currentItemId) {
                    const confirmed = await UIUtils.confirm('Reset Timer', 'Reset tracked time to zero?');
                    if (confirmed) this.resetTimer(this.currentItemId);
                }
            });
        }

        // Quick-add — type a task, press Enter to create it in one step. The
        // input is parsed for a date/time/repeat (see ScheduleQuickParse), with
        // a live chip preview under the field so the interpretation is always
        // visible and correctable before Enter. The new task auto-links to the
        // focus area / goal currently selected in the sidebar.
        const quickAdd = document.getElementById('schedule-quick-add');
        if (quickAdd) {
            const newQuickAdd = quickAdd.cloneNode(true);
            quickAdd.parentNode.replaceChild(newQuickAdd, quickAdd);
            newQuickAdd.addEventListener('input', () => {
                this.updateQuickAddPreview(newQuickAdd.value);
            });
            newQuickAdd.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') { newQuickAdd.value = ''; this.updateQuickAddPreview(''); return; }
                if (e.key !== 'Enter') return;
                const newId = this.quickAddTask(newQuickAdd.value);
                if (newId) {
                    newQuickAdd.value = '';
                    this.updateQuickAddPreview('');
                    // Land on the new task's detail page so the user can flesh
                    // it out (description, links, reminders) right away.
                    this.openEditor(newId);
                }
            });
        }

        // Agenda / List view toggle
        const viewToggle = document.getElementById('schedule-view-toggle');
        if (viewToggle) {
            const newToggle = viewToggle.cloneNode(true);
            viewToggle.parentNode.replaceChild(newToggle, viewToggle);
            newToggle.querySelectorAll('.schedule-view-btn').forEach(btn => {
                btn.addEventListener('click', () => this.setViewMode(btn.dataset.view));
            });
        }

        // Editor "Advanced" collapsible (notify + advance reminders)
        const advancedToggle = document.getElementById('schedule-advanced-toggle');
        if (advancedToggle) {
            const newAdvanced = advancedToggle.cloneNode(true);
            advancedToggle.parentNode.replaceChild(newAdvanced, advancedToggle);
            newAdvanced.addEventListener('click', () => {
                this._showAdvanced = !this._showAdvanced;
                this._applyAdvancedState();
            });
        }

        this.setupNavResizer();
    },

    /**
     * Clamp a sidebar width to the allowed range and push it to the layout
     * as a CSS custom property. Returns the clamped value.
     */
    applyNavWidth(width) {
        const w = Math.round(Math.min(this.NAV_WIDTH_MAX, Math.max(this.NAV_WIDTH_MIN, width)));
        const layout = document.querySelector('.schedule-layout');
        if (layout) layout.style.setProperty('--schedule-nav-width', w + 'px');
        return w;
    },

    /**
     * Restore the sidebar width saved on this machine (default otherwise).
     */
    loadNavWidth() {
        let width = this.NAV_WIDTH_DEFAULT;
        try {
            const raw = parseInt(localStorage.getItem(this.NAV_WIDTH_KEY), 10);
            if (Number.isFinite(raw)) width = raw;
        } catch (_) { /* ignore */ }
        this.applyNavWidth(width);
    },

    /**
     * Wire up the drag handle that resizes the Tasks filter sidebar.
     * Dragging updates the width live; the result is saved on mouse-up.
     * Double-clicking the handle restores the default width.
     */
    setupNavResizer() {
        const resizer = document.getElementById('schedule-nav-resizer');
        if (!resizer) return;
        // Replace the node to drop listeners from any earlier init() pass.
        const fresh = resizer.cloneNode(true);
        resizer.parentNode.replaceChild(fresh, resizer);

        const currentWidth = () => {
            const layout = document.querySelector('.schedule-layout');
            const w = parseInt(layout?.style.getPropertyValue('--schedule-nav-width'), 10);
            return Number.isFinite(w) ? w : this.NAV_WIDTH_DEFAULT;
        };
        const save = (width) => {
            try { localStorage.setItem(this.NAV_WIDTH_KEY, String(width)); } catch (_) { /* ignore */ }
        };

        let startX = 0;
        let startWidth = 0;

        const onMove = (e) => {
            this.applyNavWidth(startWidth + (e.clientX - startX));
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            fresh.classList.remove('dragging');
            document.body.classList.remove('schedule-nav-resizing');
            save(currentWidth());
        };

        fresh.addEventListener('mousedown', (e) => {
            e.preventDefault();
            startX = e.clientX;
            startWidth = currentWidth();
            fresh.classList.add('dragging');
            document.body.classList.add('schedule-nav-resizing');
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        // Double-click the handle to snap back to the default width.
        fresh.addEventListener('dblclick', () => {
            save(this.applyNavWidth(this.NAV_WIDTH_DEFAULT));
        });
    },

    /**
     * Sync the editor's Advanced section open/closed state to the DOM.
     */
    _showAdvanced: false,
    _applyAdvancedState() {
        const toggle = document.getElementById('schedule-advanced-toggle');
        const body = document.getElementById('schedule-advanced-body');
        if (!toggle || !body) return;
        body.style.display = this._showAdvanced ? 'flex' : 'none';
        toggle.setAttribute('aria-expanded', this._showAdvanced);
        const arrow = toggle.querySelector('.schedule-completed-arrow');
        if (arrow) arrow.innerHTML = this._showAdvanced ? '&#9652;' : '&#9662;';
    },

    /**
     * Show/hide repeat sub-options based on repeat type
     */
    updateRepeatOptions(repeatType) {
        const weeklyOptions = document.getElementById('schedule-weekly-options');
        const customOptions = document.getElementById('schedule-custom-options');
        const dateLabel = document.getElementById('schedule-date-label');
        const remindersSection = document.getElementById('schedule-reminders-section');

        if (weeklyOptions) weeklyOptions.style.display = repeatType === 'weekly' ? 'block' : 'none';
        if (customOptions) customOptions.style.display = repeatType === 'custom' ? 'block' : 'none';

        // The date field applies to every type: it's the due date for one-time
        // tasks and the START date (anchor) for recurring ones — recurrences
        // never fire before it. Relabel so the meaning is clear.
        const isOneTime = !repeatType || repeatType === 'none';
        if (dateLabel) dateLabel.textContent = isOneTime ? 'Date' : 'Start date';
        if (remindersSection) remindersSection.style.display = isOneTime ? '' : 'none';
    },

    // --- Date helpers ---

    getLocalToday() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },

    getLocalDate(offset) {
        const d = new Date();
        d.setDate(d.getDate() + offset);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },

    getEndOfWeek() {
        const d = new Date();
        const daysUntilSun = 7 - d.getDay();
        d.setDate(d.getDate() + daysUntilSun);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },

    isCompletedToday(item) {
        if (!item.lastCompletedDate) return false;
        return item.lastCompletedDate === this.getLocalToday();
    },

    /** Was this occurrence deliberately skipped? (history: date → 'abandoned') */
    isAbandonedOn(item, dateStr) {
        return !!(item.history && item.history[dateStr] === 'abandoned');
    },

    isAbandonedToday(item) {
        return this.isAbandonedOn(item, this.getLocalToday());
    },

    /** Most recent abandoned date, or null. (One-time tasks have at most one.) */
    lastAbandonedDate(item) {
        const dates = Object.keys(item.history || {}).filter(d => item.history[d] === 'abandoned').sort();
        return dates[dates.length - 1] || null;
    },

    /**
     * Check if a repeating item fires on a given day-of-week
     */
    repeatsOnDay(item, dayOfWeek) {
        switch (item.repeat) {
            case 'daily': return true;
            case 'weekdays': return dayOfWeek >= 1 && dayOfWeek <= 5;
            case 'weekly': return item.dayOfWeek === dayOfWeek;
            case 'custom': return (item.repeatDays || []).includes(dayOfWeek);
            default: return false;
        }
    },

    /**
     * Check if a monthly/annual item fires on a given date string (YYYY-MM-DD)
     */
    repeatsOnDate(item, dateStr) {
        if (!item.scheduledDate) return false;
        const refParts = item.scheduledDate.split('-');
        const dateParts = dateStr.split('-');
        if (item.repeat === 'monthly') {
            return refParts[2] === dateParts[2]; // same day of month
        }
        if (item.repeat === 'annually') {
            return refParts[1] === dateParts[1] && refParts[2] === dateParts[2]; // same month+day
        }
        return false;
    },

    /**
     * Does an item occur on a given YYYY-MM-DD date? Single source of truth for
     * "is this task on this day" across the app (agenda, calendar, actions,
     * agent). `scheduledDate` is the anchor/START date: a recurring task never
     * occurs before it. One-time tasks occur only on their own date. Legacy
     * recurring tasks with no stored date stay unbounded (start check skipped).
     */
    occursOn(item, dateStr) {
        if (!item.repeat || item.repeat === 'none') {
            return (item.scheduledDate || '') === dateStr;
        }
        // Start-date bound — a recurrence never fires before its anchor.
        if (item.scheduledDate && dateStr < item.scheduledDate) return false;
        if (item.repeat === 'monthly' || item.repeat === 'annually') {
            return this.repeatsOnDate(item, dateStr);
        }
        const dow = new Date(dateStr + 'T00:00:00').getDay();
        return this.repeatsOnDay(item, dow);
    },

    _iso(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },

    /**
     * The next date on/after `fromISO` on which a recurring monthly/annual task
     * occurs, derived from its anchor's day-of-month (or month+day). Non-recurring
     * items just return their scheduledDate. This is what a recurring task should
     * DISPLAY as — its stored scheduledDate is only the original anchor and never
     * advances, so showing it directly leaks a stale past date into Upcoming.
     */
    nextOccurrenceDate(item, fromISO) {
        if (!item.scheduledDate) return item.scheduledDate;
        // Never advance to a date before the anchor/start date.
        const effISO = fromISO < item.scheduledDate ? item.scheduledDate : fromISO;
        const from = new Date(effISO + 'T00:00:00');
        if (item.repeat === 'monthly') {
            const day = parseInt(item.scheduledDate.split('-')[2], 10);
            let y = from.getFullYear(), m = from.getMonth();
            for (let i = 0; i < 25; i++) {
                const dim = new Date(y, m + 1, 0).getDate();
                const cand = new Date(y, m, Math.min(day, dim));
                if (cand >= from) return this._iso(cand);
                m++; if (m > 11) { m = 0; y++; }
            }
        } else if (item.repeat === 'annually') {
            const [, mo, dd] = item.scheduledDate.split('-').map(Number);
            let y = from.getFullYear();
            for (let i = 0; i < 4; i++) {
                const dim = new Date(y, mo, 0).getDate();
                const cand = new Date(y, mo - 1, Math.min(dd, dim));
                if (cand >= from) return this._iso(cand);
                y++;
            }
        }
        return item.scheduledDate;
    },

    /**
     * The date an item should sort/group under in the agenda: the next
     * occurrence for recurring monthly/annual tasks, else its own date.
     */
    _agendaDateFor(item) {
        if (item.repeat === 'monthly' || item.repeat === 'annually') {
            return this.nextOccurrenceDate(item, this.getLocalToday());
        }
        return item.scheduledDate || item.createdAt?.slice(0, 10) || '';
    },

    /**
     * Check if item is relevant for today (for today section only)
     */
    isItemForToday(item) {
        const todayDate = this.getLocalToday();

        // Recurring items — occurrence-tested (respects the start-date anchor)
        if (item.repeat && item.repeat !== 'none') {
            return this.occursOn(item, todayDate);
        }

        // One-time items: completed on a previous day = done
        if (item.lastCompletedDate && item.lastCompletedDate !== todayDate) {
            return false;
        }

        const itemDate = item.scheduledDate || (item.createdAt ? item.createdAt.slice(0, 10) : todayDate);
        return itemDate === todayDate;
    },

    // --- Grouped items ---

    /**
     * Get items grouped into today, this week, later
     */
    showOverdue: true,
    showToday: true,
    showTodayCompleted: false,
    showTomorrow: false,
    showLater: false,
    showListCompleted: false,

    // ===================================
    // Tasks sidebar filter (focus areas > goals tree)
    // ===================================

    /**
     * Apply a sidebar filter and re-render the page.
     * @param {string} type - 'all' | 'unassigned' | 'focus' | 'goal'
     * @param {string|null} id - focus/goal id when type is 'focus'/'goal'
     */
    setFilter(type, id = null) {
        this.activeFilter = { type, id: id || null };
        // Pick the right-pane model that fits the selection: a focus area or
        // goal is a backlog (List view), while "All Tasks" / "Unassigned" is
        // a daily agenda. The view toggle still lets the user override.
        this.viewMode = (type === 'focus' || type === 'goal') ? 'list' : 'agenda';
        this.render();
    },

    /**
     * Switch the right pane between the date-grouped Agenda and the
     * status-grouped List, keeping the active sidebar filter.
     */
    setViewMode(mode) {
        if (mode !== 'agenda' && mode !== 'list') return;
        this.viewMode = mode;
        this.render();
    },

    /**
     * Expand/collapse a focus node in the sidebar tree, then re-render
     * just the sidebar.
     */
    toggleNavNode(focusId) {
        if (this.expandedNavIds.has(focusId)) {
            this.expandedNavIds.delete(focusId);
        } else {
            this.expandedNavIds.add(focusId);
        }
        ScheduleUI.renderNav(this);
    },

    /**
     * Index every task by the focus areas and goals it links to, reading
     * the link table once instead of querying per-task.
     * @returns {{ taskFocus: Map<string,Set>, taskGoals: Map<string,Set> }}
     */
    buildTaskLinkIndex() {
        const taskFocus = new Map();
        const taskGoals = new Map();
        const add = (map, key, val) => {
            if (!map.has(key)) map.set(key, new Set());
            map.get(key).add(val);
        };
        const links = (typeof LinkManager !== 'undefined') ? LinkManager.loadLinks() : [];
        for (const l of links) {
            if (l.sourceApp === 'schedule' && l.targetApp === 'focus') add(taskFocus, l.sourceId, l.targetId);
            else if (l.targetApp === 'schedule' && l.sourceApp === 'focus') add(taskFocus, l.targetId, l.sourceId);
            else if (l.sourceApp === 'schedule' && l.targetApp === 'goals') add(taskGoals, l.sourceId, l.targetId);
            else if (l.targetApp === 'schedule' && l.sourceApp === 'goals') add(taskGoals, l.targetId, l.sourceId);
        }
        return { taskFocus, taskGoals };
    },

    /**
     * A focus area id plus every descendant focus area id, so selecting a
     * parent focus area shows tasks from its whole subtree.
     */
    getFocusSubtreeIds(focusId, focusItems) {
        const ids = new Set([focusId]);
        let grew = true;
        while (grew) {
            grew = false;
            for (const f of focusItems) {
                if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
                    ids.add(f.id);
                    grew = true;
                }
            }
        }
        return ids;
    },

    /**
     * Whether a task passes the active sidebar filter.
     */
    _taskPassesFilter(taskId, index, focusItems) {
        const f = this.activeFilter || { type: 'all' };
        if (f.type === 'all') return true;

        const focusSet = index.taskFocus.get(taskId);
        const goalSet = index.taskGoals.get(taskId);

        if (f.type === 'unassigned') {
            return (!focusSet || focusSet.size === 0) && (!goalSet || goalSet.size === 0);
        }
        if (f.type === 'goal') {
            return !!goalSet && goalSet.has(f.id);
        }
        if (f.type === 'focus') {
            if (!focusSet || focusSet.size === 0) return false;
            const subtree = this.getFocusSubtreeIds(f.id, focusItems);
            for (const fid of focusSet) {
                if (subtree.has(fid)) return true;
            }
            return false;
        }
        return true;
    },

    /**
     * Get items grouped into today/overdue/etc.
     * @param {object} [opts]
     * @param {boolean} [opts.applySidebarFilter=false] - when true, also
     *   restrict to the active focus/goal sidebar filter. Off by default so
     *   other callers (e.g. the agent's daily briefing) see every task.
     * @param {boolean} [opts.applySearch=true] - when false, ignore the
     *   search box (used to compute sidebar counts independent of search).
     */
    getGroupedItems({ applySidebarFilter = false, applySearch = true } = {}) {
        const todayDate = this.getLocalToday();
        const tomorrowDate = this.getLocalDate(1);
        const query = applySearch ? this.searchQuery : '';

        const overdue = [];
        const todayActive = [];
        const todayCompleted = [];
        const tomorrow = [];
        const later = [];
        const noDate = [];   // one-time tasks with no scheduled date ("someday")

        const profiledItems = ProfileManager.filterByActiveProfile(this.scheduleItems);
        const linkIndex = applySidebarFilter ? this.buildTaskLinkIndex() : null;
        const focusItems = applySidebarFilter ? ((StorageManager.get('focus') || {}).focusItems || []) : [];
        for (const item of profiledItems) {
            // Search filter
            if (query && !item.title.toLowerCase().includes(query)) {
                continue;
            }

            // Sidebar focus/goal filter
            if (applySidebarFilter && !this._taskPassesFilter(item.id, linkIndex, focusItems)) {
                continue;
            }

            // One-time items resolved (completed or abandoned) on a previous
            // day — fully done, hide
            if (!item.repeat || item.repeat === 'none') {
                const resolvedOn = item.lastCompletedDate || this.lastAbandonedDate(item);
                if (resolvedOn && resolvedOn !== todayDate) continue;
            }

            // Recurring items — occurrence-tested against the actual dates so
            // the start-date anchor is respected (no occurrences before it).
            if (item.repeat && item.repeat !== 'none') {
                const dueToday = this.occursOn(item, todayDate);
                const dueTomorrow = this.occursOn(item, tomorrowDate);
                if (dueToday) {
                    if (this.isCompletedToday(item) || this.isAbandonedToday(item)) {
                        todayCompleted.push(item);
                    } else {
                        todayActive.push(item);
                    }
                }
                if (dueTomorrow) {
                    tomorrow.push(item);
                }
                // Monthly/annual tasks not due in the next day still surface in
                // Upcoming under their next occurrence; day-based ones simply
                // wait until their day comes around.
                const isDateBased = item.repeat === 'monthly' || item.repeat === 'annually';
                if (isDateBased && !dueToday && !dueTomorrow) {
                    later.push(item);
                }
                continue;
            }

            // One-time items completed (or abandoned) today
            if (this.isCompletedToday(item) || this.isAbandonedToday(item)) {
                todayCompleted.push(item);
                continue;
            }

            // Undated one-time tasks ("someday") get their own bucket instead of
            // being forced into Overdue/Today via a creation-date fallback.
            if (!item.scheduledDate) {
                noDate.push(item);
                continue;
            }

            const itemDate = item.scheduledDate;

            if (itemDate < todayDate) {
                overdue.push(item);
            } else if (itemDate === todayDate) {
                todayActive.push(item);
            } else if (itemDate === tomorrowDate) {
                tomorrow.push(item);
            } else {
                later.push(item);
            }
        }

        // Untimed tasks sort after timed ones within a day ('99:99' sentinel).
        const sortByTime = (a, b) => (a.startTime || '99:99').localeCompare(b.startTime || '99:99');
        const sortByDate = (a, b) => {
            const da = this._agendaDateFor(a);
            const db = this._agendaDateFor(b);
            return da.localeCompare(db) || sortByTime(a, b);
        };

        todayActive.sort(sortByTime);
        todayCompleted.sort(sortByTime);
        overdue.sort(sortByDate);
        tomorrow.sort(sortByTime);
        later.sort(sortByDate);
        // Undated tasks: timed ones first, then by title for a stable order.
        noDate.sort((a, b) => sortByTime(a, b) || (a.title || '').localeCompare(b.title || ''));

        // Group later items by date for better display. Recurring monthly/annual
        // tasks group under their NEXT occurrence, not their stale anchor.
        const laterByDate = {};
        for (const item of later) {
            const d = this._agendaDateFor(item);
            if (!laterByDate[d]) laterByDate[d] = [];
            laterByDate[d].push(item);
        }
        // Sort each group by time
        for (const d of Object.keys(laterByDate)) {
            laterByDate[d].sort(sortByTime);
        }
        const laterDates = Object.keys(laterByDate).sort();

        return { overdue, todayActive, todayCompleted, tomorrow, later, laterByDate, laterDates, noDate };
    },

    /**
     * Get items for the List view — the full backlog, grouped by status
     * rather than by date. Unlike getGroupedItems, this keeps completed
     * one-time tasks from previous days, so a focus area or goal shows its
     * whole history of work instead of just what is due in the next day.
     * @param {object} [opts]
     * @param {boolean} [opts.applySidebarFilter=true] - restrict to the
     *   active focus/goal sidebar filter.
     * @param {boolean} [opts.applySearch=true] - apply the search box.
     * @returns {{ todo: object[], completed: object[] }}
     */
    getListItems({ applySidebarFilter = true, applySearch = true } = {}) {
        const query = applySearch ? this.searchQuery : '';
        const profiledItems = ProfileManager.filterByActiveProfile(this.scheduleItems);
        const linkIndex = applySidebarFilter ? this.buildTaskLinkIndex() : null;
        const focusItems = applySidebarFilter ? ((StorageManager.get('focus') || {}).focusItems || []) : [];

        const todo = [];
        const completed = [];

        for (const item of profiledItems) {
            if (query && !item.title.toLowerCase().includes(query)) continue;
            if (applySidebarFilter && !this._taskPassesFilter(item.id, linkIndex, focusItems)) continue;

            const isOneTime = !item.repeat || item.repeat === 'none';
            // One-time tasks with a completion date are "done". Repeating
            // tasks are ongoing commitments and stay in the active list —
            // their per-day completion shows on the card checkbox.
            if (isOneTime && (item.lastCompletedDate || this.lastAbandonedDate(item))) {
                completed.push(item);
            } else {
                todo.push(item);
            }
        }

        // To Do: dated tasks chronologically (overdue first), recurring last.
        const dateKey = (it) => it.scheduledDate || it.createdAt?.slice(0, 10) || '';
        const todoSortKey = (it) => {
            const isOneTime = !it.repeat || it.repeat === 'none';
            return (isOneTime || it.repeat === 'monthly' || it.repeat === 'annually')
                ? dateKey(it) : '9999-99-99';
        };
        todo.sort((a, b) =>
            todoSortKey(a).localeCompare(todoSortKey(b)) ||
            (a.startTime || '99:99').localeCompare(b.startTime || '99:99'));

        // Completed: most recently finished first.
        completed.sort((a, b) => (b.lastCompletedDate || '').localeCompare(a.lastCompletedDate || ''));

        return { todo, completed };
    },

    /**
     * Flat list of today items (used by dashboard preview + notifications)
     */
    getTodayItems() {
        return this.scheduleItems
            .filter(item => this.isItemForToday(item))
            .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
    },

    // --- Actions ---

    toggleComplete(id) {
        const item = this.scheduleItems.find(i => i.id === id);
        if (!item) return;

        const today = this.getLocalToday();
        const isOneTime = !item.repeat || item.repeat === 'none';
        // A one-time task is "done" if it carries any completion date, so
        // unchecking a task finished on an earlier day works. A repeating
        // task is "done" only for today — it auto-resets the next day.
        const done = isOneTime ? !!item.lastCompletedDate : this.isCompletedToday(item);

        item.history = item.history || {};
        if (done) {
            item.lastCompletedDate = null;
            if (item.history[today] === 'done') delete item.history[today];
        } else {
            item.lastCompletedDate = today;
            // Completing overwrites an abandoned mark for the day.
            item.history[today] = 'done';
            // Auto-stop timer when completing
            if (item.timerStartedAt) {
                const elapsed = Date.now() - new Date(item.timerStartedAt).getTime();
                item.totalTimeSpent = (item.totalTimeSpent || 0) + Math.max(0, elapsed);
                item.timerStartedAt = null;
            }
            if (typeof AnalyticsManager !== 'undefined') {
                AnalyticsManager.record('schedule.task_completed');
            }
        }

        this.saveData();

        this.render();

        // Completing a task removes it from the active list — offer a one-tap
        // Undo so an accidental check has a safety net. Re-running toggleComplete
        // is the faithful inverse.
        if (!done) {
            UIUtils.showToast('Task completed', 'success', 5000, {
                actionLabel: 'Undo',
                onAction: () => this.toggleComplete(id)
            });
        }
    },

    /**
     * Mark today's occurrence as deliberately not done ('abandoned'). For
     * recurring tasks this records the day in `history` (visible in the
     * detail page's History section); for one-time tasks it resolves the
     * task like completing does, just with the honest label. Toggling again
     * clears the mark.
     */
    toggleAbandoned(id) {
        const item = this.scheduleItems.find(i => i.id === id);
        if (!item) return;

        const today = this.getLocalToday();
        item.history = item.history || {};
        const wasAbandoned = item.history[today] === 'abandoned';

        if (wasAbandoned) {
            delete item.history[today];
        } else {
            item.history[today] = 'abandoned';
            // Abandoning replaces a same-day completion.
            if (item.lastCompletedDate === today) item.lastCompletedDate = null;
        }
        item.modifiedAt = new Date().toISOString();
        this.saveData();
        this.render();

        if (!wasAbandoned) {
            UIUtils.showToast('Marked abandoned', 'success', 5000, {
                actionLabel: 'Undo',
                onAction: () => this.toggleAbandoned(id)
            });
        }
    },

    /**
     * Resolve a reschedule keyword to a concrete date (or null for "no date"),
     * reusing the quick-add parser's date math. Keywords: today, tomorrow,
     * weekend (coming Saturday), nextweek (+7), none.
     */
    _resolveRescheduleDate(when) {
        const today = this.getLocalToday();
        const P = ScheduleQuickParse;
        switch (when) {
            case 'today': return today;
            case 'tomorrow': return P._addDays(today, 1);
            case 'weekend': return P._addDays(today, P._deltaToWeekday(today, 6, false));
            case 'nextweek': return P._addDays(today, 7);
            case 'none': return null;
            default: return today;
        }
    },

    /**
     * Move a single task to a new date without opening the editor. `when` is a
     * reschedule keyword (see _resolveRescheduleDate) or an explicit YYYY-MM-DD.
     */
    rescheduleTask(id, when) {
        const item = this.scheduleItems.find(i => i.id === id);
        if (!item) return;
        const date = /^\d{4}-\d{2}-\d{2}$/.test(when) ? when : this._resolveRescheduleDate(when);
        item.scheduledDate = date;
        item.modifiedAt = new Date().toISOString();
        this.saveData();
        this.render();
        const label = date
            ? ScheduleUI.formatRelativeDate(date, this.getLocalToday())
            : 'No date';
        UIUtils.showToast(date ? `Rescheduled to ${label}` : 'Moved to No date', 'success');
    },

    /**
     * Clear the overdue backlog in one action: push every currently-overdue
     * task (within the active sidebar filter) to today. This is the common
     * "start the day fresh" move that otherwise takes N editor round-trips.
     * Actions Today calls it with applySidebarFilter:false — the Tasks
     * sidebar filter is invisible from there and must not apply.
     */
    rescheduleAllOverdue({ applySidebarFilter = true } = {}) {
        const { overdue } = this.getGroupedItems({ applySidebarFilter });
        if (!overdue.length) return;
        const today = this.getLocalToday();
        const stamp = new Date().toISOString();
        for (const item of overdue) {
            item.scheduledDate = today;
            item.modifiedAt = stamp;
        }
        const n = overdue.length;
        this.saveData();
        this.render();
        UIUtils.showToast(`Moved ${n} task${n === 1 ? '' : 's'} to today`, 'success');
    },

    // --- Embedded editor hosting ---
    // The full editor's DOM can be moved INTO another view's pane (the
    // Tasks tab's right pane, Plan's detail pane) so opening a task keeps
    // that page's left nav — no view switch, no flicker. One host at a
    // time; every populate/wire path uses getElementById, so the editor
    // works wherever its nodes live. Hosts MUST call restoreEditorHome()
    // before wiping their pane, or the editor markup would be destroyed.
    _embedHost: null,

    embedEditor(host) {
        if (!host) return;
        this.restoreEditorHome();
        const view = document.getElementById('schedule-editor-view');
        if (!view) return;
        while (view.firstChild) host.appendChild(view.firstChild);
        this._embedHost = host;
    },

    restoreEditorHome() {
        const host = this._embedHost;
        this._embedHost = null;
        const view = document.getElementById('schedule-editor-view');
        if (!host || !view) return;
        while (host.firstChild) view.appendChild(host.firstChild);
    },

    openEditor(itemId = null, opts = {}) {
        this.currentItemId = itemId;
        this._editorOrigin = opts.origin || null;

        if (!opts.embedded) {
            AppManager.setDetailHash('schedule', 'edit', itemId);
            // Reclaim the editor DOM if a pane embedded it earlier.
            this.restoreEditorHome();
            // Switch views — deactivate whatever is showing, not just the
            // schedule list: callers arrive from Tasks/Plan/Calendar too,
            // and routing through openApp('schedule') first paints the
            // schedule list for a frame (reads as a flickering redirect).
            // Callers outside the schedule view call ScheduleApp.init()
            // first (cheap, idempotent) so the editor's buttons are wired.
            document.querySelectorAll('.view.active').forEach(v => v.classList.remove('active'));
            document.getElementById('schedule-editor-view').classList.add('active');
        }
        // Embedded: the host page stays the active view (and keeps its
        // hash, so Cmd+R restores the host page, not the editor).

        // Render breadcrumb
        const item = itemId ? this.scheduleItems.find(i => i.id === itemId) : null;
        this.renderEditorBreadcrumb(itemId, item?.title || 'New Task');

        // Populate fields
        const titleInput = document.getElementById('schedule-title-input');
        const descInput = document.getElementById('schedule-description-input');
        const dateInput = document.getElementById('schedule-date-input');
        const startTimeInput = document.getElementById('schedule-start-time');
        const endTimeInput = document.getElementById('schedule-end-time');
        const notifyBeforeSelect = document.getElementById('schedule-notify-before');
        const repeatSelect = document.getElementById('schedule-repeat-select');
        const weeklyDaySelect = document.getElementById('schedule-weekly-day');
        const deleteBtn = document.getElementById('schedule-editor-delete-btn');
        const remindersSection = document.getElementById('schedule-reminders-section');

        // Email source banner
        const emailBanner = document.getElementById('schedule-email-source-banner');

        // Reset editor reminders state
        this._editorReminders = [];

        if (itemId) {
            const item = this.scheduleItems.find(i => i.id === itemId);
            if (item) {
                titleInput.value = item.title;
                if (descInput) descInput.value = item.description || '';
                startTimeInput.value = item.startTime || '';
                endTimeInput.value = item.endTime || '';
                if (notifyBeforeSelect) notifyBeforeSelect.value = item.notifyBefore || 0;
                repeatSelect.value = item.repeat || 'none';

                // Date field — due date for one-time tasks, start date for
                // recurring ones (the label is set by updateRepeatOptions below).
                if (dateInput) {
                    dateInput.value = item.scheduledDate || '';
                }

                // Reminders
                this._editorReminders = (item.reminderDaysBefore || []).filter(d => d > 0).sort((a, b) => b - a);
                this._renderEditorReminders();

                if (item.repeat === 'weekly' && weeklyDaySelect) {
                    weeklyDaySelect.value = item.dayOfWeek || 0;
                }

                if (item.repeat === 'custom') {
                    const checkboxes = document.querySelectorAll('#schedule-custom-options input[type="checkbox"]');
                    checkboxes.forEach(cb => {
                        cb.checked = (item.repeatDays || []).includes(parseInt(cb.value));
                    });
                }

                // Show email source info if applicable
                if (emailBanner && item.source === 'email') {
                    emailBanner.style.display = '';
                    emailBanner.style.cursor = 'pointer';
                    document.getElementById('schedule-email-source-from').textContent = `From: ${item.sourceEmailFrom || 'Unknown'}`;
                    document.getElementById('schedule-email-source-subject').textContent = item.sourceEmailSubject || '';
                    // Make clickable — navigate to the source email
                    const newBanner = emailBanner.cloneNode(true);
                    emailBanner.parentNode.replaceChild(newBanner, emailBanner);
                    newBanner.addEventListener('click', () => {
                        this.navigateToSourceEmail(item.sourceEmailId);
                    });
                } else if (emailBanner) {
                    emailBanner.style.display = 'none';
                }

                deleteBtn.style.display = '';
                const dupBtn = document.getElementById('schedule-editor-duplicate-btn');
                if (dupBtn) dupBtn.style.display = '';
            }
        } else {
            // Quick-capture "expand" can prefill the title (opts.title) so the
            // text typed in the modal carries over into the full editor.
            titleInput.value = opts.title || '';
            if (descInput) descInput.value = '';
            if (dateInput) dateInput.value = this.getLocalToday();
            startTimeInput.value = '';
            endTimeInput.value = '';
            if (notifyBeforeSelect) notifyBeforeSelect.value = 0;
            repeatSelect.value = 'none';
            if (weeklyDaySelect) weeklyDaySelect.value = 0;

            const checkboxes = document.querySelectorAll('#schedule-custom-options input[type="checkbox"]');
            checkboxes.forEach(cb => { cb.checked = false; });

            this._editorReminders = [];
            if (remindersSection) remindersSection.style.display = '';
            this._renderEditorReminders();

            if (emailBanner) emailBanner.style.display = 'none';
            deleteBtn.style.display = 'none';
            const dupBtn = document.getElementById('schedule-editor-duplicate-btn');
            if (dupBtn) dupBtn.style.display = 'none';
        }

        this.updateRepeatOptions(repeatSelect.value);

        // Advanced section starts collapsed on every open
        this._showAdvanced = false;
        this._applyAdvancedState();

        // Render linked items
        this.renderEditorLinkedItems(itemId);

        // Update timer section
        this._updateEditorTimerSection();

        // Update completion toggle
        this._updateEditorCompletionSection();

        // Only auto-focus the title for new tasks. For existing tasks,
        // auto-focusing a filled input scrolls the caret to the end and
        // feels like the cursor jumped somewhere unexpected.
        if (!itemId) {
            setTimeout(() => titleInput.focus(), 100);
        }
    },

    // Sync the editor's "Mark complete / Completed" button to the current
    // item's state. Hidden for new items (no itemId). For repeating tasks the
    // state is today-scoped (auto-resets each day); for one-time tasks, any
    // non-null lastCompletedDate is shown as done.
    _updateEditorCompletionSection() {
        const btn = document.getElementById('schedule-editor-complete-btn');
        if (!btn) return;

        const abandonBtn = document.getElementById('schedule-editor-abandon-btn');
        const item = this.currentItemId
            ? this.scheduleItems.find(i => i.id === this.currentItemId)
            : null;

        if (!item) {
            btn.style.display = 'none';
            btn.classList.remove('schedule-editor-complete-btn-done');
            if (abandonBtn) {
                abandonBtn.style.display = 'none';
                abandonBtn.classList.remove('schedule-editor-abandon-btn-on');
            }
            this._renderEditorHistory(null);
            return;
        }

        btn.style.display = '';

        const isRepeating = item.repeat && item.repeat !== 'none';
        let done;
        let label;
        if (isRepeating) {
            done = this.isCompletedToday(item);
            label = done ? 'Completed today \u2713' : 'Mark complete';
        } else {
            done = !!item.lastCompletedDate;
            if (done && item.lastCompletedDate === this.getLocalToday()) {
                label = 'Completed today \u2713';
            } else if (done) {
                label = `Completed ${item.lastCompletedDate} \u2713`;
            } else {
                label = 'Mark complete';
            }
        }

        btn.textContent = label;
        btn.classList.toggle('schedule-editor-complete-btn-done', done);

        if (abandonBtn) {
            abandonBtn.style.display = '';
            const abToday = this.isAbandonedToday(item);
            const lastAb = this.lastAbandonedDate(item);
            let abLabel;
            if (abToday) abLabel = 'Abandoned today \u2715';
            else if (!isRepeating && lastAb) abLabel = `Abandoned ${lastAb} \u2715`;
            else abLabel = 'Mark abandoned';
            abandonBtn.textContent = abLabel;
            abandonBtn.classList.toggle('schedule-editor-abandon-btn-on', abToday || (!isRepeating && !!lastAb));
        }

        this._renderEditorHistory(item);
    },

    /**
     * History section (recurring tasks only): the last due occurrences and
     * what happened on each \u2014 completed, abandoned, or no record. Records
     * accrue from now on via `history`; days before tracking (or before the
     * task existed) show as "no record".
     */
    _renderEditorHistory(item) {
        const section = document.getElementById('schedule-editor-history-section');
        const list = document.getElementById('schedule-editor-history');
        if (!section || !list) return;

        const isRepeating = item && item.repeat && item.repeat !== 'none';
        if (!isRepeating) {
            section.style.display = 'none';
            list.innerHTML = '';
            return;
        }

        const today = this.getLocalToday();
        const firstDay = (item.createdAt || '').slice(0, 10);
        const rows = [];
        const cursor = new Date(today + 'T00:00:00');
        const pad = (n) => String(n).padStart(2, '0');
        // Walk back up to 120 days collecting the last 14 due occurrences.
        for (let i = 0; i < 120 && rows.length < 14; i++) {
            const iso = `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`;
            if (firstDay && iso < firstDay) break;
            const due = this.occursOn(item, iso);
            if (due) {
                let status = 'none';
                if ((item.history && item.history[iso] === 'done') || item.lastCompletedDate === iso) status = 'done';
                else if (item.history && item.history[iso] === 'abandoned') status = 'abandoned';
                rows.push({ iso, status });
            }
            cursor.setDate(cursor.getDate() - 1);
        }

        if (rows.length === 0) {
            section.style.display = 'none';
            list.innerHTML = '';
            return;
        }

        const STATUS = {
            done: '<span class="schedule-history-status is-done">&#10003; Completed</span>',
            abandoned: '<span class="schedule-history-status is-abandoned">&#10005; Abandoned</span>',
            none: '<span class="schedule-history-status is-none">&mdash; No record</span>',
        };
        list.innerHTML = rows.map(r => `
            <div class="schedule-history-row">
                <span class="schedule-history-date">${UIUtils.escapeHtml(ScheduleUI.formatRelativeDate(r.iso, today))}</span>
                <span class="schedule-history-iso">${UIUtils.escapeHtml(r.iso)}</span>
                ${STATUS[r.status]}
            </div>`).join('');
        section.style.display = '';
    },

    /**
     * Render linked items in the schedule editor
     */
    _showLinkedNotes: false,

    renderEditorLinkedItems(itemId) {
        const container = document.getElementById('schedule-linked-section');
        if (!container) return;

        if (!itemId) {
            container.innerHTML = '';
            return;
        }

        // Resolve current goal + focus links
        const resolved = LinkManager.resolveLinks('schedule', itemId);
        const linkedGoal = (resolved.goals || [])[0] || null;
        const linkedFocus = (resolved.focus || [])[0] || null;
        const allGoals = (StorageManager.get('goals') || {}).goals || [];
        const activeGoals = allGoals.filter(g => g.status !== 'completed');
        const allFocus = (StorageManager.get('focus') || {}).focusItems || [];
        // When a goal is linked, the focus area is derived from it (see
        // LinkManager.syncTaskFocusLinks). The picker is read-only in that
        // case — to change focus, change the goal's focus.
        const focusFromGoal = !!linkedGoal && !!linkedFocus;

        let html = `<div class="detail-section-header">Linked</div>`;

        html += `<div class="schedule-goal-picker">
            <label class="schedule-field-label">Focus area${focusFromGoal ? ' <span class="schedule-field-hint">From goal</span>' : ''}</label>
            <div class="schedule-goal-search-wrap">
                <input type="text" id="schedule-focus-search" class="schedule-goal-search"
                    placeholder="${linkedFocus ? '' : (linkedGoal ? 'Goal has no focus area' : 'Search focus areas...')}"
                    value="${linkedFocus ? UIUtils.escapeHtml(linkedFocus.title) : ''}"
                    ${focusFromGoal || linkedGoal ? 'disabled' : ''}>
                ${linkedFocus && !focusFromGoal ? `<button class="schedule-goal-clear" id="schedule-focus-clear" title="Remove">&times;</button>` : ''}
                <div id="schedule-focus-dropdown" class="schedule-goal-dropdown" style="display: none;"></div>
            </div>
        </div>`;

        html += `<div class="schedule-goal-picker">
            <label class="schedule-field-label">Goal</label>
            <div class="schedule-goal-search-wrap">
                <input type="text" id="schedule-goal-search" class="schedule-goal-search" placeholder="${linkedGoal ? '' : 'Search goals...'}" value="${linkedGoal ? UIUtils.escapeHtml(linkedGoal.title) : ''}">
                ${linkedGoal ? `<button class="schedule-goal-clear" id="schedule-goal-clear" title="Remove">&times;</button>` : ''}
                <div id="schedule-goal-dropdown" class="schedule-goal-dropdown" style="display: none;"></div>
            </div>
        </div>`;

        // Notes & Bookmarks collapsible
        const expanded = this._showLinkedNotes;
        html += `<div class="schedule-linked-notes-section">`;
        html += `<button class="focus-linked-toggle schedule-completed-toggle" data-toggle="schedule-linked-notes" aria-expanded="${!!expanded}">
            <span class="schedule-section-title">Notes &amp; Bookmarks</span>
            <span class="schedule-completed-arrow">${expanded ? '&#9652;' : '&#9662;'}</span>
        </button>`;
        html += `<div class="schedule-linked-notes-body" style="display: ${expanded ? 'block' : 'none'};">`;
        html += LinkedItemsUI.renderAll('schedule', itemId, {
            sections: [
                { targetApp: 'notes', label: 'Notes', buttonLabel: '+ Attach Note' },
                { targetApp: 'bookmarks', label: 'Bookmarks', buttonLabel: '+ Link Bookmark' }
            ]
        });
        html += '</div></div>';

        container.innerHTML = html;

        // Goal search behavior
        const searchInput = document.getElementById('schedule-goal-search');
        const dropdown = document.getElementById('schedule-goal-dropdown');
        const clearBtn = document.getElementById('schedule-goal-clear');

        const renderDropdown = (query) => {
            const q = (query || '').toLowerCase();
            const filtered = q ? activeGoals.filter(g => g.title.toLowerCase().includes(q)) : activeGoals;
            if (filtered.length === 0) {
                dropdown.innerHTML = '<div class="schedule-goal-option schedule-goal-empty">No goals found</div>';
            } else {
                dropdown.innerHTML = filtered.map(g => {
                    const statusClass = g.status || 'not-started';
                    return `<div class="schedule-goal-option" data-goal-id="${g.id}">
                        <span class="linked-item-status-dot ${statusClass}"></span>
                        <span>${UIUtils.escapeHtml(g.title)}</span>
                    </div>`;
                }).join('');
            }
            dropdown.style.display = 'block';

            dropdown.querySelectorAll('.schedule-goal-option[data-goal-id]').forEach(opt => {
                opt.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    const goalId = opt.dataset.goalId;
                    // Remove existing goal link if any
                    if (linkedGoal) {
                        LinkManager.removeLink('schedule', itemId, 'goals', linkedGoal.itemId);
                    }
                    LinkManager.addLink('goals', goalId, 'schedule', itemId);
                    this.renderEditorLinkedItems(itemId);
                });
            });
        };

        if (searchInput) {
            searchInput.addEventListener('focus', () => {
                if (linkedGoal) searchInput.value = '';
                renderDropdown(searchInput.value);
            });
            searchInput.addEventListener('input', () => renderDropdown(searchInput.value));
            searchInput.addEventListener('blur', () => {
                dropdown.style.display = 'none';
                if (linkedGoal) searchInput.value = linkedGoal.title;
            });
        }

        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                if (linkedGoal) {
                    LinkManager.removeLink('schedule', itemId, 'goals', linkedGoal.itemId);
                    this.renderEditorLinkedItems(itemId);
                }
            });
        }

        // Focus area search behavior — only active when no goal is linked,
        // because focus inheritance is otherwise driven by the goal.
        const focusSearchInput = document.getElementById('schedule-focus-search');
        const focusDropdown = document.getElementById('schedule-focus-dropdown');
        const focusClearBtn = document.getElementById('schedule-focus-clear');

        const renderFocusDropdown = (query) => {
            const q = (query || '').toLowerCase();
            const filtered = q ? allFocus.filter(f => (f.title || '').toLowerCase().includes(q)) : allFocus;
            if (filtered.length === 0) {
                focusDropdown.innerHTML = '<div class="schedule-goal-option schedule-goal-empty">No focus areas found</div>';
            } else {
                focusDropdown.innerHTML = filtered.map(f => `
                    <div class="schedule-goal-option" data-focus-id="${f.id}">
                        ${f.color ? `<span class="schedule-focus-swatch" style="background:${UIUtils.escapeHtml(f.color)}"></span>` : ''}
                        <span>${UIUtils.escapeHtml(f.title || 'Untitled')}</span>
                    </div>
                `).join('');
            }
            focusDropdown.style.display = 'block';

            focusDropdown.querySelectorAll('.schedule-goal-option[data-focus-id]').forEach(opt => {
                opt.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    const focusId = opt.dataset.focusId;
                    if (linkedFocus) {
                        LinkManager.removeLink('schedule', itemId, 'focus', linkedFocus.itemId);
                    }
                    LinkManager.addLink('focus', focusId, 'schedule', itemId);
                    this.renderEditorLinkedItems(itemId);
                });
            });
        };

        if (focusSearchInput && !focusSearchInput.disabled) {
            focusSearchInput.addEventListener('focus', () => {
                if (linkedFocus) focusSearchInput.value = '';
                renderFocusDropdown(focusSearchInput.value);
            });
            focusSearchInput.addEventListener('input', () => renderFocusDropdown(focusSearchInput.value));
            focusSearchInput.addEventListener('blur', () => {
                focusDropdown.style.display = 'none';
                if (linkedFocus) focusSearchInput.value = linkedFocus.title;
            });
        }

        if (focusClearBtn) {
            focusClearBtn.addEventListener('click', () => {
                if (linkedFocus) {
                    LinkManager.removeLink('schedule', itemId, 'focus', linkedFocus.itemId);
                    this.renderEditorLinkedItems(itemId);
                }
            });
        }

        // Notes & Bookmarks toggle
        const toggle = container.querySelector('[data-toggle="schedule-linked-notes"]');
        if (toggle) {
            toggle.addEventListener('click', () => {
                this._showLinkedNotes = !this._showLinkedNotes;
                const body = container.querySelector('.schedule-linked-notes-body');
                const arrow = toggle.querySelector('.schedule-completed-arrow');
                body.style.display = this._showLinkedNotes ? 'block' : 'none';
                arrow.innerHTML = this._showLinkedNotes ? '&#9652;' : '&#9662;';
                toggle.setAttribute('aria-expanded', this._showLinkedNotes);
            });
        }

        // Notes & Bookmarks link listeners
        const notesBody = container.querySelector('.schedule-linked-notes-body');
        if (notesBody) {
            LinkedItemsUI.attachListeners(notesBody, () => {
                this.renderEditorLinkedItems(itemId);
            });
        }
    },

    closeEditor() {
        const origin = this._editorOrigin;
        this._editorOrigin = null;
        document.getElementById('schedule-editor-view').classList.remove('active');
        this.currentItemId = null;
        this.autoLinkContext = null;

        if (origin === 'calendar') {
            AppManager.openApp('calendar');
            return;
        }

        if (origin === 'actions') {
            AppManager.openApp('actions');
            return;
        }

        // Embedded in Plan's detail pane: the focus view is already active,
        // so just hand the pane back (restores the pre-task selection).
        if (origin === 'plan') {
            FocusApp.closeTaskDetail();
            return;
        }

        if (origin === 'email-insights') {
            // Flag, not a deferred showInsights(): EmailApp.init is async and
            // would overwrite a too-early view switch (see EmailApp.init).
            EmailApp._openToInsights = true;
            AppManager.openApp('email');
            return;
        }

        if (origin && typeof origin === 'object' && origin.app) {
            LinkedItemsUI.navigateToItem(origin.app, origin.itemId);
            return;
        }

        document.getElementById('schedule-view').classList.add('active');
        AppManager.setDetailHash('schedule', null, null);
        this.render();
    },

    saveCurrentItem() {
        const title = document.getElementById('schedule-title-input').value.trim();
        const description = document.getElementById('schedule-description-input')?.value.trim() || '';
        const scheduledDate = document.getElementById('schedule-date-input')?.value || null;
        const startTime = document.getElementById('schedule-start-time').value || '';
        const endTime = document.getElementById('schedule-end-time').value || null;
        const notifyBefore = parseInt(document.getElementById('schedule-notify-before').value) || 0;
        const repeat = document.getElementById('schedule-repeat-select').value;
        const profile = ProfileManager.getProfileForNewItem();

        if (!title) {
            UIUtils.showToast('Please enter a task name', 'error');
            return;
        }

        // Start time is optional — an untimed task is a plain to-do that
        // simply belongs to its date. It just won't fire a time-of-day alert.

        let dayOfWeek = null;
        let repeatDays = [];

        if (repeat === 'weekly') {
            dayOfWeek = parseInt(document.getElementById('schedule-weekly-day').value);
        } else if (repeat === 'custom') {
            const checkboxes = document.querySelectorAll('#schedule-custom-options input[type="checkbox"]:checked');
            repeatDays = Array.from(checkboxes).map(cb => parseInt(cb.value));

            if (repeatDays.length === 0) {
                UIUtils.showToast('Please select at least one day', 'error');
                return;
            }
        }

        // Build reminderDaysBefore: editor reminders + always include day-of (0)
        const reminderDaysBefore = [...this._editorReminders];
        if (!reminderDaysBefore.includes(0)) reminderDaysBefore.push(0);

        if (this.currentItemId) {
            const item = this.scheduleItems.find(i => i.id === this.currentItemId);
            if (item) {
                item.title = title;
                item.description = description;
                item.startTime = startTime;
                item.endTime = endTime;
                item.notifyBefore = notifyBefore;
                item.repeat = repeat;
                item.dayOfWeek = dayOfWeek;
                item.repeatDays = repeatDays;
                // Keep the date for every type: it's the due date for one-time
                // tasks and the START/anchor date for recurring ones.
                item.scheduledDate = scheduledDate || this.getLocalToday();
                item.reminderDaysBefore = (!repeat || repeat === 'none') ? reminderDaysBefore : [];
                item.profile = profile;
                item.modifiedAt = new Date().toISOString();
            }
        } else {
            const newId = UIUtils.generateId();
            this.scheduleItems.push({
                id: newId,
                title,
                description,
                startTime,
                endTime,
                notifyBefore,
                repeat,
                dayOfWeek,
                repeatDays,
                scheduledDate: scheduledDate || this.getLocalToday(),
                reminderDaysBefore: (!repeat || repeat === 'none') ? reminderDaysBefore : [],
                lastCompletedDate: null,
                profile,
                createdAt: new Date().toISOString(),
                modifiedAt: new Date().toISOString()
            });

            // Auto-link if context was set (e.g., creating task from focus/goal view)
            if (this.autoLinkContext) {
                for (const ctx of this.autoLinkContext) {
                    LinkManager.addLink(ctx.app, ctx.itemId, 'schedule', newId);
                }
                this.autoLinkContext = null;
            }
        }

        this.saveData();
        const wasEditing = !!this.currentItemId;
        this.closeEditor();
        UIUtils.showToast(wasEditing ? 'Task updated' : 'Task added', 'success');
    },

    /**
     * Create a task from the quick-add bar: title only, scheduled for today,
     * no time. When a focus area or goal is selected in the sidebar, the new
     * task is auto-linked to it so it lands in the bucket the user is in.
     */
    /**
     * Programmatic task creation for other apps (e.g., the Pomodoro timer
     * turns free-text session labels into real tasks). Same shape as
     * quickAddTask minus the sidebar auto-link and toast; returns the new id.
     */
    createTask(title) {
        title = (title || '').trim();
        if (!title) return null;
        // Callers may run before this view has ever been opened — load
        // first so the push below doesn't clobber stored tasks on save.
        if (this.scheduleItems.length === 0) this.loadData();

        const newId = UIUtils.generateId();
        this.scheduleItems.push({
            id: newId,
            title,
            description: '',
            startTime: '',
            endTime: null,
            notifyBefore: 0,
            repeat: 'none',
            dayOfWeek: null,
            repeatDays: [],
            scheduledDate: this.getLocalToday(),
            reminderDaysBefore: [0],
            lastCompletedDate: null,
            profile: ProfileManager.getProfileForNewItem(),
            createdAt: new Date().toISOString(),
            modifiedAt: new Date().toISOString()
        });

        this.saveData();
        this.render();
        return newId;
    },

    /**
     * Create a task from the quick-add bar. The raw string is run through the
     * natural-language parser, so "Call dentist tomorrow 3pm" lands as a task
     * named "Call dentist" dated tomorrow at 3:00 PM. Returns the new id on
     * success, or null when there is nothing to create (blank, or the input
     * was only date/time words with no task name left).
     */
    quickAddTask(raw, { silent = false } = {}) {
        raw = (raw || '').trim();
        if (!raw) return null;

        const parsed = ScheduleQuickParse.parse(raw, this.getLocalToday());
        const title = parsed.title.trim();
        if (!title) {
            // Everything parsed away (e.g. just "tomorrow 3pm") — nothing to name.
            UIUtils.showToast('Add a task name', 'error');
            return null;
        }
        const f = parsed.fields;

        const newId = UIUtils.generateId();
        this.scheduleItems.push({
            id: newId,
            title,
            description: '',
            startTime: f.startTime || '',
            endTime: f.endTime || null,
            notifyBefore: 0,
            repeat: f.repeat || 'none',
            dayOfWeek: f.dayOfWeek,
            repeatDays: f.repeatDays || [],
            scheduledDate: f.scheduledDate || this.getLocalToday(),
            reminderDaysBefore: [0],
            lastCompletedDate: null,
            profile: ProfileManager.getProfileForNewItem(),
            createdAt: new Date().toISOString(),
            modifiedAt: new Date().toISOString()
        });

        // Auto-link to whatever focus area / goal is selected in the sidebar.
        const filter = this.activeFilter || { type: 'all' };
        if (filter.type === 'focus' && filter.id) {
            LinkManager.addLink('focus', filter.id, 'schedule', newId);
        } else if (filter.type === 'goal' && filter.id) {
            LinkManager.addLink('goals', filter.id, 'schedule', newId);
        }

        this.saveData();
        this.render();
        if (!silent) {
            // Name the date when it isn't today — from the Actions Today view
            // a future-dated task vanishes from the list the moment it's
            // created, so the toast must say where it went.
            const today = this.getLocalToday();
            const sched = f.scheduledDate || today;
            let msg = 'Task added';
            if (sched !== today) {
                const label = ScheduleUI.formatRelativeDate(sched, today);
                msg = `Added for ${label === 'Tomorrow' ? 'tomorrow' : label}`;
            }
            UIUtils.showToast(msg, 'success');
        }
        return newId;
    },

    /**
     * Context-DETACHED quick capture — for callers outside the Tasks view
     * (Actions Today, the global capture modal). Two safety wrappers around
     * quickAddTask:
     *   1. Load guard: quickAddTask has no hydration check, and saving over an
     *      unhydrated (empty) list would clobber the user's tasks.
     *   2. activeFilter neutralization: quickAddTask auto-links new tasks to
     *      the Tasks app's last sidebar filter — invisible from anywhere else,
     *      so it must not apply. Callers that want a link add it explicitly.
     */
    quickAddDetached(raw, opts) {
        if (this.scheduleItems.length === 0) this.loadData();
        const savedFilter = this.activeFilter;
        this.activeFilter = { type: 'all', id: null };
        try {
            return this.quickAddTask(raw, opts);
        } finally {
            this.activeFilter = savedFilter;
        }
    },

    /**
     * Render the live parse preview under the quick-add input: a chip per
     * recognized date/time/repeat, plus the cleaned task name. Hidden when the
     * input is empty or nothing was recognized.
     */
    updateQuickAddPreview(raw) {
        const el = document.getElementById('schedule-quick-add-preview');
        if (!el) return;
        const trimmed = (raw || '').trim();
        if (!trimmed) { el.hidden = true; el.innerHTML = ''; return; }

        const parsed = ScheduleQuickParse.parse(trimmed, this.getLocalToday());
        if (!parsed.hasParse) { el.hidden = true; el.innerHTML = ''; return; }

        const chips = parsed.chips.map(c =>
            `<span class="schedule-parse-chip">${UIUtils.escapeHtml(c.label)}</span>`).join('');
        const titlePreview = parsed.title.trim()
            ? `<span class="schedule-parse-preview-title">&#8594; <strong>${UIUtils.escapeHtml(parsed.title.trim())}</strong></span>`
            : `<span class="schedule-parse-preview-title">Add a task name</span>`;
        el.innerHTML = chips + titlePreview;
        el.hidden = false;
    },

    async deleteCurrentItem() {
        if (!this.currentItemId) return;

        const confirmed = await UIUtils.confirm(
            'Delete Task',
            'Are you sure you want to delete this task?',
            '🗑️'
        );

        if (confirmed) {
            LinkManager.removeAllLinksForItem('schedule', this.currentItemId);
            this.scheduleItems = this.scheduleItems.filter(i => i.id !== this.currentItemId);
            this.saveData();
            this.closeEditor();
            UIUtils.showToast('Task deleted', 'success');
        }
    },

    /**
     * Duplicate the task open in the editor. The copy keeps every field
     * (date, time, repeat, reminders, description) and its goal/focus links,
     * but starts as a fresh, incomplete task: new id, "(copy)" title, no
     * tracked time / running timer, and no email provenance. Opens the
     * copy for immediate editing.
     */
    duplicateCurrentItem() {
        if (!this.currentItemId) return;
        const src = this.scheduleItems.find(i => i.id === this.currentItemId);
        if (!src) return;

        const newId = UIUtils.generateId();
        const now = new Date().toISOString();
        const clone = {
            ...src,
            id: newId,
            title: `${src.title} (copy)`,
            repeatDays: Array.isArray(src.repeatDays) ? [...src.repeatDays] : [],
            reminderDaysBefore: Array.isArray(src.reminderDaysBefore) ? [...src.reminderDaysBefore] : [0],
            lastCompletedDate: null,   // a copy starts incomplete
            totalTimeSpent: 0,
            timerStartedAt: null,
            profile: src.profile || ProfileManager.getProfileForNewItem(),
            createdAt: now,
            modifiedAt: now
        };
        delete clone.sourceEmailId;    // not derived from an email
        this.scheduleItems.push(clone);

        // Carry over the goal / focus links so the copy stays in context.
        for (const targetApp of ['goals', 'focus']) {
            for (const link of LinkManager.getLinksForApp('schedule', src.id, targetApp)) {
                LinkManager.addLink('schedule', newId, targetApp, link.itemId);
            }
        }

        this.saveData();
        UIUtils.showToast('Task duplicated', 'success');
        // Keep the caller's context: an embedded editor (Tasks/Plan pane)
        // stays embedded on the copy, and the back target is preserved.
        this.openEditor(newId, { origin: this._editorOrigin, embedded: !!this._embedHost });
    },

    navigateToSourceEmail(emailId) {
        if (!emailId) return;
        document.getElementById('schedule-editor-view').classList.remove('active');
        document.getElementById('schedule-view').classList.remove('active');
        AppManager.openApp('email');
        // openApp calls init() + render() synchronously, which sets #email-view active.
        // We need to let that complete, then switch to the viewer.
        setTimeout(() => {
            EmailApp.currentView = 'emails';
            EmailApp.openViewer(emailId);
        }, 0);
    },

    // --- Editor reminders management ---

    _editorReminders: [],

    _renderEditorReminders() {
        const list = document.getElementById('schedule-reminders-list');
        if (!list) return;

        if (this._editorReminders.length === 0) {
            list.innerHTML = '<span class="schedule-reminders-empty">No advance reminders set</span>';
            return;
        }

        list.innerHTML = this._editorReminders.map(days => {
            const label = days === 1 ? '1 day before' :
                          days === 7 ? '1 week before' :
                          days === 14 ? '2 weeks before' :
                          days === 21 ? '3 weeks before' :
                          days === 30 ? '1 month before' :
                          `${days} days before`;
            return `<div class="schedule-reminder-chip">
                <span>${label}</span>
                <button class="schedule-reminder-remove" data-days="${days}">&times;</button>
            </div>`;
        }).join('');

        list.querySelectorAll('.schedule-reminder-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const d = parseInt(btn.dataset.days);
                this._editorReminders = this._editorReminders.filter(r => r !== d);
                this._renderEditorReminders();
            });
        });
    },

    _setupReminderAddListener() {
        const select = document.getElementById('schedule-reminder-add-select');
        if (!select) return;
        const newSelect = select.cloneNode(true);
        select.parentNode.replaceChild(newSelect, select);
        newSelect.addEventListener('change', () => {
            const val = parseInt(newSelect.value);
            if (val && !this._editorReminders.includes(val)) {
                this._editorReminders.push(val);
                this._editorReminders.sort((a, b) => b - a);
                this._renderEditorReminders();
            }
            newSelect.value = '';
        });
    },

    /**
     * Get the current task based on current time
     * Returns the first non-completed today item whose time window contains now
     */
    getCurrentTask() {
        const now = new Date();
        const nowMinutes = now.getHours() * 60 + now.getMinutes();
        const todayItems = this.getTodayItems().filter(i => !this.isCompletedToday(i));

        for (let idx = 0; idx < todayItems.length; idx++) {
            const item = todayItems[idx];
            if (!item.startTime) continue;

            const [sh, sm] = item.startTime.split(':').map(Number);
            const startMin = sh * 60 + sm;

            let endMin;
            if (item.endTime) {
                const [eh, em] = item.endTime.split(':').map(Number);
                endMin = eh * 60 + em;
            } else {
                // No end time — use next task's start time, or +30min
                const next = todayItems[idx + 1];
                if (next && next.startTime) {
                    const [nh, nm] = next.startTime.split(':').map(Number);
                    endMin = nh * 60 + nm;
                } else {
                    endMin = startMin + 30;
                }
            }

            if (nowMinutes >= startMin && nowMinutes < endMin) {
                return { item, startMin, endMin, nowMinutes };
            }
        }
        return null;
    },

    // --- Timer ---

    getRunningTimerId() {
        const item = this.scheduleItems.find(i => i.timerStartedAt);
        return item ? item.id : null;
    },

    getElapsedMs(item) {
        let total = item.totalTimeSpent || 0;
        if (item.timerStartedAt) {
            total += Date.now() - new Date(item.timerStartedAt).getTime();
        }
        return Math.max(0, total);
    },

    formatDuration(ms) {
        const totalSeconds = Math.floor(ms / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        if (hours > 0) return `${hours}h ${minutes}m`;
        if (minutes > 0) return `${minutes}m`;
        if (totalSeconds > 0) return `${totalSeconds}s`;
        return '0m';
    },

    formatDurationLive(ms) {
        const totalSeconds = Math.floor(ms / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        return `${minutes}:${String(seconds).padStart(2, '0')}`;
    },

    startTimer(id) {
        const runningId = this.getRunningTimerId();
        if (runningId && runningId !== id) {
            this._stopTimerSilent(runningId);
        }
        const item = this.scheduleItems.find(i => i.id === id);
        if (!item || item.timerStartedAt) return;
        item.timerStartedAt = new Date().toISOString();
        item.modifiedAt = new Date().toISOString();
        this.saveData();
        this.render();
        this._updateEditorTimerSection();
    },

    _stopTimerSilent(id) {
        const item = this.scheduleItems.find(i => i.id === id);
        if (!item || !item.timerStartedAt) return;
        const elapsed = Date.now() - new Date(item.timerStartedAt).getTime();
        item.totalTimeSpent = (item.totalTimeSpent || 0) + Math.max(0, elapsed);
        item.timerStartedAt = null;
        item.modifiedAt = new Date().toISOString();
    },

    stopTimer(id) {
        this._stopTimerSilent(id);
        this.saveData();
        this.render();
        this._updateEditorTimerSection();
    },

    toggleTimer(id) {
        const item = this.scheduleItems.find(i => i.id === id);
        if (!item) return;
        if (item.timerStartedAt) {
            this.stopTimer(id);
        } else {
            this.startTimer(id);
        }
    },

    resetTimer(id) {
        const item = this.scheduleItems.find(i => i.id === id);
        if (!item) return;
        item.timerStartedAt = null;
        item.totalTimeSpent = 0;
        item.modifiedAt = new Date().toISOString();
        this.saveData();
        this._updateEditorTimerSection();
    },

    _updateEditorTimerSection() {
        const section = document.getElementById('schedule-timer-section');
        if (!section) return;

        if (!this.currentItemId) {
            section.style.display = 'none';
            return;
        }

        const item = this.scheduleItems.find(i => i.id === this.currentItemId);
        if (!item) {
            section.style.display = 'none';
            return;
        }

        section.style.display = '';

        const elapsed = this.getElapsedMs(item);
        const isRunning = !!item.timerStartedAt;

        const valueEl = document.getElementById('schedule-editor-timer-value');
        const focusBtn = document.getElementById('schedule-focus-btn');
        const resetBtn = document.getElementById('schedule-timer-reset-btn');

        if (valueEl) {
            valueEl.textContent = isRunning ? this.formatDurationLive(elapsed) : this.formatDuration(elapsed);
            valueEl.classList.toggle('running', isRunning);
        }

        if (focusBtn) {
            focusBtn.innerHTML = isRunning ? 'Focusing&hellip;' : '&#9654; Focus';
            focusBtn.classList.toggle('running', isRunning);
            focusBtn.title = isRunning
                ? 'Open the running focus session'
                : 'Start a Pomodoro focus session for this task';
        }

        if (resetBtn) {
            resetBtn.style.display = elapsed > 0 ? '' : 'none';
        }
    },

    _startTimerTick() {
        if (this._timerTickInterval) {
            clearInterval(this._timerTickInterval);
            this._timerTickInterval = null;
        }
        if (!this.getRunningTimerId()) return;
        this._timerTickInterval = setInterval(() => {
            document.querySelectorAll('.schedule-timer-display[data-timer-running="true"]').forEach(el => {
                const itemId = el.dataset.itemId;
                const item = this.scheduleItems.find(i => i.id === itemId);
                if (item) el.textContent = this.formatDurationLive(this.getElapsedMs(item));
            });
            const editorValue = document.getElementById('schedule-editor-timer-value');
            if (editorValue && this.currentItemId) {
                const item = this.scheduleItems.find(i => i.id === this.currentItemId);
                if (item && item.timerStartedAt) {
                    editorValue.textContent = this.formatDurationLive(this.getElapsedMs(item));
                }
            }
        }, 1000);
    },

    /**
     * Start a timer to refresh the current task indicator every minute
     */
    startCurrentTaskTimer() {
        if (this._currentTaskTimer) clearInterval(this._currentTaskTimer);
        this._currentTaskTimer = setInterval(() => {
            // Only re-render if schedule view is active
            if (document.getElementById('schedule-view')?.classList.contains('active')) {
                this.render();
            }
        }, 60000);
    },

    render() {
        this._renderBreadcrumb();
        ScheduleUI.renderNav(this);
        if (this.viewMode === 'list') {
            ScheduleUI.renderListView(this.getListItems({ applySidebarFilter: true }), this);
        } else {
            ScheduleUI.renderAgenda(this.getGroupedItems({ applySidebarFilter: true }), this);
        }
        ScheduleUI.updateViewToggle(this);
        this.startCurrentTaskTimer();
        this._startTimerTick();
    },

    /**
     * Render the Tasks breadcrumb, reflecting the active sidebar filter.
     * A stale focus/goal filter (target deleted) falls back to "all".
     */
    _renderBreadcrumb() {
        const f = this.activeFilter || { type: 'all' };
        // Actions is the front door of the framework — every altitude's
        // breadcrumb roots there.
        const crumbs = [{ label: 'Actions', action: () => AppManager.openApp('actions') }];
        if (f.type === 'all') {
            crumbs.push({ label: 'Tasks' });
        } else {
            crumbs.push({ label: 'Tasks', action: () => this.setFilter('all') });
            if (f.type === 'unassigned') {
                crumbs.push({ label: 'Unassigned' });
            } else {
                const meta = LinkManager.getItemMeta(f.type === 'focus' ? 'focus' : 'goals', f.id);
                if (!meta) {
                    this.activeFilter = { type: 'all', id: null };
                    return this._renderBreadcrumb();
                }
                crumbs.push({ label: meta.title });
            }
        }
        Breadcrumb.render('schedule-breadcrumb', crumbs);
    },

    _buildTaskCrumbs(taskId, taskTitle) {
        const crumbs = [];

        // When the editor was opened from the Calendar, the breadcrumb should
        // route back there — that's where the user came from and expects to
        // return. Focus/goal links remain reachable from within the editor.
        if (this._editorOrigin === 'calendar') {
            crumbs.push({ label: 'Calendar', action: () => this.closeEditor() });
            crumbs.push({ label: taskId ? 'Task' : 'New Task' });
            return crumbs;
        }

        // Same for the Actions Today view — route back where the user was.
        if (this._editorOrigin === 'actions') {
            crumbs.push({ label: 'Actions', action: () => this.closeEditor() });
            crumbs.push({ label: taskId ? 'Task' : 'New Task' });
            return crumbs;
        }

        if (this._editorOrigin === 'email-insights') {
            crumbs.push({ label: 'AI Insights', action: () => this.closeEditor() });
            crumbs.push({ label: taskId ? 'Task' : 'New Task' });
            return crumbs;
        }

        // Existing tasks read links from storage; brand-new tasks (taskId
        // null) instead derive their breadcrumb from autoLinkContext, since
        // the real links don't exist until save. This keeps "Goals > X >
        // New Task" visible the moment the editor opens from a goal view.
        let focusArea = null;
        let goalCrumb = null;
        if (taskId) {
            focusArea = LinkManager.getFocusForItem('schedule', taskId);
            const goalLinks = LinkManager.getLinksForApp('schedule', taskId, 'goals');
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
            // If the goal lives under a focus area and no focus was passed
            // explicitly, surface that focus too — matches the existing
            // crumb shape for saved tasks.
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
            crumbs.push({ label: 'Tasks', action: () => this.closeEditor() });
        }
        crumbs.push({ label: taskId ? 'Task' : 'New Task' });
        return crumbs;
    },

    renderEditorBreadcrumb(taskId, taskTitle) {
        Breadcrumb.render('schedule-editor-breadcrumb', this._buildTaskCrumbs(taskId, taskTitle));
    }
};

AppManager.register('schedule', ScheduleApp);

// AgentContext provider — exposes the task currently being edited (set
// when the user opens the task editor). Returns null on the list view;
// the global briefing already includes today's tasks, so the per-item
// context only fires for editor-focused asks like "rephrase this task"
// or "what time should I block for this".
if (typeof AgentContext !== 'undefined') {
    AgentContext.register('schedule', () => {
        const id = ScheduleApp.currentItemId;
        if (!id) return null;
        const item = (ScheduleApp.scheduleItems || []).find(t => t && t.id === id);
        if (!item) return null;

        const time = (item.startTime || item.endTime)
            ? `${item.startTime || '?'}–${item.endTime || '?'}`
            : 'no time set';
        const repeat = item.repeat || 'once';
        const isOneTime = !item.repeat || item.repeat === 'none';
        const done = isOneTime ? !!item.lastCompletedDate : ScheduleApp.isCompletedToday(item);
        const status = done ? 'completed' : 'open';

        return {
            recordKey: 'schedule:' + item.id,
            recordLabel: item.title || '(untitled task)',
            title: 'CURRENT TASK',
            body: `The user is editing the schedule task below. The task is available as context, not a constraint:

- When the user's question is about "this task", "this item", or asks to update / complete / delete it, work with the data below. To modify it, call update_schedule_item with id: "${item.id}". To delete, delete_schedule_item with the same id. To toggle done, complete_task.
- For general questions, answer normally.

Title: ${item.title || '(untitled)'}
Time: ${time}
Repeat: ${repeat}
Status: ${status}
Task id: ${item.id}

Description:
${item.description || '(none)'}`,
            suggestedPrompts: [
                'Break this into smaller steps',
                'Estimate how long this will take',
                'Rephrase this as an action verb'
            ]
        };
    });
}
