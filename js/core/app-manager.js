/**
 * App Manager
 * Handles app registration, routing, and lifecycle
 */

const Breadcrumb = {
    /**
     * App display labels
     */
    appLabels: {
        actions: 'Actions',
        focus: 'Focus', goals: 'Goals', schedule: 'Tasks', notes: 'Notes',
        bookmarks: 'Bookmarks', journal: 'Journal', email: 'Email',
        calendar: 'Calendar', portfolio: 'Portfolio',
        pomodoro: 'Pomodoro', settings: 'Settings', agent: 'Assistant'
    },

    /**
     * Render breadcrumbs into a container element
     * @param {string} containerId - DOM element ID
     * @param {Array} crumbs - Array of {label, action} where action is a function or null (current)
     */
    render(containerId, crumbs) {
        const el = document.getElementById(containerId);
        if (!el) return;

        let html = '';
        crumbs.forEach((crumb, i) => {
            if (i > 0) html += '<span class="breadcrumb-separator">&#8250;</span>';
            // A crumb renders as a link whenever it has an action, even if
            // it's the last one — useful for detail views where the page
            // itself is implicitly "current" and the last named crumb (e.g.
            // "Email") should still link back to its list.
            if (crumb.action) {
                html += `<span class="breadcrumb-link" data-crumb-index="${i}">${AppManager.escapeHtml(crumb.label)}</span>`;
            } else {
                html += `<span class="breadcrumb-current">${AppManager.escapeHtml(crumb.label)}</span>`;
            }
        });

        el.innerHTML = html;

        el.querySelectorAll('.breadcrumb-link').forEach(link => {
            link.addEventListener('click', () => {
                const idx = parseInt(link.dataset.crumbIndex);
                const crumb = crumbs[idx];
                if (crumb && crumb.action) crumb.action();
            });
        });
    }
};

const AppManager = {
    currentApp: null,
    apps: {},
    isLocked: false,
    activityTimer: null,
    activityCheckInterval: null,
    lastActivityTime: Date.now(),
    authAvailable: false,
    authEnabled: false,
    autoLockTimeout: 5,

    // Per-app "Locked apps" feature (distinct from the whole-app Touch ID
    // lock above). A user-chosen set of sensitive apps require auth on entry.
    // Config lives in the synced `app-lock` StorageManager key; the unlocked
    // state is in-memory and re-locks after idle. See the App Lock section.
    sensitiveUnlocked: false,
    _pendingLocked: null,

    /**
     * Initialize the app manager
     */
    async init() {
        // Check for first-run setup
        if (window.electronStore.isFirstRun()) {
            this.showSetup();
            return;
        }

        // Hide any UI marked with data-feature="<key>" when its flag is off.
        // Must run before routing so gated apps aren't reachable via hash.
        if (typeof FEATURES !== 'undefined') {
            FEATURES.applyToDocument();
            // Phone<->Mac channel: main never connects to the relay on its
            // own — it waits for this call, which only happens with the
            // mobilesync flag on. A localStorage override + Cmd+R therefore
            // enables the whole feature without an app restart.
            if (FEATURES.isEnabled('mobilesync') && window.electronChannel?.ensure) {
                window.electronChannel.ensure();
            }
        }

        // User-built apps (docs/PLATFORM.md). Sync reconcile runs first so
        // apps merged from other Macs are on disk before mounting; loading
        // must run before setupNavigation so dashboard tiles pick up the
        // same click wiring as built-ins, and before handleRoute so a
        // #<user-app> hash survives a refresh.
        if (typeof UserAppsSync !== 'undefined') {
            UserAppsSync.init();
            try {
                await UserAppsSync.reconcile();
            } catch (e) {
                console.error('User app sync reconcile failed:', e);
            }
        }
        try {
            await this._loadUserApps();
        } catch (e) {
            console.error('User app loading failed:', e);
        }

        this.setupTheme();
        this.setupNavigation();
        this.setupMenuActions();
        this.setupRouting();
        this.setupSyncIndicator();
        ProfileManager.init();

        if (typeof MemoryManager !== 'undefined') MemoryManager.init();

        // Clean up stale cross-app links on startup
        LinkManager.cleanupStaleLinks();
        // Heal any task→focus links that drifted from their goal's focus
        // (e.g. because the goal was moved between focus areas before the
        // hierarchy-sync hook existed).
        LinkManager.repairFocusInheritance();

        // IMPORTANT: handleRoute MUST run before updateStats. The empty-state
        // redirect inside updateWelcome (called from updateStats) opens the
        // About app, which rewrites window.location.hash and clobbers the
        // hash we'd otherwise restore. Routing first sets currentApp to the
        // user's actual app, then the updateWelcome guard "currentApp !== null"
        // suppresses the redirect entirely. This cost users their app on every
        // page refresh until it was reordered.
        this.handleRoute();
        this.updateStats();
        this.applyHiddenApps();

        // Start schedule notifications (runs globally, not just when schedule app is open)
        this.setupScheduleNotifications();

        // Start the offline prompt scheduler (runs globally; catches up
        // missed runs once on launch, then polls). No-ops with no offline
        // prompts or no local model.
        if (typeof PromptFeed !== 'undefined') PromptFeed.init();

        // Restore a pomodoro that was running before a refresh/restart so
        // the session resumes (or completes retroactively) without the user
        // having to visit the Pomodoro view first.
        if (typeof PomodoroApp !== 'undefined') PomodoroApp.init();

        // Setup authentication
        await this.setupAuth();
        // Wire the per-app lock overlay (the locked-apps feature).
        this.setupAppLock();

        // Opt-in usage analytics: if the user has enabled it, schedule a
        // delayed upload of any pending events. Throttled to once per hour.
        if (typeof AnalyticsManager !== 'undefined') {
            AnalyticsManager.noteLaunch();
            AnalyticsManager.scheduleStartupUpload();
            if (AnalyticsManager.shouldNudgeOptIn()) {
                // Delay the ask so it doesn't land on top of any first-paint
                // work or a route-restored view the user is already reading.
                setTimeout(() => this._showAnalyticsOptInNudge(), 12000);
            }
        }

        // Resolve the local-model context window from the user's
        // setting (or auto-derive from RAM) up-front so prewarm and the
        // first sendMessage agree on num_ctx — otherwise Ollama loads
        // a second runner copy and we pay ~3-4s + ~5GB extra weight.
        if (typeof AgentService !== 'undefined' && typeof AgentService.initNumCtx === 'function') {
            AgentService.initNumCtx().catch(() => { /* falls back to default */ });
        }

        // Pre-warm the local model into resident memory so the user's first
        // message doesn't pay the cold-load cost. Deferred past first paint
        // and non-blocking — remote-only users and missing-Ollama setups no-op.
        if (typeof AgentService !== 'undefined' && typeof AgentService.prewarm === 'function') {
            setTimeout(() => { AgentService.prewarm(); }, 2500);
        }

        // Guard against losing a user-initiated memory rebuild to an accidental
        // Cmd+R / window close. Setting returnValue cancels the unload; the
        // main process (will-prevent-unload) then shows a "Leave anyway?"
        // confirm. Only blocks for FOREGROUND ops the user is actively waiting
        // on (the "Rebuild summary" / "Update now" buttons) — the silent daily
        // background pass is safe to interrupt (work is saved incrementally and
        // the remainder is picked up next launch), so it must never prompt on
        // refresh, which is the normal way to trigger sync.
        window.addEventListener('beforeunload', (e) => {
            if (typeof AgentService !== 'undefined' && AgentService._foregroundMemoryOp) {
                e.preventDefault();
                // Non-empty so Electron fires will-prevent-unload (where the
                // main process shows the actual confirm). The string itself is
                // not displayed.
                e.returnValue = 'cleanup-in-progress';
            }
        });

        // Daily memory consolidation: merge near-duplicate agent memories via
        // the local model so the store (and the briefing ranking it feeds)
        // stays tight, keeping the assistant's context small and responses
        // fast. Deferred well past prewarm so it never contends with launch or
        // the user's first message; self-throttles to once per 24h and no-ops
        // when a chat is mid-stream. (See AgentService.maybeConsolidateMemories.)
        if (typeof AgentService !== 'undefined' && typeof AgentService.maybeConsolidateMemories === 'function') {
            setTimeout(() => { AgentService.maybeConsolidateMemories(); }, 15000);
        }
    },

    _showAnalyticsOptInNudge() {
        if (typeof AnalyticsManager === 'undefined' || typeof Modal === 'undefined') return;
        if (!AnalyticsManager.shouldNudgeOptIn()) return;
        // Record "we asked" up front and durably — so the nudge never
        // reappears even if the modal is dismissed without a button
        // (overlay click, Escape) or a later state write races it.
        AnalyticsManager.markNudged();

        const content = document.createElement('div');
        content.innerHTML = `
            <p style="margin: 0 0 var(--space-md); line-height: 1.6;">
                Help us understand which features are useful without
                us seeing a single word of your content.
            </p>
            <p style="margin: 0 0 var(--space-md); font-size: var(--text-sm); color: var(--color-text-secondary); line-height: 1.6;">
                If you turn this on, Anjadhe will send anonymous event
                counts &mdash; things like &ldquo;email view opened&rdquo;
                &mdash; tagged with a random install ID. Your notes,
                journal, emails, and goals stay on this Mac. You can
                inspect exactly what would be sent, or change your mind,
                from Settings &rsaquo; Privacy at any time.
            </p>
        `;

        let decided = false;
        const markDecided = () => {
            if (decided) return;
            decided = true;
            AnalyticsManager.markNudged();
        };

        const modal = Modal.create({
            title: 'Help improve Anjadhe?',
            content,
            buttons: [
                {
                    text: 'No thanks',
                    className: 'secondary-btn',
                    onClick: () => {
                        markDecided();
                        modal.close();
                    },
                },
                {
                    text: 'Enable analytics',
                    className: 'primary-btn',
                    onClick: () => {
                        AnalyticsManager.setEnabled(true);
                        markDecided();
                        modal.close();
                        if (typeof UIUtils !== 'undefined' && UIUtils.showToast) {
                            UIUtils.showToast('Analytics enabled — thank you', 'success');
                        }
                    },
                },
            ],
            onClose: () => markDecided(),
        });
    },

    /**
     * Show first-run setup screen
     */
    showSetup() {
        this._clearInitialLoader();

        // The wizard owns the whole window — hide the global left nav
        // (finishSetup reloads, which clears this again).
        document.body.classList.add('in-setup');

        // Hide dashboard
        document.getElementById('dashboard-view').classList.remove('active');

        // Show setup view
        const setupView = document.getElementById('setup-view');
        setupView.style.display = 'flex';

        const pathDisplay = document.getElementById('setup-path-display');

        // ── Step 2 sub-phase helpers ─────────────────────────────────────
        // Step 2 has two phases: 2a (install Ollama runtime) and 2b (download
        // first model). We enter the wizard in the phase that matches current
        // state: users who already have Ollama installed skip straight to 2b.

        // Currently-selected model in the Step 2b list. Starts null and is
        // populated by populateModelList() once RemoteConfig delivers the
        // curated catalog; row-click handlers update it when the user picks
        // a different row. We deliberately do NOT seed this with a hardcoded
        // model name — the catalog in remote-config.json is the only source
        // of truth for model identifiers.
        let selectedModel = null;

        // Parse size strings like "5.5 GB" into a number (Infinity on parse
        // failure so unknown sizes sort to the bottom of any numeric sort).
        const parseModelSize = (s) => {
            const m = String(s || '').match(/([\d.]+)/);
            return m ? parseFloat(m[1]) : Infinity;
        };

        // Pick the best-fit model for first-run. Prefers the largest minRam
        // tier that fits the machine; within a tier a catalog entry flagged
        // "default": true wins (lets remote config steer the pick regardless
        // of download size), then ties break by larger size. The catalog is
        // currently just gemma4:12b (minRam 16), but the logic stays general
        // so remote config can reintroduce tiers without an app update. Caps
        // first-run downloads at 15 GB so a high-memory machine doesn't get
        // pushed toward a 40+ GB model during onboarding.
        const MAX_FIRST_RUN_SIZE_GB = 15;
        const pickDefaultModel = (totalMemGB, models) => {
            if (!totalMemGB || !Array.isArray(models) || models.length === 0) {
                return null;
            }
            const candidates = models.filter(m =>
                totalMemGB >= (m.minRam || 0) &&
                parseModelSize(m.size) <= MAX_FIRST_RUN_SIZE_GB
            );
            if (candidates.length === 0) return null;
            candidates.sort((a, b) =>
                (b.minRam || 0) - (a.minRam || 0) ||
                (b.default === true) - (a.default === true) ||
                parseModelSize(b.size) - parseModelSize(a.size)
            );
            return candidates[0];
        };

        // Render the Step 2b list: every model whose minRam fits the current
        // machine, sorted with the recommended pick pinned first followed by
        // the rest in minRam-desc then size-desc order. Each row is a
        // .settings-model-item (same styling as the model list in Settings)
        // and selection is tracked as an .active class + the selectedModel
        // closure variable that the download handler reads.
        const populateModelList = async () => {
            const listEl = document.getElementById('setup-model-list');
            const introEl = document.getElementById('setup-model-intro');
            const downloadBtn = document.getElementById('setup-download-model-btn');

            if (!listEl) return;
            listEl.innerHTML = '<div class="setup-progress-text">Detecting hardware...</div>';
            if (downloadBtn) downloadBtn.disabled = true;

            let totalMemGB = null;
            let allModels = [];

            try {
                const cfg = await window.electronConfig.get();
                totalMemGB = cfg && cfg.machine && cfg.machine.totalMemGB;
                allModels = (cfg && cfg.models) || [];
            } catch (e) {
                console.warn('[setup] Could not load remote config:', e);
            }

            // First-run downloads through the built-in llama.cpp engine, so
            // only catalog entries with a GGUF source are offerable here.
            allModels = allModels.filter(m => m.gguf);

            // Filter to models that fit the machine's RAM. No size cap here —
            // the user explicitly sees the tradeoff and can pick a big model
            // if they want. The size cap only influences which one is marked
            // "Recommended".
            let viable = allModels.filter(m => totalMemGB && totalMemGB >= (m.minRam || 0));

            // Three distinct no-model cases, each with a different fix.
            // Disambiguate by looking at whether the catalog itself loaded
            // and whether we detected hardware:
            //
            //   (a) hardware detection failed          → retry network
            //   (b) catalog didn't load               → retry network
            //   (c) catalog loaded, but this Mac is   → point at running the
            //       under the floor for every entry     model on the user's own server
            if (viable.length === 0) {
                if (!totalMemGB) {
                    listEl.innerHTML = '<div class="setup-progress-text">Could not detect hardware. Check your connection and reopen this step.</div>';
                    if (downloadBtn) downloadBtn.disabled = true;
                    return;
                }
                if (allModels.length === 0) {
                    listEl.innerHTML = '<div class="setup-progress-text">Could not load the model catalog. Check your connection and reopen this step.</div>';
                    if (downloadBtn) downloadBtn.disabled = true;
                    return;
                }
                // Case (c): RAM-below-floor. Switch to the own-server panel.
                showStep2c(totalMemGB);
                return;
            }

            const recommended = pickDefaultModel(totalMemGB, allModels);
            const recommendedName = recommended && recommended.name;

            // Sort: recommended first, then by minRam desc, size desc.
            viable.sort((a, b) => {
                if (a.name === recommendedName) return -1;
                if (b.name === recommendedName) return 1;
                return (b.minRam || 0) - (a.minRam || 0) ||
                       parseModelSize(b.size) - parseModelSize(a.size);
            });

            // Pre-select the first row after sorting (which is the recommended
            // pick, or the largest-fits-your-RAM fallback if there was no
            // explicit recommendation).
            selectedModel = viable[0];

            const selWrap  = document.getElementById('setup-selected-model');
            const listWrap = document.getElementById('setup-model-list-wrap');
            const selName  = document.getElementById('setup-selected-name');
            const selDesc  = document.getElementById('setup-selected-desc');
            const selSize  = document.getElementById('setup-selected-size');

            // Show the chosen model as a compact summary; the full list
            // stays hidden behind the "Change" link until the user wants it.
            const renderSelected = () => {
                if (selName) selName.textContent = selectedModel.name;
                if (selDesc) selDesc.textContent = selectedModel.desc || '';
                if (selSize) selSize.textContent = selectedModel.size || '';
                if (selWrap) selWrap.style.display = '';
                if (listWrap) listWrap.style.display = 'none';
            };

            // Render the rows. Uses the same class structure as
            // settings-app.js _renderOllamaModels() so the CSS already fits.
            listEl.innerHTML = viable.map(m => {
                const isActive = m.name === selectedModel.name;
                const isRec = m.name === recommendedName;
                const badge = isRec
                    ? '<span class="settings-model-default-tag">Recommended</span>'
                    : '';
                return `<div class="settings-model-item ${isActive ? 'active' : ''}"
                    data-model="${UIUtils.escapeHtml(m.name)}"
                    data-size="${UIUtils.escapeHtml(m.size || '')}"
                    data-desc="${UIUtils.escapeHtml(m.desc || '')}">
                    <span class="settings-model-radio"></span>
                    <div class="settings-model-info">
                        <span class="settings-model-name">${UIUtils.escapeHtml(m.name)}${badge}</span>
                        <span class="settings-model-desc">${UIUtils.escapeHtml(m.desc || '')}</span>
                    </div>
                    <span class="settings-model-status">${UIUtils.escapeHtml(m.size || '')}</span>
                </div>`;
            }).join('');

            // Wire up selection. Clicking a row deselects all others and
            // updates the closure-scoped selectedModel that the download
            // button will read.
            listEl.querySelectorAll('.settings-model-item').forEach(item => {
                item.addEventListener('click', () => {
                    listEl.querySelectorAll('.settings-model-item').forEach(el =>
                        el.classList.remove('active'));
                    item.classList.add('active');
                    const name = item.dataset.model;
                    selectedModel = viable.find(m => m.name === name) || selectedModel;
                    renderSelected();
                });
            });

            // "Change" reveals the full list; picking a row collapses it
            // back to the summary. Guard against double-wiring since
            // populateModelList() can run again if the user revisits 2b.
            const changeLink = document.getElementById('setup-change-model-link');
            if (changeLink && !changeLink._wired) {
                changeLink._wired = true;
                changeLink.addEventListener('click', (e) => {
                    e.preventDefault();
                    if (selWrap) selWrap.style.display = 'none';
                    if (listWrap) listWrap.style.display = '';
                });
            }

            renderSelected();

            // Update the intro line with detected specs.
            if (totalMemGB) {
                introEl.textContent = `We checked your Mac (${totalMemGB} GB memory) and picked the AI that runs best on it:`;
            } else {
                introEl.textContent = 'We could not check your Mac automatically. Pick an option below; you can change it later in Settings.';
            }

            if (downloadBtn) downloadBtn.disabled = false;
        };

        const showStep2c = (totalMemGB) => {
            document.getElementById('setup-step-2b').style.display = 'none';
            const stepC = document.getElementById('setup-step-2c');
            if (stepC) stepC.style.display = '';
            const intro = document.getElementById('setup-lowram-intro');
            if (intro && totalMemGB) {
                // \u00A0 keeps the "Settings > AI Assistant" breadcrumb on one line
                intro.textContent = `This Mac has ${totalMemGB} GB of memory, which is too little to run the AI on its own. If another computer you own can — a desktop or a home server — run the model there and connect it later in Settings\u00A0›\u00A0AI\u00A0Assistant. Anjadhe sends your data only where you point it. Or continue without AI — everything else works.`;
            }
        };
        const showStep2b = () => {
            document.getElementById('setup-step-2b').style.display = '';
            const stepC = document.getElementById('setup-step-2c');
            if (stepC) stepC.style.display = 'none';
            // Render the list based on machine specs. Fire-and-forget —
            // the button is disabled until it resolves so there's no race.
            populateModelList();
        };

        // Welcome → Private AI (step "1. Private AI"). Reveal the step
        // indicator here — it's hidden on the story screen so the first
        // impression is the pitch, not a wizard chrome.
        const goToStep2 = async () => {
            document.getElementById('setup-step-1').style.display = 'none';
            document.getElementById('setup-step-2').style.display = '';
            document.getElementById('setup-step-3').style.display = 'none';
            const steps = document.getElementById('setup-steps');
            if (steps) steps.style.visibility = 'visible';
            document.getElementById('setup-step-ind-1').classList.add('active');
            document.getElementById('setup-step-ind-2').classList.remove('active');

            // Straight to the model choice — the built-in llama.cpp engine
            // installs inline (~11 MB) when the download starts, so there is
            // no separate engine phase. populateModelList() diverts to the
            // low-RAM panel (2c) when nothing in the catalog fits.
            showStep2b();
        };

        // Private AI → Storage (step "2. Storage"). Storage is the last,
        // optional step now — demoted below the AI hero per positioning.
        const goToStep3 = () => {
            document.getElementById('setup-step-1').style.display = 'none';
            document.getElementById('setup-step-2').style.display = 'none';
            document.getElementById('setup-step-3').style.display = '';
            const steps = document.getElementById('setup-steps');
            if (steps) steps.style.visibility = 'visible';
            document.getElementById('setup-step-ind-1').classList.remove('active');
            document.getElementById('setup-step-ind-2').classList.add('active');
        };

        const finishSetup = () => {
            window.electronStore.markSetupComplete();
            // Land in the Assistant, not the 12-app grid (positioning:
            // never open with the suite). Read + cleared on next boot.
            try { localStorage.setItem('anjadhe_land_assistant', '1'); } catch {}
            window.location.reload();
        };

        // ── Step 1: Welcome / story ──────────────────────────────────────
        document.getElementById('setup-welcome-continue-btn').addEventListener('click', () => {
            goToStep2();
        });

        const whatLeavesLink = document.getElementById('setup-what-leaves-link');
        if (whatLeavesLink) {
            whatLeavesLink.addEventListener('click', (e) => {
                e.preventDefault();
                // The "what leaves your machine" page is a marketing/trust
                // surface for the skeptical beachhead — open the canonical
                // public version (in-app routing isn't up during setup).
                window.electronAuth?.openExternal?.('https://anjadhe.com/privacy');
            });
        }

        // ── Step 3: Storage location (last, optional) ────────────────────
        document.getElementById('setup-choose-folder-btn').addEventListener('click', async () => {
            const folderPath = await window.electronDialog.selectFolder();
            if (!folderPath) return;

            const pathCheck = await window.electronDialog.checkPath(folderPath);
            if (!pathCheck.writable) {
                UIUtils.showToast('Selected folder is not writable', 'error');
                return;
            }

            const existingData = await window.electronStore.checkDataAtPath(folderPath);
            if (existingData.exists && existingData.hasData) {
                await window.electronStore.setCustomStoragePath(folderPath, false);
            } else {
                await window.electronStore.setCustomStoragePath(folderPath, true);
            }

            finishSetup();
        });

        document.getElementById('setup-use-default-btn').addEventListener('click', () => {
            finishSetup();
        });

        // Show default path for context
        const defaultPath = window.electronStore.getDefaultPath();
        if (pathDisplay && defaultPath) {
            pathDisplay.textContent = `Default location: ${defaultPath}`;
        }

        // ── Step 2b: Download first model ────────────────────────────────
        // The local engine for first-run is llama.cpp: the ~11 MB llama-server
        // build installs inline right here (no separate wizard phase, no
        // Ollama.app in /Applications), then the model's GGUF downloads.
        // Ollama stays available as an engine in Settings › AI Assistant.

        // The model download is the longest the user ever waits in setup
        // (minutes to tens of minutes, entirely network-bound), so the
        // progress area works to stay worth looking at: a live stats line
        // (downloaded / total / speed / time left) proves movement, and a
        // slowly rotating card explains what's actually landing on the Mac.
        const DOWNLOAD_TIPS = [
            { label: "What's downloading", text: 'The entire AI — 12 billion parameters in a single file. Once it lands, it answers from this Mac even with Wi‑Fi off.' },
            { label: 'Private by default', text: 'This model answers from this Mac — your chats, email, and notes are processed locally, not in an AI company’s cloud.' },
            { label: 'One brain', text: 'This one model powers everything: the assistant, email insights, action filing, and building your own mini‑apps.' },
            { label: 'Open weights', text: 'Gemma 4 is an open‑weight model from Google, and it runs on llama.cpp — free, open‑source software anyone can inspect.' },
            { label: 'Long memory', text: 'It has a 256K‑token context window — long documents and months of notes can fit into a single conversation.' },
            { label: 'While you wait', text: 'Feel free to make a coffee. If your connection hiccups, the download resumes right where it left off.' },
            { label: 'Change your mind later', text: 'You can switch models — or run one on another computer you own — any time in Settings › AI Assistant.' }
        ];

        let tipTimer = null;
        const startDownloadTips = () => {
            const el = document.getElementById('setup-download-tip');
            if (!el) return;
            let i = 0;
            const show = () => {
                const tip = DOWNLOAD_TIPS[i % DOWNLOAD_TIPS.length];
                el.innerHTML = `<span class="setup-tip-label">${tip.label}</span>${tip.text}`;
                el.classList.remove('fading');
                i++;
            };
            show();
            tipTimer = setInterval(() => {
                el.classList.add('fading');
                setTimeout(show, 400); // matches the CSS opacity transition
            }, 8000);
        };
        const stopDownloadTips = () => {
            if (tipTimer) { clearInterval(tipTimer); tipTimer = null; }
            // Clear the card so a failure message (or the finished state)
            // isn't competing with a leftover tip.
            const el = document.getElementById('setup-download-tip');
            if (el) { el.innerHTML = ''; el.classList.remove('fading'); }
        };

        // Rolling download-speed estimate from progress events. Exponentially
        // smoothed so the MB/s and time-left readings don't flicker with every
        // network burst; the ETA is deliberately coarse ("about 6 min") —
        // false precision on a fluctuating connection reads as wrong.
        const makeSpeedometer = () => {
            let lastBytes = null, lastTime = 0, ema = 0;
            // Decimal GB, matching how the catalog (and every download site)
            // states model sizes — mixing in GiB here reads as a shrinking bug.
            const fmtGB = (b) => (b / 1e9).toFixed(1) + ' GB';
            const fmtEta = (sec) => {
                if (!Number.isFinite(sec) || sec <= 0) return '';
                if (sec < 60) return 'less than a minute left';
                if (sec < 120) return 'about a minute left';
                return `about ${Math.round(sec / 60)} min left`;
            };
            return (completed, total) => {
                if (!completed || !total) return '';
                const now = Date.now();
                if (lastBytes !== null && now > lastTime) {
                    const inst = (completed - lastBytes) / ((now - lastTime) / 1000);
                    if (inst >= 0) ema = ema ? ema * 0.7 + inst * 0.3 : inst;
                }
                lastBytes = completed; lastTime = now;
                const parts = [`${fmtGB(completed)} of ${fmtGB(total)}`];
                if (ema > 0) {
                    const mbs = ema / 1024 / 1024;
                    parts.push(`${mbs >= 10 ? Math.round(mbs) : mbs.toFixed(1)} MB/s`);
                    const eta = fmtEta((total - completed) / ema);
                    if (eta) parts.push(eta);
                }
                return parts.join(' · ');
            };
        };
        document.getElementById('setup-download-model-btn').addEventListener('click', async () => {
            // Read whichever row is currently selected in the list —
            // populateModelList() initializes this to the recommended pick
            // and row-click handlers update it when the user overrides. If
            // the catalog failed to load, populateModelList disables the
            // button, but guard here too in case of races.
            if (!selectedModel) return;
            const modelName = selectedModel.name;
            const progressContainer = document.getElementById('setup-model-progress');
            const progressFill = document.getElementById('setup-progress-fill');
            const progressText = document.getElementById('setup-progress-text');
            const progressStats = document.getElementById('setup-progress-stats');
            const actionsEl = document.getElementById('setup-model-actions');

            actionsEl.style.display = 'none';
            progressContainer.style.display = '';
            // The own-server alternative hint is moot once the user commits
            // to downloading, and its privacy line duplicates the tip cards.
            const noteHint = document.querySelector('#setup-step-2b .setup-note-hint');
            if (noteHint) noteHint.style.display = 'none';
            startDownloadTips();
            const speedometer = makeSpeedometer();

            try {
                // First-run runs on the built-in llama.cpp engine.
                await window.electronLLM?.setLocalBackend?.('llamacpp');

                // Engine not on disk yet? Install it inline — ~11 MB, a few
                // seconds; the model download below is the real wait.
                let engineStatus = null;
                try { engineStatus = await window.electronLlamaCpp.status(); } catch {}
                if (!engineStatus || !engineStatus.isInstalled) {
                    progressText.textContent = 'Setting up the AI engine…';
                    const installed = await window.electronLlamaCpp.install((p) => {
                        if (p.phase === 'download' && p.percent !== null && p.percent !== undefined) {
                            progressText.textContent = `Setting up the AI engine… (${p.percent}%)`;
                        }
                    });
                    if (installed && installed.error) {
                        stopDownloadTips();
                        progressText.textContent = 'Engine setup failed: ' + installed.error;
                        actionsEl.style.display = '';
                        return;
                    }
                }

                let shownPct = 0;
                const result = await window.electronLlamaCpp.pullModel(modelName, (progress) => {
                    if (progress.percent !== null && progress.percent !== undefined) {
                        // Never let the bar move backwards (defensive — the
                        // manager already clamps, but resume emits can race).
                        shownPct = Math.max(shownPct, progress.percent);
                        progressFill.style.width = shownPct + '%';
                        progressText.textContent = `${progress.status} (${shownPct}%)`;
                    } else {
                        progressText.textContent = progress.status;
                    }
                    if (progressStats) progressStats.textContent = speedometer(progress.completed, progress.total);
                });

                if (result.error) {
                    stopDownloadTips();
                    progressText.textContent = 'Download failed: ' + result.error;
                    actionsEl.style.display = '';
                    return;
                }

                stopDownloadTips();
                if (progressStats) progressStats.textContent = '';
                progressFill.style.width = '100%';
                progressText.textContent = 'Download complete!';

                // Save as selected model
                const agentSettings = StorageManager.get('agent-settings') || {};
                agentSettings.selectedModel = modelName;
                agentSettings.models = agentSettings.models || [];
                if (!agentSettings.models.includes(modelName)) {
                    agentSettings.models.push(modelName);
                }
                StorageManager.set('agent-settings', agentSettings);

                // Register a model ENTRY too — the composer model dropdown
                // and the Settings model library render entries, and the
                // one-time entry migration (ensureModelList) may already
                // have run on this boot, before any model existed. The
                // first entry becomes the default brain (selectedModel,
                // provider=local, localBackend=llamacpp follow via
                // saveModelList's write-through).
                try {
                    if (typeof AgentService !== 'undefined') {
                        AgentService.addEntry({ engine: 'llamacpp', model: modelName });
                    }
                } catch (err) {
                    console.warn('[setup] model entry registration failed:', err);
                }

                setTimeout(goToStep3, 1000);
            } catch (e) {
                stopDownloadTips();
                progressText.textContent = 'Download failed: ' + (e.message || 'Unknown error');
                actionsEl.style.display = '';
            }
        });

        document.getElementById('setup-skip-model-btn').addEventListener('click', goToStep3);

        // ── Step 2c: low-RAM Macs ─────────────────────────────────────────
        // Shown when populateModelList() detects the machine is below the
        // practical floor for every model in the catalog. The panel points
        // at running the model on another computer the user owns; the only
        // action is Continue (skip AI for now).
        const setupSkipAiBtn = document.getElementById('setup-skip-ai-btn');
        if (setupSkipAiBtn) {
            setupSkipAiBtn.addEventListener('click', goToStep3);
        }
    },

    /**
     * Setup hash-based routing
     */
    setupRouting() {
        // Handle browser back/forward buttons
        window.addEventListener('hashchange', () => {
            this.handleRoute();
        });
    },

    /**
     * Handle the current route based on URL hash
     * Supports: #app, #app/view/id, #app/edit/id
     */
    handleRoute() {
        const hash = window.location.hash.slice(1); // Remove the #

        // First boot after onboarding: land in the Assistant (the one
        // blade), never the 12-app grid. One-shot — cleared immediately so
        // later navigation behaves normally. We deliberately do NOT seed a
        // prompt: on a fresh install there are no tasks and no connected
        // inbox, so a data-dependent prompt would visibly no-op. Just open
        // the assistant and focus the empty input so the user can start.
        try {
            if (localStorage.getItem('anjadhe_land_assistant') === '1') {
                localStorage.removeItem('anjadhe_land_assistant');
                if (this.apps['agent']) {
                    this.openApp('agent', false);
                    this._clearInitialLoader();
                    setTimeout(() => {
                        try {
                            const input = (typeof AgentUI !== 'undefined' && AgentUI.getInput)
                                ? AgentUI.getInput()
                                : document.getElementById('dash-agent-input');
                            if (input) input.focus();
                        } catch {}
                    }, 150);
                    return;
                }
            }
        } catch {}

        if (hash === '' || hash === 'home') {
            this.showDashboard(false);
            this._clearInitialLoader();
            return;
        }

        const parts = hash.split('/');
        const appName = parts[0];
        const action = parts[1]; // 'view', 'edit', or undefined
        const id = parts.slice(2).join('/'); // ID (may contain /)

        if (!this.apps[appName]) {
            this.showDashboard(false);
            this._clearInitialLoader();
            return;
        }

        this.openApp(appName, false);

        // Route to detail page if action + id present. Done synchronously so
        // the list view never paints before the detail view on refresh.
        if (action && id) {
            const app = this.apps[appName];
            if (action === 'edit' && app.openEditor) {
                app.openEditor(id);
            } else if (action === 'view' && app.openViewer) {
                app.openViewer(id);
            } else if (action === 'focus' && app.navigateTo) {
                app.navigateTo(id);
            }
        }

        this._clearInitialLoader();
    },

    _clearInitialLoader() {
        document.body.classList.remove('app-loading');
    },

    /**
     * Update the URL hash for detail page routing (does not trigger hashchange navigation)
     */
    setDetailHash(appName, action, id) {
        const newHash = id ? `${appName}/${action}/${id}` : appName;
        if (window.location.hash.slice(1) !== newHash) {
            history.replaceState(null, '', '#' + newHash);
        }
    },

    /**
     * Register an app
     * @param {string} name - App name
     * @param {Object} app - App instance
     */
    register(name, app) {
        this.apps[name] = app;
    },

    /* ----------------------------------------------------------------
     * User-built apps (docs/PLATFORM.md). Each folder under
     * ~/Anjadhe/apps/<id>/ with a manifest.json is loaded at startup:
     * stylesheet injected, a view container created, app.js evaluated
     * (it must call Anjadhe.registerApp), then a dashboard tile added.
     * Built-in apps keep their hardcoded views in index.html — this is
     * a parallel path, not a rewrite.
     * ---------------------------------------------------------------- */

    _userAppsByDir: {},

    async _loadUserApps() {
        if (!window.electronApps?.list) return;
        this._wireUserAppsRow();
        // Subscribe to hot reload even with zero apps installed — the first
        // app a coding agent writes should appear without a restart.
        if (!this._userAppsWatching && window.electronApps.onChanged) {
            this._userAppsWatching = true;
            window.electronApps.onChanged((dirs) => {
                this._reloadUserApps(dirs).catch(e => console.error('User app reload failed:', e));
            });
        }
        // Preload the Spec engine source for the sandbox (so Anjadhe.Spec works
        // inside the isolated frame) before mounting any app. No-op when the
        // flag is off.
        if (typeof FEATURES !== 'undefined' && FEATURES.isEnabled('sandboxUserApps')
            && typeof UserAppSandbox !== 'undefined') {
            await UserAppSandbox.preload();
        }
        const entries = await window.electronApps.list();
        if (!Array.isArray(entries)) return;
        for (const entry of entries) {
            // One broken app must not take down startup or its siblings.
            try {
                this._mountUserApp(entry);
            } catch (e) {
                console.error(`User app "${entry?.dir || '?'}" failed to mount:`, e);
                if (entry?.dir) window.electronApps.logError?.(entry.dir, `mount: ${e.message}`);
            }
        }
    },

    /**
     * Hot reload: the main process watched ~/Anjadhe/apps and reported
     * changed app folders. Tear each one down completely (tools, style,
     * view, tile, registry) and mount the fresh files. If the user was
     * looking at the app, re-open it so the new code renders immediately.
     */
    async _reloadUserApps(dirs) {
        if (!Array.isArray(dirs) || !dirs.length) return;
        const activeApp = this.currentApp;
        const entries = await window.electronApps.list();
        const byDir = {};
        for (const e of entries) byDir[e.dir] = e;
        for (const dirName of dirs) {
            const removedId = this._unmountUserApp(dirName);
            const entry = byDir[dirName];
            if (entry) {
                // Fresh log per remount: the file means "errors from the
                // code on disk right now". Coding-agent CLIs write files
                // directly, so write-time clearing can't be relied on —
                // a transient mid-creation error would stick forever.
                await window.electronApps.clearErrors?.(dirName);
                try {
                    this._mountUserApp(entry);
                } catch (e) {
                    console.error(`User app "${dirName}" failed to remount:`, e);
                    window.electronApps.logError?.(dirName, `mount: ${e.message}`);
                }
            }
            if (removedId && activeApp === removedId) {
                const newId = this._userAppsByDir[dirName];
                if (newId) this.openApp(newId, false);
                else this.showDashboard();
            }
        }
        // Publish the change to other Macs (no-op when the change itself
        // came from sync — export compares content first).
        if (typeof UserAppsSync !== 'undefined') {
            UserAppsSync.exportDirs(dirs).catch(e => console.error('User app sync export failed:', e));
        }
    },

    _unmountUserApp(dirName) {
        const id = this._userAppsByDir[dirName];
        if (!id) return null;
        AgentTools.unregisterBySource(id);
        // Tear down any sandbox bookkeeping (pending tool calls, records); the
        // iframe element itself is removed with #<id>-view just below.
        if (typeof UserAppSandbox !== 'undefined') UserAppSandbox.unmount(id);
        document.querySelector(`style[data-user-app="${CSS.escape(id)}"]`)?.remove();
        document.getElementById(`${id}-view`)?.remove();
        const row = document.getElementById('dash-user-apps-row');
        row?.querySelector(`.dash-app-tile[data-app="${CSS.escape(id)}"]`)?.remove();
        const group = document.getElementById('dash-user-apps-group');
        if (group && row && !row.children.length) group.style.display = 'none';
        delete this.apps[id];
        delete this._userAppsByDir[dirName];
        return id;
    },

    // ---- App Studio preview: parent an app's #<id>-view into a custom
    // container instead of #app-views, so the user can chat with the
    // builder on one side and watch the live app on the other. The view
    // element keeps its id (apps look themselves up by id), and on hot
    // reload the new view is parented to the preview container directly.
    _previewContainers: {},

    previewIn(appId, container) {
        if (!appId || !container) return false;
        this._previewContainers[appId] = container;
        const view = document.getElementById(`${appId}-view`);
        if (view && view.parentNode !== container) container.appendChild(view);
        // Trigger render so the moved view shows current content immediately.
        try { this.apps[appId]?.render?.(); } catch (e) { console.error(e); }
        return true;
    },

    clearPreviewFor(appId) {
        const container = this._previewContainers[appId];
        if (!container) return;
        delete this._previewContainers[appId];
        const view = document.getElementById(`${appId}-view`);
        const home = document.getElementById('app-views');
        if (view && home && view.parentNode !== home) home.appendChild(view);
    },

    clearAllPreviews() {
        for (const id of Object.keys(this._previewContainers)) {
            this.clearPreviewFor(id);
        }
    },

    /**
     * Delegated click handling for the "Your Apps" row. Tiles come and go
     * with hot reload, so per-tile listeners (the setupNavigation pattern)
     * would be lost on remount — setupNavigation skips this row.
     */
    _wireUserAppsRow() {
        const row = document.getElementById('dash-user-apps-row');
        if (!row || row.dataset.wired) return;
        row.dataset.wired = '1';
        row.addEventListener('click', (e) => {
            const tile = e.target.closest('.dash-app-tile[data-app]');
            if (!tile) return;
            e.stopPropagation();
            if ((e.metaKey || e.ctrlKey) && window.electronWindow?.openNew) {
                window.electronWindow.openNew(tile.dataset.app);
            } else {
                this.openApp(tile.dataset.app);
            }
        });
    },

    _mountUserApp(entry) {
        const logError = (msg) => {
            console.error(`User app "${entry.dir}": ${msg}`);
            window.electronApps?.logError?.(entry.dir, msg);
        };
        if (entry.error) {
            logError(`could not be read: ${entry.error}`);
            return;
        }
        const check = AppManifest.validate(entry.manifest);
        if (!check.ok) {
            logError(`invalid manifest: ${check.errors.join('; ')}`);
            return;
        }
        const manifest = check.manifest;
        if (this.apps[manifest.id] || document.getElementById(`${manifest.id}-view`)) {
            logError(`id "${manifest.id}" collides with an existing app`);
            return;
        }

        // Compute tool keywords up front — both the sandbox and legacy paths
        // scope this app's assistant tools to messages that mention it.
        const toolKeywords = [manifest.name, manifest.id.replace(/-/g, ' '), ...manifest.keywords];

        // SECURITY (H3): sandboxed execution for CODE apps when the flag is on.
        // Spec apps (entry.spec != null) are pure data rendered by the trusted
        // engine and never need isolation. The sandbox path runs app.js in an
        // opaque-origin iframe with no bridges, so the css/view/surface/
        // new-Function machinery below is skipped entirely.
        const sandboxed = entry.spec == null
            && typeof FEATURES !== 'undefined' && FEATURES.isEnabled('sandboxUserApps')
            && typeof UserAppSandbox !== 'undefined';
        if (sandboxed) {
            const app = UserAppSandbox.mountCodeApp(manifest, entry, {
                previewParent: this._previewContainers?.[manifest.id],
                keywords: toolKeywords
            });
            app.anjadhe = { id: manifest.id, manifest };  // compat shim
            this.register(manifest.id, app);
            this._userAppsByDir[entry.dir] = manifest.id;
            this._addUserAppTile(manifest);
            return;  // the guest self-inits and registers its tools on load
        }

        // Stylesheet before the view so first open doesn't flash unstyled.
        if (entry.css) {
            const style = document.createElement('style');
            style.dataset.userApp = manifest.id;
            style.textContent = entry.css;
            document.head.appendChild(style);
        }

        // View container — same shape as the hardcoded built-in views.
        // App Studio's split-view preview parents the view inside its own
        // right pane instead of #app-views (see previewIn() below); on hot
        // reload the new view goes straight to the preview pane so the
        // model can iterate while watching the app live.
        const view = document.createElement('div');
        view.id = `${manifest.id}-view`;
        view.className = 'view app-view';
        const previewParent = this._previewContainers?.[manifest.id];
        (previewParent || document.getElementById('app-views')).appendChild(view);

        // The per-app platform surface. Built BEFORE the script runs and
        // passed in as a scoped `anjadhe` binding, so app code can use
        // `anjadhe.storage` etc. anywhere — including arrow functions,
        // where `this.anjadhe` would be undefined (a bug class generated
        // models fall into constantly). Tools registered here are scoped
        // into the assistant prompt only when the message mentions the app
        // (name/id/keywords), keeping local-model prompts small.
        const surface = {
            id: manifest.id,
            manifest,
            storage: Anjadhe.storageFor(manifest.id),
            navigate: (name) => this.openApp(name),
            registerTool: (definition, handler) =>
                AgentTools.register(definition, handler, { source: manifest.id, keywords: toolKeywords }),
            // Read-only access to built-in app data, gated on the manifest's
            // declared reads — the permission is visible in the manifest, and
            // the data comes back as a deep copy so apps can't mutate the
            // source blob in place.
            readData: (name) => {
                if (!manifest.reads.includes(name)) {
                    throw new Error(`Declare reads:["${name}"] in manifest.json to read that app's data`);
                }
                const data = StorageManager.get(name);
                return data == null ? null : JSON.parse(JSON.stringify(data));
            }
        };

        let app;
        if (entry.spec != null) {
            // Spec app (docs/PLATFORM.md Phase 3): pure data rendered by
            // the fixed engine — no app code runs at all. This is the
            // format that travels to devices where shipping generated JS
            // isn't possible (iOS).
            let parsedSpec;
            try {
                parsedSpec = JSON.parse(entry.spec);
            } catch (e) {
                logError(`app.spec.json is not valid JSON: ${e.message}`);
                view.remove();
                return;
            }
            const specCheck = AppSpec.validate(parsedSpec);
            if (!specCheck.ok) {
                logError(`invalid app.spec.json: ${specCheck.errors.join('; ')}`);
                view.remove();
                return;
            }
            app = {
                _spec: parsedSpec,
                render() {
                    const container = document.getElementById(`${manifest.id}-view`);
                    if (!container) return;
                    SpecRenderer.render(this._spec, container, {
                        storage: surface.storage,
                        rerender: () => this.render()
                    });
                }
            };
        } else {
            // Code app: evaluate app.js. It must call Anjadhe.registerApp(app)
            // at the top level; _pending carries the manifest context across
            // the call.
            Anjadhe._pending = { manifest, registered: false, app: null };
            let ctx;
            try {
                new Function('anjadhe', entry.js).call(window, surface);
            } finally {
                ctx = Anjadhe._pending;
                Anjadhe._pending = null;
            }
            if (!ctx.registered || !ctx.app) {
                view.remove();
                throw new Error('app.js did not call Anjadhe.registerApp()');
            }
            app = ctx.app;
        }
        // Kept for compatibility with method-style code (`this.anjadhe`).
        app.anjadhe = surface;

        // Route lifecycle throws into .errors.log — the builder docs tell
        // coding agents to check that file after every change, which is
        // what makes the edit→reload→fix loop self-correcting. Also keeps
        // a throwing render() from bubbling out of openApp. A failed
        // render shows an error card instead of a blank view, so the user
        // knows the app is broken rather than empty.
        for (const method of ['init', 'render']) {
            const orig = app[method];
            if (typeof orig !== 'function') continue;
            app[method] = function (...args) {
                try {
                    return orig.apply(this, args);
                } catch (e) {
                    logError(`${method}(): ${e.message}`);
                    if (method === 'render') {
                        const v = document.getElementById(`${manifest.id}-view`);
                        if (v) {
                            v.innerHTML = `<div class="user-app-error">
                                <p><strong>${UIUtils.escapeHtml(manifest.name)}</strong> hit an error while loading.</p>
                                <p class="user-app-error-detail">${UIUtils.escapeHtml(e.message)}</p>
                                <p>Ask your coding agent to check <code>.errors.log</code> in the app folder, or rebuild it in App Studio.</p>
                            </div>`;
                        }
                    }
                }
            };
        }

        this.register(manifest.id, app);
        this._userAppsByDir[entry.dir] = manifest.id;
        this._addUserAppTile(manifest);

        // Eager init so assistant tools register at startup rather than on
        // first open — otherwise the assistant can't see an app's data until
        // the user has visited it this session. openApp calls init() again;
        // apps guard with their own _initialized flag (see
        // examples/user-apps/plant-tracker).
        if (typeof app.init === 'function') app.init();
    },

    _addUserAppTile(manifest) {
        const group = document.getElementById('dash-user-apps-group');
        const row = document.getElementById('dash-user-apps-row');
        if (!group || !row) return;
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'dash-app-tile';
        tile.dataset.app = manifest.id;
        const icon = document.createElement('span');
        icon.className = 'dash-app-tile-icon';
        icon.innerHTML = manifest.icon;
        const label = document.createElement('span');
        label.className = 'dash-app-tile-label';
        label.textContent = manifest.name;
        tile.append(icon, label);
        row.appendChild(tile);
        group.style.display = '';
    },

    /**
     * Navigate to an app
     * @param {string} appName - Name of app to open
     * @param {boolean} updateHash - Whether to update the URL hash (default: true)
     */
    openApp(appName, updateHash = true) {
        // Prompts were folded into Notes as a template. The old "Prompts"
        // entry points (dashboard tile, Browse "Manage", any #prompts hash)
        // redirect into Notes pre-filtered to prompt-template notes.
        if (appName === 'prompts') {
            // Filter to prompts when any exist; otherwise show all notes so a
            // user with no prompts yet doesn't land on an empty list.
            const hasPrompts = typeof NotePrompts !== 'undefined' && NotePrompts.list().length > 0;
            if (typeof NotesApp !== 'undefined') NotesApp.currentFilter = hasPrompts ? 'prompt' : 'all';
            return this.openApp('notes', updateHash);
        }

        // Reading a feed post? Navigating away closes it — the overlay only
        // covers home's content area, so it would otherwise linger over the
        // incoming app.
        if (typeof PromptFeed !== 'undefined' && PromptFeed.closePost) PromptFeed.closePost();

        const app = this.apps[appName];
        if (!app) {
            console.error(`App ${appName} not found`);
            return;
        }

        // The docked AI panel is anchored to the page it was opened over, so
        // dismiss it whenever the user navigates elsewhere. (Expand-to-full-view
        // already closes the panel itself before calling openApp('agent'), so
        // this is a no-op there.)
        if (typeof AgentUI !== 'undefined' && AgentUI.isOpen) AgentUI.close();

        // The Setup Assistant popover belongs to the AI Assistant view; drop it
        // when navigating anywhere else so it doesn't float over other apps.
        // (Re-mounted by AgentUI.renderMessages when the Assistant view opens.)
        if (appName !== 'agent' && typeof SetupAssistant !== 'undefined') {
            SetupAssistant.removePopover();
        }

        // Leaving App Studio? Restore any previewed user-app views to
        // #app-views so they mount normally for the next navigation.
        if (appName !== 'appstudio' && this.currentApp === 'appstudio') {
            this.clearAllPreviews();
        }

        // Refuse to open gated apps whose feature flag is off — stops a
        // stale URL hash from landing the user on a view that isn't ready to
        // ship.
        if (typeof FEATURES !== 'undefined' && FEATURES.isGated(appName) && !FEATURES.isEnabled(appName)) {
            this.showDashboard();
            return;
        }

        // Locked apps: if this app is in the user's sensitive set and the
        // group isn't currently unlocked, show the unlock overlay instead of
        // the app. On success we re-enter openApp for the pending app. The
        // current view stays put behind the overlay; Cancel returns home.
        if (this.isAppLocked(appName) && !this.sensitiveUnlocked) {
            this._pendingLocked = { appName, updateHash };
            this.showAppLockOverlay(appName);
            return;
        }

        // Hide all views
        document.querySelectorAll('.view').forEach(view => {
            view.classList.remove('active');
        });
        // The first-run setup wizard reveals #setup-view with an inline
        // display style, which bypasses the .active class — the loop above
        // can't hide it. Clear it so it can't bleed through behind an app
        // the user navigated to before finishing setup.
        const setupView = document.getElementById('setup-view');
        if (setupView) setupView.style.display = 'none';

        // Show app view
        const appView = document.getElementById(`${appName}-view`);
        if (appView) {
            appView.classList.add('active');
            // Track where we came from. `null` means the dashboard (home),
            // which apps can use to decide entry behavior (e.g. the AI
            // Assistant starts a fresh chat when opened from home).
            this.previousApp = this.currentApp;
            this.currentApp = appName;
            this.updateAppPicker(appName);
            this.updateSidebarActive(appName);
            // "We're in a sub-app" CSS hook.
            document.body.classList.add('in-sub-app');

            // Opening the assistant full view? Re-warm the local model now so
            // it's resident by the time the user types — startup prewarm may
            // have expired during a long session. No-ops when already loaded.
            if (appName === 'agent' && typeof AgentService !== 'undefined'
                && typeof AgentService.warmOnIntent === 'function') {
                AgentService.warmOnIntent();
                if (typeof AgentUI !== 'undefined' && AgentUI.startReadinessWatch) {
                    AgentUI.startReadinessWatch();
                }
            }

            // Scroll to top when opening an app
            window.scrollTo(0, 0);

            // Update URL hash
            if (updateHash) {
                window.location.hash = appName;
            }

            // Initialize app if it has an init method
            if (app.init && typeof app.init === 'function') {
                app.init();
            }

            // Render app
            if (app.render && typeof app.render === 'function') {
                app.render();
            }

            if (typeof AnalyticsManager !== 'undefined') {
                AnalyticsManager.record('app.opened', { app: appName });
            }
        }
    },

    /* ----------------------------------------------------------------
     * Favourite apps. User-curated shortcuts pinned to the top of the
     * home page. Stored via StorageManager (so the picks follow the
     * user across Macs — this is a deliberate choice, unlike old
     * usage-derived "recents"). Order is the order they were added.
     * ---------------------------------------------------------------- */
    _FAVORITES_KEY: 'favorite-apps',

    getFavoriteApps() {
        const d = StorageManager.get(this._FAVORITES_KEY);
        return Array.isArray(d?.apps) ? d.apps.slice() : [];
    },

    setFavoriteApps(arr) {
        StorageManager.set(this._FAVORITES_KEY, { apps: Array.from(arr) });
    },

    isFavoriteApp(app) {
        return this.getFavoriteApps().includes(app);
    },

    toggleFavoriteApp(app) {
        const list = this.getFavoriteApps();
        const i = list.indexOf(app);
        if (i === -1) list.push(app);
        else list.splice(i, 1);
        this.setFavoriteApps(list);
    },

    renderFavoriteApps() {
        const section = document.getElementById('dash-favorite-apps-group');
        const row = document.getElementById('dash-favorite-apps-row');
        if (!section || !row) return;

        const favorites = this.getFavoriteApps();
        const hiddenApps = this.getHiddenApps();
        // Map to existing tile DOM so icons/labels/badges stay in sync with
        // the canonical grid below. Skip apps whose tile doesn't exist
        // (removed or gated-off), gated apps whose flag is currently off,
        // and apps the user has hidden from their home page.
        const tiles = [];
        for (const appName of favorites) {
            if (!appName) continue;
            if (typeof FEATURES !== 'undefined' && FEATURES.isGated(appName) && !FEATURES.isEnabled(appName)) continue;
            if (hiddenApps.has(appName)) continue;
            // Find the canonical tile elsewhere in the apps section to copy.
            const canonical = document.querySelector(
                `.dash-apps-section .dash-app-tile[data-app="${appName}"]:not(#dash-favorite-apps-row .dash-app-tile)`
            );
            if (!canonical) continue;
            tiles.push(canonical);
        }

        if (tiles.length === 0) {
            section.style.display = 'none';
            row.innerHTML = '';
            return;
        }

        // Rebuild row. Clone the canonical tile so badges/feature flags
        // come along; strip the id on the clone to avoid duplicates.
        row.innerHTML = '';
        for (const tile of tiles) {
            const clone = tile.cloneNode(true);
            clone.removeAttribute('id');
            // Re-id any descendant with an id to prevent duplicate ids
            // (e.g., #dash-email-badge). Drop the id; badge text gets
            // re-synced by updateStats() on dashboard show.
            clone.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
            row.appendChild(clone);
        }

        // Re-bind clicks — the generic delegation in setupAppTileNavigation
        // runs once at startup, so clones added later need their own handler.
        row.querySelectorAll('.dash-app-tile[data-app]').forEach(el => {
            el.addEventListener('click', () => {
                const appName = el.getAttribute('data-app');
                if (appName) this.openApp(appName);
            });
        });

        section.style.display = '';
    },

    /* ----------------------------------------------------------------
     * Customize home apps. We ship many apps; this lets a user hide the
     * ones they don't use. Stored via StorageManager (so the curated set
     * follows them across Macs — unlike Recents, which is usage-pattern
     * data and stays machine-local). Every home surface that lists apps
     * (the static grid groups and the Recents row) respects this set.
     * ---------------------------------------------------------------- */
    _HIDDEN_APPS_KEY: 'hidden-apps',

    getHiddenApps() {
        const d = StorageManager.get(this._HIDDEN_APPS_KEY);
        return new Set(Array.isArray(d?.apps) ? d.apps : []);
    },

    setHiddenApps(set) {
        StorageManager.set(this._HIDDEN_APPS_KEY, { apps: Array.from(set) });
    },

    applyHiddenApps() {
        const hidden = this.getHiddenApps();

        // Static grid tiles only — never the Favourites row clones, which
        // are rebuilt from these and filtered separately in renderFavoriteApps.
        document.querySelectorAll('.dash-apps-section .dash-app-tile[data-app]').forEach(tile => {
            if (tile.closest('#dash-favorite-apps-row')) return;
            if (tile.closest('#dash-locked-apps-row')) return;
            const app = tile.getAttribute('data-app');
            // Don't fight feature gating: a flag-off tile is already hidden
            // by FEATURES.applyToDocument and must stay that way.
            const gatedOff = typeof FEATURES !== 'undefined'
                && FEATURES.isGated(app) && !FEATURES.isEnabled(app);
            if (gatedOff) return;
            tile.style.display = hidden.has(app) ? 'none' : '';
        });

        // Collapse a group whose every tile is now hidden so we don't
        // leave an orphan section header (e.g. "Money") with nothing under it.
        document.querySelectorAll('.dash-apps-section .dash-apps-group').forEach(group => {
            if (group.id === 'dash-favorite-apps-group') return;
            if (group.id === 'dash-locked-apps-group') return;
            const tiles = Array.from(group.querySelectorAll('.dash-app-tile[data-app]'));
            const anyVisible = tiles.some(t =>
                t.style.display !== 'none' && t.getAttribute('aria-hidden') !== 'true');
            group.style.display = anyVisible ? '' : 'none';
        });
    },

    // Shared by the dashboard "Customize" button and the Settings row.
    // origin controls where the breadcrumb "back" returns to.
    openAppVisibilityModal(origin = 'dashboard') {
        const view = document.getElementById('home-apps-view');
        const list = document.getElementById('home-apps-list');
        if (!view || !list) return;

        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        view.classList.add('active');
        window.scrollTo(0, 0);

        const backToDashboard = () => this.showDashboard();
        const backToSettings = () => {
            view.classList.remove('active');
            document.getElementById('settings-view').classList.add('active');
            if (typeof SettingsApp !== 'undefined' && SettingsApp.render) SettingsApp.render();
        };
        const crumbs = origin === 'settings'
            ? [{ label: 'Settings', action: backToSettings }, { label: 'Home apps' }]
            : [{ label: 'Home', action: backToDashboard }, { label: 'Customize apps' }];
        Breadcrumb.render('home-apps-breadcrumb', crumbs);

        const hidden = this.getHiddenApps();
        const esc = (s) => (typeof UIUtils !== 'undefined' ? UIUtils.escapeHtml(s) : String(s));

        list.innerHTML = '';
        document.querySelectorAll('.dash-apps-section .dash-apps-group').forEach(group => {
            if (group.id === 'dash-favorite-apps-group') return;
            const tiles = Array.from(group.querySelectorAll('.dash-app-tile[data-app]'))
                .filter(t => {
                    const app = t.getAttribute('data-app');
                    return !(typeof FEATURES !== 'undefined'
                        && FEATURES.isGated(app) && !FEATURES.isEnabled(app));
                });
            if (tiles.length === 0) return;

            const section = document.createElement('div');
            section.className = 'app-visibility-group';
            const labelEl = group.querySelector('.dash-apps-group-label');
            if (labelEl) {
                const h = document.createElement('h4');
                h.className = 'app-visibility-group-label';
                h.textContent = labelEl.textContent;
                section.appendChild(h);
            }
            tiles.forEach(t => {
                const app = t.getAttribute('data-app');
                // innerHTML, not textContent — tile icons are inline SVGs
                // (user-app tiles may still be emoji; both are our own
                // markup already living in the grid, so re-injecting is safe).
                const icon = t.querySelector('.dash-app-tile-icon')?.innerHTML || '';
                const label = t.querySelector('.dash-app-tile-label')?.textContent || app;
                const fav = this.isFavoriteApp(app);
                const row = document.createElement('div');
                row.className = 'app-visibility-row';
                row.innerHTML =
                    `<label class="app-visibility-main">` +
                    `<span class="app-visibility-row-icon">${icon}</span>` +
                    `<span class="app-visibility-row-label">${esc(label)}</span>` +
                    `</label>` +
                    `<button type="button" class="app-visibility-fav${fav ? ' is-fav' : ''}" ` +
                    `data-app="${esc(app)}" aria-pressed="${fav}" ` +
                    `title="Mark as favourite" aria-label="Toggle favourite">` +
                    `${fav ? '&#9733;' : '&#9734;'}</button>` +
                    `<input type="checkbox" class="app-visibility-row-check" ` +
                    `data-app="${esc(app)}" ${hidden.has(app) ? '' : 'checked'}` +
                    ` aria-label="Show on home page">`;
                section.appendChild(row);
            });
            list.appendChild(section);
        });

        // Save on every toggle — no Save button. Assigned as a property
        // (not addEventListener) so re-opening the page doesn't stack
        // duplicate handlers; change events bubble to the list container.
        list.onchange = (e) => {
            if (!e.target.classList.contains('app-visibility-row-check')) return;
            const next = new Set();
            list.querySelectorAll('.app-visibility-row-check').forEach(cb => {
                if (!cb.checked) next.add(cb.getAttribute('data-app'));
            });
            this.setHiddenApps(next);
            this.applyHiddenApps();
            this.renderFavoriteApps();
        };

        // Favourite star — toggles independently of show/hide. Lives
        // outside the .app-visibility-main label so a click doesn't also
        // flip visibility. Property assignment keeps it idempotent.
        list.onclick = (e) => {
            const favBtn = e.target.closest('.app-visibility-fav');
            if (!favBtn || !list.contains(favBtn)) return;
            const app = favBtn.getAttribute('data-app');
            this.toggleFavoriteApp(app);
            const nowFav = this.isFavoriteApp(app);
            favBtn.classList.toggle('is-fav', nowFav);
            favBtn.setAttribute('aria-pressed', String(nowFav));
            favBtn.innerHTML = nowFav ? '&#9733;' : '&#9734;';
            this.renderFavoriteApps();
        };
    },

    /**
     * Show dashboard
     * @param {boolean} updateHash - Whether to update the URL hash (default: true)
     */
    showDashboard(updateHash = true) {
        // Dismiss the docked AI panel — it's anchored to the page it was
        // opened over and shouldn't linger over the dashboard.
        if (typeof AgentUI !== 'undefined' && AgentUI.isOpen) AgentUI.close();
        // Drop the Assistant-view setup popover when returning home.
        if (typeof SetupAssistant !== 'undefined') SetupAssistant.removePopover();
        // Leaving App Studio? Restore any previewed user-app views.
        if (this.currentApp === 'appstudio') this.clearAllPreviews();
        // Hide all views
        document.querySelectorAll('.view').forEach(view => {
            view.classList.remove('active');
        });
        // #setup-view is shown via an inline display style (bypassing the
        // .active class), so clear it here too — otherwise the first-run
        // wizard bleeds through behind the dashboard.
        const setupView = document.getElementById('setup-view');
        if (setupView) setupView.style.display = 'none';

        // Show dashboard
        const dashboard = document.getElementById('dashboard-view');
        if (dashboard) {
            dashboard.classList.add('active');
            this.currentApp = null;
            this.updateAppPicker(null);
            this.updateSidebarActive('home');
            document.body.classList.remove('in-sub-app');

            window.scrollTo(0, 0);
            document.querySelector('#dashboard-view .dash-main')?.scrollTo(0, 0);
            this.renderDashHeader();
            // Feed is the home stage — refresh it on every return so new
            // scheduled-run posts and profile changes show without Cmd+R.
            if (typeof PromptFeed !== 'undefined') PromptFeed.render();
            this.updateStats();
            this.applyHiddenApps();
            this.renderFavoriteApps();
            this.renderLockedApps();

            // Paint the assistant readiness dot in the home chat box (and keep
            // it live while the model is loading). Read-only — no warm here; the
            // warm fires when the user actually focuses the chat box.
            if (typeof AgentUI !== 'undefined' && AgentUI.startReadinessWatch) {
                AgentUI.startReadinessWatch();
            }
            // The home chip tracks the blank a home send would reuse — that
            // blank may have been consumed or toggled since the last visit,
            // so repaint on every return home.
            if (typeof AgentUI !== 'undefined' && AgentUI.updateChatbotChip) {
                AgentUI.updateChatbotChip();
            }

            if (updateHash) {
                window.location.hash = '';
            }
        }
    },

    /**
     * Setup navigation
     */
    setupNavigation() {
        // Cmd/Ctrl-click opens the target app in a new window instead of
        // switching the current window's view. Falls through to same-window
        // navigation if the multi-window IPC is unavailable (older preload).
        const openOrNewWindow = (appName, e) => {
            const newWindow = e && (e.metaKey || e.ctrlKey);
            if (newWindow && window.electronWindow?.openNew) {
                window.electronWindow.openNew(appName);
                return;
            }
            this.openApp(appName);
        };

        // Launcher tiles on the dashboard — replaces the old global
        // sidebar. Each tile has data-app pointing at the target view.
        // User-app tiles are excluded: they're recreated on hot reload, so
        // their row uses delegated wiring instead (_wireUserAppsRow).
        document.querySelectorAll('.dash-app-tile[data-app]').forEach(el => {
            if (el.closest('#dash-user-apps-row')) return;
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const appName = el.dataset.app;
                if (appName) openOrNewWindow(appName, e);
            });
        });

        // (Titlebar Home button retired — the global nav's Feed item is
        // the way home.)

        // Per-app settings gears (.app-settings-btn in app headers): open
        // Settings on the category that configures that app, or the root
        // for apps without a dedicated category. One delegated listener —
        // the buttons are static header markup across many views.
        document.addEventListener('click', (e) => {
            const btn = e.target.closest('.app-settings-btn');
            if (!btn) return;
            this.openAppSettings(btn.dataset.settingsFor);
        });

        // Dashboard "Ask Anjadhe" input — route to Agent with a new conversation.
        // Always start fresh so a dashboard question doesn't hijack an ongoing
        // thread the user had open in the Agent view. Reuses the Agent's own
        // sendMessage path (streaming, tool calls, persistence) rather than
        // trying to duplicate it here.
        const dashAgentInput = document.getElementById('dash-agent-input');
        const dashAgentSend = document.getElementById('dash-agent-send-btn');
        const submitDashAgent = () => {
            const text = dashAgentInput?.value?.trim() || '';
            // Attachment-only sends are fine — same rule as the chat composer.
            const hasAttachments = typeof AgentUI !== 'undefined' && AgentUI.pendingAttachments?.length > 0;
            if (!text && !hasAttachments) return;
            dashAgentInput.value = '';
            if (typeof AgentUI !== 'undefined') AgentUI._autoGrowComposer?.(dashAgentInput);
            if (typeof AgentService !== 'undefined') AgentService.openFreshConversation();
            this.openApp('agent');
            // Defer until Agent view has rendered its input. AppManager.openApp
            // calls render() synchronously, but some fields (e.g. the textarea
            // autosize) wire up on next tick — requestAnimationFrame is the
            // least surprising moment to populate + fire.
            requestAnimationFrame(() => {
                // Use AgentUI.getInput() — the full-app view uses
                // #agent-app-input, the floating panel uses #agent-input, and
                // getInput() picks the right one based on AgentUI.mode (which
                // renderAppView sets to 'app' moments before this fires).
                const agentInput = (typeof AgentUI !== 'undefined') ? AgentUI.getInput() : null;
                if (agentInput && typeof AgentUI !== 'undefined') {
                    agentInput.value = text;
                    AgentUI.sendMessage();
                }
            });
        };
        dashAgentSend?.addEventListener('click', submitDashAgent);
        dashAgentInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submitDashAgent();
            }
        });
        // Focusing the home chat box is intent to chat — warm the model so it's
        // resident by the time the user sends, and reflect its state in the dot.
        dashAgentInput?.addEventListener('focus', () => {
            if (typeof AgentService !== 'undefined') AgentService.warmOnIntent?.();
            if (typeof AgentUI !== 'undefined') AgentUI.startReadinessWatch?.();
        });

        // Customize home apps — dashboard entry point. The Settings row
        // is wired in SettingsApp; both open the same sub-view.
        const customizeBtn = document.getElementById('dash-customize-apps-btn');
        if (customizeBtn) {
            customizeBtn.addEventListener('click', () => this.openAppVisibilityModal('dashboard'));
        }

        // Theme toggle in titlebar
        const themeBtn = document.getElementById('theme-toggle-btn');
        if (themeBtn) {
            themeBtn.addEventListener('click', () => this.toggleTheme());
        }

        // Quick-create actions in titlebar — capture a note or task in place
        // via a small modal, without navigating away from the current view.
        const newNoteBtn = document.getElementById('quick-new-note-btn');
        if (newNoteBtn) {
            newNoteBtn.addEventListener('click', () => this.quickCreateNote());
        }
        const newTaskBtn = document.getElementById('quick-new-task-btn');
        if (newTaskBtn) {
            newTaskBtn.addEventListener('click', () => this.quickCreateTask());
        }

        this.setupDashboardTabs();

        // Lock screen unlock button
        const unlockBtn = document.getElementById('lock-screen-unlock-btn');
        if (unlockBtn) {
            unlockBtn.addEventListener('click', () => this.promptUnlock());
        }

        // App picker
        this.setupAppPicker();

    },

    /**
     * Titlebar quick-capture: jot a note from anywhere via a small modal.
     * Creates the note directly (no navigation) and offers to open it.
     */
    quickCreateNote() {
        if (typeof NotesApp === 'undefined' || typeof Modal === 'undefined') return;

        const form = document.createElement('div');
        form.className = 'quick-capture';
        form.innerHTML = `
            <input type="text" class="quick-capture-title" placeholder="Title" autocomplete="off" />
            <textarea class="quick-capture-body" rows="5" placeholder="Write a note…"></textarea>
            <div class="quick-capture-hint">${/Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl'}+Enter to save</div>
        `;
        const titleEl = form.querySelector('.quick-capture-title');
        const bodyEl = form.querySelector('.quick-capture-body');

        const modal = Modal.create({
            title: 'New note',
            className: 'quick-capture-modal',
            content: form,
            buttons: [
                { text: 'Cancel', className: 'secondary-btn', onClick: () => modal.close() },
                { text: 'Save note', className: 'primary-btn', onClick: () => save() }
            ]
        });

        const save = () => {
            const id = NotesApp.createNote(titleEl.value, bodyEl.value);
            modal.close();
            if (id) UIUtils.showToast('Note saved', 'success');
        };
        // Expand: hand off whatever's typed to the full note editor.
        const expand = () => {
            const title = titleEl.value;
            const content = NotesApp.plainTextToHtml(bodyEl.value);
            modal.close();
            // updateHash:false — a hash write fires an async hashchange that
            // re-runs handleRoute() and repaints the list over the editor.
            this.openApp('notes', false);
            NotesApp.openEditor(null, { template: 'blank', title: title.trim(), content });
        };
        this._addModalExpand(modal, expand);
        bodyEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
        });
        requestAnimationFrame(() => titleEl.focus());
    },

    /**
     * Inject an "expand" icon into a Modal's header, left of the close button.
     * Clicking it runs `onExpand` (which should close the modal and open the
     * corresponding full-page editor).
     */
    _addModalExpand(modal, onExpand) {
        const header = modal.element.querySelector('.modal-header');
        if (!header) return;
        const closeBtn = header.querySelector('.modal-close');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'modal-expand';
        btn.title = 'Open full editor';
        btn.setAttribute('aria-label', 'Open full editor');
        btn.innerHTML = '&#10138;'; // ➚ expand to full view
        btn.onclick = onExpand;
        if (closeBtn) header.insertBefore(btn, closeBtn);
        else header.appendChild(btn);
    },

    /**
     * Where should a globally captured action link? Only when the user is
     * LOOKING at a goal/area right now — and even then it's surfaced as a
     * visible, dismissible chip in the modal, never linked invisibly.
     */
    _captureContext() {
        try {
            if (this.currentApp === 'focus' && FocusApp.selected) {
                const sel = FocusApp.selected;
                if (sel.type === 'goal') {
                    const meta = LinkManager.getItemMeta('goals', sel.id);
                    if (meta) return { app: 'goals', itemId: sel.id, label: meta.title };
                } else if (sel.type === 'area') {
                    const meta = LinkManager.getItemMeta('focus', sel.id);
                    if (meta) return { app: 'focus', itemId: sel.id, label: meta.title };
                }
            }
            if (this.currentApp === 'goals' && GoalsApp.currentGoalId) {
                const meta = LinkManager.getItemMeta('goals', GoalsApp.currentGoalId);
                if (meta) return { app: 'goals', itemId: GoalsApp.currentGoalId, label: meta.title };
            }
        } catch { /* context is a nicety — capture must never fail over it */ }
        return null;
    },

    /**
     * Global quick capture: add an action from anywhere (titlebar button,
     * File → New Action, Cmd+Shift+N). Full natural-language parse with live
     * chips ("call dentist tomorrow 3pm"), an explicit context chip when a
     * goal/area is on screen, and a View toast that jumps to Actions.
     */
    quickCreateTask() {
        if (typeof ScheduleApp === 'undefined' || typeof Modal === 'undefined') return;

        let ctx = this._captureContext();

        const form = document.createElement('div');
        form.className = 'quick-capture';
        form.innerHTML = `
            <input type="text" class="quick-capture-title" placeholder="What needs doing? e.g., Call dentist tomorrow 3pm" autocomplete="off" />
            <div class="quick-capture-preview schedule-quick-add-preview" hidden></div>
            ${ctx ? `<div class="quick-capture-context">&#8594; <span class="quick-capture-context-label"></span><button type="button" class="quick-capture-context-remove" title="Don't link" aria-label="Don't link">&times;</button></div>` : ''}
            <div class="quick-capture-hint">Lands in Today unless you say when · Enter to save · &#8984;&#8679;N</div>
        `;
        const titleEl = form.querySelector('.quick-capture-title');
        const previewEl = form.querySelector('.quick-capture-preview');
        if (ctx) {
            // textContent (not innerHTML) — goal titles are user data.
            form.querySelector('.quick-capture-context-label').textContent = ctx.label;
            form.querySelector('.quick-capture-context-remove').onclick = (e) => {
                ctx = null;
                e.target.closest('.quick-capture-context').remove();
            };
        }

        const modal = Modal.create({
            title: 'New action',
            className: 'quick-capture-modal',
            content: form,
            buttons: [
                { text: 'Cancel', className: 'secondary-btn', onClick: () => modal.close() },
                { text: 'Add action', className: 'primary-btn', onClick: () => save() }
            ]
        });

        const save = () => {
            const raw = titleEl.value.trim();
            if (!raw) return;
            const id = ScheduleApp.quickAddDetached(raw, { silent: true });
            if (!id) return; // quickAddTask already toasted why (e.g. no name)
            if (ctx) LinkManager.addLink(ctx.app, ctx.itemId, 'schedule', id);
            const item = ScheduleApp.scheduleItems.find(i => i.id === id);
            const isToday = item && item.scheduledDate === ScheduleApp.getLocalToday();
            modal.close();
            UIUtils.showToast(`Action added${isToday ? ' to Today' : ''}`, 'success', 4000, {
                actionLabel: 'View',
                onAction: () => this.openApp('actions')
            });
            // Refresh whichever list the user is looking at.
            if (this.currentApp === 'actions' && typeof ActionsApp !== 'undefined') ActionsApp.render();
            else if (this.currentApp === 'schedule') ScheduleApp.render();
        };
        // Expand: carry the PARSED title into the full task editor.
        const expand = () => {
            const parsed = ScheduleQuickParse.parse(titleEl.value.trim(), ScheduleApp.getLocalToday());
            modal.close();
            // updateHash:false — see quickCreateNote; openEditor sets the
            // detail hash itself via replaceState (no hashchange fired).
            this.openApp('schedule', false);
            ScheduleApp.openEditor(null, { title: parsed.title.trim() });
        };
        this._addModalExpand(modal, expand);
        titleEl.addEventListener('input', () => {
            const raw = titleEl.value.trim();
            if (!raw) { previewEl.hidden = true; previewEl.innerHTML = ''; return; }
            const parsed = ScheduleQuickParse.parse(raw, ScheduleApp.getLocalToday());
            if (!parsed.hasParse) { previewEl.hidden = true; previewEl.innerHTML = ''; return; }
            const chips = parsed.chips.map(c =>
                `<span class="schedule-parse-chip">${UIUtils.escapeHtml(c.label)}</span>`).join('');
            const title = parsed.title.trim()
                ? `<span class="schedule-parse-preview-title">&#8594; <strong>${UIUtils.escapeHtml(parsed.title.trim())}</strong></span>`
                : `<span class="schedule-parse-preview-title">Add a task name</span>`;
            previewEl.innerHTML = chips + title;
            previewEl.hidden = false;
        });
        titleEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); save(); }
        });
        requestAnimationFrame(() => titleEl.focus());
    },

    appIcons: {
        actions: '☑', focus: '🔍', notes: '📝', goals: '🎯', journal: '📔',
        schedule: '🕐', bookmarks: '🔖', portfolio: '📊',
        agent: '✨', settings: '⚙', help: '?'
    },

    setupAppPicker() {
        const pickerBtn = document.getElementById('app-picker-btn');
        const dropdown = document.getElementById('app-picker-dropdown');
        if (!pickerBtn || !dropdown) return;

        pickerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.classList.toggle('open');
            // Highlight current app
            dropdown.querySelectorAll('.app-picker-item').forEach(item => {
                item.classList.toggle('active', item.dataset.app === this.currentApp);
            });
        });

        dropdown.querySelectorAll('.app-picker-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                dropdown.classList.remove('open');
                const appName = item.dataset.app;
                if (appName === 'home') {
                    this.showDashboard();
                } else {
                    this.openApp(appName);
                }
            });
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', () => {
            dropdown.classList.remove('open');
        });
    },

    updateAppPicker(appName) {
        const picker = document.getElementById('app-picker');
        const icon = document.getElementById('app-picker-icon');
        if (!picker || !icon) return;

        icon.textContent = appName ? (this.appIcons[appName] || '') : '🏠';
        picker.style.display = '';
    },

    /**
     * Which Settings category configures each app. Apps without an entry
     * land on the Settings root — every gear still goes somewhere sane.
     */
    _settingsCategoryForApp: {
        agent: 'ai',
        calendar: 'accounts',
        appstudio: 'build',
        maker: 'build',
    },

    openAppSettings(appName) {
        // Email has ONE unified settings surface — the in-app Email Settings
        // page (accounts + insights + bundles). Both email gears land there.
        if (appName === 'email' && typeof EmailApp !== 'undefined') {
            this.openApp('email');
            setTimeout(() => EmailApp.showPrioritySettings(), 0);
            return;
        }
        this.openApp('settings');
        // openApp renders Settings synchronously; category switch on next
        // tick so it lands after any root render.
        setTimeout(() => {
            if (typeof SettingsApp === 'undefined') return;
            const cat = this._settingsCategoryForApp[appName];
            if (cat) SettingsApp.openCategory(cat);
            else SettingsApp.showRoot?.();
        }, 0);
    },

    // Highlight the current app in the global left nav ('home' = the Feed
    // item). Called from openApp and showDashboard. Also drives the rail's
    // auto-collapse: expanded on home, icon-only everywhere else (hovering
    // the collapsed rail flies it open — pure CSS, see body.nav-collapsed).
    updateSidebarActive(appName) {
        document.body.classList.toggle('nav-collapsed', appName !== 'home');
        document.querySelectorAll('.dash-nav .dash-app-tile[data-app]').forEach(tile => {
            tile.classList.toggle('is-current', tile.dataset.app === appName);
        });
        document.querySelector('.dash-nav-feed')
            ?.classList.toggle('is-current', appName === 'home');
    },

    /**
     * Wire the dashboard tab bar (Apps / Feed). Persists the
     * current tab in localStorage so reopening home keeps the user's
     * choice. Defaults to "apps" — that's the launcher use case the
     * tile grid was designed for. (A stored legacy tab name, e.g. the
     * removed "widgets", falls back to "apps".)
     */
    setupDashboardTabs() {
        // No Apps/Feed tabs anymore: the left nav owns app launching and
        // the feed is the permanent home stage. (Name kept for the caller.)
        const clearBtn = document.getElementById('prompt-feed-clear');
        if (clearBtn && typeof PromptFeed !== 'undefined') {
            clearBtn.addEventListener('click', () => PromptFeed.clearAll());
        }
        // The nav's Feed item: from a sub-app it navigates home; on home it
        // returns the stream to the top.
        document.querySelector('.dash-nav [data-nav="home"]')?.addEventListener('click', () => {
            if (this.currentApp) { this.showDashboard(); return; }
            // Already home: close an open feed post, return the stream to top.
            if (typeof PromptFeed !== 'undefined' && PromptFeed.closePost) PromptFeed.closePost();
            document.querySelector('#dashboard-view .dash-main')
                ?.scrollTo({ top: 0, behavior: 'smooth' });
        });

        // Hover intent for the collapsed rail's peek flyout. Timers gate WHEN
        // .is-peek flips (120ms in — real intent, not a pass-through; 300ms
        // out — forgiveness), and the CSS width transition runs immediately
        // once it does, so the motion is one smooth curve, never
        // delay-then-snap. The class is meaningless while the rail is
        // expanded (home, wide windows), so it's toggled unconditionally.
        const nav = document.querySelector('.dash-nav');
        if (nav) {
            let peekTimer = null;
            nav.addEventListener('mouseenter', () => {
                clearTimeout(peekTimer);
                peekTimer = setTimeout(() => nav.classList.add('is-peek'), 120);
            });
            nav.addEventListener('mouseleave', () => {
                clearTimeout(peekTimer);
                peekTimer = setTimeout(() => nav.classList.remove('is-peek'), 300);
            });
        }
    },

    /**
     * Setup theme (load saved theme)
     */
    setupTheme() {
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);
    },

    /**
     * Toggle dark/light theme
     */
    toggleTheme() {
        const html = document.documentElement;
        const currentTheme = html.getAttribute('data-theme');
        const newTheme = currentTheme === 'light' ? 'dark' : 'light';
        html.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
    },

    /**
     * Setup menu bar action listeners
     */
    setupMenuActions() {
        window.electronMenu.onMenuAction((action) => {
            switch (action) {
                case 'settings':
                    this.showSettings();
                    break;
                case 'help':
                    this.showHelp();
                    break;
                case 'toggle-theme':
                    this.toggleTheme();
                    break;
                case 'new-action':
                    this.quickCreateTask();
                    break;
            }
        });
    },

    setupSyncIndicator() {
        if (!window.electronSync) return;
        window.electronSync.onMergeResult((result) => {
            if (!result || result.merged === 0) return;
            this.flashTitlebarStatus(`Synced ${result.merged} change${result.merged !== 1 ? 's' : ''}`);
        });
        this.promptSyncUnlockIfLocked();
    },

    // H6: a Mac whose sync key is passphrase-protected but not yet unlocked
    // here comes up LOCKED — main pauses sync + backups until the passphrase
    // is entered. Prompt once on startup so the user can resume; on success
    // reload so the just-merged data shows.
    async promptSyncUnlockIfLocked() {
        try {
            const st = await window.electronSync.encryptionStatus?.();
            if (!st || !st.locked || typeof SettingsApp === 'undefined') return;
            const ok = await SettingsApp._syncEncPrompt('unlock');
            if (ok) setTimeout(() => window.location.reload(), 600);
        } catch { /* non-fatal — the Settings panel can still unlock */ }
    },

    /**
     * Briefly show a status message in the titlebar, reusing the sync
     * indicator slot. Used by background passes (sync merge, memory
     * consolidation) so the user sees that silent work happened.
     */
    flashTitlebarStatus(text) {
        const el = document.getElementById('sync-indicator');
        const textEl = document.getElementById('sync-indicator-text');
        if (!el || !textEl) return;

        textEl.textContent = text;
        el.style.display = '';
        el.classList.remove('fade-out');

        // Auto-hide after 8 seconds
        clearTimeout(this._syncIndicatorTimer);
        this._syncIndicatorTimer = setTimeout(() => {
            el.classList.add('fade-out');
            setTimeout(() => { el.style.display = 'none'; }, 600);
        }, 8000);
    },

    /**
     * Show settings (opens settings app view)
     */
    showSettings() {
        this.openApp('settings');
    },

    /**
     * Show help (opens help app view)
     */
    showHelp() {
        this.openApp('help');
    },

    /**
     * Show restore backup picker modal (used by SettingsApp)
     */
    async showRestoreBackupPicker() {
        try {
            const backups = await window.electronBackup.listBackups();
            if (backups.length === 0) {
                UIUtils.showToast('No backups found', 'warning');
                return;
            }

            const backupListHtml = backups.map((b, i) => {
                const date = new Date(b.modified);
                const sizeMB = (b.size / (1024 * 1024)).toFixed(2);
                const typeLabel = b.type === 'manual' ? 'Manual' : 'Auto';
                const typeBadgeColor = b.type === 'manual' ? 'var(--color-primary)' : 'var(--color-text-tertiary)';
                return `
                    <div class="backup-item" data-index="${i}" style="display: flex; align-items: center; justify-content: space-between; padding: 0.75rem; border: 1px solid var(--color-border); border-radius: var(--radius-sm); cursor: pointer; transition: background 0.15s;">
                        <div style="flex: 1;">
                            <div style="font-size: var(--text-sm); color: var(--color-text);">
                                ${date.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}
                                <span style="color: var(--color-text-secondary); margin-left: 0.25rem;">${date.toLocaleTimeString()}</span>
                            </div>
                            <div style="font-size: var(--text-xs); color: var(--color-text-tertiary); margin-top: 0.25rem;">
                                ${sizeMB} MB
                            </div>
                        </div>
                        <span style="font-size: var(--text-xs); padding: 0.15rem 0.5rem; border-radius: var(--radius-sm); background: ${typeBadgeColor}; color: var(--color-bg);">
                            ${typeLabel}
                        </span>
                    </div>`;
            }).join('');

            const pickerModal = Modal.create({
                title: 'Restore from Backup',
                className: 'modal-wide',
                content: `
                    <p style="color: var(--color-text-secondary); font-size: var(--text-sm); margin-bottom: 0.75rem;">
                        Select a backup to restore. This will replace all current data.
                    </p>
                    <div id="backup-list" style="display: flex; flex-direction: column; gap: 0.5rem; max-height: 300px; overflow-y: auto;">
                        ${backupListHtml}
                    </div>
                `,
                buttons: [{
                    text: 'Cancel',
                    className: 'secondary-btn',
                    onClick: () => pickerModal.close()
                }]
            });

            const items = document.querySelectorAll('.backup-item');
            items.forEach(item => {
                item.addEventListener('mouseenter', () => item.style.background = 'var(--color-surface-hover)');
                item.addEventListener('mouseleave', () => item.style.background = '');
                item.addEventListener('click', async () => {
                    const idx = parseInt(item.dataset.index);
                    const chosen = backups[idx];
                    const chosenDate = new Date(chosen.modified).toLocaleString();
                    pickerModal.close();

                    const confirmed = await UIUtils.confirm(
                        'Confirm Restore',
                        `Restore from ${chosen.type === 'manual' ? 'manual' : 'auto'} backup dated ${chosenDate}?\n\nThis will replace all current data. The app will reload after restore.`
                    );
                    if (!confirmed) return;

                    const result = await window.electronBackup.restore(chosen.path);
                    if (result.success) {
                        UIUtils.showToast('Restored from backup. Reloading...', 'success');
                        setTimeout(() => window.location.reload(), 1500);
                    } else {
                        UIUtils.showToast('Restore failed: ' + result.error, 'error');
                    }
                });
            });
        } catch (err) {
            UIUtils.showToast('Restore failed: ' + err.message, 'error');
        }
    },

    /**
     * Change storage location
     */
    async changeStorageLocation() {
        try {
            // Open folder selection dialog
            const folderPath = await window.electronDialog.selectFolder();

            if (!folderPath) {
                return; // User cancelled
            }

            // Check if path is writable
            const pathCheck = await window.electronDialog.checkPath(folderPath);
            if (!pathCheck.writable) {
                UIUtils.showToast('Selected folder is not writable', 'error');
                return;
            }

            // Check if data already exists at this location
            const existingData = await window.electronStore.checkDataAtPath(folderPath);

            if (existingData.exists && existingData.hasData) {
                // Ask user what to do
                const useExisting = await UIUtils.confirm(
                    'Data Found',
                    'Data already exists at this location. Would you like to use the existing data? Click "Confirm" to use existing data, or "Cancel" to migrate your current data (will overwrite).',
                    '📁'
                );

                if (useExisting) {
                    // Use existing data - don't migrate
                    const result = await window.electronStore.setCustomStoragePath(folderPath, false);
                    if (result.success) {
                        UIUtils.showToast('Storage location changed. Using existing data.', 'success');
                        setTimeout(() => window.location.reload(), 1500);
                    }
                    return;
                }
            }

            // Migrate data to new location
            const confirmed = await UIUtils.confirm(
                'Change Storage Location',
                `Your data will be moved to:\n${folderPath}\n\nThe app will reload after the change.`,
                '📁'
            );

            if (confirmed) {
                const result = await window.electronStore.setCustomStoragePath(folderPath, true);

                if (result.success) {
                    UIUtils.showToast('Storage location changed successfully!', 'success');
                    setTimeout(() => window.location.reload(), 1500);
                } else {
                    UIUtils.showToast('Failed to change storage location', 'error');
                }
            }
        } catch (error) {
            console.error('Error changing storage location:', error);
            UIUtils.showToast('Error changing storage location', 'error');
        }
    },

    /**
     * Reset storage location to default (Electron only)
     */
    async resetStorageLocation() {
        const confirmed = await UIUtils.confirm(
            'Reset Storage Location',
            'This will move your data back to the default location. The app will reload after the change.',
            '↩️'
        );

        if (confirmed) {
            try {
                const result = await window.electronStore.setCustomStoragePath(null, true);

                if (result.success) {
                    UIUtils.showToast('Storage location reset to default', 'success');
                    setTimeout(() => window.location.reload(), 1500);
                } else {
                    UIUtils.showToast('Failed to reset storage location', 'error');
                }
            } catch (error) {
                console.error('Error resetting storage location:', error);
                UIUtils.showToast('Error resetting storage location', 'error');
            }
        }
    },

    /**
     * Update dashboard stats
     */
    // --- Dashboard rendering ---

    renderDashHeader() {
        const now = new Date();
        const hour = now.getHours();
        let greeting = 'Good morning';
        if (hour >= 12 && hour < 17) greeting = 'Good afternoon';
        else if (hour >= 17) greeting = 'Good evening';

        const greetingEl = document.getElementById('dash-greeting');
        if (greetingEl) greetingEl.textContent = greeting;

        const dateEl = document.getElementById('dash-date-line');
        if (dateEl) {
            const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            const months = ['January', 'February', 'March', 'April', 'May', 'June',
                           'July', 'August', 'September', 'October', 'November', 'December'];
            dateEl.textContent = `${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}`;
        }

    },

    updateStats() {
        // All panels updated here live on the dashboard. When the user is on
        // an app view they're invisible, so recomputing them is wasted work
        // that slows every page refresh and every in-app save. showDashboard()
        // resets currentApp to null and re-calls updateStats() when the user
        // navigates home, so panels are always fresh when actually viewed.
        if (this.currentApp !== null) return;

        this.updateJournalNudge();
        this.updateFirstRunCard();
        this.renderAnnouncements();
        this.updateDashBadges();
        this.updateWelcome();
    },


    updateWelcome() {
        // No-op. We used to redirect a data-empty home dashboard to the
        // About page, but the empty-data first experience is now owned by
        // the post-onboarding Assistant landing and the Setup Assistant
        // checklist — yanking the user to About on every empty-state
        // dashboard render fought that flow. Kept as a stub so existing
        // callers (updateStats → updateWelcome) stay valid.
    },

    async renderAnnouncements() {
        const container = document.getElementById('dash-announcements');
        if (!container) return;

        let announcements = [];
        try {
            const cfg = await window.electronConfig.get();
            announcements = Array.isArray(cfg?.announcements) ? cfg.announcements : [];
        } catch {}

        const dismissed = new Set((StorageManager.get('dismissed-announcements')?.ids) || []);
        const visible = announcements.filter(a => a && a.id && !dismissed.has(a.id));

        if (visible.length === 0) {
            container.style.display = 'none';
            container.innerHTML = '';
            return;
        }

        container.style.display = '';
        container.innerHTML = '';

        for (const a of visible) {
            const card = document.createElement('div');
            card.className = 'dash-announcement';

            const body = document.createElement('div');
            body.className = 'dash-announcement-body';

            if (a.title) {
                const titleEl = document.createElement('div');
                titleEl.className = 'dash-announcement-title';
                titleEl.textContent = a.title;
                body.appendChild(titleEl);
            }

            if (a.body) {
                const textEl = document.createElement('div');
                textEl.className = 'dash-announcement-text';
                textEl.textContent = a.body;
                body.appendChild(textEl);
            }

            if (a.link && a.link.url && a.link.label) {
                const linkEl = document.createElement('button');
                linkEl.className = 'dash-announcement-link';
                linkEl.textContent = a.link.label;
                linkEl.onclick = () => {
                    if (window.electronAuth && window.electronAuth.openExternal) {
                        window.electronAuth.openExternal(a.link.url);
                    }
                };
                body.appendChild(linkEl);
            }

            const close = document.createElement('button');
            close.className = 'dash-announcement-close';
            close.title = 'Dismiss';
            close.setAttribute('aria-label', 'Dismiss announcement');
            close.innerHTML = '&times;';
            close.onclick = () => this.dismissAnnouncement(a.id);

            card.appendChild(body);
            card.appendChild(close);
            container.appendChild(card);
        }
    },

    dismissAnnouncement(id) {
        const current = StorageManager.get('dismissed-announcements') || {};
        const ids = Array.isArray(current.ids) ? current.ids.slice() : [];
        if (!ids.includes(id)) ids.push(id);
        StorageManager.set('dismissed-announcements', { ids });
        this.renderAnnouncements();
    },

    updateJournalNudge() {
        const nudge = document.getElementById('dash-journal-nudge');
        if (!nudge) return;

        const data = StorageManager.get('journal');
        const entries = data?.entries || [];

        let anchor = entries.reduce((max, e) => {
            const d = e.date || e.createdAt;
            return d > max ? d : max;
        }, '');

        // No entries yet: anchor from first-seen so a clean install
        // doesn't immediately claim "you haven't journaled in a while".
        if (!anchor) {
            let firstSeen = StorageManager.get('journal-nudge-first-seen');
            if (!firstSeen) {
                firstSeen = new Date().toISOString();
                StorageManager.set('journal-nudge-first-seen', firstSeen);
            }
            anchor = firstSeen;
        }

        const diffDays = (new Date() - new Date(anchor)) / (1000 * 60 * 60 * 24);

        if (diffDays > 2) {
            nudge.style.display = '';
            nudge.querySelector('.dash-journal-nudge-btn').onclick = () => AppManager.openApp('journal');
        } else {
            nudge.style.display = 'none';
        }
    },

    // Dashboard's resumable entry into the guided Setup Assistant. The
    // SetupAssistant module owns state/steps; here we just host its
    // compact strip in the existing card slot, or hide it once setup is
    // complete or dismissed. Per-device (localStorage), consistent with
    // the connect-per-Mac reality.
    updateFirstRunCard() {
        const card = document.getElementById('dash-firstrun');
        if (!card) return;
        if (typeof SetupAssistant === 'undefined' || !SetupAssistant.shouldShow()) {
            card.innerHTML = '';
            card.style.display = 'none';
            return;
        }
        card.style.display = '';
        SetupAssistant.renderCompact(card);
    },

    async updateDashBadges() {
        // The Email tile badge prefers the high-signal UNREAD AI INSIGHTS count
        // (renewals, bills, appointments…) — this matches the email app's default
        // Insights view, so the number agrees with what you land on. It falls
        // back to the unread INBOX count when insights are off or none exist yet,
        // so the badge always means "email needs attention".
        const emailBadge = document.getElementById('dash-email-badge');
        if (!emailBadge) return;

        if (typeof EmailApp === 'undefined') {
            emailBadge.textContent = '';
            return;
        }

        const accountEmails = EmailApp.getAccounts().map(a => a.email);
        if (accountEmails.length === 0) {
            emailBadge.textContent = '';
            return;
        }

        // Profile-scoped unread insights, when the feature is on and analyses
        // exist. Once insights are in play they own the badge — a clean insights
        // state shows nothing, even if raw unread mail remains.
        if (EmailApp.aiInsightsEnabled && EmailApp.priorityAnalyses) {
            const analyses = EmailApp.getProfileAnalyses();
            const ids = Object.keys(analyses);
            if (ids.length > 0) {
                const unreadInsights = ids.filter(id => !analyses[id].readAt).length;
                emailBadge.textContent = unreadInsights > 0 ? unreadInsights : '';
                return;
            }
        }

        // Fallback: unread inbox via a direct SELECT COUNT(*) (no full reload).
        if (!window.electronEmailDb?.countUnreadInbox) {
            emailBadge.textContent = '';
            return;
        }
        try {
            const unread = await window.electronEmailDb.countUnreadInbox(accountEmails);
            emailBadge.textContent = unread > 0 ? unread : '';
        } catch {
            emailBadge.textContent = '';
        }
    },

    /**
     * Setup authentication (Touch ID)
     */
    async setupAuth() {
        if (!window.electronAuth) return;

        try {
            this.authAvailable = await window.electronAuth.canPromptTouchID();
            this.authEnabled = await window.electronAuth.getAuthEnabled();
            this.autoLockTimeout = await window.electronAuth.getAutoLockTimeout();
        } catch (e) {
            this.authAvailable = false;
            this.authEnabled = false;
        }

        // Listen for lock events from main process (Cmd+L, screen lock)
        window.electronAuth.onLockScreen(() => {
            if (this.authEnabled) this.lock();
        });

        // Only prompt Touch ID when Anjadhe is actually in front. Auto-lock can
        // fire while the user is in another app (Anjadhe sees no activity), and
        // a proactive promptTouchID there would pop the system dialog over the
        // app they're using. Instead we lock quietly and prompt when the window
        // regains focus. Guarded so a cancel→refocus doesn't loop.
        window.addEventListener('focus', () => {
            if (this.isLocked && this.authEnabled && this.authAvailable) {
                this._autoPromptUnlock();
            }
        });

        // If auth is enabled, lock on launch (window is focused → prompt is OK)
        if (this.authEnabled && this.authAvailable) {
            this.lock();
            this._autoPromptUnlock();
        }

        // Start activity tracking if auth is enabled
        if (this.authEnabled) {
            this.startActivityTracking();
        }
    },

    /**
     * Lock the app
     */
    lock() {
        if (this.isLocked) return;
        this.isLocked = true;
        // Allow exactly one auto-prompt for this lock (fired on focus); further
        // attempts go through the on-screen "Unlock with Touch ID" button.
        this._autoPrompted = false;

        const lockScreen = document.getElementById('lock-screen');
        if (lockScreen) {
            lockScreen.style.display = 'flex';
        }
        // Always show the "Unlock with Touch ID" button as the unlock affordance.
        // The macOS system prompt also auto-appears on launch/focus; while it's
        // on screen promptUnlock() hides this button so only the system prompt
        // shows, and reveals it again if that prompt is cancelled. Crucially,
        // when locking via Cmd+L the window stays focused (no focus event, so no
        // auto-prompt) — the button is then the user's way to start unlocking.
        const unlockBtn = document.getElementById('lock-screen-unlock-btn');
        if (unlockBtn) unlockBtn.style.display = '';

        this.stopActivityTracking();
    },

    /**
     * Auto-prompt Touch ID at most once per lock (used by launch + window
     * focus). The manual unlock button calls promptUnlock() directly to retry.
     */
    _autoPromptUnlock() {
        if (this._autoPrompted) return;
        this._autoPrompted = true;
        this.promptUnlock();
    },

    /**
     * Prompt Touch ID and unlock on success. Guarded against overlapping
     * prompts so a refocus while a prompt is already open can't stack dialogs.
     * Our in-app button stays hidden while the system prompt is up and is
     * revealed only as a retry if it's cancelled.
     */
    async promptUnlock() {
        if (!this.authAvailable || this._unlockInFlight) return;
        this._unlockInFlight = true;
        const unlockBtn = document.getElementById('lock-screen-unlock-btn');
        if (unlockBtn) unlockBtn.style.display = 'none';
        let ok = false;
        try {
            const result = await window.electronAuth.promptTouchID();
            ok = !!(result && result.success);
        } catch (e) {
            // User cancelled or Touch ID failed
        } finally {
            this._unlockInFlight = false;
        }
        if (ok) {
            this.unlock();
        } else if (this.isLocked && unlockBtn) {
            unlockBtn.style.display = '';   // reveal retry button
        }
    },

    /**
     * Unlock the app
     */
    unlock() {
        this.isLocked = false;

        const lockScreen = document.getElementById('lock-screen');
        if (lockScreen) {
            lockScreen.style.display = 'none';
        }

        this.lastActivityTime = Date.now();
        if (this.authEnabled) {
            this.startActivityTracking();
        }
    },

    /**
     * Reset the inactivity timer
     */
    resetActivityTimer() {
        this.lastActivityTime = Date.now();
    },

    /**
     * Start tracking user activity for auto-lock
     */
    startActivityTracking() {
        this.stopActivityTracking();

        this._activityHandler = () => this.resetActivityTimer();
        const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
        events.forEach(evt => document.addEventListener(evt, this._activityHandler, { passive: true }));

        // Check inactivity every 30 seconds
        this.activityCheckInterval = setInterval(() => {
            if (this.isLocked || !this.authEnabled) return;

            const idleMs = Date.now() - this.lastActivityTime;
            const timeoutMs = this.autoLockTimeout * 60 * 1000;

            if (idleMs >= timeoutMs) {
                // Lock quietly — do NOT prompt Touch ID here. The user may be
                // working in another app; the prompt fires when they return to
                // Anjadhe (window focus) or click the unlock button.
                this.lock();
            }
        }, 30000);
    },

    /**
     * Stop tracking user activity
     */
    stopActivityTracking() {
        if (this._activityHandler) {
            const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
            events.forEach(evt => document.removeEventListener(evt, this._activityHandler));
            this._activityHandler = null;
        }
        if (this.activityCheckInterval) {
            clearInterval(this.activityCheckInterval);
            this.activityCheckInterval = null;
        }
    },

    /* ================================================================
     * App Lock — per-app "sensitive apps" gate.
     *
     * A user picks a set of apps (e.g. Notes, Journal, Portfolio) to lock.
     * Entering any of them shows an unlock overlay. The auth mechanism is
     * per-device:
     *   - Touch ID present  → Touch ID only (its system prompt also offers the
     *                         Mac login password). No app passcode is used.
     *   - No Touch ID       → an app passcode, with security-question recovery
     *                         for a forgotten passcode.
     * One successful auth unlocks the whole group for the session and re-locks
     * after idle.
     *
     * Config is the synced `app-lock` StorageManager key so the chosen app set
     * follows the user across Macs:
     *   { apps: [...], passcode: {salt,hash,iterations}|null,
     *     security: [{question,salt,hash,iterations}], timeoutMin }
     * Passcode + security answers are stored only as salted PBKDF2-SHA256
     * hashes. Touch ID availability is per-device (not synced), so each Mac
     * uses whichever mechanism it can.
     * ================================================================ */
    _LOCK_KEY: 'app-lock',
    // Apps that can never be locked — locking Settings would strand the user
    // (no way back in to turn it off).
    _UNLOCKABLE: ['settings', 'help', 'about'],

    getLockConfig() {
        const d = StorageManager.get(this._LOCK_KEY) || {};
        return {
            apps: Array.isArray(d.apps) ? d.apps.slice() : [],
            passcode: d.passcode || null,
            // Security-question recovery for the passcode (non-Touch-ID devices):
            // [{ question, salt, hash, iterations }] — answers stored only as hashes.
            security: Array.isArray(d.security) ? d.security.slice() : [],
            timeoutMin: typeof d.timeoutMin === 'number' ? d.timeoutMin : 5
        };
    },

    setLockConfig(partial) {
        const next = { ...this.getLockConfig(), ...partial };
        StorageManager.set(this._LOCK_KEY, next);
        return next;
    },

    // Which auth mechanism this device uses: Touch ID when the hardware is
    // present (its system prompt also offers the Mac login password), otherwise
    // the app passcode. Touch ID devices never set an app passcode.
    lockMechanism() {
        return this.authAvailable ? 'touchid' : 'passcode';
    },

    // The feature is "on" when at least one app is chosen AND this device has a
    // usable auth mechanism: Touch ID is always usable; otherwise a passcode
    // must be set.
    isLockEnabled() {
        const cfg = this.getLockConfig();
        if (cfg.apps.length === 0) return false;
        return this.authAvailable ? true : !!cfg.passcode;
    },

    isAppLocked(appName) {
        if (!appName) return false;
        return this.isLockEnabled() && this.getLockConfig().apps.includes(appName);
    },

    getLockedApps() {
        return this.isLockEnabled() ? this.getLockConfig().apps.slice() : [];
    },

    canLockApp(appName) {
        return !!appName && !this._UNLOCKABLE.includes(appName);
    },

    // ---- Passcode hashing (Web Crypto PBKDF2) ----
    _hexFromBytes(bytes) {
        return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    },
    _bytesFromHex(hex) {
        return Uint8Array.from(hex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
    },
    async _deriveHash(passcode, saltHex, iterations) {
        const enc = new TextEncoder();
        const keyMaterial = await crypto.subtle.importKey(
            'raw', enc.encode(passcode), 'PBKDF2', false, ['deriveBits']);
        const bits = await crypto.subtle.deriveBits(
            { name: 'PBKDF2', salt: this._bytesFromHex(saltHex), iterations, hash: 'SHA-256' },
            keyMaterial, 256);
        return this._hexFromBytes(new Uint8Array(bits));
    },
    async setPasscode(passcode) {
        const saltHex = this._hexFromBytes(crypto.getRandomValues(new Uint8Array(16)));
        const iterations = 150000;
        const hash = await this._deriveHash(passcode, saltHex, iterations);
        this.setLockConfig({ passcode: { salt: saltHex, hash, iterations } });
    },
    async verifyPasscode(passcode) {
        const cfg = this.getLockConfig();
        if (!cfg.passcode) return false;
        const hash = await this._deriveHash(
            passcode, cfg.passcode.salt, cfg.passcode.iterations || 150000);
        return hash === cfg.passcode.hash;
    },

    // ---- Security-question recovery (passcode devices only) ----
    // Answers are normalized (trimmed, lower-cased, whitespace-collapsed) so
    // casual capitalization/spacing differences don't lock the user out.
    _normalizeAnswer(a) {
        return String(a || '').trim().toLowerCase().replace(/\s+/g, ' ');
    },
    async setSecurityQuestions(qa) {
        const out = [];
        for (const item of qa) {
            const saltHex = this._hexFromBytes(crypto.getRandomValues(new Uint8Array(16)));
            const iterations = 150000;
            const hash = await this._deriveHash(this._normalizeAnswer(item.answer), saltHex, iterations);
            out.push({ question: item.question, salt: saltHex, hash, iterations });
        }
        this.setLockConfig({ security: out });
    },
    getSecurityQuestions() {
        return this.getLockConfig().security.map(s => s.question);
    },
    hasSecurityQuestions() {
        return this.getLockConfig().security.length > 0;
    },
    // All answers must match for recovery to succeed.
    async verifySecurityAnswers(answers) {
        const sec = this.getLockConfig().security;
        if (!sec.length || answers.length !== sec.length) return false;
        for (let i = 0; i < sec.length; i++) {
            const h = await this._deriveHash(
                this._normalizeAnswer(answers[i]), sec[i].salt, sec[i].iterations || 150000);
            if (h !== sec[i].hash) return false;
        }
        return true;
    },

    clearLock() {
        // Removing the passcode + recovery questions disables the feature on
        // passcode devices; keep the app list so re-enabling restores the picks.
        this.setLockConfig({ passcode: null, security: [] });
        this.sensitiveUnlocked = false;
        this.stopSensitiveIdleWatch();
    },

    appLabel(appName) {
        const el = document.querySelector(
            `.dash-apps-section .dash-app-tile[data-app="${appName}"] .dash-app-tile-label`);
        return el ? el.textContent.trim() : appName;
    },

    // ---- Unlock overlay ----
    setupAppLock() {
        const overlay = document.getElementById('applock-overlay');
        if (!overlay || overlay._wired) return;
        overlay._wired = true;

        const form = document.getElementById('applock-form');
        if (form) form.addEventListener('submit', (e) => {
            e.preventDefault();
            this._submitPasscode();
        });
        const touchBtn = document.getElementById('applock-touchid-btn');
        if (touchBtn) touchBtn.addEventListener('click', () => this._tryTouchUnlock());
        const cancelBtn = document.getElementById('applock-cancel-btn');
        if (cancelBtn) cancelBtn.addEventListener('click', () => this._cancelUnlock());
        const forgotBtn = document.getElementById('applock-forgot-btn');
        if (forgotBtn) forgotBtn.addEventListener('click', () => this._forgotPasscode());
    },

    showAppLockOverlay(appName) {
        this.setupAppLock();
        const overlay = document.getElementById('applock-overlay');
        if (!overlay) return;

        const sub = document.getElementById('applock-subtitle');
        if (sub) sub.textContent = `${this.appLabel(appName)} is locked`;

        const err = document.getElementById('applock-error');
        if (err) { err.style.display = 'none'; err.textContent = ''; }
        const pass = document.getElementById('applock-passcode');
        if (pass) pass.value = '';

        // Touch ID devices: Touch ID only (its prompt offers the Mac password as
        // a fallback). Passcode devices: passcode field + "Forgot passcode?".
        const useTouch = this.authAvailable;
        // Our own "Unlock with Touch ID" button starts hidden — while the macOS
        // system prompt is up, only that should show (no redundant in-app
        // button). It's revealed as a retry only if the system prompt is
        // cancelled. On passcode devices it stays hidden entirely.
        const touchBtn = document.getElementById('applock-touchid-btn');
        if (touchBtn) touchBtn.style.display = 'none';
        const form = document.getElementById('applock-form');
        if (form) form.style.display = useTouch ? 'none' : '';
        const forgotBtn = document.getElementById('applock-forgot-btn');
        if (forgotBtn) forgotBtn.style.display = (!useTouch && this.hasSecurityQuestions()) ? '' : 'none';

        overlay.style.display = 'flex';
        if (useTouch) {
            this._tryTouchUnlock();
        } else {
            setTimeout(() => pass && pass.focus(), 50);
        }
    },

    _tryTouchUnlock() {
        if (!window.electronAuth || !this.authAvailable) return;
        // Hide our button while the system prompt is on screen.
        const touchBtn = document.getElementById('applock-touchid-btn');
        if (touchBtn) touchBtn.style.display = 'none';
        window.electronAuth.promptTouchID()
            .then(r => {
                if (r && r.success) this._onUnlockSuccess();
                else this._revealTouchRetry();
            })
            .catch(() => this._revealTouchRetry());
    },

    // Cancelled/failed Touch ID — surface our own button so the user can retry
    // (which re-opens the system prompt).
    _revealTouchRetry() {
        const overlay = document.getElementById('applock-overlay');
        if (!overlay || overlay.style.display === 'none') return;
        const touchBtn = document.getElementById('applock-touchid-btn');
        if (touchBtn && this.authAvailable) {
            touchBtn.textContent = 'Unlock with Touch ID';
            touchBtn.style.display = '';
        }
    },

    async _submitPasscode() {
        const pass = document.getElementById('applock-passcode');
        const err = document.getElementById('applock-error');
        const ok = await this.verifyPasscode(pass ? pass.value : '');
        if (ok) { this._onUnlockSuccess(); return; }
        if (err) { err.textContent = 'Incorrect passcode'; err.style.display = ''; }
        if (pass) { pass.value = ''; pass.focus(); }
    },

    _onUnlockSuccess() {
        this.sensitiveUnlocked = true;
        this.startSensitiveIdleWatch();
        const overlay = document.getElementById('applock-overlay');
        if (overlay) overlay.style.display = 'none';
        const pend = this._pendingLocked;
        this._pendingLocked = null;
        this.renderLockedApps();
        if (pend) this.openApp(pend.appName, pend.updateHash);
    },

    _cancelUnlock() {
        const overlay = document.getElementById('applock-overlay');
        if (overlay) overlay.style.display = 'none';
        this._pendingLocked = null;
        this.showDashboard();
    },

    // "Forgot passcode?" — leave the locked app, go to Settings (always
    // reachable), and open the security-question recovery flow there.
    _forgotPasscode() {
        const overlay = document.getElementById('applock-overlay');
        if (overlay) overlay.style.display = 'none';
        this._pendingLocked = null;
        this.openApp('settings');
        if (typeof SettingsApp !== 'undefined' && SettingsApp.openAppLockRecovery) {
            setTimeout(() => SettingsApp.openAppLockRecovery(), 120);
        }
    },

    // ---- Idle re-lock ----
    startSensitiveIdleWatch() {
        this.stopSensitiveIdleWatch();
        const timeoutMs = Math.max(1, this.getLockConfig().timeoutMin || 5) * 60 * 1000;
        this._sensitiveLastActivity = Date.now();
        this._sensitiveActivityHandler = () => { this._sensitiveLastActivity = Date.now(); };
        const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
        events.forEach(e => document.addEventListener(e, this._sensitiveActivityHandler, { passive: true }));
        this._sensitiveInterval = setInterval(() => {
            if (!this.sensitiveUnlocked) return;
            if (Date.now() - this._sensitiveLastActivity >= timeoutMs) this.lockSensitiveNow();
        }, 30000);
    },

    stopSensitiveIdleWatch() {
        if (this._sensitiveActivityHandler) {
            const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
            events.forEach(e => document.removeEventListener(e, this._sensitiveActivityHandler));
            this._sensitiveActivityHandler = null;
        }
        if (this._sensitiveInterval) { clearInterval(this._sensitiveInterval); this._sensitiveInterval = null; }
    },

    // Re-lock the group immediately. If the user is currently inside a locked
    // app, bounce them home so the content isn't left on screen.
    lockSensitiveNow() {
        this.sensitiveUnlocked = false;
        this.stopSensitiveIdleWatch();
        if (this.currentApp && this.isAppLocked(this.currentApp)) {
            this.showDashboard();
        } else {
            this.renderLockedApps();
        }
    },

    // ---- Locked-app badges ----
    // Locked apps aren't a separate dashboard section anymore; each locked
    // app's own grid tile just carries a lock badge in place (a padlock when
    // locked, an open padlock while the sensitive group is unlocked). This
    // paints those badges and toggles the "Lock now" control in the tabs row.
    renderLockedApps() {
        const section = document.querySelector('.dash-apps-section');

        // Clear any prior lock state so removed/unlocked apps drop their badge.
        document.querySelectorAll('.dash-apps-section .dash-app-tile--locked').forEach(t => {
            t.classList.remove('dash-app-tile--locked');
            t.querySelector('.dash-app-tile-lockbadge')?.remove();
        });

        if (section) {
            const hidden = this.getHiddenApps();
            const glyph = this.sensitiveUnlocked ? '&#128275;' : '&#128274;';
            for (const appName of this.getLockedApps()) {
                if (!appName) continue;
                if (typeof FEATURES !== 'undefined' && FEATURES.isGated(appName) && !FEATURES.isEnabled(appName)) continue;
                if (hidden.has(appName)) continue;
                // Badge every live tile for this app — its canonical grid tile
                // and any Favourites clone — so the lock reads consistently.
                section.querySelectorAll(`.dash-app-tile[data-app="${CSS.escape(appName)}"]`).forEach(tile => {
                    if (tile.querySelector('.dash-app-tile-lockbadge')) return;
                    tile.classList.add('dash-app-tile--locked');
                    const badge = document.createElement('span');
                    badge.className = 'dash-app-tile-lockbadge';
                    badge.innerHTML = glyph;
                    tile.appendChild(badge);
                });
            }
        }

        // "Lock now" only matters while the sensitive group is unlocked.
        const lockBtn = document.getElementById('dash-locked-lock-btn');
        if (lockBtn) {
            lockBtn.style.display = this.sensitiveUnlocked ? '' : 'none';
            if (!lockBtn._wired) {
                lockBtn._wired = true;
                lockBtn.addEventListener('click', () => this.lockSensitiveNow());
            }
        }
    },

    /**
     * Escape HTML to prevent XSS. Escapes quotes too, so the result is safe in
     * both text and attribute (title="…", href="…") contexts.
     */
    escapeHtml(text) {
        return String(text ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    /**
     * Setup schedule notifications (runs globally on app start)
     */
    setupScheduleNotifications() {
        if (!('Notification' in window)) return;

        if (Notification.permission === 'default') {
            Notification.requestPermission();
        }

        const notifiedToday = {};

        const checkAndNotify = () => {
            if (Notification.permission !== 'granted') return;

            const now = new Date();
            const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            const currentHH = now.getHours().toString().padStart(2, '0');
            const currentMM = now.getMinutes().toString().padStart(2, '0');
            const currentTime = `${currentHH}:${currentMM}`;

            // Reset notified set if it's a new day
            if (!notifiedToday[today]) {
                for (const key in notifiedToday) delete notifiedToday[key];
                notifiedToday[today] = new Set();
            }

            const notifiedSet = notifiedToday[today];
            const data = StorageManager.get('schedule');
            const items = data?.scheduleItems || [];
            const dayOfWeek = now.getDay();

            // Convert current time to total minutes for comparison
            const nowMinutes = now.getHours() * 60 + now.getMinutes();

            const formatTime12 = (h, m) => {
                const p = h >= 12 ? 'PM' : 'AM';
                const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
                return `${h12}:${m.toString().padStart(2, '0')} ${p}`;
            };

            for (const item of items) {
                // --- Multi-day advance reminders (for items with reminderDaysBefore) ---
                if (item.reminderDaysBefore?.length && item.scheduledDate && item.lastCompletedDate !== today) {
                    const dueDate = new Date(item.scheduledDate + 'T00:00:00');
                    const todayDate = new Date(today + 'T00:00:00');
                    const daysUntilDue = Math.round((dueDate - todayDate) / (1000 * 60 * 60 * 24));

                    // Check if today matches any of the reminder days
                    if (item.reminderDaysBefore.includes(daysUntilDue)) {
                        // Fire advance reminder at 9:00 AM
                        const reminderKey = `${item.id}_advance_${daysUntilDue}`;
                        if (currentTime === '09:00' && !notifiedSet.has(reminderKey)) {
                            notifiedSet.add(reminderKey);
                            const prefix = item.source === 'email' ? `[Email] ` : '';
                            let body;
                            if (daysUntilDue === 0) {
                                body = `Due today!`;
                            } else if (daysUntilDue === 1) {
                                body = `Due tomorrow (${item.scheduledDate})`;
                            } else {
                                body = `Due in ${daysUntilDue} days (${item.scheduledDate})`;
                            }
                            if (item.sourceEmailFrom) {
                                body += ` — from ${item.sourceEmailFrom}`;
                            }
                            new Notification(`${prefix}${item.title}`, { body, silent: false });
                        }
                    }
                }

                // --- Standard same-day notifications ---
                // Check if item is for today
                let isForToday = true;
                switch (item.repeat) {
                    case 'daily': break;
                    case 'weekdays': isForToday = dayOfWeek >= 1 && dayOfWeek <= 5; break;
                    case 'weekly': isForToday = item.dayOfWeek === dayOfWeek; break;
                    case 'custom': isForToday = (item.repeatDays || []).includes(dayOfWeek); break;
                    default: {
                        if (item.lastCompletedDate && item.lastCompletedDate !== today) {
                            isForToday = false;
                        } else {
                            const itemDate = item.scheduledDate || (item.createdAt ? item.createdAt.slice(0, 10) : today);
                            isForToday = itemDate === today;
                        }
                        break;
                    }
                }
                if (!isForToday) continue;

                // Check if already completed today
                if (item.lastCompletedDate === today) continue;

                // Untimed tasks have no clock time — they get advance-day
                // reminders (handled above) but no time-of-day notification.
                if (!item.startTime) continue;

                const [sh, sm] = item.startTime.split(':').map(Number);
                const startMinutes = sh * 60 + sm;
                const notifyBefore = item.notifyBefore || 0; // minutes before
                const notifyAt = startMinutes - notifyBefore;

                // Notification for the early reminder
                if (notifyBefore > 0 && nowMinutes === notifyAt && !notifiedSet.has(item.id + '_early')) {
                    notifiedSet.add(item.id + '_early');

                    let body = `Starting in ${notifyBefore} min at ${formatTime12(sh, sm)}`;
                    if (item.endTime) {
                        const [eh, em] = item.endTime.split(':').map(Number);
                        body += ` - ${formatTime12(eh, em)}`;
                    }

                    new Notification(item.title, { body, silent: false });
                }

                // Notification at the exact start time
                if (item.startTime === currentTime && !notifiedSet.has(item.id)) {
                    notifiedSet.add(item.id);

                    let body = formatTime12(sh, sm);
                    if (item.endTime) {
                        const [eh, em] = item.endTime.split(':').map(Number);
                        body += ` - ${formatTime12(eh, em)}`;
                    }

                    new Notification(item.title, { body, silent: false });
                }
            }
        };

        // Check every 30 seconds
        setInterval(checkAndNotify, 30000);
        checkAndNotify();
    },

};
