/**
 * MemoryManager - persistent, cross-session memories for the Anjadhe Agent.
 *
 * Memories capture stable facts, preferences, ongoing context, and
 * corrections the user has given. Unlike the briefing (derived from
 * structured app data each conversation), these are free-form notes
 * that survive across chats and sync across machines.
 *
 * Storage key is `agent-memories` and participates in the normal sync
 * journal — memories follow the user to every Mac.
 */
const MemoryManager = {
    _storageKey: 'agent-memories',
    memories: [],
    // ISO timestamp of the last consolidation pass. Persisted alongside the
    // memories and synced so the daily merge runs once across all machines
    // (mirrors PromptFeed's per-run dedup), not independently on each Mac.
    consolidatedAt: null,
    _loaded: false,

    // Allowed types. Keep this list narrow — extraction prompts and UI
    // rendering both branch on it, so expanding the enum means updating
    // both. See the Jan-2026 design discussion for rationale.
    TYPES: ['preference', 'fact', 'context', 'correction'],

    init() {
        if (this._loaded) return;
        try {
            const data = StorageManager.get(this._storageKey);
            this.memories = (data && Array.isArray(data.memories)) ? data.memories : [];
            this.consolidatedAt = (data && data.consolidatedAt) || null;
        } catch (e) {
            console.warn('[memory] load failed:', e);
            this.memories = [];
            this.consolidatedAt = null;
        }
        this._loaded = true;
    },

    _save() {
        try {
            StorageManager.set(this._storageKey, {
                memories: this.memories,
                consolidatedAt: this.consolidatedAt
            });
        } catch (e) {
            console.warn('[memory] save failed:', e);
        }
    },

    _newId() {
        return 'mem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    },

    /**
     * Create a memory. Required: type, body. Optional: title, profile, source.
     * `profile` null means "applies everywhere"; set a profile id to scope
     * work-only or personal-only context.
     */
    create({ type, title, body, profile, source } = {}) {
        this.init();
        if (!body || typeof body !== 'string') throw new Error('memory body required');
        if (!this.TYPES.includes(type)) throw new Error(`invalid memory type: ${type}`);

        const now = new Date().toISOString();
        const memory = {
            id: this._newId(),
            type,
            title: (title || body.slice(0, 60)).trim(),
            body: body.trim(),
            profile: profile || null,
            createdAt: now,
            updatedAt: now,
            lastUsedAt: null,
            usageCount: 0,
            source: source || 'manual'
        };
        this.memories.unshift(memory);
        this._save();
        return memory;
    },

    get(id) {
        this.init();
        return this.memories.find(m => m.id === id) || null;
    },

    update(id, patch) {
        this.init();
        const m = this.memories.find(x => x.id === id);
        if (!m) return null;
        const allowed = ['type', 'title', 'body', 'profile'];
        for (const k of allowed) {
            if (patch[k] !== undefined) m[k] = patch[k];
        }
        if (patch.type && !this.TYPES.includes(patch.type)) {
            throw new Error(`invalid memory type: ${patch.type}`);
        }
        m.updatedAt = new Date().toISOString();
        this._save();
        return m;
    },

    delete(id) {
        this.init();
        const before = this.memories.length;
        this.memories = this.memories.filter(m => m.id !== id);
        const changed = this.memories.length !== before;
        if (changed) this._save();
        return changed;
    },

    /**
     * Filtered list. All filters optional. Profile filter is inclusive of
     * null (global) by default — pass `onlyProfile: true` to exclude globals.
     */
    list({ type, profile, source, onlyProfile } = {}) {
        this.init();
        let out = this.memories.slice();
        if (type) out = out.filter(m => m.type === type);
        if (source) out = out.filter(m => m.source === source);
        if (profile !== undefined) {
            out = out.filter(m => (onlyProfile ? m.profile === profile : (m.profile === null || m.profile === profile)));
        }
        return out;
    },

    /**
     * Simple substring search across title+body. Case-insensitive. Returns
     * matches ordered by a tiny relevance score (title hit > body hit),
     * then recency. Good enough for an on-demand tool; swap for embeddings
     * later if the set grows past a few hundred memories.
     */
    search(query, { profile, limit = 20 } = {}) {
        this.init();
        if (!query || typeof query !== 'string') return [];
        const q = query.trim().toLowerCase();
        if (!q) return [];

        const candidates = profile !== undefined
            ? this.memories.filter(m => m.profile === null || m.profile === profile)
            : this.memories;

        const scored = [];
        for (const m of candidates) {
            const titleHit = m.title.toLowerCase().includes(q);
            const bodyHit = m.body.toLowerCase().includes(q);
            if (!titleHit && !bodyHit) continue;
            scored.push({ m, score: (titleHit ? 2 : 0) + (bodyHit ? 1 : 0) });
        }
        scored.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return (b.m.updatedAt || '').localeCompare(a.m.updatedAt || '');
        });
        return scored.slice(0, limit).map(s => s.m);
    },

    /**
     * Top N memories for inlining into the agent's briefing. Ranks by a
     * recency+usage blend so frequently-useful memories stay near the top
     * but new ones can still surface. Corrections are always boosted —
     * they're the memories that most often prevent repeat mistakes.
     */
    topForBriefing({ profile, limit = 10 } = {}) {
        this.init();
        const now = Date.now();
        const pool = profile !== undefined
            ? this.memories.filter(m => m.profile === null || m.profile === profile)
            : this.memories.slice();

        const scored = pool.map(m => {
            const createdMs = Date.parse(m.createdAt) || now;
            const usedMs = m.lastUsedAt ? Date.parse(m.lastUsedAt) : createdMs;
            const ageDays = Math.max(0, (now - createdMs) / 86400000);
            const idleDays = Math.max(0, (now - usedMs) / 86400000);
            let score = (m.usageCount || 0) * 2;
            score += 10 / (idleDays + 1);
            score += 3 / (ageDays + 7);
            if (m.type === 'correction') score += 5;
            return { m, score };
        });
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, limit).map(s => s.m);
    },

    /**
     * Bump usage counter when a memory is read by the agent. Batched save
     * avoids thrashing storage when many memories are touched in one turn.
     */
    recordUsage(ids) {
        this.init();
        const list = Array.isArray(ids) ? ids : [ids];
        const now = new Date().toISOString();
        let changed = false;
        for (const id of list) {
            const m = this.memories.find(x => x.id === id);
            if (!m) continue;
            m.usageCount = (m.usageCount || 0) + 1;
            m.lastUsedAt = now;
            changed = true;
        }
        if (changed) this._save();
    },

    /**
     * Dedupe helper used by extraction and the save_memory tool. Matches
     * case-insensitive equality on body OR a title+type match. Returns the
     * existing memory if one is found, else null.
     */
    findDuplicate({ type, title, body, profile }) {
        this.init();
        const bodyNorm = (body || '').trim().toLowerCase();
        const titleNorm = (title || '').trim().toLowerCase();
        return this.memories.find(m => {
            if (m.profile !== (profile || null)) return false;
            if (m.body.trim().toLowerCase() === bodyNorm) return true;
            if (type && m.type === type && titleNorm && m.title.trim().toLowerCase() === titleNorm) return true;
            return false;
        }) || null;
    },

    // ─────────────────────── Consolidation / pruning ───────────────────────
    //
    // The agent auto-extracts memories after conversations, so the store grows
    // unbounded and accumulates near-duplicates (extraction dedup only catches
    // *exact* body matches). A daily pass keeps it tight: a cheap deterministic
    // exact-dedup, then a model-driven merge of overlapping memories. Both are
    // strictly merge-only — a unique fact is never silently dropped, only
    // collapsed into a memory that already covers it. The model orchestration
    // lives in AgentService (it owns the local model); these are the data
    // primitives it drives.

    getConsolidatedAt() {
        this.init();
        return this.consolidatedAt;
    },

    markConsolidated() {
        this.init();
        this.consolidatedAt = new Date().toISOString();
        this._save();
    },

    // Pick the member that should absorb the others: most-used first, then
    // oldest (its createdAt anchors the merged memory's age).
    _pickSurvivor(members) {
        return members.slice().sort((a, b) => {
            const ua = a.usageCount || 0, ub = b.usageCount || 0;
            if (ub !== ua) return ub - ua;
            return (a.createdAt || '').localeCompare(b.createdAt || '');
        })[0];
    },

    // Fold the stats of every member into the survivor: usage sums (so a
    // merged memory keeps its earned ranking weight), age is the earliest
    // createdAt, last-used is the most recent. A manual member makes the
    // result manual — the user authored it, so it shouldn't be treated as
    // disposable extracted data.
    _absorb(survivor, members) {
        let usage = 0;
        let earliest = survivor.createdAt || null;
        let latest = survivor.lastUsedAt || null;
        let manual = false;
        for (const m of members) {
            usage += (m.usageCount || 0);
            if (m.createdAt && (!earliest || m.createdAt < earliest)) earliest = m.createdAt;
            if (m.lastUsedAt && (!latest || m.lastUsedAt > latest)) latest = m.lastUsedAt;
            if (m.source === 'manual') manual = true;
        }
        survivor.usageCount = usage;
        if (earliest) survivor.createdAt = earliest;
        survivor.lastUsedAt = latest;
        if (manual) survivor.source = 'manual';
    },

    /**
     * Deterministic, model-free pass: collapse memories whose bodies are
     * exactly equal (case-insensitive), scoped within the same profile.
     * Returns the number of memories removed. Safe with no local model, so
     * remote-only users still benefit.
     */
    exactDedup() {
        this.init();
        const groups = new Map();
        for (const m of this.memories) {
            const key = (m.profile || '') + '\x00' + m.body.trim().toLowerCase();
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(m);
        }
        const removeIds = new Set();
        const now = new Date().toISOString();
        for (const members of groups.values()) {
            if (members.length < 2) continue;
            const survivor = this._pickSurvivor(members);
            this._absorb(survivor, members);
            survivor.updatedAt = now;
            for (const m of members) if (m !== survivor) removeIds.add(m.id);
        }
        if (removeIds.size) {
            this.memories = this.memories.filter(m => !removeIds.has(m.id));
            this._save();
        }
        return removeIds.size;
    },

    /**
     * Swap a set of existing memories for a model-rewritten, consolidated set.
     * Deletes `oldIds`, inserts `newItems` (each `{ type, body, title?, profile?,
     * createdAt?, lastUsedAt?, usageCount?, source? }`), and persists once.
     * Items with no body or an invalid type are skipped. Used by the chunked
     * consolidation pass — see AgentService._consolidateChunk for the safety
     * guards (never called with an empty/blanking result). Returns
     * `{ removed, created }`.
     */
    replaceChunk(oldIds, newItems) {
        this.init();
        const removeSet = new Set(Array.isArray(oldIds) ? oldIds : []);
        const before = this.memories.length;
        this.memories = this.memories.filter(m => !removeSet.has(m.id));
        const removed = before - this.memories.length;

        const now = new Date().toISOString();
        let created = 0;
        for (const it of (Array.isArray(newItems) ? newItems : [])) {
            const body = (it && it.body || '').trim();
            if (!body || !this.TYPES.includes(it.type)) continue;
            this.memories.unshift({
                id: this._newId(),
                type: it.type,
                title: (it.title || body.slice(0, 60)).trim(),
                body,
                profile: it.profile || null,
                createdAt: it.createdAt || now,
                updatedAt: now,
                lastUsedAt: it.lastUsedAt || null,
                usageCount: it.usageCount || 0,
                source: it.source || 'extracted'
            });
            created++;
        }

        this._save();
        return { removed, created };
    },

    // ─────────────────────── Memory profile (categorized summary) ───────────────────────
    //
    // The user-facing surface for memory is no longer a flat list of items — it
    // is a small set of editable, categorized sections (a "profile"): Who I am,
    // Career, Food, Hobbies, etc. Each section is a short free-text summary the
    // user can read and edit directly on the assistant page.
    //
    // The flat `agent-memories` store above is kept as the raw capture LOG
    // (extraction + save_memory still write there). A background compaction pass
    // (AgentService.compactMemoryProfile) folds unabsorbed log items into these
    // sections, deduping and resolving contradictions, then marks the items
    // `absorbedAt` so they aren't re-filed. The sections are the truth the model
    // sees; the log is the audit trail underneath.
    //
    // Sections are scoped to a concrete profile id (never null) so each profile
    // keeps an independent summary. Storage key `agent-memory-profile` syncs
    // normally, like the log.

    _profileKey: 'agent-memory-profile',
    profileSections: [],
    profileSeeded: {},      // profileId -> true once defaults have been seeded
    profileCompactedAt: null,
    profileMigratedAt: null,
    _profileLoaded: false,

    // Starter sections. `key` is a stable slug used by compaction to address a
    // section; `title` is what the user sees; `hint` guides the model on what
    // belongs here (never shown to the user). Order is the display order.
    DEFAULT_SECTIONS: [
        { key: 'about', title: 'Who I am', hint: 'Identity: name, age, where they live, background, life situation.' },
        { key: 'career', title: 'Career & work', hint: 'Job, company, role, ongoing projects, skills, professional goals.' },
        { key: 'food', title: 'Food & drink', hint: 'Foods, cuisines and drinks they like or avoid; dietary restrictions and allergies.' },
        { key: 'hobbies', title: 'Hobbies & interests', hint: 'Pastimes, sports, games, creative pursuits, subjects they follow.' },
        { key: 'favourites', title: 'Favourites', hint: 'Favourite media, music, books, shows, brands, places, teams.' },
        { key: 'relationships', title: 'People & relationships', hint: 'Family, partner, friends, colleagues, pets — names and who they are.' },
        { key: 'preferences', title: 'How to help me', hint: 'How the assistant should behave: tone, format, language, and do/don\'t corrections.' },
        { key: 'other', title: 'Other', hint: 'Anything lasting and personal that does not fit another section.' }
    ],

    _initProfile() {
        if (this._profileLoaded) return;
        try {
            const data = StorageManager.get(this._profileKey);
            this.profileSections = (data && Array.isArray(data.sections)) ? data.sections : [];
            this.profileSeeded = (data && data.seeded && typeof data.seeded === 'object') ? data.seeded : {};
            this.profileCompactedAt = (data && data.compactedAt) || null;
            this.profileMigratedAt = (data && data.migratedAt) || null;
        } catch (e) {
            console.warn('[memory-profile] load failed:', e);
            this.profileSections = [];
            this.profileSeeded = {};
            this.profileCompactedAt = null;
            this.profileMigratedAt = null;
        }
        this._profileLoaded = true;
    },

    _saveProfile() {
        try {
            StorageManager.set(this._profileKey, {
                sections: this.profileSections,
                seeded: this.profileSeeded,
                compactedAt: this.profileCompactedAt,
                migratedAt: this.profileMigratedAt
            });
        } catch (e) {
            console.warn('[memory-profile] save failed:', e);
        }
    },

    // Resolve the profile a section operation applies to. `undefined` means
    // "the active profile"; an explicit value is used as-is. ProfileManager
    // returns 'default' when the user has no profiles, so sections always carry
    // a concrete id.
    _effProfile(profile) {
        if (profile !== undefined) return profile || 'default';
        try {
            if (typeof ProfileManager !== 'undefined' && ProfileManager.getActiveProfileId) {
                return ProfileManager.getActiveProfileId() || 'default';
            }
        } catch { /* fall through */ }
        return 'default';
    },

    _newSectionId() {
        return 'sec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    },

    // Seed the default sections for a profile the first time it's viewed.
    // Tracked in `profileSeeded` so a user who deletes a built-in section
    // doesn't have it silently resurrected on the next read.
    _seedProfile(profile) {
        const p = this._effProfile(profile);
        if (this.profileSeeded[p]) return;
        const now = new Date().toISOString();
        this.DEFAULT_SECTIONS.forEach((d, i) => {
            this.profileSections.push({
                id: this._newSectionId(),
                key: d.key,
                title: d.title,
                body: '',
                builtin: true,
                order: i,
                profile: p,
                userEdited: false,
                userEditedAt: null,
                compactedAt: null,
                createdAt: now,
                updatedAt: now
            });
        });
        this.profileSeeded[p] = true;
        this._saveProfile();
    },

    /** All sections for a profile (active by default), display-ordered. Seeds defaults on first access. */
    listSections(profile) {
        this._initProfile();
        const p = this._effProfile(profile);
        this._seedProfile(p);
        return this.profileSections
            .filter(s => s.profile === p)
            .slice()
            .sort((a, b) => (a.order || 0) - (b.order || 0) || (a.title || '').localeCompare(b.title || ''));
    },

    getSection(id) {
        this._initProfile();
        return this.profileSections.find(s => s.id === id) || null;
    },

    getSectionByKey(key, profile) {
        this._initProfile();
        const p = this._effProfile(profile);
        return this.profileSections.find(s => s.profile === p && s.key === key) || null;
    },

    // Slugify a title into a section key, uniquified within the profile.
    _sectionKeyFromTitle(title, profile) {
        const base = (title || 'section').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'section';
        let key = base, n = 2;
        while (this.getSectionByKey(key, profile)) key = `${base}-${n++}`;
        return key;
    },

    /** Add a user-created section. Returns the new section. */
    addSection({ title, body, profile } = {}) {
        this._initProfile();
        const p = this._effProfile(profile);
        this._seedProfile(p);
        const now = new Date().toISOString();
        const maxOrder = this.profileSections.filter(s => s.profile === p).reduce((m, s) => Math.max(m, s.order || 0), -1);
        const section = {
            id: this._newSectionId(),
            key: this._sectionKeyFromTitle(title, p),
            title: (title || 'Untitled').trim(),
            body: (body || '').trim(),
            builtin: false,
            order: maxOrder + 1,
            profile: p,
            userEdited: true,
            userEditedAt: now,
            compactedAt: null,
            createdAt: now,
            updatedAt: now
        };
        this.profileSections.push(section);
        this._saveProfile();
        return section;
    },

    /**
     * Update a section. `byUser` marks it user-edited so compaction treats the
     * text as authored and won't rewrite it (only gently appends). Compaction
     * passes `fromCompaction` to bump compactedAt without claiming user authorship.
     */
    updateSection(id, patch = {}, { byUser = false, fromCompaction = false } = {}) {
        this._initProfile();
        const s = this.profileSections.find(x => x.id === id);
        if (!s) return null;
        if (patch.title !== undefined) s.title = String(patch.title).trim();
        if (patch.body !== undefined) s.body = String(patch.body).trim();
        const now = new Date().toISOString();
        if (byUser) { s.userEdited = true; s.userEditedAt = now; }
        if (fromCompaction) s.compactedAt = now;
        s.updatedAt = now;
        this._saveProfile();
        return s;
    },

    deleteSection(id) {
        this._initProfile();
        const before = this.profileSections.length;
        this.profileSections = this.profileSections.filter(s => s.id !== id);
        const changed = this.profileSections.length !== before;
        if (changed) this._saveProfile();
        return changed;
    },

    /**
     * Compaction helper: write `body` into the section keyed `key` for a profile,
     * creating the section if the model invented a new one. Never blanks an
     * existing non-empty body. Returns the section (or null if it refused to blank).
     */
    setSectionBody(key, title, body, profile) {
        this._initProfile();
        const p = this._effProfile(profile);
        const text = (body || '').trim();
        const s = this.getSectionByKey(key, p);
        if (s) {
            if (!text && s.body) return null; // never blank existing content
            return this.updateSection(s.id, { body: text, ...(title ? { title } : {}) }, { fromCompaction: true });
        }
        if (!text) return null;
        // Model invented a new section — create it, attributed to compaction.
        const created = this.addSection({ title: title || key, body: text, profile: p });
        created.userEdited = false;
        created.userEditedAt = null;
        created.compactedAt = new Date().toISOString();
        this._saveProfile();
        return created;
    },

    /** Non-empty sections for prompt injection, display-ordered. */
    sectionsForInjection(profile) {
        return this.listSections(profile)
            .filter(s => (s.body || '').trim())
            .map(s => ({ title: s.title, body: s.body.trim() }));
    },

    markProfileCompacted() {
        this._initProfile();
        this.profileCompactedAt = new Date().toISOString();
        this._saveProfile();
    },

    getProfileMigratedAt() {
        this._initProfile();
        return this.profileMigratedAt;
    },

    markProfileMigrated() {
        this._initProfile();
        this.profileMigratedAt = new Date().toISOString();
        this._saveProfile();
    },

    // ───────────── Raw log <-> profile bridge ─────────────

    /**
     * Log items not yet folded into the profile, visible to a profile (global
     * `null` items plus that profile's own). These are fed to compaction and,
     * until then, surfaced to the model as "recently noted" so a just-saved
     * memory is never invisible between compaction passes.
     */
    unabsorbed(profile, { limit } = {}) {
        this.init();
        const p = (profile === undefined) ? undefined : (profile || null);
        let out = this.memories.filter(m => !m.absorbedAt);
        if (p !== undefined) out = out.filter(m => m.profile === null || m.profile === p);
        out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        return (limit ? out.slice(0, limit) : out);
    },

    /** Mark log items as folded into the profile. */
    markAbsorbed(ids) {
        this.init();
        const set = new Set(Array.isArray(ids) ? ids : [ids]);
        const now = new Date().toISOString();
        let changed = false;
        for (const m of this.memories) {
            if (set.has(m.id) && !m.absorbedAt) { m.absorbedAt = now; changed = true; }
        }
        if (changed) this._save();
        return changed;
    }
};
