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
            window.electronUpdater.install();
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

    _show() {
        if (!this._pillEl) return;
        if (this._textEl) {
            const v = this._version ? ' ' + this._version : '';
            this._textEl.textContent = 'Update' + v + ' ready';
        }
        this._pillEl.style.display = 'inline-flex';
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
