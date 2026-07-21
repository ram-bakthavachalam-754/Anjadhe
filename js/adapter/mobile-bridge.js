/**
 * Anjadhe mobile bridge
 * =====================
 * The desktop app reaches the Electron main process through the contextBridge
 * globals defined in preload.js (window.electronStore, window.electronLLM, ...).
 * The mobile (Capacitor) build has no Electron and no preload, so this script
 * stands in for that bridge.
 *
 * It is injected by scripts/build-mobile.js ahead of the app's own scripts,
 * and only into the mobile bundle — the desktop index.html never loads it.
 *
 * Storage layout
 * --------------
 * The renderer needs a *synchronous* key/value store — every screen reads on
 * render. IndexedDB is async-only, so we keep an in-memory `Map` as the read
 * cache and write through to IDB in the background. The cache is filled at
 * startup, so screens that render before the first IDB I/O completes simply
 * await `window.__anjadheStoreReady`.
 *
 * Why IndexedDB and not localStorage:
 *   - localStorage caps at ~5–10 MB per origin in iOS WebView; one big note
 *     blob plus tags can blow past that.
 *   - IDB has effectively no cap for normal app data and survives the same
 *     way across app launches.
 *
 * On first run we migrate any rows the *old* localStorage-backed bridge wrote
 * (so an existing install upgrades transparently).
 *
 * Every other bridge (electronLLM, electronSync, electronAuth, electronEmail,
 * ...) is deliberately left undefined. The renderer guards each with
 * `if (!window.electronX)` and cleanly disables that feature — so AI, sync,
 * and email stay dark until later milestones wire them through the
 * phone-to-Mac channel.
 */
(function () {
  'use strict';

  // If an Electron preload already ran, this is the desktop app — do nothing.
  if (window.electronStore) return;

  const EPOCH = '1970-01-01T00:00:00.000Z';

  // --- in-memory cache ----------------------------------------------------
  // Each entry is one of:
  //   live:      { value, modifiedAt }
  //   tombstone: { deleted: true, tombAt }     (no value)
  // The cache is the authoritative read source; IDB is just where we
  // re-hydrate it from on launch.
  const cache = new Map();

  // --- IndexedDB ---------------------------------------------------------
  const DB_NAME = 'anjadhe';
  const DB_VERSION = 1;
  const STORE = 'kv';
  let db = null;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const upDb = e.target.result;
        if (!upDb.objectStoreNames.contains(STORE)) {
          upDb.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function loadAll(database) {
    return new Promise((resolve, reject) => {
      const tx = database.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const row = cursor.value;
          if (row && row.key) {
            if (row.deleted) cache.set(row.key, { deleted: true, tombAt: row.tombAt || row.modifiedAt || EPOCH });
            else cache.set(row.key, { value: row.value, modifiedAt: row.modifiedAt || EPOCH });
          }
          cursor.continue();
        } else {
          resolve();
        }
      };
      cursorReq.onerror = (e) => reject(e.target.error);
    });
  }

  // Background write — fire-and-forget. Errors land in the console rather
  // than rejecting; the in-memory cache is still consistent either way.
  function persist(key, entry) {
    if (!db) return;
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const row = entry.deleted
        ? { key, deleted: true, tombAt: entry.tombAt }
        : { key, value: entry.value, modifiedAt: entry.modifiedAt };
      tx.objectStore(STORE).put(row);
    } catch (err) {
      console.error('[mobile-bridge] IDB write failed:', key, err);
    }
  }

  // One-time migration from the old localStorage-backed bridge. Runs only
  // when IDB is empty and localStorage still holds the previous data.
  // Tombstones in localStorage (TNS prefix) are preserved.
  function migrateFromLocalStorage() {
    const NS = 'anjadhe:store:';
    const MNS = 'anjadhe:meta:';
    const TNS = 'anjadhe:tomb:';
    let migrated = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k.startsWith(NS)) {
        const key = k.slice(NS.length);
        let value;
        try { value = JSON.parse(localStorage.getItem(k)); } catch { continue; }
        const at = localStorage.getItem(MNS + key) || EPOCH;
        cache.set(key, { value, modifiedAt: at });
        persist(key, { value, modifiedAt: at });
        migrated++;
      } else if (k.startsWith(TNS)) {
        const key = k.slice(TNS.length);
        const tombAt = localStorage.getItem(k) || EPOCH;
        if (!cache.has(key)) {
          // No live row migrated for this key — record the tombstone.
          cache.set(key, { deleted: true, tombAt });
          persist(key, { deleted: true, tombAt });
          migrated++;
        }
      }
    }
    if (migrated > 0) console.log(`[mobile-bridge] migrated ${migrated} row(s) from localStorage to IDB`);
  }

  // Tombstones older than this are pruned at startup. The cutoff has to be
  // longer than any plausible offline-vacation window for a peer — if a
  // peer with a stale live copy of a deleted key comes back AFTER we drop
  // the tombstone, the stale live row would resurrect the key. 90 days is
  // generous for vacation/parental-leave scenarios while still keeping
  // long-running deletes from accumulating forever.
  const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

  // Storage-key renames. Empty today; add `{from, to}` (and an optional
  // `transform`) when an app key is renamed. Stays in lockstep with the
  // Mac's STORAGE_MIGRATIONS list — a single rename works on both sides
  // without per-platform coordination. The renaming write goes through
  // applyRemote/applyRemoteDelete so the move and the tombstone for the
  // old key sync back to the Mac on the next round-trip.
  const STORAGE_MIGRATIONS = [
    // Example (commented):
    // { from: 'app_schedule', to: 'app_tasks' },
  ];

  function runStorageMigrations() {
    for (const m of STORAGE_MIGRATIONS) {
      if (!m || !m.from || !m.to) continue;
      const src = cache.get(m.from);
      const dst = cache.get(m.to);
      if (!src || src.deleted) continue;
      if (dst && !dst.deleted) continue; // target already has data
      const value = typeof m.transform === 'function' ? m.transform(src.value) : src.value;
      const at = new Date().toISOString();
      const liveEntry = { value, modifiedAt: at };
      const tombEntry = { deleted: true, tombAt: at };
      cache.set(m.to, liveEntry);
      persist(m.to, liveEntry);
      cache.set(m.from, tombEntry);
      persist(m.from, tombEntry);
      console.log(`[mobile-bridge] migrated "${m.from}" -> "${m.to}"`);
    }
  }

  function pruneOldTombstones() {
    if (cache.size === 0) return 0;
    const cutoff = Date.now() - TOMBSTONE_TTL_MS;
    let pruned = 0;
    for (const [k, e] of Array.from(cache)) {
      if (!e || !e.deleted) continue;
      const at = e.tombAt ? Date.parse(e.tombAt) : NaN;
      if (Number.isFinite(at) && at < cutoff) {
        cache.delete(k);
        try {
          if (db) db.transaction(STORE, 'readwrite').objectStore(STORE).delete(k);
        } catch (err) { /* GC is best-effort; will retry next launch */ }
        pruned++;
      }
    }
    if (pruned > 0) console.log(`[mobile-bridge] pruned ${pruned} tombstone(s) older than 90 days`);
    return pruned;
  }

  // --- ready barrier -----------------------------------------------------
  // App startup awaits this so screens never render against an empty cache.
  // We let the promise resolve even if IDB fails — the app then runs against
  // an empty cache, which is recoverable (first launch / private browsing).
  let resolveReady;
  window.__anjadheStoreReady = new Promise((res) => { resolveReady = res; });

  (async () => {
    try {
      db = await openDB();
      await loadAll(db);
      // Migrate from the legacy localStorage bridge on the first IDB-backed
      // run. We treat "IDB had nothing" as the signal for first run; the
      // user only ever has the old layout if they updated from a pre-IDB
      // build with data already in localStorage.
      if (cache.size === 0) migrateFromLocalStorage();
      runStorageMigrations();
      pruneOldTombstones();
      console.log('[mobile-bridge] IDB ready with', cache.size, 'row(s)');
    } catch (err) {
      console.error('[mobile-bridge] IDB unavailable — running with an empty cache:', err);
    }
    resolveReady();
  })();

  // --- push local writes to the paired Mac -------------------------------
  // The desktop nudges peers with a `data-changed` push on every write so a
  // change shows up on the phone within seconds (main.js notifyChannelDataChanged).
  // The phone needs the mirror: without it, a task/note created here only
  // uploads on the next app foreground (or manual sync tap), so a just-created
  // item can sit on the phone for a while. We schedule a debounced sync after
  // each write — a burst of autosave keystrokes collapses into one round-trip,
  // and mobile-sync.js handles re-entrancy (syncInFlight) and offline queueing.
  // Remote-applied changes go through applyRemote/applyRemoteDelete (cache +
  // persist directly), not this API, so they never re-trigger a push.
  const LOCAL_PUSH_DEBOUNCE_MS = 600;
  let localPushTimer = null;
  function scheduleLocalPush() {
    if (localPushTimer) clearTimeout(localPushTimer);
    localPushTimer = setTimeout(() => {
      localPushTimer = null;
      try { if (window.AnjadheSync) window.AnjadheSync.sync(); } catch { /* sync layer not ready */ }
    }, LOCAL_PUSH_DEBOUNCE_MS);
  }

  // --- electronStore: persistent key/value store -------------------------
  // The synchronous API the renderer expects. Reads hit the cache; writes
  // update the cache, queue a background IDB write, and nudge a sync upload.
  window.electronStore = {
    get(key) {
      const e = cache.get(key);
      if (!e || e.deleted) return null;
      return e.value;
    },
    set(key, value) {
      const entry = { value, modifiedAt: new Date().toISOString() };
      cache.set(key, entry);
      persist(key, entry);
      scheduleLocalPush();
      return true;
    },
    delete(key) {
      const entry = { deleted: true, tombAt: new Date().toISOString() };
      cache.set(key, entry);
      persist(key, entry);
      scheduleLocalPush();
      return true;
    },
    clear() {
      const at = new Date().toISOString();
      for (const k of Array.from(cache.keys())) {
        const entry = { deleted: true, tombAt: at };
        cache.set(k, entry);
        persist(k, entry);
      }
      scheduleLocalPush();
      return true;
    },
    getAll() {
      const out = {};
      for (const [k, e] of cache) {
        if (e.deleted) continue;
        out[k] = e.value;
      }
      return out;
    },
    has(key) {
      const e = cache.get(key);
      return !!e && !e.deleted;
    },
    getPath() { return 'On this device'; },

    // First-run setup (storage-path picker, Ollama install) is desktop-only.
    isFirstRun() { return false; },
    markSetupComplete() { /* no-op on mobile */ },

    // Custom storage paths are a desktop filesystem concept — inert here.
    getCustomStoragePath() { return null; },
    setCustomStoragePath() { return false; },
    checkDataAtPath() { return { exists: false }; },
    getDefaultPath() { return 'On this device'; },
    getStorageFolder() { return 'On this device'; },
  };

  // --- harmless stubs for bridges that may be touched during startup -----
  if (!window.electronConfig) {
    window.electronConfig = { get: () => Promise.resolve(null) };
  }
  if (!window.electronSystem) {
    window.electronSystem = {
      getInfo: () => Promise.resolve({
        platform: 'ios', arch: 'arm64', totalMemMB: 0, cpuCount: 0,
      }),
    };
  }
  if (!window.electronMenu) {
    window.electronMenu = { onMenuAction: () => { /* no native menu */ } };
  }

  // --- sync support — used by mobile-sync.js to exchange data with the Mac
  window.__anjadheStore = {
    // Every live key with its value and last-modified time. Used by the
    // legacy full-set sync; the delta protocol prefers exportManifest +
    // exportValues so values only travel for keys that actually changed.
    exportSet() {
      const set = {};
      for (const [k, e] of cache) {
        if (e.deleted) continue;
        set[k] = { value: e.value, modifiedAt: e.modifiedAt };
      }
      return set;
    },
    // Manifest = {key: timestamp}. Includes tombstones so deletes propagate.
    // No values, so this is cheap to build and tiny on the wire.
    exportManifest() {
      const manifest = {};
      for (const [k, e] of cache) {
        manifest[k] = e.deleted ? e.tombAt : e.modifiedAt;
      }
      return manifest;
    },
    // Values (or tombstones) for a specific subset of keys.
    exportValues(keys) {
      const out = {};
      (keys || []).forEach((k) => {
        const e = cache.get(k);
        if (!e) return;
        if (e.deleted) out[k] = { deleted: true, modifiedAt: e.tombAt };
        else out[k] = { value: e.value, modifiedAt: e.modifiedAt };
      });
      return out;
    },
    // Apply a value from the Mac, keeping the Mac's modifiedAt (not "now").
    // Resurrects any local tombstone so the next sync sees the key as live.
    applyRemote(key, value, modifiedAt) {
      const entry = { value, modifiedAt };
      cache.set(key, entry);
      persist(key, entry);
      return true;
    },
    // Apply a delete from the Mac: drop the live value, keep a tombstone
    // (with the Mac's timestamp) so a third device still picks up the delete.
    applyRemoteDelete(key, modifiedAt) {
      const entry = { deleted: true, tombAt: modifiedAt };
      cache.set(key, entry);
      persist(key, entry);
      return true;
    },
    localModifiedAt(key) {
      const e = cache.get(key);
      if (!e) return EPOCH;
      return e.deleted ? e.tombAt : e.modifiedAt;
    },
  };

  // Marker for code (and later milestones) that needs to branch on platform.
  window.__ANJADHE_MOBILE__ = true;
  console.log('[mobile-bridge] active — IDB-backed; AI/sync/email enable after pairing');
})();
