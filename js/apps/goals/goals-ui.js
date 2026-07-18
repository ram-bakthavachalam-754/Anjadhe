/**
 * Goals UI — one list, grouped by status.
 *
 * Status does the organizing (In progress / Up next / Stuck / Completed),
 * so the page needs no type tabs, status pills, or sort dropdown. Cards
 * carry only what identifies the goal — title, focus area, task progress,
 * target date — and click through to the single detail page.
 */

const GoalsUI = {

    GROUPS: [
        { key: 'inProgress', label: 'In progress' },
        { key: 'upNext',     label: 'Up next' },
        { key: 'stuck',      label: 'Stuck' },
    ],

    render(app) {
        const container = document.getElementById('goals-container');
        const emptyState = document.getElementById('goals-empty');
        const grouped = app.getGroupedGoals();
        const activeCount = grouped.inProgress.length + grouped.upNext.length + grouped.stuck.length;
        const total = activeCount + grouped.completed.length;

        if (total === 0 && !app.searchQuery) {
            container.style.display = 'none';
            emptyState.style.display = 'block';
            return;
        }
        container.style.display = 'block';
        emptyState.style.display = 'none';

        let html = '';

        if (total === 0) {
            html += `<div class="goals-empty-section">No goals match your search.</div>`;
        }

        for (const group of this.GROUPS) {
            const goals = grouped[group.key];
            if (goals.length === 0) continue;
            html += `<div class="goals-section-header">${group.label} <span class="goals-section-count">${goals.length}</span></div>`;
            html += `<div class="goals-list">`;
            for (const goal of goals) html += this.renderGoalCard(app, goal);
            html += `</div>`;
        }

        // Completed lives behind one collapsed toggle — replaces the old
        // "Show Completed" checkbox. A search auto-expands it so matches
        // can't hide.
        if (grouped.completed.length > 0) {
            const expanded = app.showCompleted || !!app.searchQuery;
            html += `
                <button class="goals-completed-toggle" id="goals-completed-toggle" aria-expanded="${expanded}">
                    Completed <span class="goals-section-count">${grouped.completed.length}</span>
                    <span class="goals-completed-arrow">${expanded ? '&#9652;' : '&#9662;'}</span>
                </button>`;
            if (expanded) {
                html += `<div class="goals-list goals-list--completed">`;
                for (const goal of grouped.completed) html += this.renderGoalCard(app, goal);
                html += `</div>`;
            }
        }

        container.innerHTML = html;
        this.attachEventListeners(app, container);
    },

    /**
     * One goal row: drag handle, complete checkbox, title + focus area,
     * task progress, target date. Click opens the detail page.
     */
    renderGoalCard(app, goal) {
        const focus = LinkManager.getFocusForItem('goals', goal.id);
        const focusBadgeHtml = focus
            ? `<span class="goal-focus-badge" data-focus-id="${focus.itemId}" title="Focus: ${UIUtils.escapeHtml(focus.title)}"><span class="goal-focus-dot" style="background: ${focus.color || 'var(--color-text)'}"></span>${UIUtils.escapeHtml(focus.title)}</span>`
            : '';

        const taskCount = LinkManager.getTaskCountForGoal(goal.id);
        const taskCountHtml = taskCount.total > 0
            ? `<span class="goal-task-count">${taskCount.completed}/${taskCount.total} tasks</span>`
            : '';

        const targetHtml = this.targetChip(goal);

        // "Need help" is the one status the group header doesn't convey
        // (it shares the Stuck group with "no progress").
        const done = goal.status === 'completed';
        const helpChip = goal.status === 'need-help'
            ? `<span class="goal-help-chip">need help</span>`
            : '';

        return `
            <div class="goal-card ${done ? 'completed' : ''}" data-goal-id="${goal.id}" draggable="true">
                <div class="goal-drag-handle" title="Drag to reorder">&#8942;&#8942;</div>
                <button class="goal-checkbox ${done ? 'checked' : ''}" data-goal-id="${goal.id}" title="${done ? 'Mark incomplete' : 'Mark complete'}">
                    ${done ? '&#10004;' : ''}
                </button>
                <div class="goal-card-body" data-goal-id="${goal.id}" title="Open goal">
                    <div class="goal-title">${UIUtils.escapeHtml(goal.title)}</div>
                </div>
                <div class="goal-card-meta">
                    ${helpChip}
                    ${focusBadgeHtml}
                    ${taskCountHtml}
                    ${targetHtml}
                </div>
            </div>
        `;
    },

    /**
     * The target-date chip: "by today" / "by tomorrow" / "by Jul 12",
     * switching to a red "overdue" for active goals past their date.
     */
    targetChip(goal) {
        if (!goal.targetDate) return '';
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const target = new Date(goal.targetDate + 'T00:00:00');
        const diffDays = Math.round((target - today) / (1000 * 60 * 60 * 24));

        const sameYear = target.getFullYear() === today.getFullYear();
        const dateLabel = target.toLocaleDateString(undefined,
            sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });

        if (diffDays < 0 && goal.status !== 'completed') {
            return `<span class="goal-target-chip overdue" title="Target date passed">${dateLabel} &middot; overdue</span>`;
        }
        const label = diffDays === 0 ? 'by today' : diffDays === 1 ? 'by tomorrow' : `by ${dateLabel}`;
        return `<span class="goal-target-chip" title="Target date">${label}</span>`;
    },

    /**
     * Status pills in the detail page. Selection lives in
     * GoalsApp._editorStatus; clicking re-renders and marks unsaved.
     */
    renderStatusSeg(selected) {
        const host = document.getElementById('goal-status-seg');
        if (!host) return;
        const statuses = ['not-started', 'in-progress', 'no-progress', 'need-help'];
        host.innerHTML = statuses.map(s => `
            <button type="button" class="goal-status-pill${s === selected ? ' is-active' : ''}" data-status="${s}">
                ${GoalsApp.formatStatus(s)}
            </button>`).join('');
        host.querySelectorAll('.goal-status-pill').forEach(btn => {
            btn.addEventListener('click', () => GoalsApp.setEditorStatus(btn.dataset.status));
        });
    },

    attachEventListeners(app, container) {
        // Open the detail page
        container.querySelectorAll('.goal-card-body').forEach(body => {
            body.addEventListener('click', () => {
                app.openEditor(body.dataset.goalId);
            });
        });

        // Complete checkbox
        container.querySelectorAll('.goal-checkbox').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleComplete(btn.dataset.goalId);
            });
        });

        // Focus area badge click — navigate to focus area
        container.querySelectorAll('.goal-focus-badge').forEach(badge => {
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                LinkedItemsUI.navigateToItem('focus', badge.dataset.focusId);
            });
        });

        // Completed section toggle
        const completedToggle = container.querySelector('#goals-completed-toggle');
        if (completedToggle) {
            completedToggle.addEventListener('click', () => {
                app.showCompleted = !app.showCompleted;
                app.render();
            });
        }

        this.attachDragAndDropListeners(container);
    },

    attachDragAndDropListeners(container) {
        if (!container) return;

        let draggedCard = null;
        let draggedId = null;

        container.querySelectorAll('.goal-card').forEach(card => {
            card.addEventListener('dragstart', (e) => {
                draggedCard = card;
                draggedId = card.dataset.goalId;
                card.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', draggedId);
            });

            card.addEventListener('dragend', () => {
                card.classList.remove('dragging');
                container.querySelectorAll('.goal-card').forEach(c => {
                    c.classList.remove('drag-over', 'drag-over-before', 'drag-over-after');
                });
                draggedCard = null;
                draggedId = null;
            });

            card.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';

                if (card === draggedCard) return;

                const rect = card.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;

                card.classList.remove('drag-over-before', 'drag-over-after');
                if (e.clientY < midY) {
                    card.classList.add('drag-over-before');
                } else {
                    card.classList.add('drag-over-after');
                }
            });

            card.addEventListener('dragenter', (e) => {
                e.preventDefault();
                if (card !== draggedCard) {
                    card.classList.add('drag-over');
                }
            });

            card.addEventListener('dragleave', () => {
                card.classList.remove('drag-over', 'drag-over-before', 'drag-over-after');
            });

            card.addEventListener('drop', (e) => {
                e.preventDefault();
                if (card === draggedCard || !draggedId) return;

                const targetId = card.dataset.goalId;
                const rect = card.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                const insertBefore = e.clientY < midY;

                GoalsApp.reorderGoal(draggedId, targetId, insertBefore);

                card.classList.remove('drag-over', 'drag-over-before', 'drag-over-after');
            });
        });
    },

    toggleComplete(goalId) {
        const goal = GoalsApp.goals.find(g => g.id === goalId);
        if (goal) {
            goal.status = goal.status === 'completed' ? 'in-progress' : 'completed';
            goal.modifiedAt = new Date().toISOString();
            GoalsApp.saveGoals();
            GoalsApp.render();
        }
    }
};
