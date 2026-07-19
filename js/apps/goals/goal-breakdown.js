/**
 * GoalBreakdown — break a goal into concrete tasks with the assistant.
 *
 * One-shot LLM pass (same one-brain routing + floor-model defenses as the
 * Actions filing pass) behind a confirm-before-add modal: the model proposes
 * 3–6 next tasks, the user unticks what they don't want, "Add selected"
 * materializes the rest via ScheduleApp.createTask + goal/area links — the
 * exact recipe TaskListUI's "+ New Task" uses. Nothing is ever auto-applied.
 *
 * Reached from the "Suggest tasks" button TaskListUI renders when a host
 * passes opts.aiBreakdown (the embedded Plan goal editor and the standalone
 * goal editor both do).
 */

const GoalBreakdown = {
    MAX_TASKS: 8,
    _busy: false,

    async suggest({ goalId, focusId }, opts = {}) {
        if (this._busy) return;
        const goal = (StorageManager.get('goals')?.goals || []).find(g => g.id === goalId);
        if (!goal) return;
        const existing = LinkManager.getTasksForGoal(goalId).map(t => t.title).filter(Boolean);

        this._busy = true;
        let modal;
        // Live surface while the model works: an animated status line, the
        // reasoning trace (think-enabled models), and the answer streaming
        // in — the wait is never a static sentence. Swapped for the
        // checkbox list once the output parses.
        modal = Modal.create({
            title: 'Suggest tasks',
            content: `<div class="goal-ai-body" id="goal-ai-body">
                <div class="goal-ai-status" id="goal-ai-status">Asking your assistant&hellip;</div>
                <div class="goal-ai-think" id="goal-ai-think" hidden></div>
                <div class="goal-ai-live" id="goal-ai-live" hidden></div>
            </div>`,
            buttons: [
                { text: 'Close', className: 'secondary-btn', onClick: () => modal.close() }
            ]
        });

        try {
            const suggestions = await this._callModel(goal, existing);
            const bodyEl = document.getElementById('goal-ai-body');
            if (!bodyEl) return;   // modal closed while the model thought
            if (suggestions.length === 0) {
                bodyEl.innerHTML = '<div class="goal-ai-wait">No suggestions came back for this goal. A short description of what &ldquo;done&rdquo; looks like usually helps.</div>';
                return;
            }
            this._renderSuggestions(bodyEl, modal, suggestions, { goalId, focusId }, opts);
        } catch (err) {
            const bodyEl = document.getElementById('goal-ai-body');
            if (bodyEl) bodyEl.innerHTML = `<div class="goal-ai-wait">Suggestion failed: ${UIUtils.escapeHtml(err?.message || 'the model did not answer')}</div>`;
        } finally {
            this._busy = false;
        }
    },

    // Append a chunk to a live block, revealing it on first content and
    // keeping it scrolled to the tail.
    _appendLive(id, chunk) {
        const el = document.getElementById(id);
        if (!el || !chunk) return;
        el.hidden = false;
        el.textContent += chunk;
        el.scrollTop = el.scrollHeight;
    },

    _setStatus(text) {
        const el = document.getElementById('goal-ai-status');
        if (el && el.textContent !== text) el.textContent = text;
    },

    async _callModel(goal, existing) {
        const today = ScheduleApp.getLocalToday();
        const userLines = [
            `Goal: ${goal.title}`,
            goal.description ? `Description: ${goal.description}` : '',
            goal.targetDate ? `Target date: ${goal.targetDate}` : '',
            existing.length ? `Existing tasks (do not repeat):\n${existing.map(t => `- ${t}`).join('\n')}` : ''
        ].filter(Boolean).join('\n');

        // Streamed so the modal can show reasoning + the answer forming.
        // NOTE the streaming path drops `format` (JSON-constrained
        // sampling), so the strict prompt + extractJsonObject prose
        // defenses below carry the parse on their own.
        let streamed = '';
        const result = await LLMLogger.callStream('goal-breakdown', {
            model: AgentService.model,
            logTag: 'goal-breakdown',
            messages: [
                {
                    role: 'system',
                    content: `You are a personal planning assistant. Today is ${today}.

Break the user's goal into concrete next tasks. Respond ONLY with a JSON object:
{"tasks": [{"title": "..."}, {"title": "...", "date": "YYYY-MM-DD"}]}

Rules:
- 3 to 6 tasks, each ONE concrete action starting with a verb, at most 10 words.
- Order them as the natural sequence of work.
- "date" is OPTIONAL: include it only when the goal's target date makes a schedule obvious; otherwise omit it.
- Never repeat the user's existing tasks.`
                },
                { role: 'user', content: userLines }
            ],
            stream: true
        }, (chunk, event) => {
            if (event === 'thinking') {
                this._setStatus('Thinking it through…');
                this._appendLive('goal-ai-think', chunk);
            } else if (event === 'thinking-done') {
                const think = document.getElementById('goal-ai-think');
                if (think) think.classList.add('is-done');
            } else if (chunk) {
                this._setStatus('Writing tasks…');
                this._appendLive('goal-ai-live', chunk);
                streamed += chunk;
            }
        });

        if (result?.error) throw new Error(result.error);
        const parsed = LLMLogger.extractJsonObject(result?.message?.content || streamed);
        const list = Array.isArray(parsed?.tasks) ? parsed.tasks : [];

        // Floor-model defense: keep only verifiable shapes, cap count and
        // length, drop duplicates of what the goal already has.
        const seen = new Set(existing.map(t => String(t).toLowerCase()));
        const out = [];
        for (const t of list) {
            const title = typeof t?.title === 'string' ? t.title.trim().slice(0, 140) : '';
            if (!title || seen.has(title.toLowerCase())) continue;
            seen.add(title.toLowerCase());
            const date = (typeof t?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.date)
                && !isNaN(new Date(t.date + 'T00:00:00')) && t.date >= today) ? t.date : null;
            out.push({ title, date });
            if (out.length >= this.MAX_TASKS) break;
        }
        return out;
    },

    _renderSuggestions(bodyEl, modal, suggestions, ctx, opts) {
        const today = ScheduleApp.getLocalToday();
        bodyEl.innerHTML = `
            <div class="goal-ai-lede">Suggested next tasks &mdash; untick any you don't want, then add.</div>
            ${suggestions.map((s, i) => `
                <label class="goal-ai-row">
                    <input type="checkbox" class="goal-ai-check" data-idx="${i}" checked>
                    <span class="goal-ai-title">${UIUtils.escapeHtml(s.title)}</span>
                    ${s.date ? `<span class="goal-ai-date">${UIUtils.escapeHtml(ScheduleUI.formatRelativeDate(s.date, today))}</span>` : ''}
                </label>`).join('')}
            <div class="goal-ai-actions">
                <button type="button" class="primary-btn" id="goal-ai-add">Add selected</button>
            </div>`;

        bodyEl.querySelector('#goal-ai-add').addEventListener('click', () => {
            const chosen = [...bodyEl.querySelectorAll('.goal-ai-check')]
                .filter(cb => cb.checked)
                .map(cb => suggestions[Number(cb.dataset.idx)])
                .filter(Boolean);
            this._addTasks(chosen, ctx);
            modal.close();
            if (chosen.length) UIUtils.showToast(`Added ${chosen.length} task${chosen.length === 1 ? '' : 's'}`, 'success');
            if (opts.onChanged) opts.onChanged();
        });
    },

    _addTasks(chosen, { goalId, focusId }) {
        for (const s of chosen) {
            const newId = ScheduleApp.createTask(s.title);
            if (!newId) continue;
            // Plan steps stay undated unless the model proposed a date —
            // createTask defaults to today, which would flood the front door.
            const item = ScheduleApp.scheduleItems.find(i => i.id === newId);
            if (item) {
                item.scheduledDate = s.date || null;
                item.modifiedAt = new Date().toISOString();
            }
            LinkManager.addLink('goals', goalId, 'schedule', newId);
            if (focusId) LinkManager.addLink('focus', focusId, 'schedule', newId);
        }
        if (chosen.length) ScheduleApp.saveData();
    }
};
