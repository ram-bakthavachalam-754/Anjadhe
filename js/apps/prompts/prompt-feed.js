/**
 * Prompt Feed
 *
 * Runs prompt-template notes that the user marked "Run offline on a
 * schedule" against the LOCAL model on a fixed interval, and surfaces the
 * generated output as a feed on the Home page (the "Feed" tab).
 *
 * Prompts live as notes (`template === 'prompt'`) in the `notes` blob and
 * are read through the shared NotePrompts helper — `promptId` here is the
 * note's id. (This module predates the merge and kept its name + storage.)
 *
 * Scheduling model mirrors the backup scheduler in main.js: instead of an
 * interval anchored to app launch, we poll the wall clock every few minutes
 * and compare against the last run time per prompt. A run missed while the
 * app was closed is caught up exactly once on the next launch.
 *
 * Storage: run OUTPUTS are notes (`template === 'feed'`) in the shared
 * `notes` blob — one note per run, with the generated markdown converted to
 * sanitized note HTML once at save time and run metadata on
 * `note.feed = { promptId, model, error }`. The feed and the Notes app
 * therefore render the exact same stored content (posts are searchable,
 * pinnable, and editable in Notes under the "Prompt Feed" filter).
 *
 * Storage key `promptFeed` keeps only the scheduler state:
 *   { runs: { [promptId]: <ISO last-run timestamp> } }
 * (a legacy `items` array from the pre-notes feed is migrated into feed
 * notes exactly once on init).
 *
 * Both the prompt notes and the feed notes sync across the user's Macs
 * automatically via the StorageManager journal. `runs` syncing is
 * intentional: it dedupes scheduled runs across devices so the same prompt
 * isn't independently re-run on every machine within one interval.
 */

const PromptFeed = {
    data: { items: [], runs: {} },
    _timer: null,
    _busy: false,
    _nudgeTimer: null,
    _overlay: null,
    _published: null,   // posts published by Anjadhe (remote-config feedPosts)

    // Poll cadence — how often we check whether any prompt is due. The
    // actual run frequency is governed per-prompt by its interval.
    POLL_MS: 5 * 60 * 1000,
    MAX_PER_PROMPT: 20,

    INTERVAL_MS: {
        hourly: 60 * 60 * 1000,
        '6h':   6 * 60 * 60 * 1000,
        daily:  24 * 60 * 60 * 1000,
        weekly: 7 * 24 * 60 * 60 * 1000
    },

    init() {
        this.loadData();
        this._migrateLegacyItems();
        this.render();
        // Posts we publish (release notes, tips) arrive via remote config;
        // repaint once they load so they join the stream.
        this._loadPublished().then(() => this.render());
        this.startScheduler();
        // Feed-header entry points for creating/managing background prompts
        // without leaving the Home page (the dashboard markup is static, so
        // wiring once here is safe).
        document.getElementById('prompt-feed-new')
            ?.addEventListener('click', () => this.openManager({ create: true }));
        document.getElementById('prompt-feed-config')
            ?.addEventListener('click', () => this.openManager());
        this._setupLinkHandler();
    },

    // Delegated click handler for links inside feed content — cards and the
    // full-post overlay both render `.feed-card-body`. The HTML comes from
    // AgentUI.formatContent, whose anchors are target-less; without this,
    // a click tries to navigate the app's BrowserWindow, which main.js
    // blocks (will-navigate), so links silently do nothing. Links open in
    // the in-app Browse tab, iOS-style: a "‹ Back to Feed" strip returns
    // to the exact post that was being read (external browser only as a
    // fallback when Browse isn't available).
    _setupLinkHandler() {
        if (this._linkHandlerWired) return;
        this._linkHandlerWired = true;
        document.addEventListener('click', (e) => {
            const a = e.target && e.target.closest && e.target.closest('.feed-card-body a[href]');
            if (!a) return;
            const href = a.getAttribute('href');
            if (!href || !/^https?:/i.test(href)) return;
            e.preventDefault();
            // Capture the open post BEFORE openApp('browse') closes it.
            const ov = this._overlay;
            const postId = (ov && !ov.hidden) ? ov._itemId : null;
            if (typeof AppManager !== 'undefined' && AppManager.openInBrowse) {
                AppManager.openInBrowse(href, {
                    label: 'Back to Feed',
                    onBack: () => {
                        AppManager.showDashboard();
                        if (postId) setTimeout(() => this.openPost(postId), 60);
                    }
                });
            } else if (window.electronAuth?.openExternal) {
                window.electronAuth.openExternal(href);
            } else {
                window.open(href, '_blank');
            }
        });
    },

    loadData() {
        const d = StorageManager.get('promptFeed');
        this.data = {
            // Legacy pre-notes posts; kept in the shape (and re-saved) until
            // _migrateLegacyItems has folded them into feed notes, so an
            // early saveData can never drop unmigrated posts.
            items: (d && Array.isArray(d.items)) ? d.items : [],
            runs: (d && d.runs && typeof d.runs === 'object') ? d.runs : {}
        };
    },

    saveData() {
        StorageManager.set('promptFeed', this.data);
    },

    /* ---------- Feed notes (run outputs) ----------
     *
     * Outputs live in the shared `notes` blob as 'feed'-template notes, read
     * and written through NotePrompts' blob helpers so the Notes app's
     * in-memory copy stays coherent.
     */

    _isFeedNote(n) {
        return !!n && (typeof NoteTemplates !== 'undefined'
            ? NoteTemplates.resolve(n) === 'feed'
            : n.template === 'feed');
    },

    _feedNotes() {
        if (typeof NotePrompts === 'undefined') return [];
        return NotePrompts._readNotes().filter(n => this._isFeedNote(n));
    },

    // Render model the feed cards/post view consume. `html` is the stored,
    // already-formatted note content — no per-render markdown pass.
    _cardModel(n) {
        return {
            id: n.id,
            promptId: (n.feed && n.feed.promptId) || null,
            promptTitle: n.title || 'Untitled prompt',
            html: n.content || '',
            error: (n.feed && n.feed.error) || null,
            model: (n.feed && n.feed.model) || null,
            createdAt: n.createdAt
        };
    },

    _item(id) {
        if (String(id).startsWith('pub-')) {
            return this._publishedModels().find(x => x.id === id) || null;
        }
        const n = this._feedNotes().find(x => x.id === id);
        return n ? this._cardModel(n) : null;
    },

    // If the user is looking at the Notes app while a scheduled run posts,
    // repaint it so the new feed note shows up without a manual refresh.
    _refreshNotesApp() {
        if (typeof AppManager !== 'undefined' && AppManager.currentApp === 'notes'
            && typeof NotesApp !== 'undefined' && NotesApp.render) {
            NotesApp.render();
        }
    },

    // One-time migration: fold pre-notes feed posts (`promptFeed.items`)
    // into feed notes so existing history keeps rendering. Item ids are
    // reused as note ids, so a re-run (or a second Mac migrating the same
    // synced items concurrently) cannot duplicate posts.
    _migrateLegacyItems() {
        if (!this.data.items.length || typeof NotePrompts === 'undefined') return;
        const notes = NotePrompts._readNotes();
        const existing = new Set(notes.map(n => n.id));
        // items is newest-first; prepending preserves that order.
        const migrated = this.data.items
            .filter(it => it && it.id && !existing.has(it.id))
            .map(it => ({
                id: it.id,
                title: it.promptTitle || 'Untitled prompt',
                content: it.error ? '' : this._format(it.content),
                tags: [],
                template: 'feed',
                feed: {
                    promptId: it.promptId || null,
                    model: it.model || null,
                    error: it.error || null
                },
                profile: it.profile || 'default',
                pinned: false,
                showOnHome: false,
                createdAt: it.createdAt || new Date().toISOString(),
                modifiedAt: it.createdAt || new Date().toISOString()
            }));
        if (migrated.length) NotePrompts._writeNotes([...migrated, ...notes]);
        this.data.items = [];
        this.saveData();
    },

    /* ---------- Scheduler ---------- */

    startScheduler() {
        if (this._timer) clearInterval(this._timer);
        // Catch-up pass for runs missed while the app was closed. Deferred
        // past first paint so it doesn't contend with model prewarm or
        // block launch on a cold local-model load.
        setTimeout(() => this.tick(), 8000);
        this._timer = setInterval(() => this.tick(), this.POLL_MS);
    },

    // Called by NotesApp when a prompt note is saved so a newly enabled
    // background prompt starts producing without waiting for the next poll.
    // Debounced so a flurry of edits triggers one pass.
    onPromptsChanged() {
        if (this._nudgeTimer) clearTimeout(this._nudgeTimer);
        this._nudgeTimer = setTimeout(() => this.tick(), 1500);
    },

    // Prompts are now notes with the 'prompt' template. Read them via the
    // shared NotePrompts helper so the feed and the editor agree on what a
    // prompt is and how its config/body are derived.
    _offlinePrompts() {
        if (typeof NotePrompts === 'undefined') return [];
        return NotePrompts.list().filter(n =>
            NotePrompts.config(n).offline && NotePrompts.bodyText(n).trim());
    },

    _isDue(prompt, now) {
        const last = this.data.runs[prompt.id];
        if (!last) return true;
        const cfg = NotePrompts.config(prompt);
        const lastMs = new Date(last).getTime();
        // Daily/weekly prompts with a preferred run time anchor to the wall
        // clock ("every morning at 8") instead of drifting from the last run.
        // Due when the most recent HH:MM occurrence hasn't been run yet —
        // weekly additionally waits out most of its interval so the 6-day
        // guard tolerates the run landing at the anchor time, not 7×24h later.
        if (cfg.time && (cfg.interval === 'daily' || cfg.interval === 'weekly')) {
            const [h, m] = cfg.time.split(':').map(Number);
            const occ = new Date(now);
            occ.setHours(h, m, 0, 0);
            if (occ.getTime() > now) occ.setDate(occ.getDate() - 1);
            if (lastMs >= occ.getTime()) return false;
            if (cfg.interval === 'weekly') return (now - lastMs) >= 6 * this.INTERVAL_MS.daily;
            return true;
        }
        const span = this.INTERVAL_MS[cfg.interval] || this.INTERVAL_MS.daily;
        return (now - lastMs) >= span;
    },

    async tick() {
        if (this._busy) return;
        const prompts = this._offlinePrompts();
        if (prompts.length === 0) return;

        this._busy = true;
        try {
            const now = Date.now();
            for (const p of prompts) {
                if (!this._isDue(p, now)) continue;
                await this._runPrompt(p);
            }
        } finally {
            this._busy = false;
        }
    },

    // Manual trigger from a prompt card's "Run now" button. Bypasses the
    // due check but still respects the busy guard so it can't overlap a
    // scheduled pass or another manual run. Stamping the run time also
    // shifts the next scheduled run, which is the expected behaviour.
    async runNow(promptId) {
        const p = (typeof NotePrompts !== 'undefined')
            ? NotePrompts.list().find(x => x.id === promptId)
            : null;
        if (!p || !NotePrompts.bodyText(p).trim()) {
            UIUtils.showToast('Nothing to run', 'error');
            return;
        }
        if (this._busy) {
            UIUtils.showToast('A run is already in progress', 'info');
            return;
        }
        this._busy = true;
        UIUtils.showToast(`Running "${p.title || 'prompt'}" offline…`, 'info');
        try {
            const note = await this._runPrompt(p);
            if (note && !note.feed.error) UIUtils.showToast('Added to Feed', 'success');
            else UIUtils.showToast(note?.feed?.error || 'Run failed', 'error');
        } catch (e) {
            UIUtils.showToast(e?.message || 'Run failed', 'error');
        } finally {
            this._busy = false;
        }
    },

    /* ---------- Manage prompts (create / edit / schedule) ----------
     *
     * A modal launched from the feed header. Lists the background prompts in the
     * active profile and lets the user create/edit/delete them inline — writing
     * the same prompt-notes the Notes editor does (via NotePrompts), so the two
     * stay in sync. The modal body re-renders between a list view and a form
     * view; the modal stays open across the switch.
     */

    // Scheduled (offline) prompt notes for the active profile, newest first.
    _managerPrompts() {
        if (typeof NotePrompts === 'undefined') return [];
        let list = NotePrompts.list().filter(n => NotePrompts.config(n).offline);
        if (typeof ProfileManager !== 'undefined' && ProfileManager.filterByActiveProfile) {
            list = ProfileManager.filterByActiveProfile(list);
        }
        return list.sort((a, b) =>
            new Date(b.modifiedAt || 0).getTime() - new Date(a.modifiedAt || 0).getTime());
    },

    openManager(opts = {}) {
        if (typeof Modal === 'undefined') return;
        const container = document.createElement('div');
        container.className = 'prompt-mgr';
        const modal = Modal.create({
            title: 'Manage prompts',
            className: 'prompt-mgr-dialog',
            content: container,
            onClose: () => { this._mgr = null; }
        });
        this._mgr = { modal, container };
        if (opts.create) this._renderManagerForm(container, null);
        else this._renderManagerList(container);
    },

    _renderManagerList(container) {
        const prompts = this._managerPrompts();
        const rows = prompts.map(p => {
            const cfg = NotePrompts.config(p);
            const last = this.data.runs[p.id];
            const ran = last ? `ran ${this._timeAgo(last)}` : 'not run yet';
            const chips = [
                `<span class="prompt-mgr-chip">&#9201; ${NotePrompts.scheduleLabel(cfg)}</span>`,
                cfg.web ? '<span class="prompt-mgr-chip">&#127760; web</span>' : '',
                cfg.useContext ? '<span class="prompt-mgr-chip">&#10024; my context</span>' : ''
            ].filter(Boolean).join('');
            return `
                <div class="prompt-mgr-row" data-id="${p.id}">
                    <span class="prompt-mgr-row-icon" aria-hidden="true">&#9889;</span>
                    <div class="prompt-mgr-row-main">
                        <div class="prompt-mgr-row-title">${UIUtils.escapeHtml(p.title || 'Untitled prompt')}</div>
                        <div class="prompt-mgr-row-meta">${chips}<span class="prompt-mgr-row-ran">${ran}</span></div>
                    </div>
                    <div class="prompt-mgr-row-actions">
                        <button class="prompt-mgr-run" data-id="${p.id}" type="button" title="Run this prompt now">&#9654; Run</button>
                        <button class="prompt-mgr-iconbtn prompt-mgr-edit" data-id="${p.id}" type="button" title="Edit" aria-label="Edit">&#9998;</button>
                        <button class="prompt-mgr-iconbtn prompt-mgr-del" data-id="${p.id}" type="button" title="Delete" aria-label="Delete">&#128465;</button>
                    </div>
                </div>`;
        }).join('');

        const empty = `
            <div class="prompt-mgr-empty">
                <span class="prompt-mgr-empty-icon" aria-hidden="true">&#9889;</span>
                <p class="prompt-mgr-empty-text">No background prompts yet.<br>Prompts run in the background on your local model and post their results to the feed.</p>
                <button class="primary-btn prompt-mgr-empty-add" type="button">Create your first prompt</button>
            </div>`;

        container.innerHTML = `
            <div class="prompt-mgr-head">
                <span class="prompt-mgr-subtitle">Background prompts</span>
                ${prompts.length ? `<span class="prompt-mgr-count">${prompts.length}</span>` : ''}
                <button class="primary-btn prompt-mgr-add" type="button">+ New prompt</button>
            </div>
            <div class="prompt-mgr-list">
                ${prompts.length ? rows : empty}
            </div>`;

        container.querySelectorAll('.prompt-mgr-add, .prompt-mgr-empty-add').forEach(b =>
            b.addEventListener('click', () => this._renderManagerForm(container, null)));

        container.querySelectorAll('.prompt-mgr-edit').forEach(b =>
            b.addEventListener('click', () => {
                const note = NotePrompts.list().find(n => n.id === b.dataset.id);
                if (note) this._renderManagerForm(container, note);
            }));

        container.querySelectorAll('.prompt-mgr-run').forEach(b =>
            b.addEventListener('click', async () => {
                b.disabled = true;
                await this.runNow(b.dataset.id);
                if (this._mgr && this._mgr.container === container) this._renderManagerList(container);
            }));

        container.querySelectorAll('.prompt-mgr-del').forEach(b =>
            b.addEventListener('click', async () => {
                const note = NotePrompts.list().find(n => n.id === b.dataset.id);
                const ok = await UIUtils.confirm(
                    'Delete prompt',
                    `Delete &ldquo;${UIUtils.escapeHtml(note?.title || 'this prompt')}&rdquo;? This removes the prompt and stops its scheduled runs.`,
                    '🗑️',
                    { confirmText: 'Delete' }
                );
                if (!ok) return;
                NotePrompts.remove(b.dataset.id);
                this.render();
                if (this._mgr && this._mgr.container === container) this._renderManagerList(container);
            }));
    },

    _renderManagerForm(container, note) {
        const cfg = note ? NotePrompts.config(note) : { ...NotePrompts.DEFAULTS, offline: true };
        const title = note ? (note.title || '') : '';
        const body = note ? NotePrompts.bodyText(note) : '';

        container.innerHTML = `
            <div class="prompt-mgr-head">
                <button class="prompt-mgr-back" type="button" title="Back to prompts" aria-label="Back to prompts">&#8592;</button>
                <span class="prompt-mgr-subtitle">${note ? 'Edit prompt' : 'New prompt'}</span>
            </div>
            <div class="prompt-mgr-form">
                <label class="prompt-mgr-label" for="prompt-mgr-title">Title</label>
                <input id="prompt-mgr-title" class="prompt-mgr-input" type="text" placeholder="e.g. Morning briefing" value="${UIUtils.escapeHtml(title)}" autocomplete="off" spellcheck="false">

                <label class="prompt-mgr-label" for="prompt-mgr-body">Prompt</label>
                <div class="prompt-mgr-composer">
                    <textarea id="prompt-mgr-body" class="prompt-mgr-textarea" rows="5" placeholder="What should the model generate on each run?">${UIUtils.escapeHtml(body)}</textarea>
                    <div class="prompt-mgr-composer-foot">
                        <label class="prompt-mgr-optchip" title="Let the model search the web during the run">
                            <input type="checkbox" id="prompt-mgr-web" ${cfg.web ? 'checked' : ''}>
                            <span>&#127760; Web search</span>
                        </label>
                        <label class="prompt-mgr-optchip" title="Run through the AI Assistant with your memory, goals, and schedule">
                            <input type="checkbox" id="prompt-mgr-context" ${cfg.useContext ? 'checked' : ''}>
                            <span>&#10024; My context</span>
                        </label>
                    </div>
                </div>

                <label class="prompt-mgr-label">Run every</label>
                <input type="hidden" id="prompt-mgr-interval" value="${cfg.interval}">
                <div class="prompt-mgr-seg" role="group" aria-label="Run every">
                    ${['hourly', '6h', 'daily', 'weekly'].map(v => `
                        <button type="button" class="prompt-mgr-seg-btn ${cfg.interval === v ? 'active' : ''}" data-value="${v}" aria-pressed="${cfg.interval === v}">${NotePrompts.intervalLabel(v)}</button>`).join('')}
                </div>
                <div class="prompt-mgr-time-row" ${(cfg.interval === 'daily' || cfg.interval === 'weekly') ? '' : 'hidden'}>
                    <label class="prompt-mgr-label" for="prompt-mgr-time">At (optional)</label>
                    <input type="time" id="prompt-mgr-time" class="prompt-mgr-input prompt-mgr-time" value="${cfg.time || ''}">
                </div>
                <p class="prompt-mgr-hint">Runs offline on your local model and posts the result to this feed.</p>

                <div class="prompt-mgr-form-actions">
                    <button class="secondary-btn prompt-mgr-cancel" type="button">Cancel</button>
                    <button class="primary-btn prompt-mgr-save" type="button">${note ? 'Save changes' : 'Schedule prompt'}</button>
                </div>
            </div>`;

        const back = () => this._renderManagerList(container);
        container.querySelector('.prompt-mgr-back')?.addEventListener('click', back);
        container.querySelector('.prompt-mgr-cancel')?.addEventListener('click', back);

        // Segmented schedule control writes into the hidden #prompt-mgr-interval
        // so the save handler reads the same field it always has.
        container.querySelectorAll('.prompt-mgr-seg-btn').forEach(b =>
            b.addEventListener('click', () => {
                container.querySelector('#prompt-mgr-interval').value = b.dataset.value;
                container.querySelectorAll('.prompt-mgr-seg-btn').forEach(x => {
                    x.classList.toggle('active', x === b);
                    x.setAttribute('aria-pressed', String(x === b));
                });
                // A run time only makes sense for wall-clock intervals.
                container.querySelector('.prompt-mgr-time-row').hidden =
                    !(b.dataset.value === 'daily' || b.dataset.value === 'weekly');
            }));

        // Cmd/Ctrl+Enter from the prompt body saves — same muscle memory as
        // the assistant composer.
        container.querySelector('#prompt-mgr-body')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                container.querySelector('.prompt-mgr-save')?.click();
            }
        });

        container.querySelector('.prompt-mgr-save')?.addEventListener('click', () => {
            const t = container.querySelector('#prompt-mgr-title').value.trim();
            const b = container.querySelector('#prompt-mgr-body').value.trim();
            if (!b) { UIUtils.showToast('Add a prompt to schedule', 'error'); return; }
            const interval = container.querySelector('#prompt-mgr-interval').value;
            const config = {
                offline: true,
                interval,
                time: (interval === 'daily' || interval === 'weekly')
                    ? (container.querySelector('#prompt-mgr-time').value || null) : null,
                web: container.querySelector('#prompt-mgr-web').checked,
                useContext: container.querySelector('#prompt-mgr-context').checked
            };
            if (note) NotePrompts.update(note.id, { title: t, body: b, config });
            else NotePrompts.create({ title: t, body: b, config });
            // Nudge the scheduler so a newly created/enabled prompt runs soon
            // instead of waiting for the next poll.
            this.onPromptsChanged();
            UIUtils.showToast(note ? 'Prompt updated' : 'Prompt scheduled', 'success');
            this.render();
            this._renderManagerList(container);
        });

        setTimeout(() => container.querySelector('#prompt-mgr-title')?.focus(), 0);
    },

    async _runPrompt(prompt) {
        // Stamp the run time up front so a failing or slow prompt waits a
        // full interval before retrying instead of spinning every poll.
        this.data.runs[prompt.id] = new Date().toISOString();
        this.saveData();

        let content = '';
        let error = null;
        let model = (typeof AgentService !== 'undefined' && AgentService.model) || null;
        try {
            if (typeof LLMLogger === 'undefined' || !window.electronLLM) {
                throw new Error('Local model unavailable');
            }
            const cfg = NotePrompts.config(prompt);
            const out = cfg.useContext
                ? await this._generateWithAssistant(prompt, model)
                : cfg.web
                    ? await this._generateWithWeb(prompt, model)
                    : await this._generatePlain(prompt, model);
            content = out.content;
            error = out.error;
            if (out.model) model = out.model;
            if (!error && !content) error = 'Model returned an empty response';
        } catch (e) {
            error = e?.message || 'Run failed';
        }

        const note = this._postToFeed(prompt, { content, error, model });
        this.render();
        return note;
    },

    // Persist a run's output as a 'feed'-template note in the shared `notes`
    // blob. The markdown → HTML conversion happens once here, through the
    // same sanitizing formatter the assistant's create_note uses, so the
    // feed and the Notes app render identical stored content.
    _postToFeed(prompt, { content, error, model }) {
        const now = new Date().toISOString();
        const note = {
            id: UIUtils.generateId(),
            title: prompt.title || 'Untitled prompt',
            content: error ? '' : this._format(content),
            tags: [],
            template: 'feed',
            feed: { promptId: prompt.id, model: model || null, error: error || null },
            profile: prompt.profile
                || ((typeof ProfileManager !== 'undefined' && ProfileManager.getActiveProfileId)
                    ? ProfileManager.getActiveProfileId() : 'default'),
            pinned: false,
            showOnHome: false,
            createdAt: now,
            modifiedAt: now
        };
        const notes = NotePrompts._readNotes();
        notes.unshift(note);
        NotePrompts._writeNotes(this._prune(notes, prompt.id));
        this._refreshNotesApp();
        return note;
    },

    // Personalized run: route the prompt through the AI Assistant so it gets
    // the full user briefing (memory, goals, schedule, notes…) and read-only
    // tools, then return the final answer. Headless — no chat history is
    // touched. Forced onto the local model so the schedule stays offline.
    // Degrades to a plain run if the assistant path is unavailable.
    async _generateWithAssistant(prompt, model) {
        if (typeof AgentService === 'undefined' || typeof AgentService.runHeadless !== 'function') {
            return this._generatePlain(prompt, model);
        }
        const res = await AgentService.runHeadless(NotePrompts.bodyText(prompt), {
            contextMode: 'full',
            readOnly: true,
            // Provenance for the BACKGROUND RUN system-prompt block: the
            // model should know it's an unattended scheduled run (write a
            // feed post, ask nothing) and its cadence.
            source: {
                title: prompt.title || '',
                schedule: NotePrompts.scheduleLabel(NotePrompts.config(prompt))
            }
        });
        return {
            content: (res && res.type === 'text') ? (res.content || '').trim() : '',
            error: (res && res.type === 'error') ? (res.content || 'Run failed') : null,
            // Prefer the model that actually ANSWERED (res.model — when the
            // provider is the user's own server, that's the server model, not
            // the local model selection getActiveModel would report).
            model: (res && res.model) || (AgentService.getActiveModel && AgentService.getActiveModel()) || model
        };
    },

    // Plain offline run: local model, no tools.
    async _generatePlain(prompt, model) {
        const res = await LLMLogger.call('prompt-feed', {
            model,
            messages: [
                { role: 'system', content: `You are running the user's background prompt unattended (runs ${NotePrompts.scheduleLabel(NotePrompts.config(prompt))}); the result is posted to their feed to read later. No one is present to reply — never ask questions or offer follow-ups. Respond directly and concisely with a self-contained answer.` },
                { role: 'user', content: NotePrompts.bodyText(prompt) }
            ],
            options: { temperature: 0.4 }
        });
        return {
            content: (res?.message?.content || '').trim(),
            error: res?.error ? String(res.error) : null,
            model: res?.model || null
        };
    },

    // Web-grounded run: local model with the agent's `web_search` tool
    // available. Runs a small tool loop — the model decides whether to
    // search (via the user's configured Tavily/Brave provider), reads the
    // results, then writes the final answer. No browser tab involved.
    async _generateWithWeb(prompt, model) {
        const webDef = (typeof AgentTools !== 'undefined' && Array.isArray(AgentTools.definitions))
            ? AgentTools.definitions.find(d => d?.function?.name === 'web_search')
            : null;
        if (!webDef || typeof AgentTools.execute !== 'function') {
            // Tooling unavailable — degrade to a plain run rather than fail.
            return this._generatePlain(prompt, model);
        }

        const messages = [
            { role: 'system', content: `You are a research assistant running the user's background prompt unattended (runs ${NotePrompts.scheduleLabel(NotePrompts.config(prompt))}); the result is posted to their feed to read later. Use the web_search tool when current or external information would improve the answer; otherwise answer directly. After searching, synthesize a clear, self-contained answer in markdown and cite source URLs inline. Do not ask the user questions or offer follow-ups — no one is present to reply.` },
            { role: 'user', content: NotePrompts.bodyText(prompt) }
        ];

        const MAX_ITERS = 4;
        let lastModel = null;
        for (let i = 0; i < MAX_ITERS; i++) {
            // On the final allowed iteration, drop tools so the model is
            // forced to produce a textual answer instead of another call.
            const allowTools = i < MAX_ITERS - 1;
            const res = await LLMLogger.call('prompt-feed', {
                model,
                messages,
                tools: allowTools ? [webDef] : undefined,
                options: { temperature: 0.4 }
            });
            if (res?.error) return { content: '', error: String(res.error), model: lastModel };
            if (res?.model) lastModel = res.model;

            const msg = res?.message || {};
            const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
            if (!calls.length || !allowTools) {
                return { content: (msg.content || '').trim(), error: null, model: lastModel };
            }

            // Echo the assistant turn (with its tool_calls) then append a
            // role:'tool' result per call — the message shape the engine's
            // chat template expects, mirroring AgentService's loop.
            messages.push(msg);
            for (const tc of calls) {
                let args = tc?.function?.arguments;
                if (typeof args === 'string') {
                    try { args = JSON.parse(args); } catch { args = {}; }
                }
                if (args && args.maxResults == null) args.maxResults = 5;
                let result;
                try {
                    result = await AgentTools.execute('web_search', args || {});
                } catch (e) {
                    result = { error: e?.message || 'web_search failed' };
                }
                messages.push({ role: 'tool', content: JSON.stringify(result).slice(0, 6000) });
            }
        }
        return { content: '', error: 'Stopped after too many tool calls without an answer', model: lastModel };
    },

    // Keep a rolling history per prompt so the user can see how the
    // output changed over time, without unbounded growth. Operates on a
    // notes array (newest feed notes first — runs unshift) and returns the
    // pruned copy. Pinned posts are the user's keepers — never pruned.
    _prune(notes, promptId) {
        let seen = 0;
        return notes.filter(n => {
            if (!this._isFeedNote(n) || !n.feed || n.feed.promptId !== promptId) return true;
            if (n.pinned) return true;
            seen += 1;
            return seen <= this.MAX_PER_PROMPT;
        });
    },

    /* ---------- Published posts (remote-config `feedPosts`) ----------
     *
     * Messages Anjadhe publishes for users — release notes, tips — ride the
     * same remote-config channel the model catalog uses (bundled fallback →
     * cached → remote). Each post: { id, title, date, body, link? }. They
     * render as regular feed cards with a provenance chip; a dismissed
     * post's id is stored (synced) so it stays gone on every Mac.
     */

    async _loadPublished() {
        try {
            const cfg = await window.electronConfig.get();
            this._published = (Array.isArray(cfg?.feedPosts) ? cfg.feedPosts : [])
                .filter(p => p && p.id && p.title);
        } catch {
            this._published = [];
        }
    },

    _publishedModels() {
        if (!this._published || !this._published.length) return [];
        const dismissed = new Set((StorageManager.get('dismissed-feed-posts')?.ids) || []);
        return this._published
            .filter(p => !dismissed.has(p.id))
            .map(p => ({
                id: 'pub-' + p.id,
                promptId: null,
                promptTitle: p.title,
                html: this._format(p.body || '') + ((p.link && p.link.url && p.link.label)
                    ? `<p><a href="${UIUtils.escapeHtml(p.link.url)}">${UIUtils.escapeHtml(p.link.label)}</a></p>`
                    : ''),
                error: null,
                model: null,
                createdAt: p.date || null,
                published: true
            }));
    },

    _dismissPublished(pubId) {
        const id = String(pubId).replace(/^pub-/, '');
        const current = StorageManager.get('dismissed-feed-posts') || {};
        const ids = Array.isArray(current.ids) ? current.ids.slice() : [];
        if (!ids.includes(id)) ids.push(id);
        StorageManager.set('dismissed-feed-posts', { ids });
    },

    /* ---------- Rendering ---------- */

    _filteredItems() {
        let notes = this._feedNotes();
        if (typeof ProfileManager !== 'undefined' && ProfileManager.filterByActiveProfile) {
            notes = ProfileManager.filterByActiveProfile(notes);
        }
        return [...this._publishedModels(), ...notes.map(n => this._cardModel(n))]
            .sort((a, b) =>
                new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    },

    render() {
        const list = document.getElementById('prompt-feed-list');
        if (!list) return;

        const items = this._filteredItems();
        const clearBtn = document.getElementById('prompt-feed-clear');
        // Clear all only removes the user's own run posts — published posts
        // are dismissed per-card — so key its visibility off those.
        if (clearBtn) clearBtn.style.display = items.some(i => !i.published) ? '' : 'none';

        if (items.length === 0) {
            const anyOffline = this._offlinePrompts().length > 0;
            list.innerHTML = `<div class="empty-state">
                <h3>No feed entries yet</h3>
                <p>${anyOffline
                    ? 'Background prompts will appear here after their next run.'
                    : 'Use <strong>+ New prompt</strong> above to create a prompt that runs on a schedule. Its results land here automatically.'}</p>
            </div>`;
            return;
        }

        list.innerHTML = items.map(it => this._renderCard(it)).join('');
        list.querySelectorAll('[data-feed-del]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.deleteItem(btn.dataset.feedDel);
            });
        });

        // Clamp each card to a fixed preview and reveal "Read more" only
        // when the content actually overflows. render() runs while the
        // feed tab is visible (it's called on tab activation), so we can
        // measure rendered vs. clamped height instead of hardcoding a
        // pixel cutoff. Clicking the card (or the button) opens the full
        // post; links and the delete control keep their own behaviour.
        list.querySelectorAll('.feed-card[data-feed-open]').forEach(card => {
            const body = card.querySelector('.feed-card-body');
            const moreBtn = card.querySelector('.feed-card-more');
            if (body) {
                body.classList.add('feed-card-body--clamped');
                if (body.scrollHeight > body.clientHeight + 4) {
                    if (moreBtn) moreBtn.hidden = false;
                } else {
                    body.classList.remove('feed-card-body--clamped');
                }
            }
            card.addEventListener('click', (e) => {
                if (e.target.closest('a') || e.target.closest('[data-feed-del]')) return;
                this.openPost(card.dataset.feedOpen);
            });
        });
    },

    // A model id can be a full GGUF path on llama.cpp — show just the model
    // name, the path is noise on a feed card.
    _displayModel(model) {
        if (!model) return '';
        return String(model).split('/').pop().replace(/\.gguf$/i, '');
    },

    _renderCard(it) {
        const when = this._timeAgo(it.createdAt);
        const modelName = this._displayModel(it.model);
        const meta = `<span class="feed-card-meta">${when}${modelName ? ' &middot; ' + UIUtils.escapeHtml(modelName) : ''}</span>`;
        const head = `
                <header class="feed-card-head">
                    ${it.published ? '<span class="feed-card-source">Anjadhe</span>' : ''}
                    <span class="feed-card-title">${UIUtils.escapeHtml(it.promptTitle)}</span>
                    ${meta}
                    <button class="feed-card-del" type="button" data-feed-del="${it.id}" title="${it.published ? 'Dismiss' : 'Remove'}">&times;</button>
                </header>`;
        // Errored runs stay inline — there's nothing to expand into.
        if (it.error) {
            return `
            <article class="feed-card feed-card--error">${head}
                <div class="feed-card-error">${UIUtils.escapeHtml(it.error)}</div>
            </article>`;
        }
        return `
            <article class="feed-card" data-feed-open="${it.id}">${head}
                <div class="feed-card-body">${it.html}</div>
                <button class="feed-card-more" type="button" hidden>Read more</button>
            </article>`;
    },

    /* ---------- Full-page post (social-media style detail view) ---------- */

    _ensureOverlay() {
        if (this._overlay) return this._overlay;
        const ov = document.createElement('div');
        ov.className = 'feed-post-overlay';
        ov.hidden = true;
        ov.innerHTML = `
            <article class="feed-post-main">
                <button class="feed-post-back" type="button">&larr; Back to feed</button>
                <header class="feed-post-header">
                    <span class="feed-post-source"></span>
                    <h1 class="feed-post-title"></h1>
                    <div class="feed-post-meta">
                        <span class="feed-post-time"></span>
                        <button class="feed-post-prompt-link" type="button" hidden
                                title="Open the prompt note that generated this post"></button>
                    </div>
                </header>
                <div class="feed-post-body feed-card-body"></div>
            </article>
            <button class="feed-post-discuss" type="button" title="Start a chat about this result">
                <span class="feed-post-discuss-icon">&#x2728;</span>
                <span class="feed-post-discuss-label">Ask about this result</span>
            </button>`;
        ov.querySelector('.feed-post-back').addEventListener('click', () => this.closePost());
        ov.querySelector('.feed-post-discuss').addEventListener('click', () => {
            if (ov._itemId) this.discussInAssistant(ov._itemId);
        });
        // A feed post is a note generated BY a prompt note — the meta line
        // links back to that prompt (the notes viewer links the other way).
        ov.querySelector('.feed-post-prompt-link').addEventListener('click', () => {
            const pid = ov._promptId;
            if (!pid) return;
            this.closePost();
            if (typeof AppManager !== 'undefined') AppManager.openApp('notes');
            setTimeout(() => {
                if (typeof NotesApp !== 'undefined' && NotesApp.openViewer) NotesApp.openViewer(pid);
            }, 60);
        });
        document.body.appendChild(ov);
        // Select-a-word → "Define" lookup while reading a post — the same pill
        // and popover the Notes editor uses. The body element persists across
        // posts, so attaching once here covers every post opened later.
        if (typeof WordLookup !== 'undefined') {
            WordLookup.attachSelectionTrigger(ov.querySelector('.feed-post-body'));
        }
        this._overlay = ov;
        return ov;
    },

    // Bound once (PromptFeed is a singleton) so it can be added/removed by
    // reference. Escape closes the open post.
    _onKey(e) {
        if (e.key === 'Escape') PromptFeed.closePost();
    },

    openPost(id) {
        const it = this._item(id);
        if (!it) return;
        const ov = this._ensureOverlay();
        ov._itemId = id;
        // Nothing to discuss on an errored run.
        const discuss = ov.querySelector('.feed-post-discuss');
        if (discuss) discuss.hidden = !!it.error;
        ov.querySelector('.feed-post-source').textContent = it.published ? 'From Anjadhe' : 'From your feed';
        ov.querySelector('.feed-post-title').textContent = it.promptTitle || 'Prompt';
        const when = this._timeAgo(it.createdAt);
        const modelName = this._displayModel(it.model);
        ov.querySelector('.feed-post-time').innerHTML =
            `${UIUtils.escapeHtml(when)}${modelName ? ' &middot; ' + UIUtils.escapeHtml(modelName) : ''}`;

        // Link back to the prompt note that generated this post (feed posts
        // ARE notes; the prompt is a sibling note). Hidden for published
        // posts and orphaned runs whose prompt was deleted.
        const promptLink = ov.querySelector('.feed-post-prompt-link');
        const promptNote = (it.promptId && typeof NotePrompts !== 'undefined')
            ? NotePrompts.list().find(p => p.id === it.promptId)
            : null;
        ov._promptId = promptNote ? promptNote.id : null;
        if (promptLink) {
            if (promptNote) {
                promptLink.textContent = 'Prompt: ' + (promptNote.title || 'Untitled prompt');
                promptLink.hidden = false;
            } else {
                promptLink.hidden = true;
            }
        }
        ov.querySelector('.feed-post-body').innerHTML = it.error
            ? `<div class="feed-card-error">${UIUtils.escapeHtml(it.error)}</div>`
            : it.html;
        ov.scrollTop = 0;
        ov.hidden = false;
        document.addEventListener('keydown', this._onKey);
        // Move focus into the overlay (not onto the Back button — that
        // painted a focus ring on every open) so Escape and tabbing land
        // in the post.
        ov.setAttribute('tabindex', '-1');
        ov.focus({ preventScroll: true });
    },

    closePost() {
        if (this._overlay) this._overlay.hidden = true;
        document.removeEventListener('keydown', this._onKey);
        if (typeof WordLookup !== 'undefined') WordLookup.dismiss();
    },

    // "Discuss with Assistant" on a post: open a fresh chat whose system
    // context carries the prompt + generated result (the conv.extraContext
    // channel, same as record chats), so follow-up questions land on a model
    // that has actually read what the user is looking at.
    discussInAssistant(id) {
        const it = this._item(id);
        if (!it || typeof AgentService === 'undefined') return;
        this.closePost();
        const title = it.promptTitle || 'Prompt result';

        // Enter the assistant FIRST — its entry logic may reuse or mint the
        // active conversation — then seed whatever conversation settled as
        // active. Seeding before entry raced that logic.
        AppManager.openApp('agent');
        const conv = AgentService.openFreshConversation?.()
            || AgentService.conversations.find(c => c.id === AgentService.activeConversationId);
        if (!conv) return;

        conv.title = `Re: ${title}`;
        // The note stores rendered HTML — hand the model plain text
        // (NotePrompts.bodyText flattens block boundaries to newlines).
        const plain = (typeof NotePrompts !== 'undefined')
            ? NotePrompts.bodyText({ content: it.html })
            : String(it.html || '');
        conv.extraContext =
            `This conversation is about a scheduled-prompt result the user just read in their feed. ` +
            `Prompt: "${title}". Generated ${it.createdAt}${it.model ? ` by ${it.model}` : ''}.\n\n` +
            `THE RESULT (answer follow-up questions about this content):\n${plain.slice(0, 6000)}`;
        // A visible anchor in the thread — the user sees the chat is about
        // this post, and the model sees the same commitment in its history.
        conv.messages.push({
            role: 'assistant',
            content: `Let’s discuss **${title}** from your feed — I have the full result in my context. What would you like to know?`,
            metadata: {}
        });
        // renderMessages reads the load-time snapshot (AgentService
        // .conversation), not conv.messages — refresh the mirror or the
        // anchor won't paint.
        if (AgentService.activeConversationId === conv.id) {
            AgentService.conversation = [...conv.messages];
        }
        AgentService._saveConversations?.();
        if (typeof AgentUI !== 'undefined') {
            AgentUI.renderMessages?.();
            AgentUI.renderHistorySidebar?.();
        }
    },

    deleteItem(id) {
        // Published posts aren't notes — dismissing hides them (synced).
        if (String(id).startsWith('pub-')) {
            this._dismissPublished(id);
            this.render();
            return;
        }
        if (typeof NotePrompts !== 'undefined') NotePrompts.remove(id);
        this._refreshNotesApp();
        this.render();
    },

    clearAll() {
        if (!confirm('Clear all feed entries? This deletes the generated posts (their notes) but not the prompts themselves.')) return;
        if (typeof NotePrompts !== 'undefined') {
            NotePrompts._writeNotes(
                NotePrompts._readNotes().filter(n => !this._isFeedNote(n)));
        }
        this._refreshNotesApp();
        this.render();
    },

    _timeAgo(iso) {
        const t = new Date(iso).getTime();
        if (!t) return '';
        const s = Math.max(0, Math.round((Date.now() - t) / 1000));
        if (s < 60) return 'just now';
        const m = Math.round(s / 60);
        if (m < 60) return `${m}m ago`;
        const h = Math.round(m / 60);
        if (h < 24) return `${h}h ago`;
        const d = Math.round(h / 24);
        return d === 1 ? 'yesterday' : `${d}d ago`;
    },

    // Model markdown → note HTML, done ONCE when a run is saved as a feed
    // note (and when legacy items migrate) — renders read the stored HTML.
    // Uses the SAME sanitizing markdown formatter the AI Assistant uses
    // (AgentUI.formatContent) so numbered/nested lists, tables, headers and
    // inline formatting render properly, and so feed notes match
    // assistant-written notes. The block elements it emits are styled by
    // the .feed-card-body rules in core.css and the Notes viewer alike.
    // Falls back to a minimal inline-escape if AgentUI hasn't loaded yet
    // (it loads after this module in index.html, but runs only happen after
    // startup, so the global is available in practice).
    _format(text) {
        if (!text) return '';
        if (typeof AgentUI !== 'undefined' && typeof AgentUI.formatContent === 'function') {
            return AgentUI.formatContent(text);
        }
        return `<p>${UIUtils.escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
    }
};
