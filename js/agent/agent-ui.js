/**
 * Agent UI - Floating chat panel + full app view with conversation history
 */

const AgentUI = {
    isOpen: false,
    isInitialized: false,
    mode: 'panel', // 'panel' or 'app'

    init() {
        if (this.isInitialized) return;
        this.isInitialized = true;
        AgentService.loadConversations();
        this.setupPanelListeners();
        this.updateModelLabel();
        this.updateContextChip();
        // Migrate/load the model-entry list, then repaint the model chips —
        // the first paint above ran against the pre-migration settings.
        AgentService.ensureModelList?.().then(() => this.updateModelChip()).catch(() => {});
        this._setupLinkHandler();
        this._setupGlobalShortcut();
        this._setupContextCta();
        this._setupMemoryReclaim();
    },

    /**
     * Free the local model's RAM when the user isn't using the app — critical
     * on a 16 GB Mac. Three triggers:
     *   • idle timeout (no click/keypress for AgentService._idleUnloadMs)
     *   • macOS sleep (power 'suspend') and screen lock — immediate
     *   • manual: the overflow "Free memory" item and click on a Ready dot
     * Wired once. Cheap: activity handling just resets a timer.
     */
    _setupMemoryReclaim() {
        // Any interaction anywhere in the app counts as "still using it" and
        // pushes back the idle-unload countdown. Passive + capture so we see
        // the events without interfering with anything downstream.
        const bump = () => AgentService.noteActivity?.();
        ['pointerdown', 'keydown'].forEach((ev) =>
            document.addEventListener(ev, bump, { capture: true, passive: true }));
        // Start the countdown now — if the app opens and is never touched, the
        // model (once warmed) still gets reclaimed.
        AgentService.noteActivity?.();

        // Stepping away from the machine → free the RAM right away.
        try {
            window.electronEmail?.onPowerState?.((state) => {
                if (state === 'suspend') AgentService.unloadAllResident?.('sleep');
            });
        } catch { /* channel optional */ }
        try {
            window.electronAuth?.onLockScreen?.(() => AgentService.unloadAllResident?.('lock'));
        } catch { /* channel optional */ }

        // Manual "Free memory" item in the panel overflow menu.
        const unloadBtn = document.getElementById('agent-unload-btn');
        if (unloadBtn) {
            unloadBtn.addEventListener('click', () => {
                this._closeOverflowMenu?.();
                this._freeMemory();
            });
        }

        // Click a green "Ready" dot to free memory — the fast path that needs no
        // menu. Wired on every readiness surface; only acts when local+resident.
        ['agent-readiness', 'agent-app-readiness', 'dash-agent-readiness'].forEach((id) => {
            const el = document.getElementById(id);
            if (!el || el.dataset.unloadWired) return;
            el.dataset.unloadWired = '1';
            el.addEventListener('click', () => {
                if (this._lastReadinessState === 'ready' && this._readinessModelName) {
                    this._freeMemory();
                }
            });
        });
    },

    /** Unload all resident models on demand, with feedback + a readiness re-check. */
    async _freeMemory() {
        const freed = await AgentService.unloadAllResident?.('manual');
        if (typeof UIUtils !== 'undefined') {
            UIUtils.showToast(
                freed ? 'Model unloaded — RAM freed' : 'No model was loaded',
                freed ? 'success' : 'info'
            );
        }
        this.startReadinessWatch();
    },

    // Floating "Ask about this <thing>" CTA. Polls AgentContext every
    // 500ms; that's coarse but robust — covers all the ways an app's
    // "current item" can change (sidebar nav, in-app navigation, tab
    // switches, hash changes) without each app having to opt in to
    // notifying us. Cost is one provider invocation per tick, all of
    // which are O(1) reads of in-memory state.
    _setupContextCta() {
        const cta = document.getElementById('agent-context-cta');
        if (!cta) return;
        const labelEl = cta.querySelector('.agent-context-cta-label');

        cta.addEventListener('click', () => this.open());

        let lastLabel = null;
        const tick = () => {
            const block = (typeof AgentContext !== 'undefined') ? AgentContext.getActiveBlock() : null;
            if (!block) {
                if (cta.style.display !== 'none') cta.style.display = 'none';
                lastLabel = null;
                return;
            }
            const label = this._deriveContextLabel(block.title);
            if (label !== lastLabel) {
                labelEl.textContent = `Ask about ${label}`;
                lastLabel = label;
            }
            if (cta.style.display === 'none') cta.style.display = 'inline-flex';
        };

        tick();
        setInterval(tick, 500);
    },

    // Turn a provider title into a friendly inline label. Strips the
    // "CURRENT " prefix and any "(UNTRUSTED ...)" suffix, lowercases the
    // remainder, and prepends "this". Examples:
    //   "CURRENT NOTE"                                  -> "this note"
    //   "CURRENT WEB PAGE (UNTRUSTED EXTERNAL CONTENT)" -> "this web page"
    //   "CURRENT JOURNAL ENTRY"                         -> "this journal entry"
    _deriveContextLabel(title) {
        if (!title) return 'this';
        let s = String(title).replace(/\s*\([^)]*\)\s*/g, '').trim();
        if (s.toUpperCase().startsWith('CURRENT ')) s = s.substring(8);
        return `this ${s.toLowerCase()}`;
    },

    // Cmd+/ (or Ctrl+/) toggles the docked panel from anywhere. Skipped
    // when an editable element is focused — that key combo is too easy to
    // hit by accident while typing, and dragging the user out of their
    // textarea mid-sentence is worse than making them click the button.
    _setupGlobalShortcut() {
        document.addEventListener('keydown', (e) => {
            if (!(e.metaKey || e.ctrlKey) || e.key !== '/') return;
            const t = document.activeElement;
            const editable = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
            // Inside the agent input itself, the shortcut should still close
            // the panel — otherwise the user has no way to dismiss it via
            // keyboard once they've focused there.
            const isAgentInput = t && (t.id === 'agent-input' || t.id === 'agent-app-input');
            if (editable && !isAgentInput) return;
            e.preventDefault();
            this.toggle();
        });
    },

    // Delegated click handler — any http(s) link inside an agent bubble
    // opens in the user's default browser via Electron shell.openExternal.
    // Without this, target-less anchors navigate the app's BrowserWindow
    // (blanking out the app) and target="_blank" opens a new Electron
    // window with no browser UI. The app has no dedicated #agent-messages
    // handler because chat renders in both the floating panel and the full
    // app view — a document-level filter covers both.
    _setupLinkHandler() {
        document.addEventListener('click', (e) => {
            const target = e.target;
            if (!target || !target.closest) return;

            const a = target.closest('.agent-bubble a[href]');
            if (!a) return;
            const href = a.getAttribute('href');
            if (!href || !/^https?:/i.test(href)) return;
            e.preventDefault();
            if (window.electronAuth?.openExternal) {
                window.electronAuth.openExternal(href);
            } else {
                window.open(href, '_blank');
            }
        });
    },

    async updateModelLabel() {
        const convId = AgentService.activeConversationId;
        const conv = convId ? AgentService.conversations.find(c => c.id === convId) : null;

        // The active ENTRY names the model that answers — a per-conv
        // override resolves through getActiveEntry, and server entries carry
        // their own model name, so there is no separate provider-managed
        // label path anymore.
        const entry = AgentService.getActiveEntry(convId);
        const effective = (entry && entry.model) || AgentService.getActiveModel(convId) || '';
        const isOverride = !!(conv && conv.model);

        const paint = (el) => {
            if (!el) return;
            el.textContent = effective;
            el.classList.toggle('agent-model-label--override', isOverride);
            el.title = isOverride
                ? `Model for this chat: ${effective} (override). Click to change.`
                : `Model: ${effective}. Click to change.`;
            if (!el.dataset.modelClickWired) {
                el.dataset.modelClickWired = '1';
                el.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.openModelPicker();
                });
            }
        };

        paint(document.getElementById('agent-model-label'));
        paint(document.getElementById('agent-app-model-label'));

        // The effective model may have changed (override set/cleared, new
        // default) — its resident state is now unknown, so re-evaluate.
        this.startReadinessWatch();
    },

    /**
     * Compute the assistant's readiness and paint the header indicator.
     *
     * States:
     *   ready       — model resident in RAM (or remote provider); replies start fast
     *   preparing   — a warm/load is in flight (model loading into memory)
     *   idle        — local model installed but not loaded; first reply will be slow
     *   offline     — Ollama not running, or no model selected/installed
     *
     * Returns the resolved state so the poller can decide whether to keep
     * watching. Best-effort: any failure resolves to 'offline'.
     */
    async refreshReadiness() {
        let state = 'offline';
        let text = 'Offline';
        try {
            const llm = await window.electronLLM?.getSettings?.();
            // The active model ENTRY decides which engine's readiness matters;
            // the legacy provider setting is the fallback for pre-migration
            // installs.
            const entry = AgentService.getActiveEntry?.(AgentService.activeConversationId) || null;
            const isCloud = entry
                ? (entry.engine === 'openai' || entry.engine === 'anthropic')
                : (llm?.provider === 'openai' || llm?.provider === 'anthropic');
            if (isCloud) {
                // A cloud API manages its own model lifecycle — nothing to
                // warm or track locally; a missing key surfaces at send time.
                state = 'ready';
                text = (entry ? entry.engine : llm?.provider) === 'anthropic' ? 'Anthropic' : 'OpenAI';
                this._readinessModelName = null;
                this._paintReadiness(state, text);
                return state;
            }
            const isServer = entry ? entry.engine === 'server' : (llm?.provider) === 'custom';
            if (isServer) {
                // OpenAI-compatible server manages its own model lifecycle — the
                // app doesn't warm, unload, or track residency for it. But if no
                // endpoint is saved (neither on the entry nor the legacy custom
                // config), say so plainly instead of showing "ready" — otherwise
                // a chat just hard-fails with "no URL configured".
                if ((entry && entry.baseUrl) || llm?.customBaseUrl) {
                    state = 'ready'; text = 'Server';
                } else {
                    state = 'offline'; text = 'Not configured';
                }
                this._readinessModelName = null;
            } else {
                // "Is the engine available at all?" is engine-specific: Ollama
                // is a daemon that must be running; llama.cpp only needs the
                // binary on disk (its server spawns lazily with the model, so
                // installed-but-not-running is 'idle', not 'offline').
                let engineUp;
                if (entry ? entry.engine === 'llamacpp' : llm?.localBackend === 'llamacpp') {
                    const s = await window.electronLlamaCpp?.status?.();
                    engineUp = !!(s && s.isInstalled);
                } else {
                    engineUp = !!(await AgentService.checkOllama());
                }
                const model = (entry && entry.model)
                    || AgentService.getActiveModel(AgentService.activeConversationId)
                    || AgentService.model;
                // Remember the model so the composer hint and the cold-send
                // indicator can name what's loading.
                this._readinessModelName = model || null;
                const resident = model ? await AgentService.isModelResident(model) : false;
                if (!engineUp) {
                    state = 'offline'; text = 'Offline';
                } else if (!model) {
                    state = 'offline'; text = 'No model';
                } else if (AgentService._warming) {
                    // A warm/prewarm is occupying the runner. On first startup
                    // the weights go resident early but the full-prefix prewarm
                    // keeps prefilling (~30–40s); a message sent now queues
                    // behind it. So "warming" must win over "resident" —
                    // otherwise the dot says Ready while the runner is still
                    // busy, exactly the "I sent it on Ready but it wasn't" case.
                    state = 'preparing'; text = 'Preparing…';
                } else if (resident) {
                    // Weights in RAM and nothing prefilling — replies start fast.
                    state = 'ready'; text = 'Ready';
                } else if (AgentService.isConversationStreaming?.(AgentService.activeConversationId)) {
                    state = 'preparing'; text = 'Preparing…';
                } else {
                    state = 'idle'; text = 'Idle';
                }
            }
        } catch {
            state = 'offline'; text = 'Offline';
        }
        this._paintReadiness(state, text);
        return state;
    },

    /**
     * The waking-up hero shows only before the user has ever chatted, and
     * only when a LOCAL default model exists but isn't loaded yet. Remote
     * engines have nothing to warm; 'offline' would make "loading" a lie;
     * 'ready' means the normal greeting can do its job.
     */
    _shouldShowFirstWarmHero() {
        try {
            const chatted = AgentService.conversations.some(c =>
                (c.messages || []).some(m => m.role === 'user'));
            if (chatted) return false;
            const entry = AgentService.getDefaultEntry?.();
            if (!entry || AgentService.isRemoteEngine(entry.engine)) return false;
            return this._lastReadinessState !== 'ready'
                && this._lastReadinessState !== 'offline';
        } catch { return false; }
    },

    /**
     * Keep the waking-up hero truthful as the readiness watch ticks: live
     * status line while loading, and a dissolve into the normal greeting the
     * moment the model is ready (or the engine turns out to be offline —
     * never hold a loading screen for a load that isn't happening).
     */
    _paintFirstWarmHero(state) {
        const hero = document.querySelector('.agent-empty-hero.agent-first-warm');
        if (!hero) return;
        if (state === 'ready' || state === 'offline') {
            hero.classList.remove('agent-first-warm');
            hero.classList.add('agent-first-warm-done');
            hero.innerHTML = '<h2 class="agent-empty-hero-title">How can I help?</h2>';
            return;
        }
        const status = hero.querySelector('.agent-first-warm-status');
        if (status) {
            const model = this._readinessModelName || 'your model';
            status.textContent = state === 'preparing'
                ? `Loading ${model} into memory…`
                : `Getting ${model} ready…`;
        }
    },

    _paintReadiness(state, text) {
        // Cache the latest state so a cold send can label its wait as a model
        // load (see _isModelCold / sendMessage) without an async re-check.
        this._lastReadinessState = state;
        const titleFor = {
            ready: 'Model is loaded — replies start immediately',
            preparing: 'Loading the model into memory…',
            idle: 'Model is installed but not loaded — the first reply will be slower while it loads',
            offline: 'Local model unavailable'
        };
        ['agent-readiness', 'agent-app-readiness', 'dash-agent-readiness'].forEach((id) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.dataset.state = state;
            el.title = titleFor[state] || 'Assistant status';
            const t = el.querySelector('.agent-readiness-text');
            if (t) t.textContent = text;
        });
        this._paintComposerWarming(state);
        this._paintUnloadControls(state);
        this._paintFirstWarmHero(state);
    },

    /**
     * Show the "free memory" affordances only when there's actually a local
     * model resident to free: the overflow menu item, and a clickable, pointer-
     * cursor Ready dot. Cloud ('ready' with no model name) and any non-ready
     * state hide them.
     */
    _paintUnloadControls(state) {
        const canFree = state === 'ready' && !!this._readinessModelName;
        const btn = document.getElementById('agent-unload-btn');
        if (btn) btn.hidden = !canFree;
        ['agent-readiness', 'agent-app-readiness', 'dash-agent-readiness'].forEach((id) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.classList.toggle('agent-readiness--clickable', canFree);
            if (canFree) el.title = `${this._readinessModelName} loaded — click to free memory`;
        });
    },

    /** True when a message sent right now would wait on a local model load
     *  rather than starting to generate immediately. Cheap/synchronous — reads
     *  the cached readiness state plus the service's live warming flag. */
    _isModelCold() {
        if (AgentService._warming === true) return true;
        const s = this._lastReadinessState;
        return s === 'idle' || s === 'preparing';
    },

    /** The model name that would answer the active conversation, for labels. */
    _activeModelName() {
        try {
            return AgentService.getActiveModel?.(AgentService.activeConversationId)
                || AgentService.model || '';
        } catch { return ''; }
    },

    /**
     * Soft gate: while the local model is loading, show a thin hint above the
     * composer and mark the send button as "warming" so the wait reads as a
     * one-time load, not a slow assistant. Never disables send — the user can
     * always type and send; the message just queues behind the load. Hidden
     * once ready, offline, cloud, or while a reply is already streaming (the
     * in-stream indicator covers that case).
     */
    _paintComposerWarming(state) {
        const streaming = AgentService.isConversationStreaming?.(AgentService.activeConversationId);
        const show = (state === 'preparing' || state === 'idle') && !streaming;
        const model = this._readinessModelName;
        const named = model ? ` ${model}` : ' the model';
        const text = state === 'preparing'
            ? `Warming up${named}… ready in a moment`
            : `Your first message loads${named} into memory`;

        ['agent-warming-hint', 'agent-app-warming-hint'].forEach((id) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.hidden = !show;
            const t = el.querySelector('.agent-warming-hint-text');
            if (t) t.textContent = text;
        });

        // Subtle affordance on the send button, but not mid-stream — the
        // composer is in its streaming layout then (queue + stop buttons).
        ['agent-send-btn', 'agent-app-send-btn', 'dash-agent-send-btn'].forEach((id) => {
            const b = document.getElementById(id);
            if (!b || this._streamingUI) return;
            b.classList.toggle('agent-send-btn--warming', show);
        });
    },

    /**
     * Is a surface showing the readiness dot currently on screen? The dot lives
     * in the home "Ask Anjadhe" box (dashboard), the full Assistant view, and
     * the docked panel. We only poll while one of these is visible.
     */
    _readinessVisible() {
        if (this.isOpen) return true; // docked panel
        if (typeof AppManager === 'undefined') return false;
        return AppManager.currentApp === null || AppManager.currentApp === 'agent';
    },

    /**
     * Refresh readiness now and keep it live while a dot surface is visible.
     * Polls regardless of state — the model can become resident via a path that
     * doesn't set _warming (e.g. a background load, or warming kicked off from
     * another view), so we must keep checking even from 'idle' or the dot would
     * sit stale until a manual refresh. Cadence scales with state (fast while
     * loading, slow once ready, just enough to catch eviction). Stops only when
     * no dot surface is visible. Safe to call repeatedly — resets the timer.
     */
    startReadinessWatch() {
        this.stopReadinessWatch();
        const tick = async () => {
            this._readinessTimer = null;
            if (!this._readinessVisible()) return; // dot off-screen — stop polling
            const state = await this.refreshReadiness();
            const delay = state === 'preparing' ? 1500
                : state === 'ready' ? 8000   // stable; slow re-check catches eviction
                : 2500;                      // idle / offline — catch a background load
            this._readinessTimer = setTimeout(tick, delay);
        };
        tick();
    },

    stopReadinessWatch() {
        if (this._readinessTimer) {
            clearTimeout(this._readinessTimer);
            this._readinessTimer = null;
        }
    },

    /**
     * Paint both context chips for the active conversation. Click toggles
     * personal-context on/off for THIS chat only — there is no global
     * default; default for every new chat is full context.
     */
    updateContextChip() {
        const convId = AgentService.activeConversationId;
        const mode = AgentService.getConversationContextMode(convId);
        const isSimple = mode === 'simple';

        const paint = (el) => {
            if (!el) return;
            el.textContent = isSimple ? 'Use personal info: off' : 'Use personal info: on';
            el.classList.toggle('agent-context-chip--off', isSimple);
            el.disabled = !convId;
            el.title = !convId
                ? 'Start a chat first, then choose whether it uses your personal info.'
                : isSimple
                    ? 'Personal info is OFF for this chat — no briefing, no app context, only web_search + think tools. Click to turn back on.'
                    : 'Personal info is ON for this chat — briefing, app context, and all tools available. Click to switch to simple mode for this chat only.';
            if (!el.dataset.contextClickWired) {
                el.dataset.contextClickWired = '1';
                el.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const activeId = AgentService.activeConversationId;
                    if (!activeId) return;
                    const current = AgentService.getConversationContextMode(activeId);
                    const next = current === 'simple' ? 'full' : 'simple';
                    AgentService.setConversationContextMode(activeId, next);
                    this.updateContextChip();
                });
            }
        };

        paint(document.getElementById('agent-context-chip'));
        paint(document.getElementById('agent-app-context-chip'));

        // The thinking chip lives next to the context chip and is always
        // repainted alongside it, so they never drift out of sync.
        this.updateThinkChip();
        this.updateChatbotChip();
        this.updateModelChip();
    },

    // ─────────────────── Composer model dropdown ───────────────────

    _engineLabel(engine) {
        return engine === 'llamacpp' ? 'llama.cpp'
            : engine === 'server' ? 'Server'
            : engine === 'openai' ? 'OpenAI'
            : engine === 'anthropic' ? 'Anthropic'
            : 'Ollama';
    },

    /**
     * Paint the composer model chips (assistant page, docked panel, home).
     * Shows the DEFAULT model entry as "model · engine"; clicking opens the
     * entry dropdown. Unlike the context/think chips this is global, not
     * per-conversation — switching here changes what every chat without an
     * override uses next.
     */
    updateModelChip() {
        const entry = AgentService.getDefaultEntry?.() || null;
        const paint = (el) => {
            if (!el) return;
            if (entry) {
                el.textContent = `${entry.model} · ${this._engineLabel(entry.engine)}`;
                el.classList.remove('agent-context-chip--off');
                el.title = `Default model: ${entry.model} on ${this._engineLabel(entry.engine)}. Click to switch.`;
            } else {
                el.textContent = 'choose model';
                el.classList.add('agent-context-chip--off');
                el.title = 'No model selected yet — click to pick one.';
            }
            if (!el.dataset.modelChipWired) {
                el.dataset.modelChipWired = '1';
                el.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this._toggleModelMenu(el);
                });
            }
        };
        paint(document.getElementById('agent-model-chip'));
        paint(document.getElementById('agent-app-model-chip'));
        paint(document.getElementById('dash-agent-model-chip'));
    },

    /** Close any open model menu (outside click / Escape / after choosing). */
    _closeModelMenu() {
        document.querySelectorAll('.agent-model-menu').forEach((m) => m.remove());
        if (this._modelMenuDismiss) {
            document.removeEventListener('mousedown', this._modelMenuDismiss, true);
            document.removeEventListener('keydown', this._modelMenuKeydown, true);
            this._modelMenuDismiss = null;
            this._modelMenuKeydown = null;
        }
    },

    async _toggleModelMenu(chipEl) {
        const wasOpen = chipEl.parentElement?.querySelector('.agent-model-menu');
        this._closeModelMenu();
        if (wasOpen) return;

        await AgentService.ensureModelList?.();
        const entries = AgentService.getModelList?.() || [];
        const def = AgentService.getDefaultEntry?.() || null;
        const resident = new Set(await AgentService.residentModels?.() || []);

        const menu = document.createElement('div');
        menu.className = 'agent-model-menu';
        menu.setAttribute('role', 'menu');

        if (!entries.length) {
            const empty = document.createElement('div');
            empty.className = 'agent-model-menu-empty';
            empty.textContent = 'No models yet — add one in Settings.';
            menu.appendChild(empty);
        }

        for (const entry of entries) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'agent-model-menu-item';
            item.setAttribute('role', 'menuitem');
            if (def && entry.id === def.id) item.classList.add('is-default');

            const name = document.createElement('span');
            name.className = 'agent-model-menu-name';
            name.textContent = entry.model;
            item.appendChild(name);

            const engine = document.createElement('span');
            engine.className = 'agent-model-menu-engine';
            engine.textContent = this._engineLabel(entry.engine);
            item.appendChild(engine);

            if (def && entry.id === def.id) {
                const tag = document.createElement('span');
                tag.className = 'agent-model-menu-tag';
                tag.textContent = 'default';
                item.appendChild(tag);
            }
            if (!AgentService.isRemoteEngine(entry.engine) && resident.has(entry.model)) {
                const tag = document.createElement('span');
                tag.className = 'agent-model-menu-tag agent-model-menu-tag--loaded';
                tag.textContent = 'in memory';
                item.appendChild(tag);
            }

            item.addEventListener('click', async () => {
                this._closeModelMenu();
                if (def && entry.id === def.id) return;
                await AgentService.setDefaultEntry(entry.id);
                this.updateModelChip();
                this.updateModelLabel?.();
                // Local engines start warming inside setDefaultEntry; the
                // readiness watch shows the load. Server entries are ready
                // immediately — the model runs on an external machine.
                this.startReadinessWatch();
                if (typeof UIUtils !== 'undefined') {
                    UIUtils.showToast(entry.engine === 'server'
                        ? `Model: ${entry.model} (your server)`
                        : entry.engine === 'openai' || entry.engine === 'anthropic'
                            ? `Model: ${entry.model} (${this._engineLabel(entry.engine)} API)`
                            : `Model: ${entry.model} — warming up`, 'success');
                }
            });
            menu.appendChild(item);
        }

        const manage = document.createElement('button');
        manage.type = 'button';
        manage.className = 'agent-model-menu-item agent-model-menu-manage';
        manage.textContent = 'Manage models…';
        manage.addEventListener('click', () => {
            this._closeModelMenu();
            if (typeof AppManager !== 'undefined') {
                AppManager.openApp('settings');
                setTimeout(() => { try { SettingsApp.openLLMSettings(); } catch { /* view not ready */ } }, 50);
            }
        });
        menu.appendChild(manage);

        // Anchor inside the chip's positioned wrapper; opens upward (the
        // composer sits at the bottom of the view).
        const wrap = chipEl.parentElement;
        wrap.appendChild(menu);

        this._modelMenuDismiss = (e) => {
            if (!menu.contains(e.target) && e.target !== chipEl) this._closeModelMenu();
        };
        this._modelMenuKeydown = (e) => { if (e.key === 'Escape') this._closeModelMenu(); };
        document.addEventListener('mousedown', this._modelMenuDismiss, true);
        document.addEventListener('keydown', this._modelMenuKeydown, true);
    },

    /**
     * Paint the mode chips (latency diagnostic — see
     * AgentService.getConversationChatbotMode). Shows the CURRENT mode:
     * "agent mode" (default, full assistant) or "chatbot mode" (raw model,
     * no prompt/tools). Lives in the composer so it's one click away while
     * comparing response speed against a direct llama-server chat. Click
     * toggles for THIS chat only.
     */
    updateChatbotChip() {
        const convId = AgentService.activeConversationId;
        const active = convId ? AgentService.getConversationChatbotMode(convId) : false;
        // The home box always starts a fresh chat (submitDashAgent calls
        // openFreshConversation), so ITS chip reflects — and toggles — the
        // blank that send would reuse, not whatever chat happens to be
        // active in the assistant. The two surfaces may legitimately show
        // different modes; each is truthful about its own next send.
        const blank = AgentService.peekFreshConversation();
        const home = !!(blank && AgentService.getConversationChatbotMode(blank.id));

        const paint = (el, chatbot, isHome) => {
            if (!el) return;
            el.textContent = chatbot ? 'chatbot mode' : 'agent mode';
            el.classList.toggle('agent-context-chip--off', !chatbot);
            el.title = chatbot
                ? 'Chatbot mode — no system prompt, no personal context, no tools; your question goes straight to the model, like llama-server’s own chat page. For diagnosing slowness. Click to switch back to agent mode.'
                : 'Agent mode (the normal assistant). Click to switch to chatbot mode — questions go straight to the model with no system prompt or tools, useful to check whether slowness comes from the assistant’s prompt overhead.';
            if (!el.dataset.chatbotClickWired) {
                el.dataset.chatbotClickWired = '1';
                el.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // Unlike the context/think chips, this one works before the
                    // first message: the whole point is diagnosing the FIRST
                    // turn's latency. The home chip always targets the blank a
                    // home send will use (never a chat open elsewhere); the
                    // assistant chips target the active chat, starting one only
                    // when none exists.
                    let targetId = isHome ? null : AgentService.activeConversationId;
                    if (!targetId) {
                        const conv = AgentService.openFreshConversation();
                        targetId = conv && conv.id;
                        if (!targetId) return;
                    }
                    const current = AgentService.getConversationChatbotMode(targetId);
                    AgentService.setConversationChatbotMode(targetId, !current);
                    this.updateChatbotChip();
                });
            }
        };

        paint(document.getElementById('agent-chatbot-chip'), active, false);
        paint(document.getElementById('agent-app-chatbot-chip'), active, false);
        paint(document.getElementById('dash-agent-chatbot-chip'), home, true);
    },

    /**
     * Paint both "thinking" chips for the active conversation. Click toggles
     * thinking on/off for THIS chat only, overriding the per-model default
     * (Settings → AI Models). Turning it off gives a faster first response on
     * reasoning models; it's a no-op on models that can't reason.
     */
    updateThinkChip() {
        const convId = AgentService.activeConversationId;
        const thinking = convId ? AgentService.getConversationThinking(convId) : false;

        const paint = (el) => {
            if (!el) return;
            el.textContent = thinking ? 'thinking: on' : 'thinking: off';
            el.classList.toggle('agent-context-chip--off', !thinking);
            el.disabled = !convId;
            el.title = !convId
                ? 'Start a chat first, then choose whether it uses thinking.'
                : thinking
                    ? 'Thinking is ON for this chat — the model reasons before replying, which is slower to start. Click to turn off.'
                    : 'Thinking is OFF for this chat — faster first response. Click to turn on (only affects reasoning-capable models).';
            if (!el.dataset.thinkClickWired) {
                el.dataset.thinkClickWired = '1';
                el.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const activeId = AgentService.activeConversationId;
                    if (!activeId) return;
                    const current = AgentService.getConversationThinking(activeId);
                    AgentService.setConversationThinking(activeId, current ? 'off' : 'on');
                    this.updateThinkChip();
                });
            }
        };

        paint(document.getElementById('agent-think-chip'));
        paint(document.getElementById('agent-app-think-chip'));
    },

    /**
     * Open the model picker modal. Lists installed Ollama models with the
     * currently-effective one highlighted. Picking a different model triggers
     * the scope dialog so the user can choose conv-only vs global default.
     */
    async openModelPicker() {
        if (typeof Modal === 'undefined' || !Modal.create) return;

        const convId = AgentService.activeConversationId;
        const current = AgentService.getActiveModel(convId);

        let models = [];
        try {
            // List installed models from whichever local engine is selected.
            const llm = await window.electronLLM?.getSettings?.();
            if (llm?.localBackend === 'llamacpp') {
                const result = await window.electronLlamaCpp?.listModels?.();
                models = (result?.models || []).map(m => m.name);
            } else {
                const status = await AgentService.checkOllama();
                models = (status && status.models) ? status.models.map(m => m.name) : [];
            }
        } catch (e) {
            console.warn('[agent] failed to list models for picker:', e);
        }

        // Which models are loaded in RAM right now, so we can flag them and
        // offer an inline unload to reclaim memory.
        const resident = new Set(await AgentService.residentModels());

        const wrap = document.createElement('div');
        wrap.className = 'agent-model-picker';

        if (models.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'agent-model-picker-empty';
            empty.textContent = 'No models installed. Install one from Settings → AI Assistant.';
            wrap.appendChild(empty);
        } else {
            const list = document.createElement('div');
            list.className = 'agent-model-picker-list';
            models.forEach((name) => {
                const row = document.createElement('div');
                row.className = 'agent-model-picker-row';
                if (name === current) row.classList.add('is-current');

                // The name itself stays the click target for choosing a model.
                const pick = document.createElement('button');
                pick.type = 'button';
                pick.className = 'agent-model-picker-pick';
                const label = document.createElement('span');
                label.className = 'agent-model-picker-name';
                label.textContent = name;
                pick.appendChild(label);
                if (name === current) {
                    const tag = document.createElement('span');
                    tag.className = 'agent-model-picker-tag';
                    tag.textContent = 'current';
                    pick.appendChild(tag);
                }
                if (resident.has(name)) {
                    const mem = document.createElement('span');
                    mem.className = 'agent-model-picker-tag agent-model-picker-tag--loaded';
                    mem.textContent = 'in memory';
                    pick.appendChild(mem);
                }
                pick.addEventListener('click', () => {
                    instance.close();
                    if (name === current) return;
                    this._chooseModelScope(name, convId);
                });
                row.appendChild(pick);

                // Resident models get an inline "Unload" to free their RAM
                // without leaving the dialog. The model reloads on next use.
                if (resident.has(name)) {
                    const unload = document.createElement('button');
                    unload.type = 'button';
                    unload.className = 'agent-model-picker-unload';
                    unload.textContent = 'Unload';
                    unload.title = `Free the RAM used by ${name} (it reloads next time you chat)`;
                    unload.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        unload.disabled = true;
                        unload.textContent = 'Unloading…';
                        const res = await AgentService.unloadModel(name);
                        if (res && res.error) {
                            if (typeof UIUtils !== 'undefined') UIUtils.showToast(`Couldn't unload ${name}: ${res.error}`, 'error');
                            unload.disabled = false;
                            unload.textContent = 'Unload';
                        } else {
                            if (typeof UIUtils !== 'undefined') UIUtils.showToast(`Unloaded ${name} — RAM freed`, 'success');
                            this.startReadinessWatch();
                            instance.close();
                            this.openModelPicker();
                        }
                    });
                    row.appendChild(unload);
                }

                list.appendChild(row);
            });
            wrap.appendChild(list);
        }

        const buttons = [
            { text: 'Close', className: 'secondary-btn', onClick: () => instance.close() }
        ];

        // Offer to clear the per-conv override when one exists. Lets the user
        // pop back to the global default without having to know which model
        // that currently is.
        const conv = convId ? AgentService.conversations.find(c => c.id === convId) : null;
        if (conv && conv.model) {
            buttons.unshift({
                text: 'Use default for this chat',
                className: 'secondary-btn',
                onClick: () => {
                    AgentService.setConversationModel(convId, null);
                    this.updateModelLabel();
                    instance.close();
                }
            });
        }

        const instance = Modal.create({
            title: 'Choose model',
            className: 'agent-model-picker-dialog',
            content: wrap,
            buttons
        });
    },

    /**
     * Second-step scope dialog: after the user picks a new model, ask whether
     * it applies just to this conversation or replaces the global default.
     */
    _chooseModelScope(modelName, convId) {
        if (typeof Modal === 'undefined' || !Modal.create) {
            // No modal available — fall back to per-conv only so we never
            // silently overwrite the user's global default.
            if (convId) AgentService.setConversationModel(convId, modelName);
            this.updateModelLabel();
            return;
        }

        const wrap = document.createElement('div');
        wrap.className = 'agent-model-scope';
        const desc = document.createElement('p');
        desc.className = 'agent-model-scope-desc';
        desc.textContent = `Use ${modelName} for…`;
        wrap.appendChild(desc);

        // No explicit Cancel — the modal's header ✕, Esc, and click-outside all
        // dismiss it without making a choice.
        const buttons = [];

        if (convId) {
            buttons.push({
                text: 'This conversation only',
                className: 'secondary-btn',
                onClick: () => {
                    AgentService.setConversationModel(convId, modelName);
                    this.updateModelLabel();
                    instance.close();
                }
            });
        }

        buttons.push({
            text: 'Default for all chats',
            className: 'primary-btn',
            onClick: () => {
                AgentService.setGlobalModel(modelName);
                // If this conversation had its own override, clear it so the
                // chat now follows the new global default (which is what
                // "set as default" intuitively means — no surprise where the
                // local override silently overrides the new default).
                if (convId) AgentService.setConversationModel(convId, null);
                this.updateModelLabel();
                instance.close();
            }
        });

        const instance = Modal.create({
            title: 'Where should this apply?',
            className: 'agent-model-scope-dialog',
            content: wrap,
            buttons
        });
    },

    setupPanelListeners() {
        const toggle = document.getElementById('agent-toggle-btn');
        const close = document.getElementById('agent-close-btn');
        const newBtn = document.getElementById('agent-new-btn');
        const expandBtn = document.getElementById('agent-expand-btn');
        const sendBtn = document.getElementById('agent-send-btn');
        const input = document.getElementById('agent-input');

        toggle.addEventListener('click', () => this.toggle());
        close.addEventListener('click', () => this.close());
        newBtn.addEventListener('click', () => this.newChat());
        expandBtn.addEventListener('click', () => {
            this.close();
            // Expand = "show this conversation bigger", so don't let the
            // open-from-home logic in renderAppView swap in a fresh chat.
            this._continueConversationOnEnter = true;
            AppManager.openApp('agent');
        });

        this.setupOverflowMenu();

        sendBtn.addEventListener('click', () => this._onSendOrStop());
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                // Cmd/Ctrl+Enter mid-stream = interrupt & send now.
                if (e.metaKey || e.ctrlKey) this._onForceSubmit();
                else this._onComposerSubmit();
            }
        });
        // Focusing the input is a strong "about to chat" signal — warm the
        // model so the load overlaps with the user composing their message.
        input.addEventListener('focus', () => AgentService.warmOnIntent?.());

        // Attachment plumbing (attach buttons, drag & drop) — one-time,
        // delegation-based, shared by the panel and the app view.
        this._installAttachmentHandlers();
        this._installComposerHandlers();

        this.ollamaChecked = false;
    },

    // --- Composer auto-grow ---
    //
    // Both composers are textareas that grow with their content (Enter sends,
    // Shift+Enter breaks a line — see the keydown handlers). Wired once via
    // document-level delegation because the app-view composer is re-cloned on
    // every renderAppView.
    _composerWired: false,

    _installComposerHandlers() {
        if (this._composerWired) return;
        this._composerWired = true;
        document.addEventListener('input', (e) => {
            const t = e.target;
            if (t && (t.id === 'agent-input' || t.id === 'agent-app-input' || t.id === 'dash-agent-input')) {
                this._autoGrowComposer(t);
            }
        });
        // Queued-strip controls: ✕ removes one message, "Send now" interrupts
        // the current reply and flushes the queue (draft included).
        document.addEventListener('click', (e) => {
            const remove = e.target.closest?.('.agent-queued-remove');
            if (remove) {
                const convId = AgentService.activeConversationId;
                if (!convId) return;
                AgentService.removeQueuedMessage(convId, parseInt(remove.dataset.idx, 10));
                this._renderQueuedStrip();
                return;
            }
            if (e.target.closest?.('.agent-queued-sendnow')) {
                this._onForceSubmit();
            }
        });
    },

    // Fit the textarea to its content, capped (the CSS max-height matches, so
    // past the cap it scrolls). Called on typing and after programmatic value
    // changes (send-clear, drafts, edit & resend).
    _autoGrowComposer(el) {
        if (!el || el.tagName !== 'TEXTAREA') return;
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 190) + 'px';
    },

    /**
     * Open the docked panel and immediately ask a question on the user's
     * behalf. Used by in-app affordances (e.g. Portfolio insight cards) that
     * hand a specific, grounded question to the assistant.
     */
    async askWithPrompt(prompt) {
        if (!prompt) return;
        if (!this.isOpen || this.mode !== 'panel') await this.open();
        const input = document.getElementById('agent-input');
        if (!input) return;
        input.value = prompt;
        this._autoGrowComposer(input);
        // Submit (not the button action): if that chat is mid-reply the
        // handed-in question queues instead of stopping the reply.
        this._onComposerSubmit();
    },

    /**
     * Open the full Agent app with a drafted (not yet sent) message in the
     * composer — the user reviews/edits before sending. With opts.pickFile
     * the file picker opens too, for flows whose whole point is attaching a
     * file (e.g. "Import transactions" in Portfolio).
     */
    openAppWithDraft(prompt, opts = {}) {
        if (this.isOpen) this.close();
        AppManager.openApp('agent');
        const input = document.getElementById('agent-app-input');
        if (input) {
            input.value = prompt || '';
            this._autoGrowComposer(input);
            input.focus();
        }
        if (opts.pickFile) this._openFilePicker();
    },

    /**
     * Wire the panel header's "⋯" overflow menu — the home for the per-chat
     * toggles (personal context, thinking) that used to crowd the header row.
     * The toggle buttons themselves keep their IDs and click handlers (wired
     * by updateContextChip / updateThinkChip), so this only manages open/close.
     * Idempotent: guarded so repeated setupPanelListeners calls don't stack
     * document listeners.
     */
    setupOverflowMenu() {
        const btn = document.getElementById('agent-overflow-btn');
        const menu = document.getElementById('agent-overflow-menu');
        if (!btn || !menu || btn.dataset.overflowWired) return;
        btn.dataset.overflowWired = '1';

        const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
        const open = () => { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); };
        this._closeOverflowMenu = close;

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.hidden ? open() : close();
        });

        // Clicks on the toggles inside shouldn't dismiss the menu — let the
        // user flip both settings and see the new state before closing.
        menu.addEventListener('click', (e) => e.stopPropagation());

        document.addEventListener('click', () => { if (!menu.hidden) close(); });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !menu.hidden) close();
        });
    },

    setupAppListeners() {
        Breadcrumb.render('agent-breadcrumb', [
            { label: 'AI Assistant' }
        ]);

        const newChatBtn = document.getElementById('agent-new-chat-btn');
        const newNew = newChatBtn.cloneNode(true);
        newChatBtn.parentNode.replaceChild(newNew, newChatBtn);
        newNew.addEventListener('click', () => { this.closeProfilePanel(); this.newChat(); });

        this.setupProfilePanelListeners();

        // Collapsible conversation sidebar (persisted across sessions).
        const sidebarToggle = document.getElementById('agent-sidebar-toggle');
        if (sidebarToggle) {
            const freshToggle = sidebarToggle.cloneNode(true);
            sidebarToggle.parentNode.replaceChild(freshToggle, sidebarToggle);
            freshToggle.addEventListener('click', () => this.toggleAppSidebar());
        }
        this._applyAppSidebarState();

        const sendBtn = document.getElementById('agent-app-send-btn');
        const newSend = sendBtn.cloneNode(true);
        sendBtn.parentNode.replaceChild(newSend, sendBtn);
        newSend.addEventListener('click', () => this._onSendOrStop());

        const input = document.getElementById('agent-app-input');
        const newInput = input.cloneNode(true);
        input.parentNode.replaceChild(newInput, input);
        newInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                // Cmd/Ctrl+Enter mid-stream = interrupt & send now.
                if (e.metaKey || e.ctrlKey) this._onForceSubmit();
                else this._onComposerSubmit();
            }
        });
        newInput.addEventListener('focus', () => AgentService.warmOnIntent?.());

        // Reflect the active conversation's streaming state on the composer
        // buttons (e.g. re-entering the app while a chat is still generating).
        this._setSendStopState(AgentService.isConversationStreaming(AgentService.activeConversationId));
        this._renderQueuedStrip();
    },

    // --- Conversation sidebar (app view) ---

    _APP_SIDEBAR_KEY: 'agentAppSidebarCollapsed',

    _appSidebarCollapsed() {
        try { return localStorage.getItem(this._APP_SIDEBAR_KEY) === '1'; } catch { return false; }
    },

    _applyAppSidebarState() {
        const layout = document.querySelector('#agent-view .agent-app-layout');
        if (layout) layout.classList.toggle('sidebar-collapsed', this._appSidebarCollapsed());
    },

    toggleAppSidebar() {
        const next = !this._appSidebarCollapsed();
        try { localStorage.setItem(this._APP_SIDEBAR_KEY, next ? '1' : '0'); } catch { /* ignore */ }
        this._applyAppSidebarState();
    },

    // --- Memory profile panel (app view) ---
    //
    // A categorized, editable summary of what the assistant knows about the
    // user (MemoryManager sections). Overlays the chat column. Edits are saved
    // on blur and flagged `userEdited` so compaction preserves them.

    _profilePanelOpen: false,

    setupProfilePanelListeners() {
        const bind = (id, fn) => {
            const el = document.getElementById(id);
            if (!el) return;
            const fresh = el.cloneNode(true);
            el.parentNode.replaceChild(fresh, el);
            fresh.addEventListener('click', fn);
        };
        bind('agent-app-memory-btn', () => this.toggleProfilePanel());
        bind('agent-profile-close-btn', () => this.closeProfilePanel());
        bind('agent-profile-add-btn', () => this._addProfileSection());
        bind('agent-profile-update-btn', () => this._updateProfileNow());
    },

    toggleProfilePanel() {
        if (this._profilePanelOpen) this.closeProfilePanel();
        else this.openProfilePanel();
    },

    openProfilePanel() {
        const main = document.querySelector('#agent-view .agent-chat-main');
        const panel = document.getElementById('agent-profile-panel');
        if (!main || !panel) return;
        this._profilePanelOpen = true;
        main.classList.add('profile-open');
        panel.hidden = false;
        const chip = document.getElementById('agent-app-memory-btn');
        if (chip) chip.classList.add('agent-memory-chip--active');
        this.renderProfilePanel();
    },

    closeProfilePanel() {
        const main = document.querySelector('#agent-view .agent-chat-main');
        const panel = document.getElementById('agent-profile-panel');
        this._profilePanelOpen = false;
        if (main) main.classList.remove('profile-open');
        if (panel) panel.hidden = true;
        const chip = document.getElementById('agent-app-memory-btn');
        if (chip) chip.classList.remove('agent-memory-chip--active');
    },

    // Called after a background compaction so an open panel reflects new
    // content — but only when the user isn't mid-edit (don't clobber a focused
    // textarea/input).
    refreshProfilePanelIfOpen() {
        if (!this._profilePanelOpen) return;
        const active = document.activeElement;
        if (active && active.closest && active.closest('#agent-profile-panel')) return;
        this.renderProfilePanel();
    },

    renderProfilePanel() {
        const wrap = document.getElementById('agent-profile-sections');
        if (!wrap || typeof MemoryManager === 'undefined') return;

        const sections = MemoryManager.listSections();
        const hintFor = (key) => {
            const def = (MemoryManager.DEFAULT_SECTIONS || []).find(d => d.key === key);
            return def ? def.hint : 'Anything lasting the assistant should remember.';
        };

        wrap.innerHTML = sections.map(s => {
            const badge = s.userEdited
                ? '<span class="agent-profile-badge" title="You edited this — compaction keeps it">edited by you</span>'
                : '';
            return `
                <div class="agent-profile-section" data-id="${this.escapeHtml(s.id)}">
                    <div class="agent-profile-section-head">
                        <input class="agent-profile-section-title" type="text" value="${this.escapeHtml(s.title)}" aria-label="Section title">
                        ${badge}
                        <button class="agent-profile-section-del" type="button" title="Delete section">&#x2715;</button>
                    </div>
                    <textarea class="agent-profile-section-body" rows="3" placeholder="${this.escapeHtml(hintFor(s.key))}">${this.escapeHtml(s.body || '')}</textarea>
                </div>`;
        }).join('');

        wrap.querySelectorAll('.agent-profile-section').forEach(el => {
            const id = el.dataset.id;
            const titleEl = el.querySelector('.agent-profile-section-title');
            const bodyEl = el.querySelector('.agent-profile-section-body');
            const delBtn = el.querySelector('.agent-profile-section-del');

            const saveTitle = () => {
                const v = titleEl.value.trim();
                if (!v) { const s = MemoryManager.getSection(id); if (s) titleEl.value = s.title; return; }
                MemoryManager.updateSection(id, { title: v }, { byUser: true });
                this._markSectionEdited(el);
            };
            const saveBody = () => {
                MemoryManager.updateSection(id, { body: bodyEl.value }, { byUser: true });
                this._markSectionEdited(el);
                this._autoGrow(bodyEl);
            };
            titleEl.addEventListener('change', saveTitle);
            bodyEl.addEventListener('change', saveBody);
            bodyEl.addEventListener('input', () => this._autoGrow(bodyEl));
            delBtn.addEventListener('click', () => {
                const s = MemoryManager.getSection(id);
                const label = s && s.title ? `"${s.title}"` : 'this section';
                if (!confirm(`Delete ${label}? This can't be undone.`)) return;
                MemoryManager.deleteSection(id);
                this.renderProfilePanel();
            });
            this._autoGrow(bodyEl);
        });

        // Invalidate the cached briefing so the next chat turn reflects edits.
        try { if (typeof AgentService !== 'undefined') AgentService._briefingCache?.clear(); } catch { /* ignore */ }
    },

    _markSectionEdited(el) {
        const head = el.querySelector('.agent-profile-section-head');
        if (head && !head.querySelector('.agent-profile-badge')) {
            const del = head.querySelector('.agent-profile-section-del');
            const badge = document.createElement('span');
            badge.className = 'agent-profile-badge';
            badge.title = 'You edited this — compaction keeps it';
            badge.textContent = 'edited by you';
            head.insertBefore(badge, del);
        }
    },

    _autoGrow(textarea) {
        if (!textarea) return;
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight + 2, 400) + 'px';
    },

    _addProfileSection() {
        // Electron's renderer has no window.prompt, so create the section inline
        // with a placeholder title and focus its title field for the user to
        // rename in place.
        const section = MemoryManager.addSection({ title: 'New section' });
        this.renderProfilePanel();
        const el = document.querySelector(`#agent-profile-sections .agent-profile-section[data-id="${section.id}"]`);
        if (el) {
            el.scrollIntoView({ block: 'nearest' });
            const titleEl = el.querySelector('.agent-profile-section-title');
            if (titleEl) { titleEl.focus(); titleEl.select(); }
        }
    },

    async _updateProfileNow() {
        const btn = document.getElementById('agent-profile-update-btn');
        if (typeof AgentService === 'undefined' || typeof AgentService.compactMemoryProfile !== 'function') return;
        if (!AgentService.model) {
            UIUtils.showToast('No local model selected to build the summary', 'error');
            return;
        }
        const orig = btn ? btn.textContent : '';
        if (btn) { btn.disabled = true; btn.textContent = 'Updating…'; }
        AgentService._foregroundMemoryOp = true;
        try {
            const updated = await AgentService.compactMemoryProfile({ full: true });
            this.renderProfilePanel();
            UIUtils.showToast(updated ? `Updated ${updated} section${updated === 1 ? '' : 's'}` : 'Nothing new to add', 'success');
        } catch (e) {
            UIUtils.showToast('Couldn\'t update the summary', 'error');
        } finally {
            AgentService._foregroundMemoryOp = false;
            if (btn) { btn.disabled = false; btn.textContent = orig || 'Update now'; }
        }
    },

    // --- Mode helpers ---

    getMessagesContainer() {
        return this.mode === 'app'
            ? document.getElementById('agent-app-messages')
            : document.getElementById('agent-messages');
    },

    // Word-meaning lookup over chat replies. Attach the shared WordLookup
    // selection trigger to a messages container exactly once — the element
    // persists, so re-attaching on every render would be wasteful.
    _wordLookupRoots: new Set(),
    _ensureWordLookup(container) {
        if (!container || typeof WordLookup === 'undefined') return;
        if (this._wordLookupRoots.has(container)) return;
        WordLookup.attachSelectionTrigger(container);
        this._wordLookupRoots.add(container);
    },

    getInput() {
        return this.mode === 'app'
            ? document.getElementById('agent-app-input')
            : document.getElementById('agent-input');
    },

    getSendBtn() {
        return this.mode === 'app'
            ? document.getElementById('agent-app-send-btn')
            : document.getElementById('agent-send-btn');
    },

    // The send/stop button: ■ (stop) while the active conversation is
    // streaming, ↑ (send) otherwise. Clicking ■ stops; queueing happens via
    // Enter in the composer (_onComposerSubmit).
    _onSendOrStop() {
        const convId = AgentService.activeConversationId;
        if (convId && AgentService.isConversationStreaming(convId)) {
            this.stopGeneration();
        } else {
            this.sendMessage();
            // A cold send loads the model as part of the first turn — watch so
            // the indicator shows "Preparing…" then "Ready" without the user
            // having to reopen anything.
            this.startReadinessWatch();
        }
    },

    // Enter in the composer. While the conversation is streaming the message
    // QUEUES (it goes out as the next turn when the current one ends) rather
    // than being dropped; otherwise it's a normal send.
    _onComposerSubmit() {
        const convId = AgentService.activeConversationId;
        if (convId && AgentService.isConversationStreaming(convId)) {
            this.queueComposerMessage();
        } else {
            this.sendMessage();
            this.startReadinessWatch();
        }
    },

    // "Send now" on the queued strip (or Cmd/Ctrl+Enter): interrupt & send —
    // queue whatever is in the composer, then abort the in-flight turn. The
    // interrupted turn keeps what it streamed so far; the queued messages
    // (draft included) immediately go out together as the next turn.
    _onForceSubmit() {
        const convId = AgentService.activeConversationId;
        if (!convId || !AgentService.isConversationStreaming(convId)) {
            this._onComposerSubmit();
            return;
        }
        this.queueComposerMessage();
        this.stopGeneration();
    },

    // Flip the send button between "send" (↑) and "stop" (■) looks. Driven by
    // sendMessage start/finish and by renderMessages when switching chats.
    _setSendStopState(streaming) {
        this._streamingUI = !!streaming;
        const btn = this.getSendBtn();
        if (!btn) return;
        if (streaming) {
            btn.classList.add('agent-send-btn--stop');
            btn.innerHTML = '&#9632;'; // ■
            btn.title = 'Stop generating (Enter queues your next message)';
        } else {
            btn.classList.remove('agent-send-btn--stop');
            btn.innerHTML = '&#x2191;'; // ↑
            btn.title = 'Send';
        }
    },

    // Stop the active conversation's in-flight generation. sendMessage's await
    // resolves shortly after and finalizes the partial reply.
    stopGeneration() {
        const convId = AgentService.activeConversationId;
        if (!convId) return;
        AgentService.abortConversation(convId);
        // Reflect immediately; sendMessage's finally will also reset.
        this._setSendStopState(false);
    },

    // Move the composer draft into the conversation's queue (used while the
    // conversation is streaming). The queued strip above the textarea shows
    // what's waiting; items can be removed until the drain sends them.
    queueComposerMessage() {
        const input = this.getInput();
        const text = input?.value?.trim() || '';
        const attachments = this.pendingAttachments.slice();
        if (!text && !attachments.length) return;
        const convId = AgentService.activeConversationId;
        if (!convId) return;
        input.value = '';
        this._autoGrowComposer(input);
        this.clearAttachments();
        AgentService.queueMessage(convId, text, attachments);
        this._renderQueuedStrip();
    },

    // Paint the queued-message chips into both composer strips (panel + app
    // view) for the ACTIVE conversation. Chips carry a remove button; the
    // strip ends with "Send now" — the interrupt-&-send control lives HERE,
    // with the messages it acts on, not as a standing composer button.
    _renderQueuedStrip() {
        const convId = AgentService.activeConversationId;
        const queued = convId ? AgentService.getQueuedMessages(convId) : [];
        ['agent-queued', 'agent-app-queued'].forEach((id) => {
            const strip = document.getElementById(id);
            if (!strip) return;
            strip.hidden = queued.length === 0;
            if (!queued.length) { strip.innerHTML = ''; return; }
            const chips = queued.map((q, i) => {
                const label = q.text
                    ? this.escapeHtml(q.text.length > 80 ? q.text.slice(0, 80) + '…' : q.text)
                    : this.escapeHtml((q.attachments || []).map(a => a.name).join(', ') || 'Attachment');
                return `
                <span class="agent-queued-chip" title="The assistant picks this up at its next step (or when the reply finishes)${q.text ? `:\n${this.escapeHtml(q.text)}` : ''}">
                    <span class="agent-queued-label">${label}</span>
                    ${(q.attachments || []).length ? `<span class="agent-queued-meta">${q.attachments.length} file${q.attachments.length === 1 ? '' : 's'}</span>` : ''}
                    <button class="agent-queued-remove" type="button" data-idx="${i}" title="Remove from queue" aria-label="Remove queued message">&#x2715;</button>
                </span>`;
            }).join('');
            strip.innerHTML = chips
                + `<button class="agent-queued-sendnow" type="button" title="Stop the current reply and send the queued message${queued.length === 1 ? '' : 's'} now (&#8984;&#x23CE;)">&#8648; Send now</button>`;
        });
    },

    // The service picked queued messages up at an iteration checkpoint —
    // they're now part of the RUNNING turn. Clear the strip and, if the user
    // is viewing that chat, turn the chips into real user bubbles placed
    // above the in-progress reply (the continuing answer covers them).
    onQueuedInjected(convId, msgs) {
        this._renderQueuedStrip();
        if (AgentService.activeConversationId !== convId) return;
        const container = this.getMessagesContainer();
        if (!container) return;
        const anchor = document.getElementById('agent-streaming')
            || document.getElementById('agent-thinking')
            || ((this._activityGroup && container.contains(this._activityGroup)) ? this._activityGroup : null);
        for (const qm of msgs) {
            const meta = (qm.attachments || []).length
                ? { attachments: qm.attachments.map(a => ({ name: a.name, size: a.size, kind: a.kind, pages: a.pages, truncated: a.truncated })) }
                : undefined;
            this._appendMessage(container, 'user', qm.text, undefined, meta);
            if (anchor) container.insertBefore(container.lastElementChild, anchor);
        }
        this._scrollToBottomIfPinned(container);
    },

    // After a turn ends (finished naturally or stopped), send whatever the
    // user queued during it — combined into ONE user turn so the model sees
    // the messages together. If the user switched chats mid-stream, the send
    // still targets the originating conversation, in the background.
    _drainQueuedMessages(convId) {
        if (!convId) return;
        const queued = AgentService.takeQueuedMessages(convId);
        if (!queued.length) return;
        const text = queued.map(q => q.text).filter(Boolean).join('\n\n');
        const attachments = queued.flatMap(q => q.attachments || []);
        if (!text && !attachments.length) return;
        this._renderQueuedStrip();
        if (AgentService.activeConversationId === convId) {
            this._dispatchMessage(text, attachments);
        } else {
            AgentService.sendMessage(text, null, {
                convId,
                ...(attachments.length ? { attachments } : {})
            }).then(() => this._drainQueuedMessages(convId));
        }
    },

    // --- Panel controls ---

    toggle() {
        if (this.isOpen) this.close();
        else this.open();
    },

    async open() {
        this.isOpen = true;
        this.mode = 'panel';
        const panel = document.getElementById('agent-panel');
        const toggle = document.getElementById('agent-toggle-btn');
        panel.classList.add('open');
        toggle.classList.add('active');
        // Drives `body.agent-panel-open #app-views { margin-right: 380px }`
        // in css/apps/agent.css — shrinks the active view so content stays
        // visible while the docked panel is open.
        document.body.classList.add('agent-panel-open');

        // If we're opening over a record page (a goal, a task, …) that exposes
        // a stable record key, attach to that record's recent conversation —
        // continuing the discussion about the thing the user is looking at
        // instead of whatever chat was last active. Records without a recent
        // thread get a fresh one. Never let this block opening the panel.
        try {
            const rec = (typeof AgentContext !== 'undefined') ? AgentContext.getActiveRecord() : null;
            if (rec) AgentService.openConversationForRecord(rec.key, rec.label);
        } catch (e) {
            console.warn('[agent-ui] record-scoped conversation lookup failed:', e);
        }

        // Restore active conversation in panel
        this.renderMessages();

        // Re-warm the local model the moment the panel opens — the user is
        // about to type, so overlap the (possibly cold) load with their typing.
        // Gated on /api/ps, so it's a no-op when the model is already resident.
        if (typeof AgentService !== 'undefined' && typeof AgentService.warmOnIntent === 'function') {
            AgentService.warmOnIntent();
        }
        // Reflect (and watch) the model's load state in the header indicator.
        this.startReadinessWatch();

        setTimeout(() => {
            document.getElementById('agent-input').focus();
        }, 300);

        if (!this.ollamaChecked) {
            this.ollamaChecked = true;
            await this.checkOllamaStatus();
        }
    },

    close() {
        this.isOpen = false;
        const panel = document.getElementById('agent-panel');
        const toggle = document.getElementById('agent-toggle-btn');
        panel.classList.remove('open');
        toggle.classList.remove('active');
        document.body.classList.remove('agent-panel-open');
        this._closeOverflowMenu?.();
        // Re-evaluate the watch: it self-stops if no dot surface is left visible,
        // but keeps running if we closed the panel over the dashboard or the
        // full Assistant view (both still show the dot).
        this.startReadinessWatch();
    },

    async checkOllamaStatus() {
        // The custom (OpenAI-compatible server) provider doesn't use a local
        // engine — skip the check so we don't post a misleading "not running"
        // message or auto-pick a local model.
        let backend = 'ollama';
        try {
            const llm = await window.electronLLM?.getSettings?.();
            if (llm?.provider === 'custom') return;
            backend = llm?.localBackend || 'ollama';
        } catch { /* fall through to the local check */ }

        // Engine-specific availability + installed-model list. llama.cpp has
        // no daemon to "start" — its server spawns with the model on first
        // chat — so only a missing engine install is worth a message.
        let modelNames = [];
        if (backend === 'llamacpp') {
            const status = await window.electronLlamaCpp?.status?.().catch(() => null);
            if (!status || !status.isInstalled) {
                this.addSystemMessage('The AI engine is not set up yet. Install it in Settings &rarr; AI Assistant.');
                return;
            }
            const result = await window.electronLlamaCpp.listModels().catch(() => null);
            modelNames = (result?.models || []).map(m => m.name);
        } else {
            const result = await AgentService.checkOllama();
            if (!result) {
                this.addSystemMessage('Ollama is not running. Please start it with: <code>ollama serve</code>');
                return;
            }
            modelNames = (result.models || []).map(m => m.name);
        }

        // Exact-name membership check — no prefix/startsWith heuristics, no
        // hardcoded model names. If the user has a selected model and it's
        // actually installed, use it. Otherwise, auto-pick the first installed
        // model so the Agent is usable immediately; the user can change it
        // anytime in Settings → AI Assistant. If nothing is installed at all,
        // point them at Settings rather than suggesting a specific `ollama pull`
        // command (which would require a model-name default to exist here).

        if (modelNames.length === 0) {
            this.addSystemMessage('No models installed. Install one from Settings → AI Assistant.');
            return;
        }

        const configured = AgentService.model;
        if (!configured || !modelNames.includes(configured)) {
            // Route through setGlobalModel so the entry list + brain
            // write-through stay coherent (a raw selectedModel write would
            // silently diverge from the entries).
            AgentService.setGlobalModel(modelNames[0]);
            this.updateModelLabel();
        }
    },

    // --- Full app view ---

    renderAppView(opts = {}) {
        this.mode = 'app';
        // Ensure conversations are loaded from storage (may not have been initialized via panel)
        if (!this.isInitialized) {
            this.isInitialized = true;
            AgentService.loadConversations();
            try { this.setupPanelListeners(); } catch (e) { /* panel may not be in DOM yet */ }
        }
        // Opening the assistant from the home page starts a fresh conversation
        // rather than resuming the most recent one. We skip this when:
        //   - the current chat is already an empty "New chat" (so repeated
        //     opens don't pile up blank conversations),
        //   - we got here via the panel's expand button (continue the chat the
        //     user was just looking at — expand means "show this bigger", not
        //     "start over"), or
        //   - the current chat is mid-stream (abandoning it would hide a live
        //     response that keeps generating in the background).
        // Resuming a past chat is still one click away in the history sidebar.
        // Consume the expand-button flag on every entry (not just the
        // from-home case) so it can't go stale and suppress a later fresh
        // chat from the launcher tile.
        const continueExisting = opts.entering && this._continueConversationOnEnter === true;
        if (opts.entering) this._continueConversationOnEnter = false;
        if (opts.entering && (typeof AppManager === 'undefined' || AppManager.previousApp == null)) {
            const activeId = AgentService.activeConversationId;
            const conv = AgentService.conversations?.find(c => c.id === activeId);
            const isEmpty = !conv || (conv.messages || []).length === 0;
            const isStreaming = !!activeId && AgentService.isConversationStreaming(activeId);
            if (!continueExisting && !isEmpty && !isStreaming) {
                AgentService.openFreshConversation();
            }
        }
        this.setupAppListeners();
        this.renderHistorySidebar();
        this.renderMessages();
        this.updateModelLabel();
        this.updateContextChip();

        setTimeout(() => {
            document.getElementById('agent-app-input')?.focus();
        }, 100);
    },

    // Friendly type name for a recordKey ("goals:g_1" → "Goal"), shown on
    // history items so the user can tell at a glance which chat is about what.
    _recordTypeLabel(recordKey) {
        if (!recordKey) return 'Record';
        const parts = String(recordKey).split(':');
        const app = parts[0];
        const sub = parts[1];
        if (app === 'portfolio') return sub === 'account' ? 'Account' : 'Ticker';
        const map = {
            goals: 'Goal', schedule: 'Task', notes: 'Note',
            journal: 'Journal', calendar: 'Event', bookmarks: 'Bookmark',
            email: 'Email', browse: 'Page', userapp: 'App', artifact: 'Artifact'
        };
        return map[app] || 'Record';
    },

    // Banner above the message area (full app view) naming the record the
    // active conversation is about. Hidden for chats with no related record.
    // No-op in the docked panel, which has no banner element.
    updateRecordBanner() {
        const banner = document.getElementById('agent-record-banner');
        if (!banner) return;
        const convId = AgentService.activeConversationId;
        const conv = convId ? AgentService.conversations.find(c => c.id === convId) : null;
        if (conv && conv.recordLabel) {
            const type = this._recordTypeLabel(conv.recordKey);
            banner.innerHTML = `
                <span class="agent-record-banner-icon" aria-hidden="true">&#128206;</span>
                <span class="agent-record-banner-text">
                    <span class="agent-record-banner-type">${this.escapeHtml(type)}</span>
                    <span class="agent-record-banner-label">${this.escapeHtml(conv.recordLabel)}</span>
                </span>`;
            banner.hidden = false;
        } else {
            banner.hidden = true;
            banner.innerHTML = '';
        }
    },

    // --- Conversation goal banner (above the composer) ---
    // A one-line, auto-derived statement of what this chat is trying to
    // accomplish (AgentService._updateGoal). Display-only, deliberately:
    // to steer the goal, the user just says so in chat — the correction is
    // in the transcript, so the deriver folds it into the next update.
    // Painted on every render and whenever the background deriver lands a
    // change. Both surfaces (panel + app view) are painted regardless of
    // mode — cheap, and it can't drift when the user switches surfaces
    // mid-chat.
    updateGoalBanner() {
        const convId = AgentService.activeConversationId;
        const conv = convId ? AgentService.conversations.find(c => c.id === convId) : null;
        const goal = (conv && typeof conv.goal === 'string') ? conv.goal : '';
        for (const id of ['agent-goal-banner', 'agent-app-goal-banner']) {
            const el = document.getElementById(id);
            if (!el) continue;
            if (!goal) { el.hidden = true; el.innerHTML = ''; continue; }
            el.innerHTML = `
                <span class="agent-goal-banner-label">Goal</span>
                <span class="agent-goal-banner-text" title="What this chat is working toward — to change it, just say so in the chat">${this.escapeHtml(goal)}</span>`;
            el.hidden = false;
        }
    },

    renderHistorySidebar() {
        const list = document.getElementById('agent-history-list');
        if (!list) return;

        const conversations = AgentService.getConversationList()
            .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

        if (conversations.length === 0) {
            list.innerHTML = '<div class="agent-history-empty">No conversations yet</div>';
            return;
        }

        // Date buckets (Today / Yesterday / …) between rows, so the list
        // scans like a reading history instead of a flat dump.
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        const dayMs = 24 * 60 * 60 * 1000;
        const bucketFor = (iso) => {
            const t = new Date(iso).getTime();
            if (t >= startOfToday.getTime()) return 'Today';
            if (t >= startOfToday.getTime() - dayMs) return 'Yesterday';
            if (t >= startOfToday.getTime() - 6 * dayMs) return 'This week';
            if (t >= startOfToday.getTime() - 29 * dayMs) return 'This month';
            return 'Earlier';
        };

        let lastBucket = null;
        list.innerHTML = conversations.map(c => {
            const isActive = c.id === AgentService.activeConversationId;
            const isStreaming = AgentService.isConversationStreaming(c.id);
            const timeAgo = this.formatTimeAgo(c.updatedAt);
            const streamingDot = isStreaming ? '<span class="agent-history-streaming-dot" title="Generating response"></span>' : '';
            const bucket = bucketFor(c.updatedAt);
            const groupLabel = bucket !== lastBucket
                ? `<div class="agent-history-group-label">${bucket}</div>`
                : '';
            lastBucket = bucket;
            // Related record (the task/note/… this chat was started over).
            const recordChip = c.recordLabel
                ? `<div class="agent-history-item-record" title="${this.escapeHtml(this._recordTypeLabel(c.recordKey))}: ${this.escapeHtml(c.recordLabel)}">
                        <span class="agent-history-item-record-type">${this.escapeHtml(this._recordTypeLabel(c.recordKey))}</span>
                        <span class="agent-history-item-record-label">${this.escapeHtml(c.recordLabel)}</span>
                   </div>`
                : '';
            return `${groupLabel}
                <div class="agent-history-item ${isActive ? 'active' : ''}" data-id="${c.id}" title="${c.messageCount} messages">
                    <div class="agent-history-item-title">${streamingDot}${this.escapeHtml(c.title)}</div>
                    ${recordChip}
                    <div class="agent-history-item-meta">${timeAgo}</div>
                    <button class="agent-history-item-delete" data-id="${c.id}" title="Delete">&times;</button>
                </div>
            `;
        }).join('');

        // Click to load conversation — parallel-safe. renderMessages detaches
        // any previous stream subscription and re-subscribes if the target has
        // one in flight.
        list.querySelectorAll('.agent-history-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.classList.contains('agent-history-item-delete')) return;
                const id = item.dataset.id;
                this.closeProfilePanel();
                AgentService.loadConversation(id);
                this.renderHistorySidebar();
                this.renderMessages();
                this.updateModelLabel();
                this.updateContextChip();
            });
        });

        // Delete buttons — still block deleting a conversation that's actively
        // streaming, since we'd orphan the in-flight generation and lose it.
        list.querySelectorAll('.agent-history-item-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const convId = btn.dataset.id;
                if (AgentService.isConversationStreaming(convId)) {
                    UIUtils.showToast('This chat is still generating a response', 'error');
                    return;
                }
                AgentService.deleteConversation(convId);
                this.renderHistorySidebar();
                this.renderMessages();
            });
        });
    },

    // --- Shared message rendering ---

    renderMessages() {
        const container = this.getMessagesContainer();
        if (!container) return;

        // Enable select-a-word → "Define" lookup over assistant replies, the
        // same pill/popover the Notes editor uses. Attached once per messages
        // container (panel + app modes each have their own, both persistent).
        this._ensureWordLookup(container);

        // Keep the related-record banner (app view) in sync with the conv.
        this.updateRecordBanner();
        // …and the conversation-goal banner above the composer.
        this.updateGoalBanner();

        const activeConvId = AgentService.activeConversationId;

        // Detach UI listeners from EVERY background stream that isn't the
        // currently active conversation. This is more thorough than relying on
        // _currentStreamConvId alone — if our local tracking ever drifts out
        // of sync, we still kill all stale subscriptions on every render.
        for (const convId of AgentService.getActiveStreamingConvIds()) {
            if (convId !== activeConvId) {
                AgentService.setStreamListener(convId, null);
            }
        }
        if (this._currentStreamConvId && this._currentStreamConvId !== activeConvId) {
            this._currentStreamBubble = null;
            this._currentStreamConvId = null;
            this._currentStreamContent = '';
            this._currentThinkingText = '';
            this._revealedChars = 0;
            this._stopRevealTicker();
        }

        // The transient streaming/thinking nodes use global IDs
        // (#agent-streaming, #agent-thinking), but the docked panel and the
        // full-app view are BOTH persistent containers in the DOM. Closing the
        // panel doesn't clear its contents, so a half-streamed bubble left
        // there would shadow the getElementById lookup in _ensureStreamingMessage
        // and the rebuilt bubble would render into the hidden panel instead of
        // the view the user just switched to — the "expand mid-stream and the
        // response vanishes" bug. Sweep both containers before we rebuild.
        document.querySelectorAll('#agent-streaming, #agent-thinking, .agent-scroll-pill').forEach(el => el.remove());

        container.innerHTML = '';

        // Empty-state composer (app view only): default to the normal
        // bottom-docked layout; the empty branch below opts back into the
        // centered layout when this turns out to be a fresh chat.
        const chatMain = (this.mode === 'app') ? container.closest('.agent-chat-main') : null;
        if (chatMain) chatMain.classList.remove('agent-chat-main--empty');

        // Render persisted messages for the active conv
        const messages = AgentService.conversation || [];
        for (const msg of messages) {
            if (msg.role === 'user' || msg.role === 'assistant') {
                // Attachments persist on the message itself; surface them to
                // _appendMessage through metadata so chips re-render on load.
                const meta = (msg.role === 'user' && Array.isArray(msg.attachments) && msg.attachments.length)
                    ? { ...(msg.metadata || {}), attachments: msg.attachments.map(a => ({ name: a.name, size: a.size, kind: a.kind, pages: a.pages, truncated: a.truncated })) }
                    : msg.metadata;
                this._appendMessage(container, msg.role, msg.content, msg.responseMs, meta, msg.thinking);
            }
        }

        // Empty-conversation suggestions. When a fresh chat opens (no
        // messages) and the active app provides suggestedPrompts,
        // surface them as quick-start buttons. Clicking one auto-sends
        // — they're meant to be one-tap shortcuts, not edit handles.
        const isEmptyConv = !messages.some(m => m.role === 'user' || m.role === 'assistant');
        if (isEmptyConv) {
            // Guided first-run setup no longer takes over the empty state — it
            // floats as a bottom-right popover (mounted below) so the greeting
            // and composer stay usable. The empty state is always the normal
            // centered hero.
            if (chatMain) {
                // Fresh chat in the full app view: float the greeting + input
                // box to the vertical centre of the column, like ChatGPT /
                // Claude. The class is removed (and the hero discarded) the
                // moment a message is sent — see _exitEmptyState / sendMessage.
                chatMain.classList.add('agent-chat-main--empty');
                const hero = document.createElement('div');
                hero.className = 'agent-empty-hero';
                if (this._shouldShowFirstWarmHero()) {
                    // First-ever visit while the local model is still loading:
                    // a dedicated waking-up state instead of a greeting the
                    // model can't answer yet. The readiness watch dissolves it
                    // into the normal hero (_paintFirstWarmHero) on 'ready'.
                    hero.classList.add('agent-first-warm');
                    const model = AgentService.getDefaultEntry?.()?.model || AgentService.model || '';
                    hero.innerHTML =
                        `<img class="agent-first-warm-logo" src="build/icon.png" alt="" />
                         <h2 class="agent-empty-hero-title">Waking up your assistant</h2>
                         <p class="agent-first-warm-status">Getting ${UIUtils.escapeHtml(model)} ready&hellip;</p>
                         <div class="agent-first-warm-bar" aria-hidden="true"><span></span></div>
                         <p class="agent-first-warm-note">The first launch takes the longest &mdash; the AI is
                         loading into this Mac&rsquo;s memory. Once it&rsquo;s in, replies start right away.</p>`;
                } else {
                    hero.innerHTML = '<h2 class="agent-empty-hero-title">How can I help?</h2>';
                }
                container.appendChild(hero);
            }
            this._renderSuggestedPrompts(container);
        }

        // Guided first-run setup lives as a floating popover on the full
        // Assistant view only (never the docked panel), so it stays out of the
        // chat flow. Show while setup is pending; drop it once done/dismissed.
        if (this.mode === 'app' && typeof SetupAssistant !== 'undefined') {
            if (SetupAssistant.shouldShow()) SetupAssistant.renderPopover();
            else SetupAssistant.removePopover();
        }

        // If the active conv has a stream in flight, rebuild its streaming UI
        // from the accumulated content and re-subscribe for future chunks.
        if (activeConvId && AgentService.isConversationStreaming(activeConvId)) {
            const state = AgentService.getStreamingState(activeConvId);
            const content = state?.content || '';
            if (content) {
                const bubble = this._createStreamingBubble(container);
                bubble.innerHTML = this._formatStreaming(content);
                this._currentStreamBubble = bubble;
                this._currentStreamConvId = activeConvId;
                this._currentStreamContent = content;
                // Already-accumulated text shows at once; only NEW chunks
                // go through the smoothed reveal.
                this._revealedChars = content.length;
            } else {
                // Stream hasn't produced any output yet (still warming up or
                // between tool calls). Show a thinking indicator; the first
                // chunk will replace it with a real bubble.
                this.showThinking();
                this._currentStreamConvId = activeConvId;
                this._currentStreamContent = '';
            }
            AgentService.setStreamListener(activeConvId, (chunk, event) => {
                this._handleStreamChunk(activeConvId, chunk, event);
            });
        }

        // An app/artifact build in flight for THIS conversation: restore its
        // progress card from BuildStatus — without this, coming back showed
        // only thinking dots until the next event recreated an empty card.
        const bs = (typeof BuildStatus !== 'undefined') ? BuildStatus.current : null;
        if (bs && bs.status === 'building' && bs.convId === activeConvId) {
            this.hideThinking();
            this._restoreBuildCard(container, bs);
        }

        // Keep the send/stop button in sync with whatever chat is now shown.
        this._setSendStopState(!!activeConvId && AgentService.isConversationStreaming(activeConvId));
        // ...and the queued-messages strip (queues are per-conversation).
        this._renderQueuedStrip();

        // Offer "edit & resend" on the most recent question (when not streaming).
        this._decorateLastUserMessage(container);

        container.scrollTop = container.scrollHeight;
    },

    // Add an inline "edit" control to the latest user message so the user can
    // tweak their last question and resend (drops that turn + its reply). Only
    // the most recent question is editable — keeps the affordance unambiguous
    // and avoids index-mapping into the message array.
    _decorateLastUserMessage(container) {
        if (!container) return;
        const convId = AgentService.activeConversationId;
        if (!convId || AgentService.isConversationStreaming(convId)) return;
        const userMsgs = container.querySelectorAll('.agent-message-user');
        const last = userMsgs[userMsgs.length - 1];
        if (!last || last.querySelector('.agent-edit-btn')) return;
        const btn = document.createElement('button');
        btn.className = 'agent-edit-btn';
        btn.type = 'button';
        btn.title = 'Edit & resend';
        btn.setAttribute('aria-label', 'Edit and resend this message');
        btn.innerHTML = '&#9998;'; // ✎
        btn.addEventListener('click', () => this._editLastQuestion());
        last.appendChild(btn);
    },

    _editLastQuestion() {
        const convId = AgentService.activeConversationId;
        if (!convId || AgentService.isConversationStreaming(convId)) return;
        const text = AgentService.editLastUserMessage(convId);
        if (text == null) return;
        this.renderMessages();
        const input = this.getInput();
        if (input) {
            input.value = text;
            this._autoGrowComposer(input);
            input.focus();
            // Cursor to end.
            try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* not a text input */ }
        }
    },

    // Quick-start chips for empty conversations, sourced from the
    // current app's AgentContext provider. We render plain buttons
    // (not links) so the click is unambiguous, and we fire sendMessage
    // through the same path as keyboard input — no parallel send path.
    _renderSuggestedPrompts(container) {
        const block = (typeof AgentContext !== 'undefined') ? AgentContext.getActiveBlock() : null;
        const prompts = block && block.suggestedPrompts;
        if (!prompts || prompts.length === 0) return;

        const wrap = document.createElement('div');
        wrap.className = 'agent-suggestions';
        const heading = document.createElement('div');
        heading.className = 'agent-suggestions-heading';
        heading.textContent = 'Try asking…';
        wrap.appendChild(heading);

        const list = document.createElement('div');
        list.className = 'agent-suggestions-list';
        prompts.forEach((text) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'agent-suggestion-btn';
            btn.textContent = text;
            btn.addEventListener('click', () => {
                const input = this.getInput();
                if (!input) return;
                input.value = text;
                this.sendMessage();
            });
            list.appendChild(btn);
        });
        wrap.appendChild(list);
        container.appendChild(wrap);
    },

    // One delegated listener serves every copy affordance — code-block
    // buttons come and go with innerHTML rewrites (streaming re-renders the
    // bubble on every chunk), so per-element wiring would leak or vanish.
    _copyHandlersInstalled: false,

    // Clipboard + confirmation labels for the whole-response copy button.
    // Feather-style stroke SVGs (same voice as the home-tile icons) so the
    // glyph stays crisp and monochrome at any size, unlike the tiny ⎘
    // text character it replaced.
    COPY_LABEL: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg><span>Copy</span>',
    COPIED_LABEL: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg><span>Copied</span>',

    _installCopyHandlers() {
        if (this._copyHandlersInstalled) return;
        this._copyHandlersInstalled = true;
        document.addEventListener('click', (e) => {
            const codeBtn = e.target.closest?.('.agent-code-copy');
            if (codeBtn) {
                const code = codeBtn.closest('.agent-codeblock')?.querySelector('code');
                if (code) this._copyToClipboard(code.textContent, codeBtn, 'Copied');
                return;
            }
            const msgBtn = e.target.closest?.('.agent-msg-copy');
            if (msgBtn) {
                const msg = msgBtn.closest('.agent-message');
                // Prefer the raw markdown (what the model actually wrote) so a
                // paste elsewhere keeps code fences and tables intact.
                const raw = (msg && msg._rawContent) || msg?.querySelector('.agent-bubble')?.innerText || '';
                if (raw) this._copyToClipboard(raw, msgBtn, this.COPIED_LABEL);
            }
        });
    },

    _copyToClipboard(text, btn, doneLabel) {
        navigator.clipboard.writeText(text).then(() => {
            const prev = btn.innerHTML;
            btn.innerHTML = doneLabel;
            btn.disabled = true;
            setTimeout(() => { btn.innerHTML = prev; btn.disabled = false; }, 1200);
        }).catch((e) => console.warn('[agent-ui] clipboard write failed:', e));
    },

    /**
     * Build the Sources footer for an assistant bubble: a collapsible list of
     * the pages the agent actually read, each a numbered row with its title
     * and site (the delegated .agent-bubble link handler opens them
     * externally), plus the search queries behind them.
     *
     * Sources are stored as {url, title} (see recordSources in agent-service),
     * but conversations written before that carry bare URL strings — both
     * shapes render.
     */
    _buildSourcesBlock(sources) {
        const searches = Array.isArray(sources.searches) ? sources.searches : [];
        const pages = (Array.isArray(sources.pages) ? sources.pages : [])
            .map(p => (typeof p === 'string' ? { url: p, title: '' } : p))
            .filter(p => p && typeof p.url === 'string' && p.url);
        if (!searches.length && !pages.length) return null;

        const wrap = document.createElement('details');
        wrap.className = 'agent-sources';
        // Long source lists fold away; a handful stay open so the provenance
        // is visible without a click.
        wrap.open = pages.length <= 4;

        const summary = document.createElement('summary');
        summary.className = 'agent-sources-summary';
        const label = document.createElement('span');
        label.className = 'agent-sources-label';
        label.textContent = pages.length
            ? `${pages.length} source${pages.length === 1 ? '' : 's'}`
            : 'Web search';
        summary.appendChild(label);
        if (pages.length) {
            // Collapsed-state preview: which sites this answer leaned on.
            const hosts = [];
            for (const p of pages) {
                const h = this._sourceHost(p.url);
                if (h && !hosts.includes(h)) hosts.push(h);
            }
            const preview = document.createElement('span');
            preview.className = 'agent-sources-hosts';
            preview.textContent = hosts.slice(0, 3).join(' · ') + (hosts.length > 3 ? ` +${hosts.length - 3}` : '');
            summary.appendChild(preview);
        }
        wrap.appendChild(summary);

        const body = document.createElement('div');
        body.className = 'agent-sources-body';

        if (pages.length) {
            const list = document.createElement('ol');
            list.className = 'agent-source-list';
            pages.forEach((page, i) => {
                const host = this._sourceHost(page.url) || page.url;
                const li = document.createElement('li');
                li.className = 'agent-source-item';

                const a = document.createElement('a');
                a.className = 'agent-source-link';
                a.href = UIUtils.safeHref(page.url);  // M11: block javascript:/data: source URLs
                a.title = page.url;

                const num = document.createElement('span');
                num.className = 'agent-source-num';
                num.textContent = String(i + 1);
                a.appendChild(num);

                const text = document.createElement('span');
                text.className = 'agent-source-text';
                const title = document.createElement('span');
                title.className = 'agent-source-title';
                title.textContent = page.title || host;
                const meta = document.createElement('span');
                meta.className = 'agent-source-host';
                meta.textContent = page.title ? host : this._sourcePath(page.url);
                text.appendChild(title);
                text.appendChild(meta);
                a.appendChild(text);

                const arrow = document.createElement('span');
                arrow.className = 'agent-source-open';
                arrow.innerHTML = '&#8599;'; // ↗ opens in the default browser
                a.appendChild(arrow);

                li.appendChild(a);
                list.appendChild(li);
            });
            body.appendChild(list);
        }

        // The queries behind the pages: rounded search pills, each carrying a
        // magnifier glyph so no "Searched" label is needed and they can't be
        // mistaken for the square, clickable source rows above them.
        if (searches.length) {
            const row = document.createElement('div');
            row.className = 'agent-source-searches';
            for (const q of searches) {
                const chip = document.createElement('span');
                chip.className = 'agent-source-query';
                chip.title = `Web search: ${q}`;
                // Magnifier is drawn in CSS — the ⌕ glyph is illegible at 11px
                // and fonts disagree on how to draw it.
                const icon = document.createElement('span');
                icon.className = 'agent-source-query-icon';
                icon.setAttribute('aria-hidden', 'true');
                const text = document.createElement('span');
                text.className = 'agent-source-query-text';
                text.textContent = q;
                chip.appendChild(icon);
                chip.appendChild(text);
                row.appendChild(chip);
            }
            body.appendChild(row);
        }

        wrap.appendChild(body);
        return wrap;
    },

    _sourceHost(url) {
        try {
            return new URL(url).hostname.replace(/^www\./, '');
        } catch {
            return '';
        }
    },

    // Fallback line for a source with no known title: the path alone reads
    // better under the host than a repeated hostname.
    _sourcePath(url) {
        try {
            const u = new URL(url);
            const path = (u.pathname === '/' ? '' : u.pathname) + (u.search || '');
            return path ? decodeURI(path) : u.hostname.replace(/^www\./, '');
        } catch {
            return url;
        }
    },

    _appendMessage(container, role, content, responseMs, metadata, thinking) {
        this._installCopyHandlers();
        const div = document.createElement('div');
        div.className = `agent-message agent-message-${role}`;
        // Reasoning trace (if the model produced one), collapsed above the
        // answer — click to expand. Mirrors the live streaming block.
        if (role === 'assistant' && thinking) {
            const block = this._buildThinkingBlock();
            block.classList.remove('agent-thinking-block--live');
            block.classList.add('agent-thinking-block--collapsed');
            block.querySelector('.agent-thinking-label').textContent = 'Reasoning';
            // Render markdown (matches the live streaming render above).
            block.querySelector('.agent-thinking-content').innerHTML = this.formatContent(thinking);
            div.appendChild(block);
        }
        const bubble = document.createElement('div');
        bubble.className = 'agent-bubble';
        bubble.innerHTML = this.formatContent(content);
        // Attachment chips on user messages (files sent with this turn).
        if (role === 'user' && metadata && Array.isArray(metadata.attachments) && metadata.attachments.length) {
            const row = document.createElement('div');
            row.className = 'agent-msg-attachments';
            row.innerHTML = metadata.attachments.map(a => `
                <span class="agent-msg-attachment" title="${this.escapeHtml(a.name)}">
                    <span class="agent-msg-attachment-name">${this.escapeHtml(a.name)}</span>
                    <span class="agent-msg-attachment-meta">${a.kind === 'pdf' ? `PDF${a.pages ? ` &middot; ${a.pages}p` : ''}` : this._formatFileSize(a.size)}</span>
                </span>`).join('');
            bubble.appendChild(row);
        }
        if (role === 'assistant' && responseMs) {
            const timeEl = document.createElement('span');
            timeEl.className = 'agent-response-time';
            timeEl.textContent = `${(responseMs / 1000).toFixed(1)}s`;
            bubble.appendChild(timeEl);
        }
        if (role === 'assistant' && metadata && metadata.model) {
            const modelEl = document.createElement('span');
            modelEl.className = 'agent-message-model';
            modelEl.textContent = metadata.model;
            modelEl.title = `Model used: ${metadata.model}`;
            bubble.appendChild(modelEl);
        }
        // Provenance footer: what this turn actually searched and read on the
        // web, recorded from the tool transcript (see recordSources in
        // agent-service) — shown so web-derived answers carry their sources
        // even when the model forgot to cite inline.
        if (role === 'assistant' && metadata && metadata.sources) {
            const block = this._buildSourcesBlock(metadata.sources);
            if (block) bubble.appendChild(block);
        }
        // Records the agent created/updated this turn (see recordRecords in
        // agent-service) — one pill per record, click to jump straight to it.
        if (role === 'assistant' && metadata && Array.isArray(metadata.records) && metadata.records.length) {
            const row = this._buildRecordPills(metadata.records);
            if (row) bubble.appendChild(row);
        }
        div.appendChild(bubble);
        // Whole-response copy (ChatGPT/Claude style): raw markdown stashed on
        // the element, button revealed on hover (see agent.css).
        if (role === 'assistant' && content) {
            div._rawContent = content;
            const copyBtn = document.createElement('button');
            copyBtn.className = 'agent-msg-copy';
            copyBtn.title = 'Copy response';
            copyBtn.innerHTML = this.COPY_LABEL;
            div.appendChild(copyBtn);
        }
        container.appendChild(div);
    },

    // --- File attachments ---
    //
    // The user can attach files to a message: text-like files (CSV, TXT, MD,
    // JSON, code, …) are read in the renderer via File.text(); PDFs are parsed
    // in the main process by pdf.js (electronPdf.extractText) — everything
    // stays on-device. Attachments live on the message object as
    // { name, size, kind, content, truncated } — the UI renders chips from the
    // light fields and AgentService inlines `content` into the LLM turn.
    // Caps keep a 12B model's context (and the synced conversation blob) sane.
    _ATTACH_MAX_FILES: 4,
    _ATTACH_MAX_BYTES: 5 * 1024 * 1024,
    _ATTACH_MAX_CHARS: 30000,
    pendingAttachments: [],
    _attachmentsWired: false,

    // One-time, delegation-based wiring: the composers get re-cloned on every
    // renderAppView, so per-element listeners would be wiped — document-level
    // delegation survives all innerHTML rewrites.
    _installAttachmentHandlers() {
        if (this._attachmentsWired) return;
        this._attachmentsWired = true;

        document.addEventListener('click', (e) => {
            if (e.target.closest?.('.agent-attach-btn')) {
                this._openFilePicker();
                return;
            }
            const remove = e.target.closest?.('.agent-attachment-remove');
            if (remove) {
                const idx = parseInt(remove.dataset.idx, 10);
                if (!isNaN(idx)) {
                    this.pendingAttachments.splice(idx, 1);
                    this._renderAttachmentChips();
                }
            }
        });

        // Drag & drop onto any composer surface (docked panel, full app view,
        // or the home page's Ask Anjadhe hero).
        const dropTarget = (e) => e.target.closest?.('#agent-panel, #agent-view .agent-chat-main, .dash-agent-hero');
        document.addEventListener('dragover', (e) => {
            const t = dropTarget(e);
            if (!t || !e.dataTransfer?.types?.includes('Files')) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            t.classList.add('agent-drop-active');
        });
        document.addEventListener('dragleave', (e) => {
            const t = dropTarget(e);
            if (t && !t.contains(e.relatedTarget)) t.classList.remove('agent-drop-active');
        });
        document.addEventListener('drop', (e) => {
            const t = dropTarget(e);
            if (!t) return;
            e.preventDefault();
            t.classList.remove('agent-drop-active');
            if (e.dataTransfer?.files?.length) this.attachFiles(e.dataTransfer.files);
        });
    },

    _openFilePicker() {
        let inp = document.getElementById('agent-file-input');
        if (!inp) {
            inp = document.createElement('input');
            inp.type = 'file';
            inp.id = 'agent-file-input';
            inp.multiple = true;
            inp.hidden = true;
            inp.addEventListener('change', () => {
                if (inp.files?.length) this.attachFiles(inp.files);
                inp.value = '';
            });
            document.body.appendChild(inp);
        }
        inp.click();
    },

    async attachFiles(fileList) {
        for (const file of Array.from(fileList)) {
            if (this.pendingAttachments.length >= this._ATTACH_MAX_FILES) {
                UIUtils.showToast(`Up to ${this._ATTACH_MAX_FILES} files per message`, 'error');
                break;
            }
            if (file.size > this._ATTACH_MAX_BYTES && !this._isPdf(file)) {
                UIUtils.showToast(`${file.name} is too large (max 5 MB)`, 'error');
                continue;
            }
            const att = this._isPdf(file)
                ? await this._readPdfAttachment(file)
                : await this._readTextAttachment(file);
            if (att) this.pendingAttachments.push(att);
        }
        this._renderAttachmentChips();
        this.getInput()?.focus();
    },

    _isPdf(file) {
        return file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
    },

    async _readTextAttachment(file) {
        let text = null;
        try { text = await file.text(); } catch { /* unreadable */ }
        // NUL byte in the head = binary (same sniff agent-fs-read uses).
        if (text == null || text.slice(0, 8192).includes('\u0000')) {
            UIUtils.showToast(`${file.name} isn't a text file — attach text files (CSV, TXT, MD, JSON, code) or PDFs`, 'error');
            return null;
        }
        const truncated = text.length > this._ATTACH_MAX_CHARS;
        return {
            name: file.name,
            size: file.size,
            kind: 'text',
            content: truncated ? text.slice(0, this._ATTACH_MAX_CHARS) : text,
            totalChars: text.length,
            truncated
        };
    },

    async _readPdfAttachment(file) {
        if (!window.electronPdf?.extractText) {
            UIUtils.showToast('PDF attachments need the desktop app', 'error');
            return null;
        }
        let result = null;
        try {
            const data = new Uint8Array(await file.arrayBuffer());
            result = await window.electronPdf.extractText(data, file.name);
        } catch (e) {
            result = { error: e?.message };
        }
        if (!result || result.error) {
            UIUtils.showToast(`Couldn't read ${file.name}: ${result?.error || 'unknown error'}`, 'error');
            return null;
        }
        const text = (result.text || '').trim();
        if (!text) {
            UIUtils.showToast(`${file.name} has no extractable text (it may be a scanned image)`, 'error');
            return null;
        }
        const truncated = result.truncated || text.length > this._ATTACH_MAX_CHARS;
        return {
            name: file.name,
            size: file.size,
            kind: 'pdf',
            pages: result.pages,
            content: text.slice(0, this._ATTACH_MAX_CHARS),
            totalChars: text.length,
            truncated
        };
    },

    clearAttachments() {
        this.pendingAttachments = [];
        this._renderAttachmentChips();
    },

    // Paint the pending-attachment chips into every composer strip (panel,
    // app view, home hero) — the pending list is shared, so a half-composed
    // message survives switching between surfaces, and a file attached on
    // the home page rides along into the agent conversation it opens.
    _renderAttachmentChips() {
        ['agent-attachments', 'agent-app-attachments', 'dash-agent-attachments'].forEach((id) => {
            const strip = document.getElementById(id);
            if (!strip) return;
            const atts = this.pendingAttachments;
            strip.hidden = atts.length === 0;
            strip.innerHTML = atts.map((a, i) => `
                <span class="agent-attachment-chip" title="${this.escapeHtml(a.name)}${a.truncated ? ' — long file; the first part will be shared' : ''}">
                    <span class="agent-attachment-name">${this.escapeHtml(a.name)}</span>
                    <span class="agent-attachment-meta">${a.kind === 'pdf' ? `PDF &middot; ${a.pages} page${a.pages === 1 ? '' : 's'}` : this._formatFileSize(a.size)}${a.truncated ? ' &middot; trimmed' : ''}</span>
                    <button class="agent-attachment-remove" type="button" data-idx="${i}" title="Remove" aria-label="Remove ${this.escapeHtml(a.name)}">&#x2715;</button>
                </span>`).join('');
        });
    },

    _formatFileSize(bytes) {
        if (bytes == null) return '';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    },

    // --- Sending messages ---
    //
    // Parallel-conversation note: the UI tracks AT MOST one visible streaming
    // bubble at a time — the one for the conversation the user is currently
    // viewing. Streams for non-visible conversations continue in the background
    // (state lives in AgentService._streamingState), but don't touch the DOM.
    // When the user switches to a conversation with an in-flight stream,
    // renderMessages rebuilds a bubble from the accumulated content and
    // subscribes a fresh chunk listener.
    _currentStreamBubble: null,
    _currentStreamConvId: null,
    _currentStreamContent: '',
    _currentThinkingText: '',

    // The streaming assistant message can hold two children: an optional
    // reasoning ("thinking") block on top, then the answer bubble. Both share
    // the one #agent-streaming wrapper so they're torn down together when the
    // final persisted message replaces them.
    _ensureStreamingMessage(container) {
        let msg = document.getElementById('agent-streaming');
        if (!msg) {
            msg = document.createElement('div');
            msg.className = 'agent-message agent-message-assistant';
            msg.id = 'agent-streaming';
            container.appendChild(msg);
            // Anchor the question (and the reply's first lines) near the top
            // of the viewport, once. The stream then fills in BELOW the fold —
            // no auto-follow — so the user reads from the start at their own
            // pace; the "↓ New text" pill jumps to the newest text.
            const users = container.querySelectorAll('.agent-message-user');
            const anchor = users.length ? users[users.length - 1] : msg;
            const top = anchor.getBoundingClientRect().top
                - container.getBoundingClientRect().top + container.scrollTop;
            container.scrollTop = Math.max(0, top - 8);
        }
        return msg;
    },

    _createStreamingBubble(container) {
        const msg = this._ensureStreamingMessage(container);
        let bubble = msg.querySelector('.agent-bubble-streaming');
        if (!bubble) {
            bubble = document.createElement('div');
            bubble.className = 'agent-bubble agent-bubble-streaming';
            msg.appendChild(bubble); // after any thinking block
        }
        return bubble;
    },

    // Collapsible reasoning block. Built once per assistant message, shown
    // expanded while the model thinks and collapsed to a summary afterwards.
    _buildThinkingBlock() {
        const block = document.createElement('div');
        block.className = 'agent-thinking-block agent-thinking-block--live';
        block.innerHTML = `
            <button class="agent-thinking-toggle" type="button">
                <span class="agent-thinking-caret" aria-hidden="true">&#9656;</span>
                <span class="agent-thinking-label">Thinking&hellip;</span>
            </button>
            <div class="agent-thinking-content"></div>`;
        block.querySelector('.agent-thinking-toggle').addEventListener('click', () => {
            block.classList.toggle('agent-thinking-block--collapsed');
        });
        return block;
    },

    _ensureThinkingBlock(container) {
        const msg = this._ensureStreamingMessage(container);
        let block = msg.querySelector('.agent-thinking-block');
        if (!block) {
            block = this._buildThinkingBlock();
            msg.insertBefore(block, msg.firstChild); // always above the answer
        }
        return block;
    },

    // Stream over: turn the live block into a quiet, collapsed summary.
    _finalizeThinkingBlock(block) {
        if (!block) return;
        block.classList.remove('agent-thinking-block--live');
        block.classList.add('agent-thinking-block--collapsed');
        const label = block.querySelector('.agent-thinking-label');
        if (label) label.textContent = 'Reasoning';
    },

    // Handles a single streamed chunk for a given convId. Skips the render if
    // the user has navigated away (the bubble reference points to a different
    // conversation, or activeConversationId doesn't match).
    _handleStreamChunk(convId, chunk, event) {
        if (AgentService.activeConversationId !== convId) return;

        // Live reasoning trace — render it into a collapsible block above the
        // answer (the model's chain-of-thought, shown like Ollama's app).
        if (event === 'thinking') {
            const container = this.getMessagesContainer();
            if (!container) return;
            this.hideThinking(); // the model has started; drop the dots
            this._ensureThinkingBlock(container);
            this._currentThinkingText += (chunk || '');
            this._currentStreamConvId = convId;
            this._scheduleStreamRender();
            return;
        }

        if (event === 'thinking-done') {
            const block = document.querySelector('#agent-streaming .agent-thinking-block');
            this._finalizeThinkingBlock(block);
            return;
        }

        // First visible chunk for this conversation: hide thinking, create bubble.
        if (!this._currentStreamBubble) {
            this.hideThinking();
            const container = this.getMessagesContainer();
            if (!container) return;
            this._currentStreamBubble = this._createStreamingBubble(container);
            this._currentStreamConvId = convId;
            this._currentStreamContent = '';
            this._revealedChars = 0;
            // (Viewport anchoring happens once, when the streaming message
            // wrapper is created — see _ensureStreamingMessage.)
        }

        this._currentStreamContent += chunk;
        this._ensureRevealTicker();
    },

    // ── Smoothed reveal (Gemini-style) ─────────────────────────────────
    // Network chunks land in _currentStreamContent; the ticker reveals that
    // buffer at a steady, adaptive pace — whole words at a time, each new
    // word fading in — so bursty token arrival never shows as jitter. The
    // pace targets draining the backlog in ~REVEAL_DRAIN_MS, so a burst
    // catches up quickly while a trickle still types smoothly.
    _revealedChars: 0,
    _revealInterval: null,
    REVEAL_TICK_MS: 80,
    REVEAL_DRAIN_MS: 600,

    _ensureRevealTicker() {
        if (this._revealInterval) return;
        this._revealInterval = setInterval(() => this._revealTick(), this.REVEAL_TICK_MS);
    },

    _stopRevealTicker() {
        if (this._revealInterval) {
            clearInterval(this._revealInterval);
            this._revealInterval = null;
        }
    },

    _revealTick() {
        const bubble = this._currentStreamBubble;
        const container = this.getMessagesContainer();
        if (!bubble || !container || !bubble.isConnected) { this._stopRevealTicker(); return; }
        const content = this._currentStreamContent;
        const backlog = content.length - this._revealedChars;
        if (backlog <= 0) {
            // Caught up — nothing to paint, but keep the pill honest (the
            // user may have scrolled since the last revealed chunk).
            this._updateScrollPill(container);
            return;
        }

        let next = this._revealedChars
            + Math.max(6, Math.ceil(backlog * this.REVEAL_TICK_MS / this.REVEAL_DRAIN_MS));
        if (next >= content.length) {
            next = content.length;
        } else {
            // Extend to the end of the current word so words never appear
            // half-typed (capped so an unbroken run — a long code token —
            // can't stall the reveal).
            const look = content.slice(next, next + 40);
            const ws = look.search(/\s/);
            next = ws === -1 ? Math.min(next + 40, content.length) : next + ws + 1;
        }
        const delta = next - this._revealedChars;
        this._revealedChars = next;

        this._morphStreamHtml(bubble, this._formatStreaming(content.slice(0, next)));
        this._fadeInTail(bubble, delta);
        // No auto-follow: the text grows below the fold and the user scrolls
        // at their own pace. The pill offers the jump to the newest text.
        this._updateScrollPill(container);
    },

    // Px of actual streamed CONTENT below the visible area. NOT raw scroll
    // overflow — the streaming wrapper carries a min-height runway, so
    // scrollHeight counts empty space and would show the pill with nothing
    // to read below (real-usage finding). Null when nothing is streaming.
    _contentBelowViewport(container) {
        const msg = document.getElementById('agent-streaming');
        if (!msg || !container.contains(msg)) return null;
        const bubble = msg.querySelector('.agent-bubble-streaming');
        const think = msg.querySelector('.agent-thinking-content');
        const last = (bubble && bubble.lastElementChild) || (think && think.lastElementChild) || null;
        if (!last) return null;
        return last.getBoundingClientRect().bottom - container.getBoundingClientRect().bottom;
    },

    // Show the pill when a meaningful amount of streamed text sits below the
    // viewport; hide it once the user is (back) near the bottom. The gap
    // between the two thresholds keeps it from blinking at the boundary.
    // Re-evaluated on every reveal tick AND on user scroll — without the
    // scroll hook, a pill shown mid-stream went stale the moment chunks
    // paused (build hand-off, thinking gaps) and lingered over nothing.
    _pillWatchRoots: new Set(),

    _updateScrollPill(container) {
        if (!this._pillWatchRoots.has(container)) {
            this._pillWatchRoots.add(container);
            container.addEventListener('scroll', () => this._updateScrollPill(container), { passive: true });
        }
        const below = this._contentBelowViewport(container);
        if (below === null) { this._setScrollPill(container, false); return; }
        if (below > 120) this._setScrollPill(container, true);
        else if (below < 40) this._setScrollPill(container, false);
    },

    // Wrap the just-revealed characters of the bubble's last text node in a
    // fading span (removed naturally on the next morph, after its animation
    // has run). Best-effort: a delta crossing an inline-format boundary
    // simply appears without the fade for that tick.
    _fadeInTail(bubble, deltaLen) {
        if (deltaLen <= 0) return;
        const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
        let last = null;
        while (walker.nextNode()) {
            if (walker.currentNode.textContent.trim()) last = walker.currentNode;
        }
        if (!last) return;
        const text = last.textContent;
        const cut = Math.max(0, text.length - deltaLen);
        if (cut >= text.length) return;
        const span = document.createElement('span');
        span.className = 'agent-word-in';
        span.textContent = text.slice(cut);
        last.textContent = text.slice(0, cut);
        last.parentNode.insertBefore(span, last.nextSibling);
    },

    // Floating "jump to bottom" pill, shown while streaming with the view
    // scrolled away from the bottom. An absolute overlay on the container's
    // PARENT (never inside the scrolling content — an in-flow sticky pill
    // rendered clipped at arbitrary mid-content positions), anchored just
    // above the messages area's bottom edge.
    _setScrollPill(container, show) {
        const host = container.parentElement || container;
        let pill = host.querySelector(':scope > .agent-scroll-pill');
        if (!show) { if (pill) pill.remove(); return; }
        if (!pill) {
            if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
            pill = document.createElement('div');
            pill.className = 'agent-scroll-pill';
            pill.innerHTML = '<button type="button">&#8595; New text</button>';
            pill.querySelector('button').addEventListener('click', () => {
                // Land on the end of the TEXT, not scrollHeight — the latter
                // would scroll past the content into the runway's empty space.
                const below = this._contentBelowViewport(container);
                if (below === null) container.scrollTop = container.scrollHeight;
                else container.scrollTop += below + 24;
                pill.remove();
            });
            host.appendChild(pill);
        }
        const hostRect = host.getBoundingClientRect();
        const contRect = container.getBoundingClientRect();
        pill.style.bottom = `${Math.max(8, Math.round(hostRect.bottom - contRect.bottom) + 10)}px`;
    },

    // ── Calm streaming render ──────────────────────────────────────────
    // Chunks arrive many times per second; painting each one (and swapping
    // the whole bubble's innerHTML) reads as flicker. Instead: batch chunks
    // on a ~90ms cadence and MORPH the rendered blocks — finished blocks are
    // never touched again, only the block currently growing updates in
    // place, so the text extends quietly like Gemini's streaming.
    _streamRenderTimer: null,
    STREAM_RENDER_MS: 90,

    _scheduleStreamRender() {
        if (this._streamRenderTimer) return;
        this._streamRenderTimer = setTimeout(() => {
            this._streamRenderTimer = null;
            this._renderStreamNow();
        }, this.STREAM_RENDER_MS);
    },

    _renderStreamNow() {
        const container = this.getMessagesContainer();
        if (!container) return;

        const thinkingEl = document.querySelector('#agent-streaming .agent-thinking-content');
        if (thinkingEl && this._currentThinkingText) {
            this._morphStreamHtml(thinkingEl, this._formatStreaming(this._currentThinkingText));
        }
        // (The answer bubble is painted by the smoothed reveal ticker, not
        // here.) No auto-follow — same reading model as the answer.
        this._updateScrollPill(container);
    },

    // Minimal top-level DOM morph: keep the identical leading blocks, update
    // the first differing block in place (same element kind), then append any
    // genuinely new blocks. Element identity is preserved for everything
    // that isn't changing, which is what kills the flicker.
    _morphStreamHtml(target, html) {
        const tpl = document.createElement('template');
        tpl.innerHTML = html;
        const fresh = Array.from(tpl.content.childNodes);
        const old = Array.from(target.childNodes);

        const same = (a, b) => a.nodeType === b.nodeType && a.nodeName === b.nodeName
            && (a.nodeType === Node.ELEMENT_NODE ? a.outerHTML === b.outerHTML : a.textContent === b.textContent);

        let i = 0;
        while (i < old.length && i < fresh.length && same(old[i], fresh[i])) i++;

        // Update the first differing node in place when it's the same kind —
        // this is the block currently receiving text.
        let inPlace = false;
        if (i < old.length && i < fresh.length
            && old[i].nodeType === fresh[i].nodeType && old[i].nodeName === fresh[i].nodeName) {
            if (old[i].nodeType === Node.ELEMENT_NODE) {
                // Sync attributes too so outerHTML converges once the block
                // stops changing (otherwise the prefix scan stalls here).
                for (const a of Array.from(old[i].attributes)) {
                    if (!fresh[i].hasAttribute(a.name)) old[i].removeAttribute(a.name);
                }
                for (const a of Array.from(fresh[i].attributes)) {
                    if (old[i].getAttribute(a.name) !== a.value) old[i].setAttribute(a.name, a.value);
                }
                if (old[i].innerHTML !== fresh[i].innerHTML) old[i].innerHTML = fresh[i].innerHTML;
            } else if (old[i].textContent !== fresh[i].textContent) {
                old[i].textContent = fresh[i].textContent;
            }
            inPlace = true;
        }

        // Drop stale trailing nodes, then append the genuinely new ones.
        for (let k = old.length - 1; k >= i + (inPlace ? 1 : 0); k--) target.removeChild(old[k]);
        for (let k = i + (inPlace ? 1 : 0); k < fresh.length; k++) target.appendChild(fresh[k]);
    },

    // Drop the centered "fresh chat" layout: remove the modifier class and the
    // greeting hero. Safe to call when neither is present (no-op).
    _exitEmptyState() {
        document.querySelector('.agent-chat-main--empty')?.classList.remove('agent-chat-main--empty');
        document.querySelector('.agent-empty-hero')?.remove();
    },

    async sendMessage() {
        const input = this.getInput();
        const text = input?.value?.trim() || '';
        const attachments = this.pendingAttachments.slice();
        if (!text && !attachments.length) return;

        // Per-conversation re-entrancy: if THIS conv is already streaming, the
        // message queues instead of being dropped — it goes out as the next
        // turn when the current one ends. Different conversations can stream
        // in parallel.
        const currentConvId = AgentService.activeConversationId;
        if (currentConvId && AgentService.isConversationStreaming(currentConvId)) {
            this.queueComposerMessage();
            return;
        }

        input.value = '';
        this._autoGrowComposer(input);
        this.clearAttachments();

        await this._dispatchMessage(text, attachments);
    },

    // The actual turn: renders the user bubble, runs the stream, finalizes the
    // reply, then drains any messages queued while it ran. `text`/`attachments`
    // are already detached from the composer.
    async _dispatchMessage(text, attachments) {
        // Ensure a conversation exists BEFORE we capture streamingConvId below.
        // On a cold first message there's no active conversation yet, so
        // AgentService.sendMessage would create one lazily mid-call — leaving
        // streamingConvId null. After the await, activeConversationId is the new
        // id, so `stillOnOrigin` is false and the assistant reply is never
        // appended to the UI (it's persisted, so it only appears after a
        // refresh). Creating it here keeps the id in sync end-to-end. It's the
        // same conversation the service would have made, just created up front.
        if (!AgentService.activeConversationId) {
            AgentService.openFreshConversation();
        }

        // Leave the centered empty-state layout the instant the chat gets its
        // first message — addMessage appends directly (no full re-render), so
        // the class/hero must be cleared here or they'd linger above the reply.
        this._exitEmptyState();

        this.addMessage('user', text, undefined, attachments.length
            ? { attachments: attachments.map(a => ({ name: a.name, size: a.size, kind: a.kind, pages: a.pages, truncated: a.truncated })) }
            : undefined);
        // If the model isn't resident yet, label the wait as a one-time load
        // (captured before _setSendStopState flips readiness into 'preparing').
        this.showThinking(this._isModelCold());
        this._setSendStopState(true);
        // The in-stream indicator now owns the "loading" story — drop the
        // composer hint so the two don't double up.
        ['agent-warming-hint', 'agent-app-warming-hint'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.hidden = true;
        });

        // Capture the conversation this message belongs to. If the user switches
        // away mid-stream we still want chunks to route correctly and the final
        // response to land in the originating chat, not the one they switched to.
        const streamingConvId = AgentService.activeConversationId;

        // Reset visible bubble state for a fresh stream
        this._currentStreamBubble = null;
        this._currentStreamConvId = streamingConvId;
        this._currentStreamContent = '';
        this._currentThinkingText = '';
        this._revealedChars = 0;
        this._activityGroup = null;
        this._activityCount = 0;

        const onChunk = (chunk, event) => {
            this._handleStreamChunk(streamingConvId, chunk, event);
        };

        const response = await AgentService.sendMessage(text, onChunk,
            attachments.length ? { attachments } : {});

        this.hideThinking();
        // Restore the send button if the user is still on the originating chat
        // (a background chat finishing shouldn't flip the button for the chat
        // they've switched to — renderMessages handles that on switch).
        if (AgentService.activeConversationId === streamingConvId) {
            this._setSendStopState(false);
        }

        // Finalize the visible bubble only if the user is still viewing the
        // originating conversation. If they've switched away, the service has
        // already persisted the final response — the next renderMessages will
        // pick it up from storage when they come back.
        const stillOnOrigin = AgentService.activeConversationId === streamingConvId;

        if (stillOnOrigin) {
            this._stopRevealTicker();
            this._finalizeActivityGroup();
            document.querySelectorAll('.agent-scroll-pill').forEach(p => p.remove());
            const streamEl = document.getElementById('agent-streaming');
            const streamedText = streamEl?.textContent || '';
            if (streamEl) streamEl.remove();
            this._currentStreamBubble = null;
            this._currentStreamConvId = null;
            this._currentStreamContent = '';
            this._revealedChars = 0;

            if (response) {
                if (response.type === 'error') {
                    this.addSystemMessage(response.content);
                } else {
                    const content = response.content || streamedText;
                    // Pass sources AND created/updated records through so the
                    // provenance footer and the record pills show on the live
                    // bubble too, not only after a re-render (the pills are
                    // the lasting "open what I just made" affordance — they
                    // must appear the moment the work is done).
                    const liveMeta = {};
                    if (response.sources) liveMeta.sources = response.sources;
                    if (response.records) liveMeta.records = response.records;
                    if (content) this.addMessage('assistant', content, response.thinking,
                        Object.keys(liveMeta).length ? liveMeta : undefined);
                }

                if (response._timings) {
                    // Show TTFT (time-to-first-token) on the bubble. That's
                    // when the user's subjective "wait" ended — everything
                    // after was streaming in incrementally. Fall back to totalMs
                    // only if ttft wasn't captured (no-chunks error path).
                    const shownMs = response._timings.ttftMs ?? response._timings.totalMs;
                    const secs = (shownMs / 1000).toFixed(1);
                    const container = this.getMessagesContainer();
                    const lastBubble = container?.querySelector('.agent-message-assistant:last-child .agent-bubble');
                    if (lastBubble) {
                        const timeEl = document.createElement('span');
                        timeEl.className = 'agent-response-time';
                        timeEl.textContent = `${secs}s`;
                        lastBubble.appendChild(timeEl);
                    }
                }
            }

            // Now that the turn is finished (normal or stopped), offer
            // "edit & resend" on the question that was just answered.
            this._decorateLastUserMessage(this.getMessagesContainer());
        }

        // Always refresh the sidebar so the streaming indicator on the originating
        // conv is removed (and its title/message count updated if it changed).
        if (this.mode === 'app') {
            this.renderHistorySidebar();
        }

        // Messages queued while this turn ran (send-while-streaming, or the
        // interrupt-&-send button) go out now as one combined turn.
        this._drainQueuedMessages(streamingConvId);
    },

    // Scroll to the bottom only when the user is already there — content
    // appearing mid-turn must not yank the view away from what they're reading.
    _scrollToBottomIfPinned(container) {
        if ((container.scrollHeight - container.scrollTop - container.clientHeight) < 80) {
            container.scrollTop = container.scrollHeight;
        }
    },

    addMessage(role, content, thinking, metadata) {
        const container = this.getMessagesContainer();
        if (!container) return;
        this._appendMessage(container, role, content, undefined, metadata, thinking);
        // The user's own message always comes into view; an assistant message
        // lands where the (already anchored) streaming bubble was — keep the
        // reading position instead of jumping to its end.
        if (role === 'user') container.scrollTop = container.scrollHeight;
        else this._scrollToBottomIfPinned(container);
    },

    addSystemMessage(content) {
        const container = this.getMessagesContainer();
        if (!container) return;
        const div = document.createElement('div');
        div.className = 'agent-message agent-message-system';
        div.innerHTML = `<div class="agent-system-text">${content}</div>`;
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    },

    // ── Per-turn activity group ─────────────────────────────────────────
    // Tool chips fold into one collapsible block per turn: earlier steps
    // collapse behind a "N steps" toggle, only the NEWEST chip stays
    // visible while the turn runs, and when the turn completes the last
    // chip tucks in too, leaving a one-line "✓ N steps" summary.
    _activityGroup: null,
    _activityCount: 0,

    _ensureActivityGroup(container) {
        if (this._activityGroup && container.contains(this._activityGroup)) return this._activityGroup;
        const group = document.createElement('div');
        group.className = 'agent-message agent-activity';
        group.innerHTML = `
            <div class="agent-activity-toggle" role="button" tabindex="0" aria-expanded="false">
                <span class="agent-activity-caret" aria-hidden="true">&#9656;</span>
                <span class="agent-activity-count"></span>
            </div>
            <div class="agent-activity-body" hidden></div>
            <div class="agent-activity-latest"></div>`;
        const toggle = group.querySelector('.agent-activity-toggle');
        const flip = () => {
            const body = group.querySelector('.agent-activity-body');
            const open = body.hidden;
            body.hidden = !open;
            group.classList.toggle('agent-activity--open', open);
            toggle.setAttribute('aria-expanded', String(open));
        };
        toggle.addEventListener('click', flip);
        toggle.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
        container.appendChild(group);
        this._activityGroup = group;
        this._activityCount = 0;
        return group;
    },

    // Turn over: tuck the last visible chip into the collapsed body and
    // leave the one-line summary. Safe to call when no group exists.
    _finalizeActivityGroup() {
        const group = this._activityGroup;
        this._activityGroup = null;
        const count = this._activityCount;
        this._activityCount = 0;
        if (!group || !group.isConnected) return;
        const body = group.querySelector('.agent-activity-body');
        const latest = group.querySelector('.agent-activity-latest');
        while (latest.firstChild) body.appendChild(latest.firstChild);
        group.classList.add('agent-activity--done');
        group.querySelector('.agent-activity-count').textContent =
            `✓ ${count} step${count === 1 ? '' : 's'}`;
    },

    onToolExecution(convId, toolResults) {
        // Tool execution for a background stream shouldn't touch the visible UI.
        if (convId !== AgentService.activeConversationId) return;

        // Reset streaming state — tools were called, next response will be new
        const streamEl = document.getElementById('agent-streaming');
        if (streamEl) streamEl.remove();
        this._currentStreamBubble = null;
        this._currentStreamContent = '';
        this._currentThinkingText = '';
        this.hideThinking();
        this.showThinking();

        const container = this.getMessagesContainer();
        if (!container) return;
        const group = this._ensureActivityGroup(container);
        const groupBody = group.querySelector('.agent-activity-body');
        const groupLatest = group.querySelector('.agent-activity-latest');
        for (const tr of toolResults) {
            const div = document.createElement('div');
            div.className = 'agent-message agent-message-tool';
            const label = tr.tool.replace(/_/g, ' ');
            const icon = tr.result?.error ? '!' : '\u2713';
            // Format tool-call args for display. Arrays/objects used to coerce
            // to "[object Object]"; now we JSON-stringify and truncate. Also
            // HTML-escape to keep user-entered strings safe — tool args are
            // model-controlled but the model can echo user input verbatim.
            const fmtVal = (v) => {
                if (v === null || v === undefined) return null;
                if (typeof v === 'string') return v;
                if (typeof v === 'number' || typeof v === 'boolean') return String(v);
                try {
                    const json = JSON.stringify(v);
                    return json.length > 80 ? json.slice(0, 77) + '…' : json;
                } catch { return String(v); }
            };
            const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            }[c]));
            const argParts = [];
            for (const [k, v] of Object.entries(tr.args || {})) {
                if (k === 'id') continue;
                const fmt = fmtVal(v);
                if (fmt === null || fmt === '') continue;
                argParts.push(`${escapeHtml(k)}: ${escapeHtml(fmt)}`);
            }
            const argSummary = argParts.join(', ');
            const argsHtml = argSummary ? `<span class="agent-tool-args">${argSummary}</span>` : '';
            div.innerHTML = `<div class="agent-tool-indicator"><span class="agent-tool-icon">${icon}</span> ${label}${argsHtml}</div>`;
            // Created something the user will want to see? Put the way there
            // on the chip — deterministic harness UX, not model-formatted
            // links (a small model can't be trusted to emit them).
            const openable = this._openableFromResult(tr.tool, tr.result);
            if (openable) {
                const link = document.createElement('button');
                link.className = 'agent-tool-open';
                link.textContent = openable.label;
                link.onclick = openable.open;
                div.querySelector('.agent-tool-indicator').appendChild(link);
            }
            // Older chips fold behind the toggle; the newest stays visible.
            while (groupLatest.firstChild) groupBody.appendChild(groupLatest.firstChild);
            groupLatest.appendChild(div);
            this._activityCount++;
        }
        group.querySelector('.agent-activity-count').textContent =
            `${this._activityCount} step${this._activityCount === 1 ? '' : 's'}`;
        this._scrollToBottomIfPinned(container);
    },

    /**
     * Map a tool result to an "open it" affordance for the tool chip.
     * Everything with a record id deep-links to the exact record via
     * _openRecord. Build tools are covered by the build card's own buttons.
     * Mostly create/update, but get_note earns one too — when an answer
     * leans on a note, the chip is the shortest path back to it.
     */
    _openableFromResult(toolName, result) {
        if (!result || result.error || result.cancelled) return null;
        const openRec = (app, id, label) => ({ label, open: () => this._openRecord(app, id) });
        switch (toolName) {
            case 'create_note':
            case 'update_note': return openRec('notes', result.note?.id, 'Open note');
            // get_note returns the note flat, not wrapped in a `note` key.
            case 'get_note':
                return result.id ? openRec('notes', result.id, 'Open note') : null;
            case 'create_journal_entry': return openRec('journal', result.entry?.id, 'Open journal');
            case 'create_goal':
            case 'update_goal': return openRec('goals', result.goal?.id, 'Open goal');
            case 'create_focus': return openRec('focus', result.focus?.id, 'Open focus');
            case 'create_schedule_item':
            case 'update_schedule_item': return openRec('schedule', result.item?.id, 'Open task');
            case 'create_bookmark': return openRec('bookmarks', result.bookmark?.id, 'Open bookmark');
            case 'create_calendar_event': return openRec('calendar', result.created?.id, 'Open event');
            case 'update_calendar_event': return openRec('calendar', result.updated?.id, 'Open event');
            default: return null;
        }
    },

    // Deep-link to a record the agent touched: switch the app view, then
    // open the record's editor once the view is active (the same
    // openApp + setTimeout idiom every cross-app link in the codebase uses).
    // Without an id (or an unknown app) it degrades to opening the app view.
    _openRecord(app, id) {
        AppManager.openApp(app, false);
        if (!id) return;
        const editors = {
            notes: () => typeof NotesApp !== 'undefined' && NotesApp.openEditor?.(id),
            schedule: () => typeof ScheduleApp !== 'undefined' && ScheduleApp.openEditor?.(id),
            goals: () => typeof GoalsApp !== 'undefined' && GoalsApp.openEditor?.(id),
            focus: () => typeof FocusApp !== 'undefined' && FocusApp.openEditor?.(id),
            journal: () => typeof JournalApp !== 'undefined' && JournalApp.openEditor?.(id),
            bookmarks: () => typeof BookmarksApp !== 'undefined' && BookmarksApp.openEditor?.(id),
            calendar: () => typeof CalendarApp !== 'undefined' && CalendarApp.openEventById?.(id)
        };
        const open = editors[app];
        if (open) setTimeout(open, 0);
    },

    // Pill row under an assistant answer for records it created/updated
    // (metadata.records — see recordRecords in agent-service). Labels go in
    // via textContent, never innerHTML: titles echo model/user text.
    _buildRecordPills(records) {
        const KIND = {
            notes: 'Note', schedule: 'Task', goals: 'Goal', focus: 'Focus',
            journal: 'Journal', bookmarks: 'Bookmark', calendar: 'Event'
        };
        const row = document.createElement('div');
        row.className = 'agent-msg-records';
        for (const rec of records) {
            if (!rec || !rec.app || !rec.id) continue;
            const btn = document.createElement('button');
            btn.className = 'agent-record-pill';
            const kind = document.createElement('span');
            kind.className = 'agent-record-pill-kind';
            kind.textContent = KIND[rec.app] || rec.app;
            btn.appendChild(kind);
            const label = document.createElement('span');
            label.className = 'agent-record-pill-title';
            label.textContent = rec.title || 'Open';
            btn.appendChild(label);
            const verb = rec.action === 'updated' ? 'Updated'
                : rec.action === 'completed' ? 'Completed' : 'Created';
            btn.title = `${verb} — click to open`;
            btn.onclick = () => this._openRecord(rec.app, rec.id);
            row.appendChild(btn);
        }
        return row.childElementCount ? row : null;
    },

    // --- Build progress card ---
    // The create_app/edit_app/create_artifact/edit_artifact tools dispatch to
    // the App Studio / Maker engines, which stream {type, message} progress
    // events for minutes. This renders them as ONE live card in the
    // conversation (status line + rolling action log) instead of a wall of
    // messages. The card is ephemeral UI, not part of the conversation
    // history — on re-render it disappears and is recreated by the next event.
    // --- Build progress card ---
    // One card per build, shared by the docked panel and the chat page (both
    // route through here). Design: a STEP TIMELINE that accumulates — each
    // phase is a row, finished rows keep a check mark, the active row pulses,
    // text wraps rather than truncating. High-volume token streams never show
    // raw text (unreadable churn); a calm "Reasoning… 3.2k characters"
    // counter plus an elapsed timer carry the "still working" signal.
    _buildCard: null,
    _buildCardTimer: null,
    _buildActivityAt: 0,

    _createBuildCard(container, kind, startedAt) {
        const card = document.createElement('div');
        card.className = 'agent-message agent-build-card';
        card.innerHTML = `
            <div class="agent-build-head">
                <span class="agent-warming-spinner" aria-hidden="true"></span>
                <span class="agent-build-title">${kind === 'app' ? 'Building app…' : 'Building artifact…'}</span>
                <span class="agent-build-elapsed">0:00</span>
            </div>
            <div class="agent-build-steps"></div>
            <div class="agent-build-activity"></div>
            <div class="agent-build-status"></div>`;
        // Deterministic placement: inside the current turn, right below
        // the question/tool chips — BEFORE the streaming wrapper's
        // runway. Appending after it pushed the card below the fold at
        // seemingly random spots.
        const streamEl = document.getElementById('agent-streaming');
        if (streamEl && streamEl.parentNode === container) container.insertBefore(card, streamEl);
        else container.appendChild(card);
        this._buildCard = card;
        // Elapsed timer, anchored on the build's REAL start time so a card
        // restored after navigation doesn't restart from 0:00.
        clearInterval(this._buildCardTimer);
        this._buildCardTimer = setInterval(() => {
            const el = card.querySelector('.agent-build-elapsed');
            if (!el || !card.isConnected) { clearInterval(this._buildCardTimer); return; }
            const s = Math.floor((Date.now() - startedAt) / 1000);
            el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        }, 1000);
        return card;
    },

    // Rebuild the in-flight build's progress card from BuildStatus after the
    // transcript was re-rendered (navigate away and back): full step
    // timeline, activity line, truthful elapsed time.
    _restoreBuildCard(container, bs) {
        const card = this._createBuildCard(container, bs.kind, bs.startedAt);
        const stepsEl = card.querySelector('.agent-build-steps');
        for (const st of bs.steps) {
            const row = document.createElement('div');
            row.className = `agent-build-step agent-build-step--${st.cls}`;
            row.innerHTML = '<span class="agent-build-step-mark" aria-hidden="true"></span><span class="agent-build-step-text"></span>';
            row.querySelector('.agent-build-step-text').textContent = st.text;
            stepsEl.appendChild(row);
        }
        card.querySelector('.agent-build-activity').textContent = bs.activity || '';
        const sec = Math.floor((Date.now() - bs.startedAt) / 1000);
        card.querySelector('.agent-build-elapsed').textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
        return card;
    },

    onBuildProgress(convId, kind, e) {
        // Builds triggered from a conversation the user navigated away from
        // keep running; only the visible conversation renders progress.
        if (convId !== AgentService.activeConversationId) return;
        const container = this.getMessagesContainer();
        if (!container || !e) return;

        let card = (this._buildCard && container.contains(this._buildCard)) ? this._buildCard : null;
        if (!card) {
            this.hideThinking(); // the card itself signals activity
            const startedAt = (typeof BuildStatus !== 'undefined' && BuildStatus.current?.startedAt) || Date.now();
            card = this._createBuildCard(container, kind, startedAt);
        }
        const stepsEl = card.querySelector('.agent-build-steps');
        const activityEl = card.querySelector('.agent-build-activity');
        const statusEl = card.querySelector('.agent-build-status');

        const settleActive = (cls) => {
            const prev = stepsEl.querySelector('.agent-build-step--active');
            if (prev) {
                prev.classList.remove('agent-build-step--active');
                prev.classList.add(cls || 'agent-build-step--done');
            }
        };
        const addStep = (text, cls) => {
            if (!text) return;
            const row = document.createElement('div');
            row.className = `agent-build-step ${cls}`;
            row.innerHTML = '<span class="agent-build-step-mark" aria-hidden="true"></span><span class="agent-build-step-text"></span>';
            row.querySelector('.agent-build-step-text').textContent = text;
            stepsEl.appendChild(row);
            while (stepsEl.children.length > 12) stepsEl.removeChild(stepsEl.firstChild);
        };
        const stopTimer = () => { clearInterval(this._buildCardTimer); this._buildCardTimer = null; };

        if (e.type === 'status') {
            settleActive();
            activityEl.textContent = '';
            addStep(e.message, 'agent-build-step--active');
        } else if (e.type === 'tool') {
            // Tool events are completed actions ("Writing app.js") — they
            // land as already-done rows under the active phase.
            addStep(e.message, 'agent-build-step--done');
        } else if (e.type === 'thinking' || e.type === 'model') {
            // Never render the raw stream — it swaps too fast to read and
            // truncates mid-code. A throttled counter carries the signal
            // (with a trailing update so the last value always lands).
            const len = (e.message || '').length;
            const label = e.type === 'thinking' ? 'Reasoning' : 'Writing';
            const render = () => {
                if (!activityEl.isConnected) return;
                activityEl.textContent = len > 900
                    ? `${label}… ${(len / 1000).toFixed(1)}k characters`
                    : `${label}…`;
            };
            const now = Date.now();
            clearTimeout(this._buildActivityTrail);
            if (now - this._buildActivityAt > 250) {
                this._buildActivityAt = now;
                render();
            } else {
                this._buildActivityTrail = setTimeout(render, 260);
            }
        } else if (e.type === 'error') {
            card.classList.add('agent-build-card--error');
            card.querySelector('.agent-warming-spinner')?.remove();
            card.querySelector('.agent-build-title').textContent = kind === 'app' ? 'App build failed' : 'Artifact build failed';
            settleActive('agent-build-step--failed');
            activityEl.textContent = '';
            statusEl.textContent = e.message || '';
            stopTimer();
            this._buildCard = null;
        } else if (e.type === 'done') {
            card.classList.add('agent-build-card--done');
            card.querySelector('.agent-warming-spinner')?.remove();
            card.querySelector('.agent-build-title').textContent = kind === 'app' ? 'App built' : 'Artifact built';
            settleActive();
            activityEl.textContent = '';
            statusEl.textContent = (e.summary || '').slice(0, 200);
            stopTimer();
            const id = e.appId || e.artifactId;
            if (id) {
                const btn = document.createElement('button');
                btn.className = 'agent-build-open';
                btn.textContent = kind === 'app' ? 'Open in App Studio' : 'Open in Maker';
                btn.onclick = () => {
                    if (kind === 'app') {
                        if (typeof AppStudioApp !== 'undefined') AppStudioApp._lastAppId = id;
                        AppManager.openApp('appstudio');
                    } else {
                        if (typeof MakerApp !== 'undefined') MakerApp._currentId = id;
                        AppManager.openApp('maker');
                    }
                };
                card.appendChild(btn);
            }
            this._buildCard = null;
        }
        this._scrollToBottomIfPinned(container);
    },

    // --- Task progress card (C4 task mode) ---
    // One live card per task in its conversation: the plan with per-step
    // status, the task's status line, and stage-appropriate controls
    // (Run plan / Pause / Resume / Cancel). Ephemeral UI — the final report
    // is a normal assistant message; the card just tracks the run.
    _taskCards: new Map(),   // taskId -> element

    onTaskUpdate(task) {
        if (!task || task.conversationId !== AgentService.activeConversationId) return;
        const container = this.getMessagesContainer();
        if (!container) return;
        const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));

        let card = this._taskCards.get(task.id);
        if (!card || !container.contains(card)) {
            card = document.createElement('div');
            card.className = 'agent-message agent-task-card';
            container.appendChild(card);
            this._taskCards.set(task.id, card);
        }

        const STEP_ICONS = { pending: '&#8226;', active: '<span class="agent-warming-spinner" aria-hidden="true"></span>', done: '&#10003;', failed: '&#10007;' };
        const stepsHtml = (task.plan || []).map((s, i) => `
            <div class="agent-task-step agent-task-step--${esc(s.status)}">
                <span class="agent-task-step-icon">${STEP_ICONS[s.status] || '&#8226;'}</span>
                <span class="agent-task-step-text">${i + 1}. ${esc(s.step)}${s.note ? `<span class="agent-task-step-note"> — ${esc(s.note)}</span>` : ''}</span>
            </div>`).join('');

        // awaiting_user covers two moments: initial plan approval (nothing
        // has run) and a mid-task pause on a declined permission. approve()
        // re-enters at the current step either way — only the labels differ.
        const started = (task.plan || []).some(s => s.status !== 'pending');
        const TITLE = {
            planning: 'Planning task…',
            awaiting_user: started ? 'Task waiting on you' : 'Task plan — run it?',
            running: 'Task running…', verifying: 'Checking the work…',
            paused: 'Task paused',
            done: 'Task complete', failed: 'Task did not finish'
        };
        const busy = ['planning', 'running', 'verifying'].includes(task.status);
        const buttons = [];
        if (task.status === 'awaiting_user') buttons.push(['approve', started ? 'Resume' : 'Run plan', 'primary'], ['cancel', 'Cancel', '']);
        else if (busy) buttons.push(['pause', 'Pause', ''], ['cancel', 'Cancel', '']);
        else if (task.status === 'paused') buttons.push(['resume', 'Resume', 'primary'], ['cancel', 'Cancel', '']);

        card.classList.toggle('agent-task-card--failed', task.status === 'failed');
        card.classList.toggle('agent-task-card--done', task.status === 'done');
        card.innerHTML = `
            <div class="agent-build-head">
                ${busy ? '<span class="agent-warming-spinner" aria-hidden="true"></span>' : ''}
                <span class="agent-build-title">${TITLE[task.status] || esc(task.status)}</span>
            </div>
            <div class="agent-task-goal">${esc(task.goal)}</div>
            <div class="agent-task-steps">${stepsHtml}</div>
            <div class="agent-build-status">${esc(task.note || '')}</div>
            ${buttons.length ? `<div class="agent-task-actions">${buttons.map(([act, label, kind]) =>
                `<button class="agent-task-btn${kind ? ' agent-task-btn--primary' : ''}" data-task-action="${act}">${label}</button>`).join('')}</div>` : ''}`;

        card.querySelectorAll('button[data-task-action]').forEach(btn => {
            btn.onclick = () => {
                const act = btn.dataset.taskAction;
                if (act === 'approve') TaskService.approve(task.id);
                else if (act === 'pause') TaskService.pause(task.id);
                else if (act === 'resume') TaskService.resume(task.id);
                else if (act === 'cancel') TaskService.cancel(task.id);
            };
        });
        this._scrollToBottomIfPinned(container);
    },

    showThinking(warming = false) {
        const container = this.getMessagesContainer();
        if (!container) return;
        const div = document.createElement('div');
        div.className = 'agent-message agent-message-assistant';
        div.id = 'agent-thinking';
        if (warming) {
            // Cold send: name the wait as a one-time model load instead of the
            // anonymous thinking dots. Replaced the instant the first token or
            // reasoning arrives (hideThinking in _handleStreamChunk).
            const model = this._activeModelName();
            const esc = (s) => String(s).replace(/[&<>"']/g, c => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            }[c]));
            div.classList.add('agent-message--warming');
            div.innerHTML = `<div class="agent-warming-indicator">`
                + `<span class="agent-warming-spinner" aria-hidden="true"></span>`
                + `<span class="agent-warming-body">`
                + `<span class="agent-warming-title">Warming up${model ? ' ' + esc(model) : ' the model'}…</span>`
                + `<span class="agent-warming-note">First reply only — loading into memory. Later replies start instantly.</span>`
                + `</span></div>`;
        } else {
            div.innerHTML = '<div class="agent-thinking"><span></span><span></span><span></span></div>';
        }
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    },

    hideThinking() {
        const el = document.getElementById('agent-thinking');
        if (el) el.remove();
    },

    // --- New chat ---

    newChat() {
        // Parallel conversations: creating a new chat while another stream is
        // in flight is fine. The old stream continues silently in the background
        // and persists its response to the originating conversation. We call
        // renderMessages here so any stream subscription for the old conv is
        // detached cleanly — see the early section of renderMessages.
        //
        // If the panel is docked over a record (task/note/…), keep the
        // fresh chat tied to that record so reopening the assistant here later
        // resumes it. In the full-app view there's no active record, so this is
        // null and the new chat is a general one.
        const rec = (typeof AgentContext !== 'undefined') ? AgentContext.getActiveRecord() : null;
        // Record chats stay createConversation (the binding matters); a plain
        // new chat reuses an existing blank instead of minting another.
        if (rec?.key) AgentService.createConversation(rec.key, rec.label);
        else AgentService.openFreshConversation();
        this.renderMessages();
        this.updateModelLabel();
        this.updateContextChip();
        if (this.mode === 'app') {
            this.renderHistorySidebar();
            document.getElementById('agent-app-input')?.focus();
        } else {
            document.getElementById('agent-input')?.focus();
        }
    },

    // --- Helpers ---

    formatContent(text) {
        if (!text) return '';

        // Escape HTML first — everything below only reintroduces the tags we whitelist.
        // SECURITY (H4): quotes MUST be escaped here too. _formatInline later
        // interpolates model-supplied URLs into href="${url}"; without escaping
        // `"`, a link like [x](https://e.com"onmouseover="alert(1)) would break
        // out of the attribute and inject a live event handler in the renderer.
        const escaped = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');

        const lines = escaped.split('\n');
        const out = [];
        // Stack of open lists, deepest last. Each entry: { type, indent, hasOpenLi }.
        // Tracking nesting (rather than a single listType) is what lets indented
        // bullets render as a sublist inside the current <li> instead of closing
        // the parent <ol> and re-opening a fresh one — which is what produced
        // "1.", "1.", "1.", "1." for the four news items in a search result.
        const listStack = [];
        let textBuffer = [];

        const flushText = () => {
            if (textBuffer.length === 0) return;
            out.push('<p>' + textBuffer.map(l => this._formatInline(l)).join('<br>') + '</p>');
            textBuffer = [];
        };
        const closeTopLi = () => {
            const top = listStack[listStack.length - 1];
            if (top && top.hasOpenLi) { out.push('</li>'); top.hasOpenLi = false; }
        };
        const popList = () => {
            closeTopLi();
            const t = listStack.pop();
            if (t) out.push(`</${t.type}>`);
        };
        const closeAllLists = () => {
            while (listStack.length) popList();
        };
        const openListItem = (indent, type, content) => {
            // Pop any deeper lists (de-nest).
            while (listStack.length && listStack[listStack.length - 1].indent > indent) {
                popList();
            }
            const top = listStack[listStack.length - 1];
            if (top && top.indent === indent) {
                if (top.type !== type) {
                    // Same level, different type — replace.
                    popList();
                } else {
                    // Sibling at same level — close previous <li> in this list.
                    closeTopLi();
                }
            }
            const newTop = listStack[listStack.length - 1];
            if (!newTop || newTop.indent < indent) {
                // Open a nested list (the parent's <li> stays open so the new
                // list ends up inside it — which is what gives us proper
                // ordered-list auto-numbering for siblings of the parent <li>).
                out.push(`<${type}>`);
                listStack.push({ type, indent, hasOpenLi: false });
            }
            out.push(`<li>${this._formatInline(content)}`);
            listStack[listStack.length - 1].hasOpenLi = true;
        };

        // Markdown table detection helpers
        const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
        const isTableSeparator = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
        const parseTableRow = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

        let i = 0;
        while (i < lines.length) {
            const line = lines[i];

            // Fenced code block (``` or ```lang). Contents render verbatim in
            // a <pre><code> with a header bar (language + copy button — wired
            // by the delegated handler in _installCopyHandlers). An
            // unterminated fence (mid-stream) swallows the rest of the text
            // as code so streaming doesn't flicker between layouts.
            const fence = line.match(/^\s*```([\w+#-]*)\s*$/);
            if (fence) {
                flushText();
                closeAllLists();
                const codeLines = [];
                i++;
                while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
                    codeLines.push(lines[i]);
                    i++;
                }
                i++; // past the closing fence (or the end, when streaming)
                out.push(
                    '<div class="agent-codeblock">'
                    + `<div class="agent-codeblock-head"><span class="agent-codeblock-lang">${fence[1] || 'code'}</span>`
                    + '<button class="agent-code-copy" title="Copy code">Copy</button></div>'
                    + `<pre><code>${codeLines.join('\n')}</code></pre></div>`
                );
                continue;
            }

            // Blank line → paragraph break. Flush buffered text, but leave any
            // open list open — models frequently emit numbered/bulleted items
            // separated by blank lines, and closing the list here would start
            // a new <ol> per item and re-render every one as "1.". Lists are
            // closed by the next non-blank, non-list-item line (any of the
            // other block handlers below, or the regular-text path).
            if (line.trim() === '') {
                flushText();
                i++;
                continue;
            }

            // Horizontal rule: a line containing only ---, ***, or ___
            if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
                flushText();
                closeAllLists();
                out.push('<hr>');
                i++;
                continue;
            }

            // Markdown table: a pipe-row followed by a separator row
            if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
                flushText();
                closeAllLists();
                const headerCells = parseTableRow(line);
                i += 2; // skip header + separator
                const rows = [];
                while (i < lines.length && isTableRow(lines[i])) {
                    rows.push(parseTableRow(lines[i]));
                    i++;
                }
                let html = '<table><thead><tr>';
                for (const h of headerCells) html += `<th>${this._formatInline(h)}</th>`;
                html += '</tr></thead><tbody>';
                for (const row of rows) {
                    html += '<tr>';
                    for (const c of row) html += `<td>${this._formatInline(c)}</td>`;
                    html += '</tr>';
                }
                html += '</tbody></table>';
                out.push(html);
                continue;
            }

            // Markdown headers (# through ######). Map depth to a sensible bubble-sized tag.
            const hashHeader = line.match(/^(#{1,6})\s+(.+)$/);
            if (hashHeader) {
                flushText();
                closeAllLists();
                const level = hashHeader[1].length;
                const tag = level <= 2 ? 'h3' : level === 3 ? 'h4' : 'h5';
                out.push(`<${tag}>${this._formatInline(hashHeader[2])}</${tag}>`);
                i++;
                continue;
            }

            // Fully-bolded single line → treat as a section header. Many LLMs
            // emit lines like "**Financial & Operational Aspects**" as ad-hoc
            // headings — particularly when the title contains an emoji or
            // punctuation the model can't combine cleanly with `###`. Promoting
            // them to h4 is a cosmetic improvement that's safe for any model:
            // regular inline bold inside a sentence doesn't match (the regex
            // requires the line to consist solely of the bolded content).
            const boldHeader = line.match(/^\s*\*\*(.+?)\*\*\s*$/);
            if (boldHeader) {
                flushText();
                closeAllLists();
                out.push(`<h4>${this._formatInline(boldHeader[1])}</h4>`);
                i++;
                continue;
            }

            // Unordered list (- or *) — captures leading indent so nested
            // bullets under a numbered item end up inside the parent <li>.
            const ulMatch = line.match(/^(\s*)[-*]\s+(.*)$/);
            if (ulMatch) {
                flushText();
                openListItem(ulMatch[1].length, 'ul', ulMatch[2]);
                i++;
                continue;
            }

            // Ordered list (1., 2., ...) — same indent capture as ul above.
            const olMatch = line.match(/^(\s*)\d+\.\s+(.*)$/);
            if (olMatch) {
                flushText();
                openListItem(olMatch[1].length, 'ol', olMatch[2]);
                i++;
                continue;
            }

            // Regular text — buffer until the next block element flushes it
            closeAllLists();
            textBuffer.push(line);
            i++;
        }

        flushText();
        closeAllLists();

        return out.join('');
    },

    _formatInline(text) {
        // Pull out inline code spans FIRST so later substitutions (math,
        // links, bold/italic) don't touch their contents. Code is meant
        // to render verbatim — `$\rightarrow$` inside code stays literal.
        const codeSpans = [];
        let out = text.replace(/`([^`]+)`/g, (_, body) => {
            const token = `\x00CODE${codeSpans.length}\x00`;
            codeSpans.push(`<code>${body}</code>`);
            return token;
        });

        // Replace markdown links with placeholders next so that bare-URL
        // autolinking (next step) doesn't re-wrap the URL inside an anchor
        // we just built. Only http(s) and mailto URLs are honored — anything
        // else (e.g. javascript:) is rendered as a plain # link to prevent
        // script-URL injection via model-emitted markdown.
        const linkPlaceholders = [];
        out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
            const safe = /^(https?:|mailto:)/i.test(url) ? url : '#';
            const html = `<a href="${safe}">${label}</a>`;
            const token = `\x00LINK${linkPlaceholders.length}\x00`;
            linkPlaceholders.push(html);
            return token;
        });

        // Autolink bare http(s) URLs. Trailing punctuation like . , ; ) is
        // commonly next-to-URL in prose; strip it back out of the matched URL
        // so it doesn't end up as a broken anchor.
        out = out.replace(/https?:\/\/[^\s<]+/g, (url) => {
            const m = url.match(/^(.*?)([.,;:!?)\]]*)$/);
            const clean = m[1];
            const trail = m[2];
            return `<a href="${clean}">${clean}</a>${trail}`;
        });

        // Render LaTeX-style math fragments to Unicode. Models often emit
        // things like "$\rightarrow$" or "$x^2$" in explanatory prose;
        // without this they leak through as raw "$\rightarrow$" text.
        // We deliberately don't pull in KaTeX/MathJax — a 300KB+ dep for
        // an occasional inline symbol isn't worth it. Substitution covers
        // arrows, Greek letters, common operators, and digit super/subs.
        out = this._renderMath(out);

        out = out
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>');

        // Restore code spans first (their contents are HTML-escaped already
        // by the caller's escape pass), then markdown links.
        out = out.replace(/\x00CODE(\d+)\x00/g, (_, idx) => codeSpans[+idx]);
        return out.replace(/\x00LINK(\d+)\x00/g, (_, idx) => linkPlaceholders[+idx]);
    },

    /**
     * Convert LaTeX-style math fragments to Unicode.
     *
     * Strategy:
     *  - Strip `$$...$$` (display) and `$...$` (inline) delimiters.
     *  - For inline `$...$`, only treat it as math if the contents look
     *    like LaTeX (has a backslash, brace, ^, _, or is a single bare
     *    word). This avoids munging prices like "$10.50".
     *  - Substitute common LaTeX commands (arrows, Greek, operators) for
     *    their Unicode equivalents. Outside of $...$ too — models
     *    sometimes write \rightarrow in plain prose.
     *  - Render simple super/subscripts (digits + a few common letters)
     *    to Unicode. Anything more complex stays as `^x` / `_x` text.
     *
     * Not a full math typesetter — for fractions, integrals with bounds,
     * matrices, etc. you would need KaTeX. The aim is "don't leak raw
     * LaTeX into the chat bubble" for the symbol-heavy prose models
     * routinely emit when explaining technical content.
     */
    _renderMath(text) {
        if (!text || (text.indexOf('$') === -1 && text.indexOf('\\') === -1)) {
            return text;
        }

        // Display math: $$...$$ — almost always real math, strip safely.
        let out = text.replace(/\$\$([^$]+)\$\$/g, (_, body) => this._latexToUnicode(body));

        // Inline math: $...$ — guarded against currency / dollar amounts.
        // Heuristic for "this is math": contains a backslash command,
        // a brace, ^, _, or is a single bare word/symbol.
        out = out.replace(/\$([^$\n]+?)\$/g, (full, body) => {
            const looksLikeMath =
                /\\/.test(body) ||
                /[_^{}]/.test(body) ||
                /^\s*[A-Za-z][A-Za-z0-9]?\s*$/.test(body);
            if (!looksLikeMath) return full;
            return this._latexToUnicode(body);
        });

        // Bare LaTeX commands outside $-delimiters (some models forget the $).
        out = this._latexToUnicode(out);

        return out;
    },

    _latexToUnicode(text) {
        let out = text;

        // \frac{a}{b} → (a)/(b). One level of nesting only.
        out = out.replace(/\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, '($1)/($2)');
        // \sqrt{x} → √(x); \sqrt x → √x
        out = out.replace(/\\sqrt\s*\{([^{}]+)\}/g, '√($1)');
        out = out.replace(/\\sqrt\s+(\w)/g, '√$1');
        // Accent commands — \hat{y} → ŷ, \bar{x} → x̄, \vec{v} → v⃗.
        // Combining marks attach to the preceding character. For multi-char
        // contents like \hat{xy} we apply the mark only to the first char
        // (x̂y); a real wide-hat would need a typesetter, this is the
        // best Unicode approximation. Single-char contents are by far the
        // common case (\hat{y}, \bar{x}, \dot{x}, etc).
        const accents = {
            '\\hat': '̂',        // ŷ
            '\\widehat': '̂',
            '\\bar': '̄',        // x̄
            '\\overline': '̅',   // overline
            '\\tilde': '̃',      // ỹ
            '\\widetilde': '̃',
            '\\vec': '⃗',        // v⃗
            '\\dot': '̇',        // ẏ
            '\\ddot': '̈',       // ÿ
            '\\check': '̌',      // y̌
            '\\acute': '́',      // ý
            '\\grave': '̀',      // ỳ
            '\\breve': '̆',      // y̆
            '\\ring': '̊',       // ẙ
        };
        for (const [cmd, mark] of Object.entries(accents)) {
            const pattern = new RegExp(cmd.replace(/\\/g, '\\\\') + '\\s*\\{([^{}]+)\\}', 'g');
            out = out.replace(pattern, (_, body) => body ? body[0] + mark + body.slice(1) : body);
        }
        // Style commands — \text{x}, \mathrm{x}, \mathbf{x}, etc — unwrap to plain.
        out = out.replace(/\\(?:text|mathrm|mathbf|mathit|mathsf|mathcal|mathbb|mathfrak|operatorname)\s*\{([^{}]+)\}/g, '$1');

        // Symbol commands (longest names first so \Rightarrow matches before \rightarrow's regex).
        // Word-boundary at the end so \alpha doesn't swallow \alphabet (no real LaTeX command but be safe).
        const symbols = {
            // Arrows
            '\\Leftrightarrow': '⇔', '\\leftrightarrow': '↔',
            '\\Rightarrow': '⇒', '\\rightarrow': '→', '\\to': '→', '\\mapsto': '↦',
            '\\Leftarrow': '⇐', '\\leftarrow': '←', '\\gets': '←',
            '\\uparrow': '↑', '\\downarrow': '↓', '\\Uparrow': '⇑', '\\Downarrow': '⇓',
            // Operators
            '\\times': '×', '\\div': '÷', '\\pm': '±', '\\mp': '∓',
            '\\cdot': '·', '\\cdots': '⋯', '\\ldots': '…', '\\dots': '…',
            '\\neq': '≠', '\\ne': '≠', '\\approx': '≈', '\\equiv': '≡', '\\sim': '∼', '\\cong': '≅',
            '\\leq': '≤', '\\le': '≤', '\\geq': '≥', '\\ge': '≥', '\\ll': '≪', '\\gg': '≫',
            '\\infty': '∞', '\\partial': '∂', '\\nabla': '∇',
            '\\sum': '∑', '\\prod': '∏', '\\int': '∫', '\\oint': '∮',
            // Sets / logic
            '\\in': '∈', '\\notin': '∉', '\\subset': '⊂', '\\subseteq': '⊆',
            '\\supset': '⊃', '\\supseteq': '⊇', '\\cup': '∪', '\\cap': '∩',
            '\\emptyset': '∅', '\\varnothing': '∅',
            '\\land': '∧', '\\wedge': '∧', '\\lor': '∨', '\\vee': '∨', '\\neg': '¬', '\\lnot': '¬',
            '\\forall': '∀', '\\exists': '∃', '\\nexists': '∄',
            // Greek lowercase
            '\\alpha': 'α', '\\beta': 'β', '\\gamma': 'γ', '\\delta': 'δ',
            '\\epsilon': 'ε', '\\varepsilon': 'ε', '\\zeta': 'ζ', '\\eta': 'η',
            '\\theta': 'θ', '\\vartheta': 'ϑ', '\\iota': 'ι', '\\kappa': 'κ',
            '\\lambda': 'λ', '\\mu': 'μ', '\\nu': 'ν', '\\xi': 'ξ',
            '\\pi': 'π', '\\varpi': 'ϖ', '\\rho': 'ρ', '\\varrho': 'ϱ',
            '\\sigma': 'σ', '\\varsigma': 'ς', '\\tau': 'τ',
            '\\upsilon': 'υ', '\\phi': 'φ', '\\varphi': 'ϕ',
            '\\chi': 'χ', '\\psi': 'ψ', '\\omega': 'ω',
            // Greek uppercase
            '\\Gamma': 'Γ', '\\Delta': 'Δ', '\\Theta': 'Θ', '\\Lambda': 'Λ',
            '\\Xi': 'Ξ', '\\Pi': 'Π', '\\Sigma': 'Σ', '\\Upsilon': 'Υ',
            '\\Phi': 'Φ', '\\Psi': 'Ψ', '\\Omega': 'Ω',
            // Misc
            '\\degree': '°', '\\circ': '∘', '\\bullet': '•', '\\star': '★', '\\ast': '∗',
            '\\prime': '′', '\\therefore': '∴', '\\because': '∵',
            '\\hbar': 'ℏ', '\\ell': 'ℓ', '\\Re': 'ℜ', '\\Im': 'ℑ',
        };
        // Sort by length descending so longer commands match before shorter prefixes.
        const ordered = Object.keys(symbols).sort((a, b) => b.length - a.length);
        for (const cmd of ordered) {
            // Word-boundary: command can't be followed by a letter (so \alpha
            // doesn't match inside an unrelated word). Backslash itself isn't
            // a word char, so \\alpha\\beta still matches both.
            const pattern = new RegExp(cmd.replace(/\\/g, '\\\\') + '(?![A-Za-z])', 'g');
            out = out.replace(pattern, symbols[cmd]);
        }

        // Spacing commands: \, \: \; → space; \! → nothing; \\ → line break (rendered as space).
        out = out.replace(/\\[,:;]/g, ' ').replace(/\\!/g, '').replace(/\\\\/g, ' ');

        // Subscripts / superscripts: digits + a few common signs render to Unicode.
        const supMap = { '0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','+':'⁺','-':'⁻','=':'⁼','(':'⁽',')':'⁾','n':'ⁿ','i':'ⁱ' };
        const subMap = { '0':'₀','1':'₁','2':'₂','3':'₃','4':'₄','5':'₅','6':'₆','7':'₇','8':'₈','9':'₉','+':'₊','-':'₋','=':'₌','(':'₍',')':'₎' };
        const toScript = (chars, map) => {
            let r = '';
            for (const c of chars) {
                if (!(c in map)) return null;
                r += map[c];
            }
            return r;
        };
        // ^{abc} or _{abc} — render if every char is in the map, else leave as ^abc / _abc.
        out = out.replace(/\^\{([^{}]+)\}/g, (_, g) => toScript(g, supMap) || '^' + g);
        out = out.replace(/_\{([^{}]+)\}/g, (_, g) => toScript(g, subMap) || '_' + g);
        // Single-char super/subscripts: x^2, H_2.
        out = out.replace(/\^([0-9+\-=()ni])/g, (_, c) => supMap[c] || ('^' + c));
        out = out.replace(/_([0-9+\-=()])/g, (_, c) => subMap[c] || ('_' + c));

        // Strip surviving `\` from any unmapped commands so the user sees
        // "rightarrowfoo" instead of "\rightarrowfoo" — better than leaking
        // raw backslashes into prose. Conservative: only strip when followed
        // by a word char (real LaTeX commands), not literal backslashes
        // that appear in code-style prose.
        // Actually leave these alone — false positives are worse than the
        // occasional unmapped command. The ones that really matter are the
        // 70+ symbols mapped above.

        return out;
    },

    /**
     * Streaming-safe formatter.
     *
     * Runs the full markdown parser on the ENTIRE buffer on every frame. This
     * means block-level elements (`# headers`, `- lists`, `1. ordered`, `|
     * tables`) render as soon as their line marker arrives, instead of showing
     * the raw `#`/`-`/`1.` characters and only converting once the line ends.
     *
     * Before parsing, we strip trailing UNCLOSED inline markers from the last
     * line so that partial `**bold`, `*italic`, or `` `code `` doesn't flash
     * the delimiter characters before the closing marker arrives. As soon as
     * the closing marker streams in, the text re-renders with the formatting.
     *
     * Performance note: the old split-at-last-newline approach was written for
     * perf, but `formatContent` is a cheap line-scanner, `_handleStreamChunk`
     * already debounces via `requestAnimationFrame`, and typical streaming
     * buffers are small (<few KB), so reparsing the whole thing every frame
     * costs essentially nothing and gives much smoother rendering.
     */
    _formatStreaming(text) {
        if (!text) return '';
        return this.formatContent(this._trimTrailingOpenMarkers(text));
    },

    /**
     * Strip unclosed inline markers at the very end of the streaming buffer so
     * partial inline formatting doesn't flicker. Only touches the last line —
     * earlier unclosed markers are rare and would need expensive balancing.
     *
     * Processed in order:
     *   1. `` ` `` (code) — odd count → drop the trailing unpaired one
     *   2. `**` (bold) — odd count → drop the trailing unpaired pair
     *   3. `*` (italic) — count SINGLE `*` (not adjacent to another `*`);
     *      odd count → drop the trailing unpaired one
     *
     * The content between the opener and end of buffer is preserved, just
     * rendered without the formatting until the closing marker arrives. That
     * gives a "plain text → bold" visual transition instead of "raw `**`
     * chars → bold", which is the smoother experience.
     */
    _trimTrailingOpenMarkers(text) {
        const lastNl = text.lastIndexOf('\n');
        const head = lastNl === -1 ? '' : text.slice(0, lastNl + 1);
        let tail = lastNl === -1 ? text : text.slice(lastNl + 1);

        // Inline code: `...`
        const codeCount = (tail.match(/`/g) || []).length;
        if (codeCount % 2 === 1) {
            const i = tail.lastIndexOf('`');
            tail = tail.slice(0, i) + tail.slice(i + 1);
        }

        // Bold: **...**
        const boldCount = (tail.match(/\*\*/g) || []).length;
        if (boldCount % 2 === 1) {
            const i = tail.lastIndexOf('**');
            tail = tail.slice(0, i) + tail.slice(i + 2);
        }

        // Italic: *...* — only count single-star asterisks (not part of **)
        const singles = [];
        for (let k = 0; k < tail.length; k++) {
            if (tail[k] === '*' && tail[k - 1] !== '*' && tail[k + 1] !== '*') {
                singles.push(k);
            }
        }
        if (singles.length % 2 === 1) {
            const i = singles[singles.length - 1];
            tail = tail.slice(0, i) + tail.slice(i + 1);
        }

        return head + tail;
    },

    _escapeHtml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    },

    // Human-readable, one-line description of a write action the agent
    // wants to take. Falls back to the raw tool name so a new sensitive
    // tool added to the gate without a phrasing here still gets a prompt.
    _describeToolAction(toolName, args) {
        args = args || {};
        const a = (v) => this.escapeHtml(String(v == null ? '' : v));
        switch (toolName) {
            case 'send_email':
                return `Send an email to <strong>${a(args.to || 'unknown recipient')}</strong>` +
                       (args.subject ? ` with subject “${a(args.subject)}”` : '') + '.';
            case 'trash_email':
                return `Move an email to Trash${args.subject ? ` (“${a(args.subject)}”)` : ''}.`;
            case 'modify_labels':
                return `Change labels on an email.`;
            case 'create_calendar_event':
                return `Create the calendar event “${a(args.title || args.summary || 'Untitled')}”` +
                       (args.attendees && args.attendees.length ? ` and invite ${a((Array.isArray(args.attendees) ? args.attendees : [args.attendees]).join(', '))}` : '') + '.';
            case 'update_calendar_event':
                return `Update the calendar event “${a(args.title || args.summary || '')}” (attendees may be re-notified).`;
            case 'add_transaction':
                return `Record a transaction${args.amount != null ? ` of ${a(args.amount)}` : ''}${args.description ? ` — ${a(args.description)}` : ''}.`;
            case 'update_cash':
                return `Change your recorded cash balance${args.amount != null ? ` to ${a(args.amount)}` : ''}.`;
            case 'fs_list':
                return `List the folder <strong>${a(args.path)}</strong>.`;
            case 'fs_read':
                return `Read the file <strong>${a(args.path)}</strong>.`;
            case 'fs_search':
                return `Search for files under <strong>${a(args.path)}</strong>.`;
            case 'fs_write':
                return `Write the file <strong>${a(args.path)}</strong>.`;
            case 'fs_mkdir':
                return `Create the folder <strong>${a(args.path)}</strong>.`;
            case 'fs_trash':
                return `Move <strong>${a(args.path)}</strong> to the Trash (recoverable).`;
            case 'fs_move':
                return `Move <strong>${a(args.from)}</strong> to <strong>${a(args.to)}</strong>.`;
            case 'run_command':
                return `Run this command: <code>${a(args.command)}</code>${args.cwd ? ` in ${a(args.cwd)}` : ''}`;
            case 'create_app':
            case 'edit_app':
            case 'create_artifact':
            case 'edit_artifact': {
                const target = toolName === 'edit_app' ? ` <strong>${a(args.appId || '')}</strong>`
                    : toolName === 'edit_artifact' ? ` <strong>${a(args.artifactId || '')}</strong>` : '';
                const verb = toolName.startsWith('create_') ? 'Build a new' : 'Change the';
                const what = toolName.endsWith('_app') ? 'app' : 'artifact';
                const brief = String(args.prompt || '');
                const briefShort = brief.length > 160 ? brief.slice(0, 157) + '…' : brief;
                return `${verb} ${what}${target}${briefShort ? `: “${a(briefShort)}”` : ''}<br>` +
                       `<span class="agent-confirm-note">This writes files and may take a few minutes.</span>`;
            }
            default:
                if (/^delete_/.test(toolName)) {
                    const what = args.title || args.name || args.search || args.id || 'an item';
                    return `Delete <strong>${a(what)}</strong>. This cannot be undone.`;
                }
                if (/^mcp_/.test(toolName)) {
                    const source = (typeof AgentTools !== 'undefined' && AgentTools._dynamicTools?.[toolName]?.source) || '';
                    const server = source.startsWith('mcp:') ? source.slice(4) : 'external';
                    const tool = toolName.replace(new RegExp(`^mcp_${server}_`), '').replace(/_/g, ' ');
                    let argsJson = '';
                    try { argsJson = JSON.stringify(args); } catch {}
                    if (argsJson.length > 220) argsJson = argsJson.slice(0, 217) + '…';
                    return `Use <strong>${a(tool)}</strong> from the external MCP server “${a(server)}” — it receives:<br><code>${a(argsJson)}</code>`;
                }
                return `Run <strong>${a(toolName)}</strong>.`;
        }
    },

    /**
     * Ask the user to approve a sensitive/irreversible tool call before the
     * agent executes it. Resolves { approved, scope } where scope is
     * 'once' | 'session' | 'always' (docs/COWORK_AGENT.md C1 — the grant is
     * recorded by PermissionManager, not here). Dismissing the dialog
     * (ESC / click-outside / X) counts as DENY — fail safe.
     */
    // Open permission dialogs, keyed by conversation, so Stop can dismiss
    // them: an abort mid-ask would otherwise leave the modal up and the turn
    // blocked on an answer to a question that no longer matters.
    _openToolConfirms: new Map(),

    dismissToolConfirms(convId) {
        const set = this._openToolConfirms.get(convId);
        if (!set) return;
        for (const dismiss of [...set]) dismiss();
        this._openToolConfirms.delete(convId);
    },

    confirmToolCall(toolName, args, summary, convId) {
        return new Promise((resolve) => {
            let settled = false;
            let instance = null;
            const finish = (approved, scope) => {
                if (settled) return;
                settled = true;
                if (convId) {
                    const set = this._openToolConfirms.get(convId);
                    if (set) {
                        set.delete(dismiss);
                        if (!set.size) this._openToolConfirms.delete(convId);
                    }
                }
                resolve({ approved: !!approved, scope: scope || 'once' });
            };
            // Deny-and-close, invoked by dismissToolConfirms on Stop.
            const dismiss = () => {
                finish(false);
                try { instance?.close(); } catch { /* already closed */ }
            };

            const wrap = document.createElement('div');
            wrap.className = 'agent-confirm';

            const desc = document.createElement('p');
            desc.className = 'agent-confirm-desc';
            desc.innerHTML = this._describeToolAction(toolName, args);
            wrap.appendChild(desc);

            if (summary && summary !== args?.summary) {
                const note = document.createElement('p');
                note.className = 'agent-confirm-note';
                note.textContent = summary;
                wrap.appendChild(note);
            }

            // Graduated consent: once (default) / this session / always.
            // "Always" persists on this Mac and is revocable in Settings →
            // AI → Assistant Permissions.
            const scopes = [
                { value: 'once', label: 'Just this once', checked: true },
                { value: 'session', label: 'Allow for the rest of this session' },
                { value: 'always', label: 'Always allow this action (saved on this Mac; revoke in Settings)' }
            ];
            const scopeWrap = document.createElement('div');
            scopeWrap.className = 'agent-confirm-scopes';
            for (const s of scopes) {
                const label = document.createElement('label');
                label.className = 'agent-confirm-scope';
                const radio = document.createElement('input');
                radio.type = 'radio';
                radio.name = 'agent-confirm-scope';
                radio.value = s.value;
                if (s.checked) radio.checked = true;
                label.appendChild(radio);
                label.appendChild(document.createTextNode(' ' + s.label));
                scopeWrap.appendChild(label);
            }
            wrap.appendChild(scopeWrap);
            const pickedScope = () =>
                scopeWrap.querySelector('input[name="agent-confirm-scope"]:checked')?.value || 'once';

            if (typeof Modal === 'undefined' || !Modal.create) {
                // No modal component available — fail safe by denying rather
                // than silently executing a destructive action.
                finish(false);
                return;
            }

            instance = Modal.create({
                title: 'Confirm action',
                className: 'confirm-dialog agent-confirm-dialog',
                content: wrap,
                onClose: () => finish(false),
                buttons: [
                    { text: 'Cancel', className: 'secondary-btn', onClick: () => { finish(false); instance.close(); } },
                    { text: 'Allow', className: 'primary-btn', onClick: () => { finish(true, pickedScope()); instance.close(); } }
                ]
            });
            if (convId) {
                const set = this._openToolConfirms.get(convId) || new Set();
                set.add(dismiss);
                this._openToolConfirms.set(convId, set);
            }
        });
    },

    // Escapes for both text and ATTRIBUTE contexts (quotes included) — callers
    // interpolate the result into title="…"/href="…" as well as text nodes.
    escapeHtml(text) {
        return String(text ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    formatTimeAgo(isoString) {
        const diff = Date.now() - new Date(isoString).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        if (days < 7) return `${days}d ago`;
        return new Date(isoString).toLocaleDateString();
    }
};
