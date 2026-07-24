# Task Sync — importing from other task-management apps

Status: **PLAN** (2026-07-21). Nothing built yet.

Goal: let a user connect the task manager they already use (Todoist first)
and have their tasks and projects flow into Anjadhe's Schedule / Focus /
Goals apps — so switching to (or living alongside) Anjadhe doesn't start
from a blank slate, and Anjadhe's assistant can reason over the user's
*whole* task world.

This is a **connector/sync engine**, distinct from the iCloud multi-device
sync journal (which syncs Anjadhe's own data between Macs). Naming inside
code: `task-sync` / "Connections".

---

## 1. Positioning constraints (read docs/POSITIONING.md first)

- **Direct device → provider.** All connector traffic goes straight from
  the user's Mac to the provider's API (Todoist, Microsoft, Google…).
  No Anjadhe relay server, ever. Copy rule: "your tasks go only where you
  point them."
- **Bring-your-own credentials.** Prefer providers that let the user paste
  a personal API token (Todoist, Notion, Asana, Trello, Linear) or that
  support public-client OAuth with PKCE and no secret (Microsoft, Google).
  Providers that *require* a confidential client secret (TickTick) either
  wait, or ship with a registered Anjadhe app id and honest copy.
- **Local-first providers are a positioning gift.** Apple Reminders (and
  later Things 3) never touch the network at all — "import from Reminders,
  entirely on this Mac" is exactly the pitch.
- **No new Google scopes casually.** Google Tasks could ride the existing
  unified Google OAuth, but adding the `tasks` scope changes the verified
  scope set (console Data Access must exactly match; CASA re-assessment
  implications). Treat Google Tasks as its *own* consent/token, or defer.

---

## 2. Which apps can we integrate — the landscape

### Tier 1 — build first

| Provider | API | Auth | Incremental sync | Fit |
|---|---|---|---|---|
| **Todoist** | Unified API v1 (2025; replaces REST v2 + Sync v9). Tasks, projects, sections, labels, comments, webhooks. | **Personal API token paste** (Settings → Integrations) or OAuth. | Yes — `sync_token` partial sync, 1000 partial / 100 full req per 15 min. | Best-in-class API, token-paste matches BYOK positioning, biggest personal-task-app user base. **The reference implementation.** |
| **Apple Reminders** | Local EventKit (no network). Needs a tiny helper: `osascript`/JXA (slow but zero-dep) or a small bundled Swift CLI (fast, needs notarized binary + TCC Reminders permission prompt). | macOS permission dialog only. | Re-read + diff (EventKit has no cursors; lists are small). | 100% local — flagship privacy story. Every Mac user has it. |
| **Google Tasks** | Google Tasks API — tasklists + tasks, `updatedMin` + `showDeleted` for incremental. | New scope on Google OAuth — keep as a **separate token/consent**, do not widen the verified unified scope set silently. | Yes (`updatedMin`). | Cheap to build on existing Google plumbing; gated on the OAuth-verification question. |

### Tier 2 — next wave

| Provider | API | Auth | Notes |
|---|---|---|---|
| **Microsoft To Do** | Graph `/me/todo` lists + tasks; **delta queries** supported. | Public client + PKCE (no secret) — desktop-app friendly. | Clean API; covers the Outlook/Windows-adjacent crowd. |
| **TickTick** | Open API: OAuth only (`tasks:read`/`tasks:write`), registered app with secret, **no webhooks, no "all tasks" endpoint** — must walk project by project; completed tasks poorly covered. | OAuth w/ client secret (their console). | Popular, but API is a clear step down. Import-only, poll-on-open. |
| **Things 3** | No cloud API. Read: local SQLite (`~/Library/Group Containers/JLMPQHK86H.…/main.sqlite`, unofficial schema). Write: `things:///` URL scheme (add/update with local auth token). | None (local file + URL scheme). | Local-only like Reminders — great positioning, fragile schema. Import-first. |

### Tier 3 — project-tool territory (later, likely agent/MCP instead)

Asana, Trello, Notion databases, Linear, ClickUp, Jira. All offer personal
tokens, but they are *team project* tools; their models (boards, custom
fields, workflows) map poorly onto a personal schedule. The cowork agent's
**MCP client** (`js/main/mcp-manager.js`) is often the better door for
these — the user adds the provider's MCP server and the agent acts on it —
rather than first-class sync connectors. Revisit per demand.

Explicitly out: Habitica, OmniFocus (Omni Automation is scripting-only),
anything requiring us to run a server.

---

## 3. How external models map onto Anjadhe

Anjadhe's model (see `js/apps/schedule/schedule-app.js`):
- **Schedule item** = the task unit. Fields: `id, title, description,
  scheduledDate (YYYY-MM-DD), startTime/endTime, repeat/dayOfWeek/repeatDays,
  reminderDaysBefore, lastCompletedDate, history, profile, createdAt,
  modifiedAt` (+ email-source fields). Stored in the `schedule` blob's
  `scheduleItems`. **No priority field, no subtasks, no projects on the
  item** — grouping is purely date-derived (overdue/today/tomorrow/later/noDate).
- **Focus area** = the "project"-shaped concept (title, description, color,
  group). Tasks attach to areas via **LinkManager**, not a field.
- **Goal** = outcome with `targetDate`; milestones are schedule tasks
  linked via LinkManager.

### Canonical mapping (Todoist vocabulary; others analogous)

| External | Anjadhe | Rule |
|---|---|---|
| Task | Schedule item | 1:1. `content` → `title`, `description` → `description`. |
| Project | **Focus area** (opt-in, on by default) | Create/reuse a focus area per imported project; link each imported task via `LinkManager.addLink('schedule', taskId, 'focus', areaId)`. Todoist "Inbox" → no area. |
| Section | (dropped) | Optionally noted in `description` footer. No Anjadhe equivalent worth inventing. |
| Due date | `scheduledDate` | Date part. Datetime dues also set `startTime`. No due → `scheduledDate:''` → lands in Anjadhe's "someday" bucket. |
| Recurring due (`due.is_recurring`, natural-language `due.string`) | `repeat` family | Translate the subset we can: every day/week/weekday/month/year → `weekly`/`custom`+`repeatDays`/`monthly`/`annually`. Untranslatable rules ("every 3rd workday"): import as one-time on next occurrence, append "(repeats in Todoist: …)" to description, and **leave recurrence authority with the provider** (each completion re-imports the next occurrence). |
| Priority p1–p4 | (none) | Anjadhe has no priority. v1: p1 → prefix "!! " nothing else, or drop entirely — decided: **drop, keep in `external.priority` for round-trip fidelity**. Adding a real priority field to Schedule is an open product question (§8). |
| Labels | (dropped, kept in `external.labels`) | Round-trip fidelity only. |
| Subtasks (`parent_id`) | Flattened schedule items, linked to the same focus area | Anjadhe has no hierarchy. Child imports as its own task with "↳ parent-title: " context in description. Revisit if a checklist field ever lands. |
| Completed | `lastCompletedDate` + `history[date]='done'` | Map completion timestamp's local date. |
| Deleted in provider | Local delete **iff untouched locally**, else keep + mark orphaned (like email's `sourceEmailId` strip). Ledger tombstone prevents resurrection. |
| Comments/attachments | (dropped) | Out of scope. |

Provider-specific deltas:
- **Reminders**: list → focus area; due date+time; recurrence rules map
  well (EventKit exposes structured rules); priority exists (drop, same rule);
  flagged → nothing.
- **Google Tasks**: tasklist → focus area; only due *dates* (API drops
  time); has parent/position subtasks → flatten; no recurrence in API.
- **Microsoft To Do**: list → focus area; structured `recurrence` maps
  well; `importance` → drop; checklist items → flatten or description bullet.
- **TickTick**: project → focus area; priorities 0/1/3/5 → drop; local
  recurrence in iCal RRULE subset → translate what fits.

### Fields added to imported schedule items

Mirrors the `source:'email'` convention (`sourceEmailId` etc.):

```js
{
  source: 'todoist',            // provider id: 'todoist'|'reminders'|'gtasks'|'mstodo'|'ticktick'|'things'
  sourceAccount: '<account key>',   // provider account (email / token hash / 'local')
  sourceExternalId: '<provider task id>',
  sourceProjectName: 'Errands',     // display only, for the detail-view banner
  external: {                       // round-trip fidelity stash (priority, labels, raw due string…)
    priority: 4, labels: ['home'], dueString: 'every fri'
  },
  externalModifiedAt: '<provider updated_at>',  // conflict detection
}
```

Duplicating a task strips `sourceExternalId` (same as `sourceEmailId` today).
Detail view gets a source banner ("From Todoist · Errands") like the email
banner (`schedule-ui.js:448`), linking out via the provider's app/web URL.

---

## 4. Sync engine architecture

Follow the proven in-repo patterns — this is deliberately boring:

```
js/main/task-sync/
  task-sync-manager.js      // orchestrator: accounts, scheduling, IPC surface
  providers/todoist.js      // per-provider connector implementing one interface
  providers/reminders.js
  providers/…
js/apps/schedule/task-import.js   // renderer-side merge into the schedule blob
```

- **All HTTP in the main process** over the existing SSRF-guarded `https`
  helper pattern (like `gmailApiCall` / `calendarApiRequest`); renderer
  talks to `window.electronTaskSync` (preload) → `task-sync-*` IPC.
  Provider hostnames are a fixed allowlist (`api.todoist.com`,
  `graph.microsoft.com`, …).
- **Provider interface** (each connector implements):
  `getAccount()`, `fullSync()`, `deltaSync(cursor) → {tasks, projects,
  deletedIds, nextCursor}`, `pushOps(ops)` (phase 2+), `verify()`.
- **Credentials** in `settingsStore`, `safeStorage`-encrypted, fail-closed
  — exactly the `gmailTokens_${email}` pattern. Keys:
  `taskSyncTokens_${provider}_${account}`. Never in the synced `dataStore`.
  OAuth providers reuse the loopback+PKCE+state flow from
  `email-start-oauth` (`main.js:5793`), generalized.
- **Cursors** (`sync_token`, Graph delta links, `updatedMin` watermarks) in
  a `settingsStore` key `taskSyncCursors` — machine-local by design, same
  as `calendarSyncTokens`.
- **Dedup ledger** — the linchpin for multi-Mac correctness. Inside the
  *synced* `schedule` blob, sibling of `emailActionLedger`:

  ```js
  externalTaskLedger: {
    'todoist:<account>:<externalId>': { taskId, deletedAt? }
  }
  ```

  Ledger syncs between Macs via the iCloud journal, so two Macs each
  connected to the same Todoist account import every task **once**: the
  merge step is a ledger-keyed upsert (create if no entry, update the
  existing `taskId` otherwise, skip if tombstoned). Cursors being per-Mac
  is then harmless — a second Mac's full sync just no-ops through the
  ledger. `ScheduleApp.saveData()` already merges rather than replaces the
  blob, so the ledger survives normal saves.
- **Conflict policy** (phase 2+): compare provider `updated_at` against
  local `modifiedAt` since last sync; last-writer-wins; on a true tie/both-
  changed, provider wins for fields it owns (due, recurrence), local wins
  for completion done in Anjadhe. Phase 1 sidesteps this: provider is
  authoritative for everything except local completion.
- **Trigger model** — the calendar precedent (`syncIfStale`), not the
  iCloud-journal rule: sync on app/Schedule open when stale (>15 min),
  manual "Sync now" button, and after any local write-back. No tight
  background polling; webhooks (Todoist has them) require a public
  endpoint — never, by positioning.
- **Rate limits**: Todoist 1000 partial/15 min is generous; still batch
  writes and back off on 429 with `Retry-After`.

### Direction, phased

1. **Import (one-way)** — provider → Anjadhe, repeatedly and
   incrementally. Local edits to imported tasks allowed but overwritten
   only field-by-field when the provider side changed (else preserved).
2. **Completion write-back** — completing an imported task in Anjadhe
   closes it in the provider (queued op, retried; `history` entry marked
   `pushedAt` in the ledger so a second Mac never double-pushes).
3. **Full two-way** — edits and *new* Anjadhe tasks optionally created in
   a chosen provider project. Only after 1–2 are boringly reliable.

---

## 5. UI

- **Settings → Connections** (new section near the Google account card):
  one card per provider — Connect (token paste field for Todoist, with a
  "where to find your token" link; OAuth button for Microsoft/Google;
  permission request for Reminders), then status ("Connected as … ·
  Last synced 5 min ago · 214 tasks"), Sync now, Disconnect.
- **Import options** per connection: choose projects/lists (default all),
  include completed history (default: last 30 days), "create Focus areas
  from projects" toggle (default on).
- **Disconnect** asks: keep imported tasks (strip `sourceExternalId`,
  like email does on message deletion) or remove them (ledger tombstones).
- Schedule detail view: provider banner, mirroring the email banner.
- Copy per POSITIONING.md: "Anjadhe talks to Todoist directly from this
  Mac using your own token. Your tasks go only where you point them."

---

## 6. Phases & checklists

**T0 — engine + Todoist import (one-way)**
- [ ] `task-sync-manager.js`, provider interface, IPC + preload bridge
- [ ] Todoist connector: token paste, verify, full + `sync_token` delta sync
- [ ] Mapping layer + `externalTaskLedger` upsert merge in schedule blob
- [ ] Project → Focus area creation + LinkManager wiring
- [ ] Settings → Connections card, Sync-now, disconnect (keep/remove)
- [ ] Detail-view source banner
- [ ] Two-Mac test: same Todoist account connected on both, no dups

**T1 — Apple Reminders (local)**
- [ ] Helper decision: JXA vs bundled Swift CLI (spike both; JXA if <2s
      for 500 reminders)
- [ ] TCC permission flow + graceful "denied" state
- [ ] Recurrence mapping from EventKit rules

**T2 — completion write-back (Todoist first)**
- [ ] Op queue + `pushedAt` ledger stamps; 429/offline retry
- [ ] Recurring-task completion → provider computes next occurrence →
      delta re-import updates the local anchor

**T3 — Google Tasks / Microsoft To Do**
- [ ] Resolve the Google-scope/CASA question first (§8)
- [ ] MS public-client registration + PKCE flow

**T4 — two-way, TickTick, Things import** — scope when T0–T2 are stable.

---

## 7. Security notes

- Tokens: `safeStorage` encrypted, fail closed (refuse to store if
  keychain unavailable) — copy `setGmailTokens` semantics including the
  "don't delete on transient decrypt failure" rule.
- Fixed hostname allowlist per provider; route through the `_guardedLookup`
  SSRF guard like every other outbound call.
- Token-paste field: never echo the token back into the DOM after save;
  show `••••` + account name from `verify()`.
- Imported task text is untrusted content everywhere it renders (same
  escaping discipline as email subjects).

## 8. Open questions

1. **Priority field on schedule items?** Every provider has one; Anjadhe
   deliberately doesn't. Recommendation: keep dropping it for T0 (stash in
   `external`), decide after seeing real imported data whether a minimal
   flag ("important") earns its place.
2. **Google Tasks scope**: separate consent alongside the unified Google
   token, or fold into `GOOGLE_UNIFIED_SCOPES` and redo console Data
   Access + CASA scope declaration? Needs a call before T3.
3. **Subtask fidelity**: flattening loses structure; acceptable for
   import, awkward for two-way. Revisit at T4.
4. **Agent integration**: expose connections to the cowork agent as tools
   ("what's overdue across everything, including Todoist")? Free once the
   data is in the schedule blob — but a `sync_connections` agent tool
   (trigger a refresh) may be worth adding at T2.
