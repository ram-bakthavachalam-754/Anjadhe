/**
 * Weekly Review — a guided assistant flow, not a dashboard (Actions phase 4,
 * docs/POSITIONING.md). Five steps, top-down through the altitudes:
 *
 *   1. Wins            what got done this week (payoff, no decisions)
 *   2. Goals check     stalled goals -> Still matters / Done / Stuck
 *   3. Overdue sweep   quick reschedule verdicts per item
 *   4. No-date backlog date the undated (phase-3 AI date chips surface here)
 *   5. Week ahead      next 7 days at a glance + optional AI reflection
 *
 * Deterministic by design: all data is computed locally; the only LLM use is
 * one optional closing reflection that never blocks the flow. Verdicts write
 * through the existing primitives (GoalsApp.saveGoals, ScheduleApp
 * rescheduleTask/saveData) — no new storage keys; lastReviewAt lives in the
 * synced actionsSettings blob next to phase-3's aiFiling.
 */

const ActionsReview = {
    STALLED_DAYS: 14,
    WINS_DAYS: 7,
    LIST_CAP: 10,

    step: 0,
    // Computed once at start(); steps re-derive their own lists on mutation.
    _wins: null,
    _reflection: null,
    _reflectionRequested: false,
    // Tallies for the closing reflection.
    tallies: { wins: 0, goalsResolved: 0, rescheduled: 0, dated: 0 },

    STEP_TITLES: ['Wins', 'Goals check', 'Overdue sweep', 'No-date backlog', 'Week ahead'],

    // --- lifecycle ---

    start() {
        this.step = 0;
        this._reflection = null;
        this._reflectionRequested = false;
        this._reflectionPending = false;
        this.tallies = { wins: 0, goalsResolved: 0, rescheduled: 0, dated: 0 };
        this._ensureGoalsLoaded();
        this._wins = this._computeWins();
        this.tallies.wins = this._wins.total;
    },

    // Hydrate-safe goal access: mutate GoalsApp.goals + saveGoals so an
    // already-open Goals view stays consistent.
    _ensureGoalsLoaded() {
        if (typeof GoalsApp !== 'undefined' && (!Array.isArray(GoalsApp.goals) || GoalsApp.goals.length === 0)) {
            GoalsApp.loadGoals();
        }
    },

    _openGoals() {
        this._ensureGoalsLoaded();
        return ProfileManager.filterByActiveProfile(GoalsApp.goals || [])
            .filter(g => g.status !== 'completed');
    },

    _daysAgoISO(days) {
        const d = new Date();
        d.setDate(d.getDate() - days);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },

    // --- step data ---

    _computeWins() {
        const since = this._daysAgoISO(this.WINS_DAYS - 1); // inclusive 7-day window
        const items = ProfileManager.filterByActiveProfile(ScheduleApp.scheduleItems);

        const taskWins = [];
        let repeatCompletions = 0;
        for (const i of items) {
            const oneTime = !i.repeat || i.repeat === 'none';
            if (oneTime) {
                if (i.lastCompletedDate && i.lastCompletedDate >= since) taskWins.push(i.title);
            } else if (i.lastCompletedDate && i.lastCompletedDate >= since) {
                // Repeating tasks keep only their last completion — count it.
                repeatCompletions += 1;
                taskWins.push(i.title);
            }
        }

        this._ensureGoalsLoaded();
        const sinceISO = new Date(since + 'T00:00:00').toISOString();
        const goalWins = ProfileManager.filterByActiveProfile(GoalsApp.goals || [])
            .filter(g => g.status === 'completed' && g.modifiedAt && g.modifiedAt >= sinceISO)
            .map(g => g.title);

        return {
            tasks: taskWins,
            goals: goalWins,
            total: taskWins.length + goalWins.length + (goalWins.length ? 0 : 0),
        };
    },

    // Open goals with no activity in STALLED_DAYS: neither the goal itself
    // nor any linked task was touched or completed recently.
    _stalledGoals() {
        const cutoffISO = new Date(Date.now() - this.STALLED_DAYS * 86400000).toISOString();
        const cutoffDate = this._daysAgoISO(this.STALLED_DAYS);
        const { taskGoals } = ScheduleApp.buildTaskLinkIndex();
        // goalId -> linked task ids (invert the task->goals index once)
        const goalTasks = new Map();
        for (const [taskId, goalSet] of taskGoals) {
            for (const gid of goalSet) {
                if (!goalTasks.has(gid)) goalTasks.set(gid, []);
                goalTasks.get(gid).push(taskId);
            }
        }
        const itemById = new Map(ScheduleApp.scheduleItems.map(i => [i.id, i]));

        return this._openGoals().filter(g => {
            if (g.modifiedAt && g.modifiedAt >= cutoffISO) return false;
            const linked = goalTasks.get(g.id) || [];
            return !linked.some(tid => {
                const t = itemById.get(tid);
                if (!t) return false;
                return (t.modifiedAt && t.modifiedAt >= cutoffISO) ||
                       (t.createdAt && t.createdAt >= cutoffISO) ||
                       (t.lastCompletedDate && t.lastCompletedDate >= cutoffDate);
            });
        });
    },

    _overdueItems() {
        return ScheduleApp.getGroupedItems({ applySidebarFilter: false, applySearch: false }).overdue;
    },

    _noDateItems() {
        return ProfileManager.filterByActiveProfile(ScheduleApp.scheduleItems).filter(i =>
            (!i.repeat || i.repeat === 'none') && !i.lastCompletedDate && !i.scheduledDate && i.title
        );
    },

    _weekAhead() {
        const days = [];
        const items = ProfileManager.filterByActiveProfile(ScheduleApp.scheduleItems);
        for (let off = 0; off < 7; off++) {
            const iso = ScheduleApp.getLocalDate(off);
            const count = items.filter(i => {
                if (!i.repeat || i.repeat === 'none') return i.scheduledDate === iso && !i.lastCompletedDate;
                return ScheduleApp.occursOn(i, iso);
            }).length;
            days.push({ iso, count });
        }
        return days;
    },

    // --- rendering ---

    render() {
        const container = document.getElementById('actions-review-container');
        if (!container) return;

        const dots = this.STEP_TITLES.map((t, i) =>
            `<span class="review-dot ${i === this.step ? 'is-active' : i < this.step ? 'is-done' : ''}" title="${t}"></span>`
        ).join('');

        const bodies = [
            this._renderWins, this._renderGoalsCheck, this._renderOverdue,
            this._renderNoDate, this._renderWeekAhead,
        ];

        container.innerHTML = `
            <div class="review-header">
                <div class="review-step-label">Step ${this.step + 1} of 5 &mdash; ${this.STEP_TITLES[this.step]}</div>
                <div class="review-dots">${dots}</div>
            </div>
            <div class="review-body">${bodies[this.step].call(this)}</div>
            <div class="review-nav">
                ${this.step > 0 ? `<button class="secondary-btn" data-review-nav="back">&#8592; Back</button>` : '<span></span>'}
                ${this.step < 4
                    ? `<button class="primary-btn" data-review-nav="next">Next &#8594;</button>`
                    : `<button class="primary-btn" data-review-nav="finish">Finish review</button>`}
            </div>
        `;
    },

    _renderWins() {
        const w = this._wins || this._computeWins();
        const all = [...w.goals.map(t => ({ t, goal: true })), ...w.tasks.map(t => ({ t, goal: false }))];
        if (all.length === 0) {
            return `<p class="review-lede">A quiet week — nothing marked done in the last 7 days. This review is a good place to restart.</p>`;
        }
        const shown = all.slice(0, this.LIST_CAP);
        return `
            <p class="review-lede">You finished <strong>${all.length}</strong> thing${all.length === 1 ? '' : 's'} this week${w.goals.length ? `, including ${w.goals.length} goal${w.goals.length === 1 ? '' : 's'}` : ''}. Take the credit.</p>
            <div class="review-list">
                ${shown.map(x => `<div class="review-win-row">${x.goal ? '<span class="review-win-goal">Goal</span>' : '&#10003;'} ${UIUtils.escapeHtml(x.t)}</div>`).join('')}
                ${all.length > shown.length ? `<div class="review-more">+${all.length - shown.length} more</div>` : ''}
            </div>`;
    },

    _renderGoalsCheck() {
        const stalled = this._stalledGoals();
        const open = this._openGoals().length;
        if (stalled.length === 0) {
            return `<p class="review-lede">All ${open} open goal${open === 1 ? '' : 's'} saw activity in the last two weeks. Nothing to untangle.</p>`;
        }
        return `
            <p class="review-lede">${stalled.length} goal${stalled.length === 1 ? ' has' : 's have'} had no action in two weeks. Still worth your time?</p>
            <div class="review-list">
                ${stalled.map(g => `
                    <div class="review-goal-card" data-goal-id="${g.id}">
                        <div class="review-goal-title">${UIUtils.escapeHtml(g.title)}</div>
                        <div class="review-verdicts">
                            <button class="secondary-btn review-verdict" data-goal-act="keep" data-goal-id="${g.id}">Still matters</button>
                            <button class="secondary-btn review-verdict" data-goal-act="done" data-goal-id="${g.id}">Done</button>
                            <button class="secondary-btn review-verdict" data-goal-act="stuck" data-goal-id="${g.id}">Stuck &mdash; need help</button>
                        </div>
                    </div>`).join('')}
            </div>`;
    },

    _renderOverdue() {
        const overdue = this._overdueItems();
        if (overdue.length === 0) {
            return `<p class="review-lede">No overdue actions. Clean slate.</p>`;
        }
        const todayStr = ScheduleApp.getLocalToday();
        return `
            <p class="review-lede">${overdue.length} action${overdue.length === 1 ? ' is' : 's are'} overdue. Give each a new home &mdash; or clear the lot.</p>
            <div class="review-bulk"><button class="secondary-btn" data-review-bulk="all-today">Move all to today</button></div>
            <div class="review-list">
                ${overdue.slice(0, this.LIST_CAP).map(i => `
                    <div class="review-item-row" data-item-id="${i.id}">
                        <span class="review-item-title">${UIUtils.escapeHtml(i.title)}</span>
                        <span class="review-item-date">${i.scheduledDate ? UIUtils.escapeHtml(ScheduleUI.formatRelativeDate(i.scheduledDate, todayStr)) : ''}</span>
                        <span class="review-verdicts">
                            <button class="secondary-btn review-verdict" data-when="today" data-item-id="${i.id}">Today</button>
                            <button class="secondary-btn review-verdict" data-when="tomorrow" data-item-id="${i.id}">Tomorrow</button>
                            <button class="secondary-btn review-verdict" data-when="nextweek" data-item-id="${i.id}">Next week</button>
                            <button class="secondary-btn review-verdict" data-when="none" data-item-id="${i.id}">No date</button>
                        </span>
                    </div>`).join('')}
                ${overdue.length > this.LIST_CAP ? `<div class="review-more">+${overdue.length - this.LIST_CAP} more (they stay in Overdue)</div>` : ''}
            </div>`;
    },

    _renderNoDate() {
        const items = this._noDateItems();
        if (items.length === 0) {
            return `<p class="review-lede">Every action has a date. The backlog is honest.</p>`;
        }
        return `
            <p class="review-lede">${items.length} action${items.length === 1 ? ' has' : 's have'} no date &mdash; undated things quietly never happen. Schedule what matters.</p>
            <div class="review-list">
                ${items.slice(0, this.LIST_CAP).map(i => `
                    <div class="review-item-row" data-item-id="${i.id}">
                        <span class="review-item-title">${UIUtils.escapeHtml(i.title)}</span>
                        ${ActionsApp._renderSuggestChips(i)}
                        <span class="review-verdicts">
                            <button class="secondary-btn review-verdict" data-when="today" data-item-id="${i.id}">Today</button>
                            <button class="secondary-btn review-verdict" data-when="tomorrow" data-item-id="${i.id}">Tomorrow</button>
                            <button class="secondary-btn review-verdict" data-when="nextweek" data-item-id="${i.id}">Next week</button>
                        </span>
                    </div>`).join('')}
                ${items.length > this.LIST_CAP ? `<div class="review-more">+${items.length - this.LIST_CAP} more</div>` : ''}
            </div>`;
    },

    _renderWeekAhead() {
        const days = this._weekAhead();
        this._maybeReflect();
        return `
            <p class="review-lede">Your next seven days:</p>
            <div class="review-week">
                ${days.map((d, i) => {
                    const date = new Date(d.iso + 'T00:00:00');
                    const label = i === 0 ? 'Today' : date.toLocaleDateString([], { weekday: 'short' });
                    return `<div class="review-day ${d.count === 0 ? 'is-empty' : ''}">
                        <div class="review-day-name">${label}</div>
                        <div class="review-day-count">${d.count}</div>
                    </div>`;
                }).join('')}
            </div>
            <div id="review-reflection" class="review-reflection">${this._reflectionHtml()}</div>`;
    },

    // --- closing reflection ---
    //
    // A deterministic summary ALWAYS renders (built from the tallies — works
    // with no model at all); the AI version swaps in only if it arrives.
    // Failures are logged, never shown: the step degrades to the deterministic
    // text instead of an empty hole.

    _reflectionPending: false,

    // The numbers worth mentioning, as prose parts. Shared by the fallback
    // text and the AI prompt — zeros are omitted, because small models
    // dutifully narrate them ("zero stalled goals resolved...").
    _tallyParts() {
        const t = this.tallies;
        const parts = [];
        if (t.wins) parts.push(`${t.wins} thing${t.wins === 1 ? '' : 's'} completed this week`);
        if (t.goalsResolved) parts.push(`${t.goalsResolved} stalled goal${t.goalsResolved === 1 ? '' : 's'} resolved`);
        if (t.rescheduled) parts.push(`${t.rescheduled} overdue action${t.rescheduled === 1 ? '' : 's'} rescheduled`);
        if (t.dated) parts.push(`${t.dated} backlog action${t.dated === 1 ? '' : 's'} given dates`);
        return parts;
    },

    _deterministicReflection() {
        const parts = this._tallyParts();
        if (parts.length === 0) return 'A quiet week and a clean slate — this review is your fresh start.';
        return `This week: ${parts.join(', ')}. The books are balanced — see you next week.`;
    },

    _maybeReflect() {
        if (this._reflectionRequested) return;
        this._reflectionRequested = true;
        this._reflectionPending = true;

        // NO maxTokens here: on thinking models the cap includes hidden
        // reasoning tokens — a small cap gets consumed entirely by the think
        // phase and the visible answer comes back EMPTY (observed with a 160
        // cap). Brevity is enforced by the prompt + _trimToSentence instead.
        LLMLogger.call('actions-review', {
            model: AgentService.model,
            logTag: 'actions-review',
            messages: [
                {
                    role: 'system',
                    content: 'You are a calm, encouraging personal assistant. Write a weekly review reflection for the user: 2 to 3 complete sentences, under 60 words. Plain text only, no lists, no emojis, no questions. Mention only the numbers given; do not invent details.'
                },
                { role: 'user', content: (this._tallyParts().join('; ') || 'a quiet week, nothing completed') + '.' }
            ],
            stream: false
        }).then(result => {
            this._reflectionPending = false;
            const text = (result?.message?.content || '').trim();
            if (!text || result?.error) {
                console.warn('[actions-review] reflection unavailable:', result?.error || 'empty response');
                this._updateReflectionEl();
                return;
            }
            this._reflection = this._trimToSentence(text, 500);
            this._updateReflectionEl();
        }).catch((err) => {
            this._reflectionPending = false;
            console.warn('[actions-review] reflection failed:', err?.message);
            this._updateReflectionEl();
        });
    },

    // Never cut mid-word: if over the cap, end at the last sentence boundary
    // (fall back to the last word boundary).
    _trimToSentence(text, max) {
        if (text.length <= max) return text;
        const cut = text.slice(0, max);
        const lastStop = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
        if (lastStop > max * 0.4) return cut.slice(0, lastStop + 1);
        const lastSpace = cut.lastIndexOf(' ');
        return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + '…';
    },

    // Repaint just the reflection area (the user may have navigated Back —
    // the element check keeps this safe). The deterministic text is always
    // there; the AI text replaces it, and the pending note simply disappears
    // on failure.
    _updateReflectionEl() {
        const el = document.getElementById('review-reflection');
        if (!el) return;
        el.innerHTML = this._reflectionHtml();
    },

    _reflectionHtml() {
        const text = this._reflection || this._deterministicReflection();
        return `${UIUtils.escapeHtml(text)}${
            this._reflectionPending
                ? ' <span class="review-reflection-wait">the assistant is adding a thought&hellip;</span>'
                : ''}`;
    },

    // --- verdict + nav handling (delegated from one container listener) ---

    handleClick(e) {
        const nav = e.target.closest('[data-review-nav]');
        if (nav) {
            const dir = nav.dataset.reviewNav;
            if (dir === 'back') this.step = Math.max(0, this.step - 1);
            else if (dir === 'next') this.step = Math.min(4, this.step + 1);
            else if (dir === 'finish') { this._finish(); return true; }
            this.render();
            return true;
        }

        const goalBtn = e.target.closest('[data-goal-act]');
        if (goalBtn) {
            this._goalVerdict(goalBtn.dataset.goalAct, goalBtn.dataset.goalId);
            return true;
        }

        const bulk = e.target.closest('[data-review-bulk]');
        if (bulk) {
            // rescheduleAllOverdue honors the Tasks sidebar filter — neutralize
            // it so the review sweeps everything (same trick as quickAddDetached).
            this.tallies.rescheduled += this._overdueItems().length;
            const saved = ScheduleApp.activeFilter;
            ScheduleApp.activeFilter = { type: 'all', id: null };
            try { ScheduleApp.rescheduleAllOverdue(); }
            finally { ScheduleApp.activeFilter = saved; }
            this.render();
            return true;
        }

        const when = e.target.closest('[data-when]');
        if (when) {
            const inNoDateStep = this.step === 3;
            ScheduleApp.rescheduleTask(when.dataset.itemId, when.dataset.when);
            if (inNoDateStep) this.tallies.dated++;
            else this.tallies.rescheduled++;
            this.render();
            return true;
        }

        // Phase-3 suggestion chips inside step 4 reuse ActionsApp's handler.
        const suggest = e.target.closest('.actions-suggest-act');
        if (suggest) {
            ActionsApp._handleSuggestAction(suggest.dataset.act, suggest.dataset.itemId);
            this.render(); // _handleSuggestAction re-rendered Today; redo review
            return true;
        }
        return false;
    },

    _goalVerdict(act, goalId) {
        this._ensureGoalsLoaded();
        const goal = (GoalsApp.goals || []).find(g => g.id === goalId);
        if (!goal) return;
        if (act === 'keep') {
            // Bumping modifiedAt records the decision AND resets the 14-day clock.
            goal.modifiedAt = new Date().toISOString();
            UIUtils.showToast('Kept — see you next review', 'success');
        } else if (act === 'done') {
            goal.status = 'completed';
            goal.modifiedAt = new Date().toISOString();
            UIUtils.showToast('Goal completed', 'success');
        } else if (act === 'stuck') {
            goal.status = 'need-help';
            goal.modifiedAt = new Date().toISOString();
            UIUtils.showToast('Marked as stuck — ask the assistant for a way in', 'success');
        } else {
            return;
        }
        this.tallies.goalsResolved++;
        GoalsApp.saveGoals();
        this.render();
    },

    _finish() {
        // Read-merge-write so aiFiling (and future fields) survive.
        const settings = StorageManager.get('actionsSettings') || {};
        settings.lastReviewAt = new Date().toISOString();
        StorageManager.set('actionsSettings', settings);
        UIUtils.showToast('Review complete — fresh week ahead', 'success');
        ActionsApp.showToday();
    },
};
