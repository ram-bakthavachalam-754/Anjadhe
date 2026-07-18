/**
 * SetupAssistant — a Stripe-style guided checklist shown after onboarding.
 *
 * Purpose: a fresh install has no data, so the assistant (where we land
 * per the positioning) would otherwise be an empty box. This walks the
 * user through the few steps that make the assistant actually useful:
 *
 *   1. Connect Google  -> Gmail + Calendar flow in (one sign-in).
 *   2. Inbox -> tasks   -> Email Insights derives action items as tasks.
 *   3. Ask the assistant -> now it has a week to plan (the airplane-test
 *                           prompt finally works because 1+2 made data).
 *
 * Step completion is read from REAL signals, not just clicks, so the
 * checklist reflects truth even if the user did a step elsewhere:
 *   - step1: AccountsManager has a connected account
 *   - step2: the Schedule store has an email-derived item (sourceEmailId)
 *   - step3: the user opened the guided assistant prompt (a flag)
 *
 * Persistence is per-device localStorage (Gmail is connected per-Mac and
 * not synced — same rationale as the legacy first-run card).
 */
const SetupAssistant = {
    _KEY: 'anjadhe_setup_assistant',
    _aiReady: null, // cached async check; null = unknown yet

    _state() {
        try {
            return JSON.parse(localStorage.getItem(this._KEY) || '{}') || {};
        } catch {
            return {};
        }
    },

    _save(patch) {
        const next = { ...this._state(), ...patch };
        try { localStorage.setItem(this._KEY, JSON.stringify(next)); } catch {}
        return next;
    },

    // ── Real completion signals ──────────────────────────────────────
    _step1Done() {
        try {
            return typeof AccountsManager !== 'undefined'
                && AccountsManager.getAll().length > 0;
        } catch { return false; }
    },

    _step2Done() {
        try {
            const s = StorageManager.get('schedule');
            const items = (s && Array.isArray(s.scheduleItems)) ? s.scheduleItems : [];
            return items.some(i => i && i.sourceEmailId);
        } catch { return false; }
    },

    _step3Done() {
        return this._state().askedAssistant === true;
    },

    // Web-search readiness lives in main (per-provider keys) — cached like
    // _aiReady and refreshed on render; a change re-paints every instance.
    _searchReady: null,
    async _refreshSearchReady() {
        let ready = false;
        try {
            const st = await window.electronSearch?.getStatus?.();
            ready = Object.values(st?.providers || {}).some(p => p && p.hasKey);
        } catch { /* stays false */ }
        const prev = this._searchReady;
        this._searchReady = ready;
        // Repaint on a real change (and on a first fetch that lands true,
        // since steps render "not done" while the cache is still null).
        if (prev !== ready && (prev !== null || ready)) this._rerender();
    },

    _cloudModelDone() {
        try {
            return typeof AgentService !== 'undefined'
                && AgentService.getModelList().some(e =>
                    e.engine === 'openai' || e.engine === 'anthropic');
        } catch { return false; }
    },

    steps() {
        return [
            {
                id: 'connect',
                title: 'Connect your Google account',
                desc: 'One sign-in links Gmail and Calendar so Anjadhe can work with your email and schedule. Optional, and you can disconnect anytime.',
                cta: 'Connect Google',
                done: this._step1Done(),
                action: () => this._connectGoogle()
            },
            {
                id: 'insights',
                title: 'Turn your inbox into tasks',
                desc: 'Anjadhe reads your important emails on your Mac and pulls out things you need to do, adding them to your tasks.',
                cta: 'Show me',
                done: this._step2Done(),
                action: () => this._openInsights()
            },
            {
                id: 'websearch',
                title: 'Give your assistant the web',
                desc: 'Add a search API key — Tavily has a free tier, Brave works too. The assistant then searches when you ask, sending only the query.',
                cta: 'Add a key',
                done: this._searchReady === true,
                action: () => this._openAiSettings()
            },
            {
                id: 'frontier',
                title: 'Add a frontier model',
                desc: 'Bring your own OpenAI or Anthropic API key to put Claude or GPT alongside your local model. Used only when you choose it.',
                cta: 'Add a model',
                done: this._cloudModelDone(),
                action: () => this._openAiSettings()
            },
            {
                id: 'ask',
                title: 'Ask your assistant',
                desc: 'It knows your week once email and calendar are in. Ask it to plan around your tasks and the things that matter in your inbox.',
                cta: 'Try it',
                done: this._step3Done(),
                action: () => this._askAssistant()
            }
        ];
    },

    completedCount() {
        return this.steps().filter(s => s.done).length;
    },

    isComplete() {
        // Tied to the live step list, not a hardcoded count: if a future
        // release adds a new setup step, completedCount drops below the
        // total and the assistant (and its Settings entry) resurface.
        return this.completedCount() >= this.steps().length;
    },

    isDismissed() {
        return this._state().dismissed === true;
    },

    shouldShow() {
        return !this.isComplete() && !this.isDismissed();
    },

    dismiss() {
        this._save({ dismissed: true });
        this._removeRendered();
    },

    // Clear the dismissed flag so the checklist surfaces again. Used by
    // the Settings entry point — a user who said "Maybe later" should be
    // able to come back to it.
    reopen() {
        this._save({ dismissed: false });
    },

    // AI is "set up" if a local model was selected or the user connected
    // their own server. Async (llm settings live in the main process); we
    // cache and re-render once known.
    async _refreshAiReady(rerenderTarget) {
        try {
            const a = StorageManager.get('agent-settings');
            if (a && a.selectedModel) { this._aiReady = true; }
            else if (window.electronLLM && window.electronLLM.getSettings) {
                const s = await window.electronLLM.getSettings();
                this._aiReady = !!(s && s.provider === 'custom' && s.customBaseUrl);
            } else {
                this._aiReady = false;
            }
        } catch { this._aiReady = false; }
        if (rerenderTarget && rerenderTarget.isConnected) this.renderFull(rerenderTarget);
    },

    // ── Actions ──────────────────────────────────────────────────────
    async _connectGoogle() {
        if (typeof AccountsManager === 'undefined' || !window.electronAccounts) return;
        if (!(await AccountsManager.confirmGoogleConnect())) return;
        if (typeof UIUtils !== 'undefined') UIUtils.showToast('Opening Google sign-in…', 'info');
        try {
            const r = await window.electronAccounts.googleOAuth();
            if (r && r.success && r.email) {
                AccountsManager.addOrUpdate({
                    email: r.email,
                    provider: 'google',
                    displayName: r.displayName,
                    enabledServices: r.services || ['mail', 'calendar']
                });
                if (typeof UIUtils !== 'undefined') UIUtils.showToast(`Connected ${r.email}`, 'success');
                this._rerender();
                this._syncConnectedGoogle();
            } else if (r && r.error && typeof UIUtils !== 'undefined') {
                UIUtils.showToast(`Connection failed: ${r.error}`, 'error');
            }
        } catch (e) {
            if (typeof UIUtils !== 'undefined') UIUtils.showToast(`Connection error: ${e.message}`, 'error');
        }
    },

    // After connecting, pull email + calendar in the background so the user
    // doesn't have to open each app to kick off the first fetch. Both apps
    // already poll headless (deltaSync / syncEvents run off-view), so this is
    // just an immediate first run. AccountsManager.addOrUpdate() already wrote
    // the new account into the email/calendar stores via syncToApps(); we
    // reload each app so it picks it up, then sync. Best-effort and quiet.
    async _syncConnectedGoogle() {
        try {
            if (typeof EmailApp !== 'undefined' && typeof EmailApp.loadData === 'function') {
                await EmailApp.loadData();
                if (typeof EmailApp.scheduleNextPoll === 'function') EmailApp.scheduleNextPoll();
                if (typeof EmailApp.deltaSync === 'function') EmailApp.deltaSync();
            }
        } catch (e) { console.warn('[setup-assistant] email sync after connect failed:', e?.message); }
        try {
            if (typeof CalendarApp !== 'undefined' && typeof CalendarApp.loadData === 'function') {
                CalendarApp.loadData();
                if (typeof CalendarApp.syncEvents === 'function') CalendarApp.syncEvents();
            }
        } catch (e) { console.warn('[setup-assistant] calendar sync after connect failed:', e?.message); }
    },

    _aiGateOrRun(run) {
        if (this._aiReady === false) {
            if (typeof UIUtils !== 'undefined') {
                UIUtils.showToast('Finish setting up your AI in Settings → AI Models first.', 'info');
            }
            if (typeof AppManager !== 'undefined') AppManager.openApp('settings');
            return;
        }
        run();
    },

    _openInsights() {
        // Guide the user to the live feature rather than running a hidden
        // batch pipeline — the Email app opens on its Insights view and
        // its existing analysis flow extracts action items into tasks.
        this._aiGateOrRun(() => {
            if (typeof AppManager !== 'undefined') AppManager.openApp('email');
        });
    },

    _openAiSettings() {
        // Search keys and BYOK model entries both live in Settings › AI
        // Assistant — land the user on that page directly.
        if (typeof AppManager !== 'undefined') AppManager.openApp('settings');
        setTimeout(() => {
            try { SettingsApp.openLLMSettings(); } catch { /* view not ready */ }
        }, 50);
    },

    _askAssistant() {
        this._save({ askedAssistant: true });
        this._aiGateOrRun(() => {
            if (typeof AppManager !== 'undefined') AppManager.openApp('agent');
            setTimeout(() => {
                try {
                    const input = (typeof AgentUI !== 'undefined' && AgentUI.getInput)
                        ? AgentUI.getInput()
                        : document.getElementById('dash-agent-input');
                    if (input) {
                        input.value = 'Plan my week around my overdue tasks and anything important in my inbox.';
                        input.focus();
                    }
                } catch {}
            }, 200);
        });
    },

    _rerender() {
        // There can be more than one instance live at once (the dashboard
        // compact strip *and* the Settings sub-view full card). querySelector
        // would only catch the first in DOM order — the dashboard strip —
        // leaving the Settings card stale. Re-render every instance.
        const nodes = Array.from(document.querySelectorAll('[data-setup-assistant]'));
        const seen = new Set();
        let popoverDone = false;
        nodes.forEach(node => {
            if (node.dataset.variant === 'popover') {
                // Body-anchored floating variant — re-render in place once.
                if (!popoverDone) { this.renderPopover(); popoverDone = true; }
                return;
            }
            const parent = node.parentElement || node;
            if (seen.has(parent)) return;
            seen.add(parent);
            if (node.dataset.variant === 'compact') {
                this.renderCompact(parent);
            } else {
                // Keep the card alive in the Settings sub-view even if this
                // action completed the last step (shouldShow() would be false).
                this.renderFull(parent, { force: parent.id === 'setup-assistant-host' });
            }
        });
    },

    _removeRendered() {
        document.querySelectorAll('[data-setup-assistant]').forEach(n => n.remove());
    },

    // ── Rendering ────────────────────────────────────────────────────
    _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },

    /** One checklist row (number/check, title, description, CTA). Shared by
     *  the full card and the floating popover. */
    _stepRow(s, i) {
        const row = document.createElement('div');
        row.className = 'setup-assistant-step' + (s.done ? ' done' : '');
        const mark = s.done ? '&#10003;' : (i + 1);
        row.innerHTML =
            `<span class="setup-assistant-mark">${mark}</span>
             <div class="setup-assistant-info">
                 <span class="setup-assistant-step-title">${this._esc(s.title)}</span>
                 <span class="setup-assistant-step-desc">${this._esc(s.desc)}</span>
             </div>`;
        if (!s.done) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'secondary-btn setup-assistant-cta';
            btn.textContent = s.cta;
            btn.addEventListener('click', () => s.action());
            row.appendChild(btn);
        }
        return row;
    },

    /**
     * Full checklist card — used in the assistant empty state.
     * Pass { force: true } (the Settings entry point) to render even when
     * complete or dismissed, so it works as an always-available review.
     */
    renderFull(container, opts) {
        if (!container) return;
        const force = !!(opts && opts.force);
        container.querySelectorAll('[data-setup-assistant]').forEach(n => n.remove());
        if (!force && !this.shouldShow()) return;

        if (this._aiReady === null) this._refreshAiReady(container);
        this._refreshSearchReady();

        const steps = this.steps();
        const done = steps.filter(s => s.done).length;

        const card = document.createElement('div');
        card.className = 'setup-assistant';
        card.setAttribute('data-setup-assistant', '');
        card.dataset.variant = 'full';

        const header = document.createElement('div');
        header.className = 'setup-assistant-head';
        header.innerHTML =
            `<div class="setup-assistant-title">Set up more</div>
             <div class="setup-assistant-progress">${done} of ${steps.length} done</div>`;
        card.appendChild(header);

        const list = document.createElement('div');
        list.className = 'setup-assistant-list';
        steps.forEach((s, i) => list.appendChild(this._stepRow(s, i)));
        card.appendChild(list);

        if (done >= steps.length) {
            const allset = document.createElement('div');
            allset.className = 'setup-assistant-allset';
            allset.textContent = "You're all set.";
            card.appendChild(allset);
        } else {
            const foot = document.createElement('button');
            foot.type = 'button';
            foot.className = 'setup-assistant-dismiss';
            foot.textContent = 'Maybe later';
            foot.addEventListener('click', () => this.dismiss());
            card.appendChild(foot);
        }

        container.prepend(card);
    },

    /** Compact resumable strip — used on the dashboard. */
    renderCompact(container) {
        if (!container) return;
        container.querySelectorAll('[data-setup-assistant]').forEach(n => n.remove());
        if (!this.shouldShow()) return;

        const done = this.completedCount();
        const total = this.steps().length;
        const strip = document.createElement('div');
        strip.className = 'setup-assistant-strip';
        strip.setAttribute('data-setup-assistant', '');
        strip.dataset.variant = 'compact';
        strip.innerHTML =
            `<span class="setup-assistant-strip-text">Set up more of Anjadhe &mdash; ${done} of ${total} done</span>`;

        const cont = document.createElement('button');
        cont.type = 'button';
        cont.className = 'primary-btn setup-assistant-strip-btn';
        cont.textContent = 'Continue';
        cont.addEventListener('click', () => {
            // "Continue" resumes the checklist on its dedicated page:
            // Settings › Setup Assistant (full card, always renderable).
            if (typeof AppManager !== 'undefined') AppManager.openApp('settings');
            setTimeout(() => {
                try { SettingsApp.openSetupAssistant(); } catch { /* view not ready */ }
            }, 50);
        });
        strip.appendChild(cont);

        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'setup-assistant-strip-x';
        x.setAttribute('aria-label', 'Dismiss');
        x.innerHTML = '&times;';
        x.addEventListener('click', () => this.dismiss());
        strip.appendChild(x);

        container.prepend(strip);
    },

    _popoverCollapsed() {
        // Collapsed unless the user explicitly expanded it: the panel is a
        // discovery surface, not a gate — first launch shows a quiet pill,
        // never a card over the assistant.
        return this._state().popoverCollapsed !== false;
    },

    /**
     * Floating bottom-right popover — the first-run setup surface for the full
     * AI Assistant view. Deliberately OUT of the message flow (body-anchored,
     * fixed) so it never blocks the empty-state greeting or the composer. It
     * collapses to a small pill the user can reopen; "Maybe later" dismisses it
     * everywhere. Idempotent — safe to call on every view render; it re-mounts
     * in place and no-ops (removing itself) once setup is complete or dismissed.
     */
    renderPopover() {
        if (typeof document === 'undefined' || !document.body) return;
        if (!this.shouldShow()) { this.removePopover(); return; }
        // Cache AI readiness for the step gates; no re-render needed since it
        // doesn't change what the popover shows (passing null skips the
        // renderFull re-render path, which would otherwise misfire onto body).
        if (this._aiReady === null) this._refreshAiReady(null);
        this._refreshSearchReady();

        this.removePopover();

        const steps = this.steps();
        const done = steps.filter(s => s.done).length;
        const collapsed = this._popoverCollapsed();

        const root = document.createElement('div');
        root.className = 'setup-popover' + (collapsed ? ' collapsed' : '');
        root.setAttribute('data-setup-assistant', '');
        root.dataset.variant = 'popover';

        if (collapsed) {
            const pill = document.createElement('button');
            pill.type = 'button';
            pill.className = 'setup-popover-pill';
            pill.innerHTML =
                `<span class="setup-popover-pill-dot" aria-hidden="true"></span>`
                + `<span>Learn what else you can do</span>`;
            pill.addEventListener('click', () => {
                this._save({ popoverCollapsed: false });
                this.renderPopover();
            });
            root.appendChild(pill);
        } else {
            const card = document.createElement('div');
            card.className = 'setup-popover-card';

            const head = document.createElement('div');
            head.className = 'setup-popover-head';
            head.innerHTML =
                `<div class="setup-assistant-title">Set up more</div>
                 <div class="setup-popover-head-actions">
                     <span class="setup-assistant-progress">${done} of ${steps.length} done</span>
                 </div>`;
            const min = document.createElement('button');
            min.type = 'button';
            min.className = 'setup-popover-min';
            min.setAttribute('aria-label', 'Minimize');
            min.innerHTML = '&#8211;';
            min.addEventListener('click', () => {
                this._save({ popoverCollapsed: true });
                this.renderPopover();
            });
            head.querySelector('.setup-popover-head-actions').appendChild(min);
            card.appendChild(head);

            const list = document.createElement('div');
            list.className = 'setup-assistant-list';
            steps.forEach((s, i) => list.appendChild(this._stepRow(s, i)));
            card.appendChild(list);

            const foot = document.createElement('button');
            foot.type = 'button';
            foot.className = 'setup-assistant-dismiss';
            foot.textContent = 'Maybe later';
            foot.addEventListener('click', () => this.dismiss());
            card.appendChild(foot);

            root.appendChild(card);
        }

        document.body.appendChild(root);
    },

    removePopover() {
        if (typeof document === 'undefined') return;
        document.querySelectorAll('.setup-popover[data-setup-assistant]').forEach(n => n.remove());
    }
};

if (typeof window !== 'undefined') window.SetupAssistant = SetupAssistant;
