/**
 * BuildKit — shared machinery for the two build engines (BuilderService =
 * App Studio apps, MakerService = Maker artifacts).
 *
 * Extracted 2026-07-09 after the same long-file failure had to be fixed
 * twice: the truncated-tool-call recovery ladder landed in the app builder
 * (findings #18/#19) and Maker died on the identical failure weeks of work
 * later (finding #27) because the loops are parallel implementations. The
 * engines keep their own loops, prompts, validation, tool sets, and budgets
 * — everything that proved copy-paste-identical lives here once, so the
 * next fix lands in both engines by construction.
 */
const BuildKit = {
    /**
     * Which backend will actually serve the call? 'custom' (a user-hosted
     * OpenAI-compatible server — someone running a 30B+ on their own box has
     * opted into capability) is the capable tier; small local models
     * keep the lean reliability-first settings. Pass a resolved provider to
     * skip the settings lookup.
     */
    async isCapableProvider(provider) {
        let p = provider;
        if (!p) {
            try { p = (await window.electronLLM?.getSettings?.())?.provider; } catch { p = null; }
        }
        return p === 'custom';
    },

    /** Server rejected the generation because a tool call's arguments were
     * not valid JSON — llama.cpp-class phrasing and the generic variants. */
    PARSE_ERROR_RE: /failed to parse tool call|tool[ _]call arguments|json\.exception\.parse_error|error parsing tool/i,

    /**
     * Recovery ladder for a server-rejected tool call (typically a whole
     * file in one call blowing past the generation cap mid-string). First
     * failure: ask for chunked partial/append writes. Second and third:
     * abandon tool-call JSON for the file and engage plain-text FILE
     * capture (no escaping to break, no server-side parser to fail).
     *
     * Mutates `state` ({ parseRetries, fileCapture }), pushes the nudge into
     * `messages`. Returns true when handled — the caller should `continue`
     * its loop; false means give up and surface the error.
     */
    handleParseError({ error, state, messages, emit, exampleFile }) {
        if (!this.PARSE_ERROR_RE.test(String(error || ''))) return false;
        if (state.parseRetries >= 3) return false;
        state.parseRetries++;
        if (state.parseRetries === 1) {
            emit({ type: 'status', message: 'That file was too long for one call — asking the model to send it in parts…' });
            messages.push({
                role: 'user',
                content: `Your last tool call was rejected before it ran — its arguments were not valid JSON (${String(error).slice(0, 140)}). That usually means the file was too long for a single call and got truncated. Re-issue it in PARTS: write_file with partial:true carrying roughly the first 150 lines, then append_file for each following part, with done:true on the final one. Keep every part under ~150 lines.`
            });
        } else {
            // Models routinely ignore the chunking instruction and re-emit
            // the same giant call (observed live: identical failure twice at
            // the same column). Plain text has no escaping to break.
            state.fileCapture = true;
            emit({ type: 'status', message: 'Tool calls keep failing for this file — switching to plain-text transfer…' });
            messages.push({
                role: 'user',
                content: `Your tool call failed again — this file is too large for tool-call JSON. Do NOT call any tool in your next reply. Instead reply with PLAIN TEXT in exactly this shape:\nFILE: ${exampleFile}\n\`\`\`\n<the complete file content>\n\`\`\`\n(using the correct file name). No prose before or after the block. I will save the file and confirm, and you can then continue with tool calls.`
            });
        }
        return true;
    },

    /**
     * Pull a `FILE: <name>` + fenced-code block out of a plain-text reply
     * (the fallback transfer). The content may itself contain backticks (JS
     * template literals), so the block is cut at the LAST closing fence.
     *
     * `allow(path)`  — normalize-or-reject a header path (return the path to
     *                  use, or falsy to fall through to sniffing).
     * `sniff(content)` — name the file from its content when the header is
     *                  missing or rejected.
     * Returns { file, content } or null.
     */
    extractFileBlock(text, { allow, sniff } = {}) {
        const s = String(text || '');
        const header = s.match(/FILE:\s*([\w./-]+)/i);
        const fenceStart = s.indexOf('```', header ? header.index : 0);
        if (fenceStart === -1) return null;
        const contentStart = s.indexOf('\n', fenceStart);
        if (contentStart === -1) return null;
        const fenceEnd = s.lastIndexOf('\n```');
        const content = (fenceEnd > contentStart
            ? s.slice(contentStart + 1, fenceEnd)
            : s.slice(contentStart + 1)).replace(/\s+$/, '') + '\n';
        if (!content.trim()) return null;
        let file = header ? header[1] : null;
        if (file && allow) file = allow(file) || null;
        if (!file && sniff) file = sniff(content) || null;
        return file ? { file, content } : null;
    },

    /**
     * Chunked-write buffering shared by both engines' write_file/append_file
     * handlers. `partials` is a plain object living on the engine's session;
     * `writeWhole(name, content)` performs the engine's own validate + save
     * and its result is returned verbatim. Files are only ever saved whole —
     * hot reload / preview never see fragments.
     */
    async partialWrite(partials, name, content, isPartial, writeWhole) {
        if (isPartial === true) {
            partials[name] = content;
            return { ok: true, buffered: content.length, note: `Part received (${content.length} chars buffered, nothing saved yet). Send the rest with append_file; set done:true on the final part.` };
        }
        delete partials[name];   // a whole write supersedes any stale parts
        return await writeWhole(name, content);
    },

    async partialAppend(partials, name, content, isDone, writeWhole) {
        if (typeof partials[name] !== 'string') {
            return { error: `No partial write in progress for ${name} — start with write_file {partial:true}.` };
        }
        partials[name] += content;
        if (isDone !== true) {
            return { ok: true, buffered: partials[name].length, note: `${partials[name].length} chars buffered. Continue with append_file; set done:true on the final part.` };
        }
        const whole = partials[name];
        delete partials[name];
        return await writeWhole(name, whole);
    }
};

/**
 * BuildStatus — the in-flight build's state, OUTSIDE the DOM. Progress cards
 * and banners are ephemeral UI; navigating away and back must not lose the
 * timeline. AgentTools._runBuild feeds every engine event in here; the chat
 * page restores its card from it on re-entry and App Studio renders a live
 * banner from it. One build runs at a time (both engines enforce that).
 */
const BuildStatus = {
    current: null,   // { kind, convId, startedAt, steps:[{text,cls}], activity, status, summary, id, endedAt }

    begin(kind, convId) {
        this.current = {
            kind, convId,
            startedAt: Date.now(), endedAt: null,
            steps: [], activity: '',
            status: 'building', summary: '', id: null
        };
    },

    event(e) {
        const c = this.current;
        if (!c || !e) return;
        const settleActive = (cls) => {
            // The active status row may be buried under later tool rows —
            // settle whichever step is currently active, wherever it is.
            for (let i = c.steps.length - 1; i >= 0; i--) {
                if (c.steps[i].cls === 'active') { c.steps[i].cls = cls; break; }
            }
        };
        if (e.type === 'status') {
            settleActive('done');
            c.activity = '';
            if (e.message) c.steps.push({ text: e.message, cls: 'active' });
        } else if (e.type === 'tool') {
            if (e.message) c.steps.push({ text: e.message, cls: 'done' });
        } else if (e.type === 'thinking' || e.type === 'model') {
            const len = (e.message || '').length;
            const label = e.type === 'thinking' ? 'Reasoning' : 'Writing';
            c.activity = len > 900 ? `${label}… ${(len / 1000).toFixed(1)}k characters` : `${label}…`;
        } else if (e.type === 'error') {
            settleActive('failed');
            c.status = 'error'; c.summary = e.message || ''; c.activity = ''; c.endedAt = Date.now();
        } else if (e.type === 'done') {
            settleActive('done');
            c.status = 'done'; c.summary = e.summary || ''; c.id = e.appId || e.artifactId || null;
            c.activity = ''; c.endedAt = Date.now();
        }
        while (c.steps.length > 12) c.steps.shift();
    }
};
