/**
 * AgentContext — per-app ambient context for the AI assistant.
 *
 * Each sub-app calls AgentContext.register(appName, providerFn) once. The
 * provider is called every turn the agent runs while the user is viewing
 * that app, and returns a {title, body} block describing what the user is
 * currently looking at (current note, open page, selected task, …) or
 * null if there's nothing salient to inject.
 *
 * Why per-turn (not on conversation start): apps' "current item" changes
 * mid-conversation — the user can navigate to a different page in Browse,
 * open a different note, scroll to another email — and we want the next
 * agent reply to reflect that without forcing a new conversation.
 *
 * Why one provider per app (not per item): the active app already
 * disambiguates which provider to run — AppManager.currentApp gives us
 * that for free. Sub-apps that have multiple "items" (a note vs a journal
 * entry) just look at their own internal state to decide what to expose.
 *
 * Errors thrown by a provider are swallowed, not propagated — a buggy
 * provider must never break agent send. Worst case is a missing context
 * block for one turn.
 */

const AgentContext = {
    _providers: new Map(),

    /**
     * Register a context provider for an app.
     * @param {string} appName  Must match the slug used in AppManager.register.
     * @param {() => ({title: string, body: string} | null)} providerFn
     */
    register(appName, providerFn) {
        if (typeof providerFn !== 'function') return;
        this._providers.set(appName, providerFn);
    },

    /**
     * Resolve the active app's context block. Reads AppManager.currentApp;
     * returns null when no app is active, no provider is registered, or
     * the provider returns null.
     * Providers may optionally include `suggestedPrompts: string[]` —
     * short questions/instructions surfaced as quick-start buttons in
     * the agent panel when a fresh conversation is opened.
     * Providers viewing a single record (a goal, a task, a note) may also
     * include `recordKey: string` — a stable identifier for that record
     * (e.g. "goals:goal_123"). When present, opening the assistant over the
     * record reattaches to the conversation last held about it (see
     * AgentService.openConversationForRecord).
     * @returns {{title: string, body: string, suggestedPrompts?: string[], recordKey?: string} | null}
     */
    getActiveBlock() {
        const app = (typeof AppManager !== 'undefined') ? AppManager.currentApp : null;
        if (!app) return null;
        const provider = this._providers.get(app);
        if (!provider) return null;
        try {
            const result = provider();
            if (!result || typeof result !== 'object') return null;
            if (!result.title || !result.body) return null;
            const out = { title: String(result.title), body: String(result.body) };
            if (Array.isArray(result.suggestedPrompts)) {
                out.suggestedPrompts = result.suggestedPrompts
                    .filter(p => typeof p === 'string' && p.trim())
                    .slice(0, 6);
            }
            if (typeof result.recordKey === 'string' && result.recordKey.trim()) {
                out.recordKey = result.recordKey.trim();
                // A short human label for the record (its title/name), used to
                // show "what this chat is about" in the assistant's history.
                if (typeof result.recordLabel === 'string' && result.recordLabel.trim()) {
                    out.recordLabel = result.recordLabel.trim();
                }
            }
            return out;
        } catch (e) {
            console.warn(`[agent-context] provider for "${app}" threw:`, e);
            return null;
        }
    },

    /**
     * Stable identifier for the record the user is currently viewing, or null
     * when the active app exposes no record (or no provider at all). Used to
     * tie a conversation to the record it's about.
     * @returns {string | null}
     */
    getActiveRecordKey() {
        const block = this.getActiveBlock();
        return (block && block.recordKey) ? block.recordKey : null;
    },

    /**
     * The record the user is currently viewing, as { key, label }, or null.
     * `key` is the stable id (for matching conversations); `label` is a short
     * human name (for display). Used to tag and label conversations.
     * @returns {{key: string, label: string} | null}
     */
    getActiveRecord() {
        const block = this.getActiveBlock();
        if (!block || !block.recordKey) return null;
        return { key: block.recordKey, label: block.recordLabel || '' };
    },

    /**
     * Format the active block as a single string for inclusion in a system
     * message. Returns '' when there's nothing to inject.
     */
    formatActive() {
        const block = this.getActiveBlock();
        if (!block) return '';
        return `${block.title}\n${block.body}`;
    }
};

if (typeof window !== 'undefined') {
    window.AgentContext = AgentContext;
}
