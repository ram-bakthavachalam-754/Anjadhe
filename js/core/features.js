/**
 * Feature flags.
 *
 * Build-time default flags for in-progress features. Each entry is the
 * feature key and whether it ships enabled in release builds. The
 * single source of truth is FEATURE_DEFAULTS below; flipping a value
 * to `true` and cutting a new release is the shipping mechanism.
 *
 * To try an off-by-default feature locally without a rebuild, run in
 * DevTools and reload:
 *
 *     localStorage.setItem('anjadheFeatures', 'appstudio');
 *
 * Clear with:
 *
 *     localStorage.removeItem('anjadheFeatures');
 *
 * Gating UI: add `data-feature="<key>"` to any element that should
 * disappear when the flag is off. AppManager calls applyToDocument()
 * at startup. Gating an app route: if the key is also an app slug in
 * AppManager, openApp() refuses to open it when the flag is off.
 */

const FEATURE_DEFAULTS = Object.freeze({
    // Hidden by default (2026-07-17): in-app AI app builds aren't reliable
    // enough to headline. Re-enable per-Mac with the "Show App Studio"
    // toggle in Settings → Build Apps (setOverride). The coding-agent
    // apps folder (~/Anjadhe/apps/) and installed user apps are unaffected;
    // the assistant's create_app / edit_app / test_app tools ship only
    // when this is on (agent-tools.js strip block).
    appstudio: false,
    // Graduated 2026-07-13: fs/shell tools, MCP client, and task mode
    // (docs/COWORK_AGENT.md C2–C4) shipped on for everyone after the
    // real-usage pass. Keys stay listed so any of them can be gated
    // again in an emergency by flipping to false.
    agentfs: true,
    mcp: true,
    taskmode: true,
    // Off by default (2026-07): phone pairing + relay sync (Settings →
    // Paired Devices, main.js desktop channel). Works end to end but is
    // unreleased — hosted-relay positioning/pricing is undecided, so
    // builds ship with it hidden. The flag gates the desktop side only:
    // main.js never connects to the relay unless the renderer calls
    // electronChannel.ensure(), which AppManager does only when this is on.
    mobilesync: false,
    // Default-on since 2026-07-16 (SECURITY-AUDIT.md H3): run user apps'
    // code in a sandboxed <iframe> (opaque origin, no preload, host-brokered
    // SDK) instead of in-renderer new Function(), so a malicious/LLM-written
    // app can't reach window.electron* or other apps' data. See
    // js/core/user-app-sandbox.js. Key stays listed so it can be re-gated
    // by flipping to false in an emergency.
    sandboxUserApps: true,
});

const FEATURE_OVERRIDE_KEY = 'anjadheFeatures';

const FEATURES = {
    isEnabled(name) {
        if (this._overrides().has(name)) return true;
        return !!FEATURE_DEFAULTS[name];
    },

    isGated(name) {
        return Object.prototype.hasOwnProperty.call(FEATURE_DEFAULTS, name);
    },

    all() {
        const overrides = this._overrides();
        const out = {};
        for (const key of Object.keys(FEATURE_DEFAULTS)) {
            out[key] = overrides.has(key) || FEATURE_DEFAULTS[key];
        }
        return out;
    },

    applyToDocument(root = document) {
        root.querySelectorAll('[data-feature]').forEach((el) => {
            const feature = el.getAttribute('data-feature');
            if (!feature) return;
            if (!this.isEnabled(feature)) {
                el.style.display = 'none';
                el.setAttribute('aria-hidden', 'true');
            }
        });
    },

    /**
     * Flags that ship off by default — the set Settings → AI → Experimental
     * offers as toggles. (Default-on flags aren't experimental; they're
     * only in FEATURE_DEFAULTS so they can be gated again in an emergency.)
     */
    experimental() {
        return Object.keys(FEATURE_DEFAULTS).filter((k) => !FEATURE_DEFAULTS[k]);
    },

    /**
     * Persist a local override (Settings toggle). Only meaningful for
     * off-by-default flags — an override can enable, never disable.
     * Takes effect on the next reload: gated tool registries are built at
     * script-load time, so a live flip would leave them half-applied.
     */
    setOverride(name, enabled) {
        try {
            const overrides = this._overrides();
            if (enabled) overrides.add(name);
            else overrides.delete(name);
            if (overrides.size) localStorage.setItem(FEATURE_OVERRIDE_KEY, [...overrides].join(','));
            else localStorage.removeItem(FEATURE_OVERRIDE_KEY);
        } catch { /* localStorage unavailable — nothing to persist */ }
    },

    _overrides() {
        try {
            if (typeof localStorage === 'undefined') return new Set();
            const raw = localStorage.getItem(FEATURE_OVERRIDE_KEY);
            if (!raw) return new Set();
            return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
        } catch {
            return new Set();
        }
    },
};

if (typeof window !== 'undefined') {
    window.FEATURES = FEATURES;
}
