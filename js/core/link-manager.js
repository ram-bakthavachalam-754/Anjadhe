/**
 * Link Manager
 * Bidirectional cross-app linking between Focus, Goals, Schedule, and Notes
 */

const LinkManager = {
    _storageKey: 'links',
    _syncing: false,         // re-entrancy guard for hierarchy sync

    /**
     * Load all links from storage
     */
    loadLinks() {
        const data = StorageManager.get(this._storageKey);
        return data?.links || [];
    },

    /**
     * Save links to storage
     */
    saveLinks(links) {
        StorageManager.set(this._storageKey, { links });
    },

    /**
     * Add a link between two items (stored once, queried bidirectionally)
     * Returns the new link or null if duplicate
     */
    addLink(sourceApp, sourceId, targetApp, targetId) {
        const links = this.loadLinks();

        // Check for duplicate (either direction)
        const exists = links.some(l =>
            (l.sourceApp === sourceApp && l.sourceId === sourceId &&
             l.targetApp === targetApp && l.targetId === targetId) ||
            (l.sourceApp === targetApp && l.sourceId === targetId &&
             l.targetApp === sourceApp && l.targetId === sourceId)
        );

        if (exists) return null;

        const link = {
            id: UIUtils.generateId(),
            sourceApp,
            sourceId,
            targetApp,
            targetId,
            createdAt: new Date().toISOString()
        };

        links.push(link);
        this.saveLinks(links);
        this._postMutationSync(sourceApp, sourceId, targetApp, targetId);
        return link;
    },

    /**
     * Remove a link between two items (checks both directions)
     */
    removeLink(sourceApp, sourceId, targetApp, targetId) {
        let links = this.loadLinks();
        links = links.filter(l => !(
            (l.sourceApp === sourceApp && l.sourceId === sourceId &&
             l.targetApp === targetApp && l.targetId === targetId) ||
            (l.sourceApp === targetApp && l.sourceId === targetId &&
             l.targetApp === sourceApp && l.targetId === sourceId)
        ));
        this.saveLinks(links);
        this._postMutationSync(sourceApp, sourceId, targetApp, targetId);
    },

    /**
     * Remove a link by its ID
     */
    removeLinkById(linkId) {
        let links = this.loadLinks();
        links = links.filter(l => l.id !== linkId);
        this.saveLinks(links);
    },

    /**
     * Get all linked items for a given item, grouped by target app
     * Returns { goals: [{itemId, linkId}], schedule: [...], ... }
     */
    getLinksFor(app, itemId) {
        const links = this.loadLinks();
        const result = {};

        for (const link of links) {
            let otherApp, otherId;

            if (link.sourceApp === app && link.sourceId === itemId) {
                otherApp = link.targetApp;
                otherId = link.targetId;
            } else if (link.targetApp === app && link.targetId === itemId) {
                otherApp = link.sourceApp;
                otherId = link.sourceId;
            } else {
                continue;
            }

            if (!result[otherApp]) result[otherApp] = [];
            result[otherApp].push({ itemId: otherId, linkId: link.id });
        }

        return result;
    },

    /**
     * Get linked items from a specific target app
     */
    getLinksForApp(app, itemId, targetApp) {
        const grouped = this.getLinksFor(app, itemId);
        return grouped[targetApp] || [];
    },

    /**
     * Get item metadata from its app's storage
     * Returns { title, ...appSpecificFields } or null if not found
     */
    getItemMeta(app, itemId) {
        switch (app) {
            case 'focus': {
                const data = StorageManager.get('focus');
                const item = (data?.focusItems || []).find(f => f.id === itemId);
                if (!item) return null;
                return { title: item.title, color: item.color, description: item.description };
            }
            case 'goals': {
                const data = StorageManager.get('goals');
                const item = (data?.goals || []).find(g => g.id === itemId);
                if (!item) return null;
                return { title: item.title, status: item.status, type: item.type };
            }
            case 'schedule': {
                const data = StorageManager.get('schedule');
                const item = (data?.scheduleItems || []).find(s => s.id === itemId);
                if (!item) return null;
                return { title: item.title, startTime: item.startTime, endTime: item.endTime, scheduledDate: item.scheduledDate, lastCompletedDate: item.lastCompletedDate, repeat: item.repeat, dayOfWeek: item.dayOfWeek, repeatDays: item.repeatDays, history: item.history };
            }
            case 'notes': {
                const data = StorageManager.get('notes');
                const item = (data?.notes || []).find(n => n.id === itemId);
                if (!item) return null;
                return { title: item.title, tags: item.tags, pinned: item.pinned };
            }
            case 'bookmarks': {
                const data = StorageManager.get('bookmarks');
                const item = (data?.bookmarks || []).find(b => b.id === itemId);
                if (!item) return null;
                return { title: item.title, url: item.url, group: item.group };
            }
            case 'portfolio': {
                // 'overview' is a pseudo-item for the portfolio as a whole,
                // so a strategy note can attach to the overview rather than
                // one account. It always exists — never treat it as stale.
                if (itemId === 'overview') return { title: 'Portfolio', overview: true };
                const data = StorageManager.get('portfolio');
                const item = (data?.accounts || []).find(a => a.id === itemId);
                if (!item) return null;
                return { title: item.name, type: item.type };
            }
            default:
                return null;
        }
    },

    /**
     * Check if an item exists in its app's storage
     */
    itemExists(app, itemId) {
        return this.getItemMeta(app, itemId) !== null;
    },

    /**
     * Resolve all links for an item — returns enriched objects with metadata
     * Filters out stale links automatically
     */
    resolveLinks(app, itemId) {
        const grouped = this.getLinksFor(app, itemId);
        const resolved = {};
        let hasStale = false;

        for (const [targetApp, links] of Object.entries(grouped)) {
            resolved[targetApp] = [];
            for (const link of links) {
                const meta = this.getItemMeta(targetApp, link.itemId);
                if (meta) {
                    resolved[targetApp].push({
                        app: targetApp,
                        itemId: link.itemId,
                        linkId: link.linkId,
                        ...meta
                    });
                } else {
                    // Stale link — target was deleted
                    this.removeLinkById(link.linkId);
                    hasStale = true;
                }
            }
        }

        return resolved;
    },

    /**
     * Count the cross-app children that block deletion of this item.
     * Focus parents block on linked goals; goal parents block on
     * linked schedule items; schedule items are leaves (no children).
     *
     * Same-app parent/child (focus sub-items via parentId) is not
     * tracked here — the caller (FocusApp) owns that check.
     */
    countLinkedChildren(app, itemId) {
        if (app === 'focus') {
            return { goals: this.getLinksForApp('focus', itemId, 'goals').length };
        }
        if (app === 'goals') {
            return { tasks: this.getLinksForApp('goals', itemId, 'schedule').length };
        }
        return {};
    },

    /**
     * Throw CHILD_RECORDS_EXIST if this item has linked children that
     * would be orphaned by deletion. Callers catch and surface the
     * counts to the user so they can remove children first. Strict
     * parent-child model: no cascade, no silent data loss.
     */
    assertNoLinkedChildren(app, itemId) {
        const counts = this.countLinkedChildren(app, itemId);
        const blocking = Object.entries(counts).filter(([, n]) => n > 0);
        if (blocking.length === 0) return;
        const err = new Error(
            `Cannot delete ${app}:${itemId} — ${blocking.map(([k, n]) => `${n} ${k}`).join(', ')} still linked`
        );
        err.code = 'CHILD_RECORDS_EXIST';
        err.counts = counts;
        throw err;
    },

    /**
     * Remove all links for a given item (called when item is deleted)
     */
    removeAllLinksForItem(app, itemId) {
        let links = this.loadLinks();
        links = links.filter(l => !(
            (l.sourceApp === app && l.sourceId === itemId) ||
            (l.targetApp === app && l.targetId === itemId)
        ));
        this.saveLinks(links);
    },

    /**
     * Clean up stale links where either side no longer exists
     */
    cleanupStaleLinks() {
        const links = this.loadLinks();
        const valid = links.filter(l =>
            this.itemExists(l.sourceApp, l.sourceId) &&
            this.itemExists(l.targetApp, l.targetId)
        );
        if (valid.length !== links.length) {
            this.saveLinks(valid);
        }
    },

    // --- Hierarchy sync ---
    //
    // When a task is created from a focus area's goal, the schedule app
    // denormalizes the relationship: it adds BOTH a goal→task link AND a
    // focus→task link. That denormalization is convenient for queries
    // (the focus view can list its tasks directly) but it means the
    // focus→task link can drift from reality if the goal later moves to
    // a different focus area.
    //
    // The invariant we want to maintain: a task's focus links should
    // equal the union of focus areas of its goals. The helpers below
    // restore that invariant after any goal↔focus or goal↔task mutation.

    /**
     * Re-derive a single task's focus links from its goals.
     * No-op if the task has no goal links — in that case the focus
     * link was set directly by the user, not inherited, and we leave
     * it alone.
     */
    syncTaskFocusLinks(taskId) {
        const taskGoals = this.getLinksForApp('schedule', taskId, 'goals');
        if (taskGoals.length === 0) return;

        const desired = new Set();
        for (const g of taskGoals) {
            const focusLinks = this.getLinksForApp('goals', g.itemId, 'focus');
            focusLinks.forEach(fl => desired.add(fl.itemId));
        }

        const currentLinks = this.getLinksForApp('schedule', taskId, 'focus');
        const current = new Set(currentLinks.map(l => l.itemId));

        for (const focusId of current) {
            if (!desired.has(focusId)) {
                this.removeLink('schedule', taskId, 'focus', focusId);
            }
        }
        for (const focusId of desired) {
            if (!current.has(focusId)) {
                this.addLink('schedule', taskId, 'focus', focusId);
            }
        }
    },

    /**
     * Re-derive focus links for every task linked to the given goal.
     */
    syncTaskFocusLinksForGoal(goalId) {
        const taskLinks = this.getLinksForApp('goals', goalId, 'schedule');
        for (const t of taskLinks) {
            this.syncTaskFocusLinks(t.itemId);
        }
    },

    /**
     * One-shot repair pass for existing data. Runs at startup so installs
     * that were affected by the pre-fix bug heal themselves on next launch.
     * Only touches tasks that have at least one goal link, so directly
     * user-managed task→focus links are preserved.
     */
    repairFocusInheritance() {
        const links = this.loadLinks();
        const taskIds = new Set();
        for (const l of links) {
            if (l.sourceApp === 'schedule' && l.targetApp === 'goals') taskIds.add(l.sourceId);
            if (l.targetApp === 'schedule' && l.sourceApp === 'goals') taskIds.add(l.targetId);
        }
        this._syncing = true;
        try {
            for (const taskId of taskIds) this.syncTaskFocusLinks(taskId);
        } finally {
            this._syncing = false;
        }
    },

    /**
     * Hook called after addLink/removeLink. Detects mutations that affect
     * the focus → goal → task hierarchy and re-derives downstream links.
     * Re-entrancy is blocked by the _syncing flag.
     */
    _postMutationSync(sourceApp, sourceId, targetApp, targetId) {
        if (this._syncing) return;
        const isPair = (a, b) =>
            (sourceApp === a && targetApp === b) ||
            (sourceApp === b && targetApp === a);

        this._syncing = true;
        try {
            // Goal-focus link change → re-sync focus links for all the goal's tasks.
            if (isPair('goals', 'focus')) {
                const goalId = sourceApp === 'goals' ? sourceId : targetId;
                this.syncTaskFocusLinksForGoal(goalId);
            }
            // Goal-task link change → re-sync focus links for that task.
            if (isPair('goals', 'schedule')) {
                const taskId = sourceApp === 'schedule' ? sourceId : targetId;
                this.syncTaskFocusLinks(taskId);
            }
        } finally {
            this._syncing = false;
        }
    },

    // --- Hierarchy helpers ---

    /**
     * Get the first linked focus area for an item (goal or task)
     * @returns {Object|null} { title, color, itemId } or null
     */
    getFocusForItem(app, itemId) {
        const links = this.getLinksForApp(app, itemId, 'focus');
        if (links.length === 0) return null;
        const meta = this.getItemMeta('focus', links[0].itemId);
        if (!meta) return null;
        return { title: meta.title, color: meta.color, itemId: links[0].itemId };
    },

    /**
     * Set an item's focus area — focus is a single value, not a list.
     * Removes any existing focus links, then adds the new one (pass a
     * falsy focusId to just clear). Every write path for goal→focus goes
     * through here so a goal can never accumulate multiple areas.
     */
    setFocusForItem(app, itemId, focusId) {
        for (const link of this.getLinksForApp(app, itemId, 'focus')) {
            this.removeLink(app, itemId, 'focus', link.itemId);
        }
        if (focusId) this.addLink(app, itemId, 'focus', focusId);
    },

    /**
     * Get the first linked goal for a schedule/task item
     * @returns {Object|null} { title, status, type, completed, itemId } or null
     */
    getGoalForTask(taskId) {
        const links = this.getLinksForApp('schedule', taskId, 'goals');
        if (links.length === 0) return null;
        const meta = this.getItemMeta('goals', links[0].itemId);
        if (!meta) return null;
        return { ...meta, itemId: links[0].itemId };
    },

    /**
     * Get all goals linked to a focus area, resolved with metadata
     * @returns {Array} [{ title, status, type, itemId, linkId }]
     */
    getGoalsForFocus(focusId) {
        const links = this.getLinksForApp('focus', focusId, 'goals');
        const results = [];
        for (const link of links) {
            const meta = this.getItemMeta('goals', link.itemId);
            if (meta) {
                results.push({ ...meta, itemId: link.itemId, linkId: link.linkId });
            }
        }
        // Sort: in-progress first, then not-started, no-progress, need-help, completed last
        const statusOrder = { 'in-progress': 0, 'not-started': 1, 'no-progress': 2, 'need-help': 3 };
        results.sort((a, b) => {
            const aDone = a.status === 'completed', bDone = b.status === 'completed';
            if (aDone && !bDone) return 1;
            if (!aDone && bDone) return -1;
            const sa = statusOrder[a.status || 'not-started'] ?? 4;
            const sb = statusOrder[b.status || 'not-started'] ?? 4;
            return sa - sb;
        });
        return results;
    },

    /**
     * Get all tasks linked to a goal, resolved with metadata
     * @returns {Array} [{ title, startTime, endTime, scheduledDate, lastCompletedDate, repeat, itemId, linkId }]
     */
    getTasksForGoal(goalId) {
        const links = this.getLinksForApp('goals', goalId, 'schedule');
        const results = [];
        for (const link of links) {
            const meta = this.getItemMeta('schedule', link.itemId);
            if (meta) {
                results.push({ ...meta, itemId: link.itemId, linkId: link.linkId });
            }
        }
        // Sort by start time
        results.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
        return results;
    },

    /**
     * Get task completion counts for a goal
     * @returns {{ total: number, completed: number }}
     */
    getTaskCountForGoal(goalId) {
        const tasks = this.getTasksForGoal(goalId);
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        let completed = 0;
        for (const t of tasks) {
            const h = (t.history && typeof t.history === 'object') ? t.history : {};
            const repeating = t.repeat && t.repeat !== 'none';
            if (t.lastCompletedDate === todayStr) completed++;
            else if (!repeating && t.lastCompletedDate) completed++;
            // Abandoned resolves like completing (repeating: today only)
            else if (repeating ? h[todayStr] === 'abandoned' : Object.values(h).includes('abandoned')) completed++;
        }
        return { total: tasks.length, completed };
    },

    /**
     * Get all items from a specific app (for picker)
     */
    getAppItems(app) {
        const pf = (items) => ProfileManager.filterByActiveProfile(items);
        switch (app) {
            case 'focus': {
                const data = StorageManager.get('focus');
                return pf(data?.focusItems || []).map(f => ({
                    id: f.id, title: f.title, color: f.color, description: f.description
                }));
            }
            case 'goals': {
                const data = StorageManager.get('goals');
                return pf(data?.goals || []).filter(g => g.status !== 'completed').map(g => ({
                    id: g.id, title: g.title, status: g.status, type: g.type
                }));
            }
            case 'schedule': {
                const data = StorageManager.get('schedule');
                return pf(data?.scheduleItems || []).map(s => ({
                    id: s.id, title: s.title, startTime: s.startTime, endTime: s.endTime, repeat: s.repeat
                }));
            }
            case 'notes': {
                const data = StorageManager.get('notes');
                return pf(data?.notes || []).map(n => ({
                    id: n.id, title: n.title, tags: n.tags, pinned: n.pinned
                }));
            }
            case 'bookmarks': {
                const data = StorageManager.get('bookmarks');
                return pf(data?.bookmarks || []).map(b => ({
                    id: b.id, title: b.title, url: b.url, group: b.group
                }));
            }
            case 'portfolio': {
                const data = StorageManager.get('portfolio');
                const accounts = pf(data?.accounts || []).map(a => ({
                    id: a.id, title: a.name, type: a.type
                }));
                return [{ id: 'overview', title: 'Portfolio (all accounts)' }, ...accounts];
            }
            default:
                return [];
        }
    }
};
