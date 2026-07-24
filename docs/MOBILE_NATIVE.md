# Mobile app — architecture review & native (SwiftUI) plan

> Created 2026-06-18. A long-term-architecture review of the existing iPhone app
> and the plan to move its UI to native SwiftUI. Companion to `docs/PLATFORM.md`
> (the spec-app platform) and `docs/IOS_ENGINE.md` (the native spec engine).

## Session goal / TODOs

1. **Build the native iOS spec engine** (renders user-built spec apps on iPhone).
   Logic DONE 2026-06-18 in `ios-engine/Anjadhe/` (SwiftPM, `swift test`, 14/14):
   `AnjadheCore` (`JSONValue` + `KVStore` sync seam) and `AnjadheSpecEngine`
   (`SpecValidator` passes `tests/spec/corpus.json` + catalog parity; `SpecEvaluator`
   matches `spec-render-smoke.js`). **Next: the SwiftUI views** that render the
   spec tree (need the Xcode app). See `docs/IOS_ENGINE.md`.
2. **Review the existing mobile app for a long-term architecture** — DONE (below).
3. **Convert the built-in mobile views to native SwiftUI**, starting with
   `today`, `apps`, `search`. Plan below. Task/date logic port DONE
   2026-06-18 (`AnjadheCore.DateLogic` + `ScheduleLogic`, behavior-matched to
   `mobile/app.js`, deterministic UTC tests). **All native LOGIC is now done and
   `swift test`-green (21/21): JSONValue, KVStore sync seam, date/schedule logic,
   spec validator + evaluator.** Next: the **SwiftUI views** (spec renderer +
   Today/Apps/Search) and the native shell — this is the part that needs the
   Xcode app/simulator to run, so verification shifts from `swift test` to
   building the app.

## Current architecture (what exists today)

A Capacitor **WebView** app with a clean, purpose-built vanilla-JS front-end.

**1. Native shell** — `ios/App` is a standard Capacitor 8 (SPM-based) Xcode
project: a `CAPBridgeViewController` hosting a `WKWebView` that loads `www/`.
`AppDelegate.swift` is stock. Only native plugin: `@capacitor/browser`. iOS
deploy target per the Capacitor 8 default. No custom Swift yet.

**2. Build pipeline** — `scripts/build-mobile.js` assembles `www/` from: the
`mobile/` front-end, four shared data-layer files (`storage-manager.js`,
`mobile-bridge.js`, `mobile-pairing.js`, `mobile-sync.js`), and an esbuild bundle
of the secure channel (`js/channel/mobile-channel.mjs` + `@noble` crypto →
`channel.bundle.js`).

**3. Front-end** (`mobile/`) — an `App` shell (`mobile/app.js`, ~850 lines) with:
- 3 roots (`today`, `apps`, `search`) + 7 pushed apps (`tasks`, `notes`,
  `journal`, `calendar`, `prompts`, `feed`, `bookmarks`); imperative
  nav state machine (`root`/`open`/`openDetail`/`back`/`recordBack`).
- Screens are singleton closures registered via `App.registerScreen`; each
  `render(host)` rebuilds DOM from HTML strings (`App.el`/`App.esc`).
- Shared helpers: date/time, task `dueOn`/`doneToday`,
  rich-text/markdown, toast/sheet/fab.
- **Assessment:** clean, self-contained screens; no framework; main smells are
  list/editor boilerplate per screen, imperative back-stack flags, and
  rich-text/markdown logic duplicated with desktop.

**4. Data layer** — `mobile-bridge.js` shims `window.electronStore`: a synchronous
in-memory `Map` cache (every screen reads on render) written through to
**IndexedDB**; key→`{value, modifiedAt}` or `{deleted, tombAt}` tombstones; 90-day
tombstone TTL; storage-migration hooks mirroring the Mac. Screens read/write whole
JSON blobs per app key (`schedule`, `notes`, `journal`, …).

**5. Sync + channel** — `mobile-sync.js` keeps a long-lived **encrypted Noise
channel** to the paired Mac over a relay WebSocket (`window.AnjadheChannel`,
`@noble` crypto). Delta protocol: phone sends a `sync-manifest` (key→modifiedAt),
Mac replies `sync-plan` (`send`/`want`), phone applies + uploads. LWW by
`modifiedAt`; first sync is Mac-authoritative; heartbeat + backoff reconnect; Mac
pushes `data-changed` to trigger a sync. Pairing/identity in `localStorage`
(`mobile-pairing.js`). **Mac is the source of truth.**

## The one finding that defines the long-term shape

The **UI is easy to take native; the sync/channel is the crown jewel.** The
storage is just key→JSON-blob with `modifiedAt`/tombstones — trivially native.
But the Noise handshake + relay protocol + delta state machine (~700 tested JS
lines, byte-compatible with what the Mac relay speaks) is the expensive, risky
part to reimplement. So the architecture question is **not** "rewrite everything"
— it's **where native screens get their data, and whether the channel stays JS.**

The seam already exists: `window.__anjadheStore` exposes exactly 7 methods —
`exportManifest`, `exportValues`, `applyRemote`, `applyRemoteDelete`,
`localModifiedAt`, `exportSet`, plus the `electronStore` get/set/delete. That
interface is the clean boundary between storage and sync.

## Recommended long-term architecture (staged, low-risk)

Pivot on a **native Swift key-value store** (the easy, safe port), and reuse the
**JS channel** until/unless it's worth porting.

```
            ┌──────────────── SwiftUI app (native shell, tab bar) ───────────────┐
            │  Today   Apps   Search   …   + AnjadheSpecEngine (user spec apps)   │
            └───────────────────────────────┬───────────────────────────────────┘
                                            │ reads/writes (sync, fast)
                              ┌─────────────▼─────────────┐
                              │   Native KV store (Swift)  │  source of truth
                              │  key→JSON blob + modifiedAt │  (SQLite/GRDB or files)
                              │  + tombstones (mirror of    │
                              │   mobile-bridge cache)      │
                              └─────────────┬─────────────┘
                       Stage 1 seam (the __anjadheStore 7 methods)
                              ┌─────────────▼─────────────┐
                              │  Sync/channel              │
                              │  Stage 1: existing JS Noise │  in a hidden WKWebView,
                              │   + delta-sync, bridged to  │  bridged to the native
                              │   the native store          │  store (reuse ~700 lines)
                              │  Stage 2: native Swift      │  retire the WebView
                              │   channel (optional, later) │
                              └────────────────────────────┘
```

- **Native KV store (Swift)** — ~100 lines mirroring `mobile-bridge.js` cache
  semantics (value/modifiedAt, tombstones, 90-day TTL, migrations). Becomes the
  on-device source of truth; native screens read it synchronously.
- **Native SwiftUI screens** — read/write the store directly. Start with
  today/apps/search; grow to the editors. No WebView in the UI path.
- **Sync — Stage 1:** keep the proven JS Noise channel + delta-sync running in a
  hidden `WKWebView`, with `__anjadheStore` re-pointed at the native store via a
  tiny Capacitor-plugin bridge (the 7 methods). Reuses the entire tested protocol;
  no crypto reimplementation; the Mac sees no change.
  - *Seam built + verified (2026-06-18):* `js/adapter/native-bridge.js` is a
    drop-in for `mobile-bridge.js` that backs `electronStore`/`__anjadheStore`
    with the native store via `webkit.messageHandlers` (hydrate from a snapshot,
    forward writes, `applyLocalWrite` for native UI writes — loop-free). 20/20
    Node checks (`scripts/native-bridge-test.js`, in `npm test`). Native side:
    `AnjadheUI.SyncCoordinator` hosts the JS stack in a hidden `WKWebView`, wires
    `persist`/`syncState` messages to `KVStore` + the UI, hydrates the snapshot on
    load, and forwards native writes. `swift build`-clean; `native-bridge.js` ships
    into `www/` via `build-mobile.js`.
  - *Wired into the app (2026-06-18):* `SpecPreviewRoot` starts the
    `SyncCoordinator` against the bundled `public/` web assets on appear; the
    `KVStore.onLocalWrite/onLocalDelete` hooks route native UI writes (Today
    toggles, spec actions) through `pushLocal` to the JS mirror for upload
    (remote-applied writes don't fire them — no loop). A **Sync** tab shows
    connection/paired state, a "Sync now" button, and a paste-the-offer **pairing**
    field (`mobile-pairing.js` now exposes `pairWithOffer`; the native host skips
    its auto-camera via `__ANJADHE_NATIVE_HOST__`). Verified: the app builds and
    runs with the hidden sync host loaded (no crash); state shows "offline" with
    no Mac.
  - *QR scanner DONE (2026-06-18):* `AnjadheUI.QRScannerView` (AVFoundation,
    `AVCaptureMetadataOutput` `.qr`, iOS-only via `#if os(iOS)` so the package
    still builds on macOS) is wired into the Sync tab as "Scan pairing code" →
    `sync.pair`. `NSCameraUsageDescription` added to Info.plist. Builds into the
    app; the camera scan itself is a device test.
  - *Remaining (needs a paired Mac + relay — not headless-verifiable):* the live
    end-to-end sync + pairing test against a real Mac (scan the Mac's code →
    `connecting → idle` → real data flows into the native screens).
- **Sync — Stage 2 (optional, later):** port the Noise channel + delta state
  machine to Swift (swift-crypto / a Noise lib), drop the hidden WebView. The
  native store + UI don't change — the seam is the same.
- **User apps:** the `AnjadheSpecEngine` SwiftUI package renders user **spec**
  apps; the Apps screen lists built-ins + portable user apps (see
  `AppManifest.portabilityOf`).

**Why staged:** never rewrite the risky channel on day one. The native KV store is
cheap and unblocks native UI immediately; the JS channel keeps working behind a
7-method seam; going fully native later is a contained, optional follow-up that
doesn't touch the UI.

**Decision needed (the only real fork):** confirm Stage-1 hybrid (native UI +
native store + bridged JS channel) vs. an immediate full-native channel rewrite.
Recommendation: **staged hybrid.** Lowest risk, fastest to native UI, defers the
expensive crypto port until proven necessary.

## Native shell mechanics (Capacitor 8, SPM)

The Capacitor app can host native SwiftUI: make the root a `UITabBarController`
(or SwiftUI `TabView`) where today/apps/search are SwiftUI screens and the
Capacitor `CAPBridgeViewController` is either a hidden data/sync host or a
transitional tab for not-yet-ported editors. Native↔web record editors during
transition: present the WebView at the right route as a sheet, or (preferred) port
editors to native incrementally so the WebView shrinks to just the sync host.

## Conversion plan — today / apps / search (first three)

Native models mirroring the JSON blobs + the pure date logic ported to Swift:
- **Models:** `Task` (schedule.scheduleItems), `Note`
  (notes.notes), `JournalEntry` (journal.entries) — `Codable`, matching the blob
  fields exactly so they round-trip through sync unchanged.
- **Logic to port (pure, from `mobile/app.js`):** `taskDueOn`/`taskDueToday`/
  `taskDoneToday`, `relDate`/`fmtTime`, `plainText` (HTML→preview).

- **Today** — greeting + date + sync-state indicator + settings; sections:
  Today's tasks (toggle complete), Continue (3 most-recent notes/journal). Reads
  schedule/notes/journal; writes `lastCompletedDate`.
- **Apps** — searchable grid; Stage 1 = the 7 built-ins; then add portable user
  spec apps (rendered by `AnjadheSpecEngine`).
- **Search** — substring across notes/journal/tasks, 40-item cap, tap →
  open record. (Detail/editor native or transitional web.)

### Suggested first implementation step
Native KV store (Swift) + the ported date/due logic as a SwiftPM module
(testable headless, mirrors `mobile/app.js` helpers), then the SwiftUI shell +
Today screen against it. The store + logic are verifiable with `swift test`
before any simulator work.

## Risks / watch-items
- **Sync protocol parity** — keep the `__anjadheStore` seam exact; the Mac relay
  protocol is the contract.
- **Rich text / markdown** — notes/journal store HTML; feed renders markdown.
  Native needs an HTML/markdown→AttributedString renderer at parity (or keep those
  editors web during transition).
- **Background sync** — a hidden WebView is suspended in background; native push /
  background refresh is a Stage-2 benefit of a native channel.
- **Two runtimes in Stage 1** — native UI + hidden WebView for sync; acceptable
  and temporary, removed in Stage 2.
