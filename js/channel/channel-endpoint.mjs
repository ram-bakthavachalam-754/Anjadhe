/**
 * channel-endpoint.mjs
 * ====================
 * Connects to the Anjadhe relay and runs an end-to-end-encrypted channel on
 * top of it. The Mac uses `createHostEndpoint`; the phone uses
 * `createClientEndpoint`. Both build on:
 *   - the relay protocol            (relay/server.js)
 *   - the handshake + frame crypto  (secure-channel.mjs)
 *
 * It runs in Node (the Electron main process) and in the iOS WebView — it
 * only uses the global WebSocket, which both provide.
 *
 * The relay forwards opaque `data` payloads. This module tags each one:
 *   'H' + hex   handshake — ephemeral / static *public* keys (no secrets)
 *   'E' + hex   a SecureChannel-sealed app message
 * App messages are JSON objects; the relay never sees their plaintext.
 */
import { startHandshake } from './secure-channel.mjs';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const PUBKEY_HEX = 64; // a 32-byte key encoded as hex

function packMessage(channel, obj) {
  return 'E' + bytesToHex(channel.seal(enc.encode(JSON.stringify(obj))));
}
function unpackMessage(channel, body) {
  return JSON.parse(dec.decode(channel.open(hexToBytes(body))));
}

/**
 * Build the relay WebSocket URL. The production relay (Cloudflare Workers)
 * routes to a per-room Durable Object by the routing ID in the URL path; the
 * Node relay (relay/server.js) ignores the path and reads the id from the
 * hello frame — so appending it works against both.
 */
function relaySocketUrl(relayUrl, routingId) {
  return relayUrl.replace(/\/+$/, '') + '/' + encodeURIComponent(routingId);
}

/**
 * Mac side. Registers as `host` for `routingId`, accepts sessions from paired
 * phones, and surfaces decrypted requests through `onRequest`.
 *
 * Long-lived: it reconnects to the relay on its own (exponential backoff with
 * jitter) if the connection drops, until `close()` is called. `ready` resolves
 * on the first successful connection; `isConnected()` reflects the live state.
 *
 *   isPairedPeer(staticPubHex) -> boolean   is this phone paired with us?
 *   onRequest(peerId, message, respond)     respond(obj) sends an encrypted reply
 */
export function createHostEndpoint({ relayUrl, routingId, identity, isPairedPeer, onRequest, onPairing }) {
  const sessions = new Map(); // relay clientId -> { channel, peerStatic }

  // Relay reconnection. The connection to the relay can drop at any time —
  // the network changes, the relay restarts, the Mac wakes from sleep. The
  // endpoint reconnects on its own with exponential backoff (1s, 2s, 4s …
  // with the ceiling held near 30s) plus jitter, so a fleet of Macs does not
  // stampede the relay as it comes back. A connection that proves stable
  // resets the backoff.
  const RECONNECT_BASE_MS = 1000;
  const RECONNECT_MAX_MS = 30000;
  const STABLE_MS = 30000; // a connection alive this long is deemed healthy

  let ws = null;
  let closed = false;       // close() was called — stop reconnecting for good
  let connected = false;    // a relay session is live (between welcome & close)
  let reconnecting = false; // a drop has occurred — affects only log wording
  let attempt = 0;          // consecutive failed connects; drives the backoff
  let reconnectTimer = null;
  let stableTimer = null;

  let resolveReady;
  // `ready` resolves on the first successful connection and never rejects —
  // an unreachable relay is a retry state here, not a terminal failure.
  const ready = new Promise((res) => { resolveReady = res; });

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    const ceiling = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    const delay = Math.round(ceiling * (0.5 + Math.random())); // 50–150% jitter
    attempt += 1;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  }

  function connect() {
    if (closed) return;
    ws = new WebSocket(relaySocketUrl(relayUrl, routingId));

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ t: 'hello', routingId, role: 'host' }));
    });

    // A failed or dropped connection emits 'error' then 'close'; reconnection
    // is driven from 'close' alone. The 'error' listener must still exist —
    // without one the underlying socket treats the error as unhandled.
    ws.addEventListener('error', () => {});

    ws.addEventListener('close', () => {
      connected = false;
      if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
      // Sessions are bound to this socket, and the relay issues fresh
      // clientIds on reconnect — drop them so phones cleanly re-handshake.
      sessions.clear();
      if (!closed) {
        reconnecting = true;
        console.warn('[channel] relay connection lost — reconnecting');
        scheduleReconnect();
      }
    });

    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'welcome') {
        connected = true;
        if (reconnecting) {
          reconnecting = false;
          console.log('[channel] relay connection restored');
        }
        // Reset the backoff only once a connection has proven stable, so a
        // relay that accepts then immediately drops keeps backing off.
        if (stableTimer) clearTimeout(stableTimer);
        stableTimer = setTimeout(() => { attempt = 0; }, STABLE_MS);
        return resolveReady();
      }
      if (m.t === 'peer-join') { if (!sessions.has(m.clientId)) sessions.set(m.clientId, { channel: null }); return; }
      if (m.t === 'peer-leave') { sessions.delete(m.clientId); return; }
      if (m.t === 'data') return onData(m.from, m.payload);
    });
  }

  function sendRaw(clientId, payload) {
    // While the relay is unreachable, drop the send rather than throw — the
    // phone reissues its request after it reconnects.
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ t: 'data', to: clientId, payload }));
    }
  }

  function onData(clientId, payload) {
    if (typeof payload !== 'string' || payload.length < 1) return;
    let sess = sessions.get(clientId);
    if (!sess) { sess = { channel: null }; sessions.set(clientId, sess); }
    const tag = payload[0];
    const body = payload.slice(1);

    if (tag === 'H') {
      // The phone's handshake: clientStaticPub || clientEphemeralPub.
      const clientStatic = body.slice(0, PUBKEY_HEX);
      const clientEph = body.slice(PUBKEY_HEX, PUBKEY_HEX * 2);
      if (clientStatic.length !== PUBKEY_HEX || clientEph.length !== PUBKEY_HEX) return;
      if (!isPairedPeer(clientStatic)) return; // unknown phone — ignore
      const hs = startHandshake(identity, clientStatic, 'responder');
      sess.channel = hs.complete(clientEph);
      sess.peerStatic = clientStatic;
      sendRaw(clientId, 'H' + bytesToHex(hs.ephemeralPublicKey));
    } else if (tag === 'E') {
      if (!sess.channel) return;
      let message;
      try { message = unpackMessage(sess.channel, body); }
      catch { return; } // tampered / replayed — rejected by the AEAD
      onRequest(clientId, message, (reply) => sendRaw(clientId, packMessage(sess.channel, reply)));
    } else if (tag === 'P') {
      // One-time pairing: the phone proves it scanned the QR. Body is JSON;
      // the pairing proof itself is verified by the caller's onPairing.
      if (!onPairing) return;
      let registration;
      try { registration = JSON.parse(body); } catch { return; }
      onPairing(clientId, registration, (reply) => sendRaw(clientId, 'P' + JSON.stringify(reply)));
    }
  }

  connect();

  return {
    ready,
    /** True while a live relay session is established. */
    isConnected: () => connected,
    /** Push an unsolicited encrypted message to a connected phone. */
    sendTo(clientId, message) {
      const sess = sessions.get(clientId);
      if (sess && sess.channel) sendRaw(clientId, packMessage(sess.channel, message));
    },
    /**
     * Push an unsolicited encrypted message to every connected paired
     * phone whose handshake has completed. Used by the Mac to notify
     * phones that their data is stale (the Mac just wrote something) so
     * they can pull fresh state instead of waiting for the next launch.
     * Returns the number of peers the message reached.
     */
    broadcastToPeers(message) {
      let n = 0;
      for (const [clientId, sess] of sessions) {
        if (sess && sess.channel) {
          sendRaw(clientId, packMessage(sess.channel, message));
          n++;
        }
      }
      return n;
    },
    close() {
      closed = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
      if (ws) { try { ws.close(); } catch { /* already closing */ } }
    },
  };
}

/**
 * Phone side. Connects as `client` for `routingId`, runs the handshake with
 * the Mac (whose static key it learned at pairing), then exchanges encrypted
 * messages. `ready` resolves once the channel is established.
 */
export function createClientEndpoint({ relayUrl, routingId, identity, hostStaticPub, onMessage, onClose }) {
  const ws = new WebSocket(relaySocketUrl(relayUrl, routingId));
  let handshake = null;
  let channel = null;
  let closeFired = false; // guard so onClose runs at most once

  let resolveReady, rejectReady;
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });

  function fireClose() {
    if (closeFired) return;
    closeFired = true;
    rejectReady(new Error('client: relay connection closed'));
    if (typeof onClose === 'function') { try { onClose(); } catch {} }
  }

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ t: 'hello', routingId, role: 'client' }));
  });
  ws.addEventListener('error', () => rejectReady(new Error('client: relay connection failed')));
  // Both a local close() and a relay-side drop land here. The mobile sync
  // uses onClose to drive reconnect, and we want it to fire either way.
  ws.addEventListener('close', fireClose);
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'welcome') {
      // Begin the handshake: send our static + ephemeral public keys.
      handshake = startHandshake(identity, hostStaticPub, 'initiator');
      ws.send(JSON.stringify({
        t: 'data',
        payload: 'H' + bytesToHex(identity.publicKey) + bytesToHex(handshake.ephemeralPublicKey),
      }));
      return;
    }
    if (m.t === 'data' && typeof m.payload === 'string' && m.payload.length >= 1) {
      const tag = m.payload[0];
      const body = m.payload.slice(1);
      if (tag === 'H' && handshake && !channel) {
        channel = handshake.complete(body); // the Mac's ephemeral public key
        resolveReady();
      } else if (tag === 'E' && channel) {
        try { onMessage(unpackMessage(channel, body)); }
        catch { /* tampered / replayed — dropped */ }
      }
    }
  });

  return {
    ready,
    send(message) {
      if (!channel) throw new Error('client: channel not established yet');
      ws.send(JSON.stringify({ t: 'data', payload: packMessage(channel, message) }));
    },
    close: () => { try { ws.close(); } catch {} },
  };
}

/**
 * Phone side, one-time pairing. After the QR scan, sends the pairing
 * registration to the Mac over the relay and resolves with the Mac's reply
 * (`{ ok, ... }`). Short-lived — the connection closes itself when done.
 */
export function createPairingClient({ relayUrl, routingId, registration }) {
  const ws = new WebSocket(relaySocketUrl(relayUrl, routingId));
  let resolveResult, rejectResult;
  const result = new Promise((res, rej) => { resolveResult = res; rejectResult = rej; });

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ t: 'hello', routingId, role: 'client' }));
  });
  ws.addEventListener('error', () => rejectResult(new Error('pairing: relay connection failed')));
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'welcome') {
      ws.send(JSON.stringify({ t: 'data', payload: 'P' + JSON.stringify(registration) }));
      return;
    }
    if (m.t === 'data' && typeof m.payload === 'string' && m.payload[0] === 'P') {
      try { resolveResult(JSON.parse(m.payload.slice(1))); }
      catch { rejectResult(new Error('pairing: malformed reply')); }
      ws.close();
    }
  });

  return { result, close: () => ws.close() };
}
