/**
 * Help App — Settings-style master/detail.
 *
 * The root is a list of feature topics (same card rows as the Settings
 * root); clicking one opens a plain-English explainer for that feature.
 * Content lives in TOPICS below — static HTML strings, grouped the way the
 * launcher groups the apps. Keep the language simple: what it is, how to
 * use it, where things live. No marketing voice.
 */

const HelpApp = {
    _topic: null,   // open topic id, or null for the root list
    _query: '',     // current search text on the root list

    TOPICS: [
        // ── The framework ────────────────────────────────────────────
        {
            id: 'actions', group: 'Your day', title: 'Actions & Today',
            blurb: 'The front door: what to do today, in one short list.',
            body: `
                <p>Actions is where your day starts. Open it and you see one short list: tasks due today, anything overdue, and today's calendar events. When everything is checked off, it says so — "done for today" is a real, reachable state.</p>
                <h4 class="help-heading">The strip at the top</h4>
                <p>Today, Plan, Goals, and Tasks are four views of the same system. Today is what to do <em>now</em>; the others are where you organize. The strip and the breadcrumb get you between them from any page.</p>
                <h4 class="help-heading">Adding things quickly</h4>
                <p>Type into the "Add an action" box in plain language — <em>"Call dentist tomorrow 3pm"</em> becomes a task named "Call dentist", dated tomorrow, at 3:00 PM. After it's created you land on the task's page to add details. If you dated it beyond today, the toast tells you where it went ("Added for tomorrow").</p>
                <h4 class="help-heading">Overdue</h4>
                <p>Overdue tasks show above today's list. "Push to today" on the section header moves them all to today in one click; hovering a single row shows "&rarr; Today" for just that one.</p>
                <h4 class="help-heading">Weekly review</h4>
                <p>The quiet "Weekly review" link on the date line walks you through a short guided review — what got done, what's stuck, what matters next week. It nudges you at most once a week.</p>`
        },
        {
            id: 'plan', group: 'Your day', title: 'Plan — Focus areas & Groups',
            blurb: 'Where you organize life into focus areas and groups of investment.',
            body: `
                <p>Plan answers "where am I investing my time?" It has two levels:</p>
                <ul class="help-app-list">
                    <li><strong>Focus areas</strong> — ongoing themes in your life: Fitness, a project, a venture. Each focus area holds its goals.</li>
                    <li><strong>Groups</strong> — the big buckets that hold related focus areas together: Work, Personal, Finance. The Plan home shows one card per group.</li>
                </ul>
                <p>Click a group card to open it, click a focus area to see its goals and tasks, click a goal to open the goal itself. The breadcrumb at the top (Actions &rsaquo; Plan &rsaquo; Group &rsaquo; Focus area) always shows where you are, and every crumb is clickable to go back up.</p>
                <p>Rename or delete a group from its page (hover next to the title). Deleting a group never deletes focus areas — they just become unassigned.</p>
                <p>Focus areas change monthly, goals change weekly, actions change hourly. If you only remember one thing: don't over-build the tree. Structure is available, never required.</p>`
        },
        {
            id: 'goals', group: 'Your day', title: 'Goals',
            blurb: 'Outcomes with a finish line, sorted by what needs attention.',
            body: `
                <p>A goal is something you can finish: ship the release, run the marathon, hit the savings number. Each goal has a status (not started, in progress, no progress, need help), an optional target date, and a list of tasks.</p>
                <p>The list sorts itself: in-progress goals on top, then up next, then anything stuck — so the page reads as "what needs attention", not a flat archive.</p>
                <p>Link a goal to a focus area in Plan and every task under it knows why it exists. On the Actions Today page, tasks show their goal as a small chip — click it to jump to the goal.</p>
                <p><strong>Stuck</strong> means "no progress" or "need help". Stuck counts show up in red on the Plan cards so blocked outcomes can't hide.</p>`
        },
        {
            id: 'tasks', group: 'Your day', title: 'Tasks',
            blurb: 'Everything you’ve committed to, with dates, repeats, and reminders.',
            body: `
                <p>Tasks is the full inventory — every commitment, in Agenda view (grouped by day) or List view (grouped by status). Today's slice of it shows on the Actions page.</p>
                <h4 class="help-heading">Quick add speaks English</h4>
                <p><em>"Water plants every tuesday"</em>, <em>"Pay rent monthly"</em>, <em>"Review PRs weekdays 9am"</em> — dates, times, and repeat patterns are understood as you type, and the chips under the box show what was recognized before you press Enter.</p>
                <h4 class="help-heading">Repeating tasks</h4>
                <p>A repeating task comes back on its schedule: daily, weekdays, a weekly day, custom days, monthly, or annually. Checking it off completes it for <em>today</em>; tomorrow it returns.</p>
                <h4 class="help-heading">Complete vs. abandoned</h4>
                <p>The task page has two honest buttons: <strong>Mark complete</strong> (did it) and <strong>Mark abandoned</strong> (deliberately not doing it today). For repeating tasks, the History section below shows each past occurrence — completed, abandoned, or no record — so you can see how a routine is actually going.</p>
                <h4 class="help-heading">Also here</h4>
                <p>Reminders before the due time, a work timer per task (the Pomodoro button in the header runs focus sessions against a task), a search box, and a sidebar to filter by focus area or goal.</p>`
        },

        // ── The assistant ────────────────────────────────────────────
        {
            id: 'assistant', group: 'The assistant', title: 'AI Assistant',
            blurb: 'A private assistant that knows your data and can act on it.',
            body: `
                <p>The assistant is one chat that can do three kinds of things:</p>
                <ul class="help-app-list">
                    <li><strong>Answer about your life</strong> — it reads your tasks, goals, notes, journal, email insights, and calendar, so "what's due this week?" or "summarize my journal this month" just work.</li>
                    <li><strong>Do things for you</strong> — create tasks and notes, file action items, search the web, read pages, and (if enabled in Settings &rsaquo; AI) work with files or browse websites.</li>
                    <li><strong>Answer anything</strong> — it's also a normal assistant for questions, advice, writing, and math.</li>
                </ul>
                <h4 class="help-heading">Private by design</h4>
                <p>The model runs on your Mac through the built-in llama.cpp engine, or on a server you own. There is no cloud AI option — your conversations and personal data only reach hardware you control. Pick and manage the model in Settings &rsaquo; AI (the gear icon in the assistant's header).</p>
                <h4 class="help-heading">Trust the sources</h4>
                <p>When an answer used the web, a <strong>Sources</strong> row appears under it listing what was searched and every page actually opened. It's recorded from what the assistant really did — not from what it claims.</p>
                <h4 class="help-heading">Memory</h4>
                <p>The assistant keeps durable notes about you (preferences, ongoing situations) and uses them in later chats. Click <strong>memory</strong> in the header to read or edit everything it remembers.</p>
                <h4 class="help-heading">Long jobs</h4>
                <p>Big requests can become a <em>task</em>: the assistant plans the steps, you approve, it works through them and reports back. If it hits its per-turn action limit, it writes up what it has so far and asks whether to continue.</p>`
        },
        {
            id: 'prompts', group: 'The assistant', title: 'Background prompts & the feed',
            blurb: 'Background prompts run on a schedule and post results to a feed.',
            body: `
                <p>A <strong>prompt note</strong> (Notes &rsaquo; + New Prompt) is a reusable instruction — "summarize AI news", "draft my weekly review questions". You can run it manually, or schedule it to run in the background (daily, weekly…) on your local model — a <strong>background prompt</strong>.</p>
                <p>Background runs post to the <strong>feed</strong> on your home page — each result shows when it ran and which model wrote it. Open a post to read it full-page; from there, <strong>Discuss with Assistant</strong> starts a chat that already has the result in context, so you can ask follow-ups immediately.</p>
                <p>Options per prompt: use your personal context (run through the assistant with your briefing), allow web search, or plain offline generation.</p>`
        },

        // ── Connected accounts ───────────────────────────────────────
        {
            id: 'email', group: 'Connected accounts', title: 'Email insights',
            blurb: 'Gmail on this Mac: bundles, insights, and action items.',
            body: `
                <p>Connect Gmail (Settings &rsaquo; Accounts, or the gear in the Email header) and mail syncs from Google's servers straight to this Mac — no service in the middle.</p>
                <ul class="help-app-list">
                    <li><strong>Bundles</strong> — categorical mail (newsletters, promotions, receipts) is grouped so your inbox reads as a handful of piles, not a hundred rows.</li>
                    <li><strong>Insights</strong> — the AI reads important mail and writes short summaries of what matters.</li>
                    <li><strong>Action items</strong> — deadlines, renewals, RSVPs found in mail become tasks automatically, with a source badge linking back to the email. Confirm or dismiss; never retype.</li>
                </ul>
                <p>Each Mac syncs mail independently (Gmail is the source of truth), and analysis happens locally on your model.</p>`
        },
        {
            id: 'calendar', group: 'Connected accounts', title: 'Calendar',
            blurb: 'A timeline lens over your tasks plus Google Calendar events.',
            body: `
                <p>The Calendar shows your scheduled tasks and Google Calendar events on one timeline — month, week, or day. It's a <em>lens</em>: tasks live in Tasks, events live in Google; the calendar just lets you see time.</p>
                <p>Connect Google Calendar in Settings &rsaquo; Accounts. Today's events also appear at the bottom of the Actions Today page for time context.</p>`
        },

        // ── Everyday apps ────────────────────────────────────────────
        {
            id: 'notes', group: 'Everyday apps', title: 'Notes',
            blurb: 'Rich-text notes with tags, templates, and AI-written notes.',
            body: `
                <p>Notes is a straightforward rich-text notebook: write, format, tag, pin, search. A few things worth knowing:</p>
                <ul class="help-app-list">
                    <li><strong>Templates</strong> — a note can be <em>Blank</em>, a <em>Book</em> (chapters with a table of contents), or a <em>Prompt</em> (see Background prompts).</li>
                    <li><strong>AI Assistant notes</strong> — when the assistant writes a note for you, it's typed "AI Assistant" with a &#10024; chip, and the sidebar gets a filter to see them all.</li>
                    <li><strong>Show on Home</strong> — pin a note to your home page with the house icon.</li>
                    <li><strong>Define</strong> — select a word in any note to look it up in place.</li>
                </ul>`
        },
        {
            id: 'journal', group: 'Everyday apps', title: 'Journal',
            blurb: 'Dated entries with mood — list view or diary view.',
            body: `
                <p>The journal is for dated reflection: one or more entries per day, each with an optional mood. Read it as a list or flip through the diary view.</p>
                <p>The assistant can read your journal when you ask it to ("how was my week?") and can write entries for you ("journal this: …"). A gentle home-page nudge appears if you haven't written today.</p>`
        },
        {
            id: 'bookmarks', group: 'Everyday apps', title: 'Bookmarks',
            blurb: 'Saved links with tags, grid or list.',
            body: `
                <p>Save links with a title and tags; browse them as a grid or a list. Links open in your default browser. The assistant can save bookmarks for you and can pull them into research when you ask.</p>`
        },
        {
            id: 'portfolio', group: 'Everyday apps', title: 'Portfolio',
            blurb: 'Accounts, holdings, and live prices — all stored locally.',
            body: `
                <p>Track investment accounts (brokerage, 401k, IRA, HSA…), their holdings, and properties. Prices refresh from Yahoo Finance; cost basis uses the average-cost method; a value history chart shows the trend.</p>
                <p>Everything is stored locally like the rest of your data. The <strong>Show/Hide</strong> button in the header blanks all dollar values when someone's looking over your shoulder. Snapshot saves today's total to the history.</p>`
        },

        // ── The platform ─────────────────────────────────────────────
        {
            id: 'privacy', group: 'How it works', title: 'Privacy & your data',
            blurb: 'Everything stays on hardware you control. Where it lives.',
            body: `
                <p>Anjadhe is private by default. There is no remote database and no account. Your data is stored on this Mac at:</p>
                <div id="help-storage-path" class="help-path"></div>
                <p>AI runs on open-weight models — on this Mac through the built-in engine, or on a server you own. Your data and AI conversations only ever reach hardware you control.</p>
                <p>Backups and the storage location are managed in Settings &rsaquo; Data. Transparency logs of every AI call and web search are in Settings &rsaquo; AI &rsaquo; Logs — machine-local, never synced.</p>`
        },
        {
            id: 'sync', group: 'How it works', title: 'Sync & profiles',
            blurb: 'Your Macs stay in sync via iCloud Drive; profiles separate lives.',
            body: `
                <p><strong>Sync:</strong> changes travel between your Macs through your own iCloud Drive, encrypted. Merging happens when the app starts or you refresh (Cmd+R) — never mid-work — and the titlebar briefly shows "Synced N changes". Machine-specific things (email cache, model choices) deliberately don't sync; each Mac keeps its own.</p>
                <p><strong>Profiles:</strong> keep Work and Personal separate. Switch from the titlebar dropdown; each profile has its own tasks, goals, notes, accounts, and portfolio. Manage them in Settings.</p>`
        },
        {
            id: 'shortcuts', group: 'How it works', title: 'Keyboard shortcuts',
            blurb: 'The few keys worth knowing.',
            body: `
                <ul class="help-app-list">
                    <li><strong>Cmd+R</strong> — refresh (also pulls in sync changes from your other Macs)</li>
                    <li><strong>Esc</strong> — close the open post, menu, or overlay</li>
                    <li><strong>Enter</strong> in any quick-add box — create the item</li>
                    <li><strong>Cmd/Ctrl-click</strong> a launcher tile — open that app in a new window</li>
                </ul>`
        },
        // App Studio ships hidden behind the `appstudio` flag (Settings →
        // Build Apps); the help copy follows the flag so it never describes
        // a surface the launcher doesn't show. TOPICS is built at script
        // load and flag flips reload the app, so this stays in sync.
        (typeof FEATURES !== 'undefined' && FEATURES.isEnabled('appstudio')) ? {
            id: 'builders', group: 'How it works', title: 'Maker & App Studio',
            blurb: 'Ask the AI to build you a page, a document, or a small app.',
            body: `
                <p>Two ways to have the assistant build things of your own:</p>
                <ul class="help-app-list">
                    <li><strong>Maker</strong> — describe a document, a web page, a presentation, or a small app ("a mortgage calculator", "a research brief on X with sources") and it writes a self-contained artifact you can open any time.</li>
                    <li><strong>App Studio</strong> — extend the power of Anjadhe by building your own apps. Describe what you need (a tracker, a log, a tool — anything with saved data) and it becomes a real app that lives inside Anjadhe, right next to the built-in ones like Actions, Notes, and Journal: its own launcher tile, its own saved data, and the assistant can work with it too.</li>
                </ul>
                <p>Ask in the assistant chat ("build me a…") or open Maker / App Studio from the launcher. Builds stream their progress and run on your own model.</p>`
        } : {
            id: 'builders', group: 'How it works', title: 'Maker',
            blurb: 'Ask the AI to build you a page or a document.',
            body: `
                <p><strong>Maker</strong> — describe a document, a web page, a presentation, or a small app ("a mortgage calculator", "a research brief on X with sources") and the assistant writes a self-contained artifact you can open any time.</p>
                <p>Ask in the assistant chat ("build me a…") or open Maker from the launcher. Builds stream their progress and run on your own model.</p>`
        },
        {
            id: 'coding-agent', group: 'How it works', title: 'Build apps with a coding agent',
            blurb: 'Prefer a terminal? Point Claude Code (or any coding agent) at your apps folder.',
            body: `
                <p>${(typeof FEATURES !== 'undefined' && FEATURES.isEnabled('appstudio'))
                    ? `App Studio builds apps for you from inside Anjadhe. If you'd rather work in a terminal with a coding agent — like Claude Code — you can build the same kind of apps by hand.`
                    : `You can build your own Anjadhe apps in a terminal with a coding agent — like Claude Code.`} They live in a plain folder on your Mac and Anjadhe loads them automatically.</p>

                <h4 class="help-heading">Where apps live</h4>
                <p>Turn on <strong>Build Apps</strong> in <strong>Settings</strong>. Anjadhe creates a folder in your home directory:</p>
                <ul class="help-app-list">
                    <li><code>~/Anjadhe/apps/</code> — one subfolder per app. Each has a manifest, the app's code, and its own saved data.</li>
                    <li><code>~/Anjadhe/apps/CLAUDE.md</code> and <code>AGENTS.md</code> — the full contract for building an app: the manifest format, the <code>Anjadhe</code> SDK (storage, navigation, tools), and worked examples. Both files hold the same instructions; a coding agent reads whichever one it looks for.</li>
                    <li><code>~/Anjadhe/apps/.anjadhe-schemas.json</code> — the shape of the built-in data (notes, goals, schedule, and so on) so an app can read it.</li>
                </ul>

                <h4 class="help-heading">Point a coding agent at it</h4>
                <p>Open the folder in your terminal and start your agent there:</p>
                <ul class="help-app-list">
                    <li><code>cd ~/Anjadhe/apps</code></li>
                    <li><code>claude</code> — or whatever launches your coding agent.</li>
                </ul>
                <p>Because <code>CLAUDE.md</code> / <code>AGENTS.md</code> sit in that folder, the agent picks up the whole contract on its own. Then just describe the app you want. For example:</p>
                <p><em>"Build a reading tracker app for Anjadhe. I want to add books with a title, author, and status (want to read / reading / finished), see them grouped by status, and mark one finished. Follow the manifest and SDK in CLAUDE.md, and save data with the Anjadhe storage API."</em></p>

                <h4 class="help-heading">It updates live</h4>
                <p>Anjadhe watches the apps folder. When the agent writes or changes a file, your app reloads on its own — no restart. A new app shows up as its own launcher tile next to the built-in ones.</p>
                <p>If an app has a problem, Anjadhe writes the error to <code>.errors.log</code> inside that app's folder. Point your agent at that file and it can read the error and fix itself.</p>`
        },
    ],

    init() {
        this._bindOnce();
        this.render();
    },

    render() {
        const topic = this._topic ? this.TOPICS.find(t => t.id === this._topic) : null;
        const root = document.getElementById('help-root');
        const body = document.getElementById('help-topic-body');
        const heroTitle = document.getElementById('help-hero-title');
        if (!root || !body) return;

        this._teardownSpy();
        // The search stays; the "How can we help?" title is home-only.
        if (heroTitle) heroTitle.style.display = topic ? 'none' : '';

        if (!topic) {
            Breadcrumb.render('help-breadcrumb', [{ label: 'Help' }]);
            root.style.display = '';
            body.style.display = 'none';
            this._renderRoot();
            window.scrollTo(0, 0);
            return;
        }

        Breadcrumb.render('help-breadcrumb', [
            { label: 'Help', action: () => { this._topic = null; this.render(); } },
            { label: topic.group, action: () => { this._topic = null; this._section = topic.group; this.render(); } },
            { label: topic.title }
        ]);
        root.style.display = 'none';
        body.style.display = '';
        this._renderDoc(topic);
        window.scrollTo(0, 0);
    },

    // Icons for the section rail (matches the launcher's line-icon style).
    GROUP_ICONS: {
        'Your day': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
        'The assistant': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>',
        'Connected accounts': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>',
        'Everyday apps': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
        'How it works': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H2z"/><path d="M22 4h-6a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6z"/></svg>',
    },

    _groups() {
        const groups = [];
        for (const t of this.TOPICS) {
            let g = groups[groups.length - 1];
            if (!g || g.name !== t.group) {
                g = { name: t.group, topics: [] };
                groups.push(g);
            }
            g.topics.push(t);
        }
        return groups;
    },

    // Root: the help home — a search over a two-pane section navigator (a
    // category rail and a grid of article cards). Typing swaps the panel for
    // flat search results.
    _renderRoot() {
        const list = document.getElementById('help-topic-list');
        const empty = document.getElementById('help-search-empty');
        if (!list) return;

        const q = this._query.trim().toLowerCase();

        if (q) {
            const matches = this.TOPICS.filter(t => this._haystack(t).includes(q));
            if (empty) empty.style.display = matches.length ? 'none' : '';
            list.innerHTML = matches.length ? `
                <div class="help-section-panel">
                    <h2 class="help-section-heading">${matches.length} ${matches.length === 1 ? 'result' : 'results'}</h2>
                    <div class="help-card-grid">${matches.map(t => this._cardHtml(t, q)).join('')}</div>
                </div>` : '';
            return;
        }

        if (empty) empty.style.display = 'none';
        const groups = this._groups();
        if (!this._section || !groups.some(g => g.name === this._section)) {
            this._section = groups[0].name;
        }
        const active = groups.find(g => g.name === this._section) || groups[0];

        list.innerHTML = `
            <div class="help-browse">
                <aside class="help-sections" aria-label="Sections">
                    <div class="help-sections-label">Sections</div>
                    ${groups.map(g => `
                        <button type="button" class="help-section-item${g.name === active.name ? ' active' : ''}" data-help-section="${UIUtils.escapeHtml(g.name)}"${g.name === active.name ? ' aria-current="true"' : ''}>
                            <span class="help-section-icon">${this.GROUP_ICONS[g.name] || ''}</span>
                            <span class="help-section-name">${UIUtils.escapeHtml(g.name)}</span>
                        </button>`).join('')}
                </aside>
                <div class="help-section-panel">
                    <h2 class="help-section-heading">${UIUtils.escapeHtml(active.name)}</h2>
                    <div class="help-card-grid">${active.topics.map(t => this._cardHtml(t)).join('')}</div>
                </div>
            </div>`;
    },

    _cardHtml(t, q) {
        const title = q ? this._highlight(t.title, q) : UIUtils.escapeHtml(t.title);
        return `
            <button type="button" class="help-card" data-help-topic="${t.id}">
                <span class="help-card-title">${title}</span>
                <span class="help-card-arrow" aria-hidden="true">&#8250;</span>
            </button>`;
    },

    // Detail: a doc-style page — left chapter rail, the body, an on-this-page
    // rail that scroll-spies the section headings, and prev/next.
    _renderDoc(topic) {
        const container = document.getElementById('help-topic-body');
        if (!container) return;

        const index = this.TOPICS.indexOf(topic);
        const prev = this.TOPICS[index - 1];
        const next = this.TOPICS[index + 1];

        container.innerHTML = `
            <div class="help-doc">
                <aside class="help-doc-nav" aria-label="Articles in this section">${this._railHtml(topic)}</aside>
                <div class="help-doc-main">
                    <header class="help-doc-header">
                        <h1 class="help-doc-title">${UIUtils.escapeHtml(topic.title)}</h1>
                    </header>
                    <div class="help-section help-doc-body">${topic.body}</div>
                    <nav class="help-doc-pager" aria-label="More articles">
                        ${prev ? this._pagerCard(prev, 'prev') : '<span></span>'}
                        ${next ? this._pagerCard(next, 'next') : '<span></span>'}
                    </nav>
                </div>
                <aside class="help-doc-toc"><nav class="help-toc" aria-label="On this page"></nav></aside>
            </div>`;

        // The privacy topic shows the live storage path.
        const pathEl = document.getElementById('help-storage-path');
        if (pathEl && window.electronStore?.getStorageFolder) {
            pathEl.textContent = window.electronStore.getStorageFolder();
        }

        this._buildToc(container);
    },

    // Left rail: the other articles in this article's section, current active.
    _railHtml(topic) {
        const siblings = this.TOPICS.filter(t => t.group === topic.group);
        return `
            <div class="help-doc-nav-label">Articles in this section</div>
            ${siblings.map(t => `
                <button type="button" class="help-doc-nav-item${t.id === topic.id ? ' active' : ''}" data-help-topic="${t.id}"${t.id === topic.id ? ' aria-current="page"' : ''}>
                    <span class="help-doc-nav-text">${UIUtils.escapeHtml(t.title)}</span>
                </button>`).join('')}`;
    },

    _pagerCard(t, dir) {
        const label = dir === 'prev' ? '&larr; Previous' : 'Next &rarr;';
        return `
            <button type="button" class="help-pager-card help-pager-${dir}" data-help-topic="${t.id}">
                <span class="help-pager-dir">${label}</span>
                <span class="help-pager-label">${UIUtils.escapeHtml(this._navLabel(t))}</span>
            </button>`;
    },

    // Give the section headings ids and build the on-this-page rail from them.
    // A single heading doesn't earn a contents list.
    _buildToc(container) {
        const bodyEl = container.querySelector('.help-doc-body');
        const tocNav = container.querySelector('.help-toc');
        const tocAside = container.querySelector('.help-doc-toc');
        if (!bodyEl || !tocNav) return;

        const headings = Array.from(bodyEl.querySelectorAll('.help-heading'));
        if (headings.length < 2) {
            if (tocAside) tocAside.style.display = 'none';
            container.querySelector('.help-doc')?.classList.add('help-doc--no-toc');
            return;
        }

        const used = {};
        const items = headings.map(h => {
            let id = this._slug(h.textContent);
            if (used[id]) { id = `${id}-${++used[id]}`; } else { used[id] = 1; }
            h.id = id;
            return { id, text: h.textContent };
        });

        tocNav.innerHTML = `
            <div class="help-toc-label">On this page</div>
            <ul class="help-toc-list">
                ${items.map(it => `<li><button type="button" class="help-toc-link" data-toc-target="${it.id}">${UIUtils.escapeHtml(it.text)}</button></li>`).join('')}
            </ul>`;

        this._setupSpy(items);
    },

    // Highlight the heading currently nearest the top of the viewport.
    _setupSpy(items) {
        const links = new Map();
        document.querySelectorAll('.help-toc-link').forEach(l => links.set(l.dataset.tocTarget, l));
        const setActive = (id) => links.forEach((l, key) => l.classList.toggle('active', key === id));
        setActive(items[0].id);

        const headings = items.map(it => document.getElementById(it.id)).filter(Boolean);
        this._spy = new IntersectionObserver((entries) => {
            const visible = entries
                .filter(e => e.isIntersecting)
                .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
            if (visible[0]) setActive(visible[0].target.id);
        }, { rootMargin: '-64px 0px -70% 0px', threshold: 0 });
        headings.forEach(h => this._spy.observe(h));
    },

    _teardownSpy() {
        if (this._spy) { this._spy.disconnect(); this._spy = null; }
    },

    // Short label for the rails and pager (title before the em dash).
    _navLabel(t) {
        if (!t._nav) t._nav = t.title.split('—')[0].trim();
        return t._nav;
    },

    _slug(text) {
        return text.toLowerCase().trim()
            .replace(/[^\w\s-]/g, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-');
    },

    // Lower-cased searchable text for a topic: title + blurb + body (tags stripped).
    _haystack(t) {
        if (!t._search) {
            const bodyText = t.body.replace(/<[^>]*>/g, ' ');
            t._search = `${t.title} ${t.blurb} ${bodyText}`.toLowerCase();
        }
        return t._search;
    },

    // Escape text, then wrap case-insensitive matches of the query in <mark>.
    _highlight(text, q) {
        const escaped = UIUtils.escapeHtml(text);
        if (!q) return escaped;
        const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        return escaped.replace(re, '<mark class="help-search-hit">$1</mark>');
    },

    _bindOnce() {
        if (this._bound) return;
        this._bound = true;
        document.getElementById('help-topic-list')?.addEventListener('click', (e) => {
            const section = e.target.closest('[data-help-section]');
            if (section) {
                this._section = section.dataset.helpSection;
                this._renderRoot();
                return;
            }
            const card = e.target.closest('[data-help-topic]');
            if (!card) return;
            this._topic = card.dataset.helpTopic;
            this.render();
        });
        // Detail view: chapter rail + prev/next open a topic; the contents rail
        // scrolls to a section (buttons, not #anchors, to stay clear of the
        // app's hash router).
        document.getElementById('help-topic-body')?.addEventListener('click', (e) => {
            const nav = e.target.closest('[data-help-topic]');
            if (nav) {
                this._topic = nav.dataset.helpTopic;
                this.render();
                return;
            }
            const toc = e.target.closest('[data-toc-target]');
            if (toc) {
                const el = document.getElementById(toc.dataset.tocTarget);
                if (el) {
                    const y = el.getBoundingClientRect().top + window.scrollY - 60;
                    window.scrollTo({ top: y, behavior: 'smooth' });
                }
            }
        });
        const search = document.getElementById('help-search');
        search?.addEventListener('input', () => {
            this._query = search.value;
            // Typing while reading an article jumps back to the search results.
            if (this._query.trim() && this._topic) {
                this._topic = null;
                this.render();
            } else {
                this._renderRoot();
            }
        });
        search?.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && search.value) {
                e.stopPropagation();
                search.value = '';
                this._query = '';
                this._renderRoot();
            }
        });
    }
};

AppManager.register('help', HelpApp);
