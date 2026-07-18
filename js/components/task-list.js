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
 *   - clicking the row (or its arrow) opens the task — where it opens is
 *     the host's choice via opts.onOpenTask
 *   - × unlinks the task from the owning goal/area (the task survives)
 *   - "+ New Task" creates inline and drops into rename — never navigates
 *
 * Rows sort action-first: overdue, then pending (by date, then time),
 * completed last.
 *
 * opts (one object shared by render + attach):
 *   onChanged()          host re-render after any mutation
 *   onOpenTask(taskId)   open the task's detail (host navigation)
 *   unlink               {app, id, title} — what × detaches from; omit to hide ×
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

    /** 'overdue' | 'pending' | 'completed' */
    stateOf(task, today = this._today()) {
        if (this.isCompleted(task, today)) return 'completed';
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
        const order = { overdue: 0, pending: 1, completed: 2 };
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
        const done = tasks.filter(t => this.isCompleted(t)).length;
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
            const label = this.dateLabel(t, today);
            return `<div class="task-row${state === 'completed' ? ' task-row--completed' : ''}" data-task-id="${t.itemId}" title="Open task">
                <input type="checkbox" class="task-row-check" data-task-id="${t.itemId}"
                       ${state === 'completed' ? 'checked' : ''}
                       title="${state === 'completed' ? 'Mark not done' : 'Mark done'}">
                <span class="task-row-title" data-edit-title="${t.itemId}" title="Click to rename">${this._esc(t.title)}</span>
                <span class="task-row-date${state === 'overdue' ? ' is-overdue' : ''}${label ? '' : ' is-empty'}" data-edit-date="${t.itemId}"
                      title="Click to set date">${label || 'Set date'}</span>
                <button type="button" class="task-row-open" tabindex="-1" title="Open task">&#8594;</button>
                ${opts.unlink ? `<button type="button" class="task-row-unlink" data-task-id="${t.itemId}" title="${this._esc(opts.unlink.title || 'Unlink')}">&times;</button>` : ''}
            </div>`;
        }).join('');
        return `<div class="task-list">${rows}</div>`;
    },

    // --- Wiring ---

    /**
     * Wire every task row (and any section action buttons) under `root`.
     * Call once per list instance so per-instance context (unlink target,
     * new-task links) stays unambiguous.
     */
    attach(root, opts = {}) {
        if (!root) return;
        const changed = () => { if (opts.onChanged) opts.onChanged(); };

        root.querySelectorAll('.task-row-check').forEach(cb =>
            cb.addEventListener('change', (e) => {
                e.stopPropagation();
                this._ensureScheduleLoaded();
                ScheduleApp.toggleComplete(cb.dataset.taskId);
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

        if (opts.unlink) {
            root.querySelectorAll('.task-row-unlink').forEach(btn =>
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    LinkManager.removeLink(opts.unlink.app, opts.unlink.id, 'schedule', btn.dataset.taskId);
                    changed();
                }));
        }

        // The whole row opens the task; inner controls stopPropagation.
        root.querySelectorAll('.task-row').forEach(row =>
            row.addEventListener('click', (e) => {
                if (e.target.closest('.task-row-check, .task-row-title, .task-row-date, .task-row-unlink')) return;
                if (opts.onOpenTask) opts.onOpenTask(row.dataset.taskId);
            }));

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
