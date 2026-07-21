/**
 * Templates written into ~/Anjadhe/apps/ when the user enables app building
 * (Settings → Build Apps). CLAUDE.md and AGENTS.md get the same content —
 * it's the contract coding agents read before building an app, so changes
 * here ARE platform-API documentation changes. Keep in sync with
 * js/core/anjadhe-sdk.js, js/core/app-manifest.js, and docs/PLATFORM.md.
 */

const AGENT_DOCS = `# Building Anjadhe Apps

This folder holds user-built apps for Anjadhe. Each subfolder is one app:

\`\`\`
<app-id>/
  manifest.json   required — see schema below
  app.js          required — registers the app (full example below)
  app.css         optional — styles, scoped under #<app-id>-view
\`\`\`

Apps load when Anjadhe starts and **hot-reload automatically** when you save
changes while Anjadhe is running — no restart needed. If an app fails to
load or throws at runtime, Anjadhe appends the error to \`<app-id>/.errors.log\`.
**After making changes, check that file** — if it has new entries, read them,
fix the code, and save again.

## manifest.json

\`\`\`json
{
    "manifestVersion": 1,
    "id": "plant-tracker",
    "name": "Plants",
    "icon": "&#10047;",
    "version": "0.1.0",
    "description": "Track houseplants and when they were last watered.",
    "keywords": ["plant", "plants", "water", "watering"]
}
\`\`\`

- \`id\`: kebab-case (lowercase letters/digits/hyphens, starts with a letter,
  2–41 chars). Must be unique — it becomes the folder name, the view DOM id
  (\`#<id>-view\`), and the storage namespace.
- \`icon\`: an HTML entity like \`&#10047;\` — never an emoji character.
- \`keywords\`: words that make the AI assistant load this app's tools when
  the user's message mentions them (the app's name and id are included
  automatically).

## app.js contract

At the top level, call \`Anjadhe.registerApp(app)\` exactly once with a plain
object. A scoped \`anjadhe\` object is **in scope everywhere in app.js** —
use it directly, no \`this\` needed:

| | |
|---|---|
| \`anjadhe.storage.get(key)\` | read a value (null if missing) |
| \`anjadhe.storage.set(key, value)\` | write a value (any JSON shape) |
| \`anjadhe.storage.delete(key)\` | remove a value |
| \`anjadhe.storage.all()\` | the whole blob |
| \`anjadhe.registerTool(definition, handler)\` | give the AI assistant a tool |
| \`anjadhe.navigate(appId)\` | open another app |
| \`anjadhe.readData(appName)\` | read a built-in app's data (see below) |
| \`anjadhe.id\` / \`anjadhe.manifest\` | identity |
| \`Anjadhe.Spec.render(container, components, ctx)\` | drop in prebuilt UI (see below) |
| \`Anjadhe.ui.escapeHtml(text)\` | escape user text before innerHTML |
| \`Anjadhe.ui.toast(message, type?)\` | brief feedback (\`success\`/\`error\`/\`info\`) |
| \`Anjadhe.ui.fetchJson(url, opts?)\` | fetch + JSON + timeout, throws on failure |
| \`Anjadhe.ui.debounce(fn, ms?)\` | debounce (use for typed lookups) |
| \`Anjadhe.ui.autocomplete(input, { search, onSelect, renderItem?, minChars?, debounceMs? })\` | wire type-ahead on an input — see below |

(The same object is also attached as \`this.anjadhe\` inside lifecycle
methods, but prefer the bare \`anjadhe\` — it works in arrow functions and
helpers where \`this\` doesn't.)

Storage is private to your app and is **automatically backed up and synced
across the user's Macs** — never use \`localStorage\` or touch
\`window.electronStore\` / other \`window.electron*\` APIs directly.

Note the capitalization: \`Anjadhe\` (capital A) only for \`registerApp\` and
\`Anjadhe.ui.escapeHtml\`; the lowercase \`anjadhe\` binding for everything
app-specific (storage, tools, navigation).

### Reading built-in app data

Apps can build on the user's existing data (journal, schedule, goals,
…). Declare what you read in the manifest — \`"reads": ["journal"]\` — then
call \`anjadhe.readData('journal')\` (read-only deep copy; throws if not
declared). **\`.anjadhe-schemas.json\` in this folder shows the exact shape
of each built-in app's data** (structure only, no contents) — read it
before binding to data so field names are right. Only declare what the
app actually needs.

Lifecycle: \`init()\` runs once at startup (register assistant tools here —
guard with your own \`_initialized\` flag, it's also called on every open);
\`render()\` runs every time the user opens the app — draw the entire view
into \`document.getElementById('<id>-view')\`.

### Complete working example

\`\`\`js
Anjadhe.registerApp({
    init() {
        if (this._initialized) return;
        this._initialized = true;
        anjadhe.registerTool({
            type: 'function',
            function: {
                name: 'plant_tracker_list',
                description: 'List houseplants with last watered date.',
                parameters: { type: 'object', properties: {} }
            }
        }, () => ({ plants: anjadhe.storage.get('plants') || [] }));
    },

    render() {
        const view = document.getElementById('plant-tracker-view');
        const esc = Anjadhe.ui.escapeHtml;
        const plants = anjadhe.storage.get('plants') || [];
        view.innerHTML =
            '<div class="spec-app">' +
                '<header class="spec-page-header"><div>' +
                    '<h1 class="spec-page-title">Plants</h1>' +
                    '<p class="spec-page-subtitle">' + plants.length + ' tracked</p>' +
                '</div></header>' +
                '<form id="pt-form" class="spec-form">' +
                    '<label class="spec-field spec-field-text">' +
                        '<span class="spec-field-label">Plant</span>' +
                        '<input id="pt-input" placeholder="Add a plant...">' +
                    '</label>' +
                    '<button type="submit" class="spec-form-submit">Add</button>' +
                '</form>' +
                '<div class="spec-records">' +
                    (plants.length
                        ? plants.map(p => '<div class="spec-record-row"><div class="spec-record-main">' +
                            '<span class="spec-record-primary">' + esc(p.name) + '</span></div></div>').join('')
                        : '<p class="spec-records-empty">Add your first plant above.</p>') +
                '</div>' +
            '</div>';
        view.querySelector('#pt-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const name = view.querySelector('#pt-input').value.trim();
            if (!name) return;
            plants.push({ name });
            anjadhe.storage.set('plants', plants);
            this.render();
        });
    }
});
\`\`\`

### Assistant tools

\`registerTool(definition, handler)\` uses OpenAI-style function definitions.
The handler receives the parsed arguments object and returns any
JSON-serializable result (it may be async). Prefix tool names with your app
id (\`plant_tracker_list\`, not \`list\`) to avoid collisions. Tools must be
**read-only or clearly safe** — the assistant may call them without
confirmation.

## Design system ("Minimal Book Theme")

Match the host app. In app.css, scope every rule under \`#<id>-view\` and use
the CSS variables — never hardcoded colors:

- Colors: \`--color-bg\`, \`--color-text\`, \`--color-text-secondary\`,
  \`--color-text-tertiary\`, \`--color-border\`, \`--color-surface\`,
  \`--color-surface-hover\`. Monochrome only — no accent colors. Semantic
  exceptions: \`#dc2626\` errors/overdue, \`#d97706\` warnings, \`#16a34a\` success.
- Primary buttons: \`background: var(--color-text); color: var(--color-bg)\`
  (inverts automatically in dark mode). Cards: \`1px solid var(--color-border)\`,
  \`border-radius: var(--radius-md)\`.
- Spacing \`--space-xs…--space-2xl\`, text \`--text-xs…--text-3xl\`,
  radii \`--radius-sm/md/lg\`, font \`--font-serif\` (headings) / \`--font-sans\`.
- Icons are HTML entities (\`&#9733;\`), never emoji. Empty states are italic
  \`--color-text-tertiary\`.

### Standard UI classes — REUSE these, never restyle the basics

The host ships a platform stylesheet (loaded globally) with the classes every
spec app is built from. When you hand-write DOM, use the SAME classes so every
form, label, field, button, and list in your app — and across all apps — has
identical geometry. Do not invent your own field/label/button layout, and do
not write CSS that re-styles inputs or buttons. The polish — hover elevation,
pressed states, focus rings, transitions — is built into these classes; an app
that reuses them looks finished with almost no CSS of its own.

Page header (open EVERY page with this — the same anatomy as the built-in
apps: a light serif title, a quiet subtitle, optional action buttons):

    <header class="spec-page-header">
      <div>
        <h1 class="spec-page-title">Plants</h1>
        <p class="spec-page-subtitle">12 tracked &middot; 3 need water</p>
      </div>
      <div class="spec-page-actions">
        <button class="spec-button">Add plant</button>
      </div>
    </header>

Form + fields (label sits ABOVE its input, always this exact shape):

    <form class="spec-form">
      <h3 class="spec-form-title">Log a drink</h3>
      <label class="spec-field spec-field-text">
        <span class="spec-field-label">Drink</span>
        <input type="text">
      </label>
      <label class="spec-field spec-field-number">
        <span class="spec-field-label">Caffeine (mg)</span>
        <input type="number">
      </label>
      <button type="submit" class="spec-form-submit">Add</button>
    </form>

Other kit classes: \`spec-section\` + \`spec-section-title\`, \`spec-card\` +
\`spec-card-title\`, \`spec-records\` / \`spec-record-row\` / \`spec-record-main\` /
\`spec-record-actions\` (lists of saved items), \`spec-records-empty\` (empty
state), \`spec-stat\` / \`spec-stat-value\` / \`spec-stat-label\` (a big metric),
\`spec-summary-grid\` + \`spec-summary-card\`, \`spec-table-wrap\` + \`spec-table\`,
\`spec-kv\` + \`spec-kv-row\` (label/value pairs). Your own app.css should only
add layout that is genuinely unique to your app (a grid of workout cards, a
timer circle) — scoped under \`#<id>-view\` as always. A finished app.css is
usually **under ~40 lines**; if you are writing rules for inputs, buttons,
cards, headers, or list rows, stop — the platform classes above already
style those.

## Spec components (prebuilt UI you can drop in)

For the parts of your app that are forms, lists, tables, or summaries,
**use \`Anjadhe.Spec.render(container, components, ctx)\` instead of writing
the DOM yourself.** It ships with form handling, persistence to the right
collection, edit + delete buttons, and the host theme — done correctly,
consistently, with much less code. Reserve hand-written DOM for what spec
components can't express (custom logic, charts, timers, drag-reorder,
markdown editors, etc).

Vocabulary:

- \`{ type: "paragraph", text }\`
- \`{ type: "section", title?, components: [...] }\` (nests other components)
- \`{ type: "divider" }\` — a horizontal rule.
- \`{ type: "card", title?, components: [...] }\` — a bordered card grouping components.
- \`{ type: "columns", count?: 2, components: [...] }\` — lays children out in 2-4
  responsive columns (collapses to one column on narrow screens).
- \`{ type: "tabs", id?, tabs: [{ label, components: [...] }] }\` — tabbed panels;
  the active tab is remembered across rerenders.
- \`{ type: "summary_grid", items: [{ label, value }] }\` — \`value\` is a
  string/number or a **computed aggregation** (see below), e.g.
  \`{ count: "books", where: { status: "read" } }\` for how many books are read,
  or \`{ sum: "expenses", field: "amount" }\` for a total.
- \`{ type: "list", items: [string], ordered? }\`
- \`{ type: "table", title?, headers: [string], rows: [[string]] }\`
- \`{ type: "form", collection, title?, submitLabel?, fields: [{ name,
  label?, input: "text" | "textarea" | "number" | "date" | "checkbox" |
  "select", options?: [string], required? }] }\` — appends a record to the
  named collection with \`id\` and \`createdAt\` added automatically.
- \`{ type: "record_list", collection, title?, fields?: [name], empty?,
  allowDelete?, sort?: { by, dir }, editFields?: [field defs],
  statusField?: { name, options: [string] }, detail?: {...} }\` — shows records
  from the collection (first \`fields\` entry is the primary line), with built-in
  delete, inline edit when \`editFields\` is provided, and — when \`statusField\`
  is set — that field renders as a one-click chip that cycles through its
  options (e.g. \`wish\` → \`read\`). When \`detail\` is set, clicking a row opens a
  **detail page** for that record:
  \`detail: { title?: "<field>", fields?: ["x","y"], source?: { url:
  "https://api…{key}…", key: "<recordField filling {key}>", resultPath?:
  "<dot path>", map: { "<recordField>": "<result.path>" } } }\`. The detail page
  shows a back button and the record's fields as label/value rows; \`source\`
  optionally fetches more from a web API the first time the record is opened
  (\`{key}\` ← \`record[source.key]\`, then \`map\` merges fields from the response).
  This is the declarative way to build a "tap an item → see its full details"
  page — no code needed.
- \`{ type: "progress", label?, value, max }\` — a labeled bar. \`value\` and
  \`max\` are numbers or computed aggregations (e.g. books read vs. total, or
  \`{ sum: "savings", field: "amount" }\` toward a goal).
- **Computed aggregation** (usable as any \`summary_grid\`/\`progress\` value):
  \`{ count|sum|avg|min|max: "<collection>", field?, where? }\`. \`count\` tallies
  records; \`sum\`/\`avg\`/\`min\`/\`max\` aggregate a numeric \`field\`; \`where\` filters
  to matching records. Bounded on purpose — for arithmetic beyond these, write
  code instead.
- **\`showWhen\`** — any component may add
  \`showWhen: { <aggregation>, op: "gt"|"gte"|"lt"|"lte"|"eq"|"ne", value }\` to
  render only when the condition holds (e.g. an "all caught up" note with
  \`showWhen: { count: "tasks", where: { done: false }, op: "eq", value: 0 }\`).
- \`{ type: "stat", label, value, caption? }\` — one prominent metric; \`value\` is a
  string/number or a computed aggregation.
- \`{ type: "badge", text, tone?: "neutral"|"success"|"warning"|"danger" }\` — a small status chip.
- \`{ type: "key_value", title?, items: [{ label, value }] }\` — label/value rows;
  each \`value\` is a string/number or a computed aggregation.
- \`{ type: "gauge", label?, value, max }\` — a radial progress dial (value/max as numbers or aggregations).
- \`{ type: "timeline", title?, items: [{ label, time?, detail? }] }\` — a vertical list of events.
- \`{ type: "chart", chartType: "bar"|"line"|"pie"|"area", title?, data }\` — \`data\`
  is a \`[{ label, value }]\` array or a \`{ collection, groupBy, agg?, field?, where? }\`
  grouping that buckets a collection by a field and aggregates each bucket.
- \`{ type: "sparkline", data }\` — \`data\` is \`[number]\` or \`{ collection, field, where? }\`.
- \`{ type: "image", url, alt?, caption? }\` — a remote image by http(s) URL.
- \`{ type: "icon", name, label? }\` — a named icon (star, heart, check, x, home,
  calendar, clock, flag, bell, bolt, book, plus, arrow-up, arrow-down).
- \`{ type: "button", label, tone?, action }\` — runs one bounded \`action\` verb:
  \`{ verb: "navigate", app }\`, \`{ verb: "open_url", url }\`,
  \`{ verb: "add_record", collection, values }\`,
  \`{ verb: "set_field", collection, field, value }\`,
  \`{ verb: "increment", collection, field, by? }\`, or
  \`{ verb: "clear_collection", collection }\`. \`set_field\`/\`increment\` act on one
  auto-created record — use them for counters/toggles (pair with a stat showing
  \`{ sum: collection, field }\`). A collection a button names counts as declared.
- \`{ type: "lookup", collection, title?, placeholder?, source: { url, resultsPath?,
  label, fields }, defaults? }\` — a search box that autocompletes against a
  public web API and appends the chosen result to \`collection\`. \`source.url\`
  contains \`{query}\` (replaced by the typed text, URL-encoded); \`resultsPath\`
  is the dot path to the results array; \`label\` is the result field shown in
  the dropdown; \`fields\` maps record fields to result paths (dot/index, e.g.
  \`"author_name.0"\`); \`defaults\` sets fixed values on each saved record (e.g.
  \`{ status: "wish" }\`). **This is the declarative way to do "type a name,
  look it up, save it" — use it instead of writing fetch/autocomplete code.**

\`ctx\` is \`{ storage, rerender }\` — pass \`anjadhe.storage\` and a thunk
that re-runs your app's \`render()\` so form submits and deletes repaint.
A form + record_list on the same \`collection\` is a complete CRUD UI in
about a dozen lines.

\`\`\`js
Anjadhe.registerApp({
    render() {
        const view = document.getElementById('book-tracker-view');
        view.innerHTML = '';
        Anjadhe.Spec.render(view, [
            { type: 'summary_grid', items: [
                { label: 'Books', value: { count: 'books' } }
            ]},
            { type: 'form', collection: 'books', submitLabel: 'Add', fields: [
                { name: 'title', label: 'Title', input: 'text', required: true },
                { name: 'author', label: 'Author', input: 'text' },
                { name: 'finished', label: 'Finished', input: 'checkbox' }
            ]},
            { type: 'record_list', collection: 'books',
              fields: ['title', 'author', 'finished'],
              empty: 'Add your first book above.',
              editFields: [
                  { name: 'title', label: 'Title', input: 'text', required: true },
                  { name: 'author', label: 'Author', input: 'text' },
                  { name: 'finished', label: 'Finished', input: 'checkbox' }
              ]}
        ], { storage: anjadhe.storage, rerender: () => this.render() });
    }
});
\`\`\`

Records persist under \`anjadhe.storage\` automatically; you don't have to
read or write them yourself.

A "type a name, look it up online, save it" app (books, movies, places) is a
\`lookup\` + a \`record_list\` — still no code:

\`\`\`js
Anjadhe.registerApp({
    render() {
        const view = document.getElementById('book-tracker-view');
        view.innerHTML = '';
        Anjadhe.Spec.render(view, [
            { type: 'lookup', collection: 'books', title: 'Add a book',
              placeholder: 'Search by title…',
              source: {
                  url: 'https://openlibrary.org/search.json?q={query}&limit=6',
                  resultsPath: 'docs', label: 'title',
                  fields: { title: 'title', author: 'author_name.0', year: 'first_publish_year' }
              },
              defaults: { status: 'wish' } },
            { type: 'summary_grid', items: [
                { label: 'Books', value: { count: 'books' } },
                { label: 'Read', value: { count: 'books', where: { status: 'read' } } }
            ]},
            { type: 'record_list', collection: 'books',
              fields: ['title', 'author', 'status'],
              statusField: { name: 'status', options: ['wish', 'read'] },
              empty: 'Search above to add your first book.',
              // Tap a book to open its detail page (its stored fields).
              detail: { title: 'title', fields: ['title', 'author', 'year', 'status'] } }
        ], { storage: anjadhe.storage, rerender: () => this.render() });
    }
});
\`\`\`

When you DO need to hand-write a lookup (custom UI a \`lookup\` can't express),
reuse the SDK helpers instead of building the widget yourself:

\`\`\`js
Anjadhe.ui.autocomplete(inputEl, {
    search: q => Anjadhe.ui.fetchJson(\`https://openlibrary.org/search.json?q=\${encodeURIComponent(q)}&limit=6\`)
                   .then(r => (r.docs || []).map(d => ({ label: d.title, author: d.author_name?.[0] }))),
    onSelect: book => {
        const list = anjadhe.storage.get('books') || [];
        list.push({ title: book.label, author: book.author, status: 'wish' });
        anjadhe.storage.set('books', list);
        this.render();
    }
});
\`\`\`

## Rules

1. Vanilla JS only — no frameworks, no build step, no imports/require.
2. Everything you persist goes through \`this.anjadhe.storage\`.
3. Always escape user content with \`Anjadhe.ui.escapeHtml()\` before
   putting it in innerHTML.
4. Re-render by calling \`this.render()\` after data changes.
5. Don't touch other apps' DOM or data; navigate with \`this.anjadhe.navigate()\`.
6. After saving changes, check \`.errors.log\` in the app folder and fix
   anything new in it.
7. CONSISTENCY: every form, field, label, button, and record list uses either
   \`Anjadhe.Spec.render\` or the standard \`spec-*\` classes (see "Standard UI
   classes"). The same pattern on every page of the app — never one layout on
   one page and a different one on another.

## Common mistakes that break loading

These are the failures that show up most often in \`.errors.log\` — check
against them before and after writing:

- app.js never calls \`Anjadhe.registerApp({...})\` at the top level (or calls
  it inside a function that never runs). It must run on load.
- Using \`import\`/\`require\`, a CDN \`<script>\`, or bundling an external
  library — none of those work; write vanilla JS. (\`fetch()\` to a public web
  API is fine — see "Network access" below.)
- Calling an API that does not exist. Use only the \`anjadhe.*\`,
  \`Anjadhe.registerApp\`, the \`Anjadhe.ui.*\` helpers, and \`Anjadhe.Spec.render\`
  methods documented above — do not guess method or option names.
- Using \`this\` inside an arrow function, a \`setTimeout\`, or a helper, where it
  is not the app object. Use the bare \`anjadhe\` binding instead.
- An emoji character in the manifest \`icon\` — it must be an HTML entity.
- Writing the whole UI by hand when \`Anjadhe.Spec.render\` would do it. Hand-
  rolled DOM and event wiring is where most runtime errors come from; prefer
  Spec for forms, lists, tables, and summaries.
- Reading built-in data without declaring it in \`"reads"\`, or guessing field
  names instead of reading \`.anjadhe-schemas.json\` first.

## Network access

Apps run inside Anjadhe's window, so \`fetch()\` works for public,
CORS-enabled web APIs. Use it when the app genuinely needs external data — a
book or movie lookup, exchange rates, and the like. Good keyless options:

- Books: Open Library — \`https://openlibrary.org/search.json?q=<query>\`
  (covers via \`https://covers.openlibrary.org/b/id/<cover_id>-M.jpg\`).
- Otherwise prefer any keyless, CORS-enabled public endpoint.

Rules for network code:

- Always handle loading and error states; never assume the request succeeds,
  and degrade gracefully when the user is offline.
- No API keys in app code. Prefer keyless endpoints.
- Only the request itself leaves the device (e.g. the search term). The user's
  own list and everything else still lives locally in \`anjadhe.storage\` — do
  not send their data to third parties.
- Debounce text-driven lookups (e.g. autocomplete) so you do not fire a request
  on every keystroke.
`;

module.exports = { AGENT_DOCS };
