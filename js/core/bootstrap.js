// App bootstrap. Extracted from an inline <script> in index.html so the
// Content-Security-Policy can forbid inline scripts (script-src without
// 'unsafe-inline') — the main defense against injected-markup XSS reaching the
// privileged contextBridge APIs. Loaded last, after every other module.

// Initialize the app
document.addEventListener('DOMContentLoaded', () => {
    // Apply the persisted sidebar-minimized choice before AppManager.init's
    // async work (user-app sync reconcile can take seconds) so the rail
    // doesn't flash expanded during boot. init re-applies it along with the
    // toggle button state.
    try {
        document.body.classList.toggle('nav-minimized', StorageManager.get('nav-minimized') === true);
    } catch { /* storage unavailable — init applies it */ }
    LLMLogger.loadFromStorage();
    SearchLogger.loadFromStorage();
    AIActivity.init();
    // AccountsManager runs migration from legacy email/calendar account
    // storage and synchronizes the per-app account arrays. Must run
    // before AppManager.init() in case any view rendering reads them.
    AccountsManager.init();
    AppManager.init();
    AgentUI.init();
    UpdaterUI.init();
});

// This was an inline onclick="AppManager.openApp('settings')" on the calendar
// "Not connected" prompt button. CSP forbids inline handlers, so bind it here
// via delegation (survives any re-render of the empty-state view).
document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('#calendar-connect-prompt-btn');
    if (btn) AppManager.openApp('settings');
});
