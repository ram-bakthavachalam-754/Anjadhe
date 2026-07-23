/**
 * AI Activity App — live view of what's using the AI engine on this Mac.
 *
 * Renders AIActivity's active/recent lists (js/core/ai-activity.js): current
 * and recent AI work as human-readable activities with status and timing —
 * the user-facing answer to "why is the GPU busy when I'm not chatting".
 * Full request/response detail stays in Settings → LLM Logs; rows that went
 * through LLMLogger deep-link to their log entry.
 */

const AIActivityApp = {
    _tickTimer: null,
    _engineState: null,     // [{engine, model}] or null before first fetch
    _engineFetchedAt: 0,
    _engineFetching: false,

    init() {
        Breadcrumb.render('aiactivity-breadcrumb', [
            { label: 'AI Activity' }
        ]);
    },

    render() {
        const view = document.getElementById('aiactivity-view');
        if (!view.dataset.bound) {
            view.dataset.bound = 'true';
            document.getElementById('aiactivity-open-logs-btn')?.addEventListener('click', () => {
                SettingsApp.openLlmLogs();
            });
            document.getElementById('aiactivity-clear-btn')?.addEventListener('click', async () => {
                const ok = await UIUtils.confirm('Clear activity', 'Clear the recent AI activity list? Detailed LLM logs are kept.');
                if (ok) AIActivity.clear();
            });
            // Every row opens the activity detail modal. Delegated: rows
            // re-render on every activity event.
            const openFromRow = (e) => {
                const row = e.target.closest('[data-uid]');
                if (!row) return;
                const item = AIActivity.findByUid(row.dataset.uid);
                if (item) this._openDetail(item);
            };
            document.getElementById('aiactivity-recent')?.addEventListener('click', openFromRow);
            document.getElementById('aiactivity-now')?.addEventListener('click', openFromRow);
            AIActivity.subscribe(() => {
                if (this._isVisible()) {
                    this._renderAll();
                    // A start/end often means the engine state changed too.
                    this._refreshEngineState(true);
                }
            });
        }
        this._renderAll();
        this._refreshEngineState(true);
        this._startTicker();
    },

    _isVisible() {
        const view = document.getElementById('aiactivity-view');
        return !!view && view.classList.contains('active');
    },

    // 1s ticker while the page is open: keeps elapsed times moving and the
    // engine card fresh. Stops itself when the user navigates away.
    _startTicker() {
        if (this._tickTimer) return;
        this._tickTimer = setInterval(() => {
            if (!this._isVisible()) {
                clearInterval(this._tickTimer);
                this._tickTimer = null;
                return;
            }
            if (AIActivity.active.size > 0) this._renderAll();
            this._refreshEngineState();
        }, 1000);
    },

    // Which model is resident in memory right now — the other half of the GPU
    // story (a loaded model holds RAM even when idle). Throttled to every 5s;
    // both engines are local HTTP calls.
    async _refreshEngineState(force) {
        if (this._engineFetching) return;
        // Even forced refreshes (page open, activity events) keep a floor —
        // an email-insights run ends several calls per minute and each event
        // forcing a probe burst is pure noise.
        if (Date.now() - this._engineFetchedAt < (force ? 1500 : 5000)) return;
        this._engineFetching = true;
        try {
            const state = [];
            try {
                const s = await window.electronLlamaCpp?.status?.();
                if (s?.isReady && s.loadedModel) state.push({ engine: 'llama.cpp', model: s.loadedModel });
            } catch { /* engine not installed */ }
            this._engineState = state;
            this._engineFetchedAt = Date.now();
            if (this._isVisible()) this._renderStatus();
        } finally {
            this._engineFetching = false;
        }
    },

    _renderAll() {
        this._renderStatus();
        this._renderNow();
        this._renderRecent();
    },

    _renderStatus() {
        const el = document.getElementById('aiactivity-status');
        if (!el) return;
        const active = [...AIActivity.active.values()];
        const loading = active.filter(a => a.kind === 'engine');
        const requests = active.filter(a => a.kind === 'request');

        let headline, sub;
        if (loading.length) {
            headline = 'Loading a model into memory';
            sub = 'This is the heaviest moment for the GPU and memory — it passes once the model is ready.';
        } else if (requests.length) {
            const labels = [...new Set(requests.map(r => r.label))];
            headline = requests.length === 1
                ? `${labels[0]} is running`
                : `${requests.length} AI tasks are running`;
            sub = labels.join(' · ');
        } else {
            headline = 'The AI engine is idle';
            sub = 'Nothing is using AI right now.';
        }

        // Frame residency relative to where the user's model actually runs.
        // With a server/cloud brain, a bare "In memory: <local model>" read
        // as "this is the current model" — say where the brain lives first,
        // and mention a resident local model only as the RAM note it is.
        let entry = null, remote = false;
        try {
            entry = (typeof AgentService !== 'undefined' && AgentService.getDefaultEntry?.()) || null;
            remote = !!(entry && AgentService.isRemoteEngine?.(entry.engine));
        } catch { /* best-effort */ }
        const models = this._engineState;
        const chips = (list) => list.map(m =>
            `<span class="aiact-model-chip" title="Loaded models keep using memory until unloaded">${this._esc(AIActivity._shortModel(m.model))} <span class="aiact-model-engine">${this._esc(m.engine)}</span></span>`
        ).join(' ');
        let engineLine;
        if (models === null) {
            engineLine = '';
        } else if (remote) {
            const where = entry.engine === 'openai' ? 'the OpenAI API'
                : entry.engine === 'anthropic' ? 'the Anthropic API'
                : 'your server';
            const brain = `Your model (${this._esc(AIActivity._shortModel(entry.model))}) runs on ${where}.`;
            engineLine = models.length
                ? `<div class="aiact-engine-line">${brain} Also loaded locally: ${chips(models)} &mdash; holds memory until unloaded.</div>`
                : `<div class="aiact-engine-line">${brain} Nothing is loaded in this Mac's memory.</div>`;
        } else if (models.length) {
            engineLine = `<div class="aiact-engine-line">In memory: ${chips(models)}</div>`;
        } else {
            engineLine = '<div class="aiact-engine-line">No model is loaded in memory.</div>';
        }

        el.innerHTML = `
            <div class="aiact-status-head ${active.length ? 'is-busy' : ''}">
                <span class="aiact-dot ${active.length ? 'running' : 'idle'}"></span>
                <span class="aiact-status-headline">${this._esc(headline)}</span>
            </div>
            <div class="aiact-status-sub">${this._esc(sub)}</div>
            ${engineLine}
        `;
    },

    _renderNow() {
        const wrap = document.getElementById('aiactivity-now-section');
        const el = document.getElementById('aiactivity-now');
        if (!wrap || !el) return;
        const active = [...AIActivity.active.values()].sort((a, b) => a.startedAt - b.startedAt);
        wrap.hidden = active.length === 0;
        el.innerHTML = active.map(item => this._renderRow(item, true)).join('');
    },

    _renderRecent() {
        const el = document.getElementById('aiactivity-recent');
        if (!el) return;
        if (AIActivity.recent.length === 0) {
            el.innerHTML = '<p class="aiact-empty">No AI activity recorded on this Mac yet.</p>';
            return;
        }
        el.innerHTML = AIActivity.recent.map(item => this._renderRow(item, false)).join('');
    },

    _renderRow(item, isActive) {
        const metaBits = [];
        if (item.model) metaBits.push(this._esc(AIActivity._shortModel(item.model)));
        if (isActive) {
            metaBits.push(item.status === 'queued' ? 'waiting its turn' : this._elapsed(Date.now() - item.startedAt));
        } else {
            if (item.durationMs != null) metaBits.push(this._elapsed(item.durationMs));
            metaBits.push(this._timeAgo(item.endedAt || item.startedAt));
        }

        const chip = item.auto ? '<span class="aiact-chip">automatic</span>' : '';
        const errLine = item.status === 'failed' && item.error
            ? `<div class="aiact-error">${this._esc(String(item.error).slice(0, 160))}</div>` : '';

        return `
            <div class="aiact-row is-clickable" data-uid="${this._esc(item.uid || '')}" title="Show details">
                <span class="aiact-dot ${item.status}"></span>
                <div class="aiact-main">
                    <div class="aiact-label">${this._esc(item.label)} ${chip}</div>
                    ${item.desc ? `<div class="aiact-desc">${this._esc(item.desc)}</div>` : ''}
                    ${errLine}
                </div>
                <div class="aiact-meta">${metaBits.join(' · ')}</div>
            </div>
        `;
    },

    // ── Detail modal — what exactly this activity is/was doing ──

    _openDetail(item) {
        if (typeof Modal === 'undefined' || !Modal.create) return;
        const running = item.status === 'running' || item.status === 'queued';
        const statusText = {
            queued: 'Waiting its turn behind the request in flight',
            running: 'Running now',
            done: 'Finished',
            failed: 'Failed',
            stopped: 'Stopped'
        }[item.status] || item.status;

        const rows = [];
        const add = (label, value) => { if (value) rows.push({ label, value }); };

        add('What', `${item.label}${item.desc ? ' — ' + item.desc : ''}`);
        add('Started by', item.kind === 'engine' ? 'The app (engine housekeeping)'
            : (item.auto ? 'The app, automatically in the background' : 'You'));
        add('Status', statusText + (item.status === 'failed' && item.error ? ` — ${item.error}` : ''));
        add('Model', item.model ? AIActivity._shortModel(item.model) : null);
        add('Runs on', item.kind === 'engine' ? 'This Mac (llama.cpp)'
            : item.local ? 'This Mac (llama.cpp)'
            : item.engine === 'openai' ? 'OpenAI (your API key)'
            : item.engine === 'anthropic' ? 'Anthropic (your API key)'
            : 'Your server');
        if (item.kind === 'request') {
            add('Priority', item.jobClass === 'interactive'
                ? 'Interactive — runs ahead of background work'
                : 'Background — waits for chat and other background work');
            const sizeBits = [];
            if (item.msgs) sizeBits.push(`${item.msgs} message${item.msgs === 1 ? '' : 's'}`);
            if (item.promptChars) sizeBits.push(`~${Math.round(item.promptChars / 4).toLocaleString()} prompt tokens`);
            if (item.toolCount) sizeBits.push(`${item.toolCount} tools offered`);
            add('Request size', sizeBits.join(' · '));
        }
        add('Started', new Date(item.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
        if (item.queuedMs > 250) add('Waited in queue', this._elapsed(item.queuedMs));
        add(running ? 'Running for' : 'Took', this._elapsed((running ? Date.now() : (item.endedAt || item.startedAt)) - item.startedAt));
        if (item.promptTokens != null || item.completionTokens != null) {
            add('Tokens', `${(item.promptTokens || 0).toLocaleString()} in · ${(item.completionTokens || 0).toLocaleString()} out`);
        }

        const wrap = document.createElement('div');
        wrap.className = 'aiact-detail';
        wrap.innerHTML = rows.map(r => `
            <div class="aiact-detail-row">
                <div class="aiact-detail-label">${this._esc(r.label)}</div>
                <div class="aiact-detail-value">${this._esc(r.value)}</div>
            </div>
        `).join('');

        if (item.preview) {
            const p = document.createElement('div');
            p.className = 'aiact-detail-row';
            p.innerHTML = `
                <div class="aiact-detail-label">The request</div>
                <div class="aiact-detail-value aiact-detail-preview">&ldquo;${this._esc(item.preview)}${item.preview.length >= 200 ? '…' : ''}&rdquo;</div>`;
            wrap.appendChild(p);
        }

        // Full request/response detail lives in LLM Logs — link when this
        // call produced a log entry (calls through LLMLogger do; Maker /
        // App Studio / task-step calls don't create one).
        const logIdx = item.logId ? LLMLogger.logs.findIndex(l => l.id === item.logId) : -1;
        const foot = document.createElement('div');
        foot.className = 'aiact-detail-foot';
        if (logIdx >= 0) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'secondary-btn';
            btn.textContent = 'Open full request in LLM Logs';
            btn.addEventListener('click', () => {
                document.querySelector('.aiact-detail')?.closest('dialog')?.close();
                SettingsApp._showLogDetail(logIdx);
            });
            foot.appendChild(btn);
        } else {
            const hint = document.createElement('p');
            hint.className = 'aiact-detail-hint';
            hint.textContent = running && item.logId
                ? 'The full request and response will appear in LLM Logs once this finishes.'
                : 'No detailed log entry exists for this item.';
            foot.appendChild(hint);
        }
        wrap.appendChild(foot);

        Modal.create({ title: item.label, content: wrap, className: 'aiact-detail-modal' });
    },

    _elapsed(ms) {
        if (ms < 1000) return '<1s';
        if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
        return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
    },

    _timeAgo(ts) {
        if (!ts) return '';
        const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
        if (s < 60) return 'just now';
        if (s < 3600) return `${Math.floor(s / 60)} min ago`;
        if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
        return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
    },

    _esc(text) {
        const div = document.createElement('div');
        div.textContent = text == null ? '' : String(text);
        return div.innerHTML;
    }
};

AppManager.register('aiactivity', AIActivityApp);
