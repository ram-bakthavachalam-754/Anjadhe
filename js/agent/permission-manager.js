/**
 * PermissionManager — graduated consent for assistant tool calls
 * (docs/COWORK_AGENT.md §1, phase C1).
 *
 * Every tool call resolves to one of:
 *   allow — runs silently (reads; in-app writes; anything the user granted)
 *   ask   — confirmation dialog before running
 *   deny  — blocked, with a reason the model can read
 *
 * Resolution order: hard denials → persisted "always" grants → session
 * grants → static ask policy → default allow. Hard denials are the seam for
 * C3's fs-path / shell-command scopes — today no tool class produces one,
 * but the ordering (deny beats any grant) is load-bearing: a grant must
 * never override a scope violation.
 *
 * Grants:
 *   once    — approve this one call (nothing stored)
 *   session — skip the dialog for this tool until the app restarts
 *   always  — persisted on THIS Mac (machine-local settingsStore via IPC —
 *             grants will reference machine paths in C3, so they must not
 *             sync). Revocable in Settings → AI → Assistant Permissions.
 *
 * Every ask outcome and every grant/revoke is appended to a capped decision
 * log (also machine-local) so "what did I allow, when?" is answerable.
 */

const PermissionManager = {
    /**
     * Static ask policy: tools whose effects are irreversible, externally
     * visible, financial, or modify files. Any `delete_*` tool is also
     * gated by prefix, so new delete tools are safe by default. This was
     * AgentService.CONFIRM_TOOLS before C1.
     */
    ASK_TOOLS: new Set([
        'send_email', 'trash_email',
        'create_calendar_event', 'update_calendar_event',
        'add_transaction', 'update_cash',
        // Build tools write files (~/Anjadhe/apps, ~/Anjadhe/artifacts) and
        // hold the model busy for minutes — always worth an explicit go-ahead.
        'create_app', 'edit_app', 'create_artifact', 'edit_artifact',
        // Deleting (even to the recoverable Trash) never rides a folder
        // grant silently — same rule as in-app delete_*. fs_trash resolves
        // scope in main first (hard denies, folder grants), THEN lands here
        // for its own consent unless the tool itself was session/always
        // granted (see AgentService._resolvePermission).
        'fs_trash'
    ]),

    _sessionGrants: new Set(),  // tool names; dies with the app (safety default is sticky)
    _grants: [],                // persisted: [{ id, tool, createdAt }]
    _readyPromise: null,

    /**
     * Load persisted grants. Called lazily by ready(); safe to call again
     * (e.g. after Settings revokes) to refresh the cache.
     */
    async _load() {
        try {
            const grants = await window.electronPermissions?.getGrants?.();
            this._grants = Array.isArray(grants) ? grants : [];
        } catch {
            this._grants = [];
        }
    },

    ready() {
        if (!this._readyPromise) this._readyPromise = this._load();
        return this._readyPromise;
    },

    /**
     * Decide what happens to a tool call. Synchronous — callers await
     * ready() once before their tool loop. `args` is unused today; C3's
     * fs/shell scopes will inspect it (paths, commands) for hard denials.
     * @returns {{decision: 'allow'|'ask'|'deny', via?: string, reason?: string}}
     */
    resolve(toolName, args) {  // eslint-disable-line no-unused-vars
        // 1. Hard denials — none yet; fs-path / shell-command scopes land
        //    here in C3, BEFORE any grant is consulted.
        // 2. Persisted grants.
        if (this._grants.some(g => g && g.tool === toolName)) {
            return { decision: 'allow', via: 'always' };
        }
        // 3. Session grants.
        if (this._sessionGrants.has(toolName)) {
            return { decision: 'allow', via: 'session' };
        }
        // 4. MCP tools (C2): external servers default to ask. A per-server
        //    trust grant ('mcp:<server>', created in Settings or via the
        //    dialog) covers every tool that server exposes; a per-tool
        //    always/session grant (steps 2–3 above) covers just the one.
        if (/^mcp_/.test(toolName)) {
            // continue_output is our own paging over output ALREADY fetched
            // (and already approved) — asking again would put a prompt
            // between every page of one result.
            if (/_continue_output$/.test(toolName)) {
                return { decision: 'allow', via: 'default' };
            }
            const meta = (typeof AgentTools !== 'undefined' && AgentTools._dynamicTools?.[toolName]) || null;
            const source = meta?.source || null;
            if (source && this._grants.some(g => g && g.tool === source)) {
                // A per-server trust grant covers this server's tools — EXCEPT
                // ones the server flags destructive, which always re-ask so a
                // single "trust this server" can't silently authorize a
                // delete/overwrite (or a destructive tool added later). Note:
                // the flag is a server-supplied hint, so this narrows
                // convenience, not a boundary against a lying server (M8).
                if (meta && meta.destructive) return { decision: 'ask' };
                return { decision: 'allow', via: 'server-trust' };
            }
            return { decision: 'ask' };
        }
        // 5. Static policy.
        if (this.ASK_TOOLS.has(toolName) || /^delete_/.test(toolName)) {
            return { decision: 'ask' };
        }
        // 6. Default: reads and in-app writes run silently (today's behavior).
        return { decision: 'allow', via: 'default' };
    },

    /**
     * Scoped tools (C3): fs/shell calls carry a path or command, so their
     * decision depends on the argument, not just the tool name — and the
     * real gate lives in the MAIN process (the renderer isn't a hard
     * boundary). These helpers drive the pre-flight + grant UX; main
     * re-checks at execution time.
     */
    SCOPED_TOOLS: new Set(['fs_list', 'fs_read', 'fs_search', 'fs_write', 'fs_mkdir', 'fs_trash', 'fs_move', 'run_command']),

    isScopedTool(toolName) {
        return this.SCOPED_TOOLS.has(toolName);
    },

    /**
     * Pre-flight a scoped call. Returns main's verdict plus what a grant
     * should cover: { decision, reason?, grantClass?, suggestedScope?, display? }.
     */
    async checkScoped(toolName, args) {
        if (!window.electronPermissions?.check) return { decision: 'deny', reason: 'permission IPC unavailable' };
        try {
            return await window.electronPermissions.check({
                tool: toolName,
                path: args?.path,
                from: args?.from,
                to: args?.to,
                command: args?.command
            });
        } catch (e) {
            return { decision: 'deny', reason: e.message };
        }
    },

    /**
     * Record an approved scoped grant with main (which enforces it):
     * duration 'once' | 'session' | 'always'.
     */
    async grantScoped(grantClass, scope, duration) {
        try {
            await window.electronPermissions?.grant?.({ cls: grantClass, scope, duration });
            this._log(`grant-${duration}`, `${grantClass} ${scope}`);
            if (duration === 'always') await this._load();  // refresh cache for Settings
        } catch (e) {
            console.error('[permissions] scoped grant failed:', e);
        }
    },

    /**
     * Is this exact key covered by a persisted or session grant? Used by
     * the C2 egress gate, whose keys are origin-scoped ('read_url:<origin>')
     * rather than plain tool names — resolve() would default-allow them.
     */
    hasGrant(key) {
        return this._grants.some(g => g && g.tool === key) || this._sessionGrants.has(key);
    },

    grantSession(toolName) {
        this._sessionGrants.add(toolName);
        this._log('grant-session', toolName);
    },

    async grantAlways(toolName) {
        if (this._grants.some(g => g && g.tool === toolName)) return;
        this._grants.push({
            id: 'perm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            tool: toolName,
            createdAt: new Date().toISOString()
        });
        await this._save();
        this._log('grant-always', toolName);
    },

    async revoke(id) {
        const grant = this._grants.find(g => g && g.id === id);
        this._grants = this._grants.filter(g => g && g.id !== id);
        await this._save();
        if (grant) this._log('revoke', grant.tool);
        return !!grant;
    },

    listGrants() {
        return this._grants.slice();
    },

    async _save() {
        try { await window.electronPermissions?.setGrants?.(this._grants); } catch (e) {
            console.error('[permissions] save failed:', e);
        }
    },

    /**
     * Record an ask outcome ('approved-once' | 'approved-session' |
     * 'approved-always' | 'denied') — grant/revoke events log themselves.
     */
    recordDecision(outcome, toolName) {
        this._log(outcome, toolName);
    },

    _log(event, tool) {
        // Fire-and-forget append to the machine-local capped log.
        try { window.electronPermissions?.appendLog?.({ at: new Date().toISOString(), event, tool }); } catch {}
    },

    async getLog() {
        try {
            const log = await window.electronPermissions?.getLog?.();
            return Array.isArray(log) ? log : [];
        } catch { return []; }
    }
};

if (typeof window !== 'undefined') {
    window.PermissionManager = PermissionManager;
}
