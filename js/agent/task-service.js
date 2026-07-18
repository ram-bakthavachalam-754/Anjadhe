/**
 * TaskService — task mode: plan → act → verify → report
 * (docs/COWORK_AGENT.md §4, phase C4).
 *
 * The behavioral difference between chatbot and coworker: the user hands
 * over an OUTCOME, the harness plans it as steps, executes each step in a
 * bounded tool loop, adversarially verifies the work, and reports back —
 * interruptible and inspectable the whole way.
 *
 * Reliability is engineered in the harness, not the prompt (the design
 * target is a ~12B local model):
 *   - the plan is one forced-JSON call, capped at 6 steps, each naming the
 *     tool groups it needs — a step's LLM calls carry ONLY those groups
 *     plus core, and NO briefing (the goal + step is the context), keeping
 *     step prompts inside the same budget chat uses
 *   - steps end with a DONE:/FAILED: sentinel line; runaway caps bound
 *     iterations per step, tool calls per task, and wall-clock
 *   - the verify pass gets read-only tools only, then a tiny forced-JSON
 *     call turns its findings into per-step verdicts; failed steps re-run
 *     ONCE with the issue attached, then the report is honest about the rest
 *
 * Every tool call rides the SAME permission gate as chat
 * (AgentService._resolvePermission → confirm dialog → PermissionManager);
 * a denied permission pauses the task as awaiting_user instead of plowing on.
 *
 * Tasks persist in the `agent-tasks` StorageManager key (synced — it's user
 * content). A task interrupted by an app restart resumes as `paused`, never
 * auto-runs.
 */

const TaskService = {
    STORE_KEY: 'agent-tasks',
    MAX_TASKS: 30,

    // Runaway caps (per docs: per-step iteration caps, per-task budgets).
    MAX_STEPS: 6,
    MAX_STEP_ITERATIONS: 6,
    MAX_TOTAL_TOOL_CALLS: 30,
    MAX_WALL_CLOCK_MS: 10 * 60 * 1000,
    MAX_VERIFY_ITERATIONS: 4,

    _controls: new Map(),   // taskId -> { pause: bool, cancel: bool }

    // ── Store ────────────────────────────────────────────────────────────

    _all() {
        const t = StorageManager.get(this.STORE_KEY);
        return Array.isArray(t) ? t : [];
    },

    _saveAll(tasks) {
        StorageManager.set(this.STORE_KEY, tasks.slice(0, this.MAX_TASKS));
    },

    get(taskId) {
        return this._all().find(t => t && t.id === taskId) || null;
    },

    list() {
        const tasks = this._all();
        return (typeof ProfileManager !== 'undefined')
            ? ProfileManager.filterByActiveProfile(tasks)
            : tasks;
    },

    _update(taskId, patch) {
        const tasks = this._all();
        const t = tasks.find(x => x && x.id === taskId);
        if (!t) return null;
        Object.assign(t, patch, { updatedAt: new Date().toISOString() });
        this._saveAll(tasks);
        this._notify(t);
        return t;
    },

    _log(taskId, message) {
        const tasks = this._all();
        const t = tasks.find(x => x && x.id === taskId);
        if (!t) return;
        t.log.push({ at: new Date().toISOString(), message: String(message).slice(0, 500) });
        if (t.log.length > 100) t.log.splice(0, t.log.length - 100);
        this._saveAll(tasks);
    },

    _notify(task) {
        try {
            if (typeof AgentUI !== 'undefined' && AgentUI.onTaskUpdate) AgentUI.onTaskUpdate(task);
        } catch { /* display must never break the run */ }
    },

    /**
     * App-start hygiene: anything that was mid-flight when the app died
     * resumes as paused — a task must never auto-run on launch.
     */
    init() {
        const tasks = this._all();
        let changed = false;
        for (const t of tasks) {
            if (t && ['planning', 'running', 'verifying'].includes(t.status)) {
                t.status = 'paused';
                t.note = 'Paused by app restart — resume from the task card.';
                changed = true;
            }
        }
        if (changed) this._saveAll(tasks);
    },

    // ── LLM plumbing (same seam the engines use — one brain) ─────────────

    _model() {
        if (typeof AgentService !== 'undefined' && AgentService.getActiveModel) {
            const m = AgentService.getActiveModel(AgentService.activeConversationId);
            if (m) return m;
        }
        return StorageManager.get('agent-settings')?.selectedModel || null;
    },

    async _chat(params) {
        return await window.electronLLM.chat({ model: this._model(), think: false, ...params });
    },

    // Tool groups that exist right now (feature flags trim files/shell/mcp).
    _availableGroups() {
        const groups = new Set(Object.values(AgentTools._toolGroups));
        return [...groups].filter(g => !g.startsWith('userapp:'));
    },

    _toolsForGroups(groupNames) {
        const wanted = new Set(groupNames || []);
        return AgentTools.definitions.filter(d => {
            const g = AgentTools._toolGroups[d.function.name] || 'core';
            if (d.function.name === 'start_task') return false;  // no nesting
            return g === 'core' || wanted.has(g);
        });
    },

    // ── Lifecycle ─────────────────────────────────────────────────────────

    /**
     * Create a task and produce its plan. Ends in `awaiting_user` — the
     * plan-approval card is the consent moment; nothing executes before
     * approve().
     */
    async start(goal, conversationId) {
        const text = String(goal || '').trim();
        if (!text) return { error: 'goal required' };
        if (this._all().some(t => ['planning', 'running', 'verifying'].includes(t?.status))) {
            return { error: 'Another task is already running. One task at a time.' };
        }

        const task = {
            id: 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            conversationId: conversationId || null,
            goal: text,
            plan: [],
            status: 'planning',
            note: '',
            stepIndex: 0,
            retried: false,
            toolCalls: 0,
            profile: (typeof ProfileManager !== 'undefined') ? ProfileManager.getProfileForNewItem() : null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            log: []
        };
        this._saveAll([task, ...this._all()]);
        this._controls.set(task.id, { pause: false, cancel: false });
        this._notify(task);

        const groups = this._availableGroups();
        const planResp = await this._chat({
            messages: [
                { role: 'system', content:
                    'You break a user goal into a SHORT checklist of concrete steps for an assistant that has tools.\n' +
                    `Available tool groups: ${groups.join(', ')}. Steps may also rely on always-available core tools (search, web, notes, schedule list).\n` +
                    'Reply ONLY with JSON: {"steps":[{"step":"imperative description","tools":["group",...]}]}\n' +
                    `Rules: at most ${this.MAX_STEPS} steps; each step one action; tools lists only groups from the list above (may be empty).` },
                { role: 'user', content: `Goal: ${text}` }
            ],
            format: 'json',
            options: { num_predict: 800 },
            maxTokens: 800,
            logTag: 'task-plan'
        });
        if (planResp?.error) {
            return this._update(task.id, { status: 'failed', note: `Planning failed: ${planResp.error}` }) && { error: planResp.error };
        }

        let steps = [];
        try {
            const parsed = JSON.parse(planResp?.message?.content || '{}');
            steps = (parsed.steps || [])
                .filter(s => s && typeof s.step === 'string' && s.step.trim())
                .slice(0, this.MAX_STEPS)
                .map(s => ({
                    step: s.step.trim().slice(0, 200),
                    tools: (Array.isArray(s.tools) ? s.tools : []).filter(t => groups.includes(t)),
                    status: 'pending',
                    note: ''
                }));
        } catch { /* fall through to the empty-plan error */ }
        if (!steps.length) {
            this._update(task.id, { status: 'failed', note: 'The model could not produce a usable plan for this goal.' });
            return { error: 'no usable plan' };
        }

        this._log(task.id, `Planned ${steps.length} steps`);
        this._update(task.id, { plan: steps, status: 'awaiting_user', note: 'Review the plan, then run it.' });
        return { ok: true, taskId: task.id, steps: steps.map(s => s.step) };
    },

    /** User approved the plan — run it. */
    async approve(taskId) {
        const task = this.get(taskId);
        if (!task || task.status !== 'awaiting_user') return { error: 'task is not awaiting approval' };
        this._controls.set(taskId, { pause: false, cancel: false });
        this._update(taskId, { status: 'running', note: '' });
        this._run(taskId);  // fire and forget — the card tracks progress
        return { ok: true };
    },

    pause(taskId) {
        const c = this._controls.get(taskId);
        if (c) c.pause = true;
        return { ok: true };
    },

    async resume(taskId) {
        const task = this.get(taskId);
        if (!task || task.status !== 'paused') return { error: 'task is not paused' };
        this._controls.set(taskId, { pause: false, cancel: false });
        this._update(taskId, { status: 'running', note: '' });
        this._run(taskId);
        return { ok: true };
    },

    cancel(taskId) {
        const c = this._controls.get(taskId);
        if (c) c.cancel = true;
        const task = this.get(taskId);
        // Not mid-flight (awaiting_user / paused): settle immediately.
        if (task && ['awaiting_user', 'paused', 'planning'].includes(task.status)) {
            this._update(taskId, { status: 'failed', note: 'Cancelled by the user.' });
        }
        return { ok: true };
    },

    // ── The run loop ──────────────────────────────────────────────────────

    _interrupted(taskId) {
        const c = this._controls.get(taskId) || {};
        if (c.cancel) {
            this._update(taskId, { status: 'failed', note: 'Cancelled by the user.' });
            return true;
        }
        if (c.pause) {
            this._update(taskId, { status: 'paused', note: 'Paused — resume from the task card.' });
            return true;
        }
        return false;
    },

    async _run(taskId) {
        const startedAt = Date.now();
        try {
            let task = this.get(taskId);
            for (let i = task.stepIndex; i < task.plan.length; i++) {
                if (this._interrupted(taskId)) return;
                if (Date.now() - startedAt > this.MAX_WALL_CLOCK_MS) {
                    this._update(taskId, { status: 'failed', note: 'Task hit the 10-minute budget.' });
                    return;
                }
                this._update(taskId, { stepIndex: i });
                this._setStep(taskId, i, { status: 'active' });
                const result = await this._runStep(taskId, i);
                if (result.interrupted) return;
                this._setStep(taskId, i, { status: result.ok ? 'done' : 'failed', note: result.note });
                this._log(taskId, `Step ${i + 1}: ${result.ok ? 'done' : 'FAILED'} — ${result.note}`);
            }

            // Verify, retry failures once, report.
            task = this.get(taskId);
            this._update(taskId, { status: 'verifying', note: 'Checking the work…' });
            const verdicts = await this._verify(taskId);
            if (this._interrupted(taskId)) return;

            const failedIdx = (verdicts || [])
                .map((v, i) => (v && v.ok === false ? i : -1))
                .filter(i => i !== -1 && i < task.plan.length);
            if (failedIdx.length && !task.retried) {
                this._update(taskId, { status: 'running', retried: true, note: `Fixing ${failedIdx.length} step(s) that didn't check out…` });
                for (const i of failedIdx) {
                    if (this._interrupted(taskId)) return;
                    const issue = verdicts[i]?.issue || 'did not achieve its intent';
                    this._setStep(taskId, i, { status: 'active', note: `retry: ${issue}` });
                    const result = await this._runStep(taskId, i, issue);
                    if (result.interrupted) return;
                    this._setStep(taskId, i, { status: result.ok ? 'done' : 'failed', note: result.note });
                }
            }

            await this._report(taskId, verdicts);
        } catch (e) {
            console.error('[task] run failed:', e);
            this._update(taskId, { status: 'failed', note: `Task crashed: ${e.message}` });
        }
    },

    _setStep(taskId, index, patch) {
        const tasks = this._all();
        const t = tasks.find(x => x && x.id === taskId);
        if (!t || !t.plan[index]) return;
        Object.assign(t.plan[index], patch);
        t.updatedAt = new Date().toISOString();
        this._saveAll(tasks);
        this._notify(t);
    },

    /**
     * One step: a bounded tool loop with ONLY the step's tool groups + core,
     * no briefing. Ends on a DONE:/FAILED: line, a no-tool reply, or the
     * iteration cap.
     */
    async _runStep(taskId, index, retryIssue) {
        const task = this.get(taskId);
        const step = task.plan[index];
        const tools = this._toolsForGroups(step.tools);
        const messages = [
            { role: 'system', content:
                'You are executing ONE step of an approved plan, using tools. Do only this step.\n' +
                'When the step is complete, reply with a single line: DONE: <what you did>.\n' +
                'If you cannot complete it, reply: FAILED: <why>.' },
            { role: 'user', content:
                `Overall goal: ${task.goal}\n` +
                `Plan so far: ${task.plan.map((s, i) => `${i + 1}. ${s.step}${s.status === 'done' ? ` (done: ${s.note})` : ''}`).join(' | ')}\n` +
                `Your step (#${index + 1}): ${step.step}` +
                (retryIssue ? `\nA verification pass found a problem with your earlier attempt: ${retryIssue}. Fix it.` : '') }
        ];

        for (let iter = 0; iter < this.MAX_STEP_ITERATIONS; iter++) {
            if (this._interrupted(taskId)) return { interrupted: true };

            const resp = await this._chat({
                messages, tools,
                options: { num_predict: 1500 },
                maxTokens: 1500,
                logTag: 'task-step'
            });
            if (resp?.error) return { ok: false, note: `model error: ${resp.error}` };
            const msg = resp?.message || {};
            (msg.tool_calls || []).forEach((tc, i) => { if (!tc.id) tc.id = `call_${Date.now().toString(36)}_${i}`; });
            messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });

            const calls = msg.tool_calls || [];
            if (!calls.length) {
                const text = (msg.content || '').trim();
                const failed = /^FAILED:/i.test(text);
                return { ok: !failed, note: text.replace(/^(DONE|FAILED):\s*/i, '').slice(0, 200) || 'completed' };
            }

            for (const tc of calls) {
                const name = tc.function?.name;
                let args = tc.function?.arguments;
                if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }

                // Task-level budget.
                const t = this.get(taskId);
                if (t.toolCalls >= this.MAX_TOTAL_TOOL_CALLS) {
                    return { ok: false, note: `hit the ${this.MAX_TOTAL_TOOL_CALLS}-tool-call budget` };
                }
                this._update(taskId, { toolCalls: t.toolCalls + 1 });

                // Same permission gate as chat. A denial pauses the task —
                // the user said no (or wasn't sure); don't plow on.
                let result;
                const perm = await AgentService._resolvePermission(name, args);
                if (perm.decision === 'deny') {
                    result = { error: `Blocked by permissions: ${perm.reason || 'not allowed'}` };
                } else if (perm.decision === 'ask') {
                    const decision = await AgentService._confirmWrite(name, args, perm);
                    if (!decision.approved) {
                        this._setStep(taskId, index, { status: 'pending', note: 'needs a permission you declined' });
                        this._update(taskId, { status: 'awaiting_user', note: `Step ${index + 1} needs a permission you declined. Resume to try again, or cancel.` });
                        PermissionManager.recordDecision('denied', name);
                        return { interrupted: true };
                    }
                    if (perm.grantClass && perm.suggestedScope) {
                        await PermissionManager.grantScoped(perm.grantClass, perm.suggestedScope, decision.scope || 'once');
                    } else if (decision.scope === 'session') {
                        PermissionManager.grantSession(name);
                    } else if (decision.scope === 'always') {
                        await PermissionManager.grantAlways(name);
                    }
                    PermissionManager.recordDecision(`approved-${decision.scope || 'once'}`, name);
                }
                if (!result) result = await AgentTools.execute(name, args || {});
                this._log(taskId, `tool ${name}: ${JSON.stringify(result).slice(0, 160)}`);
                messages.push({ role: 'tool', content: JSON.stringify(result), name, tool_call_id: tc.id });
            }
        }
        return { ok: false, note: `step did not finish within ${this.MAX_STEP_ITERATIONS} tool rounds` };
    },

    /**
     * Adversarial verify: read-only tools only, then a tiny forced-JSON
     * call converts the findings into per-step verdicts.
     */
    async _verify(taskId) {
        const task = this.get(taskId);
        const readOnlyTools = AgentTools.definitions.filter(d =>
            AgentService._isReadOnlyTool(d.function.name) && d.function.name !== 'start_task');

        const messages = [
            { role: 'system', content:
                'You verify completed work skeptically, using READ-ONLY tools to check reality. ' +
                'Did each step actually achieve its intent? When you have checked, reply with plain text listing, for each step number, OK or a one-line problem.' },
            { role: 'user', content:
                `Goal: ${task.goal}\nSteps and what the worker reported:\n` +
                task.plan.map((s, i) => `${i + 1}. ${s.step} → ${s.status}: ${s.note}`).join('\n') }
        ];

        let findings = '';
        for (let iter = 0; iter < this.MAX_VERIFY_ITERATIONS; iter++) {
            if (this._interrupted(taskId)) return null;
            const resp = await this._chat({
                messages, tools: readOnlyTools,
                options: { num_predict: 1000 },
                maxTokens: 1000,
                logTag: 'task-verify'
            });
            if (resp?.error) { findings = 'verification could not run: ' + resp.error; break; }
            const msg = resp?.message || {};
            (msg.tool_calls || []).forEach((tc, i) => { if (!tc.id) tc.id = `call_${Date.now().toString(36)}_${i}`; });
            messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
            const calls = msg.tool_calls || [];
            if (!calls.length) { findings = msg.content || ''; break; }
            for (const tc of calls) {
                const name = tc.function?.name;
                let args = tc.function?.arguments;
                if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
                const result = await AgentTools.execute(name, args || {});
                messages.push({ role: 'tool', content: JSON.stringify(result), name, tool_call_id: tc.id });
            }
        }

        // Findings → structured verdicts (forced JSON, no tools).
        const verdictResp = await this._chat({
            messages: [
                { role: 'system', content: `Convert these verification findings into JSON: {"verdicts":[{"step":1,"ok":true,"issue":""}...]} — one entry per step, 1-based, ${task.plan.length} entries.` },
                { role: 'user', content: `Steps:\n${task.plan.map((s, i) => `${i + 1}. ${s.step}`).join('\n')}\n\nFindings:\n${findings.slice(0, 2000)}` }
            ],
            format: 'json',
            options: { num_predict: 500 },
            maxTokens: 500,
            logTag: 'task-verdicts'
        });
        try {
            const parsed = JSON.parse(verdictResp?.message?.content || '{}');
            const out = new Array(task.plan.length).fill(null).map((_, i) => ({ ok: true, issue: '' }));
            for (const v of (parsed.verdicts || [])) {
                const i = (parseInt(v.step, 10) || 0) - 1;
                if (i >= 0 && i < out.length) out[i] = { ok: v.ok !== false, issue: String(v.issue || '').slice(0, 200) };
            }
            this._log(taskId, `Verify: ${out.filter(v => v.ok).length}/${out.length} steps check out`);
            return out;
        } catch {
            this._log(taskId, 'Verify verdicts unparseable — treating all steps as unverified-but-reported');
            return task.plan.map(() => ({ ok: true, issue: '' }));
        }
    },

    /** Final summary into the conversation + the card settles. */
    async _report(taskId, verdicts) {
        const task = this.get(taskId);
        const failed = task.plan.filter(s => s.status === 'failed');
        const lines = task.plan.map((s, i) => {
            const v = verdicts?.[i];
            const mark = s.status === 'done' ? (v && v.ok === false ? '△' : '✓') : '✗';
            return `${mark} ${s.step}${s.note ? ` — ${s.note}` : ''}`;
        });
        const ok = failed.length === 0;
        const summary = (ok
            ? `Task complete: ${task.goal}`
            : `Task finished with ${failed.length} unresolved step(s): ${task.goal}`)
            + '\n' + lines.join('\n');

        this._update(taskId, { status: ok ? 'done' : 'failed', note: ok ? 'Done.' : `${failed.length} step(s) unresolved — see the list.` });

        // Append the report to the task's conversation so it survives in
        // history (the card is ephemeral UI).
        try {
            const conv = AgentService.conversations.find(c => c.id === task.conversationId);
            if (conv) {
                conv.messages.push({ role: 'assistant', content: summary });
                conv.updatedAt = new Date().toISOString();
                AgentService._saveConversations();
                if (AgentService.activeConversationId === conv.id) {
                    AgentService.conversation = [...conv.messages];
                    if (typeof AgentUI !== 'undefined' && AgentUI.addMessage) AgentUI.addMessage('assistant', summary);
                }
            }
        } catch (e) {
            console.warn('[task] could not post report:', e);
        }
    }
};

if (typeof window !== 'undefined') {
    window.TaskService = TaskService;
    // Settle any task that was mid-flight when the app last quit.
    setTimeout(() => { try { TaskService.init(); } catch {} }, 0);
}
