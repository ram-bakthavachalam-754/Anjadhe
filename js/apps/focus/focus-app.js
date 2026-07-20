/**
 * Focus App - Focus Areas with Hierarchical Structure
 */

const FocusApp = {
    UNGROUPED: 'Ungrouped',        // label for areas with no group assigned

    focusItems: [],
    currentParentId: null,         // retained for external navigateTo callers / legacy hash
    currentEditId: null,
    selectedColor: '#4A90A4',
    hasUnsavedChanges: false,

    // Workspace state (transient — resets on refresh; tree width persists in localStorage)
    currentGroup: null,            // active group tab; null = resolved to first group on render
    viewAll: true,                 // default home shows ALL groups > areas > goals; a
                                   // persisted per-window choice overrides this on load
    selected: null,                // { type:'area'|'goal'|'task', id } shown in the detail pane
    expandedAreaIds: new Set(),    // which areas are expanded in the tree
    expandedGoalIds: new Set(),    // which goals are expanded in the tree
    collapsedGoalIds: new Set(),   // area detail: goal cards with tasks hidden
    showAreasOnHome: true,         // all-groups home: list each group's focus areas
                                   // inside its card (machine-local, survives restart)

    /**
     * Initialize the focus app
     */
    init() {
        this.loadData();
        this._restoreViewState();
        this.setupEventListeners();
        NavResizer.attach({
            layoutSel: '#focus-view .focus-layout',
            resizerId: 'focus-nav-resizer',
            cssVar: '--actions-nav-width',
            storageKey: 'focus-nav-width',
            defaultW: 188,
        });
        this.render();
    },

    // The home view mode (single group vs "all groups") and the active group
    // are per-window UI state — persisted in sessionStorage so a refresh
    // (Cmd+R) restores what the user was looking at, without syncing across
    // windows or Macs (mirrors the per-window active-profile approach).
    _viewStateKey: 'anjadhe.focus.viewState',

    // Lasting per-machine preference, unlike the per-window session state
    // below — same localStorage home as the tree width.
    _showAreasKey: 'anjadhe.focus.showAreasOnHome',

    setShowAreasOnHome(on) {
        this.showAreasOnHome = !!on;
        try { window.localStorage.setItem(this._showAreasKey, on ? '1' : '0'); } catch (_) {}
        this.render();
    },

    _restoreViewState() {
        try {
            this.showAreasOnHome = window.localStorage.getItem(this._showAreasKey) !== '0';
        } catch (_) {}
        try {
            const raw = window.sessionStorage.getItem(this._viewStateKey);
            if (!raw) return;
            const s = JSON.parse(raw);
            if (typeof s.viewAll === 'boolean') this.viewAll = s.viewAll;
            if (typeof s.currentGroup === 'string') this.currentGroup = s.currentGroup;
            if (Array.isArray(s.collapsedGoals)) this.collapsedGoalIds = new Set(s.collapsedGoals);
            if (s.selected && s.selected.type && s.selected.id) {
                this.selected = { type: s.selected.type, id: s.selected.id };
                // If an area was restored but no longer exists, drop back to the
                // overview (goal/task existence is checked lazily on render).
                if (this.selected.type === 'area' && !this.focusItems.some(f => f.id === this.selected.id)) {
                    this.selected = null;
                }
            }
        } catch (_) {}
    },

    _persistViewState() {
        try {
            window.sessionStorage.setItem(this._viewStateKey, JSON.stringify({
                viewAll: this.viewAll,
                currentGroup: this.currentGroup,
                selected: this.selected,
                collapsedGoals: [...this.collapsedGoalIds]
            }));
        } catch (_) {}
    },

    /**
     * Load focus items from storage
     */
    loadData() {
        const data = StorageManager.get('focus');
        // Normalize so phone-created focus areas (or any missing fields) render
        // cleanly — coerce the strings the renderer interpolates.
        this.focusItems = (data?.focusItems || []).map(f => ({
            ...f,
            title: typeof f.title === 'string' ? f.title : '',
            description: typeof f.description === 'string' ? f.description : '',
            color: f.color || '#4A90A4',
            group: typeof f.group === 'string' ? f.group.trim() : '',
        }));
    },

    /**
     * Areas belonging to the active profile (flat — parentId nesting is legacy).
     */
    getProfileAreas() {
        return ProfileManager.filterByActiveProfile(this.focusItems);
    },

    /**
     * The group name an area belongs to, mapping blank/missing to UNGROUPED.
     */
    groupOf(area) {
        const g = (area && typeof area.group === 'string') ? area.group.trim() : '';
        return g || this.UNGROUPED;
    },

    /**
     * Distinct group names among the active profile's areas, in first-seen
     * order, with Ungrouped always last (only present if it has areas).
     */
    getGroups() {
        const named = [];
        let hasUngrouped = false;
        for (const a of this.getProfileAreas()) {
            const g = this.groupOf(a);
            if (g === this.UNGROUPED) { hasUngrouped = true; continue; }
            if (!named.includes(g)) named.push(g);
        }
        if (hasUngrouped) named.push(this.UNGROUPED);
        return named;
    },

    /**
     * Areas within the given group (active profile), preserving stored order.
     */
    getAreasInGroup(group) {
        return this.getProfileAreas().filter(a => this.groupOf(a) === group);
    },

    /**
     * Resolve the active group, falling back to the first available group and
     * keeping currentGroup valid if areas/groups change underneath it.
     */
    resolveCurrentGroup() {
        const groups = this.getGroups();
        if (groups.length === 0) { this.currentGroup = null; return null; }
        if (!this.currentGroup || !groups.includes(this.currentGroup)) {
            // Prefer the group of the selected area, else the first group.
            const sel = this.selected && this.getAreaForSelection();
            this.currentGroup = (sel && this.groupOf(sel)) || groups[0];
        }
        return this.currentGroup;
    },

    /**
     * The area associated with the current selection (the area itself, or the
     * area that owns the selected goal/task). Null if nothing resolvable.
     */
    getAreaForSelection() {
        if (!this.selected) return null;
        if (this.selected.type === 'area') {
            return this.focusItems.find(f => f.id === this.selected.id) || null;
        }
        if (this.selected.type === 'goal') {
            return this.areaOwningGoal(this.selected.id);
        }
        if (this.selected.type === 'task') {
            const goalLinks = LinkManager.getLinksForApp('schedule', this.selected.id, 'goals');
            for (const gl of goalLinks) {
                const a = this.areaOwningGoal(gl.itemId);
                if (a) return a;
            }
            const focusLinks = LinkManager.getLinksForApp('schedule', this.selected.id, 'focus');
            if (focusLinks[0]) return this.focusItems.find(f => f.id === focusLinks[0].itemId) || null;
        }
        return null;
    },

    /**
     * Find the focus area that owns a given goal (via its focus link).
     */
    areaOwningGoal(goalId) {
        const links = LinkManager.getLinksForApp('goals', goalId, 'focus');
        if (!links[0]) return null;
        return this.focusItems.find(f => f.id === links[0].itemId) || null;
    },

    /**
     * Save focus items to storage
     */
    saveData() {
        StorageManager.set('focus', { focusItems: this.focusItems });
        AppManager.updateStats();
    },

    /**
     * Setup event listeners
     */
    setupEventListeners() {
        // Actions hub strip in the header (Plan is a rung of the Actions
        // door). Replaces the old "All Goals" header button — the strip's
        // Goals rung covers that hop now.
        ActionsApp.wireHubNav('focus-view');

        // Add focus button
        const addBtn = document.getElementById('add-focus-btn');
        const newAddBtn = addBtn.cloneNode(true);
        addBtn.parentNode.replaceChild(newAddBtn, addBtn);
        newAddBtn.addEventListener('click', () => {
            this.openEditor();
        });

        // Detail-mode Save button — persists the inline edits made directly on
        // the drilled-in focus detail page (title, description, color). Focus's
        // detail page IS its edit page now, consistent with task/goal.
        const saveBtn = document.getElementById('focus-save-btn');
        if (saveBtn) {
            const newSaveBtn = saveBtn.cloneNode(true);
            saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
            newSaveBtn.addEventListener('click', () => {
                this.saveDetailEdits();
            });
        }

        // Detail-mode Delete button — deletes the currently drilled-in focus,
        // then navigates back to its parent so we don't leave the user
        // staring at a detail view for a now-deleted item.
        const deleteBtn = document.getElementById('focus-delete-btn');
        if (deleteBtn) {
            const newDeleteBtn = deleteBtn.cloneNode(true);
            deleteBtn.parentNode.replaceChild(newDeleteBtn, deleteBtn);
            newDeleteBtn.addEventListener('click', async () => {
                const focusId = this.currentParentId;
                if (!focusId) return;
                const focus = this.focusItems.find(f => f.id === focusId);
                const parentId = focus?.parentId ?? null;
                await this.deleteFocus(focusId);
                if (!this.focusItems.some(f => f.id === focusId)) {
                    this.navigateTo(parentId);
                }
            });
        }

        // Editor save button
        const editorSaveBtn = document.getElementById('focus-editor-save-btn');
        if (editorSaveBtn) {
            const newEditorSaveBtn = editorSaveBtn.cloneNode(true);
            editorSaveBtn.parentNode.replaceChild(newEditorSaveBtn, editorSaveBtn);
            newEditorSaveBtn.addEventListener('click', () => {
                this.saveCurrentFocus();
            });
        }

        // Editor delete button
        const editorDeleteBtn = document.getElementById('focus-editor-delete-btn');
        if (editorDeleteBtn) {
            const newEditorDeleteBtn = editorDeleteBtn.cloneNode(true);
            editorDeleteBtn.parentNode.replaceChild(newEditorDeleteBtn, editorDeleteBtn);
            newEditorDeleteBtn.addEventListener('click', () => {
                this.deleteCurrentFocus();
            });
        }

        // Color selector
        this.setupColorSelector();
    },

    /**
     * Setup color selector in editor
     */
    setupColorSelector() {
        const colorSelector = document.getElementById('focus-color-selector');
        if (!colorSelector) return;

        colorSelector.querySelectorAll('.color-option').forEach(btn => {
            const newBtn = btn.cloneNode(true);
            btn.parentNode.replaceChild(newBtn, btn);
            newBtn.addEventListener('click', () => {
                this.selectedColor = newBtn.dataset.color;
                this.updateColorSelection();
                this.markAsUnsaved();
            });
        });
    },

    /**
     * Update color selection UI
     */
    updateColorSelection() {
        const colorSelector = document.getElementById('focus-color-selector');
        if (!colorSelector) return;

        colorSelector.querySelectorAll('.color-option').forEach(btn => {
            btn.classList.toggle('selected', btn.dataset.color === this.selectedColor);
        });
    },

    /**
     * Get children count for a focus item (blocks deletion of areas with
     * grandfathered sub-areas).
     */
    getChildrenCount(focusId) {
        return this.focusItems.filter(f => f.parentId === focusId).length;
    },

    /**
     * Navigate into a focus item
     */
    navigateTo(focusId) {
        // Persist any inline edits on the current detail pane before leaving it,
        // so switching selection or arriving from another app never drops them.
        this.saveDetailEdits(true);
        this.currentParentId = focusId;
        if (focusId) {
            const area = this.focusItems.find(f => f.id === focusId);
            if (area) {
                this.currentGroup = this.groupOf(area);
                this.expandedAreaIds.add(focusId);
                this.selected = { type: 'area', id: focusId };
            }
            AppManager.setDetailHash('focus', 'focus', focusId);
        } else {
            this.selected = null;
            AppManager.setDetailHash('focus', null, null);
        }
        this.render();
    },

    /**
     * Switch the active group tab. No auto-selection — the detail pane shows
     * the group's overview until the user picks an area/goal themselves.
     */
    switchGroup(group) {
        this.saveDetailEdits(true);
        this.currentGroup = group;
        this.viewAll = false;
        this.selected = null;
        this.render();
    },

    /**
     * Show the "all groups" home — every group with its focus areas and their
     * goals in the detail pane. Invoked from the launcher's "View all groups".
     */
    goToAllGroups() {
        this.saveDetailEdits(true);
        this.viewAll = true;
        this.selected = null;
        AppManager.setDetailHash('focus', null, null);
        this.render();
    },

    /**
     * Return to the current home — clears any area/goal/task selection so the
     * detail pane shows the group (or all-groups) overview. Invoked by the group
     * link in the launcher; keeps the current view mode (single group vs all).
     */
    goToGroupHome() {
        this.saveDetailEdits(true);
        this.selected = null;
        AppManager.setDetailHash('focus', null, null);
        this.render();
    },

    /**
     * Select a tree node (area/goal/task) to show in the detail pane.
     * Persists any pending area edits first.
     */
    selectNode(type, id) {
        this.saveDetailEdits(true);
        // Where the inline task detail's back/close should land — the
        // area or goal the user was on when they opened the task.
        if (type === 'task' && (!this.selected || this.selected.type !== 'task')) {
            this._taskReturnSel = this.selected ? { ...this.selected } : null;
        }
        this.selected = { type, id };
        this.viewAll = false;
        // Keep the tree/launcher in step when selecting across groups (e.g. from
        // the all-groups home) by following the selected item to its group.
        const area = this.getAreaForSelection();
        if (area) this.currentGroup = this.groupOf(area);
        if (type === 'area') AppManager.setDetailHash('focus', 'focus', id);
        this.render();
    },

    // --- Group management (rename / delete) ---
    // A group is just the `group` label on the active profile's areas, so
    // renaming relabels every area in it and deleting ungroups them (moves
    // them to Ungrouped) — nothing is destroyed.

    renameGroup(oldName) {
        if (!oldName || oldName === this.UNGROUPED) return;
        let modal;
        modal = Modal.create({
            title: 'Rename Group',
            content: `
                <div class="form-group">
                    <label class="form-label">Group name</label>
                    <input type="text" id="focus-rename-group-input" value="${UIUtils.escapeHtml(oldName)}">
                </div>`,
            buttons: [
                { text: 'Cancel', className: 'secondary-btn', onClick: () => modal.close() },
                {
                    text: 'Save',
                    className: 'primary-btn',
                    onClick: () => {
                        const val = (document.getElementById('focus-rename-group-input')?.value || '').trim();
                        if (!val) { UIUtils.showToast('Please enter a name', 'error'); return; }
                        modal.close();
                        this._applyGroupRename(oldName, val);
                    }
                }
            ]
        });
        setTimeout(() => {
            const i = document.getElementById('focus-rename-group-input');
            if (i) { i.focus(); i.select(); }
        }, 100);
    },

    _applyGroupRename(oldName, newName) {
        if (oldName === newName) return;
        let changed = false;
        for (const f of this.getProfileAreas()) {
            if (this.groupOf(f) === oldName) {
                f.group = newName;
                f.modifiedAt = new Date().toISOString();
                changed = true;
            }
        }
        if (!changed) return;
        if (this.currentGroup === oldName) this.currentGroup = newName;
        this.saveData();
        this.render();
        UIUtils.showToast('Group renamed', 'success');
    },

    async deleteGroup(name) {
        if (!name || name === this.UNGROUPED) return;
        const areas = this.getAreasInGroup(name);
        const confirmed = await UIUtils.confirm(
            'Delete Group',
            `Delete the group "${name}"? Its ${areas.length} focus area${areas.length === 1 ? '' : 's'} will move to Ungrouped — nothing is deleted.`,
            '🗑️'
        );
        if (!confirmed) return;

        for (const f of this.getProfileAreas()) {
            if (this.groupOf(f) === name) {
                f.group = '';
                f.modifiedAt = new Date().toISOString();
            }
        }
        // Let resolveCurrentGroup pick a valid group again if we were on it.
        if (this.currentGroup === name) this.currentGroup = null;
        this.selected = null;
        this.saveData();
        this.render();
        UIUtils.showToast('Group deleted', 'success');
    },

    /** Toggle a tree node's expansion (area or goal). */
    toggleExpand(kind, id) {
        const set = kind === 'area' ? this.expandedAreaIds : this.expandedGoalIds;
        if (set.has(id)) set.delete(id); else set.add(id);
        this.render();
    },

    /**
     * Close the inline task detail (embedded schedule editor) and return
     * to wherever the user opened it from — the owning goal or area.
     * Called by ScheduleApp.closeEditor for origin 'plan'.
     */
    closeTaskDetail() {
        this.selected = this._taskReturnSel || null;
        this._taskReturnSel = null;
        this.render();
    },

    /** Area detail: collapse/expand a goal card's task list. */
    toggleGoalCollapsed(goalId) {
        if (this.collapsedGoalIds.has(goalId)) this.collapsedGoalIds.delete(goalId);
        else this.collapsedGoalIds.add(goalId);
        this._persistViewState();
        this.render();
    },

    // --- Inline task/goal mutations (workspace tree + detail pane) ---

    // The tree reads via LinkManager (straight from storage), but inline edits
    // mutate ScheduleApp/GoalsApp in-memory arrays — which are only populated
    // once those apps have loaded. Guard exactly like the dashboard does.
    _ensureScheduleLoaded() {
        if (typeof ScheduleApp === 'undefined') return false;
        if (!Array.isArray(ScheduleApp.scheduleItems) || ScheduleApp.scheduleItems.length === 0) {
            ScheduleApp.loadData();
        }
        return true;
    },
    _ensureGoalsLoaded() {
        if (typeof GoalsApp === 'undefined') return false;
        if (!Array.isArray(GoalsApp.goals) || GoalsApp.goals.length === 0) {
            GoalsApp.loadGoals();
        }
        return true;
    },

    _scheduleItem(taskId) {
        this._ensureScheduleLoaded();
        return (ScheduleApp.scheduleItems || []).find(i => i.id === taskId);
    },

    /** Inline-edit a task's title. Persists via ScheduleApp and re-renders. */
    setTaskTitle(taskId, title) {
        const item = this._scheduleItem(taskId);
        const clean = (title || '').trim();
        if (!item || !clean || item.title === clean) { this.render(); return; }
        item.title = clean;
        item.modifiedAt = new Date().toISOString();
        ScheduleApp.saveData();
        this.render();
    },

    /** Inline-edit a task's scheduled date (YYYY-MM-DD or '' to clear). */
    setTaskDate(taskId, date) {
        const item = this._scheduleItem(taskId);
        if (!item) return;
        const next = date || null;
        if (item.scheduledDate === next) { this.render(); return; }
        item.scheduledDate = next;
        item.modifiedAt = new Date().toISOString();
        ScheduleApp.saveData();
        this.render();
    },

    /** Inline-edit a task's start time (HH:MM or '' to clear). */
    setTaskTime(taskId, time) {
        const item = this._scheduleItem(taskId);
        if (!item) return;
        const next = time || '';
        if ((item.startTime || '') === next) { this.render(); return; }
        item.startTime = next;
        item.modifiedAt = new Date().toISOString();
        ScheduleApp.saveData();
        this.render();
    },

    /** Toggle a task's completion (ScheduleApp handles persist). */
    toggleTask(taskId) {
        this._ensureScheduleLoaded();
        ScheduleApp.toggleComplete(taskId);
        this.render();
    },

    /** Update a goal's status inline (detail pane status pills). */
    setGoalStatus(goalId, status) {
        this._ensureGoalsLoaded();
        const goal = (GoalsApp.goals || []).find(g => g.id === goalId);
        if (!goal || goal.status === status) return;
        goal.status = status;
        goal.modifiedAt = new Date().toISOString();
        GoalsApp.saveGoals();
        if (typeof AnalyticsManager !== 'undefined') {
            try { AnalyticsManager.record('goal.status_updated'); } catch (_) {}
        }
        this.render();
    },

    /**
     * Set a plain field on a goal from the embedded editor (title, description,
     * targetDate, completed). Persists via GoalsApp and re-renders.
     */
    setGoalField(goalId, field, value) {
        this._ensureGoalsLoaded();
        const goal = (GoalsApp.goals || []).find(g => g.id === goalId);
        if (!goal) return;
        if (field === 'title') {
            const clean = (value || '').trim();
            if (!clean || goal.title === clean) { this.render(); return; }
            goal.title = clean;
        } else if (goal[field] === value) {
            return;
        } else {
            goal[field] = value;
        }
        goal.modifiedAt = new Date().toISOString();
        GoalsApp.saveGoals();
        this.render();
    },

    /**
     * Delete a goal from the embedded goal editor in the detail pane. Mirrors
     * GoalsApp.deleteCurrentGoal's guard + confirm, then returns to the group
     * home (the deleted goal can't stay selected).
     */
    async deleteGoal(goalId) {
        this._ensureGoalsLoaded();
        const goal = (GoalsApp.goals || []).find(g => g.id === goalId);
        if (!goal) return;

        const linked = LinkManager.countLinkedChildren('goals', goalId);
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

        LinkManager.removeAllLinksForItem('goals', goalId);
        GoalsApp.goals = GoalsApp.goals.filter(g => g.id !== goalId);
        GoalsApp.saveGoals();

        this.selected = null;
        AppManager.setDetailHash('focus', null, null);
        this.render();
        UIUtils.showToast('Goal deleted', 'success');
    },

    /**
     * Create a goal in place and open it in the embedded editor — with or
     * without a focus area (focusId null = unassigned, files later via
     * drag or the editor's dropdown). Title starts selected for overtype.
     */
    createGoalInline(focusId) {
        this._ensureGoalsLoaded();
        const now = new Date().toISOString();
        const goal = {
            id: UIUtils.generateId(),
            title: 'New goal',
            description: '',
            targetDate: null,
            status: 'not-started',
            profile: ProfileManager.getProfileForNewItem(),
            createdAt: now,
            modifiedAt: now
        };
        GoalsApp.goals.unshift(goal);
        GoalsApp.saveGoals();
        if (focusId) LinkManager.setFocusForItem('goals', goal.id, focusId);
        this.selectNode('goal', goal.id);
        setTimeout(() => {
            const t = document.querySelector('#focus-detail-pane .goal-embed-title');
            if (t) { t.focus(); t.select(); }
        }, 0);
    },

    /** Drag-drop filing: a goal dropped onto a focus area. */
    assignGoalToArea(goalId, areaId) {
        const area = this.focusItems.find(f => f.id === areaId);
        if (!area) return;
        const current = LinkManager.getFocusForItem('goals', goalId);
        if (current && current.itemId === areaId) return;
        LinkManager.setFocusForItem('goals', goalId, areaId);
        this.render();
        UIUtils.showToast(`Filed under ${area.title}`, 'success');
    },

    /** Drag-drop regrouping: a focus area dropped onto a group card. */
    moveAreaToGroup(areaId, groupName) {
        const area = this.focusItems.find(f => f.id === areaId);
        if (!area) return;
        const target = (!groupName || groupName === this.UNGROUPED) ? '' : groupName;
        if ((area.group || '').trim() === target) return;
        area.group = target;
        area.modifiedAt = new Date().toISOString();
        this.saveData();
        this.render();
        UIUtils.showToast(`Moved to ${target || this.UNGROUPED}`, 'success');
    },

    /** Set the goal's single focus area from the embedded editor dropdown. */
    setGoalFocus(goalId, focusId) {
        LinkManager.setFocusForItem('goals', goalId, focusId || '');
        // Keep this goal selected even if it moved to another area/group.
        const area = this.areaOwningGoal(goalId);
        if (area) this.currentGroup = this.groupOf(area);
        this.render();
    },

    /**
     * Save the inline edits made directly on the drilled-in focus detail page.
     * Reads the title/description inputs and the color chosen via the detail
     * swatches (held on _detailColor), writes them to the current focus item.
     * Silent mode is used when auto-saving on navigation — no toast, and an
     * empty title is left untouched rather than flagged as an error.
     */
    saveDetailEdits(silent = false) {
        // The area detail pane is the editor for the selected area.
        const focusId = (this.selected && this.selected.type === 'area')
            ? this.selected.id : this.currentParentId;
        if (!focusId) return;
        const titleEl = document.getElementById('focus-detail-title');
        const descEl = document.getElementById('focus-detail-description');
        const groupEl = document.getElementById('focus-detail-group');
        if (!titleEl) return;  // detail head not mounted (e.g. a goal/task is selected)
        const focus = this.focusItems.find(f => f.id === focusId);
        if (!focus) return;

        const title = titleEl.value.trim();
        if (!title) {
            if (!silent) UIUtils.showToast('Please enter a name', 'error');
            return;
        }
        const description = descEl ? descEl.value.trim() : (focus.description || '');
        const color = FocusApp._detailColor || focus.color;
        const group = groupEl ? groupEl.value.trim() : (focus.group || '');

        const changed = focus.title !== title
            || focus.description !== description
            || focus.color !== color
            || (focus.group || '') !== group;
        if (!changed) {
            if (!silent) UIUtils.showToast('Focus saved', 'success');
            return;
        }

        focus.title = title;
        focus.description = description;
        focus.color = color;
        focus.group = group;
        focus.modifiedAt = new Date().toISOString();
        // Follow the area if its rename/regroup moves it under a different tab.
        this.currentGroup = this.groupOf(focus);
        this.saveData();

        if (!silent) {
            UIUtils.showToast('Focus saved', 'success');
            this.render();
        }
    },

    /**
     * Open editor for new or existing focus item
     */
    openEditor(focusId = null) {
        this.currentEditId = focusId;

        // Hide focus view, show editor view
        document.getElementById('focus-view').classList.remove('active');
        document.getElementById('focus-editor-view').classList.add('active');

        // Render breadcrumb
        const focus = focusId ? this.focusItems.find(f => f.id === focusId) : null;
        const crumbs = [
            { label: 'Plan', action: () => this.closeEditor() }
        ];
        crumbs.push({ label: focus?.title || 'New Focus area' });
        Breadcrumb.render('focus-editor-breadcrumb', crumbs);

        // Track title changes
        const titleInput = document.getElementById('focus-title-input');
        const newTitleInput = titleInput.cloneNode(true);
        titleInput.parentNode.replaceChild(newTitleInput, titleInput);
        newTitleInput.addEventListener('input', () => {
            this.markAsUnsaved();
        });

        // Track description changes
        const descriptionInput = document.getElementById('focus-description-input');
        const newDescriptionInput = descriptionInput.cloneNode(true);
        descriptionInput.parentNode.replaceChild(newDescriptionInput, descriptionInput);
        newDescriptionInput.addEventListener('input', () => {
            this.markAsUnsaved();
        });

        // Re-setup color selector
        this.setupColorSelector();

        // Offer existing group names for quick reuse / consistent spelling.
        this._populateGroupOptions();
        const groupInput = document.getElementById('focus-group-input');

        // Load focus data if editing existing
        if (focusId) {
            const focus = this.focusItems.find(f => f.id === focusId);
            if (focus) {
                document.getElementById('focus-title-input').value = focus.title;
                document.getElementById('focus-description-input').value = focus.description || '';
                if (groupInput) groupInput.value = focus.group || '';
                this.selectedColor = focus.color || '#4A90A4';
            }
        } else {
            // New focus item — default its group to the active tab (unless
            // that's the synthetic Ungrouped bucket).
            document.getElementById('focus-title-input').value = '';
            document.getElementById('focus-description-input').value = '';
            if (groupInput) {
                groupInput.value = (this.currentGroup && this.currentGroup !== this.UNGROUPED)
                    ? this.currentGroup : '';
            }
            this.selectedColor = '#4A90A4';
        }

        this.updateColorSelection();

        // Focus title input
        setTimeout(() => {
            document.getElementById('focus-title-input').focus();
        }, 100);
    },

    /**
     * Close editor and return to focus list
     */
    closeEditor() {
        // Save before closing
        this.saveCurrentFocus();

        // Hide editor view, show focus view
        document.getElementById('focus-editor-view').classList.remove('active');
        document.getElementById('focus-view').classList.add('active');

        this.currentEditId = null;
        this.render();
    },

    /**
     * Mark as unsaved
     */
    markAsUnsaved() {
        this.hasUnsavedChanges = true;
        this.updateSaveStatus('unsaved');
    },

    /**
     * Update save status indicator
     */
    updateSaveStatus(status) {
        const statusEl = document.getElementById('focus-save-status');
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
     * Save current focus being edited
     */
    saveCurrentFocus(silent = false) {
        const title = document.getElementById('focus-title-input').value.trim();
        const description = document.getElementById('focus-description-input').value.trim();
        const groupEl = document.getElementById('focus-group-input');
        const group = groupEl ? groupEl.value.trim() : '';
        const profile = ProfileManager.getProfileForNewItem();

        if (!title) {
            if (!silent) {
                UIUtils.showToast('Please enter a title', 'error');
            }
            return;
        }

        if (this.currentEditId) {
            // Update existing focus
            const focus = this.focusItems.find(f => f.id === this.currentEditId);
            if (focus) {
                focus.title = title;
                focus.description = description;
                focus.color = this.selectedColor;
                focus.group = group;
                focus.profile = profile;
                focus.modifiedAt = new Date().toISOString();
                this.currentGroup = this.groupOf(focus);
            }
        } else {
            // Create new focus only if there's a title. Areas are flat now —
            // new ones always land at the top level (existing sub-areas are
            // grandfathered: they still render and drill in, but nothing new
            // nests). The `group` string sorts it under a group tab.
            if (title.length > 0) {
                const newFocus = {
                    id: UIUtils.generateId(),
                    title,
                    description,
                    color: this.selectedColor,
                    group,
                    profile,
                    parentId: null,
                    resources: [],
                    createdAt: new Date().toISOString(),
                    modifiedAt: new Date().toISOString()
                };
                this.focusItems.push(newFocus);
                this.currentEditId = newFocus.id;
                this.currentGroup = this.groupOf(newFocus);
                this.selected = { type: 'area', id: newFocus.id };
                this.expandedAreaIds.add(newFocus.id);
            }
        }

        this.saveData();
        if (!silent) {
            this.updateSaveStatus('saved');
            UIUtils.showToast('Focus saved', 'success');
        }
    },

    /**
     * Fill the editor's <datalist> with existing group names for reuse.
     */
    _populateGroupOptions() {
        const dl = document.getElementById('focus-group-options');
        if (!dl) return;
        const groups = this.getGroups().filter(g => g !== this.UNGROUPED);
        dl.innerHTML = groups.map(g => `<option value="${UIUtils.escapeHtml(g)}"></option>`).join('');
    },

    /**
     * Describe the children that currently block deletion of a focus.
     * Returns a list of human-readable fragments (empty if unblocked).
     * A focus is only deletable when it has no sub-focus items AND no
     * linked goals — strict parent-child, no cascade.
     */
    _blockingChildrenFor(focusId) {
        const subCount = this.focusItems.filter(f => f.parentId === focusId).length;
        const linked = LinkManager.countLinkedChildren('focus', focusId);
        const goalCount = linked.goals || 0;
        const parts = [];
        if (subCount) parts.push(`${subCount} sub-focus item${subCount === 1 ? '' : 's'}`);
        if (goalCount) parts.push(`${goalCount} goal${goalCount === 1 ? '' : 's'}`);
        return parts;
    },

    /**
     * Delete a focus item. Refuses if it has sub-focus items or linked
     * goals; caller is expected to have already validated via
     * _blockingChildrenFor. Cleans up cross-app links and removes the
     * row. Does not call saveData — caller handles persistence.
     */
    _deleteFocusItem(focusId) {
        LinkManager.assertNoLinkedChildren('focus', focusId);
        if (this.focusItems.some(f => f.parentId === focusId)) {
            const err = new Error(`Focus ${focusId} still has sub-focus items`);
            err.code = 'CHILD_RECORDS_EXIST';
            throw err;
        }
        LinkManager.removeAllLinksForItem('focus', focusId);
        this.focusItems = this.focusItems.filter(f => f.id !== focusId);
    },

    /**
     * Delete current focus (from editor)
     */
    async deleteCurrentFocus() {
        if (!this.currentEditId) return;
        const focus = this.focusItems.find(f => f.id === this.currentEditId);
        if (!focus) return;

        const blockers = this._blockingChildrenFor(this.currentEditId);
        if (blockers.length > 0) {
            UIUtils.showToast(
                `Cannot delete "${focus.title}" — still has ${blockers.join(' and ')}. Remove those first.`,
                'error'
            );
            return;
        }

        const confirmed = await UIUtils.confirm(
            'Delete Focus',
            `Are you sure you want to delete "${focus.title}"?`,
            '🗑️'
        );
        if (!confirmed) return;

        this._deleteFocusItem(this.currentEditId);
        this.saveData();

        document.getElementById('focus-editor-view').classList.remove('active');
        document.getElementById('focus-view').classList.add('active');
        this.currentEditId = null;
        this.render();
        UIUtils.showToast('Focus deleted', 'success');
    },

    /**
     * Delete a focus item from the list view
     */
    async deleteFocus(focusId) {
        const focus = this.focusItems.find(f => f.id === focusId);
        if (!focus) return;

        const blockers = this._blockingChildrenFor(focusId);
        if (blockers.length > 0) {
            UIUtils.showToast(
                `Cannot delete "${focus.title}" — still has ${blockers.join(' and ')}. Remove those first.`,
                'error'
            );
            return;
        }

        const confirmed = await UIUtils.confirm(
            'Delete Focus',
            `Are you sure you want to delete "${focus.title}"?`,
            '🗑️'
        );
        if (!confirmed) return;

        this._deleteFocusItem(focusId);
        this.saveData();
        this.render();
        UIUtils.showToast('Focus deleted', 'success');
    },

    /**
     * Render the focus workspace (group tabs + tree + detail pane).
     */
    render() {
        this.resolveCurrentGroup();
        this._persistViewState();
        FocusUI.renderWorkspace();
    }
};

// Register app
AppManager.register('focus', FocusApp);
