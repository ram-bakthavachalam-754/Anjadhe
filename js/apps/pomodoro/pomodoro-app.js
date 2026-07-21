/**
 * Pomodoro App
 *
 * Classic Pomodoro timer with cycle-aware focus/short-break/long-break
 * progression, today's stats, recent sessions, and a rotating quote pulled
 * from the shared QuotesLibrary.
 */

const PomodoroApp = {
    // Persisted state
    settings: null,
    sessions: [],
    currentTask: '',
    linkedTaskId: null,         // optional Schedule app item id linked to current task

    // The task (currentTask + linkedTaskId) is per-profile: each profile
    // remembers its own active task so switching profiles never surfaces
    // another profile's task. Map of profileId -> { currentTask, linkedTaskId };
    // `_taskProfile` is whichever profile's task is currently loaded above.
    _tasksByProfile: {},
    _taskProfile: null,
    _syncingProfile: false,

    // Active timer state (volatile)
    mode: 'focus',              // 'focus' | 'short' | 'long'
    customDurations: {},        // per-mode one-off duration overrides (ms), set by clicking the time
    _editingTime: false,
    durationMs: 0,
    remainingMs: 0,
    isRunning: false,
    tickHandle: null,
    endsAt: null,               // wall-clock ms when running; null when paused
    cycleCount: 0,              // focus sessions completed since last long break

    quote: null,
    settingsOpen: false,
    _initialized: false,
    _eventsBound: false,
    _keyHandler: null,
    _taskModal: null,

    DEFAULT_SETTINGS: {
        focusMin: 25,
        shortBreakMin: 5,
        longBreakMin: 15,
        sessionsPerCycle: 4,
        autoStartBreaks: true,
        autoStartFocus: false,
        soundEnabled: true,
        notificationEnabled: true,
    },

    MODE_LABELS: {
        focus: 'Focus',
        short: 'Short Break',
        long: 'Long Break',
    },

    init() {
        this.loadData();
        if (!this._initialized) {
            this._initialized = true;
            if (!this._restoreTimer()) this.resetTimer();
            this.refreshQuote();
            // A restored running session (or the break a retroactive
            // completion auto-started) needs the tick even if the Pomodoro
            // view is never opened.
            if (this.isRunning) this.startTickLoop();
        }
    },

    loadData() {
        const data = StorageManager.get('pomodoro') || {};
        this.settings = { ...this.DEFAULT_SETTINGS, ...(data.settings || {}) };
        this.sessions = Array.isArray(data.sessions) ? data.sessions : [];
        // Per-profile task memory. Legacy blobs stored a single global
        // currentTask/linkedTaskId — fold those into the 'default' profile.
        this._tasksByProfile = (data.tasksByProfile && typeof data.tasksByProfile === 'object')
            ? data.tasksByProfile : {};
        if (!data.tasksByProfile && (data.currentTask || data.linkedTaskId)) {
            this._tasksByProfile.default = {
                currentTask: data.currentTask || '',
                linkedTaskId: data.linkedTaskId || null,
            };
        }
        const active = this._activeProfileId();
        const entry = this._tasksByProfile[active] || {};
        this.currentTask = entry.currentTask || '';
        this.linkedTaskId = entry.linkedTaskId || null;
        this._taskProfile = active;
        this._pendingTimer = (data.timer && typeof data.timer === 'object') ? data.timer : null;
        this.cycleCount = this.completedFocusToday() % this.settings.sessionsPerCycle;
    },

    _activeProfileId() {
        return (typeof ProfileManager !== 'undefined')
            ? ProfileManager.getActiveProfileId() : 'default';
    },

    // Reconcile the loaded task with the active profile. When the profile has
    // changed since the task was loaded, bank the outgoing profile's task into
    // the map, restore the incoming profile's own task (blank for a fresh
    // profile), and reset the timer to a clean ready state. Partial focus time
    // is preserved on the outgoing linked task before the swap.
    _syncProfileTask() {
        if (this._syncingProfile) return;
        const active = this._activeProfileId();
        if (this._taskProfile === active) return;
        this._syncingProfile = true;
        if (this._taskProfile) {
            this._tasksByProfile[this._taskProfile] = {
                currentTask: this.currentTask,
                linkedTaskId: this.linkedTaskId,
            };
        }
        if (this.mode === 'focus') this._setTaskTimer(false);
        const entry = this._tasksByProfile[active] || {};
        this.currentTask = entry.currentTask || '';
        this.linkedTaskId = entry.linkedTaskId || null;
        this._taskProfile = active;
        // Clean ready state for the incoming profile (mirrors setMode('focus')).
        this.mode = 'focus';
        this.isRunning = false;
        this.endsAt = null;
        this.durationMs = this.durationMsForMode('focus');
        this.remainingMs = this.durationMs;
        this.saveData();
        this._syncingProfile = false;
    },

    saveData() {
        // Persist the loaded profile's task into the per-profile map.
        const prof = this._taskProfile || this._activeProfileId();
        if (!this._tasksByProfile) this._tasksByProfile = {};
        this._tasksByProfile[prof] = {
            currentTask: this.currentTask,
            linkedTaskId: this.linkedTaskId,
        };
        StorageManager.set('pomodoro', {
            settings: this.settings,
            sessions: this.sessions,
            tasksByProfile: this._tasksByProfile,
            // Mirror the active profile's task at top-level for backward compat.
            currentTask: this.currentTask,
            linkedTaskId: this.linkedTaskId,
            // Running/paused timer survives a refresh; endsAt is the
            // authoritative wall-clock deadline while running.
            timer: {
                mode: this.mode,
                isRunning: this.isRunning,
                endsAt: this.endsAt,
                remainingMs: this.remainingMs,
                durationMs: this.durationMs,
            },
        });
    },

    /**
     * Restore the persisted timer after a refresh/restart. Returns true when
     * a usable state existed. A session that ran out while the app wasn't
     * running is completed retroactively at its actual end time.
     */
    _restoreTimer() {
        const t = this._pendingTimer;
        this._pendingTimer = null;
        if (!t || !['focus', 'short', 'long'].includes(t.mode)) return false;
        this.mode = t.mode;
        this.durationMs = (t.durationMs > 0) ? t.durationMs : this.durationMsForMode(t.mode);

        if (t.isRunning && t.endsAt > 0) {
            const left = t.endsAt - Date.now();
            if (left > 0) {
                this.isRunning = true;
                this.endsAt = t.endsAt;
                this.remainingMs = left;
                // The linked task's own timer persisted through the refresh;
                // this is a no-op then, but restarts it if it was lost.
                if (this.mode === 'focus') this._setTaskTimer(true);
                return true;
            }
            // Ran out while the app was closed — credit the task only up to
            // the session's actual end (Date.now() would over-credit the
            // gap), then complete retroactively.
            this.isRunning = false;
            this.endsAt = null;
            this.remainingMs = 0;
            if (this.mode === 'focus') this._closeTaskTimerAt(t.endsAt);
            this.completeTimer(t.endsAt);
            return true;
        }

        // Paused or ready
        this.isRunning = false;
        this.endsAt = null;
        this.remainingMs = (t.remainingMs > 0 && t.remainingMs <= this.durationMs)
            ? t.remainingMs : this.durationMs;
        return true;
    },

    // Bank time on the linked task up to a specific wall-clock moment.
    _closeTaskTimerAt(endMs) {
        const item = this.linkedTask();
        if (!item || !item.timerStartedAt) return;
        const startedMs = new Date(item.timerStartedAt).getTime();
        item.totalTimeSpent = (item.totalTimeSpent || 0) + Math.max(0, endMs - startedMs);
        item.timerStartedAt = null;
        item.modifiedAt = new Date().toISOString();
        ScheduleApp.saveData();
    },

    /**
     * Today's open tasks from the Schedule app, used to populate the picker.
     * Defensive: ScheduleApp may not have loaded its data yet if the user
     * hasn't visited the Schedule view this session.
     */
    getScheduleTasks() {
        if (typeof ScheduleApp === 'undefined') return [];
        try {
            if (!Array.isArray(ScheduleApp.scheduleItems) || ScheduleApp.scheduleItems.length === 0) {
                ScheduleApp.loadData?.();
            }
            const today = ScheduleApp.getTodayItems?.() || [];
            const fmt = (typeof ScheduleUI !== 'undefined' && ScheduleUI.formatTime)
                ? (s) => ScheduleUI.formatTime(s)
                : (s) => s || '';
            return today
                .filter(t => !this._taskResolved(t))
                .map(t => ({
                    id: t.id,
                    title: t.title || '(untitled)',
                    startTime: fmt(t.startTime),
                }));
        } catch (_) {
            return [];
        }
    },

    // ---------- Tasks app integration ----------
    // Pomodoro has no task model of its own — a session's task IS a Schedule
    // item. Focus sessions drive the item's built-in timer (timerStartedAt /
    // totalTimeSpent), so start/stop and accumulated time show up on the
    // task card in the Tasks app. Free text in the input is only scratch
    // until a focus session starts, at which point it becomes a real task.

    _scheduleReady() {
        if (typeof ScheduleApp === 'undefined') return false;
        if (!Array.isArray(ScheduleApp.scheduleItems) || ScheduleApp.scheduleItems.length === 0) {
            try { ScheduleApp.loadData?.(); } catch (_) { return false; }
        }
        return true;
    },

    // Completed OR abandoned — either way the task is resolved and shouldn't
    // be offered for a focus session (abandoned = deliberately not done).
    _taskResolved(t) {
        if (ScheduleApp.isCompletedToday?.(t) || ScheduleApp.isAbandonedToday?.(t)) return true;
        const isOneTime = !t.repeat || t.repeat === 'none';
        return isOneTime && !!(t.lastCompletedDate || ScheduleApp.lastAbandonedDate?.(t));
    },

    linkedTask() {
        if (!this.linkedTaskId || !this._scheduleReady()) return null;
        return ScheduleApp.scheduleItems.find(i => i.id === this.linkedTaskId) || null;
    },

    /**
     * Resolve the typed task label to a real Schedule item when a focus
     * session starts: reuse an open task with the same title today, else
     * create one in the Tasks app.
     */
    _ensureLinkedTask() {
        if (!this._scheduleReady()) return;
        if (this.linkedTask()) return;
        this.linkedTaskId = null; // drop a stale link to a deleted task
        const title = (this.currentTask || '').trim();
        if (!title) return;
        const existing = (ScheduleApp.getTodayItems?.() || []).find(t =>
            !this._taskResolved(t) &&
            (t.title || '').trim().toLowerCase() === title.toLowerCase());
        this.linkedTaskId = existing ? existing.id : ScheduleApp.createTask(title);
        if (this.linkedTaskId) {
            this.saveData();
            if (!existing) UIUtils.showToast('Task added to Tasks', 'success');
        }
    },

    // Start/stop the linked task's own timer in the Tasks app. Idempotent,
    // so it's safe to call from every mode transition.
    _setTaskTimer(on) {
        const item = this.linkedTask();
        if (!item) return;
        try {
            if (on && !item.timerStartedAt) ScheduleApp.startTimer(item.id);
            else if (!on && item.timerStartedAt) ScheduleApp.stopTimer(item.id);
        } catch (_) { /* Tasks view may be mid-teardown; time is still safe in storage */ }
    },

    // After a focus session on a linked task, offer to check it off.
    async _offerMarkTaskDone() {
        const item = this.linkedTask();
        if (!item) return;
        if (this._taskResolved(item)) return;
        const ok = await UIUtils.confirm(
            'Pomodoro complete',
            `Mark "${this.escape(item.title)}" as done in Tasks?`,
            '&#10003;',
            { cancelText: 'Still Working on it', confirmText: 'Mark Done' }
        );
        if (!ok) return;
        ScheduleApp.toggleComplete(item.id);
        this.currentTask = '';
        this.linkedTaskId = null;
        this.saveData();
        this.renderUI();
    },

    /**
     * Entry point for the Tasks app (detail-page Focus button and card play
     * buttons): start — or jump back to — a focus session for a specific
     * schedule item. Replaces the old free-running stopwatch.
     */
    startForTask(taskId) {
        if (!this._initialized) this.init();
        if (!this._scheduleReady()) return;
        const item = ScheduleApp.scheduleItems.find(i => i.id === taskId);
        if (!item) return;

        AppManager.openApp('pomodoro');

        // Already focusing this task: resume if paused, otherwise just land
        // on the running timer.
        if (this.mode === 'focus' && this.linkedTaskId === taskId) {
            if (!this.isRunning) this.startTimer();
            return;
        }

        this.setMode('focus', false); // closes out any other session / task timer
        this.linkedTaskId = taskId;
        this.currentTask = item.title || '';
        this.saveData();
        this.startTimer();
    },

    render() {
        // Swap to the active profile's own task before painting, so opening
        // Pomodoro (or switching profiles while it's open) never shows another
        // profile's task.
        this._syncProfileTask();
        Breadcrumb.render('pomodoro-breadcrumb', [
            { label: 'Pomodoro' },
        ]);
        this.renderUI();   // calls bindEvents() internally
        this.startTickLoop();
    },

    // ---------- Timer logic ----------

    durationMsForMode(mode) {
        if (this.customDurations[mode]) return this.customDurations[mode];
        return this.settingsDurationMs(mode);
    },

    settingsDurationMs(mode) {
        const m = mode === 'short' ? this.settings.shortBreakMin
                : mode === 'long'  ? this.settings.longBreakMin
                :                    this.settings.focusMin;
        return Math.max(1, m) * 60 * 1000;
    },

    setMode(mode, autoStart = false) {
        // Leaving (or restarting) focus closes out the linked task's timer,
        // so partial time from skips/resets still lands on the task.
        if (this.mode === 'focus') this._setTaskTimer(false);
        this.mode = mode;
        this.durationMs = this.durationMsForMode(mode);
        this.remainingMs = this.durationMs;
        this.isRunning = false;
        this.endsAt = null;
        if (autoStart) {
            this.startTimer();
        } else {
            this.saveData();
            this.renderUI();
        }
    },

    resetTimer() {
        this.setMode(this.mode, false);
    },

    startTimer() {
        if (this.isRunning) return;
        if (this.mode === 'focus') this._ensureLinkedTask();
        this.isRunning = true;
        this.endsAt = Date.now() + this.remainingMs;
        if (this.mode === 'focus') this._setTaskTimer(true);
        this.saveData();
        this.renderUI();
    },

    pauseTimer() {
        if (!this.isRunning) return;
        this.remainingMs = Math.max(0, this.endsAt - Date.now());
        this.isRunning = false;
        this.endsAt = null;
        if (this.mode === 'focus') this._setTaskTimer(false);
        this.saveData();
        this.renderUI();
    },

    toggleStartPause() {
        if (this.isRunning) this.pauseTimer();
        else this.startTimer();
    },

    skipTimer() {
        // Move to next mode without logging current as completed
        this.advanceMode(false);
    },

    // ---------- Inline duration edit ----------

    canEditTime() {
        // Only before the timer has started — editing mid-session would
        // make "remaining" ambiguous.
        return !this.isRunning && this.remainingMs === this.durationMs;
    },

    /**
     * Swap the big time display for an inline input. Commits on Enter/blur,
     * cancels on Escape. The value becomes a one-off override for the
     * current mode (kept until the matching setting is changed); it is
     * volatile, so a restart falls back to settings.
     */
    startTimeEdit() {
        if (!this.canEditTime() || this._editingTime) return;
        const el = document.getElementById('pomodoro-time-display');
        if (!el) return;
        this._editingTime = true;

        const minutes = Math.round(this.durationMs / 60000);
        el.innerHTML = `<input id="pomodoro-time-edit" class="pomodoro-time-edit" type="text"
            inputmode="numeric" value="${minutes}" aria-label="Duration (minutes, or mm:ss)" />`;
        const input = el.querySelector('input');

        const finish = (commit) => {
            if (!this._editingTime) return;
            this._editingTime = false;
            if (commit) {
                const ms = this.parseDurationInput(input.value);
                if (ms) {
                    // An edit back to the settings value clears the override
                    // so later settings changes apply again.
                    if (ms === this.settingsDurationMs(this.mode)) delete this.customDurations[this.mode];
                    else this.customDurations[this.mode] = ms;
                    this.durationMs = ms;
                    this.remainingMs = ms;
                    this.saveData();
                }
            }
            this.renderUI();
        };
        input.addEventListener('keydown', (e) => {
            e.stopPropagation(); // keep Space from toggling the timer mid-type
            if (e.key === 'Enter') finish(true);
            else if (e.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(true));
        input.focus();
        input.select();
    },

    // "10" → 10 minutes, "10:30" → 10m 30s. Clamped to 1 min – 3 h;
    // returns null when unparseable.
    parseDurationInput(raw) {
        const v = String(raw || '').trim();
        let ms = 0;
        const mmss = v.match(/^(\d{1,3}):([0-5]?\d)$/);
        if (mmss) ms = (parseInt(mmss[1]) * 60 + parseInt(mmss[2])) * 1000;
        else if (/^\d+(\.\d+)?$/.test(v)) ms = parseFloat(v) * 60000;
        if (!ms) return null;
        return Math.min(180 * 60000, Math.max(60000, Math.round(ms)));
    },

    completeTimer(endedAtMs = Date.now()) {
        const wasFocus = this.mode === 'focus';
        const completedAt = new Date(endedAtMs).toISOString();
        this.sessions.push({
            id: endedAtMs.toString(),
            type: this.mode,
            durationMin: Math.round(this.durationMs / 60000),
            startedAt: new Date(endedAtMs - this.durationMs).toISOString(),
            completedAt,
            taskLabel: wasFocus ? (this.currentTask || '').trim() : '',
            linkedTaskId: wasFocus ? (this.linkedTaskId || null) : null,
        });
        if (wasFocus) {
            this.cycleCount = (this.cycleCount + 1) % this.settings.sessionsPerCycle;
        }
        this.saveData();
        this.notifyEnd();
        this.advanceMode(true); // setMode inside stops the linked task's timer
        if (wasFocus) this._offerMarkTaskDone();
    },

    /**
     * Advance from the current mode to the next in the cycle.
     * @param {boolean} fromCompletion — true when called from completeTimer (governs auto-start)
     */
    advanceMode(fromCompletion) {
        let nextMode;
        if (this.mode === 'focus') {
            // After enough focuses, take a long break
            const justCompletedFocus = fromCompletion ? this.completedFocusToday() : this.completedFocusToday() + 1;
            const inCycle = justCompletedFocus % this.settings.sessionsPerCycle;
            nextMode = inCycle === 0 ? 'long' : 'short';
        } else {
            nextMode = 'focus';
        }
        const shouldAutoStart = fromCompletion && (
            (nextMode === 'focus' && this.settings.autoStartFocus) ||
            (nextMode !== 'focus' && this.settings.autoStartBreaks)
        );
        this.setMode(nextMode, shouldAutoStart);
    },

    /**
     * Tick loop — recomputes remainingMs from wall clock so it stays accurate
     * even if the tab is backgrounded or the user hops between views.
     */
    startTickLoop() {
        if (this.tickHandle) return;
        this.tickHandle = setInterval(() => {
            // Completion runs regardless of the active view so the session
            // is logged and the linked task's timer stops on time, not
            // whenever the user happens to come back to this view.
            if (this.isRunning) {
                const left = Math.max(0, this.endsAt - Date.now());
                this.remainingMs = left;
                if (left <= 0) {
                    this.completeTimer();
                    return;
                }
            }
            if (AppManager.currentApp !== 'pomodoro') return;
            this.updateLiveElements();
        }, 250);
    },

    // ---------- Stats ----------

    isToday(iso) {
        if (!iso) return false;
        const d = new Date(iso);
        const now = new Date();
        return d.getFullYear() === now.getFullYear()
            && d.getMonth() === now.getMonth()
            && d.getDate() === now.getDate();
    },

    todaysSessions() {
        return this.sessions.filter(s => this.isToday(s.completedAt));
    },

    completedFocusToday() {
        return this.todaysSessions().filter(s => s.type === 'focus').length;
    },

    minutesFocusedToday() {
        return this.todaysSessions()
            .filter(s => s.type === 'focus')
            .reduce((sum, s) => sum + (s.durationMin || 0), 0);
    },

    formatDuration(min) {
        if (min < 60) return `${min}m`;
        const h = Math.floor(min / 60);
        const m = min % 60;
        return m === 0 ? `${h}h` : `${h}h ${m}m`;
    },

    formatTime(ms) {
        const total = Math.max(0, Math.ceil(ms / 1000));
        const m = Math.floor(total / 60);
        const s = total % 60;
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    },

    formatRelative(iso) {
        const then = new Date(iso).getTime();
        const diffMin = Math.round((Date.now() - then) / 60000);
        if (diffMin < 1) return 'just now';
        if (diffMin < 60) return `${diffMin}m ago`;
        const diffHr = Math.round(diffMin / 60);
        if (diffHr < 24) return `${diffHr}h ago`;
        const diffDay = Math.round(diffHr / 24);
        return `${diffDay}d ago`;
    },

    // ---------- Quote ----------

    refreshQuote() {
        if (typeof QuotesLibrary === 'undefined') {
            this.quote = null;
            return;
        }
        const all = QuotesLibrary.search('');
        if (!all.length) {
            this.quote = null;
            return;
        }
        // Avoid repeating the same quote twice in a row when possible
        let next;
        for (let i = 0; i < 5; i++) {
            next = all[Math.floor(Math.random() * all.length)];
            if (!this.quote || next.text !== this.quote.text) break;
        }
        this.quote = next;
    },

    // ---------- Notifications & sound ----------

    notifyEnd() {
        const justFinished = this.MODE_LABELS[this.mode];
        if (this.settings.soundEnabled) this.playChime();
        if (this.settings.notificationEnabled && typeof Notification !== 'undefined') {
            try {
                if (Notification.permission === 'granted') {
                    new Notification(`${justFinished} complete`, {
                        body: this.mode === 'focus'
                            ? 'Nice work. Time to step away.'
                            : 'Break\'s up. Ready for another round?',
                        silent: true,
                    });
                } else if (Notification.permission !== 'denied') {
                    Notification.requestPermission();
                }
            } catch (_) { /* notifications may be unavailable in some sandboxes */ }
        }
    },

    playChime() {
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            const ctx = new Ctx();
            const tones = this.mode === 'focus'
                ? [659.25, 783.99, 987.77]  // E5 G5 B5 — celebratory rising
                : [587.33, 493.88];          // D5 B4 — gentle two-tone for end of break
            tones.forEach((freq, i) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.value = freq;
                const t0 = ctx.currentTime + i * 0.18;
                gain.gain.setValueAtTime(0, t0);
                gain.gain.linearRampToValueAtTime(0.25, t0 + 0.04);
                gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.6);
                osc.connect(gain).connect(ctx.destination);
                osc.start(t0);
                osc.stop(t0 + 0.65);
            });
            setTimeout(() => ctx.close && ctx.close(), 1500);
        } catch (_) { /* audio may be blocked before any user gesture */ }
    },

    // ---------- Rendering ----------

    renderUI() {
        const root = document.getElementById('pomodoro-content');
        if (!root) return;

        const focusCount = this.completedFocusToday();
        const focusMin = this.minutesFocusedToday();
        const breakCount = this.todaysSessions().filter(s => s.type !== 'focus').length;
        const cyclePos = this.cycleCount;
        const total = this.settings.sessionsPerCycle;
        const recent = [...this.todaysSessions()].reverse().slice(0, 6);
        const modeLabel = this.MODE_LABELS[this.mode];

        // Build session dots
        let dotsHtml = '';
        for (let i = 0; i < total; i++) {
            const filled = i < cyclePos;
            const current = i === cyclePos && this.mode === 'focus';
            dotsHtml += `<span class="pomodoro-dot${filled ? ' filled' : ''}${current ? ' current' : ''}"></span>`;
        }

        const recentHtml = recent.length
            ? recent.map(s => {
                const label = s.type === 'focus'
                    ? (s.taskLabel || 'Focus')
                    : (s.type === 'long' ? 'Long break' : 'Short break');
                const cls = s.type === 'focus' ? 'pomodoro-recent-focus' : 'pomodoro-recent-break';
                return `
                    <li class="pomodoro-recent-item ${cls}">
                        <span class="pomodoro-recent-label" title="${this.escape(label)}">${this.escape(label)}</span>
                        <span class="pomodoro-recent-meta">${s.durationMin}m &middot; ${this.formatRelative(s.completedAt)}</span>
                    </li>`;
            }).join('')
            : '<li class="pomodoro-recent-empty">No sessions yet today.</li>';

        const quoteHtml = this.quote
            ? `
                <p class="pomodoro-quote-text">&ldquo;${this.escape(this.quote.text)}&rdquo;</p>
                <p class="pomodoro-quote-author">&mdash; ${this.escape(this.quote.author || 'Unknown')}${this.quote.theme ? ` <span class="pomodoro-quote-theme">${this.escape(this.quote.theme)}</span>` : ''}</p>
              `
            : '<p class="pomodoro-quote-empty">No quotes available.</p>';

        // Settings panel
        const s = this.settings;
        const settingsHtml = `
            <div id="pomodoro-settings-panel" class="pomodoro-settings-panel" ${this.settingsOpen ? '' : 'hidden'}>
                <div class="pomodoro-settings-section">
                    <div class="pomodoro-section-header">Durations</div>
                    <div class="pomodoro-settings-grid">
                        <label>Focus
                            <span class="pomodoro-input-row">
                                <input type="number" id="ps-focus" min="1" max="120" value="${s.focusMin}" />
                                <span class="pomodoro-input-suffix">min</span>
                            </span>
                        </label>
                        <label>Short break
                            <span class="pomodoro-input-row">
                                <input type="number" id="ps-short" min="1" max="60" value="${s.shortBreakMin}" />
                                <span class="pomodoro-input-suffix">min</span>
                            </span>
                        </label>
                        <label>Long break
                            <span class="pomodoro-input-row">
                                <input type="number" id="ps-long" min="1" max="60" value="${s.longBreakMin}" />
                                <span class="pomodoro-input-suffix">min</span>
                            </span>
                        </label>
                        <label>Sessions per set
                            <span class="pomodoro-input-row">
                                <input type="number" id="ps-cycle" min="2" max="10" value="${s.sessionsPerCycle}" />
                            </span>
                        </label>
                    </div>
                </div>
                <div class="pomodoro-settings-section">
                    <div class="pomodoro-section-header">Behavior</div>
                    <div class="pomodoro-settings-checks">
                        <label class="pomodoro-check"><input type="checkbox" id="ps-autobreak" ${s.autoStartBreaks ? 'checked' : ''}/> Auto-start breaks</label>
                        <label class="pomodoro-check"><input type="checkbox" id="ps-autofocus" ${s.autoStartFocus ? 'checked' : ''}/> Auto-start next focus session</label>
                        <label class="pomodoro-check"><input type="checkbox" id="ps-sound" ${s.soundEnabled ? 'checked' : ''}/> Play chime when timer ends</label>
                        <label class="pomodoro-check"><input type="checkbox" id="ps-notify" ${s.notificationEnabled ? 'checked' : ''}/> Show desktop notifications</label>
                    </div>
                </div>
            </div>`;

        // Mode tabs — show the effective duration (inline override or setting)
        const effMin = (mode) => Math.round(this.durationMsForMode(mode) / 60000);
        const modes = [
            { key: 'focus', label: 'Focus', sub: `${effMin('focus')}m` },
            { key: 'short', label: 'Short Break', sub: `${effMin('short')}m` },
            { key: 'long', label: 'Long Break', sub: `${effMin('long')}m` },
        ];
        const tabsHtml = modes.map(m => `
            <button class="pomodoro-mode-tab ${this.mode === m.key ? 'active' : ''}" data-mode="${m.key}">
                <span class="pomodoro-mode-tab-label">${m.label}</span>
                <span class="pomodoro-mode-tab-sub">${m.sub}</span>
            </button>
        `).join('');

        // Ring geometry
        const radius = 110;
        const circumference = 2 * Math.PI * radius;
        const progress = this.durationMs > 0 ? (this.durationMs - this.remainingMs) / this.durationMs : 0;
        const dashOffset = circumference * (1 - progress);

        root.innerHTML = `
            ${settingsHtml}
            <div class="pomodoro-layout">
                <section class="pomodoro-main">
                    <div class="pomodoro-mode-tabs" role="tablist">
                        ${tabsHtml}
                    </div>

                    <div class="pomodoro-timer-stage">
                        <svg class="pomodoro-ring" viewBox="0 0 240 240" aria-hidden="true">
                            <circle class="pomodoro-ring-track" cx="120" cy="120" r="${radius}"></circle>
                            <circle class="pomodoro-ring-progress" cx="120" cy="120" r="${radius}"
                                style="stroke-dasharray: ${circumference}; stroke-dashoffset: ${dashOffset};"></circle>
                        </svg>
                        <div class="pomodoro-time-stack">
                            <div class="pomodoro-mode-label">${modeLabel}</div>
                            <div id="pomodoro-time-display"
                                 class="pomodoro-time${this.canEditTime() ? ' pomodoro-time-editable' : ''}"
                                 ${this.canEditTime() ? 'role="button" tabindex="0" title="Click to set a custom duration"' : ''}>${this.formatTime(this.remainingMs)}</div>
                            <div class="pomodoro-state-label">${this.isRunning ? 'Running' : (this.remainingMs < this.durationMs ? 'Paused' : 'Ready')}</div>
                        </div>
                    </div>

                    <div class="pomodoro-task-row">
                        <div class="pomodoro-task-field ${this.linkedTaskId ? 'is-linked' : ''}">
                            <input id="pomodoro-task-input" type="text" class="pomodoro-task-input"
                                placeholder="What are you working on?"
                                value="${this.escape(this.currentTask)}"
                                ${this.mode === 'focus' ? '' : 'disabled'} />
                        </div>
                        ${this.mode === 'focus' ? this.renderTaskPicker() : ''}
                    </div>

                    <div class="pomodoro-controls">
                        <button id="pomodoro-startpause-btn" class="pomodoro-btn pomodoro-btn-primary">
                            ${this.isRunning ? 'Pause' : (this.remainingMs < this.durationMs ? 'Resume' : 'Start')}
                        </button>
                        <button id="pomodoro-reset-btn" class="pomodoro-btn">Reset</button>
                        <button id="pomodoro-skip-btn" class="pomodoro-btn">Skip</button>
                    </div>

                    <div class="pomodoro-cycle">
                        <div class="pomodoro-cycle-dots">${dotsHtml}</div>
                        <div class="pomodoro-cycle-label">
                            ${cyclePos} of ${total} in this set
                            <span class="pomodoro-cycle-hint">&middot; long break after #${total}</span>
                        </div>
                    </div>

                    <div class="pomodoro-hint">
                        Press <kbd>Space</kbd> to start or pause. Click the time to set a custom duration.
                    </div>
                </section>

                <aside class="pomodoro-aside">
                    <div class="pomodoro-card pomodoro-stats-card">
                        <div class="pomodoro-section-header">Today</div>
                        <div class="pomodoro-stat-grid">
                            <div class="pomodoro-stat">
                                <div class="pomodoro-stat-num">${focusCount}</div>
                                <div class="pomodoro-stat-label">Pomodoros</div>
                            </div>
                            <div class="pomodoro-stat">
                                <div class="pomodoro-stat-num">${this.formatDuration(focusMin)}</div>
                                <div class="pomodoro-stat-label">Focused</div>
                            </div>
                            <div class="pomodoro-stat">
                                <div class="pomodoro-stat-num">${breakCount}</div>
                                <div class="pomodoro-stat-label">Breaks</div>
                            </div>
                        </div>
                    </div>

                    <div class="pomodoro-card pomodoro-recent-card">
                        <div class="pomodoro-section-header">Recent</div>
                        <ul class="pomodoro-recent-list">
                            ${recentHtml}
                        </ul>
                    </div>

                    <div class="pomodoro-card pomodoro-quote-card">
                        <div class="pomodoro-quote-header">
                            <span class="pomodoro-section-header">A thought</span>
                            <button id="pomodoro-quote-refresh" class="pomodoro-quote-refresh" title="New quote" aria-label="New quote">&#8634;</button>
                        </div>
                        ${quoteHtml}
                    </div>
                </aside>
            </div>
        `;

        // Re-bind listeners — innerHTML replacement above wiped out all inner
        // DOM nodes, so any click handlers on tabs / controls / inputs are
        // gone. Without this, the second click on any pomodoro tab does
        // nothing and the panel appears frozen.
        this.bindEvents();
    },

    renderTaskPicker() {
        const linked = !!this.linkedTaskId;
        const label = linked ? 'Unlink' : 'From tasks';
        const cls = linked ? 'pomodoro-task-pick-btn is-linked' : 'pomodoro-task-pick-btn';
        return `
            <div class="pomodoro-task-picker">
                <button id="pomodoro-task-pick-btn" class="${cls}" type="button">
                    ${label}
                    ${linked ? '' : '<span class="pomodoro-task-pick-caret">&#9662;</span>'}
                </button>
            </div>
        `;
    },

    openHelpModal() {
        const content = `
            <p class="pomodoro-help-lede">
                The Pomodoro Technique is a time-management method built around short,
                focused work intervals separated by deliberate breaks. It was developed
                by Francesco Cirillo in the late 1980s &mdash; "pomodoro" is Italian
                for tomato, named after the kitchen timer Cirillo used as a student.
            </p>

            <h4 class="pomodoro-help-heading">How it works</h4>
            <ol class="pomodoro-help-list">
                <li>Pick a task and start a focus session &mdash; <strong>25 minutes</strong> of uninterrupted work.</li>
                <li>When the timer ends, take a <strong>short break</strong> of about 5 minutes.</li>
                <li>After <strong>4 focus sessions</strong>, take a longer 15-minute break.</li>
                <li>Repeat. Adjust the durations in Settings if a different rhythm suits you.</li>
            </ol>

            <h4 class="pomodoro-help-heading">Why it helps</h4>
            <ul class="pomodoro-help-list">
                <li><strong>Lowers the bar to start.</strong> A 25-minute commitment is much easier to begin than "work on this all afternoon." The hardest part of focused work is starting.</li>
                <li><strong>Protects attention.</strong> Knowing a break is coming makes it easier to ignore notifications or the urge to switch tabs &mdash; you can defer interruptions to the next break.</li>
                <li><strong>Builds sustainable rhythm.</strong> Short cycles with built-in rest are more sustainable than long marathon sessions, which often end in fatigue and lower-quality output.</li>
                <li><strong>Creates visible progress.</strong> Counting completed sessions gives concrete feedback, even on tasks where the finish line isn't in sight.</li>
                <li><strong>Sharpens estimation.</strong> Over time you learn how many sessions a typical task takes &mdash; useful for planning.</li>
            </ul>

            <h4 class="pomodoro-help-heading">Tips for getting the most out of it</h4>
            <ul class="pomodoro-help-list">
                <li><strong>Single-task during the focus.</strong> No email, no chat, no quick lookups unrelated to the task. If something comes up, jot it down and handle it on the break.</li>
                <li><strong>Take real breaks.</strong> Stand up, look away from the screen, drink water. A break spent doomscrolling doesn't reset your attention.</li>
                <li><strong>Don't pause when distracted.</strong> Reset and start over. The discipline of the unbroken 25 is part of the value.</li>
                <li><strong>Pair it with a task.</strong> Use <em>From tasks</em> to link a task from the Tasks app so each session has a clear goal.</li>
            </ul>
        `;

        Modal.create({
            title: 'About the Pomodoro Technique',
            className: 'pomodoro-help-modal',
            content,
            buttons: [
                { text: 'Got it', className: 'primary-btn' },
            ],
        });
    },

    openTaskPickerModal() {
        const tasks = this.getScheduleTasks();
        const linkedId = this.linkedTaskId;

        let listHtml;
        if (tasks.length === 0) {
            listHtml = `
                <div class="pomodoro-task-modal-empty">
                    <p>No open tasks for today.</p>
                    <p class="pomodoro-task-modal-empty-hint">Add tasks in the Tasks app and they'll show up here.</p>
                </div>`;
        } else {
            listHtml = `
                <ul class="pomodoro-task-modal-list">
                    ${tasks.map(t => `
                        <li>
                            <button class="pomodoro-task-modal-item ${t.id === linkedId ? 'is-current' : ''}"
                                    data-task-id="${this.escape(t.id)}"
                                    data-task-title="${this.escape(t.title)}">
                                ${t.startTime
                                    ? `<span class="pomodoro-task-modal-time">${this.escape(t.startTime)}</span>`
                                    : '<span class="pomodoro-task-modal-time pomodoro-task-modal-time-empty">&mdash;</span>'}
                                <span class="pomodoro-task-modal-title">${this.escape(t.title)}</span>
                                ${t.id === linkedId ? '<span class="pomodoro-task-modal-current-badge">Current</span>' : ''}
                            </button>
                        </li>
                    `).join('')}
                </ul>`;
        }

        const content = `
            <p class="pomodoro-task-modal-intro">
                Pick a task from today's list to focus on. The session will be linked to that task when you finish.
            </p>
            ${listHtml}
        `;

        this._taskModal = Modal.create({
            title: 'Choose a task',
            className: 'pomodoro-task-modal',
            content,
            buttons: [
                {
                    text: 'Open Tasks',
                    className: 'secondary-btn',
                    onClick: () => {
                        this._taskModal?.close();
                        AppManager.openApp('schedule');
                    },
                },
                {
                    text: 'Cancel',
                    className: 'secondary-btn',
                    onClick: () => this._taskModal?.close(),
                },
            ],
            onClose: () => { this._taskModal = null; },
        });

        this._taskModal.body.querySelectorAll('.pomodoro-task-modal-item').forEach(item => {
            item.addEventListener('click', () => {
                this.linkedTaskId = item.dataset.taskId;
                this.currentTask = item.dataset.taskTitle;
                this.saveData();
                this._taskModal?.close();
                this.renderUI();
            });
        });
    },

    /**
     * Lightweight per-tick update: only the time digits and progress ring,
     * to avoid rebuilding the whole DOM 4x/second.
     */
    updateLiveElements() {
        if (this._editingTime) return; // don't clobber the inline duration input
        const timeEl = document.getElementById('pomodoro-time-display');
        if (timeEl) timeEl.textContent = this.formatTime(this.remainingMs);

        const ring = document.querySelector('#pomodoro-content .pomodoro-ring-progress');
        if (ring) {
            const radius = 110;
            const circumference = 2 * Math.PI * radius;
            const progress = this.durationMs > 0 ? (this.durationMs - this.remainingMs) / this.durationMs : 0;
            ring.style.strokeDashoffset = circumference * (1 - progress);
        }

        const stateLabel = document.querySelector('#pomodoro-content .pomodoro-state-label');
        if (stateLabel) {
            stateLabel.textContent = this.isRunning
                ? 'Running'
                : (this.remainingMs < this.durationMs ? 'Paused' : 'Ready');
        }
    },

    bindEvents() {
        const root = document.getElementById('pomodoro-content');
        if (!root) return;

        // Mode tabs
        root.querySelectorAll('.pomodoro-mode-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                this.setMode(tab.dataset.mode, false);
            });
        });

        // Controls
        root.querySelector('#pomodoro-startpause-btn')?.addEventListener('click', () => this.toggleStartPause());
        root.querySelector('#pomodoro-reset-btn')?.addEventListener('click', () => this.resetTimer());
        root.querySelector('#pomodoro-skip-btn')?.addEventListener('click', () => this.skipTimer());

        // Inline duration edit on the time display (idle only)
        const timeDisplay = root.querySelector('#pomodoro-time-display');
        if (timeDisplay) {
            timeDisplay.addEventListener('click', () => this.startTimeEdit());
            timeDisplay.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); this.startTimeEdit(); }
            });
        }

        // Task input
        const taskInput = root.querySelector('#pomodoro-task-input');
        if (taskInput) {
            taskInput.addEventListener('input', () => {
                this.currentTask = taskInput.value;
                // If the user types something different from the linked task's
                // title, drop the link — the label no longer represents the
                // schedule item.
                if (this.linkedTaskId) {
                    const linked = this.getScheduleTasks().find(t => t.id === this.linkedTaskId);
                    if (!linked || linked.title !== taskInput.value) {
                        this.linkedTaskId = null;
                        // Update the picker button label without rebuilding the input
                        // (rebuilding would steal focus from the user mid-type).
                        const btn = document.getElementById('pomodoro-task-pick-btn');
                        if (btn) {
                            btn.textContent = 'From tasks ';
                            btn.classList.remove('is-linked');
                            const caret = document.createElement('span');
                            caret.className = 'pomodoro-task-pick-caret';
                            caret.innerHTML = '&#9662;';
                            btn.appendChild(caret);
                        }
                        const field = root.querySelector('.pomodoro-task-field');
                        if (field) field.classList.remove('is-linked');
                    }
                }
                this.saveData();
            });
            taskInput.addEventListener('keydown', (e) => {
                // Avoid space-toggling timer while typing
                e.stopPropagation();
            });
        }

        // Task picker button: open modal, OR unlink if already linked
        const pickBtn = root.querySelector('#pomodoro-task-pick-btn');
        if (pickBtn) {
            pickBtn.addEventListener('click', () => {
                if (this.linkedTaskId) {
                    // Unlink: keep the text in the input so the user doesn't lose context
                    this.linkedTaskId = null;
                    this.saveData();
                    this.renderUI();
                } else {
                    this.openTaskPickerModal();
                }
            });
        }

        // Quote refresh
        root.querySelector('#pomodoro-quote-refresh')?.addEventListener('click', () => {
            this.refreshQuote();
            this.renderUI();
        });

        // Settings button (in app header) + panel inputs
        const settingsBtn = document.getElementById('pomodoro-settings-btn');
        if (settingsBtn && !settingsBtn._pomodoroBound) {
            settingsBtn._pomodoroBound = true;
            settingsBtn.addEventListener('click', () => {
                this.settingsOpen = !this.settingsOpen;
                this.renderUI();
            });
        }

        // Help button (in app header) — opens the technique explainer modal
        const helpBtn = document.getElementById('pomodoro-help-btn');
        if (helpBtn && !helpBtn._pomodoroBound) {
            helpBtn._pomodoroBound = true;
            helpBtn.addEventListener('click', () => this.openHelpModal());
        }
        this.bindSettingsInputs(root);

        // Keyboard shortcut: Space toggles start/pause when on this page
        if (!this._keyHandler) {
            this._keyHandler = (e) => {
                if (AppManager.currentApp !== 'pomodoro') return;
                if (e.code !== 'Space') return;
                const tag = (e.target?.tagName || '').toLowerCase();
                if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;
                e.preventDefault();
                this.toggleStartPause();
            };
            document.addEventListener('keydown', this._keyHandler);
        }
    },

    bindSettingsInputs(root) {
        const handlers = [
            ['ps-focus',     'focusMin',           v => Math.max(1, Math.min(120, parseInt(v) || 25)), 'focus'],
            ['ps-short',     'shortBreakMin',      v => Math.max(1, Math.min(60,  parseInt(v) || 5)),  'short'],
            ['ps-long',      'longBreakMin',       v => Math.max(1, Math.min(60,  parseInt(v) || 15)), 'long'],
            ['ps-cycle',     'sessionsPerCycle',   v => Math.max(2, Math.min(10,  parseInt(v) || 4)),  null],
        ];
        handlers.forEach(([id, key, sanitize, modeKey]) => {
            const el = root.querySelector(`#${id}`);
            if (!el) return;
            el.addEventListener('change', () => {
                const next = sanitize(el.value);
                this.settings[key] = next;
                // A settings change wins over any inline one-off override.
                if (modeKey) delete this.customDurations[modeKey];
                this.saveData();
                // If editing the active mode's duration while idle, update its remaining
                if (!this.isRunning && this.remainingMs === this.durationMs) {
                    this.durationMs = this.durationMsForMode(this.mode);
                    this.remainingMs = this.durationMs;
                }
                this.cycleCount = this.completedFocusToday() % this.settings.sessionsPerCycle;
                this.renderUI();
            });
        });
        const checks = [
            ['ps-autobreak', 'autoStartBreaks'],
            ['ps-autofocus', 'autoStartFocus'],
            ['ps-sound',     'soundEnabled'],
            ['ps-notify',    'notificationEnabled'],
        ];
        checks.forEach(([id, key]) => {
            const el = root.querySelector(`#${id}`);
            if (!el) return;
            el.addEventListener('change', () => {
                this.settings[key] = el.checked;
                this.saveData();
                if (key === 'notificationEnabled' && el.checked
                    && typeof Notification !== 'undefined'
                    && Notification.permission === 'default') {
                    try { Notification.requestPermission(); } catch (_) {}
                }
            });
        });
    },

    escape(str) {
        return AppManager.escapeHtml(str || '');
    },
};

AppManager.register('pomodoro', PomodoroApp);
