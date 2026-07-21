/**
 * native-bridge.js — the data shim for the NATIVE iOS app's hidden sync WebView.
 * =============================================================================
 * Stage-1 of the native architecture (docs/MOBILE_NATIVE.md): the proven JS
 * channel + delta-sync + pairing keep running in a hidden WKWebView, but their
 * storage is the native Swift `KVStore`, not IndexedDB. This file stands in for
 * mobile-bridge.js in that WebView: it provides the same synchronous
 * `window.electronStore` + `window.__anjadheStore` API that mobile-sync.js
 * expects, backed by an in-memory mirror that:
 *   • hydrates from a native snapshot at boot (`__anjadheBridge.hydrate`),
 *   • forwards every write to native (`webkit.messageHandlers.anjadhe`),
 *   • accepts native-originated UI writes (`__anjadheBridge.applyLocalWrite`)
 *     and schedules a sync upload for them.
 * Native is the source of truth; this mirror exists only to satisfy the
 * synchronous read API and to drive the channel. Loop prevention mirrors
 * mobile-sync.js: native-originated applies never re-post to native.
 *
 * The core (`createStore`) is exported for Node tests; `install(window)` wires
 * it into the WebView. Load this INSTEAD of mobile-bridge.js, before the
 * channel bundle, pairing, and sync scripts.
 */
(function (factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined' && !window.electronStore) api.install(window);
})(function () {
  'use strict';
  const EPOCH = '1970-01-01T00:00:00.000Z';

  // Entry shapes (same as mobile-bridge.js):
  //   live:      { value, modifiedAt }
  //   tombstone: { deleted: true, tombAt }
  function toWire(entry) {
    return entry.deleted
      ? { deleted: true, modifiedAt: entry.tombAt }
      : { value: entry.value, modifiedAt: entry.modifiedAt };
  }
  function fromWire(row) {
    return row && row.deleted
      ? { deleted: true, tombAt: row.modifiedAt || EPOCH }
      : { value: row && row.value, modifiedAt: (row && row.modifiedAt) || EPOCH };
  }

  /**
   * @param post   (msg) => void  — send a message to native.
   * @param getSync () => object|null — returns window.AnjadheSync (for the
   *                push debounce); injectable so tests don't need a global.
   */
  function createStore(post, getSync, onHydrated) {
    const cache = new Map();
    getSync = getSync || (() => (typeof window !== 'undefined' ? window.AnjadheSync : null));

    // Channel identity/pairing/synced-once are device-local: they must persist
    // to the native store (→ disk, so pairing survives relaunch) but must NEVER
    // be advertised or uploaded to the Mac — the Mac has its own identity under
    // the same key name, and syncing the phone's would collide. So these keys
    // are persisted but excluded from the sync manifest/values and never trigger
    // an upload.
    function isLocalOnly(key) { return typeof key === 'string' && key.indexOf('anjadhe:channel:') === 0; }

    function persist(key, entry) {
      try { post({ type: 'persist', key: key, entry: toWire(entry) }); } catch (e) { /* native gone */ }
    }

    // A burst of local writes collapses into one sync round-trip.
    const LOCAL_PUSH_DEBOUNCE_MS = 600;
    let pushTimer = null;
    function scheduleLocalPush() {
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = setTimeout(function () {
        pushTimer = null;
        const sync = getSync();
        try { if (sync && sync.sync) sync.sync(); } catch (e) { /* sync not ready */ }
      }, LOCAL_PUSH_DEBOUNCE_MS);
    }

    const electronStore = {
      get: function (key) { const e = cache.get(key); return (!e || e.deleted) ? null : e.value; },
      set: function (key, value) {
        const entry = { value: value, modifiedAt: new Date().toISOString() };
        cache.set(key, entry); persist(key, entry); if (!isLocalOnly(key)) scheduleLocalPush(); return true;
      },
      delete: function (key) {
        const entry = { deleted: true, tombAt: new Date().toISOString() };
        cache.set(key, entry); persist(key, entry); if (!isLocalOnly(key)) scheduleLocalPush(); return true;
      },
      getAll: function () { const o = {}; cache.forEach(function (e, k) { if (!e.deleted) o[k] = e.value; }); return o; },
      has: function (key) { const e = cache.get(key); return !!e && !e.deleted; },
      getPath: function () { return 'On this device'; },
      isFirstRun: function () { return false; },
      markSetupComplete: function () {},
    };

    const anjadheStore = {
      exportSet: function () {
        const set = {}; cache.forEach(function (e, k) { if (!e.deleted && !isLocalOnly(k)) set[k] = { value: e.value, modifiedAt: e.modifiedAt }; }); return set;
      },
      exportManifest: function () {
        const m = {}; cache.forEach(function (e, k) { if (!isLocalOnly(k)) m[k] = e.deleted ? e.tombAt : e.modifiedAt; }); return m;
      },
      exportValues: function (keys) {
        const out = {};
        (keys || []).forEach(function (k) {
          if (isLocalOnly(k)) return;
          const e = cache.get(k);
          if (!e) return;
          out[k] = e.deleted ? { deleted: true, modifiedAt: e.tombAt } : { value: e.value, modifiedAt: e.modifiedAt };
        });
        return out;
      },
      // Called by mobile-sync.js when the Mac sends newer data down. Update the
      // mirror AND forward to native so the native store/UI see it. Local-only
      // keys are ignored — the Mac must never overwrite the phone's identity.
      applyRemote: function (key, value, modifiedAt) {
        if (isLocalOnly(key)) return true;
        const entry = { value: value, modifiedAt: modifiedAt };
        cache.set(key, entry); persist(key, entry); return true;
      },
      applyRemoteDelete: function (key, modifiedAt) {
        if (isLocalOnly(key)) return true;
        const entry = { deleted: true, tombAt: modifiedAt };
        cache.set(key, entry); persist(key, entry); return true;
      },
      localModifiedAt: function (key) {
        const e = cache.get(key);
        if (!e) return EPOCH;
        return e.deleted ? e.tombAt : e.modifiedAt;
      },
    };

    const bridge = {
      // Native pushes the full store snapshot at boot: { key: wireRow }. Signal
      // readiness so sync waits for the disk-hydrated data (incl. pairing keys)
      // before its first connect — otherwise it could read "not paired".
      hydrate: function (rows) {
        rows = rows || {};
        Object.keys(rows).forEach(function (k) { cache.set(k, fromWire(rows[k])); });
        if (onHydrated) { try { onHydrated(); } catch (e) { /* ignore */ } }
      },
      // A native UI write (user toggled a task). Update the mirror and schedule
      // an upload — but DO NOT persist back to native (it already has it).
      applyLocalWrite: function (key, value, modifiedAt) {
        cache.set(key, { value: value, modifiedAt: modifiedAt || new Date().toISOString() });
        scheduleLocalPush();
      },
      applyLocalDelete: function (key, tombAt) {
        cache.set(key, { deleted: true, tombAt: tombAt || new Date().toISOString() });
        scheduleLocalPush();
      },
      _cache: cache, // tests
    };

    return { cache: cache, electronStore: electronStore, anjadheStore: anjadheStore, bridge: bridge };
  }

  function install(win) {
    const post = function (msg) {
      try { win.webkit.messageHandlers.anjadhe.postMessage(msg); } catch (e) { /* not in the native host */ }
    };
    // Ready resolves on the first native hydrate so sync waits for disk data;
    // a safety timeout resolves it anyway in case hydrate never arrives.
    let resolveReady;
    const ready = new Promise(function (r) { resolveReady = r; });
    let readyDone = false;
    const markReady = function () { if (!readyDone) { readyDone = true; resolveReady(); } };
    const s = createStore(post, function () { return win.AnjadheSync; }, markReady);
    setTimeout(markReady, 2000);
    win.electronStore = s.electronStore;
    win.__anjadheStore = s.anjadheStore;
    win.__anjadheBridge = s.bridge;
    win.__ANJADHE_MOBILE__ = true;
    win.__ANJADHE_NATIVE_HOST__ = true; // pairing won't auto-open the camera here
    win.__anjadheStoreReady = ready;
    // harmless stubs the renderer/sync may touch
    if (!win.electronSystem) win.electronSystem = { getInfo: function () { return Promise.resolve({ platform: 'ios' }); } };
  }

  return { createStore: createStore, install: install };
});
