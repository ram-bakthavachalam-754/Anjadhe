/**
 * Note Prompts — prompt-template helpers shared across the app.
 *
 * A "prompt" is a note with `template === 'prompt'`. Its prompt *body* is the
 * note's rich-text content (read as plain text when run), and its run config
 * lives in a nested `note.prompt = { target, offline, interval, time, web }` object
 * — analogous to how the book template stores `bookNumbered`/`bookLayout`.
 *
 * This module centralizes everything prompt-specific that more than one caller
 * needs (the Notes editor, the background PromptFeed scheduler, and the Browse
 * prompts shelf) so the logic isn't re-implemented three times:
 *   - detecting prompt notes and reading their config
 *   - extracting the runnable body text from the note's HTML
 *   - listing prompt notes straight from the `notes` storage blob
 *   - the Run-in-Agent / Run-in-Browser actions (ported from the old
 *     standalone PromptsApp)
 */

const NotePrompts = {
    DEFAULTS: { target: 'agent', offline: false, interval: 'daily', time: null, web: false, useContext: false },

    isPrompt(note) {
        return !!note && NoteTemplates.resolve(note) === 'prompt';
    },

    /**
     * Normalized run config for a note. Always returns a full object with
     * defaults so callers can read fields without guarding.
     */
    config(note) {
        const p = (note && note.prompt && typeof note.prompt === 'object') ? note.prompt : {};
        return {
            target: p.target === 'browser' ? 'browser' : 'agent',
            offline: !!p.offline,
            interval: ['hourly', '6h', 'daily', 'weekly'].includes(p.interval) ? p.interval : 'daily',
            // Optional preferred run time (24h "HH:MM") for daily/weekly
            // schedules — "every morning" means 08:00, not "24h since the
            // last run". Null = interval-only (legacy behavior).
            time: /^([01]?\d|2[0-3]):[0-5]\d$/.test(p.time || '') ? p.time : null,
            web: !!p.web,
            // When on, scheduled offline runs go through the AI Assistant with
            // the user's full personalized context (memory, goals, schedule…)
            // instead of the bare prompt. See PromptFeed._generateWithAssistant.
            useContext: !!p.useContext
        };
    },

    /**
     * Plain-text prompt body from the note's HTML content, whitespace
     * collapsed. This is what actually gets run / searched / pasted.
     */
    bodyText(note) {
        const html = note && note.content;
        if (!html) return '';
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        // Treat block boundaries as line breaks before flattening so
        // multi-paragraph prompts don't run together into one line.
        tmp.querySelectorAll('p, div, br, h1, h2, h3, li').forEach(el => {
            el.appendChild(document.createTextNode('\n'));
        });
        return (tmp.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
    },

    /** All prompt notes straight from the `notes` blob (storage source of truth). */
    list() {
        const d = (typeof StorageManager !== 'undefined') ? StorageManager.get('notes') : null;
        const notes = (d && Array.isArray(d.notes)) ? d.notes : [];
        return notes.filter(n => this.isPrompt(n));
    },

    intervalLabel(interval) {
        return ({ hourly: 'hourly', '6h': 'every 6h', daily: 'daily', weekly: 'weekly' })[interval] || 'daily';
    },

    /** "8:00 AM" from a 24h "HH:MM" string (empty string if invalid). */
    timeLabel(hhmm) {
        const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm || '');
        if (!m) return '';
        const h = parseInt(m[1], 10);
        return `${h % 12 || 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
    },

    /** Full human schedule for a config: "daily at 8:00 AM" / "every 6h". */
    scheduleLabel(cfg) {
        const base = this.intervalLabel(cfg && cfg.interval);
        const t = (cfg && (cfg.interval === 'daily' || cfg.interval === 'weekly')) ? this.timeLabel(cfg.time) : '';
        return t ? `${base} at ${t}` : base;
    },

    /* ---------- Run ---------- */

    /**
     * Pre-run compose dialog. Shows the stored prompt body and a textarea
     * for an optional extra message — so a prompt can hold reusable context
     * and the user asks the actual question at run time. Resolves with the
     * final text to run (body, plus the extra appended after a blank line)
     * or null if the user cancels.
     */
    composeRun(note, target) {
        const body = this.bodyText(note);
        if (!body) return Promise.resolve(null);
        return new Promise((resolve) => {
            let settled = false;
            const finish = (val) => { if (!settled) { settled = true; resolve(val); } };

            const wrap = document.createElement('div');
            wrap.className = 'note-prompt-compose';
            wrap.innerHTML = `
                <div class="note-prompt-compose-preview"></div>
                <label class="note-prompt-compose-label" for="note-prompt-compose-extra">Add a message (optional)</label>
                <textarea id="note-prompt-compose-extra" class="note-prompt-compose-extra" rows="3"
                          placeholder="Appended after the prompt — e.g. a question about this context"></textarea>
            `;
            wrap.querySelector('.note-prompt-compose-preview').textContent = body;

            const run = () => {
                const extra = wrap.querySelector('textarea').value.trim();
                finish(extra ? `${body}\n\n${extra}` : body);
                modal.close();
            };
            const modal = Modal.create({
                title: note.title || 'Run Prompt',
                className: 'note-prompt-compose-dialog',
                content: wrap,
                onClose: () => finish(null),
                buttons: [
                    { text: 'Cancel', className: 'secondary-btn', onClick: () => modal.close() },
                    {
                        text: target === 'browser' ? 'Run in Browser' : 'Run in Assistant',
                        className: 'primary-btn',
                        onClick: run
                    }
                ]
            });

            const ta = wrap.querySelector('textarea');
            ta.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); }
            });
            setTimeout(() => ta.focus(), 0);
        });
    },

    // Submit the prompt through the browser's address bar so the
    // configured search engine + history recording all happen.
    async runInBrowser(note) {
        const text = await this.composeRun(note, 'browser');
        if (!text) return;
        AppManager.openApp('browse');
        setTimeout(() => {
            if (typeof BrowseApp !== 'undefined' && BrowseApp._submitUrl) {
                BrowseApp._submitUrl(text);
            }
        }, 50);
    },

    // Open the docked agent panel and paste the prompt. We don't auto-send
    // so the user can tweak before hitting Enter.
    async runInAgent(note) {
        const text = await this.composeRun(note, 'agent');
        if (!text) return;
        if (typeof AgentUI === 'undefined' || !AgentUI.open) return;
        AgentUI.open();
        setTimeout(() => {
            const input = document.getElementById('agent-input');
            if (!input) return;
            input.value = text;
            input.focus();
            input.dispatchEvent(new Event('input', { bubbles: true }));
            try {
                const end = text.length;
                input.setSelectionRange(end, end);
            } catch {}
        }, 320);
    },

    // Run the default target for a note (used by list/shelf single-click).
    runDefault(note) {
        if (this.config(note).target === 'browser') this.runInBrowser(note);
        else this.runInAgent(note);
    },

    /* ---------- Create / update / delete ----------
     *
     * Prompt notes are part of the shared `notes` blob, so these read it as the
     * source of truth (matching list()), mutate, and write back — then sync the
     * Notes app's in-memory copy if it's been loaded so the editor doesn't go
     * stale. This lets the Prompt Feed's "Manage prompts" UI create and edit
     * prompts without bouncing the user into the Notes app.
     */

    _readNotes() {
        const d = (typeof StorageManager !== 'undefined') ? StorageManager.get('notes') : null;
        return (d && Array.isArray(d.notes)) ? d.notes : [];
    },

    _writeNotes(notes) {
        StorageManager.set('notes', { notes });
        // Keep the Notes app coherent if it has already loaded its list.
        if (typeof NotesApp !== 'undefined' && Array.isArray(NotesApp.notes)) {
            NotesApp.notes = notes;
        }
        if (typeof AppManager !== 'undefined' && AppManager.updateStats) AppManager.updateStats();
    },

    // Plain text → minimal paragraph HTML for the note body (mirrors the
    // prompts→notes migration so feed-authored prompts match editor-authored
    // ones). Blank-safe.
    _bodyToHtml(body) {
        const esc = (s) => String(s || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const text = String(body || '').trim();
        if (!text) return '';
        return text.split(/\n{2,}/)
            .map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
            .join('');
    },

    /**
     * Create a new prompt note. `config` is merged over DEFAULTS and normalized.
     * Returns the created note.
     */
    create({ title, body, config } = {}) {
        const cfg = this.config({ prompt: { ...this.DEFAULTS, ...(config || {}) } });
        const now = new Date().toISOString();
        const note = {
            id: (typeof UIUtils !== 'undefined') ? UIUtils.generateId() : ('note_' + Date.now()),
            title: (title || '').trim() || 'Untitled prompt',
            content: this._bodyToHtml(body),
            tags: [],
            template: 'prompt',
            prompt: cfg,
            profile: (typeof ProfileManager !== 'undefined' && ProfileManager.getProfileForNewItem)
                ? ProfileManager.getProfileForNewItem() : 'default',
            pinned: false,
            createdAt: now,
            modifiedAt: now
        };
        const notes = this._readNotes();
        notes.unshift(note);
        this._writeNotes(notes);
        return note;
    },

    /**
     * Update an existing prompt note in place. Any of title/body/config may be
     * omitted to leave them unchanged. Returns the updated note, or null if not
     * found.
     */
    update(id, { title, body, config } = {}) {
        const notes = this._readNotes();
        const note = notes.find(n => n && n.id === id);
        if (!note) return null;
        if (typeof title === 'string') note.title = title.trim() || 'Untitled prompt';
        if (typeof body === 'string') note.content = this._bodyToHtml(body);
        if (config) note.prompt = this.config({ prompt: { ...this.config(note), ...config } });
        note.modifiedAt = new Date().toISOString();
        this._writeNotes(notes);
        return note;
    },

    /** Delete a prompt note by id. Returns true if one was removed. */
    remove(id) {
        const notes = this._readNotes();
        const next = notes.filter(n => !(n && n.id === id));
        if (next.length === notes.length) return false;
        this._writeNotes(next);
        return true;
    }
};
