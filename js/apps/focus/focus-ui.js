/**
 * Plan UI — single-pane drill-down: All groups › Group › Focus area › Goal/Task,
 * navigated by the breadcrumb and the clickable overviews (no left nav).
 * Inline edits (task title/date/complete, goal status) persist straight
 * through to ScheduleApp / GoalsApp / LinkManager.
 */

const FocusUI = {
    _showLinkedNotes: false,

    // Palette for the area's dot / card tint (same set as the New Focus form).
    FOCUS_COLORS: ['#4A90A4', '#7CB342', '#FF7043', '#AB47BC', '#EC407A', '#26A69A', '#5C6BC0', '#78909C'],

    // Valid goal statuses for the detail-pane status picker.
    STATUS_OPTIONS: ['not-started', 'in-progress', 'no-progress', 'need-help'],

    _esc(s) { return UIUtils.escapeHtml(s == null ? '' : String(s)); },

    // ===================================================================
    //  WORKSPACE SHELL
    // ===================================================================

    /**
     * Render the whole workspace: breadcrumb, empty state, detail pane.
     * There is no left nav — navigation is the drill-down breadcrumb
     * (Actions › Plan › Group › Focus area › …) plus the clickable overviews.
     */
    renderWorkspace() {
        this.renderBreadcrumb();
        this.renderNav();

        const ws = document.getElementById('focus-workspace');
        const empty = document.getElementById('focus-empty');

        // Always show the workspace: even on a blank slate the overview
        // carries both starting points ("+ New Focus area" in the header,
        // "+ New Goal" under Other goals — goals may exist before any area
        // and get filed later). The static empty state offers neither.
        if (empty) empty.style.display = 'none';
        if (ws) ws.style.display = 'block';

        this.renderDetailPane();
    },

    /**
     * Left nav — groups and their focus areas only (goals stay in the
     * pane): "All groups" home, then each group as a clickable heading
     * with its areas beneath. Reuses the Tasks tab's nav classes so the
     * two tabs read as one system. Nav rows are drag-drop wired: areas
     * accept goal drops, groups accept area drops, and area rows drag.
     */
    renderNav() {
        const nav = document.getElementById('focus-nav');
        if (!nav) return;
        const sel = FocusApp.selected;
        // Highlight the owning area even when a goal/task inside it is open.
        const selArea = sel ? FocusApp.getAreaForSelection() : null;
        const activeGroup = (!FocusApp.viewAll && !sel) ? FocusApp.currentGroup : null;

        let html = `<div class="actions-nav-section">
            <button type="button" class="actions-nav-item${FocusApp.viewAll && !sel ? ' is-active' : ''}" data-fnav-all>
                <span class="actions-nav-label">All groups</span>
            </button>
        </div>`;

        for (const g of FocusApp.getGroups()) {
            html += `<button type="button" class="actions-nav-item fnav-group${activeGroup === g ? ' is-active' : ''}"
                             data-open-space="${this._esc(g)}" title="${this._esc(g)}">
                <span class="actions-nav-label">${this._esc(g)}</span>
            </button>`;
            html += FocusApp.getAreasInGroup(g).map(a => {
                const goals = LinkManager.getGoalsForFocus(a.id).filter(x => x.status !== 'completed').length;
                return `<button type="button" class="actions-nav-item actions-nav-area fnav-area${selArea && selArea.id === a.id ? ' is-active' : ''}"
                                data-open-area="${a.id}" draggable="true" data-drag-area="${a.id}" title="${this._esc(a.title)}">
                    <span class="actions-nav-dot" style="background:${a.color || '#4A90A4'}"></span>
                    <span class="actions-nav-label">${this._esc(a.title)}</span>
                    ${goals ? `<span class="actions-nav-count">${goals}</span>` : ''}
                </button>`;
            }).join('');
        }
        nav.innerHTML = html;

        nav.querySelector('[data-fnav-all]')?.addEventListener('click', () => FocusApp.goToAllGroups());
        nav.querySelectorAll('[data-open-space]').forEach(el =>
            el.addEventListener('click', () => FocusApp.switchGroup(el.dataset.openSpace)));
        nav.querySelectorAll('[data-open-area]').forEach(el =>
            el.addEventListener('click', () => FocusApp.selectNode('area', el.dataset.openArea)));
        this._wireDragDrop(nav);
    },

    /**
     * Drill-down breadcrumb — the page's only chrome-level navigation:
     * Actions › Plan (all groups) › Group › Focus area [› Goal/Task].
     */
    renderBreadcrumb() {
        const crumbs = [
            { label: 'Actions', action: () => AppManager.openApp('actions') },
            { label: 'Plan', action: () => FocusApp.goToAllGroups() },
        ];
        const sel = FocusApp.selected;
        if (!sel) {
            if (!FocusApp.viewAll && FocusApp.currentGroup) {
                crumbs.push({ label: FocusApp.currentGroup });
            }
        } else {
            const area = FocusApp.getAreaForSelection();
            const space = area ? FocusApp.groupOf(area) : null;
            if (space) crumbs.push({ label: space, action: () => FocusApp.switchGroup(space) });
            if (sel.type === 'area') {
                crumbs.push({ label: area ? area.title : 'Focus area' });
            } else {
                if (area) crumbs.push({ label: area.title, action: () => FocusApp.selectNode('area', area.id) });
                if (sel.type === 'goal') {
                    const meta = LinkManager.getItemMeta('goals', sel.id);
                    crumbs.push({ label: meta ? meta.title : 'Goal' });
                } else {
                    const task = ScheduleApp.scheduleItems.find(t => t.id === sel.id);
                    crumbs.push({ label: task ? task.title : 'Task' });
                }
            }
        }
        Breadcrumb.render('focus-breadcrumb', crumbs);
    },

    // Inline task title/date editing lives in the shared TaskListUI now.

    // ===================================================================
    //  DETAIL PANE
    // ===================================================================

    renderDetailPane() {
        const pane = document.getElementById('focus-detail-pane');
        if (!pane) return;
        // The pane may currently host the embedded schedule editor — hand
        // its DOM back BEFORE any innerHTML write, or it would be destroyed.
        ScheduleApp.restoreEditorHome();
        const sel = FocusApp.selected;
        if (!sel) {
            if (FocusApp.viewAll) this.renderAllGroupsOverview(pane);
            else this.renderGroupOverview(pane);
            return;
        }
        if (sel.type === 'area') this.renderAreaDetail(sel.id, pane);
        else if (sel.type === 'goal') this.renderGoalDetail(sel.id, pane);
        else if (sel.type === 'task') this.renderTaskDetail(sel.id, pane);
    },

    /**
     * Group overview — one group's focus areas, each with its goals. Reached by
     * clicking a group in the all-groups home or the breadcrumb. Carries the
     * group's management actions (new focus area, rename, delete) since the left
     * nav that used to host them is gone.
     */
    renderGroupOverview(pane) {
        const group = FocusApp.currentGroup;
        if (!group) {
            pane.innerHTML = '<div class="focus-detail-empty">Create a focus area to get started.</div>';
            return;
        }
        const areas = FocusApp.getAreasInGroup(group);
        const managed = group !== FocusApp.UNGROUPED;

        let html = `<div class="focus-group-overview">
            <div class="focus-detail-eyebrow"><span>Group</span></div>
            <div class="focus-space-head">
                <h2 class="focus-detail-title">${this._esc(group)}</h2>
                ${managed ? `<span class="focus-space-actions">
                    <button type="button" class="focus-space-action" data-rename-space="${this._esc(group)}" title="Rename group">&#9998;</button>
                    <button type="button" class="focus-space-action focus-space-action--del" data-delete-space="${this._esc(group)}" title="Delete group">&times;</button>
                </span>` : ''}
            </div>
            <div class="focus-group-overview-sub">${areas.length} focus area${areas.length === 1 ? '' : 's'} &mdash; pick a focus area or goal to open it</div>`;

        if (areas.length === 0) {
            html += '<div class="focus-goals-empty">No focus areas in this group yet.</div>';
        } else {
            html += '<div class="focus-area-cards">';
            for (const area of areas) html += this._renderAreaBlock(area);
            html += '</div>';
        }
        html += `<button class="focus-add-area" data-add-area data-add-area-group="${this._esc(group)}">&#43; New focus area in ${this._esc(group)}</button>`;
        html += '</div>';

        pane.innerHTML = html;
        this._wireOverview(pane);
    },

    /**
     * All-groups home — the full map: every group, its focus areas, and the goals
     * in each area. The page's default view; group names drill in.
     */
    renderAllGroupsOverview(pane) {
        const groups = FocusApp.getGroups();
        const totalAreas = FocusApp.getProfileAreas().length;
        const showAreas = FocusApp.showAreasOnHome;

        let html = `<div class="focus-group-overview focus-all-overview">
            <div class="focus-space-head">
                <h2 class="focus-detail-title">All groups</h2>
                <label class="focus-home-toggle" title="List each group's focus areas inside its card">
                    <input type="checkbox" id="focus-show-areas" ${showAreas ? 'checked' : ''}>
                    <span>Show focus areas</span>
                </label>
            </div>
            <div class="focus-group-overview-sub">${groups.length} group${groups.length === 1 ? '' : 's'} &middot; ${totalAreas} focus area${totalAreas === 1 ? '' : 's'}</div>`;

        if (groups.length === 0) {
            html += '<div class="focus-goals-empty">No focus areas yet.</div>';
        } else {
            html += `<div class="focus-space-cards${showAreas ? ' focus-space-cards--areas' : ''}">`;
            for (const g of groups) {
                const areas = FocusApp.getAreasInGroup(g);
                let goals = 0, stuck = 0;
                for (const a of areas) {
                    const gs = LinkManager.getGoalsForFocus(a.id).filter(x => x.status !== 'completed');
                    goals += gs.length;
                    stuck += gs.filter(x => x.status === 'no-progress' || x.status === 'need-help').length;
                }
                const goalsMeta = `${goals} active goal${goals === 1 ? '' : 's'}${stuck ? ` &middot; <span class="focus-space-card-stuck">${stuck} stuck</span>` : ''}`;
                if (showAreas) {
                    // Card = header (opens the group) + the group's focus areas
                    // as rows (each opens its area directly). The header can't
                    // wrap the rows — nested buttons don't fire — so the card
                    // itself is a div.
                    const areaRows = areas.length
                        ? areas.map(a => {
                            const gs = LinkManager.getGoalsForFocus(a.id).filter(x => x.status !== 'completed');
                            const aStuck = gs.filter(x => x.status === 'no-progress' || x.status === 'need-help').length;
                            return `<button type="button" class="focus-space-area" data-open-area="${a.id}" draggable="true" data-drag-area="${a.id}" title="${this._esc(a.title)} &mdash; ${gs.length} active goal${gs.length === 1 ? '' : 's'}${aStuck ? `, ${aStuck} stuck` : ''}">
                                <span class="ftree-dot" style="background:${a.color || '#4A90A4'}"></span>
                                <span class="focus-space-area-title">${this._esc(a.title)}</span>
                                ${gs.length ? `<span class="focus-space-area-count${aStuck ? ' has-stuck' : ''}">${gs.length}</span>` : ''}
                            </button>`;
                          }).join('')
                        : '<div class="focus-space-areas-empty">No focus areas yet</div>';
                    html += `
                        <div class="focus-space-card focus-space-card--areas">
                            <button type="button" class="focus-space-card-head" data-open-space="${this._esc(g)}" title="Open ${this._esc(g)}">
                                <span class="focus-space-card-name">${this._esc(g)}</span>
                                <span class="focus-space-card-meta">${goalsMeta}</span>
                            </button>
                            <div class="focus-space-card-areas">${areaRows}</div>
                        </div>`;
                } else {
                    // Compact summary card — area color dots + counts.
                    const dots = areas.map(a =>
                        `<span class="focus-space-card-dot" style="background:${a.color || '#4A90A4'}" title="${this._esc(a.title)}"></span>`).join('');
                    html += `
                        <button type="button" class="focus-space-card" data-open-space="${this._esc(g)}" title="Open ${this._esc(g)}">
                            <span class="focus-space-card-name">${this._esc(g)}</span>
                            <span class="focus-space-card-dots">${dots}</span>
                            <span class="focus-space-card-meta">${areas.length} focus area${areas.length === 1 ? '' : 's'}</span>
                            <span class="focus-space-card-meta">${goalsMeta}</span>
                        </button>`;
                }
            }
            html += '</div>';
        }
        // Goals not yet filed under a focus area — first-class, never hidden.
        // Also the home of "+ New Goal": goals can start unassigned and be
        // dragged onto an area later.
        html += this._renderUnassignedGoals();
        html += '</div>';

        pane.innerHTML = html;
        this._wireOverview(pane);
        pane.querySelector('#focus-show-areas')?.addEventListener('change', (e) =>
            FocusApp.setShowAreasOnHome(e.target.checked));
    },

    /**
     * "Other goals" — active goals with no focus-area link, listed on the
     * all-groups home so retiring the standalone Goals list loses nothing.
     * Rows are draggable onto any focus area (row or card) to file them.
     */
    _renderUnassignedGoals() {
        FocusApp._ensureGoalsLoaded();
        const unassigned = ProfileManager.filterByActiveProfile(GoalsApp.goals || [])
            .filter(g => g.status !== 'completed' && !LinkManager.getFocusForItem('goals', g.id));

        let h = `<div class="focus-unassigned">
            <div class="focus-detail-section-header">
                <h3>Other goals</h3>
                <div class="focus-detail-section-actions">
                    <button type="button" class="secondary-btn" data-new-goal>+ New Goal</button>
                </div>
            </div>
            <div class="focus-unassigned-sub">Goals without a focus area yet &mdash; drag one onto a focus area to file it.</div>`;
        if (unassigned.length === 0) {
            h += '<div class="focus-goals-empty">Nothing unfiled.</div>';
        } else {
            h += '<div class="focus-area-goals">';
            for (const g of unassigned) {
                const count = LinkManager.getTaskCountForGoal(g.id);
                h += `<button type="button" class="focus-area-goal" data-open-goal="${g.id}" draggable="true" data-drag-goal="${g.id}">
                        <span class="ftree-gdot ${g.status || 'not-started'}"></span>
                        <span class="focus-area-goal-title">${this._esc(g.title)}</span>
                        ${count.total ? `<span class="focus-area-goal-count">${count.completed}/${count.total}</span>` : ''}
                      </button>`;
            }
            h += '</div>';
        }
        h += '</div>';
        return h;
    },

    /**
     * A focus-area block for the overview panes: a clickable header (dot, title,
     * description, active-goal/stuck meta) with the area's goals listed beneath.
     * Used by both the single-group and all-groups overviews.
     */
    _renderAreaBlock(area) {
        const goals = LinkManager.getGoalsForFocus(area.id);
        const activeGoals = goals.filter(g => g.status !== 'completed');
        const stuck = activeGoals.filter(g => g.status === 'no-progress' || g.status === 'need-help').length;

        let h = `<div class="focus-area-block">
            <button type="button" class="focus-area-block-head" data-open-area="${area.id}">
                <span class="focus-area-card-dot" style="background:${area.color || '#4A90A4'}"></span>
                <span class="focus-area-card-body">
                    <span class="focus-area-card-title">${this._esc(area.title)}</span>
                    ${area.description ? `<span class="focus-area-card-desc">${this._esc(area.description)}</span>` : ''}
                    <span class="focus-area-card-meta">
                        <span>${activeGoals.length} active goal${activeGoals.length === 1 ? '' : 's'}</span>
                        ${stuck ? `<span class="focus-area-card-stuck">${stuck} stuck</span>` : ''}
                    </span>
                </span>
                <span class="focus-area-card-arrow">&#8594;</span>
            </button>`;

        if (goals.length) {
            h += '<div class="focus-area-goals">';
            for (const g of goals) {
                const status = g.status || 'not-started';
                const count = LinkManager.getTaskCountForGoal(g.itemId);
                h += `<button type="button" class="focus-area-goal ${g.status === 'completed' ? 'completed' : ''}" data-open-goal="${g.itemId}" draggable="true" data-drag-goal="${g.itemId}">
                        <span class="ftree-gdot ${status}"></span>
                        <span class="focus-area-goal-title">${this._esc(g.title)}</span>
                        ${count.total ? `<span class="focus-area-goal-count">${count.completed}/${count.total}</span>` : ''}
                      </button>`;
            }
            h += '</div>';
        } else {
            h += '<div class="focus-area-goals-empty">No goals yet</div>';
        }
        h += '</div>';
        return h;
    },

    /** Wire focus-area/goal/group opens and group management in an overview pane. */
    _wireOverview(pane) {
        pane.querySelectorAll('[data-open-area]').forEach(el =>
            el.addEventListener('click', () => FocusApp.selectNode('area', el.dataset.openArea)));
        pane.querySelectorAll('[data-open-goal]').forEach(el =>
            el.addEventListener('click', () => FocusApp.selectNode('goal', el.dataset.openGoal)));
        pane.querySelectorAll('[data-open-space]').forEach(el =>
            el.addEventListener('click', () => FocusApp.switchGroup(el.dataset.openSpace)));
        pane.querySelectorAll('[data-add-area]').forEach(btn =>
            btn.addEventListener('click', () => {
                const g = btn.dataset.addAreaGroup;
                if (g && g !== FocusApp.UNGROUPED) FocusApp.currentGroup = g;
                FocusApp.openEditor();
            }));
        pane.querySelectorAll('[data-rename-space]').forEach(btn =>
            btn.addEventListener('click', () => FocusApp.renameGroup(btn.dataset.renameSpace)));
        pane.querySelectorAll('[data-delete-space]').forEach(btn =>
            btn.addEventListener('click', () => FocusApp.deleteGroup(btn.dataset.deleteSpace)));
        pane.querySelectorAll('[data-new-goal]').forEach(btn =>
            btn.addEventListener('click', () => FocusApp.createGoalInline(null)));
        this._wireDragDrop(pane);
    },

    // Custom MIME types so dragover can tell goal drags from area drags
    // (dataTransfer payloads are unreadable until drop).
    GOAL_MIME: 'application/x-anjadhe-goal',
    AREA_MIME: 'application/x-anjadhe-area',

    /**
     * Drag-and-drop filing in the overviews: goals drop onto focus areas
     * (sets the goal's area), focus areas drop onto group cards (sets the
     * area's group). Sources carry a custom MIME type; targets only light
     * up for the kind they accept.
     */
    _wireDragDrop(pane) {
        pane.querySelectorAll('[data-drag-goal]').forEach(el =>
            el.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData(this.GOAL_MIME, el.dataset.dragGoal);
                e.dataTransfer.effectAllowed = 'move';
            }));
        pane.querySelectorAll('[data-drag-area]').forEach(el =>
            el.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData(this.AREA_MIME, el.dataset.dragArea);
                e.dataTransfer.effectAllowed = 'move';
            }));

        const wireTarget = (el, mime, onDrop) => {
            el.addEventListener('dragover', (e) => {
                if (![...e.dataTransfer.types].includes(mime)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                el.classList.add('is-drop');
            });
            el.addEventListener('dragleave', (e) => {
                if (!el.contains(e.relatedTarget)) el.classList.remove('is-drop');
            });
            el.addEventListener('drop', (e) => {
                const id = e.dataTransfer.getData(mime);
                if (!id) return;
                e.preventDefault();
                e.stopPropagation();
                el.classList.remove('is-drop');
                onDrop(id);
            });
        };

        // Any element that opens an area accepts goals; any element that
        // opens a group accepts areas.
        pane.querySelectorAll('[data-open-area]').forEach(el =>
            wireTarget(el, this.GOAL_MIME, (goalId) =>
                FocusApp.assignGoalToArea(goalId, el.dataset.openArea)));
        pane.querySelectorAll('[data-open-space]').forEach(el =>
            wireTarget(el, this.AREA_MIME, (areaId) =>
                FocusApp.moveAreaToGroup(areaId, el.dataset.openSpace)));
    },

    /**
     * Area detail — the editor for the area (title/group/description/color)
     * plus its Goals & Tasks, and linked Notes & Bookmarks.
     */
    renderAreaDetail(focusId, pane) {
        const focus = FocusApp.focusItems.find(f => f.id === focusId);
        if (!focus) { pane.innerHTML = '<div class="focus-detail-empty">This focus area no longer exists.</div>'; return; }

        const swatches = this.FOCUS_COLORS.map(c =>
            `<button type="button" class="color-option${(focus.color || this.FOCUS_COLORS[0]) === c ? ' selected' : ''}"
                     data-color="${c}" style="background:${c};" title="${c}"></button>`).join('');

        let html = `
            <div class="focus-detail-head">
                <div class="focus-detail-eyebrow"><span class="ftree-dot" style="background:${focus.color || '#4A90A4'}"></span>Focus area</div>
                <input type="text" id="focus-detail-title" class="detail-title-input"
                       value="${this._esc(focus.title)}" placeholder="Focus area name..." autocomplete="off">
                <div class="goal-editor-card">
                <div class="detail-section-header">Details</div>
                <div class="focus-detail-row">
                    <div class="focus-detail-field">
                        <label for="focus-detail-group">Group</label>
                        <input type="text" id="focus-detail-group" class="focus-detail-input"
                               list="focus-group-options" value="${this._esc(focus.group || '')}"
                               placeholder="Ungrouped" autocomplete="off">
                    </div>
                    <div class="focus-detail-field">
                        <label>Color</label>
                        <div id="focus-detail-colors" class="focus-detail-swatches">${swatches}</div>
                    </div>
                </div>
                <div class="focus-description-wrapper">
                    <label for="focus-detail-description">Description</label>
                    <textarea id="focus-detail-description" class="focus-detail-desc-input"
                              placeholder="What this focus area is about...">${this._esc(focus.description || '')}</textarea>
                </div>
                </div>
                <div class="focus-detail-head-actions">
                    <button class="secondary-btn focus-detail-delete-btn">Delete focus area</button>
                    <button class="primary-btn focus-detail-save-btn">Save</button>
                </div>
            </div>`;

        // Goals & Tasks
        html += this._renderAreaGoalsTasks(focusId);

        // Linked Notes & Bookmarks (collapsible)
        const notesExpanded = this._showLinkedNotes;
        html += `<div class="focus-detail-section focus-linked-notes-section">
                    <button class="focus-linked-toggle schedule-completed-toggle" data-toggle="linked-notes" aria-expanded="${!!notesExpanded}">
                        <span class="schedule-section-title">Notes &amp; Bookmarks</span>
                        <span class="schedule-completed-arrow">${notesExpanded ? '&#9652;' : '&#9662;'}</span>
                    </button>
                    <div class="focus-linked-notes-body" style="display:${notesExpanded ? 'block' : 'none'};">
                        ${LinkedItemsUI.renderAll('focus', focusId, {
                            sections: [
                                { targetApp: 'notes', label: 'Notes', buttonLabel: '+ Attach Note' },
                                { targetApp: 'bookmarks', label: 'Bookmarks', buttonLabel: '+ Link Bookmark' }
                            ]
                        })}
                    </div>
                 </div>`;

        pane.innerHTML = html;
        FocusApp._populateGroupOptions();

        // Color swatch selection (held on FocusApp until Save / navigate-away).
        FocusApp._detailColor = focus.color || this.FOCUS_COLORS[0];
        pane.querySelectorAll('#focus-detail-colors .color-option').forEach(btn => {
            btn.addEventListener('click', () => {
                FocusApp._detailColor = btn.dataset.color;
                pane.querySelectorAll('#focus-detail-colors .color-option').forEach(b =>
                    b.classList.toggle('selected', b === btn));
            });
        });

        // Save / Delete
        const saveBtn = pane.querySelector('.focus-detail-save-btn');
        if (saveBtn) saveBtn.addEventListener('click', () => FocusApp.saveDetailEdits());
        const delBtn = pane.querySelector('.focus-detail-delete-btn');
        if (delBtn) delBtn.addEventListener('click', () => FocusApp.deleteFocus(focusId));

        this._attachGoalsTasksListeners(pane, focusId);

        // Notes toggle
        const linkedToggle = pane.querySelector('[data-toggle="linked-notes"]');
        if (linkedToggle) {
            linkedToggle.addEventListener('click', () => {
                this._showLinkedNotes = !this._showLinkedNotes;
                const body = pane.querySelector('.focus-linked-notes-body');
                const arrow = linkedToggle.querySelector('.schedule-completed-arrow');
                body.style.display = this._showLinkedNotes ? 'block' : 'none';
                arrow.innerHTML = this._showLinkedNotes ? '&#9652;' : '&#9662;';
                linkedToggle.setAttribute('aria-expanded', this._showLinkedNotes);
            });
        }
        const notesBody = pane.querySelector('.focus-linked-notes-body');
        if (notesBody) {
            LinkedItemsUI.attachListeners(notesBody, () => this.renderDetailPane());
        }
    },

    /**
     * The Goals & Tasks block used inside the area detail pane. Markup matches
     * what _attachGoalsTasksListeners expects.
     */
    _renderAreaGoalsTasks(focusId) {
        const goals = LinkManager.getGoalsForFocus(focusId);
        const allFocusTasks = LinkManager.getLinksForApp('focus', focusId, 'schedule');

        const goalTaskIds = new Set();
        const goalTasksMap = {};
        for (const goal of goals) {
            const tasks = LinkManager.getTasksForGoal(goal.itemId);
            goalTasksMap[goal.itemId] = tasks;
            for (const t of tasks) goalTaskIds.add(t.itemId);
        }

        const otherTasks = [];
        for (const link of allFocusTasks) {
            if (!goalTaskIds.has(link.itemId)) {
                const meta = LinkManager.getItemMeta('schedule', link.itemId);
                if (meta) otherTasks.push({ ...meta, itemId: link.itemId, linkId: link.linkId });
            }
        }

        let html = '<div class="focus-detail-section">';
        html += `<div class="focus-detail-section-header">
                    <h3>Goals &amp; Tasks</h3>
                    <div class="focus-detail-section-actions">
                        <button class="secondary-btn focus-create-goal-btn" data-focus-id="${focusId}">+ New Goal</button>
                        <button class="secondary-btn focus-link-goal-btn" data-focus-id="${focusId}">+ Link Existing</button>
                    </div>
                 </div>`;

        if (goals.length === 0 && otherTasks.length === 0) {
            html += '<div class="focus-goals-empty">No goals or tasks linked yet</div>';
        } else {
            html += '<div class="focus-goals-list">';
            for (const goal of goals) {
                const tasks = goalTasksMap[goal.itemId] || [];
                const status = goal.status || 'not-started';
                const statusLabel = GoalsApp.formatStatus(status);
                const taskCount = LinkManager.getTaskCountForGoal(goal.itemId);
                const expanded = !FocusApp.collapsedGoalIds.has(goal.itemId);

                html += `<div class="focus-goal-card ${goal.status === 'completed' ? 'completed' : ''}" data-goal-id="${goal.itemId}">`;
                // Twisty collapses the card's task list; the rest of the
                // header still opens the goal. The n/m count keeps a
                // collapsed card honest about what's inside.
                html += `<div class="focus-goal-header" data-goal-id="${goal.itemId}">
                            <button type="button" class="focus-goal-collapse" data-collapse-goal="${goal.itemId}"
                                    aria-expanded="${expanded}" title="${expanded ? 'Hide tasks' : 'Show tasks'}">${expanded ? '&#9662;' : '&#9656;'}</button>
                            <span class="focus-goal-status-dot ${status}"></span>
                            <span class="focus-goal-title">${this._esc(goal.title)}</span>
                            <span class="focus-goal-status-badge">${statusLabel}</span>
                            ${taskCount.total > 0 ? `<span class="focus-goal-task-count">${taskCount.completed}/${taskCount.total}</span>` : ''}
                            <span class="focus-goal-nav" title="Open goal">&#8594;</span>
                         </div>`;
                if (expanded) {
                    if (tasks.length > 0) {
                        html += `<div class="focus-goal-tasks">${TaskListUI.renderList(tasks, this._goalTaskOpts(goal.itemId, focusId))}</div>`;
                    }
                    html += `<button class="focus-goal-add-task task-list-new-btn">+ New Task</button>`;
                }
                html += '</div>';
            }

            if (otherTasks.length > 0) {
                html += '<div class="focus-other-tasks">';
                html += '<div class="focus-other-tasks-label">Other Tasks</div>';
                html += `<div class="focus-goal-card"><div class="focus-goal-tasks">${TaskListUI.renderList(otherTasks, this._areaTaskOpts(focusId))}</div></div>`;
                html += '</div>';
            }
            html += '</div>';
        }
        html += '</div>';
        return html;
    },

    /**
     * Goal detail — the FULL goal editor, rendered inline in the pane so the
     * experience matches the standalone goal page (same fields + tasks +
     * notes). Reuses the Goals app's Tasks-section markup and LinkedItemsUI;
     * every field autosaves in place via FocusApp -> GoalsApp.
     */
    renderGoalDetail(goalId, pane) {
        FocusApp._ensureGoalsLoaded();   // a fresh window hasn't populated GoalsApp.goals yet
        FocusApp._ensureScheduleLoaded();
        const goal = (GoalsApp.goals || []).find(g => g.id === goalId);
        if (!goal) { pane.innerHTML = '<div class="focus-detail-empty">This goal no longer exists.</div>'; return; }
        const area = FocusApp.areaOwningGoal(goalId);
        const status = goal.status || 'not-started';

        const focusItems = ProfileManager.filterByActiveProfile((StorageManager.get('focus')?.focusItems) || []);
        const focusOptions = `<option value="">— None —</option>` +
            focusItems.map(f => `<option value="${f.id}" ${area && f.id === area.id ? 'selected' : ''}>${this._esc(f.title)}</option>`).join('');

        const statusPills = this.STATUS_OPTIONS.map(s =>
            `<button type="button" class="goal-status-pill${s === status ? ' is-active' : ''}" data-status="${s}">${GoalsApp.formatStatus(s)}</button>`).join('');

        const notesExpanded = this._showLinkedNotes;
        const html = `<div class="goal-editor-main focus-goal-embed">
            <div class="focus-detail-crumbs">
                ${area ? `<span class="ftree-dot" style="background:${area.color || '#4A90A4'}"></span><span class="breadcrumb-link" data-crumb-area="${area.id}">${this._esc(area.title)}</span><span class="breadcrumb-separator">&#8250;</span>` : ''}<span class="breadcrumb-current">Goal</span>
            </div>
            <input type="text" class="detail-title-input goal-embed-title" value="${this._esc(goal.title)}" placeholder="Goal title..." autocomplete="off">
            <div class="goal-editor-card">
            <div class="detail-section-header">Details</div>
            <div class="goal-detail-row">
                <div class="goal-detail-field">
                    <label>Status</label>
                    <div class="goal-status-seg goal-embed-status" role="group" aria-label="Status">${statusPills}</div>
                </div>
                <div class="goal-detail-field">
                    <label for="goal-embed-focus">Focus area</label>
                    <select id="goal-embed-focus" class="goal-focus-select goal-embed-focus">${focusOptions}</select>
                </div>
                <div class="goal-detail-field">
                    <label for="goal-embed-target">Target date</label>
                    <input type="date" id="goal-embed-target" class="goal-target-input goal-embed-target" value="${goal.targetDate || ''}">
                </div>
                <div class="goal-detail-field goal-detail-field--completed">
                    <label class="goal-completed-label">
                        <input type="checkbox" class="goal-completed-input goal-embed-completed" ${goal.status === 'completed' ? 'checked' : ''}>
                        <span>Completed</span>
                    </label>
                </div>
            </div>
            <div class="goal-description-wrapper">
                <label for="goal-embed-desc">Description</label>
                <textarea id="goal-embed-desc" class="goal-description-input goal-embed-desc" placeholder="What does done look like?">${this._esc(goal.description || '')}</textarea>
            </div>
            </div>
            ${TaskListUI.renderSection(LinkManager.getTasksForGoal(goalId), this._goalTaskOpts(goalId, area ? area.id : null))}
            <div class="goal-linked-notes-section">
                <button class="focus-linked-toggle schedule-completed-toggle" data-toggle="goal-linked-notes" aria-expanded="${!!notesExpanded}">
                    <span class="schedule-section-title">Notes &amp; Bookmarks</span>
                    <span class="schedule-completed-arrow">${notesExpanded ? '&#9652;' : '&#9662;'}</span>
                </button>
                <div class="goal-linked-notes-body" style="display:${notesExpanded ? 'block' : 'none'};">
                    ${LinkedItemsUI.renderAll('goals', goalId, {
                        sections: [
                            { targetApp: 'notes', label: 'Notes', buttonLabel: '+ Attach Note' },
                            { targetApp: 'bookmarks', label: 'Bookmarks', buttonLabel: '+ Link Bookmark' }
                        ]
                    })}
                </div>
            </div>
            <div class="focus-detail-head-actions">
                <button type="button" class="secondary-btn goal-embed-delete">Delete goal</button>
            </div>
        </div>`;

        pane.innerHTML = html;
        this._attachGoalEmbedListeners(pane, goalId, area);
    },

    /** Wire eyebrow breadcrumb links (area/goal ancestors) to tree selection. */
    _attachCrumbListeners(pane) {
        pane.querySelectorAll('.breadcrumb-link[data-crumb-area]').forEach(btn =>
            btn.addEventListener('click', () => FocusApp.selectNode('area', btn.dataset.crumbArea)));
        pane.querySelectorAll('.breadcrumb-link[data-crumb-goal]').forEach(btn =>
            btn.addEventListener('click', () => FocusApp.selectNode('goal', btn.dataset.crumbGoal)));
    },

    /** Wire the embedded goal editor's fields, tasks, and notes to persistence. */
    _attachGoalEmbedListeners(pane, goalId, area) {
        this._attachCrumbListeners(pane);

        const titleEl = pane.querySelector('.goal-embed-title');
        titleEl.addEventListener('change', () => FocusApp.setGoalField(goalId, 'title', titleEl.value));

        pane.querySelectorAll('.goal-embed-status .goal-status-pill').forEach(btn =>
            btn.addEventListener('click', () => FocusApp.setGoalStatus(goalId, btn.dataset.status)));

        pane.querySelector('.goal-embed-focus').addEventListener('change', (e) =>
            FocusApp.setGoalFocus(goalId, e.target.value));

        pane.querySelector('.goal-embed-target').addEventListener('change', (e) =>
            FocusApp.setGoalField(goalId, 'targetDate', e.target.value || null));

        pane.querySelector('.goal-embed-completed').addEventListener('change', (e) =>
            FocusApp.setGoalStatus(goalId, e.target.checked ? 'completed' : 'in-progress'));

        const descEl = pane.querySelector('.goal-embed-desc');
        descEl.addEventListener('change', () => FocusApp.setGoalField(goalId, 'description', descEl.value.trim()));

        pane.querySelector('.goal-embed-delete')?.addEventListener('click', () => FocusApp.deleteGoal(goalId));

        // Tasks list — the shared TaskListUI; edits persist in place and
        // re-render the workspace.
        TaskListUI.attach(pane.querySelector('.task-list-section'),
            this._goalTaskOpts(goalId, area ? area.id : null));

        // Notes & Bookmarks collapsible
        const toggle = pane.querySelector('[data-toggle="goal-linked-notes"]');
        if (toggle) {
            toggle.addEventListener('click', () => {
                this._showLinkedNotes = !this._showLinkedNotes;
                const body = pane.querySelector('.goal-linked-notes-body');
                const arrow = toggle.querySelector('.schedule-completed-arrow');
                body.style.display = this._showLinkedNotes ? 'block' : 'none';
                arrow.innerHTML = this._showLinkedNotes ? '&#9652;' : '&#9662;';
                toggle.setAttribute('aria-expanded', this._showLinkedNotes);
            });
        }
        const notesBody = pane.querySelector('.goal-linked-notes-body');
        if (notesBody) LinkedItemsUI.attachListeners(notesBody, () => this.renderDetailPane());
    },

    /**
     * Task detail — the FULL schedule editor (repeat, reminders, timer,
     * links, history), embedded in the pane so Plan keeps its nav and
     * breadcrumb (same mechanism as the Tasks tab; replaced the old
     * minimal title/date/time quick form). Back/delete return to the
     * goal or area the task was opened from (origin 'plan').
     */
    renderTaskDetail(taskId, pane) {
        const item = FocusApp._scheduleItem(taskId);
        if (!item) { pane.innerHTML = '<div class="focus-detail-empty">This task no longer exists.</div>'; return; }
        pane.innerHTML = '';
        ScheduleApp.init();
        ScheduleApp.embedEditor(pane);
        ScheduleApp.openEditor(taskId, { origin: 'plan', embedded: true });
    },

    // ===================================================================
    //  SHARED HELPERS (area detail goals/tasks) — preserved
    // ===================================================================

    _attachGoalsTasksListeners(container, focusId) {
        container.querySelectorAll('.focus-link-goal-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const existingLinks = LinkManager.getLinksForApp('focus', focusId, 'goals');
                const excludeIds = existingLinks.map(l => l.itemId);
                LinkPicker.show({
                    targetApp: 'goals',
                    exclude: excludeIds,
                    onSelect: (item) => {
                        LinkManager.setFocusForItem('goals', item.id, focusId);
                        this.renderDetailPane();
                    }
                });
            });
        });

        // "+ New Goal" creates in place (linked to this area) and drops into
        // the embedded goal editor — planning never leaves the Plan page.
        container.querySelectorAll('.focus-create-goal-btn').forEach(btn => {
            btn.addEventListener('click', () => FocusApp.createGoalInline(focusId));
        });

        container.querySelectorAll('.focus-goal-header').forEach(header => {
            header.addEventListener('click', (e) => {
                if (e.target.closest('.focus-goal-collapse')) return;   // twisty owns that click
                FocusApp.selectNode('goal', header.dataset.goalId);
            });
        });

        container.querySelectorAll('.focus-goal-collapse').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                FocusApp.toggleGoalCollapsed(btn.dataset.collapseGoal);
            });
        });

        // Task rows — the shared TaskListUI, wired per goal card so each
        // list's unlink/new-task context stays unambiguous. The trailing
        // no-goal-id card is the "Other Tasks" bucket (unlinks from the area).
        container.querySelectorAll('.focus-goal-card[data-goal-id]').forEach(card =>
            TaskListUI.attach(card, this._goalTaskOpts(card.dataset.goalId, focusId)));
        const other = container.querySelector('.focus-other-tasks');
        if (other) TaskListUI.attach(other, this._areaTaskOpts(focusId));
    },

    /**
     * TaskListUI context for a goal's task list inside the Plan pane —
     * open in-pane, unlink from the goal, "+ New Task" links to the goal
     * and its focus area.
     */
    _goalTaskOpts(goalId, focusId) {
        return {
            onChanged: () => FocusApp.render(),
            onOpenTask: (taskId) => FocusApp.selectNode('task', taskId),
            unlink: { app: 'goals', id: goalId, title: 'Unlink from this goal' },
            newTask: {
                links: [
                    { app: 'goals', id: goalId },
                    ...(focusId ? [{ app: 'focus', id: focusId }] : [])
                ]
            },
            linkExisting: { app: 'goals', id: goalId },
            aiBreakdown: { goalId, focusId }
        };
    },

    /** TaskListUI context for the area's loose "Other Tasks" bucket. */
    _areaTaskOpts(focusId) {
        return {
            onChanged: () => FocusApp.render(),
            onOpenTask: (taskId) => FocusApp.selectNode('task', taskId),
            unlink: { app: 'focus', id: focusId, title: 'Unlink from this focus area' }
        };
    },

};
