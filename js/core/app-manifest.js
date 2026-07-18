/**
 * App Manifest (v1) — validation for user-built apps.
 *
 * A user app is a folder under ~/Anjadhe/apps/<id>/ containing:
 *   manifest.json  — this document
 *   app.js         — entry script; must call Anjadhe.registerApp({...})
 *   app.css        — optional stylesheet (design-system variables, see CLAUDE.md)
 *
 * Validation is shape-only and side-effect free; collision checks against
 * the live registry happen at mount time in AppManager. The platform plan
 * and full contract live in docs/PLATFORM.md.
 */

const AppManifest = {
    VERSION: 1,

    // Ids that can never be claimed by a user app: routes and DOM ids that
    // exist outside the app registry (built-in app ids are caught at mount
    // time by the registry collision check instead, so this list doesn't
    // need to chase new built-ins).
    RESERVED_IDS: new Set(['home', 'dashboard', 'setup', 'app', 'views', 'prompts']),

    ID_RE: /^[a-z][a-z0-9-]{1,40}$/,

    /**
     * Portability of an app, derived from its entry (docs/PLATFORM.md). A spec
     * app (app.spec.json) is pure data the shared engine renders, so it runs on
     * Mac AND the iOS companion. A code app (app.js) runs JS, which is Mac-only.
     * iOS sync surfaces only portable apps. `entry` is the manifest's entry (or
     * a whole manifest — both accepted).
     * @returns {'portable'|'mac-only'}
     */
    portabilityOf(entryOrManifest) {
        const entry = (entryOrManifest && typeof entryOrManifest === 'object')
            ? entryOrManifest.entry
            : entryOrManifest;
        return entry === 'app.spec.json' ? 'portable' : 'mac-only';
    },

    portabilityLabel(p) {
        return p === 'portable' ? 'Mac + iPhone' : 'Mac only';
    },

    /**
     * Validate a parsed manifest object.
     * @returns {{ok: boolean, errors: string[], manifest?: object}} —
     *   on success, `manifest` is a normalized copy with defaults filled in.
     */
    validate(raw) {
        const errors = [];
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return { ok: false, errors: ['manifest.json must be a JSON object'] };
        }
        if (raw.manifestVersion !== this.VERSION) {
            errors.push(`manifestVersion must be ${this.VERSION}`);
        }
        if (typeof raw.id !== 'string' || !this.ID_RE.test(raw.id)) {
            errors.push('id must be kebab-case (lowercase letters, digits, hyphens), start with a letter, 2-41 chars');
        } else if (this.RESERVED_IDS.has(raw.id)) {
            errors.push(`id "${raw.id}" is reserved`);
        }
        if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.trim().length > 40) {
            errors.push('name is required (max 40 chars)');
        }
        if (raw.icon != null && (typeof raw.icon !== 'string' || raw.icon.length > 24)) {
            errors.push('icon must be a short string — an HTML entity like &#9670; (no emoji in code)');
        }
        if (raw.version != null && typeof raw.version !== 'string') {
            errors.push('version must be a string');
        }
        if (raw.description != null && typeof raw.description !== 'string') {
            errors.push('description must be a string');
        }
        if (raw.entry != null && raw.entry !== 'app.js' && raw.entry !== 'app.spec.json') {
            errors.push('entry must be "app.js" (code app) or "app.spec.json" (spec app)');
        }
        if (raw.keywords != null && (!Array.isArray(raw.keywords) || raw.keywords.some(k => typeof k !== 'string'))) {
            errors.push('keywords must be an array of strings');
        }
        if (raw.reads != null && (!Array.isArray(raw.reads) || raw.reads.some(r => typeof r !== 'string' || !/^[a-z][a-z0-9-]{0,40}$/.test(r)))) {
            errors.push('reads must be an array of built-in app names (e.g. ["journal", "schedule"])');
        }
        if (errors.length) return { ok: false, errors };

        return {
            ok: true,
            errors: [],
            manifest: {
                manifestVersion: this.VERSION,
                id: raw.id,
                name: raw.name.trim(),
                icon: raw.icon || '&#9670;',
                version: raw.version || '0.1.0',
                description: raw.description || '',
                entry: raw.entry || 'app.js',
                keywords: raw.keywords || [],
                reads: raw.reads || []
            }
        };
    }
};

// Loadable as a browser global and as a Node module (tests). Guarded so the
// browser path is untouched.
if (typeof module !== 'undefined' && module.exports) module.exports = AppManifest;
