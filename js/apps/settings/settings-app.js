/**
 * Settings App
 * Full-page settings with storage, backup, theme, AI, auth, and developer options
 */

const SettingsApp = {
    init() {
        this.setupEventListeners();
        this.loadSettings();
        this.renderLogs();
        this.renderSearchLogs();
    },

    render() {
        // Opening Settings always lands on the root category list (iOS-style;
        // predictable), unless a search is mid-flight.
        const searching = !!document.querySelector('.settings-shell.searching');
        if (!searching) this.showRoot();
        this.loadSettings();
        this.renderLogs();
        this.renderSearchLogs();
    },

    /**
     * Build Apps panel — user-built apps platform (docs/PLATFORM.md).
     * Buttons use onclick assignment because loadSettings re-runs on every
     * Settings open and must not stack listeners.
     */
    async _loadUserAppsSettings() {
        // App Studio visibility (features.js `appstudio`, off by default).
        // Flag gating happens at script load (launcher tile, agent tools),
        // so a flip only lands after a reload — do it for the user.
        const studioToggle = document.getElementById('settings-appstudio-toggle');
        if (studioToggle && typeof FEATURES !== 'undefined') {
            studioToggle.checked = FEATURES.isEnabled('appstudio');
            studioToggle.onchange = () => {
                FEATURES.setOverride('appstudio', studioToggle.checked);
                UIUtils.showToast(studioToggle.checked ? 'App Studio enabled — reloading…' : 'App Studio hidden — reloading…');
                setTimeout(() => window.location.reload(), 700);
            };
        }

        const offEl = document.getElementById('settings-userapps-off');
        const onEl = document.getElementById('settings-userapps-on');
        if (!offEl || !onEl || !window.electronApps?.status) return;

        const refresh = async () => {
            const status = await window.electronApps.status();
            offEl.style.display = status.enabled ? 'none' : '';
            onEl.style.display = status.enabled ? '' : 'none';
            if (!status.enabled) return;
            const pathEl = document.getElementById('settings-userapps-path');
            if (pathEl) pathEl.textContent = status.dir;
            const countEl = document.getElementById('settings-userapps-count');
            if (countEl) {
                const apps = await window.electronApps.list();
                const n = Array.isArray(apps) ? apps.length : 0;
                countEl.textContent = n === 0
                    ? 'No apps yet. Open a terminal in the folder and ask your coding agent to build one.'
                    : `${n} app${n !== 1 ? 's' : ''} installed.`;
            }
        };

        const enableBtn = document.getElementById('settings-userapps-enable-btn');
        if (enableBtn) {
            enableBtn.onclick = async () => {
                const result = await window.electronApps.enable();
                if (!result.ok) {
                    UIUtils.showToast(`Could not enable app building: ${result.error}`, 'error');
                    return;
                }
                UIUtils.showToast('App building enabled', 'success');
                await refresh();
            };
        }
        const openBtn = document.getElementById('settings-userapps-open-btn');
        if (openBtn) {
            openBtn.onclick = () => window.electronApps.openFolder();
        }

        await refresh();
        // No builder-specific model or provider settings anymore: builds run
        // on the AI Assistant's model — one brain for chat and building
        // (docs/COWORK_AGENT.md §5). The old builder-settings key
        // (localModel / experimentalBuilders) is retired.
    },

    async loadSettings() {
        const storageFolder = window.electronStore.getStorageFolder();

        // Storage summary on main settings page
        const storagePathEl = document.getElementById('settings-storage-path');
        if (storagePathEl) storagePathEl.textContent = storageFolder;

        // Profiles summary
        const profileCount = ProfileManager.getProfiles().length;
        const profileSummary = document.getElementById('settings-profiles-summary');
        if (profileSummary) profileSummary.textContent = `${profileCount} profile${profileCount !== 1 ? 's' : ''}`;

        // Setup Assistant: only surface the entry while there's something to
        // do. Hidden once complete; resurfaces on its own if a future release
        // adds new setup steps (isComplete() tracks the live step count).
        const setupGroup = document.getElementById('settings-setup-group');
        const setupNav = document.getElementById('settings-nav-setup');
        if (setupGroup && typeof SetupAssistant !== 'undefined') {
            const incomplete = !SetupAssistant.isComplete();
            setupGroup.style.display = incomplete ? '' : 'none';
            if (setupNav) setupNav.style.display = incomplete ? '' : 'none';
            const setupSummary = document.getElementById('settings-setup-summary');
            if (setupSummary && incomplete) {
                const done = SetupAssistant.completedCount();
                const total = SetupAssistant.steps().length;
                setupSummary.textContent = `${done} of ${total} steps done`;
            }
            // If the user is ON the Setup page and it just completed, return
            // to the root list rather than leaving a blank page.
            if (!incomplete && this._mode === 'category' &&
                document.querySelector('.settings-panel.active')?.dataset.cat === 'setup') {
                this.showRoot();
            }
        }

        // Theme
        const darkToggle = document.getElementById('settings-dark-mode');
        if (darkToggle) darkToggle.checked = document.documentElement.getAttribute('data-theme') === 'dark';

        // DevTools state
        const devToggle = document.getElementById('settings-devtools');
        if (devToggle && window.electronAuth?.isDevToolsOpen) {
            window.electronAuth.isDevToolsOpen().then(isOpen => { devToggle.checked = isOpen; });
        }

        // Build Apps (user-built apps platform)
        this._loadUserAppsSettings();

        // AI Assistant summary
        this._loadLLMSummary();

        // Assistant permission grants (docs/COWORK_AGENT.md C1)
        this._loadAgentPermissions();

        // Experimental capability toggles (feature flags)

        // MCP tool servers (docs/COWORK_AGENT.md C2; behind the mcp flag)
        this._loadMCPServers();

        // Connected accounts (gmail + calendar in one place)
        this._renderConnectedAccounts();

        // Paired devices (the phone <-> Mac channel)
        this._renderPairedDevices();

        // Privacy / analytics badge
        const privacyBadge = document.getElementById('settings-privacy-status');
        if (privacyBadge && typeof AnalyticsManager !== 'undefined') {
            privacyBadge.textContent = AnalyticsManager.isEnabled() ? 'On' : 'Off';
        }

        // Network logs count comes from the main process over IPC.
        const netLogBadge = document.getElementById('settings-network-logs-count');
        if (netLogBadge && window.electronNetLog) {
            window.electronNetLog.getLogs()
                .then(logs => { netLogBadge.textContent = Array.isArray(logs) ? logs.length : 0; })
                .catch(() => {});
        }

        // Auth
        const authToggle = document.getElementById('settings-auth-toggle');
        const authSection = document.getElementById('settings-auth-section');
        if (authSection) authSection.style.display = AppManager.authAvailable ? '' : 'none';
        if (authToggle) authToggle.checked = AppManager.authEnabled;

        const autoLockSettings = document.getElementById('settings-auto-lock');
        if (autoLockSettings) autoLockSettings.style.display = AppManager.authEnabled ? '' : 'none';

        const autoLockSelect = document.getElementById('settings-auto-lock-timeout');
        if (autoLockSelect) autoLockSelect.value = AppManager.autoLockTimeout;

        this._loadAppLockSettings();
        this._loadBrowserSearchSettings();
        this._updateRootHints();
    },

    /**
     * Locked apps. The auth mechanism is per-device: Touch ID where available
     * (no app passcode), otherwise an app passcode with security-question
     * recovery. Rendered fresh on every Settings open; controls use property
     * assignment / onclick so the re-run doesn't stack listeners.
     */
    _loadAppLockSettings() {
        const cfg = AppManager.getLockConfig();
        const touch = AppManager.authAvailable;
        const hasPass = !!cfg.passcode;
        const showConfig = touch || hasPass;   // reveal timeout + app picker

        const status = document.getElementById('settings-applock-status');
        if (status) status.textContent = AppManager.isLockEnabled() ? `On · ${cfg.apps.length}` : 'Off';

        const hint = document.getElementById('settings-applock-hint');
        if (hint) hint.textContent = touch
            ? 'Locked apps require Touch ID to open. The Touch ID prompt also lets you use your Mac login password.'
            : 'Locked apps require a passcode to open. Set one below.';

        // Action buttons depend on the mechanism.
        const actions = document.getElementById('settings-applock-actions');
        if (actions) {
            actions.innerHTML = '';
            if (touch) {
                const note = document.createElement('span');
                note.className = 'settings-badge';
                note.textContent = 'Touch ID';
                actions.appendChild(note);
            } else if (!hasPass) {
                actions.appendChild(this._mkLockBtn('Set passcode', () => this._promptSetPasscode()));
            } else {
                actions.appendChild(this._mkLockBtn('Change', () => this._promptSetPasscode()));
                if (AppManager.hasSecurityQuestions()) {
                    actions.appendChild(this._mkLockBtn('Forgot?', () => this.openAppLockRecovery()));
                }
                actions.appendChild(this._mkLockBtn('Turn off', () => this._turnOffAppLock(), 'settings-applock-off-btn'));
            }
        }

        // Options + app picker show on Touch ID devices, or once a passcode exists.
        const options = document.getElementById('settings-applock-options');
        if (options) options.style.display = showConfig ? '' : 'none';
        const appsCard = document.getElementById('settings-applock-apps-card');
        if (appsCard) appsCard.style.display = showConfig ? '' : 'none';

        // The old "Use Touch ID" toggle is gone — Touch ID is implicit now.
        const touchRow = document.getElementById('settings-applock-touchid-row');
        if (touchRow) touchRow.style.display = 'none';

        const timeoutSel = document.getElementById('settings-applock-timeout');
        if (timeoutSel) {
            timeoutSel.value = String(cfg.timeoutMin);
            timeoutSel.onchange = (e) => AppManager.setLockConfig({ timeoutMin: parseInt(e.target.value, 10) || 5 });
        }

        // App checkboxes — built from the dashboard tiles so labels/icons match
        // and user-installed apps are included. Settings/help/about excluded.
        const list = document.getElementById('settings-applock-apps');
        if (list) {
            const seen = new Set();
            const apps = [];
            document.querySelectorAll('.dash-apps-section .dash-app-tile[data-app]').forEach(tile => {
                if (tile.closest('#dash-favorite-apps-row') || tile.closest('#dash-locked-apps-row')) return;
                const id = tile.getAttribute('data-app');
                if (!id || seen.has(id) || !AppManager.canLockApp(id)) return;
                seen.add(id);
                const label = tile.querySelector('.dash-app-tile-label')?.textContent.trim() || id;
                apps.push({ id, label });
            });
            apps.sort((a, b) => a.label.localeCompare(b.label));

            list.innerHTML = '';
            for (const { id, label } of apps) {
                const row = document.createElement('label');
                row.className = 'settings-applock-app-row';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = cfg.apps.includes(id);
                cb.onchange = () => this._toggleLockApp(id, cb.checked);
                const span = document.createElement('span');
                span.textContent = label;
                row.appendChild(cb);
                row.appendChild(span);
                list.appendChild(row);
            }
        }
    },

    _toggleLockApp(appId, on) {
        const cfg = AppManager.getLockConfig();
        const set = new Set(cfg.apps);
        if (on) set.add(appId); else set.delete(appId);
        AppManager.setLockConfig({ apps: Array.from(set) });
        // Reflect the new count badge + refresh the home section.
        const status = document.getElementById('settings-applock-status');
        if (status) status.textContent = AppManager.isLockEnabled() ? `On · ${set.size}` : 'Off';
        AppManager.renderLockedApps();
    },

    _mkLockBtn(text, onClick, extraClass = '') {
        const b = document.createElement('button');
        b.className = 'secondary-btn' + (extraClass ? ' ' + extraClass : '');
        b.textContent = text;
        b.onclick = onClick;
        return b;
    },

    _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    async _turnOffAppLock() {
        const ok = await this._confirmAppLockIdentity('Turn off App Lock', 'Enter your passcode to turn off App Lock.');
        if (!ok) return;
        AppManager.clearLock();
        UIUtils.showToast?.('App Lock turned off', 'success');
        this._loadAppLockSettings();
        AppManager.renderLockedApps();
    },

    /**
     * Set or change the passcode (passcode devices only — Touch ID devices use
     * no app passcode). Initial setup also captures two recovery questions so a
     * forgotten passcode can be reset. Changing keeps the existing questions.
     */
    _promptSetPasscode() {
        const hasPass = !!AppManager.getLockConfig().passcode;
        const wrap = document.createElement('div');
        wrap.className = 'applock-passcode-dialog';
        wrap.innerHTML = `
            ${hasPass ? `
            <label class="applock-dialog-label">Current passcode</label>
            <input type="password" id="applock-cur" class="applock-dialog-input" inputmode="numeric" autocomplete="off">` : ''}
            <label class="applock-dialog-label">New passcode</label>
            <input type="password" id="applock-new" class="applock-dialog-input" inputmode="numeric" autocomplete="off" placeholder="At least 4 characters">
            <label class="applock-dialog-label">Confirm passcode</label>
            <input type="password" id="applock-confirm" class="applock-dialog-input" inputmode="numeric" autocomplete="off">
            ${hasPass ? '' : `
            <div class="applock-dialog-section">Recovery questions</div>
            <p class="applock-dialog-prompt">If you forget your passcode, you'll answer these to reset it. Pick answers you'll remember.</p>
            <label class="applock-dialog-label">Question 1</label>
            <input type="text" id="applock-q1" class="applock-dialog-input" autocomplete="off" placeholder="e.g. First pet's name">
            <label class="applock-dialog-label">Answer 1</label>
            <input type="text" id="applock-a1" class="applock-dialog-input" autocomplete="off">
            <label class="applock-dialog-label">Question 2</label>
            <input type="text" id="applock-q2" class="applock-dialog-input" autocomplete="off" placeholder="e.g. City you were born in">
            <label class="applock-dialog-label">Answer 2</label>
            <input type="text" id="applock-a2" class="applock-dialog-input" autocomplete="off">`}
            <p id="applock-dialog-error" class="applock-dialog-error" style="display:none;"></p>`;

        const showErr = (msg) => {
            const e = wrap.querySelector('#applock-dialog-error');
            e.textContent = msg; e.style.display = '';
        };

        let modalRef = null;
        modalRef = Modal.create({
            title: hasPass ? 'Change passcode' : 'Set passcode',
            content: wrap,
            className: 'applock-passcode-modal',
            buttons: [
                { text: 'Cancel', className: 'secondary-btn', onClick: () => modalRef.close() },
                {
                    text: 'Save',
                    className: 'primary-btn',
                    onClick: async () => {
                        if (hasPass) {
                            const cur = wrap.querySelector('#applock-cur').value;
                            if (!(await AppManager.verifyPasscode(cur))) {
                                showErr('Current passcode is incorrect'); return;
                            }
                        }
                        const np = wrap.querySelector('#applock-new').value;
                        const cp = wrap.querySelector('#applock-confirm').value;
                        if (np.length < 4) { showErr('Passcode must be at least 4 characters'); return; }
                        if (np !== cp) { showErr('Passcodes do not match'); return; }

                        let qa = null;
                        if (!hasPass) {
                            const q1 = wrap.querySelector('#applock-q1').value.trim();
                            const a1 = wrap.querySelector('#applock-a1').value.trim();
                            const q2 = wrap.querySelector('#applock-q2').value.trim();
                            const a2 = wrap.querySelector('#applock-a2').value.trim();
                            if (!q1 || !a1 || !q2 || !a2) {
                                showErr('Fill in both recovery questions and answers'); return;
                            }
                            qa = [{ question: q1, answer: a1 }, { question: q2, answer: a2 }];
                        }

                        await AppManager.setPasscode(np);
                        if (qa) await AppManager.setSecurityQuestions(qa);
                        modalRef.close();
                        UIUtils.showToast?.(hasPass ? 'Passcode changed' : 'Passcode set', 'success');
                        this._loadAppLockSettings();
                        AppManager.renderLockedApps();
                    }
                }
            ]
        });
        setTimeout(() => wrap.querySelector(hasPass ? '#applock-cur' : '#applock-new')?.focus(), 50);
    },

    /**
     * Recovery flow: answer the security questions to reset a forgotten
     * passcode. On success the passcode + questions are cleared and the user is
     * taken straight into setting a fresh passcode.
     */
    openAppLockRecovery() {
        const questions = AppManager.getSecurityQuestions();
        if (!questions.length) {
            UIUtils.showToast?.('No recovery questions are set on this device.', 'error');
            return;
        }
        const wrap = document.createElement('div');
        wrap.className = 'applock-passcode-dialog';
        wrap.innerHTML = `
            <p class="applock-dialog-prompt">Answer your recovery questions to reset the passcode.</p>
            ${questions.map((q, i) => `
                <label class="applock-dialog-label">${this._esc(q)}</label>
                <input type="text" class="applock-dialog-input applock-recovery-answer" data-i="${i}" autocomplete="off">`).join('')}
            <p id="applock-recovery-error" class="applock-dialog-error" style="display:none;"></p>`;

        let modalRef = null;
        modalRef = Modal.create({
            title: 'Reset passcode',
            content: wrap,
            className: 'applock-passcode-modal',
            buttons: [
                { text: 'Cancel', className: 'secondary-btn', onClick: () => modalRef.close() },
                {
                    text: 'Verify',
                    className: 'primary-btn',
                    onClick: async () => {
                        const answers = Array.from(wrap.querySelectorAll('.applock-recovery-answer')).map(i => i.value);
                        if (await AppManager.verifySecurityAnswers(answers)) {
                            AppManager.clearLock();
                            modalRef.close();
                            UIUtils.showToast?.('Verified — set a new passcode', 'success');
                            this._loadAppLockSettings();
                            AppManager.renderLockedApps();
                            this._promptSetPasscode();
                        } else {
                            const e = wrap.querySelector('#applock-recovery-error');
                            e.textContent = 'One or more answers are incorrect'; e.style.display = '';
                        }
                    }
                }
            ]
        });
        setTimeout(() => wrap.querySelector('.applock-recovery-answer')?.focus(), 50);
    },

    /**
     * Lightweight passcode confirmation modal (used before turning the feature
     * off). Resolves true when the entered passcode is correct.
     */
    _confirmAppLockIdentity(title, prompt) {
        return new Promise((resolve) => {
            const wrap = document.createElement('div');
            wrap.className = 'applock-passcode-dialog';
            wrap.innerHTML = `
                <p class="applock-dialog-prompt">${prompt}</p>
                <input type="password" id="applock-verify" class="applock-dialog-input" inputmode="numeric" autocomplete="off">
                <p id="applock-verify-error" class="applock-dialog-error" style="display:none;"></p>`;
            let modalRef = null;
            modalRef = Modal.create({
                title,
                content: wrap,
                className: 'applock-passcode-modal',
                onClose: () => resolve(false),
                buttons: [
                    { text: 'Cancel', className: 'secondary-btn', onClick: () => { modalRef.close(); } },
                    {
                        text: 'Confirm',
                        className: 'primary-btn',
                        onClick: async () => {
                            const val = wrap.querySelector('#applock-verify').value;
                            if (await AppManager.verifyPasscode(val)) {
                                resolve(true);
                                modalRef.close();
                            } else {
                                const e = wrap.querySelector('#applock-verify-error');
                                e.textContent = 'Incorrect passcode'; e.style.display = '';
                            }
                        }
                    }
                ]
            });
            setTimeout(() => wrap.querySelector('#applock-verify')?.focus(), 50);
        });
    },

    _loadBrowserSearchSettings() {
        const data = StorageManager.get('browse_settings') || {};
        const engine = data.searchEngine || 'duckduckgo';
        const custom = data.customSearchUrl || '';
        const sel = document.getElementById('settings-search-engine');
        const customWrap = document.getElementById('settings-search-engine-custom-wrap');
        const customInput = document.getElementById('settings-search-engine-custom-url');
        if (sel) sel.value = engine;
        if (customInput) customInput.value = custom;
        if (customWrap) customWrap.style.display = engine === 'custom' ? '' : 'none';
    },

    // Active two-pane category. Persisted on the instance so returning from a
    // drill-in sub-view (which just re-activates #settings-view) keeps the
    // user where they were. Default to AI.
    _activeCategory: 'ai',

    // ── Two-pane navigator + search ──────────────────────────────────

    _setupNavigator() {
        if (this._navigatorBound) return;
        this._navigatorBound = true;

        // Root list rows (iOS-style): tap a category row → its page.
        const list = document.getElementById('settings-nav-list');
        if (list) {
            list.addEventListener('click', (e) => {
                const item = e.target.closest('[data-cat]');
                if (!item) return;
                this.openCategory(item.dataset.cat);
            });
        }

        const search = document.getElementById('settings-search');
        if (search) {
            search.addEventListener('input', () => this._runSearch(search.value));
            search.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && search.value) {
                    search.value = '';
                    this._runSearch('');
                }
            });
        }

        this.showRoot();
    },

    // ── iOS-style shell modes: 'root' (category list) / 'category' (one page) ──

    showRoot() {
        this._mode = 'root';
        const root = document.getElementById('settings-root');
        if (root) root.style.display = '';
        document.querySelectorAll('#settings-detail .settings-panel').forEach(p => p.classList.remove('active'));
        const shell = document.querySelector('.settings-shell');
        if (shell) shell.classList.remove('in-category');
        Breadcrumb.render('settings-breadcrumb', [{ label: 'Settings' }]);
        this._updateRootHints();
    },

    openCategory(cat) {
        if (!cat) return;
        this._mode = 'category';
        const root = document.getElementById('settings-root');
        if (root) root.style.display = 'none';
        const shell = document.querySelector('.settings-shell');
        if (shell) shell.classList.add('in-category');

        let label = cat;
        document.querySelectorAll('#settings-detail .settings-panel').forEach(p => {
            const active = p.dataset.cat === cat;
            p.classList.toggle('active', active);
            if (active) {
                const t = p.querySelector('.settings-panel-title');
                if (t) label = t.textContent.trim();
            }
        });
        Breadcrumb.render('settings-breadcrumb', [
            { label: 'Settings', action: () => this.showRoot() },
            { label }
        ]);

        // The paired-devices panel reflects live channel state — refresh on open.
        if (cat === 'devices') this._renderPairedDevices();
    },

    // Back-compat alias (harnesses + older callers).
    _selectCategory(cat) {
        this.openCategory(cat);
    },

    // Current-value hints on the root rows — filled from data loadSettings
    // already fetched. Each is best-effort; a missing source leaves the
    // static hint empty rather than erroring.
    _updateRootHints() {
        const set = (id, text) => {
            const el = document.getElementById(id);
            if (el) el.textContent = text || '';
        };
        try {
            if (typeof SetupAssistant !== 'undefined' && !SetupAssistant.isComplete()) {
                set('settings-root-hint-setup', `${SetupAssistant.completedCount()} of ${SetupAssistant.steps().length} steps done`);
            }
        } catch {}
        // AI: the default model entry IS the brain — same source as the
        // AI Assistant sub-view, so the two can't disagree.
        try {
            const def = AgentService.getDefaultEntry?.();
            if (def) {
                const where = def.engine === 'server' ? 'Your server'
                    : def.engine === 'openai' ? 'OpenAI'
                    : def.engine === 'anthropic' ? 'Anthropic'
                    : 'This Mac';
                set('settings-root-hint-ai', `${where} · ${def.model}`);
            } else {
                set('settings-root-hint-ai', 'No model yet');
            }
        } catch {}
        try {
            const n = (typeof AccountsManager !== 'undefined') ? (AccountsManager.getAll() || []).length : 0;
            set('settings-root-hint-accounts', n ? `${n} account${n === 1 ? '' : 's'} connected` : 'Connect Google');
        } catch { set('settings-root-hint-accounts', ''); }
        try {
            const profiles = (typeof ProfileManager !== 'undefined') ? ProfileManager.getProfiles().length : 0;
            set('settings-root-hint-data', profiles > 1 ? `Storage · ${profiles} profiles` : 'Storage, backups, profiles');
        } catch {}
        set('settings-root-hint-appearance',
            document.documentElement.dataset.theme === 'dark' ? 'Dark' : 'Light');
        try {
            const on = (typeof AnalyticsManager !== 'undefined') && AnalyticsManager.isEnabled();
            set('settings-root-hint-privacy', on ? 'Analytics on' : 'Analytics off');
        } catch {}
        try {
            const engineNames = {
                duckduckgo: 'DuckDuckGo', google: 'Google', bing: 'Bing',
                startpage: 'Startpage', kagi: 'Kagi', brave: 'Brave Search',
                ecosia: 'Ecosia', custom: 'Custom search'
            };
            const engine = (StorageManager.get('browse_settings') || {}).searchEngine || 'duckduckgo';
            set('settings-root-hint-browser', engineNames[engine] || 'DuckDuckGo');
        } catch { set('settings-root-hint-browser', ''); }
        set('settings-root-hint-devices', '');
        set('settings-root-hint-build', 'Your apps folder');
        set('settings-root-hint-advanced', '');
    },

    // Live, cross-category filter. Empty query restores normal single-panel
    // mode; a query stacks every panel and hides cards that don't match,
    // collapsing groups/subheads/panels that end up empty.
    _runSearch(raw) {
        const shell = document.querySelector('.settings-shell');
        if (!shell) return;
        const q = (raw || '').trim().toLowerCase();

        const rootList = document.getElementById('settings-nav-list');

        if (!q) {
            shell.classList.remove('searching');
            shell.querySelectorAll('.search-hide').forEach(n => n.classList.remove('search-hide'));
            shell.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('has-match'));
            const empty = document.getElementById('settings-search-empty');
            if (empty) empty.style.display = 'none';
            if (rootList) rootList.style.display = '';
            this.showRoot();
            return;
        }

        // Searching: hide the category rows, stack matching panel content
        // below the search box (root stays visible as the container).
        if (this._mode === 'category') this.showRoot();
        if (rootList) rootList.style.display = 'none';
        shell.classList.add('searching');
        let anyMatch = false;

        shell.querySelectorAll('.settings-panel').forEach(panel => {
            // A hidden conditional section (e.g. Setup/Security) shouldn't surface.
            const conditionallyHidden = panel.dataset.cat === 'setup'
                && (() => { const g = document.getElementById('settings-setup-group'); return g && g.style.display === 'none'; })();

            let panelHasMatch = false;
            panel.querySelectorAll('.settings-card').forEach(card => {
                // A card inside feature-gated-off UI never matches — otherwise
                // its keywords would surface an empty panel title in the stack.
                const gate = card.closest('[data-feature]');
                const gatedOff = gate && typeof FEATURES !== 'undefined'
                    && !FEATURES.isEnabled(gate.getAttribute('data-feature'));
                const hay = (card.textContent + ' ' + (card.dataset.keywords || '')).toLowerCase();
                const match = !conditionallyHidden && !gatedOff && hay.includes(q);
                card.classList.toggle('search-hide', !match);
                if (match) panelHasMatch = true;
            });

            // Collapse empty groups and their subheads.
            panel.querySelectorAll('.settings-card-group').forEach(g => {
                const visible = g.querySelector('.settings-card:not(.search-hide)');
                g.classList.toggle('search-hide', !visible);
            });
            panel.querySelectorAll('.settings-subhead').forEach(sh => {
                let next = sh.nextElementSibling;
                while (next && !next.classList.contains('settings-card-group')) next = next.nextElementSibling;
                sh.classList.toggle('search-hide', !next || next.classList.contains('search-hide'));
            });

            panel.classList.toggle('has-match', panelHasMatch);
            if (panelHasMatch) anyMatch = true;
        });

        const empty = document.getElementById('settings-search-empty');
        if (empty) empty.style.display = anyMatch ? 'none' : '';
    },

    setupEventListeners() {
        this._setupNavigator();

        // Open Setup Assistant sub-view
        this._bindBtn('settings-open-setup-btn', () => {
            this.openSetupAssistant();
        });

        // Open Storage & Backup sub-view
        this._bindBtn('settings-open-storage-btn', () => {
            this.openStorageBackup();
        });

        // Open Profiles sub-view
        this._bindBtn('settings-open-profiles-btn', () => {
            this.openProfileSettings();
        });

        // Open Customize Home Apps sub-view
        this._bindBtn('settings-open-home-apps-btn', () => {
            AppManager.openAppVisibilityModal('settings');
        });

        // Dark mode
        this._bindChange('settings-dark-mode', () => AppManager.toggleTheme(), true);

        // DevTools
        this._bindChange('settings-devtools', async () => {
            const isOpen = await window.electronAuth.toggleDevTools();
            const cb = document.getElementById('settings-devtools');
            if (cb) cb.checked = isOpen;
        }, true);

        // Open AI Assistant sub-view (provider routing + web search key)
        this._bindBtn('settings-open-llm-btn', () => {
            this.openLLMSettings();
        });

        // Memories / LLM Logs / Web Search Logs each get their own sub-view,
        // opened on demand from the AI Assistant page — they were inline-rendered
        // sections before but carry heavy DOM and only matter when a user wants
        // to inspect/edit them.
        // Web-search setup walkthrough on the website (free-key signup steps).
        this._bindBtn('settings-search-help-link', (e) => {
            e.preventDefault();
            window.electronAuth.openExternal('https://anjadhe.com/help/web-search');
        });

        this._bindBtn('settings-open-memories-btn', () => this.openMemoriesSettings());
        this._bindBtn('settings-open-llm-logs-btn', () => this.openLlmLogs());
        this._bindBtn('settings-open-search-logs-btn', () => this.openSearchLogs());
        this._bindBtn('settings-open-network-logs-btn', () => this.openNetworkLogs());
        this._bindBtn('settings-network-logs-refresh-btn', () => this.renderNetworkLogs());
        this._bindBtn('settings-network-logs-clear-btn', async () => {
            try { await window.electronNetLog.clear(); } catch {}
            this.renderNetworkLogs();
            UIUtils.showToast('Network logs cleared', 'success');
        });

        // Open Privacy settings sub-view
        this._bindBtn('settings-open-privacy-btn', () => {
            this.openPrivacySettings();
        });

        this._bindBrowserSearchControls();

        // Auth toggle
        const authToggle = document.getElementById('settings-auth-toggle');
        if (authToggle) {
            const newEl = authToggle.cloneNode(true);
            authToggle.parentNode.replaceChild(newEl, authToggle);
            newEl.addEventListener('change', async (e) => {
                const enabled = e.target.checked;

                if (enabled) {
                    const result = await window.electronAuth.promptTouchID();
                    if (!result.success) {
                        e.target.checked = false;
                        return;
                    }
                }

                AppManager.authEnabled = enabled;
                await window.electronAuth.setAuthEnabled(enabled);

                const autoLock = document.getElementById('settings-auto-lock');
                if (autoLock) autoLock.style.display = enabled ? '' : 'none';

                if (enabled) {
                    AppManager.lastActivityTime = Date.now();
                    AppManager.startActivityTracking();
                } else {
                    AppManager.stopActivityTracking();
                }
            });
        }

        // Auto-lock timeout
        this._bindChange('settings-auto-lock-timeout', async (val) => {
            const minutes = parseInt(val, 10);
            AppManager.autoLockTimeout = minutes;
            await window.electronAuth.setAutoLockTimeout(minutes);
            AppManager.lastActivityTime = Date.now();
        });

    },

    // ── AI Assistant summary + sub-view ──

    async _loadLLMSummary() {
        // The default model entry IS the brain — summarize it directly.
        const engineLabels = { ollama: 'Ollama', llamacpp: 'llama.cpp', server: 'Your server', openai: 'OpenAI', anthropic: 'Anthropic' };
        try { await AgentService.ensureModelList?.(); } catch { /* offline */ }
        const def = AgentService.getDefaultEntry?.() || null;

        const provEl = document.getElementById('settings-llm-provider-display');
        if (provEl) provEl.textContent = def ? (engineLabels[def.engine] || def.engine) : '--';

        const localEl = document.getElementById('settings-llm-local-display');
        if (localEl) localEl.textContent = def ? def.model : '--';
    },

    /**
     * Assistant permission grants — standing "always allow" permissions
     * (docs/COWORK_AGENT.md C1). Machine-local; revoking restores the
     * confirmation dialog for that action.
     */
    async _loadAgentPermissions() {
        const list = document.getElementById('settings-agent-permissions-list');
        if (!list || typeof PermissionManager === 'undefined') return;
        await PermissionManager.ready();
        const grants = PermissionManager.listGrants();
        if (!grants.length) {
            list.innerHTML = '<p class="settings-hint" style="font-style: italic;">No standing permissions. The assistant asks each time.</p>';
            return;
        }
        const esc = UIUtils.escapeHtml;
        // Scoped fs/shell grants (C3) read as "<verb> <scope>"; plain tool
        // grants keep their tool name.
        const label = (g) => {
            if (g.tool === 'fs:read') return `Read files in ${g.scope}`;
            if (g.tool === 'fs:write') return `Write files in ${g.scope}`;
            if (g.tool === 'shell') return `Run commands starting with "${g.scope}"`;
            if (g.tool.startsWith('mcp:')) return `Trust every tool from MCP server "${g.tool.slice(4)}"`;
            return g.tool.replace(/_/g, ' ');
        };
        list.innerHTML = grants.map(g => `
            <div class="settings-toggle-row">
                <span class="settings-toggle-label">
                    <strong>${esc(label(g))}</strong>
                    <span class="settings-hint" style="margin: 0 0 0 6px;">since ${esc(new Date(g.createdAt).toLocaleDateString())}</span>
                </span>
                <span class="settings-row-actions"><button class="secondary-btn" data-revoke="${esc(g.id)}">Revoke</button></span>
            </div>`).join('');
        list.querySelectorAll('button[data-revoke]').forEach(btn => {
            btn.onclick = async () => {
                await PermissionManager.revoke(btn.dataset.revoke);
                UIUtils.showToast('Permission revoked — the assistant will ask again', 'success');
                this._loadAgentPermissions();
            };
        });
    },


    /**
     * MCP tool servers (docs/COWORK_AGENT.md C2). List + add/remove +
     * enable + test + per-server trust. Server processes and secrets live
     * in main; this is config UX only.
     */
    async _loadMCPServers() {
        const list = document.getElementById('settings-mcp-list');
        if (!list || !window.electronMCP?.listServers) return;
        if (typeof FEATURES !== 'undefined' && !FEATURES.isEnabled('mcp')) return;

        const esc = UIUtils.escapeHtml;
        const servers = await window.electronMCP.listServers();
        await (typeof PermissionManager !== 'undefined' ? PermissionManager.ready() : Promise.resolve());
        const trusted = new Set(
            (typeof PermissionManager !== 'undefined' ? PermissionManager.listGrants() : [])
                .filter(g => g.tool.startsWith('mcp:')).map(g => g.tool.slice(4))
        );

        // Recommended preset (docs/COWORK_AGENT.md C6): one-click browser
        // server so "act on any website" doesn't require knowing MCP.
        const presetHtml = servers.some(s => s.name === 'browser') ? '' : `
            <div class="settings-toggle-row">
                <span class="settings-toggle-label" style="flex-direction: column; align-items: flex-start; gap: 2px;">
                    <strong>Browser (Playwright) &middot; recommended</strong>
                    <span class="settings-hint" style="margin: 0;">Lets the assistant open websites, click, and fill forms in a real browser window on this Mac. Needs Node.js; every action asks for permission first.</span>
                </span>
                <span class="settings-row-actions">
                    <button class="secondary-btn" data-mcp-preset="browser">Add</button>
                </span>
            </div>`;

        if (!servers.length) {
            list.innerHTML = presetHtml || '<p class="settings-hint" style="font-style: italic;">No servers yet.</p>';
        } else {
            list.innerHTML = presetHtml + servers.map(s => `
                <div class="settings-toggle-row" data-mcp="${esc(s.name)}">
                    <span class="settings-toggle-label" style="flex-direction: column; align-items: flex-start; gap: 2px;">
                        <strong>${esc(s.name)}</strong>
                        <span class="settings-hint" style="margin: 0;">
                            <code>${esc(s.command)} ${esc((s.args || []).join(' '))}</code>
                            &middot; ${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}
                            ${s.running ? ' &middot; running' : ''}
                            ${trusted.has(s.name) ? ' &middot; trusted' : ''}
                        </span>
                    </span>
                    <span class="settings-row-actions">
                        <button class="secondary-btn" data-mcp-action="test">Test</button>
                        <button class="secondary-btn" data-mcp-action="trust">${trusted.has(s.name) ? 'Untrust' : 'Trust'}</button>
                        <button class="secondary-btn" data-mcp-action="toggle">${s.enabled ? 'Disable' : 'Enable'}</button>
                        <button class="secondary-btn" data-mcp-action="remove">Remove</button>
                    </span>
                </div>`).join('');
        }

        list.onclick = async (e) => {
            const presetBtn = e.target.closest('button[data-mcp-preset]');
            if (presetBtn) {
                presetBtn.disabled = true;
                presetBtn.textContent = 'Adding…';
                const res = await window.electronMCP.addServer({
                    name: 'browser',
                    command: 'npx',
                    args: ['-y', '@playwright/mcp@latest'],
                    env: {}
                });
                if (res.error) { UIUtils.showToast(res.error, 'error'); }
                else UIUtils.showToast('Added "browser" — press Test to connect and load its tools', 'success');
                this._loadMCPServers();
                return;
            }
            const btn = e.target.closest('button[data-mcp-action]');
            if (!btn) return;
            const name = btn.closest('[data-mcp]')?.dataset.mcp;
            if (!name) return;
            const action = btn.dataset.mcpAction;
            const servers = await window.electronMCP.listServers();
            const server = servers.find(s => s.name === name);
            if (action === 'test') {
                btn.disabled = true;
                btn.textContent = 'Testing…';
                const res = await window.electronMCP.testServer(name);
                if (res.error) UIUtils.showToast(`${name}: ${res.error}`, 'error');
                else {
                    UIUtils.showToast(`${name}: connected — ${res.tools.length} tool${res.tools.length === 1 ? '' : 's'}`, 'success');
                    // Re-register with the fresh tool list.
                    const updated = (await window.electronMCP.listServers()).find(s => s.name === name);
                    if (updated && typeof MCPTools !== 'undefined') MCPTools.refreshServer(updated);
                }
            } else if (action === 'trust') {
                const grant = (typeof PermissionManager !== 'undefined' ? PermissionManager.listGrants() : [])
                    .find(g => g.tool === 'mcp:' + name);
                if (grant) {
                    await PermissionManager.revoke(grant.id);
                    UIUtils.showToast(`"${name}" tools will ask again`, 'success');
                } else {
                    await PermissionManager.grantAlways('mcp:' + name);
                    UIUtils.showToast(`"${name}" tools run without asking now`, 'success');
                }
                this._loadAgentPermissions();
            } else if (action === 'toggle') {
                await window.electronMCP.setEnabled(name, !server.enabled);
                const updated = (await window.electronMCP.listServers()).find(s => s.name === name);
                if (updated && typeof MCPTools !== 'undefined') MCPTools.refreshServer(updated);
            } else if (action === 'remove') {
                const ok = await UIUtils.confirm(`Remove "${name}"?`, 'The server config (and any API keys you entered for it) is deleted from this Mac.');
                if (!ok) return;
                await window.electronMCP.removeServer(name);
                if (typeof MCPTools !== 'undefined') MCPTools.unregisterServer(name);
            }
            this._loadMCPServers();
        };

        const addBtn = document.getElementById('settings-mcp-add-btn');
        if (addBtn) addBtn.onclick = () => this._addMCPServer();
    },

    _addMCPServer() {
        let modal;
        const content = document.createElement('div');
        // Labeled fields with per-field hints (labels survive typing;
        // placeholder-only fields lose their meaning the moment they fill).
        content.innerHTML = `
            <div class="settings-form">
                <label class="settings-form-field">
                    <span class="settings-form-label">Name</span>
                    <input id="mcp-add-name" class="settings-form-input" type="text"
                           placeholder="github" spellcheck="false" autocomplete="off">
                </label>
                <label class="settings-form-field">
                    <span class="settings-form-label">Launch command</span>
                    <input id="mcp-add-command" class="settings-form-input settings-form-input--mono" type="text"
                           placeholder="npx -y @modelcontextprotocol/server-github" spellcheck="false" autocomplete="off">
                    <span class="settings-form-hint">Paste it exactly as the server's docs show it.</span>
                </label>
                <label class="settings-form-field">
                    <span class="settings-form-label">Environment variables <em>optional</em></span>
                    <textarea id="mcp-add-env" class="settings-form-input settings-form-input--mono" rows="3"
                              placeholder="GITHUB_TOKEN=ghp_..." spellcheck="false"></textarea>
                    <span class="settings-form-hint">One KEY=value per line, for API keys the server needs. Stored encrypted on this Mac.</span>
                </label>
            </div>`;
        const save = async () => {
            const name = document.getElementById('mcp-add-name')?.value.trim();
            const cmdLine = document.getElementById('mcp-add-command')?.value.trim();
            if (!name || !cmdLine) { UIUtils.showToast('Name and command are required', 'error'); return; }
            const parts = cmdLine.split(/\s+/);
            const env = {};
            for (const line of (document.getElementById('mcp-add-env')?.value || '').split('\n')) {
                const eq = line.indexOf('=');
                if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
            }
            const res = await window.electronMCP.addServer({ name, command: parts[0], args: parts.slice(1), env });
            if (res.error) { UIUtils.showToast(res.error, 'error'); return; }
            modal.close();
            UIUtils.showToast(`Added "${res.name}" — press Test to connect and load its tools`, 'success');
            this._loadMCPServers();
        };
        // Enter in a single-line field submits (the textarea keeps Enter
        // for new env lines).
        content.querySelectorAll('input').forEach(el =>
            el.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); }));
        modal = Modal.create({
            title: 'Add MCP server',
            content,
            buttons: [
                { text: 'Cancel', className: 'secondary-btn' },
                { text: 'Add', className: 'primary-btn', onClick: save }
            ]
        });
        content.querySelector('#mcp-add-name')?.focus();
    },

    // ── Connected accounts (macOS-style: account → toggleable services) ──

    _renderConnectedAccounts() {
        const container = document.getElementById('settings-connected-accounts-list');
        if (!container) return;

        const accounts = (typeof AccountsManager !== 'undefined') ? AccountsManager.getAll() : [];

        let html = '';
        if (accounts.length === 0) {
            html += `<div class="connected-account-empty">No accounts connected yet.</div>`;
        } else {
            for (const account of accounts) {
                html += this._renderAccountRow(account);
            }
        }

        // Single "Add Account" button — runs the unified OAuth flow that
        // grants every service (Mail + Calendar) in one shot.
        html += `
            <div class="connected-account-actions-row">
                <button id="connected-account-add-google" class="secondary-btn">+ Add Google Account</button>
            </div>
        `;

        container.innerHTML = html;

        // Wire up per-account actions
        container.querySelectorAll('.connected-account-service-toggle').forEach(input => {
            input.addEventListener('change', () => {
                const email = input.dataset.email;
                const service = input.dataset.service;
                this._toggleAccountService(email, service, input.checked);
            });
        });

        container.querySelectorAll('.connected-account-reconnect-btn').forEach(btn => {
            btn.addEventListener('click', () => this._reconnectGoogleAccount(btn.dataset.email));
        });

        container.querySelectorAll('.connected-account-disconnect-btn').forEach(btn => {
            btn.addEventListener('click', () => this._disconnectGoogleAccount(btn.dataset.email));
        });

        const addBtn = document.getElementById('connected-account-add-google');
        if (addBtn) addBtn.addEventListener('click', () => this._connectGoogleAccount());

        // "Email settings ›" on the Mail row → the unified Email Settings
        // page. Inside a <label>: stop the click from reaching the toggle.
        container.querySelectorAll('[data-open-email-settings]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                AppManager.openAppSettings('email');
            });
        });
    },

    _renderAccountRow(account) {
        const email = this._esc(account.email);
        const displayName = this._esc(account.displayName || account.email);
        const services = account.services || {};
        // Provider icon — Google for now, easily extended later
        const icon = '&#128247;'; // generic mail icon as placeholder for any provider
        return `
            <div class="connected-account-row">
                <div class="connected-account-header">
                    <div class="connected-account-info">
                        <div class="connected-account-email">${displayName}</div>
                        ${displayName !== email ? `<div class="connected-account-subtitle">${email}</div>` : ''}
                    </div>
                    <div class="connected-account-row-actions">
                        <button class="secondary-btn connected-account-reconnect-btn" data-email="${email}" title="Re-authenticate this account">Reconnect</button>
                        <button class="secondary-btn connected-account-disconnect-btn" data-email="${email}" title="Remove this account">Remove</button>
                    </div>
                </div>
                <div class="connected-account-services">
                    ${this._renderServiceToggle(account.email, 'mail', 'Mail', services.mail)}
                    ${this._renderServiceToggle(account.email, 'calendar', 'Calendar', services.calendar)}
                </div>
            </div>
        `;
    },

    _renderServiceToggle(email, service, label, enabled) {
        // The Mail row carries a door to the unified Email Settings page
        // (insights, bundles, senders — global across accounts).
        const link = service === 'mail'
            ? `<button type="button" class="connected-account-service-link" data-open-email-settings
                       title="Insights, bundles, and sender rules — applies to all accounts">Email settings &#8250;</button>`
            : '';
        return `
            <label class="connected-account-service">
                <span class="connected-account-service-label">${label}</span>
                ${link}
                <span class="settings-switch">
                    <input type="checkbox" class="connected-account-service-toggle"
                           data-email="${this._esc(email)}"
                           data-service="${service}"
                           ${enabled ? 'checked' : ''}>
                    <span class="settings-switch-track"></span>
                </span>
            </label>
        `;
    },

    async _connectGoogleAccount() {
        if (typeof AccountsManager === 'undefined' || !window.electronAccounts) return;
        if (!(await AccountsManager.confirmGoogleConnect())) return;
        UIUtils.showToast('Opening Google sign-in...', 'info');
        try {
            const result = await window.electronAccounts.googleOAuth();
            if (result?.success && result.email) {
                AccountsManager.addOrUpdate({
                    email: result.email,
                    provider: 'google',
                    displayName: result.displayName,
                    enabledServices: result.services || ['mail', 'calendar']
                });
                UIUtils.showToast(`Connected ${result.email}`, 'success');
                this._renderConnectedAccounts();
            } else if (result?.error) {
                UIUtils.showToast(`Connection failed: ${result.error}`, 'error');
            }
        } catch (e) {
            UIUtils.showToast(`Connection error: ${e.message}`, 'error');
        }
    },

    async _reconnectGoogleAccount(email) {
        UIUtils.showToast(`Re-authenticate as ${email}`, 'info');
        await this._connectGoogleAccount();
    },

    async _disconnectGoogleAccount(email) {
        if (typeof AccountsManager === 'undefined') return;
        const confirmed = await UIUtils.confirm(
            'Remove account',
            `Remove ${email}? Synced data from this account (emails, calendar events) will be cleared. You can reconnect later.`,
            ''
        );
        if (!confirmed) return;
        await AccountsManager.remove(email);
        UIUtils.showToast(`Removed ${email}`, 'success');
        this._renderConnectedAccounts();
    },

    _toggleAccountService(email, service, enabled) {
        if (typeof AccountsManager === 'undefined') return;
        AccountsManager.setServiceEnabled(email, service, enabled);
        // The label below the switch updates implicitly via re-render on next open;
        // for now we just toast so the user gets immediate feedback.
        UIUtils.showToast(`${service === 'mail' ? 'Mail' : 'Calendar'} ${enabled ? 'enabled' : 'disabled'} for ${email}`, 'info');
    },

    // ── Paired devices (the phone <-> Mac channel) ──

    async _renderPairedDevices() {
        const container = document.getElementById('settings-paired-devices-list');
        if (!container) return;

        const flagOff = typeof FEATURES !== 'undefined' && !FEATURES.isEnabled('mobilesync');
        if (flagOff || !window.electronChannel) {
            container.innerHTML = `<div class="connected-account-empty">Device pairing is not available in this build.</div>`;
            return;
        }

        // Register the "a phone paired" listener once, on first render.
        if (!this._pairedListenerBound) {
            this._pairedListenerBound = true;
            window.electronChannel.onPaired(() => {
                this._pairingQr = null;
                this._renderPairedDevices();
                if (typeof UIUtils !== 'undefined') UIUtils.showToast('Phone paired', 'success');
            });
        }

        let info = null;
        try { info = await window.electronChannel.getInfo(); } catch {}

        if (!info || !info.available) {
            container.innerHTML = `<div class="connected-account-empty">The channel is offline. Start the relay, then reopen this panel.</div>`;
            return;
        }

        const devices = info.devices || [];
        let html = '';
        if (devices.length === 0) {
            html += `<div class="connected-account-empty">No phone paired yet.</div>`;
        } else {
            for (const device of devices) html += this._renderDeviceRow(device);
        }

        if (this._pairingQr) {
            html += `
                <div class="pairing-qr-block">
                    <div class="pairing-qr">${this._pairingQr}</div>
                    <p class="pairing-qr-help">Open Anjadhe on your iPhone and scan this code to pair. It stays valid for two minutes.</p>
                    <div class="connected-account-actions-row">
                        <button id="paired-device-cancel" class="secondary-btn">Cancel</button>
                    </div>
                </div>
            `;
        } else {
            html += `
                <div class="connected-account-actions-row">
                    <button id="paired-device-pair" class="secondary-btn">+ Pair a device</button>
                </div>
            `;
        }

        container.innerHTML = html;

        container.querySelectorAll('.paired-device-forget-btn').forEach(btn => {
            btn.addEventListener('click', () => this._forgetDevice(btn.dataset.pub));
        });
        const pairBtn = document.getElementById('paired-device-pair');
        if (pairBtn) pairBtn.addEventListener('click', () => this._beginPairing());
        const cancelBtn = document.getElementById('paired-device-cancel');
        if (cancelBtn) cancelBtn.addEventListener('click', () => this._cancelPairing());
    },

    _renderDeviceRow(device) {
        const name = this._esc(device.name || 'iPhone');
        const pub = this._esc(device.pub || '');
        let when = '';
        if (device.pairedAt) {
            const d = new Date(device.pairedAt);
            if (!isNaN(d.getTime())) when = `Paired ${d.toLocaleDateString()}`;
        }
        return `
            <div class="connected-account-row">
                <div class="connected-account-header">
                    <div class="connected-account-info">
                        <div class="connected-account-email">${name}</div>
                        ${when ? `<div class="connected-account-subtitle">${when}</div>` : ''}
                    </div>
                    <div class="connected-account-row-actions">
                        <button class="secondary-btn paired-device-forget-btn" data-pub="${pub}" title="Unpair this device">Forget</button>
                    </div>
                </div>
            </div>
        `;
    },

    async _beginPairing() {
        if (!window.electronChannel) return;
        try {
            const result = await window.electronChannel.beginPairing();
            if (result && result.qrSvg) {
                this._pairingQr = result.qrSvg;
                this._renderPairedDevices();
            } else {
                UIUtils.showToast((result && result.error) || 'Could not start pairing', 'error');
            }
        } catch (e) {
            UIUtils.showToast(`Pairing error: ${e.message}`, 'error');
        }
    },

    _cancelPairing() {
        this._pairingQr = null;
        if (window.electronChannel) window.electronChannel.cancelPairing();
        this._renderPairedDevices();
    },

    async _forgetDevice(pub) {
        if (!window.electronChannel || !pub) return;
        const confirmed = await UIUtils.confirm(
            'Forget device',
            'Unpair this phone? It will need to scan a new code to reconnect.',
            ''
        );
        if (!confirmed) return;
        await window.electronChannel.removeDevice(pub);
        UIUtils.showToast('Device unpaired', 'success');
        this._renderPairedDevices();
    },

    _esc(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    },

    _llmSettingsBound: false,

    // Shared binding setup for both the AI Models sub-view and the AI Assistant
    // sub-view. Element IDs live in whichever view they were moved into — we bind
    // once (idempotent guard) and both sub-views work regardless of open order.
    _ensureLlmBindings() {
        if (this._llmSettingsBound) return;
        this._llmSettingsBound = true;
        this._attachLlmBindings();
    },

    _escape(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },

    async openLLMSettings() {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('llm-settings-view').classList.add('active');
        Breadcrumb.render('llm-settings-breadcrumb', [
            { label: 'Settings', action: () => { document.getElementById('llm-settings-view').classList.remove('active'); document.getElementById('settings-view').classList.add('active'); this._loadLLMSummary(); } },
            { label: 'AI Assistant' }
        ]);

        this._ensureLlmBindings();

        // The model library: a Default-model status card + one card per
        // entry. The DEFAULT entry is the brain (setDefaultEntry writes
        // through to the provider settings) — there is no separate Brain
        // section or engine picker.
        await this._renderModelLibrary();
        this._startLibraryWatch();

        // Web search providers — same card-library pattern as the models.
        await this._renderSearchProviders();

        // Refresh the entry-card badges (Memories / LLM Logs / Search Logs
        // counts) without rendering the heavy lists — those load lazily when
        // the user opens each sub-view.
        this._refreshAssistantBadges();
    },

    // ─────────────────── Model library ───────────────────
    //
    // One card per entry ({id, engine, model, baseUrl?, numCtx?, think?});
    // the DEFAULT entry is the brain. Every card renders its own Manage body
    // inline (no shared/moved panels), every mutation goes through the
    // AgentService entries API (addEntry/updateEntry/removeEntry — never a
    // raw selectedModel write), and downloads are tracked by entry id so a
    // re-render can't orphan a progress bar.

    _engines: null,              // snapshot from _refreshEngineState
    _openManageId: null,         // entry id whose Manage body is open
    _activeDownloads: new Map(), // entry id -> { text, percent }
    _libraryWatchTimer: null,
    _entryKeyStatus: new Map(),  // cloud entry id -> hasKey (refreshed per render)

    _engineLabel(engine) {
        return engine === 'llamacpp' ? 'llama.cpp'
            : engine === 'server' ? 'your server'
            : engine === 'openai' ? 'OpenAI'
            : engine === 'anthropic' ? 'Anthropic'
            : 'Ollama';
    },

    _engineApiFor(engine) {
        return engine === 'llamacpp' ? window.electronLlamaCpp : window.electronOllama;
    },

    /**
     * One parallel snapshot of everything the library renders from: the
     * model catalog (remote config), machine RAM, and each local engine's
     * status + installed + resident model sets. Failures degrade to empty —
     * an unreachable engine just renders as not installed.
     */
    async _refreshEngineState() {
        const wrap = (p) => Promise.resolve(p).then(v => v, () => null);
        const [config, ollamaStatus, ollamaModels, ollamaPs, llamaStatus, llamaModels] = await Promise.all([
            wrap(window.electronConfig?.get?.()),
            wrap(window.electronOllama?.status?.()),
            wrap(window.electronOllama?.listModels?.()),
            wrap(window.electronOllama?.ps?.()),
            wrap(window.electronLlamaCpp?.status?.()),
            wrap(window.electronLlamaCpp?.listModels?.())
        ]);
        const names = (r) => new Set(((r && r.models) || []).map(m => m.name));
        this._engines = {
            catalog: (config && config.models) || [],
            totalMemGB: Number(config?.machine?.totalMemGB) || 8,
            ollama: {
                status: ollamaStatus || { isReady: false, isInstalled: false },
                installed: names(ollamaModels),
                resident: names(ollamaPs)
            },
            llamacpp: {
                status: llamaStatus || { isReady: false, isInstalled: false },
                installed: names(llamaModels),
                resident: new Set(llamaStatus?.isReady && llamaStatus.loadedModel ? [llamaStatus.loadedModel] : [])
            }
        };
        return this._engines;
    },

    /** The catalog record for an entry's model, or null (custom models). */
    _catalogFor(entry) {
        if (!entry || !this._engines) return null;
        return this._engines.catalog.find(m => m.name === entry.model) || null;
    },

    async _renderModelLibrary() {
        const cardsHost = document.getElementById('settings-model-cards');
        if (!cardsHost) return;
        try { await AgentService.ensureModelList?.(); } catch { /* offline */ }
        await this._refreshEngineState();

        const entries = AgentService.getModelList();
        // Cloud entries' status text depends on whether a key is saved —
        // resolve it once per render so _computeEntryStatus stays synchronous
        // (the watch loop repaints from it cheaply).
        await Promise.all(entries
            .filter(e => e.engine === 'openai' || e.engine === 'anthropic')
            .map(async (e) => {
                try {
                    const r = await window.electronLLM?.entryKeyStatus?.(e.id);
                    this._entryKeyStatus.set(e.id, !!(r && r.hasKey));
                } catch { /* leave unknown */ }
            }));
        const def = AgentService.getDefaultEntry();
        this._renderDefaultCard();

        cardsHost.innerHTML = '';
        if (!entries.length) {
            const empty = document.createElement('p');
            empty.className = 'settings-hint settings-model-cards-empty';
            empty.textContent = 'No models yet — add one to get started.';
            cardsHost.appendChild(empty);
            return;
        }
        for (const entry of entries) {
            const card = this._buildModelCard(entry, !!(def && def.id === entry.id));
            cardsHost.appendChild(card);
            if (this._activeDownloads.has(entry.id)) this._paintCardProgress(entry.id);
            if (this._openManageId === entry.id) this._openManage(card, entry);
        }
    },

    _renderDefaultCard() {
        const host = document.getElementById('settings-default-model-card');
        if (!host) return;
        host.innerHTML = '';
        const def = AgentService.getDefaultEntry();
        if (!def) {
            const p = document.createElement('p');
            p.className = 'settings-hint';
            p.style.margin = '0';
            p.textContent = 'No default model yet — add one below.';
            host.appendChild(p);
            return;
        }
        const st = this._computeEntryStatus(def);
        const dot = document.createElement('span');
        dot.className = 'ollama-status-dot' + (st.state === 'ready' ? ' active' : '');
        const name = document.createElement('span');
        name.className = 'settings-default-model-name';
        name.textContent = def.model;
        const badge = document.createElement('span');
        badge.className = 'settings-model-card-engine';
        badge.textContent = this._engineLabel(def.engine);
        const status = document.createElement('span');
        status.className = 'settings-default-model-status';
        status.textContent = st.text;
        host.append(dot, name, badge, status);
    },

    /**
     * Entry status from the engine snapshot — synchronous so the watch can
     * repaint cheaply. States: downloading (an active pull owns the card),
     * server configured/not-configured (no auto-probe: testCustom issues a
     * real completion, too heavy per paint — Test lives in Manage),
     * engine-missing / not-installed / warming / ready / installed.
     */
    _computeEntryStatus(entry) {
        if (!entry) return { state: 'none', text: '' };
        if (this._activeDownloads.has(entry.id)) {
            const p = this._activeDownloads.get(entry.id);
            return { state: 'downloading', text: (p && p.text) || 'Downloading…' };
        }
        if (entry.engine === 'server') {
            if (!entry.baseUrl) return { state: 'not-configured', text: 'No server URL yet — open Manage' };
            let hostLabel = entry.baseUrl;
            try { hostLabel = new URL(entry.baseUrl).host || entry.baseUrl; } catch { /* show raw */ }
            return { state: 'configured', text: hostLabel };
        }
        if (entry.engine === 'openai' || entry.engine === 'anthropic') {
            if (this._entryKeyStatus.get(entry.id) === false) {
                return { state: 'not-configured', text: 'No API key yet — open Manage' };
            }
            return { state: 'configured', text: entry.engine === 'openai' ? 'api.openai.com' : 'api.anthropic.com' };
        }
        const eng = this._engines && this._engines[entry.engine];
        if (!eng) return { state: 'unknown', text: '' };
        if (!eng.status.isInstalled) {
            return {
                state: 'engine-missing',
                text: entry.engine === 'llamacpp' ? 'Engine not installed yet' : 'Ollama not installed yet'
            };
        }
        if (!eng.installed.has(entry.model)) return { state: 'not-installed', text: 'Not downloaded' };
        if (typeof AgentService !== 'undefined' && AgentService._warming) return { state: 'warming', text: 'Warming up…' };
        if (eng.resident.has(entry.model)) return { state: 'ready', text: 'Ready — in memory' };
        return { state: 'installed', text: 'Downloaded' };
    },

    _buildModelCard(entry, isDefault) {
        const card = document.createElement('div');
        card.className = 'settings-model-card' + (isDefault ? ' is-default' : '');
        card.dataset.entryId = entry.id;

        const header = document.createElement('div');
        header.className = 'settings-model-card-header';

        // Default radio — switching also warms local engines.
        const radioWrap = document.createElement('label');
        radioWrap.className = 'settings-model-card-default';
        radioWrap.title = 'Use this model for new chats and every AI feature';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'settings-model-card-default';
        radio.checked = !!isDefault;
        radio.addEventListener('change', async () => {
            if (!radio.checked) return;
            await AgentService.setDefaultEntry(entry.id);
            if (typeof AgentUI !== 'undefined') {
                AgentUI.updateModelChip?.();
                AgentUI.updateModelLabel?.();
                AgentUI.startReadinessWatch?.();
            }
            const e = AgentService.getEntry(entry.id);
            UIUtils.showToast(e && e.engine === 'server'
                ? `Default model: ${e.model} (your server)`
                : `Default model: ${e ? e.model : ''} — warming up`, 'success');
            this._renderModelLibrary();
        });
        radioWrap.appendChild(radio);

        // Name + engine badge (+ catalog description when we have one).
        const info = document.createElement('div');
        info.className = 'settings-model-card-info';
        const name = document.createElement('span');
        name.className = 'settings-model-card-name';
        name.textContent = entry.model;
        const badge = document.createElement('span');
        badge.className = 'settings-model-card-engine';
        badge.textContent = this._engineLabel(entry.engine);
        info.append(name, badge);
        const cat = this._catalogFor(entry);
        if (cat && cat.desc && entry.engine !== 'server') {
            const desc = document.createElement('span');
            desc.className = 'settings-model-card-desc';
            desc.textContent = cat.desc;
            info.appendChild(desc);
        }

        // Status area: text + (when not downloaded) a Download button.
        const statusWrap = document.createElement('div');
        statusWrap.className = 'settings-model-card-statuswrap';
        const status = document.createElement('span');
        status.className = 'settings-model-card-status';
        statusWrap.appendChild(status);
        this._fillCardStatus(statusWrap, status, entry, card);

        // Manage disclosure.
        const manage = document.createElement('button');
        manage.type = 'button';
        manage.className = 'settings-model-card-manage';
        manage.textContent = 'Manage';
        manage.title = entry.engine === 'server'
            ? 'Server URL, API key, connection test'
            : (entry.engine === 'openai' || entry.engine === 'anthropic')
                ? 'API key, model, connection test'
                : 'Engine status, context window, thinking, delete';
        manage.addEventListener('click', () => this._toggleManage(card, entry));

        // Remove from the list (weights stay on disk — Manage deletes those).
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'settings-model-card-remove';
        remove.title = 'Remove this model from the list';
        remove.textContent = '✕';
        remove.addEventListener('click', async () => {
            const ok = await UIUtils.confirm('Remove model',
                `Remove <strong>${this._escape(entry.model)}</strong> from your list? ` +
                (AgentService.isRemoteEngine(entry.engine) ? '' : 'Downloaded files stay on disk — use Manage &rsaquo; Delete to free the space.'),
                '✕', { confirmText: 'Remove' });
            if (!ok) return;
            if (this._openManageId === entry.id) this._openManageId = null;
            AgentService.removeEntry(entry.id);
            if (typeof AgentUI !== 'undefined') {
                AgentUI.updateModelChip?.();
                AgentUI.updateModelLabel?.();
            }
            this._renderModelLibrary();
        });

        header.append(radioWrap, info, statusWrap, manage, remove);
        card.appendChild(header);

        // Hidden Manage body — rendered on open, per card.
        const body = document.createElement('div');
        body.className = 'settings-model-card-body';
        body.style.display = 'none';
        card.appendChild(body);
        return card;
    },

    /** Status text + the action that fits the state (Download / hint). */
    _fillCardStatus(statusWrap, statusEl, entry, card) {
        const st = this._computeEntryStatus(entry);
        card.dataset.state = st.state;
        statusEl.textContent = st.text;
        statusEl.classList.toggle('is-downloading', st.state === 'downloading');
        if (st.state === 'not-installed' || st.state === 'engine-missing') {
            const cat = this._catalogFor(entry);
            if (entry.engine === 'llamacpp' && !(cat && cat.gguf)) {
                // No download source — the model arrives as a GGUF drop-in.
                statusEl.textContent = 'GGUF not found — drop the file in ~/.anjadhe_llamacpp/models';
                return;
            }
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'secondary-btn settings-model-card-download';
            btn.textContent = cat && cat.size ? `Download (${cat.size})` : 'Download';
            if (st.state === 'engine-missing') {
                btn.title = entry.engine === 'llamacpp'
                    ? 'Installs the llama.cpp engine (~11 MB), then downloads the model'
                    : 'Installs Ollama first, then downloads the model';
            }
            btn.addEventListener('click', () => this._startEntryDownload(entry.id));
            statusWrap.appendChild(btn);
        }
    },

    // ── Per-card Manage body ──

    _toggleManage(card, entry) {
        const body = card.querySelector('.settings-model-card-body');
        if (!body) return;
        const isOpen = body.style.display !== 'none';
        // Close any open body (one at a time).
        document.querySelectorAll('.settings-model-card-body').forEach(b => { b.style.display = 'none'; });
        document.querySelectorAll('.settings-model-card-manage.open').forEach(b => b.classList.remove('open'));
        this._openManageId = null;
        if (isOpen) return;
        this._openManage(card, entry);
    },

    _openManage(card, entry) {
        const body = card.querySelector('.settings-model-card-body');
        if (!body) return;
        this._openManageId = entry.id;
        card.querySelector('.settings-model-card-manage')?.classList.add('open');
        body.style.display = '';
        if (entry.engine === 'server') this._renderServerManage(body, entry);
        else if (entry.engine === 'openai' || entry.engine === 'anthropic') this._renderCloudManage(body, entry);
        else this._renderLocalManage(body, entry);
    },

    /**
     * Manage body for a local entry: engine status, Think toggle, context
     * window, license, delete-weights. All controls are closures over the
     * ENTRY and query inside the body — no global ids, so two cards can't
     * fight and nothing mutates machine-global engine state on open.
     */
    _renderLocalManage(body, entry) {
        body.innerHTML = '';
        const eng = this._engines && this._engines[entry.engine];

        const engineHost = document.createElement('div');
        engineHost.className = 'settings-model-card-enginestatus';
        body.appendChild(engineHost);
        this._renderEngineStatusInto(engineHost, entry.engine);

        // Think toggle — per entry, the chat default (header chip overrides per-chat).
        const thinkRow = document.createElement('div');
        thinkRow.className = 'settings-toggle-row';
        const thinkLabel = document.createElement('label');
        thinkLabel.className = 'settings-toggle-label';
        thinkLabel.textContent = 'Thinking';
        const thinkInput = document.createElement('input');
        thinkInput.type = 'checkbox';
        thinkInput.checked = entry.think === true;
        thinkInput.title = 'Enable reasoning by default (slower first token, sometimes better tool planning)';
        thinkInput.addEventListener('change', () => {
            AgentService.updateEntry(entry.id, { think: thinkInput.checked });
        });
        thinkRow.append(thinkLabel, thinkInput);
        body.appendChild(thinkRow);
        const thinkHint = document.createElement('p');
        thinkHint.className = 'settings-hint';
        thinkHint.textContent = 'Reasoning adds hidden thinking tokens before each answer — slower to start, sometimes better at multi-step tasks. Non-reasoning models ignore this. You can still flip it per-chat from the thinking chip.';
        body.appendChild(thinkHint);

        // Context window — per entry (Auto = the RAM tier for this engine).
        const ctxRow = document.createElement('div');
        ctxRow.className = 'settings-toggle-row';
        const ctxLabel = document.createElement('label');
        ctxLabel.className = 'settings-toggle-label';
        ctxLabel.textContent = 'Context window';
        const ctxSel = document.createElement('select');
        ctxSel.className = 'settings-select settings-inline-select';
        const autoVal = AgentService.autoNumCtx(this._engines?.totalMemGB || 8, entry.engine);
        for (const [value, label] of [
            [0, `Auto — ${autoVal.toLocaleString()} on this Mac`],
            [4096, '4,096 tokens (low RAM)'],
            [8192, '8,192 tokens'],
            [16384, '16,384 tokens'],
            [32768, '32,768 tokens'],
            [65536, '65,536 tokens (high memory)']
        ]) {
            const opt = document.createElement('option');
            opt.value = String(value);
            opt.textContent = label;
            ctxSel.appendChild(opt);
        }
        ctxSel.value = String(entry.numCtx || 0);
        ctxSel.addEventListener('change', () => {
            const n = Number(ctxSel.value);
            AgentService.updateEntry(entry.id, { numCtx: Number.isFinite(n) && n > 0 ? n : null });
        });
        ctxRow.append(ctxLabel, ctxSel);
        body.appendChild(ctxRow);
        const ctxHint = document.createElement('p');
        ctxHint.className = 'settings-hint';
        ctxHint.textContent = 'How much conversation and document context this model holds in memory. Bigger fits more but uses more RAM. Changing it triggers a one-time model reload on the next chat.';
        body.appendChild(ctxHint);

        // License — each model ships under its own terms.
        const cat = this._catalogFor(entry);
        if (cat && cat.license) {
            const lic = document.createElement('p');
            lic.className = 'settings-hint';
            lic.textContent = 'License: ';
            const link = document.createElement('a');
            link.href = '#';
            link.className = 'settings-model-license';
            link.textContent = cat.license;
            link.addEventListener('click', (e) => {
                e.preventDefault();
                if (cat.licenseUrl) window.electronAuth?.openExternal?.(cat.licenseUrl);
            });
            lic.appendChild(link);
            body.appendChild(lic);
        }

        // Delete the downloaded weights (the entry itself stays in the list).
        if (eng && eng.installed.has(entry.model)) {
            const delRow = document.createElement('div');
            delRow.className = 'settings-input-row';
            delRow.style.marginTop = 'var(--space-md)';
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'secondary-btn settings-model-card-deleteweights';
            delBtn.textContent = 'Delete model from disk';
            delBtn.addEventListener('click', async () => {
                const ok = await UIUtils.confirm('Delete model',
                    `Delete <strong>${this._escape(entry.model)}</strong> from this Mac? You can download it again anytime.`,
                    '🗑️', { confirmText: 'Delete' });
                if (!ok) return;
                delBtn.disabled = true;
                delBtn.textContent = 'Deleting…';
                try {
                    const result = await this._engineApiFor(entry.engine).deleteModel(entry.model);
                    if (result?.error || result?.success === false) throw new Error(result?.error || 'Delete failed');
                    UIUtils.showToast(`${entry.model} deleted`, 'success');
                    await this._renderModelLibrary();
                } catch {
                    UIUtils.showToast(`Failed to delete ${entry.model}`, 'error');
                    delBtn.disabled = false;
                    delBtn.textContent = 'Delete model from disk';
                }
            });
            delRow.appendChild(delBtn);
            body.appendChild(delRow);
        }
    },

    /**
     * Manage body for a server entry: model name, base URL, per-entry API
     * key, Auto-detect / Test / Save. Saving writes the URL + model onto the
     * ENTRY and the key into main's encrypted per-entry store; a blank key
     * field leaves any stored key untouched.
     */
    _renderServerManage(body, entry) {
        body.innerHTML = '';

        const desc = document.createElement('p');
        desc.className = 'settings-section-desc';
        desc.innerHTML = 'Connection details for this model\'s server &mdash; any endpoint that speaks the OpenAI <code>/v1/chat/completions</code> API (<code>llama-server</code>, vLLM, LM Studio) on a computer you own. Auto-detect finds one running on this Mac.';
        body.appendChild(desc);

        const modelRow = document.createElement('div');
        modelRow.className = 'settings-input-row';
        modelRow.style.marginBottom = 'var(--space-md)';
        const modelInput = document.createElement('input');
        modelInput.type = 'text';
        modelInput.className = 'settings-input';
        modelInput.placeholder = 'Model name on your server, e.g. qwen3.6:35b';
        modelInput.value = entry.model || '';
        modelRow.appendChild(modelInput);
        body.appendChild(modelRow);

        const urlRow = document.createElement('div');
        urlRow.className = 'settings-input-row';
        urlRow.style.marginBottom = 'var(--space-md)';
        const urlInput = document.createElement('input');
        urlInput.type = 'text';
        urlInput.className = 'settings-input';
        urlInput.placeholder = 'http://your-server:8080/v1';
        urlInput.value = entry.baseUrl || '';
        urlRow.appendChild(urlInput);
        body.appendChild(urlRow);

        const keyRow = document.createElement('div');
        keyRow.className = 'settings-input-row';
        const keyInput = document.createElement('input');
        keyInput.type = 'password';
        keyInput.className = 'settings-input';
        keyInput.placeholder = 'API key (optional)';
        window.electronLLM?.entryKeyStatus?.(entry.id).then((r) => {
            if (r?.hasKey) keyInput.placeholder = '•••••••• (saved)';
        }).catch(() => {});
        const detectBtn = document.createElement('button');
        detectBtn.type = 'button';
        detectBtn.className = 'secondary-btn';
        detectBtn.textContent = 'Auto-detect';
        detectBtn.title = 'Scan localhost for a running OpenAI-compatible server';
        const testBtn = document.createElement('button');
        testBtn.type = 'button';
        testBtn.className = 'secondary-btn';
        testBtn.textContent = 'Test';
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'secondary-btn';
        saveBtn.textContent = 'Save';
        keyRow.append(keyInput, detectBtn, testBtn, saveBtn);
        body.appendChild(keyRow);

        const status = document.createElement('p');
        status.className = 'settings-key-status';
        status.textContent = entry.baseUrl
            ? `Endpoint: ${entry.baseUrl}`
            : 'No server URL yet — enter one or use Auto-detect.';
        body.appendChild(status);

        const hint = document.createElement('p');
        hint.className = 'settings-hint';
        hint.innerHTML = 'The URL can be the base (<code>http://host:8080</code>), the <code>/v1</code> path, or the full <code>/v1/chat/completions</code>. An API key is only needed if your server requires one (e.g. <code>llama-server --api-key</code>) &mdash; it is stored encrypted, per model. App-action tools work only if the server supports OpenAI function-calling for the model.';
        body.appendChild(hint);

        detectBtn.addEventListener('click', async () => {
            status.textContent = 'Scanning localhost (8080, 1234, 8000…)…';
            const res = await window.electronLLM?.detectCustom?.();
            if (res?.found) {
                urlInput.value = res.baseUrl;
                if (res.model && !modelInput.value.trim()) modelInput.value = res.model;
                status.textContent = `Found a server at ${res.baseUrl}${res.model ? ` (serving: ${res.model})` : ''}. Click Save to use it.`;
                UIUtils.showToast('Server detected — review and Save', 'success');
            } else {
                status.textContent = 'No local OpenAI-compatible server found on common ports (8080, 1234, 8000, 5000, 8081).';
                UIUtils.showToast('No server found', 'error');
            }
        });

        testBtn.addEventListener('click', async () => {
            const baseUrl = urlInput.value.trim();
            if (!baseUrl) { status.textContent = 'Enter a server URL first.'; return; }
            status.textContent = 'Testing…';
            const cfg = { baseUrl, model: modelInput.value.trim() || entry.model || '', entryId: entry.id };
            const key = keyInput.value.trim();
            if (key) cfg.apiKey = key;
            const res = await window.electronLLM?.testCustom?.(cfg);
            if (res?.ok) {
                status.textContent = `✓ Connected${res.model ? ` (${res.model})` : ''}${res.reply ? ` — reply: "${res.reply}"` : ''}`;
                UIUtils.showToast('Server reachable', 'success');
            } else {
                status.textContent = `✗ ${res?.error || 'Connection failed'}`;
                UIUtils.showToast('Server test failed', 'error');
            }
        });

        saveBtn.addEventListener('click', async () => {
            const baseUrl = urlInput.value.trim();
            const model = modelInput.value.trim();
            if (!model) { UIUtils.showToast('Enter the model name on your server', 'error'); return; }
            // updateEntry persists via saveModelList, which write-throughs to
            // the legacy provider settings when this entry is the default.
            AgentService.updateEntry(entry.id, { model, baseUrl });
            const key = keyInput.value.trim();
            if (key) {
                const res = await window.electronLLM?.setEntryKey?.(entry.id, key);
                if (res && res.success === false) { UIUtils.showToast(res.error || 'Could not save the key', 'error'); return; }
                keyInput.value = '';
                keyInput.placeholder = '•••••••• (saved)';
            }
            status.textContent = baseUrl ? `Endpoint saved: ${baseUrl}` : 'No server URL yet — enter one or Auto-detect.';
            UIUtils.showToast('Server details saved', 'success');
            if (typeof AgentUI !== 'undefined') {
                AgentUI.updateModelChip?.();
                AgentUI.updateModelLabel?.();
            }
            this._renderModelLibrary();
        });
    },

    /**
     * Manage body for a cloud entry (OpenAI / Anthropic API): model id, the
     * per-entry API key (encrypted in main), live model listing with the
     * key, and a connection test. Mirrors _renderServerManage minus the URL —
     * the endpoint is fixed per provider.
     */
    _renderCloudManage(body, entry) {
        body.innerHTML = '';
        const label = entry.engine === 'openai' ? 'OpenAI' : 'Anthropic';
        const keysUrl = entry.engine === 'openai'
            ? 'https://platform.openai.com/api-keys'
            : 'https://console.anthropic.com/settings/keys';

        const desc = document.createElement('p');
        desc.className = 'settings-section-desc';
        desc.textContent = `${label}'s official API with your own key. Whatever runs on this model — chats, email insights, builds — is sent to ${label}'s servers under your account.`;
        body.appendChild(desc);

        const modelRow = document.createElement('div');
        modelRow.className = 'settings-input-row';
        modelRow.style.marginBottom = 'var(--space-md)';
        const modelInput = document.createElement('input');
        modelInput.type = 'text';
        modelInput.className = 'settings-input';
        modelInput.placeholder = entry.engine === 'openai' ? 'Model id, e.g. gpt-5.2' : 'Model id, e.g. claude-opus-4-8';
        modelInput.value = entry.model || '';
        const listBtn = document.createElement('button');
        listBtn.type = 'button';
        listBtn.className = 'secondary-btn';
        listBtn.textContent = 'List models';
        listBtn.title = `Fetch the models your ${label} key can use`;
        modelRow.append(modelInput, listBtn);
        body.appendChild(modelRow);

        const modelSel = document.createElement('select');
        modelSel.className = 'settings-select';
        modelSel.style.display = 'none';
        modelSel.style.marginBottom = 'var(--space-md)';
        modelSel.addEventListener('change', () => { if (modelSel.value) modelInput.value = modelSel.value; });
        body.appendChild(modelSel);

        const keyRow = document.createElement('div');
        keyRow.className = 'settings-input-row';
        const keyInput = document.createElement('input');
        keyInput.type = 'password';
        keyInput.className = 'settings-input';
        keyInput.placeholder = 'API key';
        window.electronLLM?.entryKeyStatus?.(entry.id).then((r) => {
            if (r?.hasKey) keyInput.placeholder = '•••••••• (saved)';
        }).catch(() => {});
        const testBtn = document.createElement('button');
        testBtn.type = 'button';
        testBtn.className = 'secondary-btn';
        testBtn.textContent = 'Test';
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'secondary-btn';
        saveBtn.textContent = 'Save';
        keyRow.append(keyInput, testBtn, saveBtn);
        body.appendChild(keyRow);

        const status = document.createElement('p');
        status.className = 'settings-key-status';
        body.appendChild(status);

        const hint = document.createElement('p');
        hint.className = 'settings-hint';
        hint.innerHTML = `The key is stored encrypted on this Mac, per model — it never syncs. Create or manage keys at <a href="#" class="settings-model-license">${keysUrl.replace('https://', '')}</a>. API usage is billed by ${label} to your account.`;
        hint.querySelector('a').addEventListener('click', (e) => {
            e.preventDefault();
            window.electronAuth?.openExternal?.(keysUrl);
        });
        body.appendChild(hint);

        listBtn.addEventListener('click', async () => {
            status.textContent = 'Fetching model list…';
            const res = await window.electronLLM?.cloudModels?.({
                engine: entry.engine, apiKey: keyInput.value.trim(), entryId: entry.id
            });
            if (res?.models?.length) {
                modelSel.innerHTML = '';
                const ph = document.createElement('option');
                ph.value = '';
                ph.textContent = `Pick from ${res.models.length} models…`;
                modelSel.appendChild(ph);
                for (const m of res.models) {
                    const opt = document.createElement('option');
                    opt.value = m.id;
                    opt.textContent = m.label && m.label !== m.id ? `${m.label} (${m.id})` : m.id;
                    modelSel.appendChild(opt);
                }
                modelSel.style.display = '';
                status.textContent = `Loaded ${res.models.length} models from ${label}.`;
            } else {
                status.textContent = `✗ ${res?.error || 'Could not list models'}`;
            }
        });

        testBtn.addEventListener('click', async () => {
            const model = modelInput.value.trim() || entry.model;
            status.textContent = 'Testing…';
            const res = await window.electronLLM?.testCloud?.({
                engine: entry.engine, model, apiKey: keyInput.value.trim(), entryId: entry.id
            });
            if (res?.ok) {
                status.textContent = `✓ Connected${res.model ? ` (${res.model})` : ''}${res.reply ? ` — reply: "${res.reply}"` : ''}`;
                UIUtils.showToast(`${label} reachable`, 'success');
            } else {
                status.textContent = `✗ ${res?.error || 'Connection failed'}`;
                UIUtils.showToast(`${label} test failed`, 'error');
            }
        });

        saveBtn.addEventListener('click', async () => {
            const model = modelInput.value.trim();
            if (!model) { UIUtils.showToast('Enter the model id', 'error'); return; }
            AgentService.updateEntry(entry.id, { model });
            const key = keyInput.value.trim();
            if (key) {
                const res = await window.electronLLM?.setEntryKey?.(entry.id, key);
                if (res && res.success === false) { UIUtils.showToast(res.error || 'Could not save the key', 'error'); return; }
                keyInput.value = '';
                keyInput.placeholder = '•••••••• (saved)';
            }
            status.textContent = 'Saved.';
            UIUtils.showToast(`${label} model saved`, 'success');
            if (typeof AgentUI !== 'undefined') {
                AgentUI.updateModelChip?.();
                AgentUI.updateModelLabel?.();
            }
            this._renderModelLibrary();
        });
    },

    // ── Downloads (engine install included) ──

    /**
     * Download an entry's model, installing the engine first when it's
     * missing: llama.cpp fetches its ~11 MB tarball; Ollama auto-installs
     * Ollama.app on macOS (elsewhere the error path points at
     * ollama.com/download). Progress paints inline on the entry's card,
     * keyed by entry id so re-renders pick it right back up.
     */
    async _startEntryDownload(entryId) {
        const entry = AgentService.getEntry(entryId);
        if (!entry || AgentService.isRemoteEngine(entry.engine)) return;
        if (this._activeDownloads.has(entryId)) return;
        const api = this._engineApiFor(entry.engine);
        if (!api) return;

        const setProgress = (text, percent) => {
            this._activeDownloads.set(entryId, { text, percent });
            this._paintCardProgress(entryId);
        };
        setProgress('Starting…', null);

        try {
            // 1. Engine present? Install inline when we can.
            let status = null;
            try { status = await api.status(); } catch { /* treat as missing */ }
            if (!status?.isInstalled) {
                const label = entry.engine === 'llamacpp' ? 'llama.cpp engine' : 'Ollama';
                setProgress(`Installing ${label}…`, null);
                const res = await api.install((p) => {
                    if (p.phase === 'download' && p.percent != null) setProgress(`Installing ${label}… ${p.percent}%`, null);
                    else if (p.message) setProgress(p.message, null);
                });
                if (res?.error) throw new Error(res.error);
            }
            // 2. Daemon running? (Ollama pulls need the daemon; llama-server
            //    spawns lazily on first chat and downloads without it.)
            if (entry.engine === 'ollama') {
                try { status = await api.status(); } catch { /* try start anyway */ }
                if (!status?.isReady) {
                    setProgress('Starting Ollama…', null);
                    const ok = await api.start();
                    if (!ok) throw new Error('Could not start Ollama');
                }
            }
            // 3. Pull, rAF-throttled so fast progress events can't flood layout.
            let latest = null;
            let rafPending = false;
            const flush = () => {
                rafPending = false;
                if (!latest) return;
                if (latest.percent !== null && latest.percent !== undefined) setProgress(`${latest.percent}%`, latest.percent);
                else setProgress(latest.status || 'Downloading…', null);
            };
            const result = await api.pullModel(entry.model, (progress) => {
                latest = progress;
                if (!rafPending) { rafPending = true; requestAnimationFrame(flush); }
            });
            if (result?.error) throw new Error(result.error);

            this._activeDownloads.delete(entryId);
            UIUtils.showToast(`${entry.model} downloaded`, 'success');
            const def = AgentService.getDefaultEntry();
            if (def && def.id === entryId) AgentService.warmOnIntent?.();
            await this._renderModelLibrary();
        } catch (e) {
            this._activeDownloads.delete(entryId);
            await this._handleEntryPullError(entry, e?.message || 'Download failed');
        }
    },

    /** Paint an in-flight download onto its card (found by entry id). */
    _paintCardProgress(entryId) {
        const card = document.querySelector(`.settings-model-card[data-entry-id="${CSS.escape(entryId)}"]`);
        if (!card) return;
        const p = this._activeDownloads.get(entryId);
        if (!p) return;
        card.dataset.state = 'downloading';
        const statusEl = card.querySelector('.settings-model-card-status');
        if (statusEl) {
            statusEl.textContent = p.text || 'Downloading…';
            statusEl.classList.add('is-downloading');
        }
        const btn = card.querySelector('.settings-model-card-download');
        if (btn) btn.remove();
        let strip = card.querySelector('.settings-model-progress');
        if (!strip) {
            strip = document.createElement('div');
            strip.className = 'settings-model-progress';
            strip.innerHTML = '<div class="settings-model-progress-fill"></div>';
            card.appendChild(strip);
        }
        const fill = strip.querySelector('.settings-model-progress-fill');
        if (fill && p.percent !== null && p.percent !== undefined) fill.style.width = p.percent + '%';
    },

    async _handleEntryPullError(entry, errorMsg) {
        const needsUpdate = errorMsg && (errorMsg.includes('newer version') || errorMsg.includes('412'));
        if (needsUpdate) {
            UIUtils.showToast('This model requires a newer version of Ollama. Update at ollama.com/download', 'error', 6000);
        } else {
            UIUtils.showToast('Download failed: ' + errorMsg, 'error', 6000);
        }
        // Re-render resets the card to its real state (Download reappears —
        // the entry stays in the list, so the user can just retry).
        await this._renderModelLibrary();
    },

    // ── Add-model flow (guided modal) ──
    //
    // A Modal.create wizard: pick an engine, then a catalog model / name /
    // server details. Incomplete state lives entirely inside the modal, so a
    // half-finished add can never persist a blank entry.

    _openAddModelModal() {
        const body = document.createElement('div');
        body.className = 'settings-add-model';
        const modal = Modal.create({ title: 'Add a model', content: body, className: 'settings-add-model-modal modal-wide' });
        this._renderAddEngineStep(body, modal);
    },

    _renderAddEngineStep(body, modal) {
        body.innerHTML = '';
        const intro = document.createElement('p');
        intro.className = 'settings-section-desc';
        intro.textContent = 'Where should this model run?';
        body.appendChild(intro);

        const llamaInstalled = !!this._engines?.llamacpp?.status?.isInstalled;
        const ollamaInstalled = !!this._engines?.ollama?.status?.isInstalled;
        const options = [
            {
                engine: 'llamacpp',
                name: 'llama.cpp',
                hint: 'The built-in engine — runs models on this Mac.'
                    + (llamaInstalled ? '' : ' The engine installs automatically (~11 MB).')
            },
            {
                engine: 'ollama',
                name: 'Ollama',
                hint: 'Local engine with the full ollama.com model registry.'
                    + (ollamaInstalled ? '' : ' Not installed yet — it installs automatically with your first model download.')
            },
            {
                engine: 'server',
                name: 'Your server',
                hint: 'An OpenAI-compatible endpoint (llama-server, vLLM, LM Studio) on a computer you own.'
            },
            {
                engine: 'openai',
                name: 'OpenAI API',
                hint: 'GPT models from OpenAI with your own API key. What runs on this model is sent to OpenAI.'
            },
            {
                engine: 'anthropic',
                name: 'Anthropic API',
                hint: 'Claude models from Anthropic with your own API key. What runs on this model is sent to Anthropic.'
            }
        ];
        const list = document.createElement('div');
        list.className = 'settings-add-model-engines';
        for (const opt of options) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'settings-add-model-engine';
            const name = document.createElement('span');
            name.className = 'settings-add-model-engine-name';
            name.textContent = opt.name;
            const hint = document.createElement('span');
            hint.className = 'settings-add-model-engine-hint';
            hint.textContent = opt.hint;
            btn.append(name, hint);
            btn.addEventListener('click', () => {
                if (opt.engine === 'server') this._renderAddServerStep(body, modal);
                else if (opt.engine === 'openai' || opt.engine === 'anthropic') this._renderAddCloudStep(body, modal, opt.engine);
                else this._renderAddLocalStep(body, modal, opt.engine);
            });
            list.appendChild(btn);
        }
        body.appendChild(list);
    },

    _addModalBackLink(body, modal) {
        const back = document.createElement('a');
        back.href = '#';
        back.className = 'settings-add-model-back';
        back.textContent = '‹ Back';
        back.addEventListener('click', (e) => {
            e.preventDefault();
            this._renderAddEngineStep(body, modal);
        });
        return back;
    },

    /** Finish an add: create the entry, close, render, start the download. */
    async _finishAddModel(modal, { engine, model, baseUrl, key }) {
        const before = AgentService.getModelList().length;
        const entry = AgentService.addEntry({ engine, model, baseUrl });
        if (!entry) { UIUtils.showToast('Enter a model name first', 'error'); return; }
        const isNew = AgentService.getModelList().length > before;
        if (!isNew) UIUtils.showToast(`${entry.model} is already in your list`, 'info');
        if (key && AgentService.isRemoteEngine(engine)) {
            const res = await window.electronLLM?.setEntryKey?.(entry.id, key);
            if (res && res.success === false) UIUtils.showToast(res.error || 'Could not save the key', 'error');
        }
        modal.close();
        if (typeof AgentUI !== 'undefined') {
            AgentUI.updateModelChip?.();
            AgentUI.updateModelLabel?.();
        }
        await this._renderModelLibrary();
        if (isNew && !AgentService.isRemoteEngine(engine)) {
            const eng = this._engines && this._engines[engine];
            if (!eng?.installed?.has(entry.model)) {
                const cat = this._catalogFor(entry);
                // llama.cpp models without a GGUF source can't be downloaded —
                // the card shows the drop-in hint instead.
                if (engine !== 'llamacpp' || (cat && cat.gguf)) this._startEntryDownload(entry.id);
            }
        }
    },

    _renderAddLocalStep(body, modal, engine) {
        body.innerHTML = '';
        body.appendChild(this._addModalBackLink(body, modal));

        const eng = this._engines && this._engines[engine];
        const installedSet = eng?.installed || new Set();
        const totalRam = this._engines?.totalMemGB || 8;
        const catalog = (this._engines?.catalog || [])
            .filter(m => (m.minRam || 0) <= totalRam)
            .filter(m => engine !== 'llamacpp' || m.gguf);
        const inList = new Set(AgentService.getModelList()
            .filter(e => e.engine === engine).map(e => e.model));

        const desc = document.createElement('p');
        desc.className = 'settings-section-desc';
        desc.textContent = `Models recommended for your Mac (${totalRam} GB RAM), running on ${this._engineLabel(engine)}.`;
        body.appendChild(desc);

        let selectedName = null;
        let addBtn = null;
        const list = document.createElement('div');
        list.className = 'settings-model-list settings-add-model-list';

        // Catalog rows + any installed models the catalog doesn't know
        // (GGUF drop-ins, custom pulls) so they can become entries too.
        const catalogNames = new Set(catalog.map(m => m.name));
        const extras = [...installedSet].filter(n => !catalogNames.has(n)).map(name => ({
            name,
            desc: engine === 'llamacpp' ? 'GGUF file in ~/.anjadhe_llamacpp/models' : 'Installed model',
            size: ''
        }));
        for (const m of [...catalog, ...extras]) {
            const item = document.createElement('div');
            item.className = 'settings-model-item ' + (installedSet.has(m.name) ? 'installed' : 'not-installed');
            const radio = document.createElement('span');
            radio.className = 'settings-model-radio';
            const info = document.createElement('div');
            info.className = 'settings-model-info';
            const nameEl = document.createElement('span');
            nameEl.className = 'settings-model-name';
            nameEl.textContent = m.name;
            const descEl = document.createElement('span');
            descEl.className = 'settings-model-desc';
            descEl.textContent = m.desc || '';
            info.append(nameEl, descEl);
            if (m.license) {
                const lic = document.createElement('a');
                lic.href = '#';
                lic.className = 'settings-model-license';
                lic.textContent = m.license;
                lic.title = 'View license';
                lic.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (m.licenseUrl) window.electronAuth?.openExternal?.(m.licenseUrl);
                });
                info.appendChild(lic);
            }
            const statusEl = document.createElement('span');
            statusEl.className = 'settings-model-status';
            statusEl.textContent = inList.has(m.name) ? 'In your list'
                : installedSet.has(m.name) ? 'Downloaded' : (m.size || '');
            item.append(radio, info, statusEl);
            item.addEventListener('click', () => {
                list.querySelectorAll('.settings-model-item.active').forEach(el => el.classList.remove('active'));
                item.classList.add('active');
                selectedName = m.name;
                if (addBtn) addBtn.disabled = false;
            });
            list.appendChild(item);
        }
        if (!catalog.length && !extras.length) {
            const none = document.createElement('p');
            none.className = 'settings-hint';
            none.textContent = 'No recommended models for this engine yet.';
            list.appendChild(none);
        }
        body.appendChild(list);

        // Ollama: any registry model by name. llama.cpp: GGUF drop-in hint.
        let nameInput = null;
        if (engine === 'ollama') {
            const row = document.createElement('div');
            row.className = 'settings-input-row';
            row.style.marginTop = 'var(--space-md)';
            nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = 'settings-input';
            nameInput.placeholder = 'Or any model from ollama.com/library, e.g. llama3.2:3b';
            nameInput.addEventListener('input', () => {
                if (nameInput.value.trim()) {
                    list.querySelectorAll('.settings-model-item.active').forEach(el => el.classList.remove('active'));
                    selectedName = null;
                }
                if (addBtn) addBtn.disabled = !(selectedName || nameInput.value.trim());
            });
            row.appendChild(nameInput);
            body.appendChild(row);
        } else {
            const hint = document.createElement('p');
            hint.className = 'settings-hint';
            hint.innerHTML = 'To use a model that isn&rsquo;t listed, drop any <code>.gguf</code> file into <code>~/.anjadhe_llamacpp/models</code> and re-open this dialog.';
            body.appendChild(hint);
        }

        const license = document.createElement('p');
        license.className = 'settings-hint';
        license.textContent = 'Each model is provided under its own license (shown above). Downloading a model means accepting its terms.';
        body.appendChild(license);

        const footer = document.createElement('div');
        footer.className = 'settings-input-row settings-add-model-footer';
        addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'primary-btn';
        addBtn.textContent = 'Add model';
        addBtn.disabled = true;
        addBtn.addEventListener('click', () => {
            const model = selectedName || (nameInput && nameInput.value.trim());
            if (!model) return;
            this._finishAddModel(modal, { engine, model });
        });
        footer.appendChild(addBtn);
        body.appendChild(footer);
    },

    _renderAddServerStep(body, modal) {
        body.innerHTML = '';
        body.appendChild(this._addModalBackLink(body, modal));

        const desc = document.createElement('p');
        desc.className = 'settings-section-desc';
        desc.innerHTML = 'Any endpoint that speaks the OpenAI <code>/v1/chat/completions</code> API on a computer you own. Auto-detect finds one running on this Mac.';
        body.appendChild(desc);

        const urlRow = document.createElement('div');
        urlRow.className = 'settings-input-row';
        urlRow.style.marginBottom = 'var(--space-md)';
        const urlInput = document.createElement('input');
        urlInput.type = 'text';
        urlInput.className = 'settings-input';
        urlInput.placeholder = 'http://your-server:8080/v1';
        urlRow.appendChild(urlInput);
        body.appendChild(urlRow);

        const modelRow = document.createElement('div');
        modelRow.className = 'settings-input-row';
        modelRow.style.marginBottom = 'var(--space-md)';
        const modelInput = document.createElement('input');
        modelInput.type = 'text';
        modelInput.className = 'settings-input';
        modelInput.placeholder = 'Model name on the server, e.g. qwen3.6:35b';
        modelRow.appendChild(modelInput);
        body.appendChild(modelRow);

        const keyRow = document.createElement('div');
        keyRow.className = 'settings-input-row';
        const keyInput = document.createElement('input');
        keyInput.type = 'password';
        keyInput.className = 'settings-input';
        keyInput.placeholder = 'API key (optional)';
        const detectBtn = document.createElement('button');
        detectBtn.type = 'button';
        detectBtn.className = 'secondary-btn';
        detectBtn.textContent = 'Auto-detect';
        const testBtn = document.createElement('button');
        testBtn.type = 'button';
        testBtn.className = 'secondary-btn';
        testBtn.textContent = 'Test';
        keyRow.append(keyInput, detectBtn, testBtn);
        body.appendChild(keyRow);

        const status = document.createElement('p');
        status.className = 'settings-key-status';
        body.appendChild(status);

        detectBtn.addEventListener('click', async () => {
            status.textContent = 'Scanning localhost (8080, 1234, 8000…)…';
            const res = await window.electronLLM?.detectCustom?.();
            if (res?.found) {
                urlInput.value = res.baseUrl;
                if (res.model && !modelInput.value.trim()) modelInput.value = res.model;
                status.textContent = `Found a server at ${res.baseUrl}${res.model ? ` (serving: ${res.model})` : ''}.`;
            } else {
                status.textContent = 'No local OpenAI-compatible server found on common ports (8080, 1234, 8000, 5000, 8081).';
            }
        });
        testBtn.addEventListener('click', async () => {
            const baseUrl = urlInput.value.trim();
            if (!baseUrl) { status.textContent = 'Enter a server URL first.'; return; }
            status.textContent = 'Testing…';
            const cfg = { baseUrl, model: modelInput.value.trim() };
            const key = keyInput.value.trim();
            if (key) cfg.apiKey = key;
            const res = await window.electronLLM?.testCustom?.(cfg);
            status.textContent = res?.ok
                ? `✓ Connected${res.model ? ` (${res.model})` : ''}`
                : `✗ ${res?.error || 'Connection failed'}`;
        });

        const footer = document.createElement('div');
        footer.className = 'settings-input-row settings-add-model-footer';
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'primary-btn';
        addBtn.textContent = 'Add model';
        addBtn.addEventListener('click', () => {
            const baseUrl = urlInput.value.trim();
            const model = modelInput.value.trim();
            if (!baseUrl || !model) {
                UIUtils.showToast('Enter the server URL and model name', 'error');
                return;
            }
            this._finishAddModel(modal, { engine: 'server', model, baseUrl, key: keyInput.value.trim() });
        });
        footer.appendChild(addBtn);
        body.appendChild(footer);
    },

    /**
     * Add-model step for a cloud provider (OpenAI / Anthropic API): paste a
     * key, list the models the key can use live (no hardcoded catalog to
     * rot), pick one or type an id, optional test, add. The key is saved
     * onto the new entry (encrypted in main) by _finishAddModel.
     */
    _renderAddCloudStep(body, modal, engine) {
        body.innerHTML = '';
        body.appendChild(this._addModalBackLink(body, modal));
        const label = engine === 'openai' ? 'OpenAI' : 'Anthropic';
        const keysUrl = engine === 'openai'
            ? 'https://platform.openai.com/api-keys'
            : 'https://console.anthropic.com/settings/keys';

        const desc = document.createElement('p');
        desc.className = 'settings-section-desc';
        desc.textContent = `${label}'s official API with your own key. Anything that runs on this model — chats, email insights, builds — is sent to ${label}'s servers under your account, and API usage is billed by ${label}.`;
        body.appendChild(desc);

        const keyRow = document.createElement('div');
        keyRow.className = 'settings-input-row';
        keyRow.style.marginBottom = 'var(--space-md)';
        const keyInput = document.createElement('input');
        keyInput.type = 'password';
        keyInput.className = 'settings-input';
        keyInput.placeholder = `${label} API key`;
        const loadBtn = document.createElement('button');
        loadBtn.type = 'button';
        loadBtn.className = 'secondary-btn';
        loadBtn.textContent = 'List models';
        keyRow.append(keyInput, loadBtn);
        body.appendChild(keyRow);

        let selectedId = null;
        let addBtn = null;
        let testBtn = null;
        const list = document.createElement('div');
        list.className = 'settings-model-list settings-add-model-list';
        body.appendChild(list);

        const modelRow = document.createElement('div');
        modelRow.className = 'settings-input-row';
        modelRow.style.marginTop = 'var(--space-md)';
        const modelInput = document.createElement('input');
        modelInput.type = 'text';
        modelInput.className = 'settings-input';
        modelInput.placeholder = engine === 'openai'
            ? 'Or type a model id, e.g. gpt-5.2'
            : 'Or type a model id, e.g. claude-opus-4-8';
        modelInput.addEventListener('input', () => {
            if (modelInput.value.trim()) {
                list.querySelectorAll('.settings-model-item.active').forEach(el => el.classList.remove('active'));
                selectedId = null;
            }
            const has = !!(selectedId || modelInput.value.trim());
            if (addBtn) addBtn.disabled = !has;
            if (testBtn) testBtn.disabled = !has;
        });
        modelRow.appendChild(modelInput);
        body.appendChild(modelRow);

        const status = document.createElement('p');
        status.className = 'settings-key-status';
        body.appendChild(status);

        const hint = document.createElement('p');
        hint.className = 'settings-hint';
        hint.innerHTML = `The key is stored encrypted on this Mac, per model — it never syncs. Create a key at <a href="#" class="settings-model-license">${keysUrl.replace('https://', '')}</a>.`;
        hint.querySelector('a').addEventListener('click', (e) => {
            e.preventDefault();
            window.electronAuth?.openExternal?.(keysUrl);
        });
        body.appendChild(hint);

        loadBtn.addEventListener('click', async () => {
            const apiKey = keyInput.value.trim();
            if (!apiKey) { status.textContent = 'Paste your API key first.'; return; }
            status.textContent = `Fetching models from ${label}…`;
            const res = await window.electronLLM?.cloudModels?.({ engine, apiKey });
            list.innerHTML = '';
            if (!res?.models?.length) {
                status.textContent = `✗ ${res?.error || 'Could not list models'}`;
                return;
            }
            status.textContent = `Your key can use ${res.models.length} models — pick one.`;
            for (const m of res.models) {
                const item = document.createElement('div');
                item.className = 'settings-model-item';
                const radio = document.createElement('span');
                radio.className = 'settings-model-radio';
                const info = document.createElement('div');
                info.className = 'settings-model-info';
                const nameEl = document.createElement('span');
                nameEl.className = 'settings-model-name';
                nameEl.textContent = m.label && m.label !== m.id ? m.label : m.id;
                info.appendChild(nameEl);
                if (m.label && m.label !== m.id) {
                    const descEl = document.createElement('span');
                    descEl.className = 'settings-model-desc';
                    descEl.textContent = m.id;
                    info.appendChild(descEl);
                }
                item.append(radio, info);
                item.addEventListener('click', () => {
                    list.querySelectorAll('.settings-model-item.active').forEach(el => el.classList.remove('active'));
                    item.classList.add('active');
                    selectedId = m.id;
                    modelInput.value = '';
                    if (addBtn) addBtn.disabled = false;
                    if (testBtn) testBtn.disabled = false;
                });
                list.appendChild(item);
            }
        });

        const footer = document.createElement('div');
        footer.className = 'settings-input-row settings-add-model-footer';
        testBtn = document.createElement('button');
        testBtn.type = 'button';
        testBtn.className = 'secondary-btn';
        testBtn.textContent = 'Test';
        testBtn.disabled = true;
        testBtn.addEventListener('click', async () => {
            const model = selectedId || modelInput.value.trim();
            const apiKey = keyInput.value.trim();
            if (!apiKey) { status.textContent = 'Paste your API key first.'; return; }
            status.textContent = 'Testing…';
            const res = await window.electronLLM?.testCloud?.({ engine, model, apiKey });
            status.textContent = res?.ok
                ? `✓ Connected${res.model ? ` (${res.model})` : ''}`
                : `✗ ${res?.error || 'Connection failed'}`;
        });
        addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'primary-btn';
        addBtn.textContent = 'Add model';
        addBtn.disabled = true;
        addBtn.addEventListener('click', () => {
            const model = selectedId || modelInput.value.trim();
            const key = keyInput.value.trim();
            if (!model) { UIUtils.showToast('Pick or type a model id', 'error'); return; }
            if (!key) { UIUtils.showToast(`Paste your ${label} API key`, 'error'); return; }
            this._finishAddModel(modal, { engine, model, key });
        });
        footer.append(testBtn, addBtn);
        body.appendChild(footer);
    },

    // ── Library status watch ──
    //
    // A light polling loop that keeps the status texts honest (warming →
    // ready, llama-server loading a model, Ollama started outside the app).
    // Text-only repaints; a structural change (e.g. a model appeared on
    // disk) triggers one full re-render — skipped while the user is typing
    // in a card, so it can't eat their input.

    _startLibraryWatch() {
        this._stopLibraryWatch();
        const tick = async () => {
            const view = document.getElementById('llm-settings-view');
            if (!view || !view.classList.contains('active')) { this._stopLibraryWatch(); return; }
            try {
                await this._refreshEngineState();
                this._refreshCardStatuses();
            } catch { /* next tick */ }
            const busy = (typeof AgentService !== 'undefined' && AgentService._warming) || this._activeDownloads.size > 0;
            this._libraryWatchTimer = setTimeout(tick, busy ? 2500 : 8000);
        };
        this._libraryWatchTimer = setTimeout(tick, 2500);
    },

    _stopLibraryWatch() {
        if (this._libraryWatchTimer) clearTimeout(this._libraryWatchTimer);
        this._libraryWatchTimer = null;
    },

    _refreshCardStatuses() {
        this._renderDefaultCard();
        const cardsHost = document.getElementById('settings-model-cards');
        if (!cardsHost) return;
        const typing = cardsHost.contains(document.activeElement)
            && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName || '');
        let structuralChange = false;
        cardsHost.querySelectorAll('.settings-model-card').forEach(card => {
            const entry = AgentService.getEntry(card.dataset.entryId);
            if (!entry) { structuralChange = true; return; }
            if (this._activeDownloads.has(entry.id)) return; // download owns the card
            const st = this._computeEntryStatus(entry);
            if (st.state !== card.dataset.state) { structuralChange = true; return; }
            const statusEl = card.querySelector('.settings-model-card-status');
            if (statusEl && statusEl.textContent !== st.text) statusEl.textContent = st.text;
        });
        if (structuralChange && !typing) this._renderModelLibrary();
    },

    // ─────────────────── Web-search provider cards ───────────────────
    //
    // Same library pattern as the models: one card per provider (the
    // registry is fixed in main.js — no add flow), a radio for the active
    // one, and a per-card Manage body holding the API key + Save/Test and
    // the signup link. All controls are closures over the provider id.

    _openSearchManageId: null,

    // Renderer-side extras for each provider; labels + key state come from
    // main (search-get-status), which owns the registry.
    _searchProviderMeta: {
        // signupText is honest-copy per provider: Tavily's free plan needs no
        // card; Brave requires one and bills past its monthly credit.
        tavily: { placeholder: 'tvly-...', signupUrl: 'https://tavily.com/', signupLabel: 'tavily.com', signupText: 'Get a free key (no credit card) at ' },
        brave: { placeholder: 'BSA...', signupUrl: 'https://api.search.brave.com/app/keys', signupLabel: 'api.search.brave.com', signupText: 'Get a key (credit card required) at ' }
    },

    async _renderSearchProviders() {
        const host = document.getElementById('settings-search-providers');
        if (!host || !window.electronSearch) return;
        let status = null;
        try { status = await window.electronSearch.getStatus(); } catch { return; }
        host.innerHTML = '';
        for (const id of Object.keys(status.providers || {})) {
            host.appendChild(this._buildSearchProviderCard(id, status.providers[id], id === status.provider));
        }
    },

    _buildSearchProviderCard(id, info, isActive) {
        const card = document.createElement('div');
        card.className = 'settings-model-card' + (isActive ? ' is-default' : '');

        const header = document.createElement('div');
        header.className = 'settings-model-card-header';

        const radioWrap = document.createElement('label');
        radioWrap.className = 'settings-model-card-default';
        radioWrap.title = 'Send web searches to this provider';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'settings-search-provider-active';
        radio.checked = !!isActive;
        radio.addEventListener('change', async () => {
            if (!radio.checked) return;
            await window.electronSearch.setProvider(id);
            UIUtils.showToast(`Search provider: ${info.label}`, 'success');
            this._renderSearchProviders();
        });
        radioWrap.appendChild(radio);

        const infoWrap = document.createElement('div');
        infoWrap.className = 'settings-model-card-info';
        const name = document.createElement('span');
        name.className = 'settings-model-card-name';
        name.textContent = info.label;
        infoWrap.appendChild(name);

        const statusWrap = document.createElement('div');
        statusWrap.className = 'settings-model-card-statuswrap';
        const statusEl = document.createElement('span');
        statusEl.className = 'settings-model-card-status';
        statusEl.textContent = info.hasKey ? 'API key saved' : 'No API key yet';
        statusWrap.appendChild(statusEl);

        const manage = document.createElement('button');
        manage.type = 'button';
        manage.className = 'settings-model-card-manage';
        manage.textContent = 'Manage';
        manage.title = 'API key, connection test';
        manage.addEventListener('click', () => {
            const body = card.querySelector('.settings-model-card-body');
            const isOpen = body.style.display !== 'none';
            const host = document.getElementById('settings-search-providers');
            host.querySelectorAll('.settings-model-card-body').forEach(b => { b.style.display = 'none'; });
            host.querySelectorAll('.settings-model-card-manage.open').forEach(b => b.classList.remove('open'));
            this._openSearchManageId = null;
            if (isOpen) return;
            this._openSearchManageId = id;
            manage.classList.add('open');
            body.style.display = '';
            this._renderSearchProviderManage(body, id, info, statusEl);
        });

        header.append(radioWrap, infoWrap, statusWrap, manage);
        card.appendChild(header);

        const body = document.createElement('div');
        body.className = 'settings-model-card-body';
        body.style.display = 'none';
        card.appendChild(body);

        if (this._openSearchManageId === id) {
            manage.classList.add('open');
            body.style.display = '';
            this._renderSearchProviderManage(body, id, info, statusEl);
        }
        return card;
    },

    _renderSearchProviderManage(body, id, info, cardStatusEl) {
        body.innerHTML = '';
        const meta = this._searchProviderMeta[id] || {};

        const keyRow = document.createElement('div');
        keyRow.className = 'settings-input-row';
        const keyInput = document.createElement('input');
        keyInput.type = 'password';
        keyInput.className = 'settings-input';
        keyInput.placeholder = info.hasKey ? '••••••••••••••••' : (meta.placeholder || 'API key');
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'secondary-btn';
        saveBtn.textContent = 'Save Key';
        const testBtn = document.createElement('button');
        testBtn.type = 'button';
        testBtn.className = 'secondary-btn';
        testBtn.textContent = 'Test';
        keyRow.append(keyInput, saveBtn, testBtn);
        body.appendChild(keyRow);

        const status = document.createElement('p');
        status.className = 'settings-key-status';
        status.textContent = info.hasKey ? 'API key saved' : 'No API key configured';
        body.appendChild(status);

        if (meta.signupUrl) {
            const hint = document.createElement('p');
            hint.className = 'settings-hint';
            hint.textContent = meta.signupText || 'Get a key at ';
            const link = document.createElement('a');
            link.href = '#';
            link.style.color = 'var(--color-text-secondary)';
            link.textContent = meta.signupLabel || meta.signupUrl;
            link.addEventListener('click', (e) => {
                e.preventDefault();
                window.electronAuth.openExternal(meta.signupUrl);
            });
            hint.appendChild(link);
            hint.appendChild(document.createTextNode('.'));
            body.appendChild(hint);
        }

        saveBtn.addEventListener('click', async () => {
            const key = keyInput.value.trim();
            await window.electronSearch.setApiKey(id, key);
            info.hasKey = !!key;
            if (key) {
                keyInput.value = '';
                keyInput.placeholder = '••••••••••••••••';
                status.textContent = 'API key saved';
                UIUtils.showToast(`${info.label} API key saved`, 'success');
            } else {
                // An empty save deliberately removes the stored key.
                keyInput.placeholder = meta.placeholder || 'API key';
                status.textContent = 'API key removed';
            }
            cardStatusEl.textContent = info.hasKey ? 'API key saved' : 'No API key yet';
        });

        testBtn.addEventListener('click', async () => {
            status.textContent = 'Testing…';
            const res = await window.electronSearch.test?.(id);
            if (res?.ok) {
                status.textContent = `✓ Connected — ${info.label} answered a test query`;
                UIUtils.showToast(`${info.label} reachable`, 'success');
            } else {
                status.textContent = `✗ ${res?.error || 'Test failed'}`;
                UIUtils.showToast('Search test failed', 'error');
            }
        });
    },

    // Keep the three summary badges on the AI Assistant page in sync without
    // building the full lists. Each renderer also updates its own badge when
    // invoked from inside its sub-view.
    _refreshAssistantBadges() {
        const logsBadge = document.getElementById('settings-logs-count');
        if (logsBadge) logsBadge.textContent = (LLMLogger.logs?.length || 0);
        const searchBadge = document.getElementById('settings-search-logs-count');
        if (searchBadge && typeof SearchLogger !== 'undefined') {
            searchBadge.textContent = (SearchLogger.logs?.length || 0);
        }
        const memBadge = document.getElementById('settings-memories-count');
        if (memBadge && typeof MemoryManager !== 'undefined' && MemoryManager.listSections) {
            try { memBadge.textContent = MemoryManager.listSections().filter(s => (s.body || '').trim()).length; } catch {}
        }
    },

    async openMemoriesSettings() {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('memories-settings-view').classList.add('active');
        Breadcrumb.render('memories-settings-breadcrumb', [
            { label: 'Settings', action: () => { document.getElementById('memories-settings-view').classList.remove('active'); document.getElementById('settings-view').classList.add('active'); this._loadLLMSummary(); } },
            { label: 'AI Assistant', action: () => this.openLLMSettings() },
            { label: 'Memories' }
        ]);
        this._ensureLlmBindings();
        this._renderMemories();
    },

    async openLlmLogs() {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('llm-logs-view').classList.add('active');
        Breadcrumb.render('llm-logs-breadcrumb', [
            { label: 'Settings', action: () => { document.getElementById('llm-logs-view').classList.remove('active'); document.getElementById('settings-view').classList.add('active'); this._loadLLMSummary(); } },
            { label: 'AI Assistant', action: () => this.openLLMSettings() },
            { label: 'LLM Logs' }
        ]);
        this._ensureLlmBindings();
        this.renderLogs();
    },

    async openSearchLogs() {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('search-logs-view').classList.add('active');
        Breadcrumb.render('search-logs-breadcrumb', [
            { label: 'Settings', action: () => { document.getElementById('search-logs-view').classList.remove('active'); document.getElementById('settings-view').classList.add('active'); this._loadLLMSummary(); } },
            { label: 'AI Assistant', action: () => this.openLLMSettings() },
            { label: 'Web Search Logs' }
        ]);
        this._ensureLlmBindings();
        this.renderSearchLogs();
    },

    async openNetworkLogs() {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('network-logs-view').classList.add('active');
        Breadcrumb.render('network-logs-breadcrumb', [
            { label: 'Settings', action: () => { document.getElementById('network-logs-view').classList.remove('active'); document.getElementById('settings-view').classList.add('active'); this.render(); } },
            { label: 'Network Logs' }
        ]);
        this.renderNetworkLogs();
    },

    // One-time event wiring for every control inside the two split sub-views.
    // Kept as a single block because many controls historically lived together;
    // splitting them by view adds only friction — the IDs are unique globally
    // regardless of which sub-view they landed in after the split.
    _attachLlmBindings() {
        // Model library: the guided add-model wizard. Everything else on a
        // card (Manage, downloads, default radio) binds per-card at render
        // time — no global ids.
        this._bindBtn('settings-add-model-btn', () => this._openAddModelModal());

        // Web-search provider cards bind per-card at render time
        // (_renderSearchProviders) — no global ids here.

        // LLM Logs
        this._bindBtn('settings-logs-refresh-btn', () => this.renderLogs());
        this._bindBtn('settings-logs-clear-btn', () => {
            LLMLogger.clear();
            this.renderLogs();
            UIUtils.showToast('LLM logs cleared', 'success');
        });

        // Web Search Logs
        this._bindBtn('settings-search-logs-refresh-btn', () => this.renderSearchLogs());
        this._bindBtn('settings-search-logs-clear-btn', () => {
            SearchLogger.clear();
            this.renderSearchLogs();
            UIUtils.showToast('Search logs cleared', 'success');
        });

        // Memories
        this._bindMemoryEvents();
    },

    // Engine status (running / installed / not installed) with the inline
    // Start/Install action, rendered INTO the given host element — one per
    // open Manage body, no global ids. Unlike Ollama, llama.cpp has no
    // daemon to "start": llama-server spawns lazily on the first chat, so
    // installed-but-idle is a healthy state, not a problem to fix.
    async _renderEngineStatusInto(host, engine) {
        host.innerHTML = '';
        const line = document.createElement('div');
        line.className = 'settings-ollama-status';
        const extra = document.createElement('div');
        extra.className = 'settings-ollama-version';
        host.append(line, extra);
        const dot = (active) => `<span class="ollama-status-dot${active ? ' active' : ''}"></span> `;
        const hint = (text) => { extra.innerHTML = `<span class="settings-hint">${UIUtils.escapeHtml(text)}</span>`; };
        try {
            if (engine === 'llamacpp') {
                const status = await window.electronLlamaCpp?.status?.();
                if (!status) return;
                if (status.isReady) {
                    line.innerHTML = dot(true) + `llama.cpp running on port ${status.port}${status.loadedModel ? ` (${UIUtils.escapeHtml(status.loadedModel)})` : ''}`;
                    if (status.version) hint(`llama.cpp build ${status.version}`);
                } else if (status.isInstalled) {
                    line.innerHTML = dot(false) + 'llama.cpp installed — the model loads on your first chat';
                    if (status.version) hint(`llama.cpp build ${status.version}`);
                } else {
                    line.innerHTML = dot(false) + 'llama.cpp engine not installed ';
                    const installBtn = document.createElement('button');
                    installBtn.type = 'button';
                    installBtn.className = 'secondary-btn ollama-start-btn';
                    installBtn.textContent = 'Install engine (~11 MB)';
                    installBtn.addEventListener('click', async () => {
                        installBtn.disabled = true;
                        installBtn.textContent = 'Installing…';
                        try {
                            const result = await window.electronLlamaCpp.install((p) => {
                                if (p.phase === 'download' && p.percent != null) installBtn.textContent = `Downloading… ${p.percent}%`;
                                else if (p.message) installBtn.textContent = p.message;
                            });
                            if (result?.error) throw new Error(result.error);
                            UIUtils.showToast('llama.cpp engine installed', 'success');
                            await this._renderModelLibrary();
                        } catch (e) {
                            installBtn.disabled = false;
                            installBtn.textContent = 'Install engine (~11 MB)';
                            UIUtils.showToast(e.message || 'Engine install failed', 'error');
                        }
                    });
                    line.appendChild(installBtn);
                }
                return;
            }
            const status = await window.electronOllama?.status?.();
            if (!status) return;
            if (status.isReady) {
                line.innerHTML = dot(true) + `Ollama running on port ${status.port}`;
                if (status.version) hint(`Version ${status.version}`);
            } else if (status.isInstalled) {
                line.innerHTML = dot(false) + 'Ollama installed but not running ';
                const startBtn = document.createElement('button');
                startBtn.type = 'button';
                startBtn.className = 'secondary-btn ollama-start-btn';
                startBtn.textContent = 'Start';
                startBtn.addEventListener('click', async () => {
                    startBtn.disabled = true;
                    startBtn.textContent = 'Starting...';
                    const started = await window.electronOllama.start();
                    if (started) {
                        UIUtils.showToast('Ollama started', 'success');
                        await this._renderModelLibrary();
                    } else {
                        startBtn.textContent = 'Failed';
                        UIUtils.showToast('Could not start Ollama', 'error');
                    }
                });
                line.appendChild(startBtn);
            } else {
                line.innerHTML = dot(false) + 'Ollama not installed — it installs automatically when you download a model, or get it from ';
                const linkBtn = document.createElement('button');
                linkBtn.type = 'button';
                linkBtn.className = 'secondary-btn ollama-start-btn';
                linkBtn.textContent = 'ollama.com/download';
                linkBtn.addEventListener('click', () => window.electronAuth.openExternal('https://ollama.com/download'));
                line.appendChild(linkBtn);
            }
        } catch { /* engine bridge unavailable */ }
    },

    // ── Memories ──

    _bindMemoryEvents() {
        this._bindBtn('settings-memory-edit-btn', () => this._editMemoryProfile());
        this._bindBtn('settings-memory-cleanup-btn', () => this._cleanupMemories());
    },

    // Jump to the Assistant page and open the editable memory profile panel.
    _editMemoryProfile() {
        try {
            if (typeof AppManager !== 'undefined' && AppManager.openApp) AppManager.openApp('agent');
            setTimeout(() => {
                if (typeof AgentUI !== 'undefined' && AgentUI.openProfilePanel) AgentUI.openProfilePanel();
            }, 150);
        } catch (e) {
            console.warn('[memory] open profile editor failed:', e);
        }
    },

    // Manual trigger for the consolidation pass that also runs daily on startup
    // (AgentService.consolidateMemories). Unlike the daily run, the button uses
    // `full: true` — it processes the ENTIRE store (looping passes until it
    // converges), so one click cleans everything rather than a bounded slice.
    async _cleanupMemories() {
        const btn = document.getElementById('settings-memory-cleanup-btn');
        if (typeof AgentService === 'undefined' || typeof AgentService.consolidateMemories !== 'function') {
            UIUtils.showToast('Rebuild unavailable', 'error');
            return;
        }
        if (typeof AgentService !== 'undefined' && !AgentService.model) {
            UIUtils.showToast('No local model selected to build the summary', 'error');
            return;
        }
        if (btn) { btn.disabled = true; btn.textContent = 'Rebuilding…'; }
        // Hold the same lock the daily auto-run checks, so the background timer
        // can't kick off a second overlapping pass while this one runs.
        // _foregroundMemoryOp warns on refresh (the user is watching this run).
        AgentService._consolidating = true;
        AgentService._foregroundMemoryOp = true;
        try {
            // consolidateMemories tidies the raw log AND re-folds it into the
            // categorized profile (full mode).
            await AgentService.consolidateMemories({ full: true });
            this._renderMemories();
            this._refreshAssistantBadges();
            UIUtils.showToast('Summary rebuilt from your chats', 'success');
        } catch (e) {
            UIUtils.showToast('Rebuild failed', 'error');
            console.warn('[memory] manual rebuild failed:', e);
        } finally {
            AgentService._consolidating = false;
            AgentService._foregroundMemoryOp = false;
            if (btn) { btn.disabled = false; btn.textContent = 'Rebuild summary'; }
        }
    },

    // Read-only view of the categorized memory profile. Editing lives on the
    // Assistant page (the "Edit on Assistant page" button); here we just show
    // the summary so the user can review what's stored from Settings.
    _renderMemories() {
        const listEl = document.getElementById('settings-memory-list');
        const countEl = document.getElementById('settings-memories-count');
        if (!listEl || typeof MemoryManager === 'undefined') return;

        const sections = MemoryManager.listSections();
        const filled = sections.filter(s => (s.body || '').trim());
        if (countEl) countEl.textContent = filled.length;

        if (filled.length === 0) {
            listEl.innerHTML = '<div class="settings-memory-empty">Nothing remembered yet. The assistant fills this in as you chat — or open it on the Assistant page to write your own.</div>';
            return;
        }

        listEl.innerHTML = filled.map(s => {
            const badge = s.userEdited ? '<span class="settings-memory-chip">edited by you</span>' : '';
            return `
                <div class="settings-memory-item">
                    <div class="settings-memory-item-header">
                        <span class="settings-memory-title">${UIUtils.escapeHtml(s.title || '')}</span>
                        ${badge}
                    </div>
                    <div class="settings-memory-body">${UIUtils.escapeHtml(s.body)}</div>
                </div>
            `;
        }).join('');
    },

    _relativeTime(iso) {
        const then = Date.parse(iso);
        if (!then) return '';
        const diff = Date.now() - then;
        const mins = Math.round(diff / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        const hrs = Math.round(mins / 60);
        if (hrs < 24) return `${hrs}h ago`;
        const days = Math.round(hrs / 24);
        if (days < 7) return `${days}d ago`;
        return new Date(iso).toLocaleDateString();
    },


    // ── Privacy / Analytics sub-view ──

    _privacySettingsBound: false,

    openPrivacySettings() {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('privacy-settings-view').classList.add('active');
        Breadcrumb.render('privacy-settings-breadcrumb', [
            { label: 'Settings', action: () => { document.getElementById('privacy-settings-view').classList.remove('active'); document.getElementById('settings-view').classList.add('active'); this.render(); } },
            { label: 'Privacy' }
        ]);

        this._renderPrivacySettings();

        if (!this._privacySettingsBound) {
            this._privacySettingsBound = true;

            this._bindChange('settings-analytics-toggle', (checked) => {
                if (typeof AnalyticsManager === 'undefined') return;
                AnalyticsManager.setEnabled(!!checked);
                UIUtils.showToast(checked ? 'Analytics enabled' : 'Analytics disabled', 'info');
                this._renderPrivacySettings();
            }, true);

            this._bindBtn('settings-analytics-refresh-btn', () => {
                this._renderPrivacySettings();
            });

            this._bindBtn('settings-analytics-send-btn', async () => {
                if (typeof AnalyticsManager === 'undefined') return;
                if (!AnalyticsManager.isEnabled()) {
                    UIUtils.showToast('Enable analytics first', 'info');
                    return;
                }
                UIUtils.showToast('Sending…', 'info');
                const result = await AnalyticsManager.uploadIfDue({ force: true });
                if (result && result.uploaded) {
                    UIUtils.showToast(`Sent ${result.uploaded} event${result.uploaded === 1 ? '' : 's'}`, 'success');
                } else if (result && result.skipped === 'empty') {
                    UIUtils.showToast('No events to send', 'info');
                } else if (result && result.error) {
                    UIUtils.showToast(`Send failed: ${result.error}`, 'error');
                } else {
                    UIUtils.showToast('Send complete', 'info');
                }
                this._renderPrivacySettings();
            });

            this._bindBtn('settings-analytics-clear-btn', async () => {
                if (typeof AnalyticsManager === 'undefined') return;
                const confirmed = await UIUtils.confirm(
                    'Clear recorded events?',
                    'The local event log will be emptied. Your install ID and opt-in preference are kept.',
                    ''
                );
                if (!confirmed) return;
                AnalyticsManager.clearPendingEvents();
                UIUtils.showToast('Event log cleared', 'success');
                this._renderPrivacySettings();
            });

            // Clear browse data — wipes the persist:browse session so
            // every browsed site logs the user out and any trackers
            // start from scratch. Doesn't touch the main app data.
            this._bindBtn('settings-clear-browse-data-btn', async () => {
                if (!window.electronBrowse?.clearData) return;
                const confirmed = await UIUtils.confirm(
                    'Clear browse data?',
                    'This wipes cookies, cache, local storage, and saved auth from every site you\'ve visited in the Browse sub-app. Your notes, journal, goals, and other Anjadhe data are not affected.',
                    'Clear'
                );
                if (!confirmed) return;
                const status = document.getElementById('settings-clear-browse-data-status');
                if (status) status.textContent = 'Clearing…';
                const result = await window.electronBrowse.clearData();
                if (result?.ok) {
                    if (status) status.textContent = `Cleared at ${new Date().toLocaleString()}.`;
                    UIUtils.showToast('Browse data cleared', 'success');
                } else {
                    if (status) status.textContent = `Clear failed: ${result?.error || 'unknown error'}`;
                    UIUtils.showToast('Clear failed', 'error');
                }
            });
        }
    },

    _renderPrivacySettings() {
        if (typeof AnalyticsManager === 'undefined') return;

        const toggle = document.getElementById('settings-analytics-toggle');
        if (toggle) toggle.checked = AnalyticsManager.isEnabled();

        const installIdEl = document.getElementById('settings-analytics-install-id');
        if (installIdEl) installIdEl.textContent = AnalyticsManager.getInstallId();

        const lastUploadEl = document.getElementById('settings-analytics-last-upload');
        if (lastUploadEl) {
            const lastUpload = AnalyticsManager.getLastUploadAt();
            lastUploadEl.textContent = lastUpload
                ? `Last sent: ${this._formatTimeAgo(new Date(lastUpload))}`
                : 'Last sent: never';
        }

        const events = AnalyticsManager.getPendingEvents();
        const summaryEl = document.getElementById('settings-analytics-summary');
        if (summaryEl) {
            if (events.length === 0) {
                summaryEl.textContent = 'No events recorded.';
            } else {
                const oldest = new Date(events[0].ts);
                const newest = new Date(events[events.length - 1].ts);
                const span = oldest.getTime() === newest.getTime()
                    ? this._formatTime(newest)
                    : this._formatTimeRange(oldest, newest);
                summaryEl.textContent = `${events.length} event${events.length === 1 ? '' : 's'} · ${span}`;
            }
        }

        const eventsEl = document.getElementById('settings-analytics-events');
        if (eventsEl) {
            eventsEl.innerHTML = '';
            // Show newest first.
            for (let i = events.length - 1; i >= 0; i--) {
                const ev = events[i];
                const row = document.createElement('div');
                row.className = 'settings-analytics-event';
                const propStr = Object.keys(ev.props || {}).length
                    ? JSON.stringify(ev.props)
                    : '';
                row.innerHTML = `
                    <span class="settings-analytics-event-name">${this._esc(ev.name)}</span>
                    <span class="settings-analytics-event-props">${this._esc(propStr)}</span>
                    <span class="settings-analytics-event-time" title="${this._esc(this._formatTime(new Date(ev.ts)))}">${this._esc(this._formatTimeAgo(new Date(ev.ts)))}</span>
                `;
                eventsEl.appendChild(row);
            }
        }

        const vocabEl = document.getElementById('settings-analytics-vocabulary');
        if (vocabEl && !vocabEl.dataset.rendered) {
            vocabEl.innerHTML = '';
            for (const name of AnalyticsManager.getVocabulary()) {
                const schema = AnalyticsManager.VOCABULARY[name];
                const propKeys = Object.keys(schema);
                const li = document.createElement('li');
                li.innerHTML = `
                    <span>${this._esc(name)}</span>
                    <span class="settings-analytics-vocabulary-props">${propKeys.length ? this._esc('{ ' + propKeys.join(', ') + ' }') : '(no props)'}</span>
                `;
                vocabEl.appendChild(li);
            }
            vocabEl.dataset.rendered = '1';
        }
    },

    _formatTime(date) {
        const now = new Date();
        const timeOpts = { hour: 'numeric', minute: '2-digit' };
        const time = date.toLocaleTimeString(undefined, timeOpts);
        if (date.toDateString() === now.toDateString()) return `Today, ${time}`;
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        if (date.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
        const sameYear = date.getFullYear() === now.getFullYear();
        const dateOpts = sameYear
            ? { month: 'short', day: 'numeric' }
            : { year: 'numeric', month: 'short', day: 'numeric' };
        return `${date.toLocaleDateString(undefined, dateOpts)}, ${time}`;
    },

    _formatTimeRange(start, end) {
        if (start.toDateString() === end.toDateString()) {
            const endTime = end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
            return `${this._formatTime(start)} – ${endTime}`;
        }
        return `${this._formatTime(start)} – ${this._formatTime(end)}`;
    },

    _formatTimeAgo(date) {
        const diff = Date.now() - date.getTime();
        if (diff < 0) return this._formatTime(date);
        const secs = Math.floor(diff / 1000);
        if (secs < 45) return 'just now';
        const mins = Math.floor(secs / 60);
        if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
        const days = Math.floor(hours / 24);
        if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
        return this._formatTime(date);
    },

    // ── Storage & Backup sub-view ──

    _storageBackupBound: false,

    openProfileSettings() {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('profiles-settings-view').classList.add('active');
        Breadcrumb.render('profiles-settings-breadcrumb', [
            { label: 'Settings', action: () => { document.getElementById('profiles-settings-view').classList.remove('active'); document.getElementById('settings-view').classList.add('active'); this.render(); } },
            { label: 'Profiles' }
        ]);
        this._renderProfilesList();

        // Add profile button
        const addBtn = document.getElementById('profiles-add-btn');
        if (addBtn) {
            const freshBtn = addBtn.cloneNode(true);
            addBtn.parentNode.replaceChild(freshBtn, addBtn);
            freshBtn.addEventListener('click', () => {
                ProfileManager._showNewProfileModal(() => {
                    this._renderProfilesList();
                });
            });
        }
    },

    _renderProfilesList() {
        const container = document.getElementById('profiles-list');
        if (!container) return;

        const profiles = ProfileManager.getProfiles();
        const activeId = ProfileManager.getActiveProfileId();

        container.innerHTML = profiles.map(p => `
            <div class="profile-settings-row" data-profile-id="${p.id}">
                <span class="profile-settings-name ${p.id === activeId ? 'active' : ''}">${p.name}</span>
                ${p.id === activeId ? '<span class="profile-settings-badge">Active</span>' : ''}
                <div class="profile-settings-actions">
                    ${p.id !== 'default' ? `<button class="profile-rename-btn secondary-btn" data-id="${p.id}">Rename</button>` : ''}
                    ${p.id !== 'default' ? `<button class="profile-delete-btn secondary-btn" data-id="${p.id}">Delete</button>` : ''}
                </div>
            </div>
        `).join('');

        // Rename handlers
        container.querySelectorAll('.profile-rename-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.id;
                const profile = profiles.find(p => p.id === id);
                ProfileManager._showRenameProfileModal(id, profile?.name || '', () => {
                    this._renderProfilesList();
                });
            });
        });

        // Delete handlers
        container.querySelectorAll('.profile-delete-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.dataset.id;
                const profile = profiles.find(p => p.id === id);
                const confirmed = await UIUtils.confirm('Delete Profile', `Delete "${profile?.name}"? Its items will be moved to Default.`);
                if (!confirmed) return;
                ProfileManager.deleteProfile(id);
                this._renderProfilesList();
                UIUtils.showToast('Profile deleted', 'success');
            });
        });
    },

    openSetupAssistant() {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('setup-assistant-view').classList.add('active');
        Breadcrumb.render('setup-assistant-breadcrumb', [
            { label: 'Settings', action: () => { document.getElementById('setup-assistant-view').classList.remove('active'); document.getElementById('settings-view').classList.add('active'); } },
            { label: 'Setup Assistant' }
        ]);

        const host = document.getElementById('setup-assistant-host');
        if (host && typeof SetupAssistant !== 'undefined') {
            // A user reaching this from Settings explicitly wants it back —
            // clear any "Maybe later" and render even when complete.
            SetupAssistant.reopen();
            SetupAssistant.renderFull(host, { force: true });
        }
    },

    async openStorageBackup() {
        // Show the sub-view
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('storage-backup-view').classList.add('active');
        Breadcrumb.render('storage-backup-breadcrumb', [
            { label: 'Settings', action: () => { document.getElementById('storage-backup-view').classList.remove('active'); document.getElementById('settings-view').classList.add('active'); } },
            { label: 'Storage & Backup' }
        ]);

        // Load current state
        const storageFolder = window.electronStore.getStorageFolder();
        const customPath = window.electronStore.getCustomStoragePath();

        const pathEl = document.getElementById('storage-backup-path');
        if (pathEl) pathEl.textContent = storageFolder;

        const customNote = document.getElementById('storage-backup-custom-note');
        if (customNote) customNote.style.display = customPath ? '' : 'none';

        const resetBtn = document.getElementById('settings-reset-storage-btn');
        if (resetBtn) resetBtn.style.display = customPath ? '' : 'none';

        // Backup settings
        let backupSettings = { enabled: false, frequency: 'hourly', lastBackup: null, backupPath: null };
        if (window.electronBackup) {
            try { backupSettings = await window.electronBackup.getSettings(); } catch {}
        }

        const backupToggle = document.getElementById('settings-backup-toggle');
        if (backupToggle) backupToggle.checked = backupSettings.enabled;

        const backupDetail = document.getElementById('settings-backup-detail');
        if (backupDetail) backupDetail.style.display = backupSettings.enabled ? '' : 'none';

        const freqSelect = document.getElementById('settings-backup-frequency');
        if (freqSelect) freqSelect.value = backupSettings.frequency;

        const lastBackupEl = document.getElementById('settings-last-backup');
        if (lastBackupEl) {
            lastBackupEl.textContent = backupSettings.lastBackup
                ? new Date(backupSettings.lastBackup).toLocaleString()
                : 'Never';
        }

        const backupPathEl = document.getElementById('settings-backup-path');
        if (backupPathEl) backupPathEl.textContent = backupSettings.backupPath || 'No folder selected';

        this._renderStorageUsage();
        await this._renderSyncEncryption();

        // Bind events once
        if (!this._storageBackupBound) {
            this._storageBackupBound = true;

            this._bindBtn('settings-change-storage-btn', () => AppManager.changeStorageLocation());
            this._bindBtn('settings-reset-storage-btn', () => AppManager.resetStorageLocation());

            this._bindBtn('settings-sync-enc-set-btn', () => this._syncEncPrompt('set'));
            this._bindBtn('settings-sync-enc-unlock-btn', () => this._syncEncPrompt('unlock'));
            this._bindBtn('settings-sync-enc-change-btn', () => this._syncEncPrompt('change'));

            // Backup toggle
            const toggle = document.getElementById('settings-backup-toggle');
            if (toggle) {
                const newEl = toggle.cloneNode(true);
                toggle.parentNode.replaceChild(newEl, toggle);
                newEl.addEventListener('change', async (e) => {
                    const enabled = e.target.checked;
                    await window.electronBackup.setEnabled(enabled);
                    const detail = document.getElementById('settings-backup-detail');
                    if (detail) detail.style.display = enabled ? '' : 'none';

                    if (enabled) {
                        const result = await window.electronBackup.backupNow();
                        if (result.success) {
                            const timeEl = document.getElementById('settings-last-backup');
                            if (timeEl) timeEl.textContent = new Date(result.time).toLocaleString();
                            UIUtils.showToast('Backup enabled', 'success');
                        }
                    }
                });
            }

            // Backup folder chooser
            this._bindBtn('settings-backup-choose-folder-btn', async () => {
                const folderPath = await window.electronDialog.selectFolder();
                if (!folderPath) return;
                if (window.electronBackup) {
                    await window.electronBackup.setBackupPath(folderPath);
                }
                const pathEl = document.getElementById('settings-backup-path');
                if (pathEl) pathEl.textContent = folderPath;
                UIUtils.showToast('Backup folder updated', 'success');
            });

            this._bindChange('settings-backup-frequency', async (val) => {
                await window.electronBackup.setFrequency(val);
            });

            this._bindBtn('settings-backup-now-btn', async () => {
                const btn = document.getElementById('settings-backup-now-btn');
                btn.disabled = true;
                btn.textContent = 'Backing up...';
                try {
                    const result = await window.electronBackup.backupNow();
                    if (result.success) {
                        const timeEl = document.getElementById('settings-last-backup');
                        if (timeEl) timeEl.textContent = new Date(result.time).toLocaleString();
                        UIUtils.showToast('Backup completed', 'success');
                    } else {
                        UIUtils.showToast('Backup failed: ' + result.error, 'error');
                    }
                } catch (err) {
                    UIUtils.showToast('Backup failed: ' + err.message, 'error');
                }
                btn.disabled = false;
                btn.textContent = 'Backup Now';
            });

            this._bindBtn('settings-restore-btn', async () => {
                await AppManager.showRestoreBackupPicker();
            });
            this._bindBtn('settings-browse-db-btn', () => this.openDbBrowser());
        }
    },

    // ── Sync encryption (H6) ──

    async _renderSyncEncryption() {
        const statusEl = document.getElementById('settings-sync-enc-status');
        const setBtn = document.getElementById('settings-sync-enc-set-btn');
        const unlockBtn = document.getElementById('settings-sync-enc-unlock-btn');
        const changeBtn = document.getElementById('settings-sync-enc-change-btn');
        if (!statusEl || !window.electronSync?.encryptionStatus) return;
        let st;
        try { st = await window.electronSync.encryptionStatus(); } catch { return; }
        const show = (el, on) => { if (el) el.style.display = on ? '' : 'none'; };
        const messages = {
            passphrase: 'Protected — your sync key is encrypted with a passphrase, and unlocked on this Mac.',
            locked: 'Locked — this Mac needs your passphrase to sync and back up. Enter it to resume.',
            plaintext: 'Not protected yet — your sync key sits unprotected in iCloud. Set a passphrase to secure it.',
            'local-only': 'This Mac has a local key that isn’t synced yet. Set a passphrase to sync securely across your Macs.',
            none: 'No sync key on this Mac.'
        };
        statusEl.textContent = messages[st.state] || '';
        statusEl.style.color = st.state === 'locked' ? 'var(--color-danger, #dc2626)'
            : st.state === 'passphrase' ? 'var(--color-success, #16a34a)' : '';
        show(setBtn, st.upgradeable);
        show(unlockBtn, st.locked);
        show(changeBtn, st.state === 'passphrase');
    },

    // One flow for set / change / unlock. `mode` picks the copy + IPC call.
    // Resolves true once the operation succeeds (used by the startup unlock).
    _syncEncPrompt(mode) {
        const cfg = {
            set: { title: 'Set a sync passphrase', label: 'Choose a passphrase (8+ characters)', confirm: true, save: 'Set passphrase',
                note: 'Every Mac will need this passphrase once to keep syncing. It isn’t stored in iCloud, so keep it somewhere safe — it can’t be recovered.',
                run: (p) => window.electronSync.setPassphrase(p), ok: 'Passphrase set — your sync key is now protected.' },
            change: { title: 'Change sync passphrase', label: 'New passphrase (8+ characters)', confirm: true, save: 'Change passphrase',
                note: 'Your other Macs will keep working until they next need the key; then they’ll ask for the new passphrase.',
                run: (p) => window.electronSync.changePassphrase(p), ok: 'Passphrase changed.' },
            unlock: { title: 'Unlock sync on this Mac', label: 'Enter your sync passphrase', confirm: false, save: 'Unlock',
                note: 'This unlocks the shared sync key on this Mac and resumes syncing and backups.',
                run: (p) => window.electronSync.unlock(p), ok: 'Unlocked — syncing resumed.' }
        }[mode];
        return new Promise((resolve) => {
            const body = document.createElement('div');
            body.innerHTML = `
                <p class="settings-section-desc">${UIUtils.escapeHtml(cfg.note)}</p>
                <p class="settings-hint" style="margin-bottom:4px;">${UIUtils.escapeHtml(cfg.label)}</p>
                <input type="password" id="sync-enc-pass" class="settings-input" autocomplete="new-password" style="width:100%;margin-bottom:var(--space-sm);">
                ${cfg.confirm ? '<p class="settings-hint" style="margin-bottom:4px;">Confirm passphrase</p><input type="password" id="sync-enc-pass2" class="settings-input" autocomplete="new-password" style="width:100%;">' : ''}
                <p id="sync-enc-err" class="settings-hint" style="color:var(--color-danger,#dc2626);display:none;"></p>`;
            let done = false;
            const err = body.querySelector('#sync-enc-err');
            const showErr = (m) => { err.textContent = m; err.style.display = ''; };
            const submit = async () => {
                const p = body.querySelector('#sync-enc-pass').value;
                if (cfg.confirm) {
                    if (p !== body.querySelector('#sync-enc-pass2').value) return showErr('Passphrases don’t match.');
                    if (p.length < 8) return showErr('Use at least 8 characters.');
                }
                if (!p) return showErr('Enter your passphrase.');
                const saveBtn = body.closest('.modal')?.querySelector('.modal-footer .primary-btn');
                if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Working…'; }
                let res;
                try { res = await cfg.run(p); } catch (e) { res = { error: e.message }; }
                if (res && res.ok) {
                    done = true;
                    modal.close();
                    UIUtils.showToast(cfg.ok, 'success');
                    this._renderSyncEncryption();
                    resolve(true);
                } else {
                    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = cfg.save; }
                    showErr((res && res.error) || 'Something went wrong.');
                }
            };
            const modal = Modal.create({
                title: cfg.title, content: body,
                buttons: [
                    { text: 'Cancel', className: 'secondary-btn', onClick: () => modal.close() },
                    { text: cfg.save, className: 'primary-btn', onClick: submit }
                ],
                onClose: () => { if (!done) resolve(false); }
            });
            body.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
            setTimeout(() => body.querySelector('#sync-enc-pass')?.focus(), 50);
        });
    },

    // ── Database Browser ──

    openDbBrowser() {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('db-browser-view').classList.add('active');
        Breadcrumb.render('db-browser-breadcrumb', [
            { label: 'Settings', action: () => { document.getElementById('db-browser-view').classList.remove('active'); document.getElementById('settings-view').classList.add('active'); } },
            { label: 'Storage', action: () => this.openStorageBackup() },
            { label: 'Browse Database' }
        ]);

        const allData = StorageManager.getAll();
        const keys = Object.keys(allData).sort();
        this._dbBrowserData = allData;
        this._dbBrowserKeys = keys;

        this._renderDbList(keys, allData);

        // Search filter
        if (!this._dbSearchBound) {
            this._dbSearchBound = true;
            const searchInput = document.getElementById('db-browser-search');
            searchInput.addEventListener('input', () => {
                const q = searchInput.value.toLowerCase().trim();
                const filtered = q
                    ? this._dbBrowserKeys.filter(k => k.toLowerCase().includes(q))
                    : this._dbBrowserKeys;
                this._renderDbList(filtered, this._dbBrowserData);
            });
        }
        document.getElementById('db-browser-search').value = '';
    },

    _renderDbList(keys, allData) {
        const container = document.getElementById('db-browser-list');
        const countEl = document.getElementById('db-browser-count');
        countEl.textContent = `${keys.length} key${keys.length !== 1 ? 's' : ''}`;

        if (keys.length === 0) {
            container.innerHTML = '<div class="db-browser-empty">No keys found</div>';
            return;
        }

        container.innerHTML = keys.map(key => {
            const val = allData[key];
            const size = this._formatSize(JSON.stringify(val));
            const type = Array.isArray(val) ? 'array' : typeof val;
            let itemCount = '';
            if (Array.isArray(val)) {
                itemCount = ` (${val.length})`;
            } else if (val && typeof val === 'object') {
                const innerArrays = Object.values(val).filter(v => Array.isArray(v));
                if (innerArrays.length === 1) {
                    itemCount = ` (${innerArrays[0].length} items)`;
                }
            }
            return `<div class="db-browser-item" data-key="${this._esc(key)}">
                <div class="db-browser-key">
                    <span class="db-browser-key-arrow">&#9654;</span>
                    <span class="db-browser-key-name">${this._esc(key)}</span>
                    <span class="db-browser-key-meta">${type}${itemCount} &middot; ${size}</span>
                </div>
                <div class="db-browser-value"><pre></pre></div>
            </div>`;
        }).join('');

        // Toggle expand on click
        container.querySelectorAll('.db-browser-key').forEach(el => {
            el.addEventListener('click', () => {
                const item = el.closest('.db-browser-item');
                const wasExpanded = item.classList.contains('expanded');
                if (!wasExpanded) {
                    const key = item.dataset.key;
                    const pre = item.querySelector('pre');
                    if (!pre.textContent) {
                        pre.textContent = JSON.stringify(allData[key], null, 2);
                    }
                }
                item.classList.toggle('expanded');
            });
        });
    },

    _formatSize(str) {
        const bytes = new Blob([str]).size;
        return this._formatBytes(bytes);
    },

    _formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    },

    // ── Per-app data usage (Storage & Backup page) ──

    // Map a raw storage key to a user-facing app name. Exact matches
    // first, then prefix rules for the namespaced / dynamic keys.
    // Anything unrecognized falls into "Other" so the totals always
    // add up even as new keys are introduced.
    _appForStorageKey(key) {
        const exact = {
            email: 'Email', emailPriorityTerms: 'Email', emailSearchHistory: 'Email',
            schedule: 'Schedule', calendar: 'Schedule',
            notes: 'Notes', notesPrefs: 'Notes', tags: 'Notes',
            journal: 'Journal',
            goals: 'Goals',
            bookmarks: 'Bookmarks', 'bookmarks-view-mode': 'Bookmarks', links: 'Bookmarks',
            portfolio: 'Portfolio',
            focus: 'Focus', pomodoro: 'Focus',
            dictionary: 'Vocabulary', 'dictionary-cache': 'Vocabulary',
            prompts: 'Prompts', promptFeed: 'Prompts',
            // Assistant internals — chat history and model/search logs are
            // often the heaviest keys, so attributing them correctly keeps
            // the breakdown honest.
            'agent-settings': 'Assistant', 'agent-conversations': 'Assistant',
            'agent-memories': 'Assistant',
            // Diagnostic logs — every LLM/search call app-wide, capped and
            // machine-local. Kept separate from Assistant so chat/memory
            // size isn't conflated with debug logging (and it's clearable
            // from Settings - LLM Logs).
            'llm-logs': 'Logs', 'search-logs': 'Logs', 'network-logs': 'Logs',
            // Cross-cutting app/system state — not owned by any sub-app.
            profiles: 'System', accounts: 'System', analytics: 'System',
            'favorite-apps': 'System', 'hidden-apps': 'System',
            dashTab: 'System', 'dismissed-announcements': 'System'
        };
        if (exact[key]) return exact[key];
        if (key.startsWith('browse')) return 'Browser';        // browse_*, browseHomeTab, app_browse*
        if (key.startsWith('app_browse')) return 'Browser';
        if (key.startsWith('llm') || key.startsWith('search-log')) return 'Logs';
        if (key.startsWith('agent')) return 'Assistant';
        if (key.startsWith('email')) return 'Email';
        if (key.startsWith('calendar')) return 'Schedule';
        if (key.startsWith('journal')) return 'Journal';
        if (key.startsWith('notes')) return 'Notes';
        if (key.startsWith('bookmarks')) return 'Bookmarks';
        if (key.startsWith('dictionary')) return 'Vocabulary';
        if (key.startsWith('prompt')) return 'Prompts';
        // Truly unrecognized (new/future keys) — keep them visible rather
        // than hiding them inside System so the breakdown stays auditable.
        return 'Other';
    },

    async _renderStorageUsage() {
        const listEl = document.getElementById('storage-usage-list');
        const totalEl = document.getElementById('storage-usage-total');
        if (!listEl) return;

        let all = {};
        try { all = StorageManager.getAll() || {}; } catch {}

        const byApp = {};
        let total = 0;
        for (const key of Object.keys(all)) {
            // Same measurement as the DB browser: serialized byte length.
            let bytes = 0;
            try { bytes = new Blob([JSON.stringify(all[key] ?? null)]).size; } catch {}
            const app = this._appForStorageKey(key);
            byApp[app] = (byApp[app] || 0) + bytes;
            total += bytes;
        }

        // Email's cached messages live in a dedicated SQLite table, not the
        // app_email kv blob, so StorageManager.getAll() above only sees
        // Email's small metadata. Fold in the message-table size so Email
        // isn't drastically under-reported.
        try {
            const eml = await window.electronEmailDb?.dbSize?.();
            if (eml && eml.bytes > 0) {
                byApp['Email'] = (byApp['Email'] || 0) + eml.bytes;
                total += eml.bytes;
            }
        } catch {}

        const rows = Object.entries(byApp)
            .map(([app, bytes]) => ({ app, bytes }))
            .sort((a, b) => b.bytes - a.bytes);

        if (rows.length === 0 || total === 0) {
            listEl.innerHTML = '<p class="settings-hint">No app data stored yet.</p>';
            if (totalEl) totalEl.textContent = '';
            return;
        }

        const max = rows[0].bytes || 1;
        listEl.innerHTML = rows.map(r => {
            const pct = Math.max(2, Math.round((r.bytes / max) * 100));
            const appId = this._launchIdForApp(r.app);
            const name = appId
                ? `<a href="#" class="storage-usage-link" data-app="${this._esc(appId)}" title="Open ${this._esc(r.app)}">${this._esc(r.app)}</a>`
                : `<span class="storage-usage-name-plain">${this._esc(r.app)}</span>`;
            return `<div class="storage-usage-row">
                <span class="storage-usage-name">${name}</span>
                <span class="storage-usage-bar"><span class="storage-usage-bar-fill" style="width: ${pct}%;"></span></span>
                <span class="storage-usage-size">${this._formatBytes(r.bytes)}</span>
            </div>`;
        }).join('');

        if (totalEl) totalEl.textContent = `Total: ${this._formatBytes(total)} across ${rows.length} app${rows.length !== 1 ? 's' : ''}`;

        // Delegated once: clicking an app name launches that sub-app.
        // Non-app buckets (System, Logs, Other) render as plain text and
        // have no data-app, so they're inert.
        if (!this._storageUsageBound) {
            this._storageUsageBound = true;
            listEl.addEventListener('click', (e) => {
                const link = e.target.closest('[data-app]');
                if (!link) return;
                e.preventDefault();
                const appId = link.getAttribute('data-app');
                if (appId && typeof AppManager !== 'undefined') AppManager.openApp(appId);
            });
        }
    },

    // Map a Data Usage bucket label to the canonical AppManager id, or
    // null for buckets that aren't launchable sub-apps (System, Logs,
    // Other). Keys mirror the labels produced by _appForStorageKey().
    _launchIdForApp(app) {
        const map = {
            Email: 'email', Schedule: 'schedule', Notes: 'notes',
            Journal: 'journal', Goals: 'goals', Bookmarks: 'bookmarks',
            Portfolio: 'portfolio',
            Focus: 'focus', Vocabulary: 'dictionary',
            Prompts: 'prompts',
            Browser: 'browse', Assistant: 'agent'
        };
        return map[app] || null;
    },

    // ── LLM Logs rendering ──

    renderLogs() {
        const container = document.getElementById('settings-logs-container');
        const countBadge = document.getElementById('settings-logs-count');
        if (!container) return;

        const logs = LLMLogger.logs;
        if (countBadge) countBadge.textContent = logs.length;

        if (logs.length === 0) {
            container.innerHTML = '<p class="settings-hint" style="text-align:center; padding: var(--space-lg) 0;">No LLM calls recorded yet.</p>';
            return;
        }

        container.innerHTML = `
            <table class="llm-logs-table">
                <thead>
                    <tr>
                        <th>Source</th>
                        <th>Model</th>
                        <th>Prompt</th>
                        <th>Duration</th>
                        <th>Tokens</th>
                        <th>Time</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    ${logs.map((log, i) => this._renderLogEntry(log, i)).join('')}
                </tbody>
            </table>
        `;

        // Attach row click to show detail
        container.querySelectorAll('[data-log-index]').forEach(row => {
            row.addEventListener('click', () => {
                this._showLogDetail(parseInt(row.dataset.logIndex));
            });
        });
    },

    _renderLogEntry(log, index) {
        const time = new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const date = new Date(log.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
        const duration = log.durationMs != null ? `${(log.durationMs / 1000).toFixed(1)}s` : '--';
        const status = log.error ? 'error' : '';

        const sourceLabels = { agent: 'Agent', email: 'Email' };
        const sourceLabel = sourceLabels[log.source] || log.source || '?';
        const sourceClass = `source-${log.source || 'agent'}`;

        const tokens = log.totalTokens != null
            ? `${log.promptTokens?.toLocaleString() || '?'} / ${log.completionTokens?.toLocaleString() || '?'}`
            : `~${Math.round((log.requestChars || 0) / 4).toLocaleString()}`;

        const prompt = this._esc((log.userPrompt || '').slice(0, 80)) + ((log.userPrompt || '').length > 80 ? '...' : '');

        // A model id can be a full GGUF path on llama.cpp — show the model
        // name; the full id stays in the tooltip and the detail view.
        const modelName = String(log.model || '?').split('/').pop().replace(/\.gguf$/i, '');

        return `
            <tr class="llm-log-row ${status}" data-log-index="${index}">
                <td><span class="log-source ${sourceClass}">${sourceLabel}</span></td>
                <td class="log-model-cell" title="${this._esc(log.model || '')}">${this._esc(modelName)}</td>
                <td class="log-prompt-cell">${prompt}</td>
                <td>${duration}</td>
                <td>${tokens}</td>
                <td>${date} ${time}</td>
                <td>${log.error ? '<span class="log-error-dot"></span>' : ''}</td>
            </tr>
        `;
    },

    renderSearchLogs() {
        const container = document.getElementById('settings-search-logs-container');
        const countBadge = document.getElementById('settings-search-logs-count');
        if (!container) return;

        const logs = SearchLogger.logs;
        if (countBadge) countBadge.textContent = logs.length;

        if (logs.length === 0) {
            container.innerHTML = '<p class="settings-hint" style="text-align:center; padding: var(--space-lg) 0;">No web searches recorded yet.</p>';
            return;
        }

        container.innerHTML = `
            <table class="llm-logs-table">
                <thead>
                    <tr>
                        <th>Query</th>
                        <th>Provider</th>
                        <th>Results</th>
                        <th>Duration</th>
                        <th>Time</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    ${logs.map(log => this._renderSearchLogEntry(log)).join('')}
                </tbody>
            </table>
        `;
    },

    _renderSearchLogEntry(log) {
        const time = new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const date = new Date(log.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
        const duration = log.durationMs != null ? `${(log.durationMs / 1000).toFixed(1)}s` : '--';
        const status = log.error ? 'error' : '';
        const resultsCell = log.error ? this._esc(log.error) : String(log.resultCount ?? 0);
        const providerLabels = { tavily: 'Tavily', brave: 'Brave' };
        const providerCell = log.provider ? (providerLabels[log.provider] || this._esc(log.provider)) : '--';

        return `
            <tr class="llm-log-row ${status}">
                <td class="log-prompt-cell">${this._esc(log.query)}</td>
                <td>${providerCell}</td>
                <td>${resultsCell}</td>
                <td>${duration}</td>
                <td>${date} ${time}</td>
                <td>${log.error ? '<span class="log-error-dot"></span>' : ''}</td>
            </tr>
        `;
    },

    // ── Network Logs rendering ──

    async renderNetworkLogs() {
        const container = document.getElementById('settings-network-logs-container');
        const countBadge = document.getElementById('settings-network-logs-count');
        if (!container) return;

        let logs = [];
        try { logs = await window.electronNetLog.getLogs(); } catch {}
        if (!Array.isArray(logs)) logs = [];
        this._netLogs = logs;
        if (countBadge) countBadge.textContent = logs.length;

        if (logs.length === 0) {
            container.innerHTML = '<p class="settings-hint" style="text-align:center; padding: var(--space-lg) 0;">No network calls recorded yet.</p>';
            return;
        }

        container.innerHTML = `
            <table class="llm-logs-table">
                <thead>
                    <tr>
                        <th>Service</th>
                        <th>Request</th>
                        <th>Status</th>
                        <th>Size</th>
                        <th>Duration</th>
                        <th>Time</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    ${logs.map((log, i) => this._renderNetLogEntry(log, i)).join('')}
                </tbody>
            </table>
        `;

        container.querySelectorAll('[data-net-index]').forEach(row => {
            row.addEventListener('click', () => this._showNetLogDetail(parseInt(row.dataset.netIndex)));
        });
    },

    _fmtBytes(n) {
        if (n == null) return '--';
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / 1024 / 1024).toFixed(1)} MB`;
    },

    _renderNetLogEntry(log, index) {
        const time = new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const date = new Date(log.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
        const duration = log.durationMs != null ? `${(log.durationMs / 1000).toFixed(2)}s` : '--';
        const status = !log.ok ? 'error' : '';
        const statusCell = log.error ? this._esc(log.error) : (log.status != null ? String(log.status) : '--');
        const reqPath = (log.path || '/') + (log.hadQuery ? '?…' : '');
        const reqCell = `<span class="log-source">${this._esc(log.method || 'GET')}</span> ${this._esc(log.host || '')}${this._esc(reqPath.length > 60 ? reqPath.slice(0, 60) + '…' : reqPath)}`;
        const size = this._fmtBytes(log.resBytes);

        return `
            <tr class="llm-log-row ${status}" data-net-index="${index}">
                <td>${this._esc(log.service || 'Other')}</td>
                <td class="log-prompt-cell">${reqCell}</td>
                <td>${statusCell}</td>
                <td>${size}</td>
                <td>${duration}</td>
                <td>${date} ${time}</td>
                <td>${!log.ok ? '<span class="log-error-dot"></span>' : ''}</td>
            </tr>
        `;
    },

    _showNetLogDetail(index) {
        const log = (this._netLogs || [])[index];
        if (!log) return;

        const status = !log.ok ? 'error' : 'success';
        const sourceLabel = log.source === 'renderer' ? 'Renderer (fetch)' : 'Main process';
        const fullUrl = `${log.protocol || 'https:'}//${log.host || ''}${log.port ? ':' + log.port : ''}${log.path || '/'}${log.hadQuery ? '?…' : ''}`;

        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('net-log-detail-view').classList.add('active');
        window.scrollTo(0, 0);

        const content = document.getElementById('net-log-detail-content');
        content.innerHTML = `
            <div class="log-detail-overview">
                <span class="log-source">${this._esc(log.service || 'Other')}</span>
                <span class="log-model">${this._esc(log.method || 'GET')}</span>
                <span class="log-duration">${log.durationMs != null ? (log.durationMs / 1000).toFixed(2) + 's' : '—'}</span>
                <span class="log-status-dot ${status}"></span>
            </div>

            <div class="log-detail-section">
                <div class="log-detail-label">Destination</div>
                <pre class="log-detail-pre">${this._esc(fullUrl)}</pre>
            </div>

            <div class="log-detail-section">
                <div class="log-detail-label">Summary</div>
                <p class="log-detail-text">Initiated by: ${this._esc(sourceLabel)}</p>
                <p class="log-detail-text">Status: ${log.status != null ? log.status : '—'}${log.ok ? ' (ok)' : ' (failed)'}</p>
                <p class="log-detail-text">Request sent: ${this._fmtBytes(log.reqBytes)} | Response received: ${this._fmtBytes(log.resBytes)}</p>
                <p class="log-detail-text">Query string: ${log.hadQuery ? 'present (not logged)' : 'none'}</p>
                <p class="log-detail-text">When: ${new Date(log.timestamp).toLocaleString()}</p>
            </div>

            ${log.error ? `
                <div class="log-detail-section">
                    <div class="log-detail-label">Error</div>
                    <pre class="log-detail-pre log-error">${this._esc(log.error)}</pre>
                </div>
            ` : ''}

            <div class="log-detail-section">
                <div class="log-detail-label">Privacy</div>
                <p class="log-detail-text">Only the metadata above is recorded. Request and response bodies, headers, cookies, and authentication tokens are not logged, and the query string is stripped before storage.</p>
            </div>
        `;

        Breadcrumb.render('net-log-detail-breadcrumb', [
            { label: 'Settings', action: () => { document.querySelectorAll('.view').forEach(v => v.classList.remove('active')); document.getElementById('settings-view').classList.add('active'); this.render(); } },
            { label: 'Network Logs', action: () => this.openNetworkLogs() },
            { label: 'Request Detail' }
        ]);
    },

    _showLogDetail(index) {
        const log = LLMLogger.logs[index];
        if (!log) return;

        const systemPrompt = log.systemPrompt || 'None';
        const messages = log.requestMessages || [];
        const sourceLabels = { agent: 'Agent', email: 'Email' };
        const sourceLabel = sourceLabels[log.source] || log.source || '?';
        const sourceClass = `source-${log.source || 'agent'}`;
        const status = log.error ? 'error' : 'success';

        // Navigate to detail view
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        const view = document.getElementById('llm-log-detail-view');
        view.classList.add('active');
        window.scrollTo(0, 0);

        const content = document.getElementById('llm-log-detail-content');
        content.innerHTML = `
            <div class="log-detail-overview">
                <span class="log-source ${sourceClass}">${sourceLabel}</span>
                <span class="log-model">${this._esc(log.model || '?')}</span>
                <span class="log-duration">${log.durationMs != null ? (log.durationMs / 1000).toFixed(1) + 's' : '—'}</span>
                <span class="log-status-dot ${status}"></span>
            </div>

            <div class="log-detail-section">
                <div class="log-detail-label">Tokens</div>
                <p class="log-detail-text">Prompt: ${log.promptTokens?.toLocaleString() || '—'} | Completion: ${log.completionTokens?.toLocaleString() || '—'} | Total: ${log.totalTokens?.toLocaleString() || '—'}</p>
            </div>

            <div class="log-detail-section">
                <div class="log-detail-label">System Prompt <span class="log-detail-count">${systemPrompt.length.toLocaleString()} chars</span></div>
                <pre class="log-detail-pre">${this._esc(systemPrompt)}</pre>
            </div>

            <div class="log-detail-section">
                <div class="log-detail-label">Messages <span class="log-detail-count">${messages.length}</span></div>
                ${messages.map(m => `
                    <div class="log-detail-msg">
                        <strong>${this._esc(m.role)}</strong> <span class="log-detail-count">${m.chars.toLocaleString()} chars${m.toolCalls ? `, ${m.toolCalls} tool calls` : ''}</span>
                        <pre class="log-detail-pre">${this._esc(m.preview)}</pre>
                    </div>
                `).join('')}
            </div>

            ${log.toolCalls ? `
                <div class="log-detail-section">
                    <div class="log-detail-label">Tool Calls</div>
                    <pre class="log-detail-pre">${this._esc(JSON.stringify(log.toolCalls, null, 2))}</pre>
                </div>
            ` : ''}

            <div class="log-detail-section">
                <div class="log-detail-label">Full Response <span class="log-detail-count">${(log.responseChars || 0).toLocaleString()} chars</span></div>
                <pre class="log-detail-pre">${this._esc(log.response || log.error || 'No response')}</pre>
            </div>

            ${log.error ? `
                <div class="log-detail-section">
                    <div class="log-detail-label">Error</div>
                    <pre class="log-detail-pre log-error">${this._esc(log.error)}</pre>
                </div>
            ` : ''}
        `;

        // Breadcrumb for log detail — threads through the new LLM Logs sub-view
        // so Back goes log-list → assistant page → settings, matching how the
        // user navigated in.
        Breadcrumb.render('llm-log-detail-breadcrumb', [
            { label: 'Settings', action: () => { document.querySelectorAll('.view').forEach(v => v.classList.remove('active')); document.getElementById('settings-view').classList.add('active'); } },
            { label: 'AI Assistant', action: () => this.openLLMSettings() },
            { label: 'LLM Logs', action: () => this.openLlmLogs() },
            { label: 'Log Detail' }
        ]);
    },

    _esc(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
    },

    // Helper: bind click with clone-and-replace
    _bindBrowserSearchControls() {
        const saveAndNotify = () => {
            const sel = document.getElementById('settings-search-engine');
            const customInput = document.getElementById('settings-search-engine-custom-url');
            const customWrap = document.getElementById('settings-search-engine-custom-wrap');
            const engine = sel ? sel.value : 'duckduckgo';
            const customSearchUrl = (customInput?.value || '').trim();
            if (customWrap) customWrap.style.display = engine === 'custom' ? '' : 'none';
            const existing = StorageManager.get('browse_settings') || {};
            StorageManager.set('browse_settings', { ...existing, searchEngine: engine, customSearchUrl });
            if (typeof BrowseApp !== 'undefined' && BrowseApp._invalidateSearchSettings) {
                BrowseApp._invalidateSearchSettings();
            }
        };
        this._bindChange('settings-search-engine', saveAndNotify);
        const customInput = document.getElementById('settings-search-engine-custom-url');
        if (customInput) {
            const fresh = customInput.cloneNode(true);
            customInput.parentNode.replaceChild(fresh, customInput);
            fresh.addEventListener('input', () => saveAndNotify());
        }
    },

    _bindBtn(id, handler) {
        const el = document.getElementById(id);
        if (!el) return;
        const newEl = el.cloneNode(true);
        el.parentNode.replaceChild(newEl, el);
        newEl.addEventListener('click', handler);
    },

    // Helper: bind change with clone-and-replace
    _bindChange(id, handler, isCheckbox = false) {
        const el = document.getElementById(id);
        if (!el) return;
        const newEl = el.cloneNode(true);
        el.parentNode.replaceChild(newEl, el);
        newEl.addEventListener('change', (e) => {
            handler(isCheckbox ? e.target.checked : e.target.value);
        });
    }
};

AppManager.register('settings', SettingsApp);
