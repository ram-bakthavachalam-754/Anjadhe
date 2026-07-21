/**
 * Goals App — outcomes with a status and an optional target date.
 *
 * Simplified 2026-07: the old type buckets (today / week / month / year)
 * are replaced by one optional `targetDate`; old records migrate on load
 * (the bucket becomes the date it claimed — today → today, week → end of
 * week, …). The list needs no filters: goals group themselves by status
 * (In progress / Up next / Stuck / Completed-collapsed), and the separate
 * read-only viewer is merged into the editor as a single detail page.
 */

const GoalsApp = {
    goals: [],
    currentGoalId: null,
    searchQuery: '',
    showCompleted: false, // collapsed "Completed" section (in-memory)
    hasUnsavedChanges: false,
    autoLinkContext: null, // [{app, itemId}, ...] — auto-link new goals to these items
    _editorStatus: 'not-started', // status pill selection while editing

    init() {
        this.loadGoals();
        this.setupEventListeners();
        this.render();
    },

    /**
     * Load goals from storage. Normalizes missing fields (phone-created
     * records) and migrates legacy `type` buckets to `targetDate` — the
     * bucket always meant "due within this horizon, measured from now",
     * so it converts to that horizon's end date at migration time.
     */
    loadGoals() {
        const data = StorageManager.get('goals');
        let migrated = false;
        this.goals = (data?.goals || []).map(g => {
            // Completion used to be a boolean alongside status; it's now just
            // another status value. Fold the legacy flag in and drop it.
            const { completed, ...rest } = g;
            if (completed !== undefined) migrated = true;
            return {
                ...rest,
                title: typeof g.title === 'string' ? g.title : '',
                description: typeof g.description === 'string' ? g.description : '',
                status: completed ? 'completed' : (g.status || 'not-started'),
            };
        });
        for (const g of this.goals) {
            if (g.targetDate === undefined) {
                g.targetDate = g.type ? this._horizonEnd(g.type) : null;
                migrated = true;
            }
        }
        if (migrated) this.saveGoals();
    },

    // End date of a legacy type bucket, measured from today.
    _horizonEnd(type) {
        const d = new Date();
        if (type === 'today') {
            // keep d
        } else if (type === 'week') {
            d.setDate(d.getDate() + (7 - d.getDay()) % 7); // upcoming Sunday
        } else if (type === 'month') {
            d.setMonth(d.getMonth() + 1, 0); // last day of this month
        } else if (type === 'year') {
            d.setMonth(11, 31);
        } else {
            return null;
        }
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${d.getFullYear()}-${m}-${day}`;
    },

    saveGoals() {
        StorageManager.set('goals', { goals: this.goals });
        AppManager.updateStats();
    },

    setupEventListeners() {
        // Actions hub strip in the header (Goals is a rung of the Actions door).
        ActionsApp.wireHubNav('goals-view');

        // Add goal button
        const addBtn = document.getElementById('add-goal-btn');
        const newAddBtn = addBtn.cloneNode(true);
        addBtn.parentNode.replaceChild(newAddBtn, addBtn);
        newAddBtn.addEventListener('click', () => {
            this.openEditor();
        });

        // Search input
        const searchInput = document.getElementById('goals-search');
        const newSearchInput = searchInput.cloneNode(true);
        searchInput.parentNode.replaceChild(newSearchInput, searchInput);
        newSearchInput.addEventListener('input', UIUtils.debounce((e) => {
            this.searchQuery = e.target.value.toLowerCase();
            this.render();
        }, 300));

        // Editor save button
        const editorSaveBtn = document.getElementById('goal-editor-save-btn');
        if (editorSaveBtn) {
            const newEditorSaveBtn = editorSaveBtn.cloneNode(true);
            editorSaveBtn.parentNode.replaceChild(newEditorSaveBtn, editorSaveBtn);
            newEditorSaveBtn.addEventListener('click', () => {
                this.saveCurrentGoal();
            });
        }

        // Editor delete button
        const editorDeleteBtn = document.getElementById('goal-editor-delete-btn');
        if (editorDeleteBtn) {
            const newEditorDeleteBtn = editorDeleteBtn.cloneNode(true);
            editorDeleteBtn.parentNode.replaceChild(newEditorDeleteBtn, editorDeleteBtn);
            newEditorDeleteBtn.addEventListener('click', () => {
                this.deleteCurrentGoal();
            });
        }
    },

    /**
     * The viewer and editor are one detail page now. openViewer stays as
     * an alias because deep links (#goals/view/<id>), link-picker, and
     * breadcrumbs across other apps all navigate through it.
     */
    openViewer(goalId) {
        this.openEditor(goalId);
    },

    closeViewer() {
        this.closeEditor();
    },

    /**
     * Open the detail page for a new or existing goal.
     * opts.origin — {app, itemId} to navigate back to on close.
     */
    openEditor(goalId = null, opts = {}) {
        this.currentGoalId = goalId;
        this._editorOrigin = opts.origin || null;

        AppManager.setDetailHash('goals', goalId ? 'edit' : null, goalId);
        document.getElementById('goals-view').classList.remove('active');
        document.getElementById('goal-editor-view').classList.add('active');

        const goal = goalId ? this.goals.find(g => g.id === goalId) : null;
        Breadcrumb.render(
            'goal-editor-breadcrumb',
            this._buildGoalCrumbs(goalId, goal?.title || (goalId ? 'Edit Goal' : 'New Goal'))
        );

        // (Re)wire inputs — cloneNode drops stale listeners from prior opens.
        const titleInput = document.getElementById('goal-title-input');
        const newTitleInput = titleInput.cloneNode(true);
        titleInput.parentNode.replaceChild(newTitleInput, titleInput);
        newTitleInput.addEventListener('input', () => this.markAsUnsaved());

        const descriptionInput = document.getElementById('goal-description-input');
        const newDescriptionInput = descriptionInput.cloneNode(true);
        descriptionInput.parentNode.replaceChild(newDescriptionInput, descriptionInput);
        newDescriptionInput.addEventListener('input', () => this.markAsUnsaved());

        const targetInput = document.getElementById('goal-target-input');
        const newTargetInput = targetInput.cloneNode(true);
        targetInput.parentNode.replaceChild(newTargetInput, targetInput);
        newTargetInput.addEventListener('change', () => this.markAsUnsaved());

        // The Completed checkbox is a shortcut for status = 'completed'. It
        // remembers the pre-completion status so unchecking restores it.
        const completedInput = document.getElementById('goal-completed-input');
        const newCompletedInput = completedInput.cloneNode(true);
        completedInput.parentNode.replaceChild(newCompletedInput, completedInput);
        newCompletedInput.addEventListener('change', () => {
            this._editorStatus = newCompletedInput.checked
                ? 'completed'
                : (this._statusBeforeCompleted || 'in-progress');
            GoalsUI.renderStatusSeg(this._editorStatus);
            this.markAsUnsaved();
        });

        // Focus area — a single value per goal, so it's a dropdown here
        // rather than a linked-items section. New goals opened from inside
        // a focus area (autoLinkContext) come preselected to that area.
        const focusSel = document.getElementById('goal-focus-select');
        const newFocusSel = focusSel.cloneNode(false);
        focusSel.parentNode.replaceChild(newFocusSel, focusSel);
        const focusItems = ProfileManager.filterByActiveProfile(
            (StorageManager.get('focus')?.focusItems) || []);
        newFocusSel.innerHTML = `<option value="">— None —</option>` +
            focusItems.map(f => `<option value="${f.id}">${UIUtils.escapeHtml(f.title)}</option>`).join('');
        const linkedFocus = goalId ? LinkManager.getFocusForItem('goals', goalId) : null;
        const ctxFocus = !goalId && Array.isArray(this.autoLinkContext)
            ? this.autoLinkContext.find(c => c.app === 'focus') : null;
        newFocusSel.value = linkedFocus?.itemId || ctxFocus?.itemId || '';
        newFocusSel.addEventListener('change', () => this.markAsUnsaved());

        // Populate
        newTitleInput.value = goal?.title || '';
        newDescriptionInput.value = goal?.description || '';
        newTargetInput.value = goal?.targetDate || '';
        this._editorStatus = goal?.status || 'not-started';
        newCompletedInput.checked = this._editorStatus === 'completed';
        this._statusBeforeCompleted = this._editorStatus === 'completed' ? 'in-progress' : this._editorStatus;
        GoalsUI.renderStatusSeg(this._editorStatus);

        // Delete only exists for a saved goal
        const delBtn = document.getElementById('goal-editor-delete-btn');
        if (delBtn) delBtn.style.display = goalId ? '' : 'none';

        // Linked items (focus area, tasks, notes/bookmarks) — saved goals only
        this.renderEditorLinkedItems(goalId);

        this.updateSaveStatus('saved');
        setTimeout(() => newTitleInput.focus(), 100);
    },

    setEditorStatus(status) {
        this._editorStatus = status;
        if (status !== 'completed') this._statusBeforeCompleted = status;
        // Picking a working status means the goal is no longer completed.
        const cb = document.getElementById('goal-completed-input');
        if (cb) cb.checked = status === 'completed';
        GoalsUI.renderStatusSeg(status);
        this.markAsUnsaved();
    },

    /**
     * Render linked items into the detail page.
     */
    _showLinkedNotes: false,

    renderEditorLinkedItems(goalId) {
        const container = document.getElementById('goal-editor-linked-section');
        if (!container) return;
        if (!goalId) { container.innerHTML = ''; return; }

        // Focus area is the dropdown in the properties row; Tasks is the
        // shared TaskListUI related list (rows are actionable in place);
        // Notes & Bookmarks stay collapsed below.
        const tasks = LinkManager.getTasksForGoal(goalId);
        let html = TaskListUI.renderSection(tasks, this._taskListOpts(goalId));

        const expanded = this._showLinkedNotes;
        html += `<div class="goal-linked-notes-section">`;
        html += `<button class="focus-linked-toggle schedule-completed-toggle" data-toggle="goal-linked-notes" aria-expanded="${!!expanded}">
            <span class="schedule-section-title">Notes &amp; Bookmarks</span>
            <span class="schedule-completed-arrow">${expanded ? '&#9652;' : '&#9662;'}</span>
        </button>`;
        html += `<div class="goal-linked-notes-body" style="display: ${expanded ? 'block' : 'none'};">`;
        html += LinkedItemsUI.renderAll('goals', goalId, {
            sections: [
                { targetApp: 'notes', label: 'Notes', buttonLabel: '+ Attach Note' },
                { targetApp: 'bookmarks', label: 'Bookmarks', buttonLabel: '+ Link Bookmark' }
            ]
        });
        html += '</div></div>';

        container.innerHTML = html;

        TaskListUI.attach(container.querySelector('.task-list-section'), this._taskListOpts(goalId));

        const toggle = container.querySelector('[data-toggle="goal-linked-notes"]');
        if (toggle) {
            toggle.addEventListener('click', () => {
                this._showLinkedNotes = !this._showLinkedNotes;
                const body = container.querySelector('.goal-linked-notes-body');
                const arrow = toggle.querySelector('.schedule-completed-arrow');
                body.style.display = this._showLinkedNotes ? 'block' : 'none';
                arrow.innerHTML = this._showLinkedNotes ? '&#9652;' : '&#9662;';
                toggle.setAttribute('aria-expanded', this._showLinkedNotes);
            });
        }

        LinkedItemsUI.attachListeners(container, () => {
            this.renderEditorLinkedItems(goalId);
        });
    },

    /**
     * TaskListUI context for this goal's Tasks list: open a task in the
     * Schedule editor with this goal as the return origin; "+ New Task"
     * creates inline, linked to the goal AND its focus area (so the task
     * shows up under the area's detail too).
     */
    _taskListOpts(goalId) {
        const focus = LinkManager.getFocusForItem('goals', goalId);
        return {
            onChanged: () => this.renderEditorLinkedItems(goalId),
            onOpenTask: (taskId) => LinkedItemsUI.navigateToItem('schedule', taskId,
                { origin: { app: 'goals', itemId: goalId } }),
            unlink: { app: 'goals', id: goalId, title: 'Unlink from this goal' },
            newTask: {
                links: [
                    { app: 'goals', id: goalId },
                    ...(focus ? [{ app: 'focus', id: focus.itemId }] : [])
                ]
            },
            linkExisting: { app: 'goals', id: goalId },
            aiBreakdown: { goalId, focusId: focus ? focus.itemId : null }
        };
    },

    /**
     * Close the detail page and return to the list (or the origin app).
     */
    closeEditor() {
        // Save before closing
        this.saveCurrentGoal(true);

        const origin = this._editorOrigin;
        this._editorOrigin = null;

        document.getElementById('goal-editor-view').classList.remove('active');

        this.currentGoalId = null;
        this.autoLinkContext = null;
        AppManager.setDetailHash('goals', null, null);

        if (origin && typeof origin === 'object' && origin.app) {
            LinkedItemsUI.navigateToItem(origin.app, origin.itemId);
            return;
        }

        document.getElementById('goals-view').classList.add('active');
        this.render();
    },

    markAsUnsaved() {
        this.hasUnsavedChanges = true;
        this.updateSaveStatus('unsaved');
    },

    updateSaveStatus(status) {
        const statusEl = document.getElementById('goal-save-status');
        if (!statusEl) return;

        statusEl.className = 'save-status ' + status;

        if (status === 'saving') {
            statusEl.textContent = 'Saving...';
        } else if (status === 'saved') {
            statusEl.textContent = 'Saved';
            this.hasUnsavedChanges = false;
        } else if (status === 'unsaved') {
            statusEl.textContent = 'Unsaved changes';
        }
    },

    /**
     * Save the goal being edited.
     */
    saveCurrentGoal(silent = false) {
        const title = document.getElementById('goal-title-input').value.trim() || 'Untitled Goal';
        const description = document.getElementById('goal-description-input').value.trim();
        const targetDate = document.getElementById('goal-target-input').value || null;
        const focusId = document.getElementById('goal-focus-select')?.value || null;
        const status = this._editorStatus || 'not-started';
        const profile = ProfileManager.getProfileForNewItem();

        if (this.currentGoalId) {
            const goal = this.goals.find(g => g.id === this.currentGoalId);
            if (goal) {
                const statusChanged = goal.status !== status;
                goal.title = title;
                goal.description = description;
                goal.targetDate = targetDate;
                goal.status = status;
                goal.profile = profile;
                goal.modifiedAt = new Date().toISOString();
                LinkManager.setFocusForItem('goals', goal.id, focusId);
                if (statusChanged && typeof AnalyticsManager !== 'undefined') {
                    AnalyticsManager.record('goal.status_updated');
                }
            }
        } else {
            // Create new goal only if there's content
            if (description.trim().length > 0 || title !== 'Untitled Goal') {
                const newGoal = {
                    id: UIUtils.generateId(),
                    title,
                    description,
                    targetDate,
                    status,
                    profile,
                    createdAt: new Date().toISOString(),
                    modifiedAt: new Date().toISOString()
                };
                this.goals.unshift(newGoal);
                this.currentGoalId = newGoal.id;

                // Auto-link non-focus context (focus is driven by the
                // dropdown below, which came preselected from the context).
                if (this.autoLinkContext) {
                    for (const ctx of this.autoLinkContext) {
                        if (ctx.app === 'focus') continue;
                        LinkManager.addLink(ctx.app, ctx.itemId, 'goals', newGoal.id);
                    }
                    this.autoLinkContext = null;
                }
                LinkManager.setFocusForItem('goals', newGoal.id, focusId);

                // Delete + linked sections become available once saved
                const delBtn = document.getElementById('goal-editor-delete-btn');
                if (delBtn) delBtn.style.display = '';
                this.renderEditorLinkedItems(newGoal.id);
                AppManager.setDetailHash('goals', 'edit', newGoal.id);
            }
        }

        this.saveGoals();
        // The focus area may have changed — refresh the breadcrumb trail.
        if (this.currentGoalId) {
            const saved = this.goals.find(g => g.id === this.currentGoalId);
            Breadcrumb.render('goal-editor-breadcrumb',
                this._buildGoalCrumbs(this.currentGoalId, saved?.title || 'Goal'));
        }
        this.updateSaveStatus('saved');
        if (!silent) {
            UIUtils.showToast('Goal saved', 'success');
        }
    },

    async deleteCurrentGoal() {
        if (!this.currentGoalId) return;
        const goal = this.goals.find(g => g.id === this.currentGoalId);
        if (!goal) return;

        const linked = LinkManager.countLinkedChildren('goals', this.currentGoalId);
        if (linked.tasks > 0) {
            UIUtils.showToast(
                `Cannot delete "${goal.title}" — still has ${linked.tasks} task${linked.tasks === 1 ? '' : 's'} linked. Remove those first.`,
                'error'
            );
            return;
        }

        const confirmed = await UIUtils.confirm(
            'Delete Goal',
            `Are you sure you want to delete "${goal.title}"?`,
            '🗑️'
        );
        if (!confirmed) return;

        LinkManager.removeAllLinksForItem('goals', this.currentGoalId);
        this.goals = this.goals.filter(g => g.id !== this.currentGoalId);
        this.saveGoals();

        // Leave the detail page without re-saving the deleted goal
        this.currentGoalId = null;
        this._editorOrigin = null;
        this.autoLinkContext = null;
        document.getElementById('goal-editor-view').classList.remove('active');
        document.getElementById('goals-view').classList.add('active');
        AppManager.setDetailHash('goals', null, null);
        this.render();

        UIUtils.showToast('Goal deleted', 'success');
    },

    /**
     * Reorder goal via drag and drop (manual order within its group).
     */
    reorderGoal(draggedId, targetId, insertBefore) {
        const draggedIndex = this.goals.findIndex(g => g.id === draggedId);
        const targetIndex = this.goals.findIndex(g => g.id === targetId);

        if (draggedIndex === -1 || targetIndex === -1) return;
        if (draggedIndex === targetIndex) return;

        const [draggedGoal] = this.goals.splice(draggedIndex, 1);

        let newTargetIndex = this.goals.findIndex(g => g.id === targetId);
        if (newTargetIndex === -1) {
            newTargetIndex = this.goals.length;
        }
        if (!insertBefore) {
            newTargetIndex++;
        }
        this.goals.splice(newTargetIndex, 0, draggedGoal);

        this.saveGoals();
        this.render();
    },

    /**
     * Legacy type label — old records may still carry `type`; link-picker
     * and old data paths call this. New goals have targetDate instead.
     */
    formatType(type) {
        const typeMap = {
            'today': 'Today',
            'week': 'This Week',
            'month': 'This Month',
            'year': 'This Year'
        };
        return typeMap[type] || '';
    },

    formatStatus(status) {
        const statusMap = {
            'not-started': 'Not started',
            'in-progress': 'In progress',
            'no-progress': 'No progress',
            'need-help': 'Need help',
            'completed': 'Completed'
        };
        return statusMap[status] || status;
    },

    /**
     * Goals of the active profile matching the search, split into the
     * groups the list renders: status does the organizing, so the page
     * needs no filter controls.
     */
    getGroupedGoals() {
        let goals = ProfileManager.filterByActiveProfile([...this.goals]);

        if (this.searchQuery) {
            goals = goals.filter(goal =>
                goal.title.toLowerCase().includes(this.searchQuery) ||
                goal.description.toLowerCase().includes(this.searchQuery)
            );
        }

        const active = goals.filter(g => g.status !== 'completed');
        return {
            inProgress: active.filter(g => g.status === 'in-progress'),
            upNext: active.filter(g => g.status === 'not-started' || !['in-progress', 'no-progress', 'need-help'].includes(g.status)),
            stuck: active.filter(g => g.status === 'no-progress' || g.status === 'need-help'),
            completed: goals.filter(g => g.status === 'completed'),
        };
    },

    render() {
        this.renderListBreadcrumb();
        GoalsUI.render(this);
    },

    /**
     * Build breadcrumb trail for a goal, including focus area context if linked
     */
    _buildGoalCrumbs(goalId, goalTitle) {
        const crumbs = [];

        // Existing goals read links from storage; brand-new goals (goalId
        // null) instead derive their breadcrumb from autoLinkContext, since
        // the real focus link doesn't exist until save.
        let focusArea = null;
        if (goalId) {
            focusArea = LinkManager.getFocusForItem('goals', goalId);
        } else if (Array.isArray(this.autoLinkContext)) {
            const focusCtx = this.autoLinkContext.find(c => c.app === 'focus');
            if (focusCtx) {
                const meta = LinkManager.getItemMeta('focus', focusCtx.itemId);
                if (meta) focusArea = { itemId: focusCtx.itemId, title: meta.title, color: meta.color };
            }
        }

        if (focusArea) {
            crumbs.push({ label: 'Plan', action: () => AppManager.openApp('focus') });
            crumbs.push({ label: focusArea.title, action: () => { AppManager.openApp('focus'); setTimeout(() => FocusApp.navigateTo(focusArea.itemId), 0); } });
        } else {
            // Unassigned goals live under Plan's "Other goals" now — the
            // standalone Goals list is retired from navigation.
            crumbs.push({ label: 'Plan', action: () => AppManager.openApp('focus') });
        }
        crumbs.push({ label: goalId ? 'Goal' : 'New Goal' });
        return crumbs;
    },

    renderListBreadcrumb() {
        Breadcrumb.render('goals-breadcrumb', [
            { label: 'Actions', action: () => AppManager.openApp('actions') },
            { label: 'Goals' }
        ]);
    }
};

// Register app
AppManager.register('goals', GoalsApp);

// AgentContext provider — exposes the goal currently being viewed or
// edited. Returns null on the list view; active goals already appear in
// the global briefing. Per-item context is for editor-focused asks like
// "make this goal more measurable" or "draft a plan for this".
if (typeof AgentContext !== 'undefined') {
    AgentContext.register('goals', () => {
        const id = GoalsApp.currentGoalId;
        if (!id) return null;
        const goal = (GoalsApp.goals || []).find(g => g && g.id === id);
        if (!goal) return null;

        return {
            recordKey: 'goals:' + goal.id,
            recordLabel: goal.title || '(untitled goal)',
            title: 'CURRENT GOAL',
            body: `The user is viewing or editing the goal below. The goal is available as context, not a constraint:

- When the user's question is about "this goal", "the goal", or asks to update / refine it, work with the data below. To modify it, call update_goal with id: "${goal.id}".
- For general questions, answer normally.

Title: ${goal.title || '(untitled)'}
Target date: ${goal.targetDate || 'none'}
Status: ${goal.status || 'unspecified'}
Goal id: ${goal.id}

Description:
${goal.description || '(none)'}`,
            suggestedPrompts: [
                'Make this more measurable',
                'Suggest milestones',
                'Identify likely obstacles'
            ]
        };
    });
}
