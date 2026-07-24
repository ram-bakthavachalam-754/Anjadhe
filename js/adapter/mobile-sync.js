/**
 * mobile-sync.js — syncs the phone's data with the paired Mac.
 * ============================================================
 * Keeps a long-lived encrypted channel to the Mac. On launch (and on every
 * reconnect) the phone sends its key/value set; the Mac replies with the
 * merged set and the phone applies any newer values. Last-writer-wins by
 * modifiedAt — same model as the desktop iCloud journal.
 *
 * The Mac also pushes a `data-changed` message whenever something changes
 * on its side (a task you typed on the Mac, a Mac-to-Mac iCloud merge
 * arriving, …). The phone treats that as a trigger to sync immediately —
 * so a change on the Mac shows up on the phone within seconds, instead of
 * waiting for the next app launch.
 *
 * The first sync after pairing is Mac-authoritative: the phone sends an
 * empty set and adopts the Mac's data, so first-run defaults cannot
 * overwrite it.
 *
 * Sync state is surfaced through `AnjadheSync.onStateChange` so screens
 * can render a quiet header indicator instead of popping a banner.
 *
 * Mobile-only — injected by build-mobile.js after the channel bundle, the
 * mobile bridge, and the pairing screen.
 */
(function () {
  'use strict';
  if (!window.__ANJADHE_MOBILE__) return;

  const LS_IDENTITY = 'anjadhe:channel:identity';
  const LS_PAIRING = 'anjadhe:channel:pairing';
  const LS_SYNCED_ONCE = 'anjadhe:channel:synced-once';

  // Reconnect: any backoff has to stay polite to the relay. We aim for the
  // same shape as the host endpoint (1s base, 30s ceiling, 50–150% jitter).
  const RECONNECT_BASE_MS = 1000;
  const RECONNECT_MAX_MS = 30000;

  // The Mac debounces its pushes to ~500ms; we collapse syncs at a slightly
  // bigger window so several quick pushes still produce one sync round-trip.
  const PUSH_SYNC_DEBOUNCE_MS = 250;

  // Heartbeat: a network drop sometimes doesn't fire `close` on the
  // WebSocket (iOS WebView quirks, NAT timeouts). Pinging keeps it honest —
  // if no pong arrives within the deadline, we treat the channel as dead
  // and reconnect.
  const HEARTBEAT_INTERVAL_MS = 25000;
  const HEARTBEAT_TIMEOUT_MS = 8000;

  let endpoint = null;
  let connecting = false;
  let closed = false;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let pushSyncTimer = null;
  let syncInFlight = false; // a sync round-trip is mid-request
  let heartbeatTimer = null;
  let heartbeatPongTimer = null;

  // In the native host the sync WebView is rebuilt from loadHTMLString each
  // launch (no durable localStorage), so the pairing record + identity + the
  // synced-once flag are read/written through electronStore → native KVStore →
  // disk. The native bridge keeps these `anjadhe:channel:*` keys device-local.
  // On the Capacitor web build, localStorage on the real origin is durable.
  const nativeStore = window.__ANJADHE_NATIVE_HOST__ && window.electronStore ? window.electronStore : null;
  function load(key) {
    if (nativeStore) { const v = nativeStore.get(key); return v == null ? null : v; }
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }
  function save(key, value) {
    if (nativeStore) { try { nativeStore.set(key, value); } catch { /* ignore */ } return; }
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  }

  // --- observable state machine -----------------------------------------
  // Sync state is surfaced through a small subscription API instead of a
  // banner — the home screen renders a quiet icon, and we just fire state
  // changes for any subscriber. States:
  //   'offline'    — not connected (initial, or relay unreachable)
  //   'connecting' — handshake in progress
  //   'syncing'    — a sync round-trip is in flight
  //   'idle'       — handshake done, no work in flight; phone is up to date
  //   'error'      — recent failure (sync timed out, send threw). Returns
  //                  to 'connecting' or 'offline' on the next reconnect.
  let state = 'offline';
  const listeners = new Set();
  function setState(next) {
    if (state === next) return;
    state = next;
    for (const cb of listeners) { try { cb(state); } catch { /* keep firing */ } }
  }

  // Apply a {key: entry} map to local storage; returns how many keys
  // changed. Each entry is either `{value, modifiedAt}` (update) or
  // `{deleted: true, modifiedAt}` (tombstone — drop the local copy and
  // remember the delete so a third device still picks it up).
  function applyValues(values) {
    if (!values) return 0;
    let applied = 0;
    for (const key of Object.keys(values)) {
      const remote = values[key];
      if (!remote || !remote.modifiedAt) continue;
      const localAt = window.__anjadheStore.localModifiedAt(key);
      if (new Date(remote.modifiedAt) <= new Date(localAt)) continue;
      if (remote.deleted) {
        window.__anjadheStore.applyRemoteDelete(key, remote.modifiedAt);
      } else {
        window.__anjadheStore.applyRemote(key, remote.value, remote.modifiedAt);
      }
      applied++;
    }
    return applied;
  }

  /**
   * Re-render the live screen so changes pulled from the Mac actually
   * appear without a reload. Skip if the user is typing — we'd lose the
   * draft. A reload would also re-run mobile-sync, looping the app on
   * launch.
   */
  function rerenderIfIdle() {
    const el = document.activeElement;
    const typing = el && /^(INPUT|TEXTAREA)$/.test(el.tagName || '');
    if (!typing && window.App && typeof App.refresh === 'function') App.refresh();
  }

  /**
   * Stage 1 of the delta sync: send a manifest (key→modifiedAt only) so
   * the Mac can decide which values still need to travel. The endpoint
   * stays open afterwards so push notifications keep arriving on it.
   *
   * First-sync remains Mac-authoritative: an empty manifest means the
   * Mac will send everything down and request nothing up, so leftover
   * first-run defaults on the phone cannot overwrite real data.
   */
  function requestSync() {
    if (!endpoint) return;
    if (syncInFlight) return;
    syncInFlight = true;
    setState('syncing');
    const firstSync = !load(LS_SYNCED_ONCE);
    const manifest = firstSync ? {} : window.__anjadheStore.exportManifest();
    try {
      endpoint.send({ type: 'sync-manifest', manifest });
    } catch (err) {
      syncInFlight = false;
      console.warn('[mobile-sync] sync send failed:', (err && err.message) || err);
      setState('error');
    }
  }

  function finishSync(applied) {
    save(LS_SYNCED_ONCE, true);
    syncInFlight = false;
    console.log('[mobile-sync] applied', applied, 'change(s) from the Mac');
    if (applied > 0) rerenderIfIdle();
    setState('idle');
  }

  function handleHostMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'pong') {
      if (heartbeatPongTimer) { clearTimeout(heartbeatPongTimer); heartbeatPongTimer = null; }
      return;
    }
    if (msg.type === 'sync-plan') {
      // Stage-1 reply: apply values the Mac sent down, then upload values
      // for the keys it asked for. Marking the sync done after stage 1
      // (not waiting for the upload ack) makes sync feel snappy — the
      // phone shows fresh data before we even start uploading.
      const applied = applyValues(msg.send);
      finishSync(applied);
      const wanted = Array.isArray(msg.want) ? msg.want : [];
      if (wanted.length > 0) {
        try {
          endpoint.send({ type: 'sync-values', values: window.__anjadheStore.exportValues(wanted) });
        } catch { /* a failed upload will retry on next sync */ }
      }
      return;
    }
    if (msg.type === 'sync-values-ack') {
      // Mac confirmed our stage-2 upload — informational, no action.
      return;
    }
    if (msg.type === 'sync-result') {
      // Legacy full-set reply — kept for the case where the phone build
      // is running against an old Mac that hasn't shipped the delta
      // protocol yet. Should be a no-op in fresh deployments.
      finishSync(applyValues(msg.changes));
      return;
    }
    if (msg.type === 'data-changed') {
      // The Mac touched something — collapse a flurry of pushes into one
      // sync round-trip.
      if (pushSyncTimer) clearTimeout(pushSyncTimer);
      pushSyncTimer = setTimeout(() => { pushSyncTimer = null; requestSync(); }, PUSH_SYNC_DEBOUNCE_MS);
      return;
    }
  }

  /**
   * Connect (or reconnect) the long-lived channel and run an initial sync
   * once the handshake completes. No user-visible UI here — the header
   * indicator reads state via onStateChange.
   */
  function connect() {
    if (closed || connecting || endpoint) return;
    const pairing = load(LS_PAIRING);
    const identityHex = load(LS_IDENTITY);
    if (!pairing || !identityHex) return; // not paired yet
    if (!window.AnjadheChannel || !window.__anjadheStore) {
      console.warn('[mobile-sync] channel bundle not available');
      setState('error');
      return;
    }

    connecting = true;
    setState('connecting');

    // onClose fires when the relay WebSocket drops for any reason — a
    // network blip, the Worker cycling, the Mac quitting. We clear our
    // state and schedule a reconnect with backoff so the push channel
    // self-heals.
    const onChannelClose = () => {
      connecting = false;
      endpoint = null;
      syncInFlight = false;
      stopHeartbeat();
      if (closed) return;
      setState('offline');
      scheduleReconnect();
    };

    try {
      endpoint = window.AnjadheChannel.createClientEndpoint({
        relayUrl: pairing.relayUrl,
        routingId: pairing.routingId,
        identity: window.AnjadheChannel.identityFromHex(identityHex),
        hostStaticPub: pairing.hostPub,
        onMessage: handleHostMessage,
        onClose: onChannelClose,
      });
    } catch (err) {
      connecting = false;
      endpoint = null;
      console.warn('[mobile-sync] createClientEndpoint failed:', (err && err.message) || err);
      setState('error');
      scheduleReconnect();
      return;
    }

    // Watch readiness; on success, kick off the initial sync. On failure,
    // schedule a reconnect.
    Promise.race([
      endpoint.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error('could not reach your Mac')), 15000)),
    ]).then(() => {
      reconnectAttempt = 0; // a successful handshake earns a clean slate
      connecting = false;
      requestSync();
      startHeartbeat();
    }).catch((err) => {
      connecting = false;
      try { if (endpoint) endpoint.close(); } catch {}
      endpoint = null;
      console.warn('[mobile-sync] handshake failed:', (err && err.message) || err);
      setState('error');
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    const ceiling = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
    const delay = Math.round(ceiling * (0.5 + Math.random()));
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  }

  /**
   * Heartbeat: ping the Mac every HEARTBEAT_INTERVAL_MS. If no pong arrives
   * within HEARTBEAT_TIMEOUT_MS the channel is considered dead — we close
   * it locally, which fires onClose and starts the reconnect dance. This
   * catches "silent" disconnects (NAT timeouts, suspended WebView, lossy
   * networks) that don't deliver a clean close event.
   */
  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (!endpoint) return;
      try {
        endpoint.send({ type: 'ping' });
        if (heartbeatPongTimer) clearTimeout(heartbeatPongTimer);
        heartbeatPongTimer = setTimeout(() => {
          // No pong — bring the channel down so it can be rebuilt fresh.
          heartbeatPongTimer = null;
          try { if (endpoint) endpoint.close(); } catch {}
        }, HEARTBEAT_TIMEOUT_MS);
      } catch {
        try { if (endpoint) endpoint.close(); } catch {}
      }
    }, HEARTBEAT_INTERVAL_MS);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (heartbeatPongTimer) { clearTimeout(heartbeatPongTimer); heartbeatPongTimer = null; }
  }

  /**
   * Manual entry point — the home-screen sync indicator calls this on tap.
   * No banner; the state machine drives the UI through onStateChange.
   */
  function sync() {
    if (!endpoint) connect();
    else requestSync();
  }

  // Foreground: when iOS resumes the WebView, refresh state immediately
  // so the user sees the latest data without re-tapping. A bare
  // visibilitychange covers both Safari WebView and Capacitor.
  function onForeground() {
    if (document.visibilityState !== 'visible') return;
    if (!endpoint) connect();
    else requestSync();
  }

  window.AnjadheSync = {
    sync,
    getState: () => state,
    /**
     * Subscribe to sync-state changes. The callback fires synchronously
     * with the current state on subscribe so the indicator can render
     * right away, and again on every transition. Returns an unsubscribe.
     */
    onStateChange(cb) {
      if (typeof cb !== 'function') return () => {};
      listeners.add(cb);
      try { cb(state); } catch { /* keep going */ }
      return () => listeners.delete(cb);
    },
    isConnected: () => !!endpoint && !connecting,
  };

  document.addEventListener('visibilitychange', onForeground);
  window.addEventListener('focus', onForeground);

  // Wait for the IDB-backed cache to be ready before the initial sync —
  // otherwise the phone's manifest would look empty and we'd ship a
  // first-sync-style empty payload that adopts the Mac's data even when
  // we have real data locally that just hadn't loaded yet.
  const ready = window.__anjadheStoreReady || Promise.resolve();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      ready.then(() => setTimeout(connect, 600));
    });
  } else {
    ready.then(() => setTimeout(connect, 600));
  }
})();
