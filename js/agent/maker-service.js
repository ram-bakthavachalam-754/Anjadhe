/**
 * MakerService — the Maker build agent.
 *
 * A sibling to BuilderService (App Studio), but deliberately SIMPLER: where the
 * builder fills a portable JSON component spec, Maker just writes a
 * self-contained web artifact — arbitrary HTML/CSS/JS files in one folder,
 * rendered in a sandboxed <webview>. Generating HTML directly plays to a local
 * model's strengths far better than the spec DSL did, so this path is the one
 * that runs well on Ollama.
 *
 * Two kinds of artifact, one loop:
 *   - a research document (web_search → a long-form, cited HTML page)
 *   - an interactive app (semantic HTML + vanilla JS + localStorage)
 *
 * Containment lives in main (anjadhe-artifact:// + the artifacts IPC), never in
 * the prompt. The loop owns reliability: after the model calls finish, it reads
 * index.html back and refuses to report "done" on an empty/missing file.
 */

const MakerService = {
    maxIterations: 24,
    maxFixRounds: 2,
    // Cap web searches per build so an unreliable local model can't loop on
    // web_search forever instead of writing the artifact.
    maxSearches: 4,
    // Hard ceiling for a single search round (slightly above the main-process
    // 30s HTTP timeout) so a stalled IPC can't hang the whole build.
    searchTimeoutMs: 35000,

    _running: false,

    // Race a promise against a timeout so a hung call can't block the loop.
    _withTimeout(promise, ms, onTimeout) {
        return Promise.race([
            Promise.resolve(promise),
            new Promise((resolve) => setTimeout(() => resolve(onTimeout), ms))
        ]);
    },

    // Resolve the model context window. Reuse the assistant's RAM-aware num_ctx
    // so Ollama serves Maker from the same loaded runner (no second model
    // load), and — critically — so the model has room to emit a whole HTML file
    // in one write_file. Without an explicit num_ctx, Ollama's small default
    // truncates large writes mid-file, which makes the model loop trying to
    // "rewrite the entire index.html".
    async _resolveNumCtx() {
        try {
            if (typeof AgentService !== 'undefined') {
                if (AgentService.numCtx) return AgentService.numCtx;
                if (typeof AgentService.initNumCtx === 'function') {
                    const v = await AgentService.initNumCtx();
                    if (v) return v;
                }
            }
        } catch { /* fall through */ }
        return 8192;
    },

    // Swappable transport so the loop can stream the model's "thinking" trace
    // into the Maker log, same as BuilderService. Resolves to the same final
    // { message: { content, tool_calls } } shape either way.
    _chat(params, onChunk) {
        return onChunk
            ? window.electronLLM.chatStream(params, onChunk)
            : window.electronLLM.chat(params);
    },

    _thinkingStreamer(model, emit) {
        // Maker always runs on the brain (default entry) — its think flag decides.
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

    // Per-artifact memory (artifacts/<id>/.maker/history.json) — capped
    // {userPrompt, assistantSummary} pairs from past builds. The live file
    // contents are the source of truth for the *what*; history gives the *why*.
    async _loadHistory(id) {
        if (!id || !window.electronArtifacts?.readHistory) return [];
        try {
            const result = await window.electronArtifacts.readHistory(id);
            return Array.isArray(result?.entries) ? result.entries : [];
        } catch { return []; }
    },

    async _appendHistory(id, userPrompt, assistantSummary) {
        if (!id || !window.electronArtifacts?.appendHistory) return;
        if (!userPrompt && !assistantSummary) return;
        try {
            await window.electronArtifacts.appendHistory(id, {
                userPrompt: userPrompt || '', assistantSummary: assistantSummary || '', timestamp: Date.now()
            });
        } catch {}
    },

    _historyMessages(entries) {
        const out = [];
        for (const e of (entries || [])) {
            if (e?.userPrompt) out.push({ role: 'user', content: e.userPrompt });
            if (e?.assistantSummary) out.push({ role: 'assistant', content: e.assistantSummary });
        }
        return out;
    },

    // Same model resolution as the builder: the assistant's active model —
    // ONE brain for chat and builds (docs/COWORK_AGENT.md §5). The dedicated
    // builder model (builder-settings.localModel) is retired.
    _model() {
        if (typeof AgentService !== 'undefined' && AgentService.getActiveModel) {
            const m = AgentService.getActiveModel(AgentService.activeConversationId);
            if (m) return m;
        }
        return StorageManager.get('agent-settings')?.selectedModel || null;
    },

    async _webSearchAvailable() {
        try {
            const s = await window.electronSearch?.getStatus?.();
            return !!(s && s.providers && s.provider && s.providers[s.provider]?.hasKey);
        } catch { return false; }
    },

    definitions: [
        { type: 'function', function: {
            name: 'write_file',
            description: 'Write a file inside the artifact folder. Path is relative (e.g. "index.html", "styles.css", "pages/about.html"). Always write the COMPLETE file — never a diff or fragment. Write index.html first. For a LONG file (roughly 150+ lines), set partial:true and send the rest in append_file parts — one huge tool call gets truncated at the token limit and the whole call fails.',
            parameters: { type: 'object', properties: {
                path: { type: 'string', description: 'Relative path within the artifact, e.g. index.html or assets/app.js' },
                content: { type: 'string', description: 'The full file contents (or the first part when partial:true).' },
                partial: { type: 'boolean', description: 'true = more parts follow via append_file; the file is saved when the last part (done:true) arrives' }
            }, required: ['path', 'content'] }
        }},
        { type: 'function', function: {
            name: 'append_file',
            description: 'Continue a file started with write_file {partial:true}. Set done:true on the final part — the assembled file is then saved.',
            parameters: { type: 'object', properties: {
                path: { type: 'string' },
                content: { type: 'string' },
                done: { type: 'boolean', description: 'true = last part; save the assembled file' }
            }, required: ['path', 'content'] }
        }},
        { type: 'function', function: {
            name: 'read_file',
            description: 'Read a file from the artifact folder. Returns null content if it does not exist yet.',
            parameters: { type: 'object', properties: {
                path: { type: 'string' }
            }, required: ['path'] }
        }},
        { type: 'function', function: {
            name: 'list_files',
            description: 'List the files that currently exist in the artifact folder.',
            parameters: { type: 'object', properties: {} }
        }},
        { type: 'function', function: {
            name: 'remember',
            description: 'Save a DURABLE, GENERAL preference about how to build ALL future artifacts (e.g. "always make sources clickable links", "prefer a dark theme", "include a table of contents in documents"). Use this whenever the user states a lasting how-to-build preference. Do NOT use it for one-off requests specific to the current artifact.',
            parameters: { type: 'object', properties: {
                preference: { type: 'string', description: 'The preference, phrased as a short imperative the agent can follow next time.' }
            }, required: ['preference'] }
        }},
        { type: 'function', function: {
            name: 'finish',
            description: 'Call when the artifact is complete. Provide a name, a one-sentence summary, and whether it is a document, a presentation, or an app.',
            parameters: { type: 'object', properties: {
                name: { type: 'string', description: 'A short, human-friendly name for this artifact — 2 to 5 words, Title Case, no quotes (e.g. Toddler Sleep Guide, Multiplication Practice).' },
                summary: { type: 'string' },
                kind: { type: 'string', enum: ['doc', 'app', 'presentation'], description: 'doc for a research/reading document, presentation for a slide deck, app for an interactive tool.' }
            }, required: ['name', 'summary'] }
        }}
    ],

    // ---- Global build preferences (agent memory, source 'maker') -------------
    // Unlike per-artifact history, these are durable how-to-build preferences
    // the user states once ("sources should be links") that should shape EVERY
    // future build. They live in the one agent's MemoryManager (type
    // 'preference', source 'maker') — the assistant is the only agent, so its
    // memory surface (list_memories / delete_memory, Settings) manages them
    // too. Legacy entries in the old `maker-memory` StorageManager key are
    // migrated on first read; the key is then cleared (both stores sync, so
    // the migration propagates across Macs).
    _MEMORY_KEY: 'maker-memory',
    _MEMORY_MAX: 20,

    _migrateLegacyMemory() {
        if (typeof MemoryManager === 'undefined') return;
        let legacy;
        try { legacy = StorageManager.get(this._MEMORY_KEY); } catch { return; }
        if (!Array.isArray(legacy) || !legacy.length) return;
        for (const e of legacy) {
            const text = ((e && e.text) || '').trim();
            if (!text) continue;
            try {
                if (!MemoryManager.findDuplicate({ type: 'preference', title: '', body: text, profile: null })) {
                    MemoryManager.create({ type: 'preference', body: text, source: 'maker' });
                }
            } catch { /* one bad entry must not block the rest */ }
        }
        try { StorageManager.set(this._MEMORY_KEY, []); } catch {}
    },

    getMemory() {
        if (typeof MemoryManager === 'undefined') return [];
        try {
            this._migrateLegacyMemory();
            // Keep the {id, text} shape the build prompt and UI consume.
            return MemoryManager.list({ type: 'preference', source: 'maker' })
                .map(m => ({ id: m.id, text: m.body, createdAt: m.createdAt }));
        } catch { return []; }
    },

    addMemory(text) {
        const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!clean || typeof MemoryManager === 'undefined') return null;
        try {
            // Dedup so the agent re-stating a known preference doesn't pile up.
            if (MemoryManager.findDuplicate({ type: 'preference', title: '', body: clean, profile: null })) return null;
            if (this.getMemory().length >= this._MEMORY_MAX) return null;
            const m = MemoryManager.create({ type: 'preference', body: clean, source: 'maker' });
            return { id: m.id, text: m.body, createdAt: m.createdAt };
        } catch { return null; }
    },

    forget(id) {
        try { if (typeof MemoryManager !== 'undefined') MemoryManager.delete(id); } catch {}
    },

    _systemPrompt(searchOn, memory = []) {
        const lines = [
            'You are Maker, an agent inside the Anjadhe desktop app that builds self-contained web artifacts for the user by writing files with the write_file tool.',
            'An artifact is a folder of plain HTML/CSS/JS rendered in a sandboxed frame. It has its OWN page — it does NOT inherit Anjadhe styles, so include your own CSS.',
            'Work autonomously. Do not ask questions — pick sensible defaults and build.',
            '',
            'THREE KINDS OF ARTIFACT — decide which the request wants:',
            '• A DOCUMENT (e.g. "deep research on X", "a guide to Y"): a long-form, readable HTML page. Include a title, a table of contents linking to sections, well-structured prose, and — when you used web research — a "Sources" section at the end. List EACH source as a clickable link: <a href="https://full-url" target="_blank" rel="noopener">Source title</a>. Never list a source as plain text without its URL. Use generous typography and readable line length.',
            '• A PRESENTATION (e.g. "slides about our trip", "a deck to pitch X"): full-viewport slides, each as <section class="slide">. One idea per slide, large type, generous whitespace. Add simple navigation (arrow keys and click advance) in a few lines of vanilla JS. REQUIRED print CSS so PDF export gives one slide per page: @media print { .slide { page-break-after: always; height: 100vh; display: flex; } } and @page { size: landscape; margin: 0; }.',
            '• An APP (e.g. "an app to practice multiplication", "a budgeting calculator"): semantic HTML + vanilla JavaScript. Persist any state with localStorage (the artifact has its own origin). Handle empty/error states.',
            '',
            'STRUCTURE:',
            '1. Write index.html FIRST. Prefer a SINGLE self-contained index.html with an inline <style> and inline <script> — it is the most reliable. Only split into separate styles.css / app.js, or add extra pages, when the artifact genuinely needs it; link extra pages with relative hrefs (e.g. <a href="page2.html">).',
            '2. Send the COMPLETE file in every write — never a diff or a fragment. LONG FILES: a single tool call gets truncated at the token limit and the whole call is rejected. Any file over ~150 lines MUST be sent in parts: write_file with partial:true for the first ~150 lines, then append_file for each following part with done:true on the final one. Keep every part under ~150 lines.',
            '3. NO external libraries, frameworks, CDNs, or remote fonts/images — the frame is offline and cannot reach the network. Everything must be inline or in sibling files you write. Use system fonts and CSS you write yourself.',
            '4. TYPOGRAPHY: set this exact font stack on the page body (and inherit it everywhere) — do not substitute another font:',
            "   font-family: -apple-system, BlinkMacSystemFont, \"Apple Color Emoji\", Inter, Roboto, \"Segoe UI\", \"Helvetica Neue\", Arial, \"Noto Sans\", sans-serif;",
            '5. Plain vanilla JS only — no import/require, no build step, no npm.',
            '6. Keep it clean and working over clever. A focused, working artifact beats an ambitious broken one.',
            '',
            searchOn
                ? 'You have a web_search tool. For research/documents, search BEFORE writing to gather real facts, and cite your sources as links. Use it sparingly for apps — only to look up a fact or technique you are unsure of.'
                : 'Web search is not configured, so rely on your own knowledge. For a research document, still organize it well and note where the user could verify details.',
            '',
            'MEMORY: If the user states a durable, general preference about how artifacts should be built — one that should apply to every future build, not just this one — call the remember tool to save it. Apply it now too.'
        ];
        if (memory.length) {
            lines.push('',
                'The user has saved these preferences from past builds. FOLLOW ALL of them unless this request explicitly overrides one:');
            for (const e of memory) lines.push(`• ${e.text || e}`);
        }
        lines.push('', 'NAMING: every artifact needs a short, human-friendly name (2–5 words, Title Case) — decide it as you build. When the artifact is complete, call finish with that name, a one-sentence summary, and the kind (doc, presentation, or app).');
        return lines.join('\n');
    },

    // Turn a prompt into a stable, readable folder id: a short slug plus a
    // suffix so two "math practice" requests don't collide. We own the id
    // because there's no manifest naming the artifact.
    _makeId(prompt) {
        const slug = String(prompt || 'artifact')
            .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'artifact';
        const suffix = Date.now().toString(36).slice(-4);
        return `${slug}-${suffix}`;
    },

    /**
     * Run one build session.
     * @param {object} opts
     *   prompt      — what the user wants built or changed
     *   artifactId  — optional: iterate on an existing artifact instead of new
     *   onEvent     — ({type, ...}) progress events: status | tool | model |
     *                 thinking | error | done
     */
    async start({ prompt, artifactId = null, onEvent }) {
        if (this._running) {
            onEvent?.({ type: 'error', message: 'A build is already running.' });
            return { ok: false };
        }
        this._running = true;
        const emit = (e) => { try { onEvent?.(e); } catch {} };
        try {
            // Make sure the artifacts dir exists before any write.
            try { await window.electronArtifacts?.enable?.(); } catch {}

            const searchOn = await this._webSearchAvailable();
            const webDef = (searchOn && typeof AgentTools !== 'undefined')
                ? AgentTools.definitions.find(d => d?.function?.name === 'web_search')
                : null;
            const toolDefs = webDef ? [...this.definitions, webDef] : this.definitions;

            const session = {
                id: artifactId || null,   // assigned on first write for new artifacts
                isNew: !artifactId,
                _firstPrompt: prompt,     // seeds the folder id slug on first write
                wroteIndex: false,
                wroteAnything: false,
                finishName: null,
                finishSummary: null,
                finishKind: null,
                searchCount: 0
            };

            const history = await this._loadHistory(artifactId);
            const messages = [
                { role: 'system', content: this._systemPrompt(searchOn, this.getMemory()) },
                ...this._historyMessages(history),
                { role: 'user', content: artifactId
                    ? `Modify the existing artifact "${artifactId}". Read its files first. Request: ${prompt}`
                    : `Build a new artifact. Request: ${prompt}` }
            ];

            emit({ type: 'status', message: artifactId ? `Editing ${artifactId}…` : 'Planning the artifact…' });

            // Give write_file room for a whole HTML file. num_predict is the
            // generation budget; num_ctx is the window the prompt + output share.
            // A capable brain (a user-hosted server) writes rich
            // single-file artifacts that blow straight past 8k tokens
            // (observed live: a story-presentation HTML cut at ~26.5k chars).
            const capable = await BuildKit.isCapableProvider();
            const numCtx = await this._resolveNumCtx();
            const numPredict = capable ? 32768 : Math.min(numCtx, 8192);

            let iterations = 0;
            let fixRounds = 0;
            const recovery = { parseRetries: 0, fileCapture: false };   // BuildKit parse-error ladder state
            while (iterations < this.maxIterations) {
                iterations++;
                const model = this._model();
                const response = await this._chat({
                    messages,
                    model,
                    tools: toolDefs,
                    think: AgentService.getBrainThink(),
                    // write_file carries whole HTML files — set num_ctx (Ollama's
                    // default is too small) and a generous num_predict so the
                    // output isn't truncated mid-file.
                    options: { num_predict: numPredict, num_ctx: numCtx },
                    maxTokens: numPredict,
                    logTag: 'maker'
                }, this._thinkingStreamer(model, emit));

                if (response?.error) {
                    // Truncated / malformed tool-call JSON — BuildKit runs the
                    // shared recovery ladder (parts nudge, then plain-text
                    // FILE capture). See findings #18/#19/#27.
                    if (BuildKit.handleParseError({ error: response.error, state: recovery, messages, emit, exampleFile: 'index.html' })) continue;
                    emit({ type: 'error', message: response.error });
                    return { ok: false, error: response.error };
                }
                const msg = response?.message || {};
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
                    // Plain-text FILE-block fallback after repeated tool-call
                    // JSON failures: extract, save, continue the loop.
                    if (recovery.fileCapture && msg.content) {
                        const cap = this._extractFileBlock(msg.content);
                        if (cap) {
                            const res = await this._execute('write_file', { path: cap.file, content: cap.content }, session, emit);
                            messages.push({
                                role: 'user',
                                content: res?.error
                                    ? `Saving ${cap.file} failed: ${res.error}\nReply again with FILE: ${cap.file} and the corrected complete file in a fenced block.`
                                    : `Saved ${cap.file} (${cap.content.length} chars). Continue: write any remaining files (write_file for small ones, another FILE: block for long ones), then call finish.`
                            });
                            continue;
                        }
                    }
                    if (msg.content) emit({ type: 'model', message: msg.content });
                    if (!session.wroteAnything) {
                        messages.push({ role: 'user', content: 'Use the tools to build the artifact. Start with write_file index.html.' });
                        continue;
                    }
                    finished = true;
                }

                if (!finished) continue;

                // Verification gate: never report done on an empty/missing
                // index.html. Feed the problem back within a small fix budget.
                const indexOk = await this._hasIndex(session.id);
                if (indexOk) break;
                if (fixRounds < this.maxFixRounds) {
                    fixRounds++;
                    emit({ type: 'status', message: `index.html is empty — fixing it (attempt ${fixRounds}/${this.maxFixRounds})…` });
                    messages.push({ role: 'user', content: 'index.html is missing or empty. Write the COMPLETE index.html now with write_file, then call finish.' });
                    continue;
                }
                break;
            }

            if (!session.wroteAnything || !session.id) {
                emit({ type: 'error', message: 'No artifact was produced. Try rephrasing, or pick a more capable model.' });
                return { ok: false };
            }

            // Record metadata so the list can render a name/kind without
            // opening files, then persist the build summary to history. Prefer
            // the name the agent chose; fall back to a derived title only if it
            // didn't name the artifact.
            const title = (session.finishName && session.finishName.trim())
                || this._titleFrom(prompt, session.finishSummary);
            try {
                await window.electronArtifacts.setMeta(session.id, {
                    title, kind: session.finishKind || (await this._guessKind(session.id))
                });
            } catch {}

            const summary = session.finishSummary || 'Artifact updated.';
            await this._appendHistory(session.id, prompt, summary);
            emit({ type: 'done', artifactId: session.id, title, summary });
            return { ok: true, artifactId: session.id };
        } finally {
            this._running = false;
        }
    },

    async _execute(name, args, session, emit) {
        switch (name) {
            case 'web_search': {
                // Stop a model that loops on search instead of writing.
                session.searchCount = (session.searchCount || 0) + 1;
                if (session.searchCount > this.maxSearches) {
                    emit({ type: 'status', message: 'Enough research — writing the artifact…' });
                    return { note: `Search limit (${this.maxSearches}) reached. Stop searching and write the artifact now: call write_file for index.html, then finish.` };
                }

                const q = String(args.query || '').slice(0, 80);
                emit({ type: 'tool', message: `Searching the web: ${q}` });

                // Guard against a stalled IPC: a single search can't hang the build.
                const exec = (typeof AgentTools !== 'undefined' && AgentTools.execute)
                    ? AgentTools.execute('web_search', args || {})
                    : (window.electronSearch?.query
                        ? window.electronSearch.query(args.query, args.maxResults)
                        : Promise.resolve({ error: 'Web search not available.' }));
                let res;
                try {
                    res = await this._withTimeout(exec, this.searchTimeoutMs, { error: 'Web search timed out.' });
                } catch (e) {
                    res = { error: e?.message || 'Web search failed.' };
                }

                // Always report the outcome so the UI never looks frozen on
                // "Searching the web…" while the model thinks/writes next.
                const n = (res && Array.isArray(res.results)) ? res.results.length : 0;
                emit({ type: 'status', message: res?.error
                    ? `Search failed (${res.error}) — continuing…`
                    : `Found ${n} result${n === 1 ? '' : 's'} — writing…` });

                if (res && Array.isArray(res.results)) {
                    return { results: res.results.slice(0, 6).map(r => ({
                        title: r.title,
                        url: r.url,
                        snippet: typeof r.snippet === 'string' ? r.snippet.slice(0, 400) : r.snippet
                    })) };
                }
                return res;
            }

            case 'list_files': {
                if (!session.id) return { files: [] };
                return await window.electronArtifacts.listFiles(session.id);
            }

            case 'read_file': {
                if (!session.id) return { error: 'Nothing written yet — write index.html first.' };
                const rel = String(args.path || '');
                emit({ type: 'tool', message: `Reading ${rel}` });
                return await window.electronArtifacts.readFile(session.id, rel);
            }

            case 'write_file': {
                const rel = String(args.path || '').trim();
                if (!rel) return { error: 'path is required.' };
                if (!session.partials) session.partials = Object.create(null);
                return await BuildKit.partialWrite(session.partials, rel, String(args.content ?? ''), args.partial,
                    (name, content) => this._writeArtifactFile(session, name, content, emit));
            }

            case 'append_file': {
                const rel = String(args.path || '').trim();
                if (!session.partials) session.partials = Object.create(null);
                return await BuildKit.partialAppend(session.partials, rel, String(args.content ?? ''), args.done,
                    (name, content) => this._writeArtifactFile(session, name, content, emit));
            }

            case 'remember': {
                const entry = this.addMemory(args.preference);
                if (entry) emit({ type: 'tool', message: `Remembered: ${entry.text.slice(0, 80)}` });
                return { ok: true };
            }

            case 'finish': {
                session.finishName = typeof args.name === 'string' ? args.name.replace(/^["']|["']$/g, '').trim() : null;
                session.finishSummary = typeof args.summary === 'string' ? args.summary : null;
                session.finishKind = ['doc', 'app', 'presentation'].includes(args.kind) ? args.kind : null;
                return { ok: true };
            }

            default:
                return { error: `unknown tool: ${name}` };
        }
    },

    /**
     * Shared tail of write_file / append_file(done): save the COMPLETE file
     * into the artifact folder (id assigned on the first write).
     */
    async _writeArtifactFile(session, rel, content, emit) {
        if (!session.id) session.id = this._makeId(session._firstPrompt || rel);
        // Carry the id so the UI can point its preview at the artifact
        // the moment the first file lands (the agent owns the id).
        emit({ type: 'tool', message: `Writing ${rel}`, artifactId: session.id });
        const result = await window.electronArtifacts.writeFile(session.id, rel, content);
        if (result?.error) return { error: result.error };
        session.wroteAnything = true;
        if (/(^|\/)index\.html$/i.test(rel) && content.trim().length > 0) session.wroteIndex = true;
        return { ok: true, path: rel };
    },

    /**
     * Pull a `FILE: <path>` + fenced-code block out of a plain-text reply
     * (fallback transfer for files too large for tool-call JSON). Content may
     * contain backticks, so the block is cut at the LAST closing fence.
     * Sniffs index.html when the header is missing but the body is a page.
     */
    _extractFileBlock(text) {
        return BuildKit.extractFileBlock(text, {
            sniff: (content) => /^\s*(<!doctype html|<html)/i.test(content) ? 'index.html' : null
        });
    },

    async _hasIndex(id) {
        if (!id) return false;
        try {
            const r = await window.electronArtifacts.readFile(id, 'index.html');
            return !!(r && typeof r.content === 'string' && r.content.trim().length > 0);
        } catch { return false; }
    },

    // Best-effort kind guess when the model didn't declare one: a <script> with
    // interactivity reads as an app, otherwise a document.
    async _guessKind(id) {
        try {
            const r = await window.electronArtifacts.readFile(id, 'index.html');
            const html = (r && r.content) || '';
            return /<script[\s>]/i.test(html) && /addeventlistener|onclick|localstorage/i.test(html) ? 'app' : 'doc';
        } catch { return 'doc'; }
    },

    // A human title for the artifact list — prefer the model's summary, fall
    // back to a trimmed prompt.
    _titleFrom(prompt, summary) {
        const src = (summary && summary.trim()) || (prompt && prompt.trim()) || 'Artifact';
        const oneLine = src.replace(/\s+/g, ' ').trim();
        return oneLine.length > 80 ? oneLine.slice(0, 77) + '…' : oneLine;
    }
};

if (typeof window !== 'undefined') window.MakerService = MakerService;
