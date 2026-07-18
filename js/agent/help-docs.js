/**
 * HelpDocs — the assistant's built-in knowledge of Anjadhe itself.
 *
 * This is the SOURCE OF TRUTH for app help. The website's help articles
 * (anjadhe-website/content/help/*.mdx) mirror these docs — a manual mirror,
 * same convention as the About view ↔ landing page. When a feature or a
 * Settings path changes, update the doc here first, then mirror the change
 * on the website. RELEASING.md has a per-release review step for this file.
 *
 * Served to the model one doc at a time via the get_help tool
 * (agent-tools.js, tool group 'help') — deliberately NOT injected into the
 * system prompt: the whole corpus is thousands of tokens and prompt-eval
 * dominates latency on local models. Slugs match the website's where a
 * counterpart exists ('ai-models' ↔ the site's 'cloud-models'; 'settings'
 * is app-only).
 *
 * Style: plain markdown, bold **Settings → …** paths so answers can cite
 * exact locations, no HTML, no emojis. Keep each doc under ~500 words —
 * these land in a 12B model's context as tool results.
 */
const HelpDocs = {
    docs: {
        'getting-started': {
            title: 'Getting started with Anjadhe',
            description: 'First steps: set up focus areas, add goals and tasks, connect Gmail/Calendar, enable AI.',
            content: `## Set up your focus areas

Focus areas are the headings of your life: Career, Health, Learning, Relationships, Finance. Start with three or four. They live in **Actions**, the one door that holds the whole framework.

1. Open **Actions** from the home page or sidebar, then open the **Plan** tab.
2. Click **+ New Focus area** and give it a name.
3. Optionally add a short description, and group related areas together.

A typical starter set: **Health** (fitness, sleep, checkups), **Career** (your job or a project), **Finance** (saving, investing, bills), **Learning** (courses, reading). Group related areas if it helps — a "Work" group holding Career and a project area, a "Personal" group holding Health and Family.

## Add a goal

Inside each focus area, create goals — specific, finishable outcomes with a date, not vague wishes:

- Health → "Run a 10K on October 18"
- Career → "Ship v1 of the mobile app by end of Q2"
- Finance → "Save a 6-month emergency fund by December"
- Learning → "Finish the machine-learning course by August"

Less useful: "Work on the app", "Get healthier" — you can never check those off.

## Break goals into tasks

Tasks are the day-to-day actions that move a goal forward. For "Run a 10K on October 18" that might be: "Sign up for the October 10K" (one-time, this week), "Run" repeating Mon/Wed/Sat at 7am, "Buy running shoes Saturday". Type them into the quick-add box in plain language — "Run every mon wed sat 7am" — or open the goal and click **Suggest tasks** to have the assistant propose them. For recurring behaviors, a repeating task comes back on the days you choose and tracks your streak.

The **Tasks** tab in Actions is the front door — it opens to Today, a short finishable list merging today's tasks, action items pulled from email, and your calendar. Tomorrow, This Week, This Month, Later, and each focus area are one click away in its nav.

## Connect your tools

- **Gmail** — priority emails are analyzed by your own model, and action items are extracted directly into your task list.
- **Google Calendar** — see events alongside your tasks.

Open **Settings → Accounts** to connect. Services can be toggled off any time.

## Enable AI

Open **Settings → AI** to download a model (Gemma is a good default). Everything runs on this Mac by default. For more power, point Anjadhe at your own OpenAI-compatible server, or add an OpenAI or Anthropic model with your own API key (**Settings → AI → Add model**) — always an explicit choice, never a fallback.

Everything else — Notes, Journal, Bookmarks, Portfolio — is optional; use only the parts that fit.`
        },

        'your-day': {
            title: 'Your day — Actions, Tasks, Plan',
            description: 'The Actions app: Today list, quick-add in plain language, repeating tasks, overdue, weekly review, and the Plan workspace (groups, focus areas, goals).',
            content: `Actions has two tabs. **Tasks** is what to do now — it opens to Today. **Plan** is where you organize — focus areas, goals, and structure.

## Tasks — your day

**Today** merges tasks due today, anything overdue, repeating tasks, action items pulled from email, and today's calendar events. When everything is checked off it says so — "done for today" is a reachable state.

The nav beside the list slices the same system: **Tomorrow**, **This Week**, **This Month**, **Later** (beyond this month, plus the undated backlog), and each focus area.

**Quick add.** Type into the "Add an action" box in plain language — "Call dentist tomorrow 3pm" becomes a task named "Call dentist", dated tomorrow, 3:00 PM. Dates, times, and repeat patterns ("Water plants every tuesday", "Pay rent monthly") are recognized as you type; chips under the box show what was understood before you press Enter.

**Overdue** shows above today's list. "Push to today" on the section header moves all of them; hovering a single row shows "→ Today" for just that one.

**Repeating tasks** come back on their schedule: daily, weekdays, a weekly day, custom days, monthly, annually. Checking one off completes it for today; tomorrow it returns.

**Complete vs. abandoned.** A task page has two honest buttons: Mark complete (did it) and Mark abandoned (deliberately not doing it today). Repeating tasks show a History of past occurrences. There are also reminders before the due time, a per-task work timer, and search.

**Weekly review.** The "Weekly review" link on the date line runs a short guided review — what got done, what's stuck, what matters next week. It nudges at most once a week.

## Plan — Groups, Focus areas, Goals

- **Groups** — big buckets holding related focus areas: Work, Personal, Finance.
- **Focus areas** — ongoing themes: Fitness, a project, a venture.
- **Goals** — something you can finish, with a status (not started / in progress / no progress / need help), an optional target date, and tasks.

Click down the hierarchy; the breadcrumb at the top navigates back up. "Stuck" (no progress / need help) counts show in red on Plan cards.

Structure is optional. Goals and tasks can be created unassigned and filed later — drag a goal onto a focus area, an area onto a group, or let the assistant suggest filing. On any goal, **Suggest tasks** asks the assistant to propose next steps; nothing is added until confirmed.

## A worked example

One person's tree, end to end:

- **Work** (group)
  - *Product launch* (focus area)
    - Goal: "Ship v1 by end of Q2" — tasks: "Fix login crash", "Draft release notes Friday", "Review PRs weekdays 9am" (repeating)
- **Personal** (group)
  - *Health* (focus area)
    - Goal: "Run a 10K on October 18" — tasks: "Sign up for the 10K this week", "Run every mon wed sat 7am" (repeating)
  - *Home* (focus area)
    - No goal needed — just repeating upkeep: "Water plants every tuesday", "Pay rent monthly"

Each quoted task above is literally what you'd type into quick-add — the dates, times, and repeats are parsed from the words. Note the shape: a couple of groups, a handful of areas, one or two live goals per area, and repeating tasks carrying the routines. Areas change monthly, goals weekly, actions hourly — if the tree is bigger than that, it's doing overwhelm's job for it.`
        },

        'the-assistant': {
            title: 'The assistant',
            description: 'What the AI assistant can do, agent vs. chatbot mode, memory, sources, long tasks, scheduled prompts and the feed.',
            content: `## What it does

The assistant is one chat that can: answer about your life (tasks, goals, notes, journal, email insights, calendar), do things for you (create tasks and notes, file action items, search the web, read pages, build documents and apps, and — if enabled in **Settings → AI** — work with files or browse), and answer anything general.

**Private by design.** The model runs on this Mac by default, on a server you own, or — if you added your own API key — on OpenAI or Anthropic. Conversations and personal data go only to the brain you picked. Pick and manage models in **Settings → AI**.

**Sources.** When an answer used the web, a Sources row under it lists what was searched and every page actually opened — recorded from what the assistant really did.

**Memory.** The assistant keeps durable notes about you (preferences, ongoing situations) and uses them in later chats. Click **memory** in the chat header to read or edit everything it remembers.

**Long jobs.** Big requests can become a task: the assistant plans the steps, you approve, it works through them and reports back.

**Agent mode vs. chatbot mode.** A chip on the message box shows the mode. Agent mode (default) is the full assistant: personal context, memory, tools. Click the chip for chatbot mode — your words go straight to the model, no system prompt, no personal data, no tools. Per-chat only. Useful for quick generic questions and for checking whether slowness comes from context or the model.

## Scheduled prompts & the feed

A prompt note (**Notes → + New Prompt**) is a reusable instruction — "summarize AI news". Run it manually, or schedule it (daily, weekly…) on your local model. Scheduled runs post to the feed on the home page; open a post and **Discuss with Assistant** starts a chat with the result already in context. Per-prompt options: use personal context, allow web search, or plain offline generation.`
        },

        'ai-models': {
            title: 'Choosing where the AI runs — local, your server, or your own API key',
            description: 'The three homes for the model, switching the default model, adding an OpenAI/Anthropic key, when a cloud model makes sense.',
            content: `## Three homes for the brain

Every AI feature — chat, email insights, action filing, builds — runs on one model: the **default entry** in **Settings → AI**. It can live in three places:

1. **This Mac (default).** An open-weight model like Gemma or Qwen via the built-in llama.cpp engine or Ollama. Free, offline, nothing leaves the machine. This is what first-run setup installs.
2. **A server you own.** Any OpenAI-compatible endpoint you host — llama-server, vLLM, LM Studio on a homelab box.
3. **A provider you trust, with your own key.** The official OpenAI or Anthropic API, added as a model entry with a key from your own account. Frontier capability, at the cost of sending what runs on that model to the provider.

There is no fourth option: Anjadhe has no cloud of its own and never falls back to a provider you didn't add.

## Adding an OpenAI or Anthropic model

1. **Settings → AI** → **+ Add model**.
2. Pick **OpenAI API** or **Anthropic API**.
3. Paste an API key from your account (platform.openai.com/api-keys or console.anthropic.com/settings/keys).
4. Click **List models** to fetch the live list your key can use; pick one.
5. **Test** if you like, then **Add model**.

Make it the default via the radio on its card. You can keep local and cloud models side by side and switch from the model chip in the chat box. Keys are stored encrypted on this Mac, per model, and never sync — each Mac needs its own copy.

## When a cloud model makes sense

On an 8–16 GB Mac, local models handle the core flows but can struggle with long multi-step assistant work. Be clear-eyed: what you run on a cloud model goes to that provider under your account and their data terms, and usage is billed by the provider to you — Anjadhe adds nothing on top.`
        },

        'web-search': {
            title: 'Web search — give the assistant the internet',
            description: 'Setting up a Tavily or Brave search key, what leaves the Mac, search logs.',
            content: `## Why a search key

When the assistant searches, the query goes straight from this Mac to a search provider you choose — no service in the middle. Providers require a free account that gives you an API key. Without a key the assistant still works from your data and the model's knowledge, and says when a question really needs the web.

## Get a free key (Tavily)

Tavily's free plan includes 1,000 searches a month, no credit card.

1. Sign up at tavily.com (email or Google account).
2. The dashboard shows your API key — a long code starting with "tvly-". Copy it.

## Turn it on

1. **Settings → AI** → scroll to **Web Search**.
2. On the **Tavily** card click **Manage**, paste the key, **Save Key**.
3. Click **Test** to confirm.

Keys are stored encrypted on this Mac and never sync — paste the key on each Mac you use.

## Alternative: Brave Search

The **Brave Search** card works the same way with a key from api.search.brave.com. Brave asks for a credit card and charges beyond its monthly credit, so Tavily is the easier choice for most people.

## What leaves your Mac

Only the search query — never documents, email, or notes. A Sources row under web-assisted answers lists what was searched and every page opened, and **Settings → AI → Web Search Logs** records every query that left this machine.`
        },

        'connected-accounts': {
            title: 'Connected accounts — Email & Calendar',
            description: 'Connecting Gmail and Google Calendar, email bundles/insights/action items, how the calendar lens works.',
            content: `## Email insights

Connect Gmail (**Settings → Accounts**, or the gear in the Email header) and mail syncs from Google's servers straight to this Mac — no service in the middle.

- **Bundles** — categorical mail (newsletters, promotions, receipts) is grouped into a handful of piles.
- **Insights** — the AI reads important mail and writes short summaries of what matters.
- **Action items** — deadlines, renewals, RSVPs found in mail become tasks automatically, with a source badge linking back to the email. Confirm or dismiss; never retype.

Each Mac syncs mail independently (Gmail is the source of truth), and analysis happens on your own model.

## Calendar

The Calendar shows scheduled tasks and Google Calendar events on one timeline — month, week, or day. It is a lens: tasks live in Tasks, events live in Google; the calendar lets you see time. Connect Google Calendar in **Settings → Accounts**. Today's events also appear at the bottom of the Actions Today page.`
        },

        'everyday-apps': {
            title: 'Everyday apps — Notes, Journal, Bookmarks, Portfolio',
            description: 'The capture and reference apps: note templates, journal moods, bookmark grid, portfolio accounts and prices.',
            content: `## Notes

A rich-text notebook: write, format, tag, pin, search.

- **Templates** — a note can be Blank, a Book (chapters with a table of contents), or a Prompt (a reusable instruction the assistant can run on a schedule).
- **AI Assistant notes** — notes the assistant writes are typed "AI Assistant" with a sparkle chip; the sidebar has a filter for them.
- **Show on Home** — pin a note to the home page with the house icon.
- **Define** — select a word in any note to look it up in place.

## Journal

Dated reflection: one or more entries per day, each with an optional mood. Read as a list or flip through the diary view. The assistant can read the journal on request ("how was my week?") and write entries ("journal this: …"). A gentle home-page nudge appears if you haven't written today.

## Bookmarks

Save links with a title and tags; browse as grid or list. Links open in the default browser. The assistant can save bookmarks and pull them into research.

## Portfolio

Track investment accounts (brokerage, 401k, IRA, HSA…), holdings, and properties. Prices refresh from Yahoo Finance; cost basis uses the average-cost method; a value-history chart shows the trend. The **Show/Hide** button in the header blanks all dollar values; Snapshot saves today's total to the history. Stored locally like everything else.`
        },

        'how-anjadhe-works': {
            title: 'How Anjadhe works — privacy, sync, profiles, and building your own',
            description: 'Where data lives, multi-Mac sync, profiles, keyboard shortcuts, Maker and App Studio, building apps with a coding agent.',
            content: `## Privacy & your data

Anjadhe is private by default. No remote database, no account. Data is stored on this Mac in the standard macOS Application Support area. AI runs where you choose — this Mac (default), a server you own, or OpenAI/Anthropic with your own key. Backups and storage location live in **Settings → Data & Storage**. Transparency logs of every AI call and web search are in **Settings → AI → Logs** — machine-local, never synced.

## Sync & profiles

**Sync.** Changes travel between your Macs through your own iCloud Drive, encrypted. Merging happens on app start or refresh (Cmd+R) — never mid-work — and the titlebar briefly shows "Synced N changes". Machine-specific things (email cache, model choices, API keys) deliberately don't sync.

**Profiles.** Keep Work and Personal separate. Switch from the titlebar dropdown; each profile has its own tasks, goals, notes, accounts, and portfolio. Manage in **Settings → Manage Profiles**.

## Keyboard shortcuts

- **Cmd+R** — refresh (also pulls sync changes from other Macs)
- **Esc** — close the open post, menu, or overlay
- **Enter** in any quick-add box — create the item
- **Cmd/Ctrl-click** a launcher tile — open that app in a new window

## Maker & App Studio

Two ways the assistant builds things of your own:

- **Maker** — describe a document or small interactive page ("a mortgage calculator", "a research brief on X with sources") and it writes a self-contained artifact.
- **App Studio** — describe an app (a tracker, a log, anything with saved data) and it becomes a real app inside Anjadhe: its own launcher tile, its own data, and the assistant can work with it.

Ask in chat ("build me a…") or open Maker / App Studio from the launcher. Builds stream progress and run on your own model.

## Build apps with a coding agent

Prefer a terminal? Turn on **Build Apps** in **Settings**. Anjadhe creates ~/Anjadhe/apps/ — one subfolder per app, plus CLAUDE.md / AGENTS.md holding the full contract (manifest format, the Anjadhe SDK, worked examples) and .anjadhe-schemas.json describing built-in data shapes. Start your coding agent in that folder and describe the app; the agent picks up the contract on its own. Anjadhe watches the folder — changes reload live, and errors are written to .errors.log inside the app's folder so the agent can read and fix them.`
        },

        'settings': {
            title: 'Settings reference — every section and where things live',
            description: 'Map of the Settings app: AI, Accounts, Appearance, Browser, Data & Storage, Privacy & Security, Build Apps, Advanced.',
            content: `Settings opens from the home page or sidebar. A search box at the top filters across every section. Sections:

## Set up Anjadhe
The guided setup checklist: connect Google, turn the inbox into tasks, add a web-search key, add a frontier model, try the assistant.

## AI (Settings → AI)
The assistant's whole brain, in one place:
- **Models** — the model list with a default-model radio. Download local models (llama.cpp or Ollama engine), point at your own OpenAI-compatible server, or **+ Add model** with an OpenAI/Anthropic API key. Per-model Manage panel for keys and options.
- **Web Search** — Tavily / Brave key cards (Manage → paste key → Save → Test).
- **MCP servers** — connect external tool servers the assistant can use.
- **Permissions** — grants the assistant has been given (files, shell, servers); review or revoke.
- **Memories** — everything the assistant remembers about you; edit or delete.
- **Logs** — transparency logs of every AI call, web search, and network request from this machine.

## Accounts (Settings → Accounts)
Connect or disconnect Google (Gmail, Calendar) per account. Each Mac authorizes independently.

## Appearance
Dark mode (follows the OS or manual), and Customize home apps — show/hide/reorder launcher tiles.

## Browser
Default search engine for the built-in browser (DuckDuckGo, Google, Bing, Kagi, Brave).

## Data & Storage
Database location, disk usage, backups, and **Sync Encryption** — set a passphrase that protects the multi-Mac sync key end-to-end.

## Privacy & Security
- **App Lock** — require Touch ID / passcode to open the app, and pick specific apps to lock (Notes, Journal…).
- **Network logs** — every outbound connection this app made.
- **Usage signals** — anonymous, off by default.

## Manage Profiles
Create/switch Work and Personal profiles; each keeps separate data.

## Build Apps (Developer)
Turn on the ~/Anjadhe/apps/ folder for coding-agent-built apps, and show/hide App Studio.

## Advanced
Developer tools (inspect/debug).`
        }
    },

    /** Compact index — slugs with one-liners, for an invalid/omitted topic. */
    index() {
        return Object.entries(this.docs).map(([slug, d]) => ({
            topic: slug, title: d.title, about: d.description
        }));
    },

    get(topic) {
        const doc = this.docs[topic];
        if (!doc) return null;
        return { topic, title: doc.title, content: doc.content };
    },

    slugs() {
        return Object.keys(this.docs);
    }
};
