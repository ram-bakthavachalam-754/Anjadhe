/**
 * TaskListUI — the ONE task related-list, shared by every surface that
 * embeds a list of linked tasks (standalone goal page, the goal editor
 * embedded in the Plan pane, and the focus-area detail's per-goal and
 * "Other Tasks" lists). One renderer + one wiring function means the
 * features, sort order, and editing behavior can't drift apart again.
 *
 * Every row offers the same interactions everywhere:
 *   - checkbox completes/uncompletes (repeat-aware, via ScheduleApp)
 *   - title click renames inline
 *   - date pill opens the native date picker (repeat label for repeating)
 *   - clicking the row opens the task — where it opens is the host's
 *     choice via opts.onOpenTask
 *   - the ⋯ button (or right-clicking the row) opens a small menu:
 *     Open, Set date, Delete — Delete confirms first, then the toast
 *     still offers Undo
 *   - "+ New Task" creates inline and drops into rename — never navigates
 *
 * Rows sort action-first: overdue, then pending (by date, then time),
 * completed last.
 *
 * opts (one object shared by render + attach):
 *   onChanged()          host re-render after any mutation
 *   onOpenTask(taskId)   open the task's detail (host navigation)
 *   allowDelete          true — offer Delete in the row menu; omit to hide it
 *   newTask              {links: [{app, id}, …]} — links for "+ New Task"; omit to hide
 *   linkExisting         {app, id} — owner for "+ Add Existing"; omit to hide
 *   aiBreakdown          {goalId, focusId} — show "Suggest tasks" (GoalBreakdown)
 *   title                section header label (default 'Tasks')
 *   emptyText            empty-state copy
 */

const TaskListUI = {

    _esc(s) { return UIUtils.escapeHtml(s == null ? '' : String(s)); },

    _today() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },

    _ensureScheduleLoaded() {
        if (typeof ScheduleApp === 'undefined') return false;
        if (!Array.isArray(ScheduleApp.scheduleItems) || ScheduleApp.scheduleItems.length === 0) {
            ScheduleApp.loadData();
        }
        return true;
    },

    _scheduleItem(taskId) {
        this._ensureScheduleLoaded();
        return (ScheduleApp.scheduleItems || []).find(i => i.id === taskId);
    },

    // --- Task state (matches how the Schedule app groups items) ---

    isCompleted(task, today = this._today()) {
        const repeating = task.repeat && task.repeat !== 'none';
        if (repeating) return task.lastCompletedDate === today;
        return !!task.lastCompletedDate;
    },

    /** Deliberately not done ('abandoned' in history) — resolved, same as
     *  completed: never pending, never overdue. */
    isAbandoned(task, today = this._today()) {
        const h = (task.history && typeof task.history === 'object') ? task.history : {};
        const repeating = task.repeat && task.repeat !== 'none';
        if (repeating) return h[today] === 'abandoned';
        return Object.values(h).includes('abandoned');
    },

    /** 'overdue' | 'pending' | 'completed' | 'abandoned' — abandoned sorts
     *  and styles with completed, it just keeps the honest label. */
    stateOf(task, today = this._today()) {
        if (this.isCompleted(task, today)) return 'completed';
        if (this.isAbandoned(task, today)) return 'abandoned';
        const repeating = task.repeat && task.repeat !== 'none';
        if (!repeating && task.scheduledDate && task.scheduledDate < today) return 'overdue';
        return 'pending';
    },

    /** "Every Mon" / "Tomorrow" / "Jul 20" (+ " · 2:00 PM" when timed). */
    dateLabel(task, today = this._today()) {
        const parts = [];
        if (task.repeat && task.repeat !== 'none') {
            parts.push(ScheduleUI.getRepeatLabel(task));
        } else if (task.scheduledDate) {
            parts.push(ScheduleUI.formatRelativeDate(task.scheduledDate, today));
        }
        const time = ScheduleUI.formatTime(task.startTime);
        if (time) parts.push(time);
        return parts.join(' &middot; ');
    },

    /** Action-first order: overdue, pending, completed — then date, then time. */
    sort(tasks) {
        const today = this._today();
        const order = { overdue: 0, pending: 1, completed: 2, abandoned: 2 };
        return [...tasks].sort((a, b) =>
            (order[this.stateOf(a, today)] - order[this.stateOf(b, today)])
            || (a.scheduledDate || '9999').localeCompare(b.scheduledDate || '9999')
            || (a.startTime || '').localeCompare(b.startTime || '')
            || (a.title || '').localeCompare(b.title || ''));
    },

    // --- Rendering ---

    /**
     * Full section: header row ("Tasks · n/m done" + actions) above the list.
     */
    renderSection(tasks, opts = {}) {
        const done = tasks.filter(t => this.isCompleted(t) || this.isAbandoned(t)).length;
        const actions = [
            opts.aiBreakdown ? `<button type="button" class="secondary-btn task-list-ai-btn" title="Ask the assistant to break this goal into tasks">&#10022; Suggest tasks</button>` : '',
            opts.newTask ? `<button type="button" class="secondary-btn task-list-new-btn">+ New Task</button>` : '',
            opts.linkExisting ? `<button type="button" class="secondary-btn task-list-link-btn">+ Add Existing</button>` : ''
        ].join('');
        return `<div class="task-list-section">
            <div class="detail-section-header-row">
                <span class="detail-section-header">${this._esc(opts.title || 'Tasks')}${tasks.length ? ` <span class="detail-section-count">${done}/${tasks.length} done</span>` : ''}</span>
                ${actions ? `<div class="detail-section-actions">${actions}</div>` : ''}
            </div>
            ${this.renderList(tasks, opts)}
        </div>`;
    },

    /**
     * Just the list (or the empty state) — used bare inside the focus-area
     * detail's goal cards, which bring their own chrome.
     */
    renderList(tasks, opts = {}) {
        if (!tasks.length) {
            return `<div class="task-list-empty">${opts.emptyText || 'No tasks yet &mdash; break this into concrete steps.'}</div>`;
        }
        const today = this._today();
        const rows = this.sort(tasks).map(t => {
            const state = this.stateOf(t, today);
            const resolved = state === 'completed' || state === 'abandoned';
            const label = state === 'abandoned'
                ? ['Abandoned', this.dateLabel(t, today)].filter(Boolean).join(' &middot; ')
                : this.dateLabel(t, today);
            return `<div class="task-row${resolved ? ' task-row--completed' : ''}" data-task-id="${t.itemId}" title="Open task">
                <input type="checkbox" class="task-row-check" data-task-id="${t.itemId}"
                       ${resolved ? 'checked' : ''}${state === 'abandoned' ? ' data-abandoned="1"' : ''}
                       title="${state === 'abandoned' ? 'Abandoned — uncheck to restore' : resolved ? 'Mark not done' : 'Mark done'}">
                <span class="task-row-title" data-edit-title="${t.itemId}" title="Click to rename">${this._esc(t.title)}</span>
                <span class="task-row-date${state === 'overdue' ? ' is-overdue' : ''}${label ? '' : ' is-empty'}" data-edit-date="${t.itemId}"
                      title="Click to set date">${label || 'Set date'}</span>
                <button type="button" class="task-row-menu" data-task-id="${t.itemId}" title="More actions">&#8943;</button>
            </div>`;
        }).join('');
        return `<div class="task-list">${rows}</div>`;
    },

    // --- Wiring ---

    /**
     * Wire every task row (and any section action buttons) under `root`.
     * Call once per list instance so per-instance context (new-task links,
     * owner ids) stays unambiguous.
     */
    attach(root, opts = {}) {
        if (!root) return;
        const changed = () => { if (opts.onChanged) opts.onChanged(); };

        root.querySelectorAll('.task-row-check').forEach(cb =>
            cb.addEventListener('change', (e) => {
                e.stopPropagation();
                this._ensureScheduleLoaded();
                // An abandoned row's checkbox restores the task (clears the
                // abandoned mark) — toggleComplete here would mark it done.
                if (cb.dataset.abandoned) ScheduleApp.toggleAbandoned(cb.dataset.taskId);
                else ScheduleApp.toggleComplete(cb.dataset.taskId);
                changed();
            }));

        root.querySelectorAll('.task-row-title').forEach(el =>
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                this.beginTitleEdit(el.dataset.editTitle, el, opts);
            }));

        root.querySelectorAll('.task-row-date').forEach(el =>
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                this.beginDateEdit(el.dataset.editDate, el, opts);
            }));

        root.querySelectorAll('.task-row-menu').forEach(btn =>
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const r = btn.getBoundingClientRect();
                this.openMenu(btn.dataset.taskId, { x: r.right, y: r.bottom + 2 }, opts);
            }));

        // The whole row opens the task; inner controls stopPropagation.
        // Right-click anywhere on the row opens the same actions menu.
        root.querySelectorAll('.task-row').forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.closest('.task-row-check, .task-row-title, .task-row-date, .task-row-menu')) return;
                if (opts.onOpenTask) opts.onOpenTask(row.dataset.taskId);
            });
            row.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.openMenu(row.dataset.taskId, { x: e.clientX, y: e.clientY }, opts);
            });
        });

        if (opts.newTask) {
            root.querySelectorAll('.task-list-new-btn').forEach(btn =>
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.createLinkedTask(opts.newTask.links || [], opts);
                }));
        }

        // "Suggest tasks" — GoalBreakdown runs the LLM pass and its
        // confirm-before-add modal; accepted rows land via the same
        // goal+area links as "+ New Task".
        if (opts.aiBreakdown && typeof GoalBreakdown !== 'undefined') {
            root.querySelectorAll('.task-list-ai-btn').forEach(btn =>
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    GoalBreakdown.suggest(opts.aiBreakdown, opts);
                }));
        }

        if (opts.linkExisting) {
            root.querySelectorAll('.task-list-link-btn').forEach(btn =>
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const { app, id } = opts.linkExisting;
                    const excludeIds = LinkManager.getLinksForApp(app, id, 'schedule').map(l => l.itemId);
                    LinkPicker.show({
                        targetApp: 'schedule',
                        exclude: excludeIds,
                        onSelect: (item) => {
                            LinkManager.addLink(app, id, 'schedule', item.id);
                            changed();
                        }
                    });
                }));
        }
    },

    /**
     * Small anchored actions menu for a row — one menu at a time, closed
     * by any outside click, Escape, or picking an action.
     */
    openMenu(taskId, at, opts = {}) {
        this.closeMenu();
        const items = [
            { label: 'Open', act: () => { if (opts.onOpenTask) opts.onOpenTask(taskId); } },
            { label: 'Set date', act: () => this.beginDateEdit(taskId, null, opts) },
            ...(opts.extraItems || []),
            ...(opts.allowDelete ? [{ label: 'Delete', danger: true, act: () => this.deleteWithUndo(taskId, opts) }] : [])
        ];
        const menu = document.createElement('div');
        menu.className = 'task-menu';
        menu.innerHTML = items.map((it, i) =>
            `<button type="button" class="task-menu-item${it.danger ? ' task-menu-item--danger' : ''}" data-idx="${i}">${it.label}</button>`
        ).join('');
        document.body.appendChild(menu);
        this._menu = menu;

        // Position: below-left of the anchor point, clamped to the viewport.
        const mw = menu.offsetWidth, mh = menu.offsetHeight;
        menu.style.left = `${Math.max(8, Math.min(at.x - mw, window.innerWidth - mw - 8))}px`;
        menu.style.top = `${Math.min(at.y, window.innerHeight - mh - 8)}px`;

        menu.addEventListener('click', (e) => {
            const btn = e.target.closest('.task-menu-item');
            if (!btn) return;
            e.stopPropagation();
            this.closeMenu();
            items[Number(btn.dataset.idx)].act();
        });
        this._menuDismiss = (e) => {
            if (e.type === 'keydown' && e.key !== 'Escape') return;
            if (e.type === 'mousedown' && e.target.closest('.task-menu')) return;
            this.closeMenu();
        };
        document.addEventListener('mousedown', this._menuDismiss, true);
        document.addEventListener('keydown', this._menuDismiss, true);
    },

    closeMenu() {
        if (this._menu && this._menu.parentNode) this._menu.parentNode.removeChild(this._menu);
        this._menu = null;
        if (this._menuDismiss) {
            document.removeEventListener('mousedown', this._menuDismiss, true);
            document.removeEventListener('keydown', this._menuDismiss, true);
            this._menuDismiss = null;
        }
    },

    /**
     * Confirm, delete, then still offer Undo in the toast. The snapshot
     * keeps the task object and every link it had, so Undo restores both.
     */
    async deleteWithUndo(taskId, opts = {}) {
        this._ensureScheduleLoaded();
        const item = this._scheduleItem(taskId);
        if (!item) return;
        const confirmed = await UIUtils.confirm(
            'Delete Task',
            'Are you sure you want to delete this task?',
            '🗑️'
        );
        if (!confirmed) return;
        const links = LinkManager.loadLinks().filter(l =>
            (l.sourceApp === 'schedule' && l.sourceId === taskId) ||
            (l.targetApp === 'schedule' && l.targetId === taskId));
        ScheduleApp.deleteTask(taskId);
        if (opts.onChanged) opts.onChanged();
        UIUtils.showToast('Task deleted', 'success', 6000, {
            actionLabel: 'Undo',
            onAction: () => {
                this._ensureScheduleLoaded();
                if (!ScheduleApp.scheduleItems.find(i => i.id === taskId)) {
                    item.modifiedAt = new Date().toISOString();
                    ScheduleApp.scheduleItems.push(item);
                    ScheduleApp.saveData();
                }
                links.forEach(l => LinkManager.addLink(l.sourceApp, l.sourceId, l.targetApp, l.targetId));
                if (opts.onChanged) opts.onChanged();
            }
        });
    },

    /**
     * Create a task inline (dated today), link it to each {app, id} given,
     * re-render the host, then drop straight into renaming the new row.
     */
    createLinkedTask(links, opts = {}) {
        this._ensureScheduleLoaded();
        const newId = ScheduleApp.createTask('New task');
        if (!newId) return;
        for (const l of links) {
            if (l && l.app && l.id) LinkManager.addLink(l.app, l.id, 'schedule', newId);
        }
        if (opts.onChanged) opts.onChanged();
        setTimeout(() => this.beginTitleEdit(newId, null, opts), 0);
    },

    /** Swap the title span for an input; Enter/blur commits, Escape cancels. */
    beginTitleEdit(taskId, spanEl, opts = {}) {
        const el = spanEl || document.querySelector(`[data-edit-title="${taskId}"]`);
        if (!el) return;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'task-row-input';
        input.value = el.textContent;
        el.replaceWith(input);
        input.focus();
        input.select();
        let done = false;
        const finish = (commit) => {
            if (done) return;
            done = true;
            if (commit) {
                const item = this._scheduleItem(taskId);
                const clean = (input.value || '').trim();
                if (item && clean && item.title !== clean) {
                    item.title = clean;
                    item.modifiedAt = new Date().toISOString();
                    ScheduleApp.saveData();
                }
            }
            if (opts.onChanged) opts.onChanged();
        };
        input.addEventListener('blur', () => finish(true));
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
            else if (ev.key === 'Escape') finish(false);
        });
    },

    /**
     * Open the native date picker anchored to the pill via an invisible
     * proxy input — the pill itself never turns into a form field.
     */
    beginDateEdit(taskId, chipEl, opts = {}) {
        const el = chipEl || document.querySelector(`[data-edit-date="${taskId}"]`);
        if (!el) return;
        const item = this._scheduleItem(taskId);
        const input = document.createElement('input');
        input.type = 'date';
        input.className = 'task-row-date-proxy';
        input.value = (item && item.scheduledDate) || '';
        ['click', 'mousedown'].forEach(t => input.addEventListener(t, (e) => e.stopPropagation()));
        el.style.position = 'relative';
        el.appendChild(input);

        let done = false;
        const cleanup = () => { if (input.parentNode) input.parentNode.removeChild(input); };
        const commit = () => {
            if (done) return;
            done = true;
            cleanup();
            const it = this._scheduleItem(taskId);
            const next = input.value || null;
            if (it && it.scheduledDate !== next) {
                it.scheduledDate = next;
                it.modifiedAt = new Date().toISOString();
                ScheduleApp.saveData();
            }
            if (opts.onChanged) opts.onChanged();
        };
        const cancel = () => { if (done) return; done = true; cleanup(); };
        input.addEventListener('change', commit);
        input.addEventListener('blur', cancel);

        input.focus({ preventScroll: true });
        if (input.showPicker) { try { input.showPicker(); } catch (_) { cancel(); } }
        else { cancel(); }
    }
};
