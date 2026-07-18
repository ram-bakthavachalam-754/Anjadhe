/**
 * BuilderService — the App Studio builder agent (docs/PLATFORM.md).
 *
 * Deliberately a SEPARATE assistant from AgentService: its own system prompt,
 * its own toolset, its own sessions. The builder can only touch files inside
 * one app folder (containment enforced in main, not here) and has no tools
 * that read user data — the agent that writes code never reads your data.
 *
 * The loop is provider-agnostic: it runs over electronLLM.chat — local
 * Ollama or the user's own OpenAI-compatible server via providerOverride.
 *
 * Self-correction: every write_file clears the app's .errors.log (main does
 * this); after the model finishes, the service waits for hot reload and
 * reads the log itself — fresh entries go back into the conversation as a
 * fix-it round. The model doesn't need the discipline to check; the loop has it.
 */

const BuilderService = {
    maxIterations: 20,
    maxFixRounds: 3,
    // Code-path recovery for small models that ANNOUNCE a tool ("now I'll write
    // the CSS…") without emitting the call. Bounded so a model that genuinely
    // has nothing left doesn't loop forever.
    maxToolNudges: 4,

    _running: false,

    // Swappable transport so tests (and future SDK backends) can replace the
    // model call without touching the loop. Pass onChunk to stream — used to
    // surface the model's live "thinking" trace in the App Studio log, the
    // same way the AI Assistant shows it. Both paths resolve to the same
    // final { message: { content, tool_calls } } shape.
    _chat(params, onChunk) {
        return onChunk
            ? window.electronLLM.chatStream(params, onChunk)
            : window.electronLLM.chat(params);
    },

    // Build the streaming callback that turns the model's reasoning channel
    // into throttled `thinking` build events. Returns null when the model
    // isn't in think mode, so we stay on the cheaper non-streaming call.
    _thinkingStreamer(model, emit) {
        // Builds always run on the brain (default entry) — its think flag decides.
        const thinking = AgentService.getBrainThink();
        if (!thinking) return null;
        let buf = '';
        let lastAt = 0;
        return (chunk, kind) => {
            if (kind === 'thinking') {
                buf += (chunk || '');
                const now = Date.now();
                if (now - lastAt > 120) { lastAt = now; emit({ type: 'thinking', message: buf }); }
            } else if (kind === 'thinking-done') {
                if (buf) emit({ type: 'thinking', message: buf });
            }
        };
    },

    // Per-app builder memory (apps/<dir>/.builder/history.json) — a capped
    // journal of {userPrompt, assistantSummary} pairs from past builds.
    // The live tool transcript is NOT kept; current file contents in the
    // app folder are the source of truth for the *what*. History gives the
    // model the *why* across sessions.
    async _loadHistory(appId) {
        if (!appId || !window.electronApps?.readHistory) return [];
        try {
            const result = await window.electronApps.readHistory(appId);
            return Array.isArray(result?.entries) ? result.entries : [];
        } catch {
            return [];
        }
    },

    async _appendHistory(appId, userPrompt, assistantSummary) {
        if (!appId || !window.electronApps?.appendHistory) return;
        if (!userPrompt && !assistantSummary) return;
        try {
            await window.electronApps.appendHistory(appId, {
                userPrompt: userPrompt || '',
                assistantSummary: assistantSummary || '',
                timestamp: Date.now()
            });
        } catch {}
    },

    // Render history as compact user/assistant text turns to splice between
    // the system prompt and the live user prompt. Keeps tool payloads out
    // of context — they would dominate the window and add no signal.
    _historyMessages(entries) {
        const out = [];
        for (const e of (entries || [])) {
            if (e?.userPrompt) out.push({ role: 'user', content: e.userPrompt });
            if (e?.assistantSummary) out.push({ role: 'assistant', content: e.assistantSummary });
        }
        return out;
    },

    definitions: [
        { type: 'function', function: {
            name: 'list_apps',
            description: 'List ids of apps that already exist (avoid id collisions).',
            parameters: { type: 'object', properties: {} }
        }},
        { type: 'function', function: {
            name: 'read_schemas',
            description: 'Shapes (never contents) of built-in app data — use when the app should read existing data via anjadhe.readData().',
            parameters: { type: 'object', properties: {} }
        }},
        { type: 'function', function: {
            name: 'read_file',
            description: 'Read a file from the app folder. Returns null content if it does not exist yet.',
            parameters: { type: 'object', properties: {
                file: { type: 'string', enum: ['manifest.json', 'app.js', 'app.css'] }
            }, required: ['file'] }
        }},
        { type: 'function', function: {
            name: 'write_file',
            description: 'Write a file in the app folder. Write manifest.json FIRST — it names the app. For a LONG file (roughly 150+ lines), set partial:true and send the rest in append_file parts — one huge tool call gets truncated at the token limit and the whole call fails. The app hot-reloads after every completed write.',
            parameters: { type: 'object', properties: {
                file: { type: 'string', enum: ['manifest.json', 'app.js', 'app.css'] },
                content: { type: 'string' },
                partial: { type: 'boolean', description: 'true = more parts follow via append_file; the file is validated and saved when the last part (done:true) arrives' }
            }, required: ['file', 'content'] }
        }},
        { type: 'function', function: {
            name: 'append_file',
            description: 'Continue a file started with write_file {partial:true}. Set done:true on the final part — the assembled file is then validated and saved.',
            parameters: { type: 'object', properties: {
                file: { type: 'string', enum: ['manifest.json', 'app.js', 'app.css'] },
                content: { type: 'string' },
                done: { type: 'boolean', description: 'true = this is the last part; validate and save the assembled file' }
            }, required: ['file', 'content'] }
        }},
        { type: 'function', function: {
            name: 'finish',
            description: 'Call when the app is complete. Summarize what was built in one sentence.',
            parameters: { type: 'object', properties: {
                summary: { type: 'string' }
            }, required: ['summary'] }
        }}
    ],

    /**
     * Capability tier follows which backend will actually serve the call.
     * A user-configured OpenAI-compatible server ('custom' — someone hosting
     * a 30B+ on their own box has opted into capability) is the "capable"
     * tier: full component kit + code-builder fallback. Ollama-class local
     * models keep the lean reliability-first path. Callers that don't pass a
     * provider get it resolved from the global LLM setting.
     */
    async _resolveProvider(provider) {
        if (provider) return provider;
        try {
            const s = await window.electronLLM?.getSettings?.();
            if (s?.provider === 'custom') return 'custom';
        } catch { /* fall through to local */ }
        return 'local';
    },

    _isCapable(provider) {
        return provider === 'custom';
    },

    /**
     * Run one build session.
     * @param {object} opts
     *   prompt    — what the user wants built or changed
     *   appId     — optional: edit an existing app instead of creating one
     *   provider  — 'local' | 'remote' | 'custom' | undefined (= resolved
     *               from the global LLM provider setting)
     *   onEvent   — ({type, ...}) progress events for the UI:
     *               status | tool | model | error | done
     */
    async start({ prompt, appId = null, provider, onEvent }) {
        if (this._running) {
            onEvent?.({ type: 'error', message: 'A build is already running.' });
            return { ok: false };
        }
        provider = await this._resolveProvider(provider);
        this._running = true;
        try {
            // Editing an existing app: spec-only apps stay on the spec path;
            // code apps stay on the code path.
            if (appId) {
                const entry = ((await window.electronApps.list()) || []).find(e => e.dir === appId);
                if (entry?.spec) {
                    return await this._runSpec({ prompt, appId, provider, onEvent });
                }
                return await this._run({ prompt, appId, provider, onEvent });
            }

            // New app. Try the SPEC path first for EVERY provider. A spec app
            // is pure JSON that runs on both Mac and the iOS companion; a code
            // app is Mac-only. So a portable, component-built app is the default
            // outcome, and we only drop to code for the genuine long tail. It's
            // also the more reliable path — filling a schema-validated document
            // beats writing correct JS on a small model, and frontier models
            // produce better specs too and know when to escape. The generator
            // bails with { needsCode: true } when the app needs logic Spec can't
            // express, and we fall back to the code builder (which also catches a
            // model that just can't produce a valid spec).
            const specResult = await this._runSpec({ prompt, appId: null, provider, onEvent, allowFallback: true });
            if (specResult.ok) return specResult;

            // A capable brain (a user-hosted OpenAI-compatible server —
            // someone running a 30B+ on their own box has opted into
            // capability) can write real code, so any spec miss (needsCode,
            // validation exhaustion, or bad JSON) falls through to the code
            // builder.
            if (this._isCapable(provider)) {
                if (specResult.needsCode || specResult.fallback || specResult.weakJson) {
                    onEvent?.({ type: 'status', message: 'Switching to the code builder for this one…' });
                    return await this._run({ prompt, appId: null, provider, onEvent });
                }
                return specResult;
            }

            // Local / auto path: do NOT drop to the code builder — it depends on
            // tool-calling that small local models can't do (measured: gemma4:e4b
            // returns empty output there), so it just burns minutes and fails.
            // Give an honest, actionable message instead.
            if (specResult.needsCode) {
                const msg = "This app needs custom code, which the local model can't build reliably. Connect a more capable model on your own server (Settings → AI Assistant) for this one.";
                onEvent?.({ type: 'error', message: msg });
                return { ok: false, error: msg };
            }
            if (specResult.weakJson || specResult.fallback) {
                const detail = (specResult.problems || []).slice(0, 4).join('\n• ');
                const msg = "The local model couldn't settle on a valid app after several tries. Try a simpler description, pick a larger local model, or connect a more capable model on your own server (Settings → AI Assistant)."
                    + (detail ? `\n\nLast issue(s):\n• ${detail}` : '');
                onEvent?.({ type: 'error', message: msg });
                return { ok: false, error: msg };
            }
            return specResult;
        } finally {
            this._running = false;
        }
    },

    /**
     * A conversational turn for an EXISTING app. Instead of every message
     * triggering a build, the agent decides per message to either:
     *   • REPLY — answer a question or brainstorm a numbered list of concrete
     *     improvement ideas (no change made), or
     *   • BUILD — make a specific change, resolving references to earlier ideas
     *     ("do 1 and 3", "the first two") from the conversation.
     * The whole exchange threads through the app's .builder history, so the
     * ideas the agent proposed are in context when the user picks some to build.
     * A brand-new app (no appId) has nothing to discuss yet, so it builds.
     */
    async converse({ prompt, appId = null, provider, onEvent }) {
        const emit = (e) => { try { onEvent?.(e); } catch {} };
        provider = await this._resolveProvider(provider);
        if (!appId) return this.start({ prompt, appId, provider, onEvent });

        emit({ type: 'status', message: 'Thinking…' });
        const entry = ((await window.electronApps.list()) || []).find(e => e.dir === appId);
        const manifest = entry?.manifestRaw || '';
        const specStr = entry?.spec ? JSON.stringify(entry.spec) : '';
        const isCode = !entry?.spec && !!entry;
        const history = await this._loadHistory(appId);
        const errors = await this._readErrors(appId);
        const model = this._model();

        const system = [
            `You are App Studio's collaborator for the app "${entry?.manifest?.name || appId}". You help the user improve THIS app by talking with them.`,
            'Each turn, output ONLY ONE JSON object — pick the action:',
            '{"mode":"reply","text":"<message in GitHub-flavored markdown>"} — to answer a question, brainstorm, or discuss. When asked for ideas/improvements, give a SHORT NUMBERED list (at most ~6) of concrete, specific improvements, each one sentence; prefer ideas this platform can build with its component kit. Do NOT change the app in reply mode.',
            '{"mode":"build","instruction":"<a clear, self-contained instruction for exactly what to change>"} — ONLY when the user clearly wants the app changed NOW. Resolve references to earlier ideas ("do 1 and 3", "the first two", "that one") into a concrete instruction using the conversation above.',
            'Default to "reply" for questions, brainstorming, or anything ambiguous. Use "build" only on a clear directive to change the app now.',
            errors ? `The app is CURRENTLY THROWING these runtime errors — if the user is reporting a problem, this is the cause; offer to fix it (mode:"build") and put the exact fix in the instruction:\n${errors}` : '',
            isCode ? '(This is a code app.)' : '',
            manifest ? `Current manifest:\n${manifest}` : '',
            specStr ? `Current spec:\n${specStr}` : ''
        ].filter(Boolean).join('\n');

        const messages = [
            { role: 'system', content: system },
            ...this._historyMessages(history),
            { role: 'user', content: prompt }
        ];

        let decision = null, raw = '';
        try {
            // No streamer: think is forced off (nothing to stream), and only
            // the non-streaming transport forwards `format` — streaming would
            // silently drop the JSON constraint.
            const resp = await this._chat({
                messages, model, providerOverride: provider, format: 'json', think: false,
                options: { num_predict: 2048 }, maxTokens: 2048, logTag: 'builder-converse'
            });
            if (resp?.error) { emit({ type: 'error', message: resp.error }); return { ok: false, error: resp.error }; }
            raw = resp?.message?.content || '';
            decision = this._parseJsonObject(raw);
        } catch { decision = null; }

        // Only BUILD on an explicit, well-formed build decision — so a question
        // or anything ambiguous is answered, never silently rebuilds the app.
        if (decision && decision.mode === 'build' && typeof decision.instruction === 'string' && decision.instruction.trim()) {
            emit({ type: 'status', message: 'Making the change…' });
            return this.start({ prompt: decision.instruction.trim(), appId, provider, onEvent });
        }

        // Otherwise reply (covers mode:'reply', a missing mode, or stray prose).
        const text = (decision && typeof decision.text === 'string' && decision.text.trim())
            ? decision.text.trim()
            : (raw.trim() || "Sorry, I didn't catch that — could you rephrase, or tell me what to change?");
        emit({ type: 'reply', message: text });
        await this._appendHistory(appId, prompt, text);
        return { ok: true, reply: text, appId };
    },

    /* ----------------------------------------------------------------
     * Spec generation (Phase 3): one bounded JSON document per attempt,
     * checked by AppManifest + AppSpec, with concrete validation errors
     * fed back until it converges or attempts run out. No tools, no
     * open-ended code — this is the reliable path for local models.
     * ---------------------------------------------------------------- */

    // Each retry runs on a FRESH context (base + only the last broken attempt),
    // so more attempts don't accumulate clutter — cheap insurance for weak
    // models that need a few seeds to land valid JSON. See _runSpec.
    // Capped at 3: repair-loop studies consistently find the gains concentrate
    // in the first 2 rounds and drop to single digits by round 3 (arXiv
    // 2604.10508, 2607.05197) — rounds 4-5 mostly burned minutes on a model
    // that wasn't going to converge.
    maxSpecAttempts: 3,

    SPEC_DOC: [
        'Component types for spec.components:',
        '{"type":"paragraph","text":"..."}',
        '{"type":"section","title":"...","components":[...]}',
        '{"type":"divider"}',
        '{"type":"card","title":"...","components":[...]}',
        '{"type":"columns","count":2,"components":[...]}  (2-4 responsive columns; one column on narrow screens)',
        '{"type":"tabs","id":"<optional>","tabs":[{"label":"...","components":[...]}]}  (tabbed panels; the active tab is remembered)',
        '{"type":"summary_grid","items":[{"label":"...","value":"static" | <computed aggregation>}]}',
        '{"type":"list","items":["..."],"ordered":false}',
        '{"type":"table","title":"...","headers":["..."],"rows":[["..."]]}',
        '{"type":"form","collection":"<name>","title":"...","submitLabel":"Add","fields":[{"name":"x","label":"X","input":"text|textarea|number|date|checkbox|select","options":["only for select"],"required":true}]}',
        '{"type":"record_list","collection":"<name>","title":"...","fields":["x","y"],"empty":"...","sort":{"by":"createdAt","dir":"desc"},"editFields":[same shape as form fields],"statusField":{"name":"<field>","options":["wish","read"]},"detail":{"title":"<field>","fields":["x","y","z"],"source":{"url":"https://api.example.com{key}.json","key":"<recordField filling {key}>","resultPath":"<optional dot path>","map":{"<recordField>":"<result.path>"}}}}',
        '{"type":"progress","label":"...","value":<number | computed aggregation>,"max":<number | computed aggregation>}',
        '{"type":"stat","label":"...","value":"static" | <computed aggregation>,"caption":"..."}  (one prominent metric)',
        '{"type":"badge","text":"...","tone":"neutral|success|warning|danger"}  (a small status chip)',
        '{"type":"key_value","title":"...","items":[{"label":"...","value":"static" | <computed aggregation>}]}',
        '{"type":"gauge","label":"...","value":<number | computed aggregation>,"max":<number | computed aggregation>}  (radial progress)',
        '{"type":"timeline","title":"...","items":[{"label":"...","time":"...","detail":"..."}]}  (static list of events)',
        '{"type":"chart","chartType":"bar|line|pie|area","title":"...","data":[{"label":"...","value":<number>}] OR {"collection":"<name>","groupBy":"<field>","agg":"count|sum|avg|min|max","field":"<numeric field for sum/avg/min/max>","where":{...}}}  (static points, or a grouping that buckets a collection by a field and aggregates each bucket)',
        '{"type":"sparkline","data":[<number>,...] OR {"collection":"<name>","field":"<numeric field>","where":{...}}}  (tiny inline trend line)',
        '{"type":"image","url":"https://…","alt":"...","caption":"..."}  (remote image by URL)',
        '{"type":"icon","name":"star|heart|check|x|home|calendar|clock|flag|bell|bolt|book|plus|arrow-up|arrow-down","label":"..."}',
        '{"type":"button","label":"...","tone":"neutral|success|warning|danger","action":<action>}',
        'An <action> is exactly one of: {"verb":"navigate","app":"<app id>"} | {"verb":"open_url","url":"https://…"} | {"verb":"add_record","collection":"<name>","values":{...}} | {"verb":"set_field","collection":"<name>","field":"<f>","value":<v>} | {"verb":"increment","collection":"<name>","field":"<f>","by":1} | {"verb":"clear_collection","collection":"<name>"}. set_field/increment act on ONE auto-created record in the collection — use them for counters/toggles (e.g. a +1 button incrementing "count", with a stat showing {"sum":"<collection>","field":"count"}). A collection named by a button action counts as declared, so a counter app needs no form or record_list.',
        '{"type":"lookup","collection":"<name>","title":"...","placeholder":"Search…","source":{"url":"https://api.example.com/search?q={query}","resultsPath":"<path.to.results.array>","label":"<result field to show>","fields":{"<recordField>":"<result.path>"}},"defaults":{"<field>":"<value>"}}',
        'Forms append records to the collection; record_list shows them (first field is the primary line), deletes, edits via editFields, and a statusField renders as a one-click chip that cycles its options (e.g. wish→read).',
        'record_list "detail" makes each row open a detail page (back button + the record fields as label/value). Use it for "click an item to see more". detail.source optionally enriches the record from a web API the first time it is opened: the url may contain ONE OR MORE {field} placeholders, each filled from the opened record (e.g. weather needs both: "https://api.open-meteo.com/v1/forecast?latitude={latitude}&longitude={longitude}&current_weather=true"). The legacy single-field form {key} pulls from record[detail.source.key] (e.g. an Open Library work key). map pulls fields from the response (dot/index paths). This is the declarative way to build a book/movie/weather/etc. detail page — no code needed.',
        'lookup is for "type a name, autocomplete from a public web API, save the pick" (book/movie/place trackers). It needs NO code — use it instead of the escape hatch for those. {query} in source.url is the typed text; resultsPath/label/fields use dot/index paths (e.g. "author_name.0"). Open Library is a good keyless books API: url "https://openlibrary.org/search.json?q={query}&limit=6", resultsPath "docs", label "title".',
        'CRITICAL — do NOT guess an API\'s response shape. resultsPath/label/fields (lookup) and detail.source.resultPath/map must match the API\'s ACTUAL JSON exactly. If you are not 100% certain of the real field names and paths, you are probably wrong. The builder will actually CALL the API with a sample and verify every path resolves — so any guessed path will be rejected and you will be shown the real response to map from. Use free, keyless, CORS-enabled APIs. For apps that need two calls (e.g. zip→coords→weather): a lookup captures the coords, then a record_list with detail.source fetches the weather for the opened record using the SAME field names. Example chain: lookup url "https://api.zippopotam.us/us/{query}" (resultsPath "places", label "place name", fields {"city":"place name","state":"state","latitude":"latitude","longitude":"longitude"}); then detail.source url "https://api.open-meteo.com/v1/forecast?latitude={latitude}&longitude={longitude}&current_weather=true" with map {"temperature":"current_weather.temperature","wind":"current_weather.windspeed"}. The {latitude}/{longitude} placeholders are filled from the record the lookup saved.',
        'WHENEVER the spec contains a lookup or a detail.source, ALSO include a top-level "_probe" object: { "<collection>": "<a real sample query/value that returns a result>" } (e.g. {"weather_queries":"90210"}). The builder calls each API with this sample to verify your paths; _probe is used only for verification and is NOT saved into the app.',
        'A computed aggregation is {"count|sum|avg|min|max":"<collection>","field":"<numeric field — required for sum/avg/min/max, omit for count>","where":{"<field>":"<value>"}}. count tallies records; sum/avg/min/max aggregate a numeric field; where filters to matching records. Use these for totals/averages/remaining — do NOT escape to code for arithmetic this covers.',
        'Any component may carry "showWhen":{...computed aggregation, "op":"gt|gte|lt|lte|eq|ne","value":<number>} to render only when the aggregation meets the comparison — e.g. an "all done!" paragraph with showWhen {"count":"tasks","where":{"done":false},"op":"eq","value":0}.',
        'Every collection named in a computed aggregation (in summary_grid, progress, or showWhen) must be one a form or record_list in this same spec uses — otherwise it is rejected.',
        'COMPOSE these into whatever the user asked for — you are NOT limited to trackers. Common shapes: a TRACKER (form or lookup + record_list on the same collection, plus a summary_grid/stat count); a COUNTER or tally (increment/decrement buttons on a collection + a stat showing {"sum":"<collection>","field":"count"}, with a Reset button using clear_collection); a DASHBOARD (stat/summary_grid/gauge/progress over collections, organized with sections or columns); a CHECKLIST with a progress bar and an "all done" paragraph gated by showWhen; a MULTI-SCREEN app using tabs, or navigate buttons to other apps. Use sections/cards/columns/tabs to organize, and pair every form/lookup with a record_list so entries are visible.'
    ].join('\n'),

    // Lean vocabulary for SMALL LOCAL MODELS. Measured finding: the full SPEC_DOC
    // (23 components + lookup/detail/_probe/editFields) overwhelms a weak model
    // like gemma4:e4b — it reaches for advanced nested features and loses track of
    // JSON nesting, emitting malformed output. Restricted to the reliable core
    // (form/record_list/stat/summary_grid/progress/section/paragraph/list/button +
    // computed aggregations + showWhen) with hard "keep it minimal" steering, the
    // SAME model produces valid, validating apps in ~8s. Advanced components stay
    // in the full doc for the remote/frontier path. This trades a little local
    // reach for reliability — the explicit goal for the local builder.
    SPEC_DOC_COMPACT: [
        'Components you may use:',
        '{"type":"form","collection":"<name>","title":"...","submitLabel":"Add","fields":[{"name":"x","label":"X","input":"number|text|date|textarea|checkbox|select","options":["for select only"]}]}',
        '{"type":"record_list","collection":"<name>","title":"...","fields":["x"],"empty":"Nothing yet."}',
        '{"type":"stat","label":"...","value":{"sum":"<collection>","field":"x"},"caption":"..."}   (value can also be {"count":"<collection>"} or a plain number)',
        '{"type":"summary_grid","items":[{"label":"...","value":{"count":"<collection>"}}]}',
        '{"type":"progress","label":"...","value":{"sum":"<collection>","field":"x"},"max":<number>}',
        '{"type":"section","title":"...","components":[...]}    {"type":"paragraph","text":"..."}    {"type":"list","items":["..."]}',
        '{"type":"button","label":"...","action":{"verb":"increment","collection":"<name>","field":"count","by":1}}   (or verb "clear_collection" to reset — for a COUNTER, pair it with a stat {"sum":"<name>","field":"count"}, no form)',
        'ALWAYS build a tracker as, in this order: (1) a "form" to add entries, (2) a "record_list" showing the SAME collection, then optionally (3) a "stat" total over that same collection. Include the form and record_list FIRST — never a stat alone. Every collection named in a stat/summary_grid/progress MUST have a form or record_list using it. Keep it to 3-4 components. Do not invent component types or fields, and do not use lookup, charts, tabs, or API calls.'
    ].join('\n'),

    /**
     * Grammar-enforced output shape for spec generation, passed as `format`.
     * Ollama (≥0.5) and llama-server compile a JSON schema into a sampling
     * grammar that masks invalid tokens — malformed JSON, markdown fences, and
     * a missing manifest/spec envelope become impossible to emit rather than
     * something the retry loop has to catch. Deliberately SHALLOW: component
     * internals stay unconstrained ({type:'object'}) because llama.cpp's
     * schema→grammar conversion treats objects with declared properties as
     * closed (additionalProperties:false), which would forbid the whole
     * component vocabulary — AppSpec.validate remains the real semantic check.
     * Only universally-supported keywords (type/properties/required/items);
     * no anyOf/enum/minItems, which some grammar converters reject.
     *
     * `allowEscape` (capable tier, new app): nothing is required and the
     * needsCode/reason keys are declared, so the {"needsCode":true} escape
     * hatch stays expressible. The compact/local prompt never offers the
     * escape, so that tier keeps the stronger manifest+spec requirement.
     */
    _specOutputSchema(allowEscape) {
        const schema = {
            type: 'object',
            properties: {
                manifest: {
                    type: 'object',
                    properties: {
                        manifestVersion: { type: 'integer' },
                        id: { type: 'string' },
                        name: { type: 'string' },
                        icon: { type: 'string' },
                        version: { type: 'string' },
                        description: { type: 'string' },
                        entry: { type: 'string' },
                        keywords: { type: 'array', items: { type: 'string' } },
                        reads: { type: 'array', items: { type: 'string' } }
                    },
                    required: ['id', 'name']
                },
                spec: {
                    type: 'object',
                    properties: {
                        specVersion: { type: 'integer' },
                        title: { type: 'string' },
                        components: { type: 'array', items: { type: 'object' } }
                    },
                    required: ['components']
                },
                _probe: { type: 'object' }
            },
            required: ['manifest', 'spec']
        };
        if (allowEscape) {
            schema.required = [];
            schema.properties.needsCode = { type: 'boolean' };
            schema.properties.reason = { type: 'string' };
        }
        return schema;
    },

    /**
     * Parse a model response as one JSON object, salvaging the common
     * local-model failure of a complete object followed by stray trailing
     * characters (observed live with qwen3.5 under format:json). True
     * truncation still throws — the retry loop handles that.
     */
    _parseJsonObject(text) {
        let s = String(text).trim();
        // Some models (esp. local ones) ignore format:json and wrap the object
        // in a ```json fence and/or add prose — observed live. Strip a leading
        // fence, cut at the first closing fence, and skip to the first "{".
        s = s.replace(/^```(?:json)?\s*/i, '');
        const close = s.indexOf('```');
        if (close >= 0) s = s.slice(0, close);
        s = s.trim();
        const start = s.indexOf('{');
        if (start > 0) s = s.slice(start);
        try {
            return JSON.parse(s);
        } catch (e) {
            // Salvage the first balanced {...} (handles trailing prose).
            const obj = this._firstBalancedObject(s);
            if (obj != null) { try { return JSON.parse(obj); } catch {} }
            // V8's "stray chars after a complete value" form.
            const m = /position (\d+)/.exec(e.message);
            if (m && /after (?:JSON|array element|value)/i.test(e.message)) {
                try { return JSON.parse(s.slice(0, Number(m[1]))); } catch {}
            }
            // Last resort: repair common local-model JSON slips (trailing
            // commas, smart quotes) — a model that's almost right shouldn't be
            // thrown away over a stray comma.
            const repaired = this._repairJson(s);
            try { return JSON.parse(repaired); } catch {}
            const robj = this._firstBalancedObject(repaired);
            if (robj != null) { try { return JSON.parse(robj); } catch {} }
            throw e; // true truncation — the retry loop asks for a compact redo
        }
    },

    // Mechanical fixes for the JSON a weak model most often gets slightly wrong.
    _repairJson(s) {
        return String(s)
            .replace(/[“”]/g, '"')   // " " -> "
            .replace(/[‘’]/g, "'")   // ' ' -> '
            .replace(/,(\s*[}\]])/g, '$1');    // trailing comma before } or ]
    },

    // The first balanced top-level {...} in a string, respecting string escapes.
    // Returns null if there's no complete object (e.g. truncated output).
    _firstBalancedObject(s) {
        if (s[0] !== '{') return null;
        let depth = 0, inStr = false, esc = false;
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (inStr) {
                if (esc) esc = false;
                else if (ch === '\\') esc = true;
                else if (ch === '"') inStr = false;
            } else if (ch === '"') inStr = true;
            else if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth === 0) return s.slice(0, i + 1); }
        }
        return null;
    },

    async _runSpec({ prompt, appId, provider, onEvent, allowFallback = false }) {
        const emit = (e) => { try { onEvent?.(e); } catch {} };
        emit({ type: 'status', message: appId ? `Updating ${appId}…` : 'Designing your app…' });
        const searchOn = await this._webSearchAvailable();

        let currentSpec = null;
        let currentManifest = null;
        if (appId) {
            const entry = ((await window.electronApps.list()) || []).find(e => e.dir === appId);
            currentSpec = entry?.spec || null;
            currentManifest = entry?.manifestRaw || null;
        }

        // Weak local models get a LEAN, self-contained prompt (measured: the
        // full 23-component doc AND the verbose manifest/escape scaffolding both
        // make gemma4:e4b over-reach — it emits malformed JSON or a stat with no
        // form feeding it. A short, directive prompt makes the SAME model produce
        // valid, well-composed apps ~4/5 of the time, converging within retries.)
        // Capable brains — a user-hosted server ('custom') — get the
        // full kit + escape hatch.
        const useCompact = !this._isCapable(provider);
        const system = useCompact
            ? [
                'You build small apps for the Anjadhe platform. Output ONE JSON object and nothing else — no prose, no markdown fences.',
                'Shape exactly: {"manifest":{"manifestVersion":1,"id":"<kebab-id>","name":"<name>","icon":"&#9733; (an HTML entity, NEVER an emoji)","version":"0.1.0","description":"<one line>","entry":"app.spec.json","keywords":["..."]},"spec":{"specVersion":1,"title":"<title>","components":[...]}}',
                this.SPEC_DOC_COMPACT
            ].join('\n')
            : [
                'You design apps for the Anjadhe platform as pure JSON documents.',
                'Build the app COMPLETE and polished — use as many components as the request deserves. A rich app commonly runs 10–25 components organized with tabs, sections, columns, and cards; include the dashboards, charts, stats, filters, detail pages, and lookups a thoughtful product designer would ship, not just the bare form. Prefer MANY simple components over deeply nested cleverness — valid JSON is non-negotiable. Output compact JSON; do not pretty-print.',
                'Output ONLY one JSON object, no prose and no markdown fences, shaped exactly:',
                '{"manifest": {...}, "spec": {...}}  (plus an optional top-level "_probe" object when the spec fetches from an API — see below)',
                'manifest: {"manifestVersion":1,"id":"<kebab-case-id>","name":"<short name>","icon":"<HTML entity like &#9733; — NEVER an emoji character>","version":"0.1.0","description":"<one line>","entry":"app.spec.json","keywords":["<words users would say>"]}',
                'spec: {"specVersion":1,"title":"<title>","components":[...]}',
                this.SPEC_DOC,
                ...(allowFallback ? [
                    '',
                    'PREFER THE SPEC. A spec app runs on BOTH Mac and the iPhone companion; escaping to code makes it Mac-only. The components above are a broad kit — not just trackers: layout (section/card/columns/tabs), data entry (form/lookup), data display (record_list/table/list/summary_grid/stat/key_value/timeline), charts (bar/line/pie/area + sparkline, over static points or a collection grouped by a field), media (image/icon), metrics (gauge/progress with computed count/sum/avg/min/max + where filters), conditional visibility (showWhen), and buttons that navigate, open URLs, quick-add records, or increment/set a counter field. So counters, dashboards with charts, checklists, tabbed and multi-section apps, totals/averages, and book/movie/place lookups are ALL doable in a spec — do not escape for those. Escape ONLY when the app genuinely needs something none of them express: a LIVE timer/stopwatch, drag-to-reorder, freeform canvas/drawing or a game, or logic beyond the bounded actions and aggregations. Then output exactly {"needsCode": true, "reason": "<short reason>"} and nothing else, and a code builder will take over.'
                ] : [])
            ].join('\n');

        const history = await this._loadHistory(appId);
        const liveErrors = appId ? await this._readErrors(appId) : null;
        const base = [
            { role: 'system', content: system },
            ...this._historyMessages(history),
            { role: 'user', content: appId
                ? `Modify this existing app. The id must stay "${appId}".\nCurrent manifest:\n${currentManifest}\nCurrent spec:\n${currentSpec}${liveErrors ? `\nThe app is currently throwing these runtime errors — fix them as part of this change:\n${liveErrors}` : ''}\nRequest: ${prompt}`
                : `Create a new app. Request: ${prompt}` }
        ];

        let lastFailureWasParse = false; // track JSON-malformation exhaustion
        let followup = null; // { assistant, feedback } from the previous failed attempt
        let lastProblems = []; // the final attempt's issues, surfaced on failure
        // Grammar-enforce the output envelope where the backend supports it
        // (Ollama schema format / llama-server json_schema). Downgraded ONCE
        // to plain 'json' if the backend rejects the schema (older Ollama,
        // servers without json_schema support) — the parse/validate retry
        // ladder below still catches everything on that path.
        let format = this._specOutputSchema(allowFallback && !useCompact);
        for (let attempt = 1; attempt <= this.maxSpecAttempts; attempt++) {
            const model = this._model();
            // Fresh context each retry: base + ONLY the immediately-preceding
            // broken attempt and its errors — never the whole pile of failures.
            // A small model reasons better over a clean slate plus one concrete
            // correction than over a window crowded with its earlier mistakes.
            const messages = followup
                ? [...base, { role: 'assistant', content: followup.assistant }, { role: 'user', content: followup.feedback }]
                : [...base];
            const response = await this._chat({
                messages,
                model,
                providerOverride: provider,
                // NEVER think here, regardless of the per-model Think toggle. The
                // output is one JSON document and thinking SHARES num_predict with
                // it — a reasoning model's long trace starves the JSON and it gets
                // truncated mid-array (observed live: valid-looking JSON failing at
                // "position 1187"). Thinking adds nothing to filling a schema, so
                // turning it off frees the whole budget for the document.
                think: false,
                format,
                // A whole {manifest, spec} document easily passes 1k tokens;
                // the runtime default cap truncates mid-JSON (verified live:
                // qwen3.5 cut at ~230 tokens), which no retry can fix. Bigger cap
                // + a per-attempt seed: greedy-ish sampling made a failing model
                // reproduce the same broken output verbatim on every retry —
                // varying the seed breaks that loop. The capable tier is asked
                // for rich 10–25 component apps, so it gets double the room.
                options: { num_predict: useCompact ? 8192 : 16384, seed: attempt },
                maxTokens: useCompact ? 8192 : 16384,
                logTag: 'builder-spec'
                // No streamer: think is forced off (nothing to stream), and
                // only the NON-streaming transport forwards `format` — the
                // streaming handlers drop it, which would silently disable
                // both the schema grammar and plain format:json.
            });
            if (response?.error) {
                if (typeof format === 'object') {
                    // The backend rejected the schema grammar — retry this
                    // same attempt on plain format:json (downgrade happens at
                    // most once; a repeat error is then a real failure).
                    format = 'json';
                    attempt--;
                    continue;
                }
                emit({ type: 'error', message: response.error });
                return { ok: false, error: response.error };
            }
            const content = response?.message?.content || '';

            const problems = [];
            let manifest, spec, probe = null;
            lastFailureWasParse = false;
            try {
                const parsed = this._parseJsonObject(content);
                // The model decided this app needs custom code — hand it back
                // to the router (no files written yet) so the code builder
                // can take over cleanly.
                if (allowFallback && parsed && parsed.needsCode === true) {
                    return { ok: false, needsCode: true, reason: parsed.reason || '' };
                }
                manifest = parsed.manifest;
                spec = parsed.spec;
                probe = parsed._probe || null; // verification samples, not saved
                if (!manifest || !spec) problems.push('output must contain both "manifest" and "spec"');
            } catch (e) {
                problems.push(`output is not valid JSON: ${e.message}`);
                lastFailureWasParse = true;
            }

            if (!problems.length) {
                // Pin the invariants rather than arguing with the model.
                manifest.manifestVersion = 1;
                manifest.entry = 'app.spec.json';
                if (appId) manifest.id = appId;
                const mCheck = AppManifest.validate(manifest);
                if (!mCheck.ok) problems.push(...mCheck.errors.map(e => `manifest: ${e}`));
                else manifest = mCheck.manifest;
                const sCheck = AppSpec.validate(spec);
                if (!sCheck.ok) problems.push(...sCheck.errors.map(e => `spec: ${e}`));
                if (!appId && !problems.length) {
                    const taken = ((await window.electronApps.list()) || []).some(e => e.dir === manifest.id) || AppManager.apps[manifest.id];
                    if (taken) problems.push(`manifest: id "${manifest.id}" is taken — pick another`);
                }
                // Ground truth: actually CALL any API the spec fetches from and
                // verify resultsPath/label/fields/map resolve against the REAL
                // response — the only way to catch a hallucinated API shape.
                if (!problems.length) {
                    emit({ type: 'status', message: 'Verifying the data source against the live API…' });
                    problems.push(...await this._probeSpec(spec, probe, searchOn, prompt, emit));
                }
            }

            if (problems.length) {
                lastProblems = problems;
                if (attempt === this.maxSpecAttempts) break;
                emit({ type: 'status', message: `Refining (attempt ${attempt + 1})…` });
                // Truncation shows up as a JSON parse error — ask for a
                // smaller document, not just a corrected one.
                const compactNudge = problems.some(p => p.includes('not valid JSON'))
                    ? ' Keep the app compact: at most 6 components, short texts.' : '';
                followup = { assistant: content, feedback: `Fix these problems and output the full corrected JSON again:${compactNudge}\n- ${problems.join('\n- ')}` };
                continue;
            }

            const dir = manifest.id;
            emit({ type: 'tool', message: `Writing ${dir}/manifest.json` });
            const w1 = await window.electronApps.writeFile(dir, 'manifest.json', JSON.stringify(manifest, null, 4) + '\n');
            emit({ type: 'tool', message: `Writing ${dir}/app.spec.json` });
            const w2 = await window.electronApps.writeFile(dir, 'app.spec.json', JSON.stringify(spec, null, 4) + '\n');
            if (w1?.error || w2?.error) {
                const msg = w1?.error || w2?.error;
                emit({ type: 'error', message: msg });
                return { ok: false, error: msg };
            }

            emit({ type: 'status', message: 'Checking the app loads cleanly…' });
            const errors = await this._postBuildCheck(dir);
            if (errors) {
                // Validated spec failing to mount means an engine/validator
                // gap, not a model mistake — feeding it back won't help.
                await this._appendHistory(dir, prompt, `Attempted but the app failed to load: ${errors.split('\n')[0]}`);
                emit({ type: 'error', message: `The app failed to load:\n${errors}` });
                return { ok: false, appId: dir, error: errors };
            }
            const summary = appId ? 'App updated.' : `Built ${manifest.name}.`;
            await this._appendHistory(dir, prompt, summary);
            emit({ type: 'done', appId: dir, summary });
            return { ok: true, appId: dir };
        }

        // Couldn't converge on a valid spec. No files were written.
        // If the model kept emitting MALFORMED JSON, it's too weak for this —
        // don't silently fall through to the code builder and ship a buggy app;
        // signal the router to recommend a stronger builder instead. A non-parse
        // failure (e.g. validation) can still try the code path.
        if (allowFallback) return lastFailureWasParse ? { ok: false, weakJson: true, problems: lastProblems } : { ok: false, fallback: true, problems: lastProblems };

        const msg = `Could not produce a valid app after ${this.maxSpecAttempts} attempts. Try rephrasing, or connect a more capable model on your own server (Settings → AI Assistant).`;
        if (appId) await this._appendHistory(appId, prompt, 'Attempted but could not produce a valid app.');
        emit({ type: 'error', message: msg });
        return { ok: false, error: msg };
    },

    /**
     * Wait for hot reload to settle, exercise render() once (mounting only
     * runs init, so render-time crashes would otherwise ship as success),
     * then return the app's .errors.log content — null means clean.
     */
    async _postBuildCheck(dir) {
        await new Promise(r => setTimeout(r, 1800));
        // Capture a synchronous render() throw too — swallowing it would let a
        // broken app ship as "clean" (the host only logs *lifecycle* throws).
        let renderError = null;
        try { AppManager.apps[dir]?.render?.(); } catch (e) { renderError = (e && e.message) || String(e); }
        await new Promise(r => setTimeout(r, 400));
        const log = await window.electronApps.readFile(dir, '.errors.log');
        let errors = (log && log.content) ? this._cleanErrors(log.content) : null;
        if (renderError) errors = (errors ? errors + '\n' : '') + `render() threw: ${renderError}`;
        return errors;
    },

    // Read & tidy an app's current runtime error log — the live evidence a
    // user means by "it's not working". Fed into the conversation and edits so
    // the agent can fix a runtime bug (e.g. a ReferenceError that only fires
    // after data loads) instead of debugging blind.
    async _readErrors(appId) {
        if (!appId || !window.electronApps?.readFile) return null;
        try {
            const log = await window.electronApps.readFile(appId, '.errors.log');
            return (log && log.content) ? this._cleanErrors(log.content) : null;
        } catch { return null; }
    },

    // --- API grounding probe -------------------------------------------------
    // The spec validator only checks structure, so a hallucinated API shape
    // (wrong resultsPath, made-up field names, or an API that doesn't even
    // return the asked-for data) passes. This actually CALLS each API the spec
    // fetches from — exactly the way the running app does (a plain renderer
    // fetch, same CORS behavior) — and verifies every configured path resolves
    // against the REAL response, feeding the real JSON back so the model maps
    // from ground truth instead of guessing. Returns problem strings (fed into
    // the same retry loop as validation errors). Empty if there's nothing to
    // fetch or everything checks out.
    _dig(obj, path) {
        if (path == null || path === '') return obj;
        return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    },
    _truncJson(o) {
        try { const s = JSON.stringify(o); return s.length > 900 ? s.slice(0, 900) + '…(truncated)' : s; }
        catch { return String(o); }
    },
    async _probeFetch(url) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        try {
            const res = await fetch(url, { signal: controller.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (e) {
            throw new Error(e.name === 'AbortError' ? 'timed out' : (e.message || 'network error'));
        } finally { clearTimeout(timer); }
    },
    async _searchForApi(prompt, emit) {
        try {
            emit({ type: 'tool', message: 'Searching for a working API…' });
            const r = await AgentTools.execute('web_search', { query: `free public JSON API, no API key, CORS-enabled, for: ${prompt}`.slice(0, 200) });
            const text = typeof r === 'string' ? r : (r?.content || r?.result || JSON.stringify(r));
            return String(text || '').slice(0, 1200);
        } catch { return ''; }
    },
    async _probeSpec(spec, probe, searchOn, prompt, emit) {
        const lookups = [], details = [];
        const walk = (comps) => {
            for (const c of (comps || [])) {
                if (!c || typeof c !== 'object') continue;
                if (c.type === 'lookup' && c.source && typeof c.source.url === 'string' && c.source.url.includes('{query}')) lookups.push(c);
                if (c.type === 'record_list' && c.detail && c.detail.source && typeof c.detail.source.url === 'string') details.push(c);
                if (Array.isArray(c.components)) walk(c.components);
                if (Array.isArray(c.tabs)) for (const t of c.tabs) walk(t?.components);
            }
        };
        walk(spec?.components);
        if (!lookups.length && !details.length) return [];

        const problems = [];
        const sampleRecordByCollection = {}; // first real result, to chain detail probes

        for (const c of lookups) {
            const entry = probe && probe[c.collection];
            const sample = typeof entry === 'string' ? entry : (entry && entry.query);
            if (sample == null || sample === '') {
                // No verification sample — can't ground-check this lookup, but
                // don't block an otherwise-valid app (weak models may omit it).
                emit({ type: 'status', message: `Skipping API check for "${c.collection}" (no _probe sample)` });
                continue;
            }
            const url = c.source.url.replace(/\{query\}/g, encodeURIComponent(String(sample)));
            emit({ type: 'tool', message: `Probing API: ${url}` });
            let data;
            try { data = await this._probeFetch(url); }
            catch (e) { problems.push(`The "${c.collection}" lookup API failed: GET ${url} → ${e.message}. Use a free, keyless, CORS-enabled JSON API, or fix the URL.`); continue; }
            const arr = this._dig(data, c.source.resultsPath);
            if (!Array.isArray(arr) || !arr.length) {
                problems.push(`The "${c.collection}" lookup's resultsPath ${JSON.stringify(c.source.resultsPath ?? null)} does NOT resolve to a non-empty array in the real API response. Actual response:\n${this._truncJson(data)}\nSet resultsPath/label/fields to match this exact shape.`);
                continue;
            }
            const item = arr[0];
            const miss = [], rec = {};
            if (c.source.label && this._dig(item, c.source.label) == null) miss.push(`label "${c.source.label}"`);
            for (const [rf, p] of Object.entries(c.source.fields || {})) {
                const v = this._dig(item, p);
                if (v == null) miss.push(`fields.${rf} ← "${p}"`); else rec[rf] = v;
            }
            if (miss.length) problems.push(`The "${c.collection}" lookup maps paths that don't exist on a real result: ${miss.join(', ')}. A real result item:\n${this._truncJson(item)}\nFix label/fields to this item's actual paths.`);
            sampleRecordByCollection[c.collection] = rec;
        }

        for (const c of details) {
            const src = c.detail.source;
            const e = probe && probe[c.collection];
            const sampleRec = { ...(sampleRecordByCollection[c.collection] || {}), ...((e && typeof e === 'object') ? e : {}) };
            // Fill every {field} placeholder from the sample record (chained from
            // the lookup probe, e.g. latitude/longitude). Skip if we can't.
            const need = [...String(src.url).matchAll(/\{(\w+)\}/g)].map(m => m[1]);
            const fieldFor = (n) => (n === 'key' && src.key != null) ? src.key : n;
            if (!need.length || need.some(n => sampleRec[fieldFor(n)] == null)) continue;
            const url = String(src.url).replace(/\{(\w+)\}/g, (_m, n) => encodeURIComponent(String(sampleRec[fieldFor(n)])));
            emit({ type: 'tool', message: `Probing API: ${url}` });
            let data;
            try { data = await this._probeFetch(url); }
            catch (e) { problems.push(`The "${c.collection}" detail API failed: GET ${url} → ${e.message}. Use a free, keyless, CORS-enabled JSON API, or fix the URL.`); continue; }
            const base = src.resultPath ? this._dig(data, src.resultPath) : data;
            const miss = [];
            for (const [rf, p] of Object.entries(src.map || {})) { if (this._dig(base, p) == null) miss.push(`map.${rf} ← "${p}"`); }
            if (miss.length) problems.push(`The "${c.collection}" detail enrichment maps paths that don't exist in the real API response: ${miss.join(', ')}. Actual response:\n${this._truncJson(data)}\nFix detail.source.map/resultPath to match.`);
        }

        if (problems.length && searchOn) {
            const hint = await this._searchForApi(prompt, emit);
            if (hint) problems.push(`Web search results for a working API (use these to pick the right endpoint and field paths):\n${hint}`);
        }
        return problems;
    },

    // Tidy a raw .errors.log for a model: strip ISO timestamps, dedupe
    // (remounts during a build can log the same crash repeatedly), and cap
    // length so the fix prompt stays focused on the actual problem.
    _cleanErrors(log) {
        const seen = new Set();
        const lines = [];
        for (let line of String(log).split('\n')) {
            line = line.replace(/^\[[^\]]+\]\s*/, '').trim();
            if (!line || seen.has(line)) continue;
            seen.add(line);
            lines.push(line);
        }
        return lines.join('\n').slice(0, 1500);
    },

    // A fix-round prompt that hands the model everything it needs to repair
    // the app without relying on its own earlier write_file calls still being
    // in context — the load errors PLUS the current on-disk file contents.
    // This is the difference-maker for small local models, whose limited
    // context routinely drops the files they wrote a few turns earlier.
    async _buildFixMessage(dir, errors) {
        const parts = ['The app failed to load. Fix it.', '', 'Errors:', errors, '', 'Current files on disk:'];
        for (const f of ['manifest.json', 'app.js', 'app.css']) {
            try {
                const r = await window.electronApps.readFile(dir, f);
                if (r && r.content != null) parts.push('', `--- ${f} ---`, String(r.content).slice(0, 6000));
            } catch {}
        }
        parts.push('', 'Rewrite whatever file is broken — the COMPLETE corrected file, not a diff (write_file with partial:true + append_file parts when it is long) — then call finish again.');
        return parts.join('\n');
    },

    // Deterministic static checks on app.js, run at write time so the model
    // gets instant, specific feedback instead of a runtime crash three steps
    // later. These catch the patterns the docs forbid and small models reach
    // for anyway. Returns an error string, or null if clean.
    _lintAppJs(content) {
        const checks = [
            [/(?<![.\w])import\s*\(/, 'app.js uses dynamic import() — modules are not available. Write plain vanilla JS.'],
            [/(?<![.\w])import\b[^\n;]*\bfrom\b/, 'app.js uses an ES `import` — modules are not available. Write plain vanilla JS, no imports.'],
            [/(?<![.\w])require\s*\(/, 'app.js uses require() — modules are not available. Write plain vanilla JS, no require.'],
            [/\blocalStorage\b/, 'app.js uses localStorage — persist through anjadhe.storage instead (it syncs and is backed up).'],
            [/window\.electron/, 'app.js touches window.electron* — that is off-limits. Use the anjadhe.* APIs for everything.']
        ];
        for (const [re, msg] of checks) {
            if (re.test(content)) return msg;
        }
        return null;
    },

    // Manifest icons must be HTML entities (e.g. "&#10047;"), never emoji —
    // color glyphs clash with the monochrome theme and small models default
    // to them. Extended_Pictographic catches emoji without flagging ordinary
    // symbol characters.
    _iconLooksLikeEmoji(icon) {
        try { return /\p{Extended_Pictographic}/u.test(String(icon || '')); }
        catch { return false; }
    },


    /**
     * Model for local builds: the assistant's active model — ONE brain for
     * chat and builds (docs/COWORK_AGENT.md §5, single user-chosen backend).
     * Follows the conversation the build was dispatched from (same loaded
     * Ollama runner, no second model resident). The dedicated builder model
     * (builder-settings.localModel) is retired.
     */
    _model() {
        if (typeof AgentService !== 'undefined' && AgentService.getActiveModel) {
            const m = AgentService.getActiveModel(AgentService.activeConversationId);
            if (m) return m;
        }
        return StorageManager.get('agent-settings')?.selectedModel || null;
    },

    // Is web search usable right now? True only when the active provider has
    // an API key (Settings → APIs). Gates whether the builder is offered the
    // web_search tool — no point dangling a tool that returns "not configured".
    async _webSearchAvailable() {
        try {
            const s = await window.electronSearch?.getStatus?.();
            return !!(s && s.providers && s.provider && s.providers[s.provider]?.hasKey);
        } catch { return false; }
    },

    async _run({ prompt, appId, provider, onEvent }) {
        const emit = (e) => { try { onEvent?.(e); } catch {} };
        const capable = this._isCapable(provider);
        const docs = await window.electronApps.getDocs();

        // Give the code builder the same web_search tool the assistant uses,
        // when a search provider is configured — so it can look up an
        // unfamiliar API, a best practice, or a fix for an error it hit. Reuse
        // the assistant's exact definition + handler so behavior stays in sync.
        const searchOn = await this._webSearchAvailable();
        const webDef = (searchOn && typeof AgentTools !== 'undefined')
            ? AgentTools.definitions.find(d => d?.function?.name === 'web_search')
            : null;
        const toolDefs = webDef ? [...this.definitions, webDef] : this.definitions;

        const system = [
            'You are the Anjadhe App Builder. You build small apps inside the Anjadhe desktop app by writing files with the write_file tool.',
            'Work autonomously — do not ask questions. Pick sensible defaults.',
            'Steps: 1) write_file manifest.json  2) write_file app.js  3) write_file app.css. Then call finish.',
            'LONG FILES: a single tool call gets truncated at the token limit and the whole call is rejected. Any file over ~150 lines MUST be sent in parts — write_file with partial:true for the first part, then append_file for each following part with done:true on the final one. The file is validated and saved when the last part lands. Keep every part under ~150 lines.',
            'Each completed write reports validation problems — fix them before moving on.',
            'After you call finish, the app is loaded and checked. If it fails to load, you get the exact errors and the current file contents — rewrite the broken file (the COMPLETE corrected file, never a diff or a fragment; use partial/append_file parts when it is long), then call finish again.',
            webDef
                ? 'You have file tools plus a web_search tool. Use web_search sparingly — to look up an unfamiliar technique, a best practice, or a fix for an error you hit — not for things you already know. You still cannot run commands or read the user\'s data.'
                : 'You only have file tools. You cannot run commands, browse, or read user data.',
            '',
            'You are on the code path because the spec builder could not express this app — so hand-write the part that needs code (a chart, a live timer, drag-reorder, a canvas/game, or logic beyond bounded actions and aggregations). But for the rest — any form, list, table, summary, stat, gauge, tabs, buttons, etc. — STILL render it with Anjadhe.Spec.render(container, components, { storage: anjadhe.storage, rerender: () => this.render() }), which handles input, persistence, edit/delete, computed values, and theming for you. Mix Spec components with your custom DOM; hand-roll only what Spec genuinely cannot do. Spec is far more reliable than hand-rolled DOM and event wiring.',
            '',
            'RELIABILITY RULES — follow them exactly. Breaking any one is the usual reason an app will not load:',
            '1. Write all three files, in order: manifest.json, then app.js, then app.css (app.css may be minimal). manifest.json first — it names the app.',
            '2. app.js MUST call Anjadhe.registerApp({ ... }) once at the top level. No import/require, no external libraries, no build step — vanilla JS only. You MAY use fetch() to call public, CORS-enabled web APIs when the app needs external data (e.g. a book or movie lookup) — handle loading and error states, and keep all of the user\'s own data in anjadhe.storage.',
            '3. Use only the documented anjadhe / Anjadhe / Anjadhe.Spec / Anjadhe.ui methods below. Do NOT invent or guess APIs, globals, or option names. If it is not in the docs, do not use it.',
            '4. Use the bare `anjadhe` binding (NOT `this.anjadhe`) for storage, tools, and navigate, so it works inside arrow functions and helpers. Persist only through anjadhe.storage — never localStorage or window.electron*.',
            '5. The manifest icon is an HTML entity such as "&#10047;", never an emoji character.',
            '6. Escape every piece of user-entered text with Anjadhe.ui.escapeHtml(...) before placing it in innerHTML, and re-render with this.render() after changing data.',
            capable
                ? '7. Build it COMPLETE and polished — real interactions, multiple views where the request calls for them, thoughtful empty/loading/error states, and styling that follows the design rules in the docs. Working still beats broken: build in solid increments and fix validation errors as they surface, but do not artificially shrink the app.'
                : '7. Keep it small and working over clever. A working one-screen app beats an ambitious broken one.',
            '',
            'The platform documentation (file formats, the Anjadhe SDK, Spec component vocabulary, design rules):',
            '',
            docs
        ].join('\n');

        const session = {
            dir: appId,          // set from manifest.json id on first write
            wroteAnything: false,
            finishSummary: null,
            partials: Object.create(null)   // file -> buffered parts (write_file partial:true + append_file)
        };

        const history = await this._loadHistory(appId);
        const liveErrors = appId ? await this._readErrors(appId) : null;
        const messages = [
            { role: 'system', content: system },
            ...this._historyMessages(history),
            { role: 'user', content: appId
                ? `Modify the existing app "${appId}". Read its files first. Request: ${prompt}${liveErrors ? `\n\nThe app is currently throwing these runtime errors — fix them as part of this change:\n${liveErrors}` : ''}`
                : `Build a new app. Request: ${prompt}` }
        ];

        emit({ type: 'status', message: appId ? `Editing ${appId}…` : 'Writing the code…' });

        let iterations = 0;
        let fixRounds = 0;
        let toolNudges = 0;
        const recovery = { parseRetries: 0, fileCapture: false };   // BuildKit parse-error ladder state
        let verifiedClean = false;
        // A rich multi-view app plus fix rounds needs more turns than the
        // small-model budget allows; the capable tier gets extra headroom.
        const maxIterations = capable ? 32 : this.maxIterations;
        while (iterations < maxIterations) {
            iterations++;
            const model = this._model();
            const response = await this._chat({
                messages,
                model,
                tools: toolDefs,
                providerOverride: provider,
                // Honor the brain entry's Think toggle (Settings → AI
                // Assistant → Manage). Defaults to false; ignored by
                // non-reasoning models. The main.js tool-quirk list still
                // force-disables it for qwen3:/deepseek-r1/r2 during tool turns.
                think: AgentService.getBrainThink(),
                // write_file calls carry whole files in their arguments —
                // don't let the default completion cap truncate them. The
                // capable tier writes big files (a polished app.js observed
                // live at ~14k tokens once JSON-escaped), so it gets a cap
                // that whole file comfortably fits under.
                options: { num_predict: capable ? 32768 : 4096 },
                maxTokens: capable ? 32768 : 4096,
                logTag: 'builder'
            }, this._thinkingStreamer(model, emit));
            if (response?.error) {
                // Truncated / malformed tool-call JSON — BuildKit runs the
                // shared recovery ladder (parts nudge, then plain-text
                // FILE capture). See findings #18/#19.
                if (BuildKit.handleParseError({ error: response.error, state: recovery, messages, emit, exampleFile: 'app.js' })) continue;
                emit({ type: 'error', message: response.error });
                return { ok: false, error: response.error };
            }
            const msg = response?.message || {};
            // Ollama doesn't surface tool_call ids; synthesize stable ones so
            // the chat template can link results to calls (same trick as
            // AgentService.sendMessage).
            (msg.tool_calls || []).forEach((tc, i) => {
                if (!tc.id) tc.id = `call_${Date.now().toString(36)}_${i}`;
            });
            messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });

            const calls = msg.tool_calls || [];
            let finished = false;
            if (calls.length) {
                for (const tc of calls) {
                    const name = tc.function?.name;
                    let args = tc.function?.arguments;
                    if (typeof args === 'string') {
                        try { args = JSON.parse(args); } catch { args = {}; }
                    }
                    const result = await this._execute(name, args || {}, session, emit);
                    if (name === 'finish') finished = true;
                    messages.push({ role: 'tool', content: JSON.stringify(result), name, tool_call_id: tc.id });
                }
            } else {
                // Plain-text FILE-block fallback (engaged after repeated
                // tool-call JSON failures): the file arrives as text, the
                // harness saves it and the loop continues.
                if (recovery.fileCapture && msg.content) {
                    const cap = this._extractFileBlock(msg.content);
                    if (cap) {
                        const res = await this._validateAndWriteFile(session, cap.file, cap.content, emit);
                        messages.push({
                            role: 'user',
                            content: res?.error
                                ? `The ${cap.file} you sent failed validation: ${res.error}\nReply again with FILE: ${cap.file} and the corrected COMPLETE file in a fenced block.`
                                : `Saved ${cap.file} (${cap.content.length} chars) — validation passed. Continue: write the remaining files (write_file tool for small ones, another FILE: block for long ones), then call finish.`
                        });
                        continue;
                    }
                }
                // No tool calls. Two recoverable small-model failures land here:
                //   (a) nothing built yet — the model is stalling before it
                //       starts; nudge it to begin with write_file.
                //   (b) it ANNOUNCED a tool ("now I'll write the CSS…") in prose
                //       without emitting the call — a Gemma-class quirk. Treating
                //       that as "done" ships a half-built app, so re-prompt for
                //       the real call instead of finishing.
                // Otherwise (a genuine substantive final message with files
                // already written) treat the model as done and fall through to
                // the verify gate. Nudges are bounded so a model that truly has
                // nothing left can't loop forever.
                if (msg.content) emit({ type: 'model', message: msg.content });
                const announced = typeof ModelQuirks !== 'undefined'
                    && ModelQuirks.looksLikeBuilderToolAnnouncement(msg.content);
                if ((!session.wroteAnything || announced) && toolNudges < this.maxToolNudges) {
                    toolNudges++;
                    messages.push({ role: 'user', content: session.wroteAnything
                        ? 'Emit the actual tool call now (write_file or finish) — do not describe it in prose.'
                        : 'Use the tools to build the app. Start with write_file manifest.json.' });
                    continue;
                }
                finished = true;
            }

            if (!finished) continue;

            // The model thinks it's done; the loop verifies the app actually
            // loads (render-time crashes must not ship as success) and spends
            // its fix budget repairing — handing the model the live error log
            // PLUS the current files, so even a small model can correct.
            if (!session.dir || !session.wroteAnything) break;
            emit({ type: 'status', message: 'Checking the app loads cleanly…' });
            const errors = await this._postBuildCheck(session.dir);
            if (!errors) { verifiedClean = true; break; }
            if (fixRounds < this.maxFixRounds) {
                fixRounds++;
                emit({ type: 'status', message: `Found a problem — fixing it (attempt ${fixRounds}/${this.maxFixRounds})…` });
                messages.push({ role: 'user', content: await this._buildFixMessage(session.dir, errors) });
                continue;
            }
            await this._appendHistory(session.dir, prompt, `Attempted but the app still has errors: ${errors.split('\n')[0]}`);
            emit({ type: 'error', message: `The app still has errors after ${fixRounds} fix attempts:\n${errors}` });
            return { ok: false, appId: session.dir, error: errors };
        }

        if (!session.wroteAnything) {
            if (appId) await this._appendHistory(appId, prompt, 'Attempted but the model produced no files.');
            emit({ type: 'error', message: 'The model did not produce an app. Try rephrasing, or use a more capable model.' });
            return { ok: false };
        }

        // Safety net: the loop hit the iteration cap mid-build without a clean
        // verification. Never ship an unchecked app as success — verify once
        // more and surface any errors rather than claiming "done".
        if (!verifiedClean) {
            const errors = await this._postBuildCheck(session.dir);
            if (errors) {
                await this._appendHistory(session.dir, prompt, `Attempted but the app still has errors: ${errors.split('\n')[0]}`);
                emit({ type: 'error', message: `The build stopped before the app loaded cleanly:\n${errors}` });
                return { ok: false, appId: session.dir, error: errors };
            }
        }

        const summary = session.finishSummary || 'App updated.';
        await this._appendHistory(session.dir, prompt, summary);
        emit({ type: 'done', appId: session.dir, summary });
        return { ok: true, appId: session.dir };
    },

    async _execute(name, args, session, emit) {
        switch (name) {
            case 'list_apps': {
                const entries = await window.electronApps.list();
                return { apps: (entries || []).map(e => e.dir) };
            }

            case 'read_schemas':
                return await window.electronApps.getSchemas();

            case 'web_search': {
                emit({ type: 'tool', message: `Searching the web: ${String(args.query || '').slice(0, 80)}` });
                // Reuse the assistant's handler (logging + provider plumbing).
                const res = (typeof AgentTools !== 'undefined' && AgentTools.execute)
                    ? await AgentTools.execute('web_search', args || {})
                    : (window.electronSearch?.query
                        ? await window.electronSearch.query(args.query, args.maxResults)
                        : { error: 'Web search not available.' });
                // Bound the payload — the builder model's context is tight, and
                // a raw 10-result list with long snippets would crowd out the
                // code it's writing. Keep the top few, trim snippets.
                if (res && Array.isArray(res.results)) {
                    return { results: res.results.slice(0, 5).map(r => ({
                        title: r.title,
                        url: r.url,
                        snippet: typeof r.snippet === 'string' ? r.snippet.slice(0, 280) : r.snippet
                    })) };
                }
                return res;
            }

            case 'read_file': {
                if (!session.dir) return { error: 'No app yet — write manifest.json first.' };
                emit({ type: 'tool', message: `Reading ${args.file}` });
                return await window.electronApps.readFile(session.dir, args.file);
            }

            case 'write_file': {
                if (args.partial === true && args.file === 'manifest.json') {
                    return { error: 'manifest.json is small — write it whole, without partial.' };
                }
                return await BuildKit.partialWrite(session.partials, args.file, String(args.content ?? ''), args.partial,
                    (name, content) => this._validateAndWriteFile(session, name, content, emit));
            }

            case 'append_file':
                return await BuildKit.partialAppend(session.partials, args.file, String(args.content ?? ''), args.done,
                    (name, content) => this._validateAndWriteFile(session, name, content, emit));

            case 'finish':
                session.finishSummary = args.summary || null;
                return { ok: true };

            default:
                return { error: `Unknown tool: ${name}` };
        }
    },

    /**
     * Pull a `FILE: <name>` + fenced-code block out of a plain-text reply
     * (the fallback transfer for files too large for tool-call JSON). The
     * content may itself contain backticks (JS template literals), so the
     * block is cut at the LAST closing fence in the text, not the first.
     * Falls back to sniffing the file kind when the FILE: header is missing.
     */
    _extractFileBlock(text) {
        return BuildKit.extractFileBlock(text, {
            allow: (f) => /^(manifest\.json|app\.js|app\.css)$/i.test(f) ? f.toLowerCase() : null,
            sniff: (content) => {
                if (content.includes('Anjadhe.registerApp')) return 'app.js';
                if (/^\s*\{/.test(content) && content.includes('manifestVersion')) return 'manifest.json';
                if (/[.#][\w-]+\s*\{/.test(content) && !/\bfunction\b|=>/.test(content)) return 'app.css';
                return null;
            }
        });
    },

    /**
     * Shared tail of write_file / append_file(done): validate the COMPLETE
     * file content, then write it to disk. Validation before disk means the
     * model gets the problem back as the tool result and can correct
     * immediately, and hot reload only ever sees complete files.
     */
    async _validateAndWriteFile(session, file, content, emit) {
        if (file === 'manifest.json') {
            let parsed;
            try { parsed = JSON.parse(content); } catch (e) {
                return { error: `manifest.json is not valid JSON: ${e.message}` };
            }
            const check = AppManifest.validate(parsed);
            if (!check.ok) return { error: `invalid manifest: ${check.errors.join('; ')}` };
            if (this._iconLooksLikeEmoji(parsed.icon)) {
                return { error: 'manifest "icon" is an emoji — use an HTML entity instead, e.g. "&#10047;".' };
            }
            if (!session.dir) {
                // Creating: refuse ids that already exist.
                const entries = await window.electronApps.list();
                if ((entries || []).some(e => e.dir === parsed.id) || AppManager.apps[parsed.id]) {
                    return { error: `id "${parsed.id}" is taken — pick another` };
                }
                session.dir = parsed.id;
            } else if (parsed.id !== session.dir) {
                return { error: `id must stay "${session.dir}"` };
            }
        }
        if (file === 'app.js') {
            // Same compilation shape as the loader (scoped `anjadhe`
            // binding) so what validates here is what runs there.
            try { new Function('anjadhe', content); } catch (e) {
                return { error: `app.js has a syntax error: ${e.message}` };
            }
            if (!content.includes('Anjadhe.registerApp')) {
                return { error: 'app.js must call Anjadhe.registerApp({...})' };
            }
            const lint = this._lintAppJs(content);
            if (lint) return { error: lint };
        }
        if (!session.dir) return { error: 'Write manifest.json first — it names the app folder.' };

        emit({ type: 'tool', message: `Writing ${session.dir}/${file}` });
        const result = await window.electronApps.writeFile(session.dir, file, content);
        if (result?.error) return result;
        session.wroteAnything = true;
        // Consistency nudge (non-blocking): restyling bare form elements is
        // how apps drift from the host look — the platform kit (spec-*
        // classes) already styles them identically everywhere.
        if (file === 'app.css') {
            const stripped = content.replace(/\/\*[\s\S]*?\*\//g, '');
            if (/(^|[,{}\s])(#[\w-]+-view\s+)?(input|button|select|textarea)(\s*[,{[:]|\s+\{)/m.test(stripped)) {
                return { ok: true, warning: 'app.css restyles bare input/button/select/textarea elements. The platform kit (spec-form / spec-field / spec-form-submit classes — see "Standard UI classes" in the docs) already styles these consistently across every app and page. Remove the restyling and use the kit classes unless this is a genuinely app-specific control (e.g. a custom slider).' };
            }
        }
        return { ok: true };
    }
};
