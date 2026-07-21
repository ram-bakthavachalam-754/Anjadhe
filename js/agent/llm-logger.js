/**
 * LLM Logger - Single layer for all AI calls
 * Routes through the unified electronLLM.chat provider and logs every call
 */

const LLMLogger = {
    logs: [],
    maxLogs: 100,
    _storageKey: 'llm-logs',
    _persistTimer: null,

    /**
     * Load persisted logs from storage on startup
     */
    loadFromStorage() {
        try {
            const saved = StorageManager.get(this._storageKey);
            if (Array.isArray(saved)) {
                this.logs = saved.slice(0, this.maxLogs);
            }
        } catch (e) {
            console.warn('Failed to load LLM logs from storage:', e);
        }
    },

    /**
     * Persist current logs to storage
     */
    _persist() {
        try {
            const toSave = this.logs.map(({ startTime, ...rest }) => rest);
            StorageManager.set(this._storageKey, toSave);
        } catch (e) {
            console.warn('Failed to persist LLM logs:', e);
        }
    },

    /**
     * Pull ONE JSON object out of model prose. Small/self-hosted models wrap
     * JSON in markdown fences, preambles ("Sure! Here is..."), or trailing
     * commentary — a bare `content.match(/\{[\s\S]*\}/)` + JSON.parse dies on
     * any of it, and several background classifiers (email bundles, action
     * filing) depend on surviving that. Strategy, cheapest first:
     *   1. direct parse of the trimmed content,
     *   2. parse the fenced block if there is one,
     *   3. balanced-brace scan from the first '{' (ignores trailing prose).
     * Returns the parsed object or null — never throws.
     */
    extractJsonObject(content) {
        const text = String(content || '').trim();
        if (!text) return null;
        const tryParse = (s) => {
            try { const v = JSON.parse(s); return (v && typeof v === 'object') ? v : null; }
            catch { return null; }
        };

        let v = tryParse(text);
        if (v) return v;

        const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fence) {
            v = tryParse(fence[1].trim());
            if (v) return v;
        }

        const start = text.indexOf('{');
        if (start === -1) return null;
        let depth = 0, inStr = false, esc = false;
        for (let i = start; i < text.length; i++) {
            const c = text[i];
            if (esc) { esc = false; continue; }
            if (c === '\\') { esc = true; continue; }
            if (c === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (c === '{') depth++;
            else if (c === '}') {
                depth--;
                if (depth === 0) return tryParse(text.slice(start, i + 1));
            }
        }
        return null;
    },

    /**
     * Send a chat request through the unified LLM provider and log it.
     * This is the ONLY way AI calls should be made from the renderer.
     *
     * @param {string} source - Caller identifier ('agent', 'email', etc.)
     * @param {Object} params - Chat params (model, messages, tools, stream, options)
     * @returns {Object} The LLM response (Ollama-style shape: message, eval counts)
     */
    async call(source, params) {
        const entry = {
            id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
            source,
            timestamp: new Date().toISOString(),
            model: params.model || '(auto)',
            messageCount: params.messages?.length || 0,
            systemPrompt: this.extractSystemPrompt(params.messages),
            userPrompt: this.extractLastUserMessage(params.messages),
            toolCount: params.tools?.length || 0,
            temperature: params.options?.temperature,
            requestChars: JSON.stringify(params.messages).length,
            requestMessages: this.summarizeMessages(params.messages),
            startTime: performance.now(),
            durationMs: null,
            response: null,
            responseChars: null,
            toolCalls: null,
            error: null,
            provider: null,
            promptTokens: null,
            completionTokens: null,
            totalTokens: null
        };

        // Thread the source tag + this entry's id down to main so the AI
        // Activity feed can label the request and link its row to this log.
        // (activityTag, not logTag — logTag also opts into main's verbose
        // terminal tracing, which stays per-caller.)
        params.activityTag = params.logTag || source;
        params.activityId = entry.id;

        try {
            const response = await window.electronLLM.chat(params);
            entry.durationMs = Math.round(performance.now() - entry.startTime);

            if (response.error) {
                entry.error = response.error;
            } else {
                const msg = response.message;
                entry.response = msg?.content || null;
                entry.responseChars = entry.response?.length || 0;
                entry.toolCalls = msg?.tool_calls?.map(tc => ({
                    name: tc.function?.name,
                    args: tc.function?.arguments
                })) || null;

                // Token counts — Ollama format
                if (response.prompt_eval_count != null) entry.promptTokens = response.prompt_eval_count;
                if (response.eval_count != null) entry.completionTokens = response.eval_count;
                // Token counts — usage format (OpenAI-compatible servers)
                if (response.usage) {
                    entry.promptTokens = response.usage.input_tokens || entry.promptTokens;
                    entry.completionTokens = response.usage.output_tokens || entry.completionTokens;
                }
                if (entry.promptTokens != null || entry.completionTokens != null) {
                    entry.totalTokens = (entry.promptTokens || 0) + (entry.completionTokens || 0);
                }

                // Actual model and provider from the response
                if (response.model) entry.model = response.model;
                if (response.provider) entry.provider = response.provider;
            }

            this.addEntry(entry);
            return response;
        } catch (e) {
            entry.durationMs = Math.round(performance.now() - entry.startTime);
            entry.error = e.message || 'Unknown error';
            this.addEntry(entry);
            throw e;
        }
    },

    /**
     * Streaming version of call(). Sends chunks to onChunk callback.
     * Returns the final response (same format as call()).
     */
    async callStream(source, params, onChunkCallback) {
        const entry = {
            id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
            source,
            timestamp: new Date().toISOString(),
            model: params.model || '(auto)',
            messageCount: params.messages?.length || 0,
            systemPrompt: this.extractSystemPrompt(params.messages),
            userPrompt: this.extractLastUserMessage(params.messages),
            toolCount: params.tools?.length || 0,
            temperature: params.options?.temperature,
            requestChars: JSON.stringify(params.messages).length,
            requestMessages: this.summarizeMessages(params.messages),
            startTime: performance.now(),
            durationMs: null,
            response: null,
            responseChars: null,
            toolCalls: null,
            error: null,
            provider: null,
            promptTokens: null,
            completionTokens: null,
            totalTokens: null
        };

        // Same tagging as call() — see comment there.
        params.activityTag = params.logTag || source;
        params.activityId = entry.id;

        try {
            const response = await window.electronLLM.chatStream(params, onChunkCallback);
            entry.durationMs = Math.round(performance.now() - entry.startTime);

            if (response.error) {
                entry.error = response.error;
            } else {
                const msg = response.message;
                entry.response = msg?.content || null;
                entry.responseChars = entry.response?.length || 0;
                entry.toolCalls = msg?.tool_calls?.map(tc => ({
                    name: tc.function?.name,
                    args: tc.function?.arguments
                })) || null;

                if (response.prompt_eval_count != null) entry.promptTokens = response.prompt_eval_count;
                if (response.eval_count != null) entry.completionTokens = response.eval_count;
                if (response.usage) {
                    entry.promptTokens = response.usage.input_tokens || entry.promptTokens;
                    entry.completionTokens = response.usage.output_tokens || entry.completionTokens;
                }
                if (entry.promptTokens != null || entry.completionTokens != null) {
                    entry.totalTokens = (entry.promptTokens || 0) + (entry.completionTokens || 0);
                }
                if (response.model) entry.model = response.model;
                if (response.provider) entry.provider = response.provider;
            }

            this.addEntry(entry);
            return response;
        } catch (e) {
            entry.durationMs = Math.round(performance.now() - entry.startTime);
            entry.error = e.message || 'Unknown error';
            this.addEntry(entry);
            throw e;
        }
    },

    // Storage diet for the ring buffer. Entries stored the FULL system
    // prompt, user prompt, response, and tool-call args — 100 entries ran
    // to >1 MB of JSON, re-serialized and written synchronously on every AI
    // call (and re-parsed at every boot). The logs are for inspection, not
    // archival: a few KB of each field tells the story, and the *Chars /
    // *Tokens fields keep the true sizes. Truncation is marked in-place.
    _trim(s, max) {
        if (typeof s !== 'string' || s.length <= max) return s;
        return s.slice(0, max) + `\n… [truncated — ${s.length.toLocaleString()} chars total]`;
    },

    addEntry(entry) {
        entry.systemPrompt = this._trim(entry.systemPrompt, 6000);
        entry.userPrompt = this._trim(entry.userPrompt, 4000);
        entry.response = this._trim(entry.response, 6000);
        if (Array.isArray(entry.toolCalls)) {
            entry.toolCalls = entry.toolCalls.map(tc => ({
                ...tc,
                args: this._trim(typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? null), 2000)
            }));
        }
        this.logs.unshift(entry);
        if (this.logs.length > this.maxLogs) {
            this.logs = this.logs.slice(0, this.maxLogs);
        }
        // Coalesce bursts (an agent tool loop ends several calls per second)
        // into one storage write — same pattern as NetworkLogger/AIActivity.
        if (this._persistTimer) return;
        this._persistTimer = setTimeout(() => {
            this._persistTimer = null;
            this._persist();
        }, 1000);
    },

    extractSystemPrompt(messages) {
        if (!messages) return null;
        const sys = messages.find(m => m.role === 'system');
        return sys?.content || null;
    },

    extractLastUserMessage(messages) {
        if (!messages) return null;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') return messages[i].content;
        }
        return null;
    },

    summarizeMessages(messages) {
        if (!messages) return [];
        return messages.map(m => ({
            role: m.role,
            chars: (m.content || '').length,
            preview: (m.content || '').slice(0, 100) + ((m.content || '').length > 100 ? '...' : ''),
            toolCalls: m.tool_calls?.length || 0
        }));
    },

    clear() {
        this.logs = [];
        this._persist();
    }
};
