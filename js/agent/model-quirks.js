/**
 * Model Quirks — documented workarounds for known small-model failure modes.
 *
 * The agent loop targets a wide range of local models (Gemma 3n / Gemma 4
 * variants, Qwen, Llama-family, etc.).
 * Smaller local models intermittently regress on two specific failure modes
 * that we recover from here rather than letting the user see a broken UI:
 *
 *   1. "Tool announcement without a tool call" — the model emits a plain-text
 *      "let me check that" / "I'll search now" and stops, never invoking the
 *      structured tool. Observed reliably on Gemma 3n E2B under context
 *      pressure; also seen sporadically on other ≤4B-parameter local models.
 *
 *   2. "Non-answer after a tool result" — the model successfully calls a tool
 *      and receives data back, then replies with a contentless greeting or
 *      offer-of-help instead of answering ("Hi! How can I help you today?").
 *      Most reproducible on the PDF-chat path with small local models.
 *
 * Both checks are intentionally narrow:
 *   - bounded by length so a substantive answer that happens to start
 *     "Hello — here's the summary" is not mis-classified;
 *   - bounded to English phrasing because that's what the targeted models
 *     emit in this failure mode (a Spanish-language regression would not
 *     trigger the recovery; that's the explicit trade-off);
 *   - consulted only at decision points where there is no other signal
 *     (no tool_calls, or tool ran but content is empty/short).
 *
 * Why this lives in its own file: surfacing model-specific heuristics in
 * their own module is more honest than burying them as private methods in
 * the main service. A reader can see exactly what shims are in play and
 * what they trigger on, and the agent loop reads as a clean control flow
 * with named, narrow guards rather than ad-hoc regex sprinkled inline.
 *
 * Sibling: main.js holds `MODELS_THAT_NEED_THINK_OFF_FOR_TOOLS` for the
 * Ollama-side "disable thinking mode for tool use on these models" quirk
 * — same category, kept in main because that's where the request is built.
 */

const ModelQuirks = {
    /**
     * Does a final assistant message look like a tool-use announcement that
     * the model never followed through on?
     *
     * Triggers only on short responses (under 220 chars) matching a "let me
     * check / I'll search / one moment" pattern. Long responses with
     * substantive content beyond an "I'll" are real answers.
     */
    looksLikeToolAnnouncement(content) {
        if (!content) return false;
        if (content.length > 220) return false;
        const lower = content.toLowerCase();
        const patterns = [
            /\b(let me|i'?ll|i will|i'?m going to|going to|i need to|i'?ll need to)\s+(check|search|look|find|see|pull|grab|get|fetch|verify|confirm|look up|look that up|look this up|figure out|work out)\b/,
            /\b(checking|searching|looking|fetching|pulling|verifying)\s+(it|that|this|now|on it|right now)\b/,
            /\b(one (moment|sec|second)|hold on|hang on|just a (moment|sec|second))\b/,
            /\bi'?ll get back to you\b/,
        ];
        return patterns.some(p => p.test(lower));
    },

    /**
     * A "hanging build promise": the model narrates an imminent app/artifact
     * build — "Let me rebuild it from scratch… This should take a minute." —
     * and ends the turn without calling create_app/edit_app. Longer than the
     * generic announcement cap (these messages carry a paragraph of
     * explanation first), so it keys on BOTH a promise verb AND an
     * imminence tail; either alone is a legitimate answer. Observed live on
     * qwen3.6/gemma with the coffee-tracker autofill loop.
     */
    looksLikeUnfulfilledBuildPromise(content) {
        if (!content || content.length > 700) return false;
        const lower = content.toLowerCase();
        const promise = /\b(let me|i'?ll|i will|i'?m going to|going to|now i'?ll)\s+(rebuild|re-?create|rewrite|build|create|update|edit|fix|change|modify|redo)\b/.test(lower);
        const imminent = /\b(should (only )?take (a|about|around|just)?\s*(minute|moment|few)|starting now|building now|rebuilding now|hang tight|give me a (minute|moment|sec)|be right back|one (minute|moment))\b/.test(lower);
        return promise && imminent;
    },

    /**
     * BUILDER variant: does a final assistant message ANNOUNCE writing a file
     * ("Now I'll write app.js", "Here's the manifest:") without emitting the
     * actual write_file / finish tool call? Small local models (Gemma-class)
     * do this under App Studio's code-builder path, where the assistant's
     * check/search verbs don't apply. Kept separate so the assistant's detector
     * isn't broadened (a chat "I'll write a poem" must not trigger). Builder-only,
     * so a false positive costs only one bounded re-prompt.
     */
    looksLikeBuilderToolAnnouncement(content) {
        if (!content) return false;
        if (content.length > 320) return false;
        const lower = content.toLowerCase();
        const patterns = [
            /\b(let me|i'?ll|i will|i'?m going to|going to|now i'?ll|next i'?ll|first i'?ll|i need to|i'?ll now)\s+(write|create|add|update|make|build|implement|start|generate|set up|put together|code|define|scaffold)\b/,
            /\b(writing|creating|adding|updating|building|implementing|generating|coding|scaffolding)\s+(the |a |an |your |this )?(manifest|app\.js|app\.css|spec|css|html|js|file|files|code|app|it|that|now)\b/,
            /\bhere('?s| is)\s+(the |your |a |an )?(manifest|spec|code|app|css|js|html|file|files)\b/,
            /\b(let'?s|i'?ll|i will|i'?m going to|going to)\s+(get )?start(ed)?\b/,
        ];
        return patterns.some(p => p.test(lower));
    },

    /**
     * A past-tense WRITE claim with no write behind it: the final message
     * says "I've created the tasks / your note has been saved" but no
     * successful non-read tool ran this turn. Distinct from
     * looksLikeToolAnnouncement (future tense, pre-tool): here the model
     * asserts the work is DONE. Only consulted when zero write tools
     * succeeded this turn, so a recap of work the turn actually did never
     * sees it. References to prior or pre-existing state ("already",
     * "earlier", "previously") are excluded — "continue" turns routinely
     * restate old work in past tense, and that's legitimate.
     */
    looksLikeUnfulfilledWriteClaim(content) {
        if (!content) return false;
        const lower = content.toLowerCase();
        if (/\b(already|earlier|previously|existing|last time)\b/.test(lower)) return false;
        // "I've added the comparison below" is prose about the reply itself.
        if (/\b(added|created|updated|included)\s+(\w+\s+){0,3}(below|above|here)\b/.test(lower)) return false;
        const patterns = [
            /\b(i'?ve|i have|i)\s+(just\s+)?(created|added|updated|saved|scheduled|set up|linked|deleted|removed|archived|sent|completed|marked|booked)\b/,
            /\b(has|have)\s+been\s+(created|added|updated|saved|scheduled|set up|linked|deleted|removed|archived|sent|completed|marked)\b/,
            /\b(is|are)\s+now\s+(created|added|saved|scheduled|set up|linked|in your|on your)\b/,
            /\b(created|added|updated|scheduled)\s+\d+\s+(new\s+)?(task|note|goal|event|entr|item|bookmark|reminder|focus)/,
        ];
        return patterns.some(p => p.test(lower));
    },

    /**
     * After a tool actually ran this turn, did the model reply with a
     * contentless greeting / offer-of-help instead of answering?
     *
     * Distinct from looksLikeToolAnnouncement (a pre-tool "I'll go check"):
     * here the tool DID return and the model still produced filler ("Hello.
     * I'm here to assist with what you need."). Only consulted when a tool
     * ran this turn, so the false-positive risk on a legitimately short
     * answer is low. A reply carrying a [p. N] citation is treated as a
     * real answer.
     */
    looksLikeNonAnswer(content) {
        if (!content) return false;
        if (content.length > 200) return false;
        if (/\[p\.\s*\d+\]/.test(content)) return false;
        const lower = content.toLowerCase().trim();
        const patterns = [
            /^(hi|hello|hey)\b/,
            /\bhow (can|may) i (help|assist)\b/,
            /\b(i'?m|i am) (here|happy|glad) to (help|assist)\b/,
            /\bwhat (can i do for you|do you need|would you like)\b/,
            /\b(let me know|feel free to ask|is there anything)\b/,
        ];
        return patterns.some(p => p.test(lower));
    }
};
