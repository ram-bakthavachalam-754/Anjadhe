/**
 * UpdaterUI — renders the titlebar update pill.
 *
 * Subscribes to the electron-updater events pushed from the main process
 * via window.electronUpdater. We stay quiet during background download
 * (no progress UI) so the user isn't nagged during the time there's
 * nothing for them to do. When the download is ready, the pill appears
 * next to the sync indicator in the titlebar, with an "Install" button
 * that triggers quitAndInstall() through the preload bridge.
 *
 * Also handles the "Check for Updates…" menu action result — shows a
 * short toast telling the user whether they're on the latest build, or
 * why the check failed, when there's no newer version for the main
 * update-available flow to advertise.
 *
 * In dev mode (`npm start`) window.electronUpdater still exists but all
 * its calls return `{ error: 'dev build' }` and no events fire, so
 * init() is a harmless no-op.
 */
const UpdaterUI = {
    _pillEl: null,
    _textEl: null,
    _btnEl: null,
    _version: null,
    _downloaded: false,

    init() {
        if (!window.electronUpdater) {
            // Running outside Electron (e.g., rendered statically). Skip.
            return;
        }

        this._pillEl = document.getElementById('updater-pill');
        this._textEl = document.getElementById('updater-pill-text');
        this._btnEl = document.getElementById('updater-install-btn');

        if (!this._pillEl || !this._btnEl) {
            console.warn('[updater-ui] pill DOM not found; updates will still download but the nudge will not appear');
            return;
        }

        this._btnEl.addEventListener('click', () => {
            this._requestInstall();
        });

        window.electronUpdater.onAvailable((info) => {
            console.log('[updater-ui] update available:', info && info.version);
            this._version = (info && info.version) || null;
            // Intentionally quiet during download — pill stays hidden.
        });

        window.electronUpdater.onProgress((info) => {
            // Intentionally no-op for UI. Logged for debugging only.
            console.log('[updater-ui] download progress:', info && info.percent + '%');
        });

        window.electronUpdater.onDownloaded((info) => {
            this._version = (info && info.version) || this._version;
            this._downloaded = true;
            this._show();
        });

        window.electronUpdater.onManualCheckResult((result) => {
            this._handleManualCheck(result);
        });

        // Rehydrate: if a download already completed before this window
        // existed, the one-shot `updater:downloaded` broadcast is gone, so
        // ask the main process for the current state and show the pill.
        if (window.electronUpdater.getState) {
            window.electronUpdater.getState().then((state) => {
                if (state && state.downloadedVersion) {
                    this._version = state.downloadedVersion;
                    this._downloaded = true;
                    this._show();
                }
            }).catch(() => {});
        }
    },

    /**
     * Install entry point for both the titlebar pill and the home card.
     * If AI work is mid-flight (a chat answer, email insights, a Maker
     * build…), restarting would silently throw that work away — so ask
     * first. Model warm-up and engine loads don't count: interrupting
     * them loses nothing, the model just reloads after the restart.
     */
    async _requestInstall() {
        const busy = this._runningAIActivities();
        if (busy.length > 0) {
            const esc = (s) => (typeof UIUtils !== 'undefined' && UIUtils.escapeHtml)
                ? UIUtils.escapeHtml(s) : String(s);
            const labels = [...new Set(busy.map(it => it.label))].map(esc).join(', ');
            const noun = busy.length > 1 ? 'these tasks' : 'this task';
            const confirmed = await UIUtils.confirm(
                'AI work in progress',
                `Anjadhe is still working on: <strong>${labels}</strong>.<br><br>
                 Restarting now interrupts ${noun}. You can wait for it to finish —
                 the update also installs on its own the next time you quit.`,
                '&#9888;',
                { confirmText: 'Restart anyway', cancelText: 'Wait' }
            );
            if (!confirmed) return;
        }
        window.electronUpdater.install();
    },

    /** In-flight AI work worth protecting from a restart. */
    _runningAIActivities() {
        if (typeof AIActivity === 'undefined' || !AIActivity.active) return [];
        return [...AIActivity.active.values()]
            .filter(it => it.kind !== 'engine' && it.tag !== 'prewarm');
    },

    _show() {
        if (this._pillEl) {
            if (this._textEl) {
                const v = this._version ? ' ' + this._version : '';
                this._textEl.textContent = 'Update' + v + ' ready';
            }
            this._pillEl.style.display = 'inline-flex';
        }
        this._renderHomeCard();
    },

    // The home-feed card — the pill's second, more visible surface. Renders
    // at the top of the home column once the download is ready. Dismissal is
    // per-version and machine-local (localStorage): updates are per-Mac, and
    // the next version's card should reappear. The titlebar pill stays either
    // way, and ignoring both is safe — the update installs on quit.
    _CARD_DISMISS_KEY: 'anjadhe_update_card_dismissed',

    _renderHomeCard() {
        if (!this._downloaded) return;
        const host = document.getElementById('dash-update-card');
        if (!host) return;

        let dismissedFor = null;
        try { dismissedFor = localStorage.getItem(this._CARD_DISMISS_KEY); } catch {}
        if (this._version && dismissedFor === this._version) return;

        const esc = (s) => (typeof UIUtils !== 'undefined' && UIUtils.escapeHtml)
            ? UIUtils.escapeHtml(s) : String(s);
        const v = this._version ? 'v' + String(this._version).replace(/^v/, '') : '';

        host.innerHTML = `
            <div class="dash-firstrun">
                <button type="button" class="dash-firstrun-dismiss" id="dash-update-dismiss"
                        title="Later — it installs when you quit" aria-label="Dismiss">&times;</button>
                <p class="dash-firstrun-kicker">Update ready</p>
                <h3 class="dash-firstrun-title">Anjadhe ${esc(v)} is ready to install</h3>
                <p class="dash-firstrun-body">Installs automatically the next time you quit Anjadhe.
                   Restart now to get it sooner.</p>
                <button type="button" class="primary-btn" id="dash-update-restart">Restart &amp; update</button>
            </div>`;
        host.style.display = '';

        document.getElementById('dash-update-restart')?.addEventListener('click', () => {
            this._requestInstall();
        });
        document.getElementById('dash-update-dismiss')?.addEventListener('click', () => {
            if (this._version) {
                try { localStorage.setItem(this._CARD_DISMISS_KEY, this._version); } catch {}
            }
            host.innerHTML = '';
            host.style.display = 'none';
        });
    },

    _handleManualCheck(result) {
        if (!result) return;

        // Error path — surface the reason so the user knows why nothing happened.
        if (result.error) {
            if (typeof UIUtils !== 'undefined' && UIUtils.showToast) {
                UIUtils.showToast('Update check failed: ' + result.error, 'error');
            }
            return;
        }

        // Success path. If a newer version exists, the normal update-available
        // event has already (or will shortly) fire and _show() will take over
        // once the download completes. If not, let the user know explicitly
        // that they're on the latest — otherwise the menu click feels like a
        // silent no-op.
        if (!this._downloaded && !this._version) {
            if (typeof UIUtils !== 'undefined' && UIUtils.showToast) {
                UIUtils.showToast('You are on the latest version.', 'success');
            }
        }
    }
};
