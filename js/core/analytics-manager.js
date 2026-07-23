/**
 * Analytics Manager
 *
 * Opt-in, content-free usage analytics. Off by default. When enabled,
 * records anonymous event counts tagged with a per-machine install ID.
 * Message bodies, note text, goal descriptions — none of it goes in
 * here. Only small, pre-declared events from the vocabulary below.
 *
 * Phase 1 (current): events are recorded locally and visible to the
 * user in Settings → Privacy. There is no network transmission yet.
 * When a destination is wired up later, pending events will be POSTed
 * and `clearPending()` will be called on success.
 */

const AnalyticsManager = {
    STORAGE_KEY: 'analytics',
    MAX_EVENTS: 500,
    MAX_PROP_VALUE_LENGTH: 64,

    ENDPOINT: 'https://anjadhe-analytics.ram-bakthavachalam.workers.dev/events',
    UPLOAD_MIN_INTERVAL_MS: 60 * 60 * 1000, // at most once per hour
    UPLOAD_STARTUP_DELAY_MS: 5000,

    // After this many launches, if the user hasn't opted in and we've
    // never asked, surface the one-time nudge. Three is enough that
    // the user has seen value in the app before the ask.
    NUDGE_AFTER_LAUNCHES: 3,

    // The complete set of event names we allow. Anything not on this
    // list is rejected — prevents accidental content leakage through
    // a typo'd event name.
    VOCABULARY: Object.freeze({
        'app.opened':           { app: 'string' },
        'email.analyzed':       { result: 'string', model: 'string' },
        'email.action_synced':  {},
        'agent.query.sent':     { model: 'string' },
        'agent.reply.feedback': { rating: 'string' },
        'goal.status_updated':  {},
        'schedule.task_completed': {},
        'journal.entry_written':   {},
        'settings.analytics_enabled':  {},
        'settings.analytics_disabled': {},
    }),

    _state: null,

    // The opt-in decision (enabled + "already asked") must outlive the
    // analytics blob, which is sync-excluded and constantly rewritten by
    // event recording/uploads — a stale or racing blob write was wiping
    // the decision, so the nudge kept reappearing. localStorage is
    // machine-local (analytics is per-device by design anyway), durable,
    // and isolated from that churn, so it is the source of truth for the
    // decision bits. The blob still holds installId + pending events.
    LS_ENABLED_KEY: 'analytics.enabled',
    LS_NUDGED_KEY: 'analytics.nudgedAt',

    _lsGet(key) {
        try { return localStorage.getItem(key); } catch { return null; }
    },
    _lsSet(key, value) {
        try { localStorage.setItem(key, String(value)); } catch {}
    },

    _load() {
        if (this._state) return this._state;
        const stored = (typeof StorageManager !== 'undefined' && StorageManager.get(this.STORAGE_KEY)) || {};
        this._state = {
            enabled: stored.enabled === true,
            installId: stored.installId || this._generateInstallId(),
            events: Array.isArray(stored.events) ? stored.events.slice(-this.MAX_EVENTS) : [],
            lastUploadAt: typeof stored.lastUploadAt === 'number' ? stored.lastUploadAt : 0,
            launchCount: typeof stored.launchCount === 'number' ? stored.launchCount : 0,
            nudgedAt: typeof stored.nudgedAt === 'number' ? stored.nudgedAt : 0,
        };
        // Durable decision bits win over whatever the blob says.
        const lsEnabled = this._lsGet(this.LS_ENABLED_KEY);
        if (lsEnabled !== null) this._state.enabled = lsEnabled === 'true';
        const lsNudged = this._lsGet(this.LS_NUDGED_KEY);
        if (lsNudged !== null) {
            const n = Number(lsNudged);
            if (Number.isFinite(n) && n > 0) this._state.nudgedAt = n;
        }
        // Persist back if the installId was just generated.
        if (!stored.installId) this._save();
        return this._state;
    },

    _save() {
        if (typeof StorageManager === 'undefined') return;
        StorageManager.set(this.STORAGE_KEY, this._state);
    },

    _generateInstallId() {
        // RFC 4122 v4 via crypto.randomUUID when available, else a best-effort fallback.
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            const v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    },

    _sanitizeProps(name, props) {
        const schema = this.VOCABULARY[name];
        if (!schema || !props) return {};
        const out = {};
        for (const key of Object.keys(schema)) {
            const value = props[key];
            if (value === undefined || value === null) continue;
            const expected = schema[key];
            if (typeof value !== expected) continue;
            if (typeof value === 'string' && value.length > this.MAX_PROP_VALUE_LENGTH) continue;
            out[key] = value;
        }
        return out;
    },

    isEnabled() {
        return this._load().enabled;
    },

    getInstallId() {
        return this._load().installId;
    },

    setEnabled(enabled) {
        const state = this._load();
        const wasEnabled = state.enabled;
        state.enabled = !!enabled;
        // Durable, churn-proof source of truth for the decision.
        this._lsSet(this.LS_ENABLED_KEY, state.enabled);
        this._save();
        // Record the toggle itself (meta-event) so we know whether the
        // user opted in or out — but only while analytics are on.
        if (!wasEnabled && state.enabled) {
            this.record('settings.analytics_enabled');
        } else if (wasEnabled && !state.enabled) {
            // Write the disabled event before we lose the chance, but
            // only if we still had consent at record time.
            const prevEnabled = state.enabled;
            state.enabled = true;
            this.record('settings.analytics_disabled');
            state.enabled = prevEnabled;
            this._save();
        }
    },

    record(name, props) {
        const state = this._load();
        if (!state.enabled) return;
        if (!this.VOCABULARY[name]) {
            console.warn(`[analytics] ignoring unknown event: ${name}`);
            return;
        }
        const entry = {
            name,
            ts: Date.now(),
            props: this._sanitizeProps(name, props),
        };
        state.events.push(entry);
        if (state.events.length > this.MAX_EVENTS) {
            state.events = state.events.slice(-this.MAX_EVENTS);
        }
        this._save();
    },

    getPendingEvents() {
        return this._load().events.slice();
    },

    getPendingPayload() {
        const state = this._load();
        return {
            installId: state.installId,
            events: state.events.slice(),
            generatedAt: Date.now(),
        };
    },

    clearPendingEvents() {
        const state = this._load();
        state.events = [];
        this._save();
    },

    getVocabulary() {
        return Object.keys(this.VOCABULARY);
    },

    getLastUploadAt() {
        return this._load().lastUploadAt;
    },

    noteLaunch() {
        const state = this._load();
        state.launchCount = (state.launchCount || 0) + 1;
        this._save();
    },

    shouldNudgeOptIn() {
        const state = this._load();
        if (state.enabled) return false;
        if (state.nudgedAt) return false;
        return state.launchCount >= this.NUDGE_AFTER_LAUNCHES;
    },

    markNudged() {
        const state = this._load();
        state.nudgedAt = Date.now();
        this._lsSet(this.LS_NUDGED_KEY, state.nudgedAt);
        this._save();
    },

    _uploadInFlight: false,

    async uploadIfDue(options = {}) {
        const force = options.force === true;
        const state = this._load();
        if (!state.enabled) return { skipped: 'disabled' };
        if (!this.ENDPOINT) return { skipped: 'no_endpoint' };
        if (state.events.length === 0) return { skipped: 'empty' };
        if (this._uploadInFlight) return { skipped: 'in_flight' };
        if (!force && state.lastUploadAt && Date.now() - state.lastUploadAt < this.UPLOAD_MIN_INTERVAL_MS) {
            return { skipped: 'too_soon' };
        }

        this._uploadInFlight = true;
        const batch = state.events.slice();
        try {
            const response = await fetch(this.ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    installId: state.installId,
                    events: batch,
                    generatedAt: Date.now(),
                }),
            });
            if (!response.ok) {
                return { error: `server ${response.status}` };
            }
            // Remove only the events we uploaded; events recorded during
            // the request stay in the buffer for next run.
            const uploadedCount = batch.length;
            state.events = state.events.slice(uploadedCount);
            state.lastUploadAt = Date.now();
            this._save();
            return { uploaded: uploadedCount };
        } catch (err) {
            return { error: (err && err.message) || 'network' };
        } finally {
            this._uploadInFlight = false;
        }
    },

    scheduleStartupUpload() {
        setTimeout(() => {
            this.uploadIfDue().catch(() => {});
        }, this.UPLOAD_STARTUP_DELAY_MS);

        // Keep trying while the app stays open so long-running windows
        // don't accumulate events for days. The per-hour throttle inside
        // uploadIfDue gates actual network calls.
        if (!this._backgroundTimer) {
            this._backgroundTimer = setInterval(() => {
                this.uploadIfDue().catch(() => {});
            }, this.UPLOAD_MIN_INTERVAL_MS);
        }
    },
};

if (typeof window !== 'undefined') {
    window.AnalyticsManager = AnalyticsManager;
}
