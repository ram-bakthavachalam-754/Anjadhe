/**
 * Anjadhe relay — Cloudflare Workers + Durable Objects
 * ====================================================
 * A zero-knowledge rendezvous: it matches a user's Mac ("host") with their
 * paired phones ("client") by an opaque routing ID and forwards frames
 * between them. It never holds an encryption key and never inspects payloads
 * — the Mac<->phone Noise session does the encryption end to end.
 *
 * This is the production deployment of relay/server.js. Behaviour is
 * identical; only the shape differs:
 *   - the Worker routes each WebSocket to a Durable Object by routing ID
 *     (the id is the first path segment of the connect URL);
 *   - each routing ID gets its own RelayRoom Durable Object — one room;
 *   - the room uses the WebSocket Hibernation API, so the many idle Mac
 *     connections cost almost nothing while parked.
 *
 * Protocol (unchanged from relay/server.js — all frames are JSON text):
 *   hello       client -> relay   { t:'hello', routingId, role:'host'|'client' }
 *   welcome     relay  -> host     { t:'welcome' }
 *   welcome     relay  -> client   { t:'welcome', clientId }
 *   peer-join   relay  -> host     { t:'peer-join', clientId }
 *   peer-leave  relay  -> host     { t:'peer-leave', clientId }
 *   host-state  relay  -> client   { t:'host-state', online:boolean }
 *   data        client -> relay    { t:'data', payload }
 *   data        host   -> relay    { t:'data', to:clientId, payload }
 *   data        relay  -> host     { t:'data', from:clientId, payload }
 *   data        relay  -> client   { t:'data', payload }
 *   error       relay  -> peer     { t:'error', message }
 *
 * `payload` is opaque ciphertext — forwarded verbatim. The Cloudflare WebSocket
 * message cap (32 MiB) matches the relay's own frame budget.
 */

const MAX_ROUTING_ID = 128;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Liveness probe — not a WebSocket upgrade.
    if (request.headers.get('Upgrade') !== 'websocket') {
      if (url.pathname === '/healthz') return new Response('ok');
      return new Response('upgrade required', { status: 426 });
    }

    // The routing ID is the first path segment: wss://relay/<routingId>
    const routingId = decodeURIComponent(url.pathname.replace(/^\/+/, '').split('/')[0]);
    if (!routingId || routingId.length > MAX_ROUTING_ID) {
      return new Response('bad routing id', { status: 400 });
    }

    // One Durable Object per routing ID — that object *is* the room.
    const stub = env.RELAY.get(env.RELAY.idFromName(routingId));
    return stub.fetch(request);
  },
};

/**
 * One RelayRoom Durable Object = one routing ID's room. The set of live
 * WebSockets attached to the object *is* the room state, so nothing has to be
 * persisted: getWebSockets() survives hibernation, and each socket's role and
 * clientId ride along in its serialized attachment.
 */
export class RelayRoom {
  constructor(state) {
    this.state = state;
  }

  // A fresh WebSocket: accept it for hibernation, then wait for `hello`.
  async fetch() {
    const { 0: client, 1: server } = new WebSocketPair();
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // --- socket helpers --------------------------------------------------
  meta(ws) {
    try { return ws.deserializeAttachment() || null; } catch { return null; }
  }
  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch { /* socket already gone */ }
  }
  // The current host socket, if any. A "zombie" — a replaced host still
  // awaiting its close event — is deliberately not counted.
  host(exclude) {
    for (const ws of this.state.getWebSockets()) {
      if (ws === exclude) continue;
      const m = this.meta(ws);
      if (m && m.role === 'host') return ws;
    }
    return null;
  }
  client(clientId) {
    for (const ws of this.state.getWebSockets()) {
      const m = this.meta(ws);
      if (m && m.role === 'client' && m.clientId === clientId) return ws;
    }
    return null;
  }
  clients() {
    const out = [];
    for (const ws of this.state.getWebSockets()) {
      const m = this.meta(ws);
      if (m && m.role === 'client') out.push(ws);
    }
    return out;
  }

  // --- hibernation handlers -------------------------------------------
  webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return this.send(ws, { t: 'error', message: 'bad json' });
    }
    const m = this.meta(ws);
    if (!m) return this.handleHello(ws, msg);
    if (msg.t === 'data') return this.forward(ws, m, msg);
    // unknown post-handshake messages are ignored
  }

  webSocketClose(ws) { this.handleGone(ws); }
  webSocketError(ws) { this.handleGone(ws); }

  // --- protocol --------------------------------------------------------
  handleHello(ws, msg) {
    const okRole = msg.role === 'host' || msg.role === 'client';
    const okId = typeof msg.routingId === 'string'
      && msg.routingId.length > 0 && msg.routingId.length <= MAX_ROUTING_ID;
    if (msg.t !== 'hello' || !okRole || !okId) {
      this.send(ws, { t: 'error', message: 'expected valid hello' });
      try { ws.close(1000, 'bad hello'); } catch { /* already closing */ }
      return;
    }

    if (msg.role === 'host') {
      // A reconnecting Mac replaces any stale host. Mark the old socket a
      // "zombie" first so its imminent close does not flap host-state.
      const stale = this.host(ws);
      if (stale) {
        try {
          stale.serializeAttachment({ role: 'zombie' });
          stale.close(1000, 'replaced');
        } catch { /* already closing */ }
      }
      ws.serializeAttachment({ role: 'host' });
      this.send(ws, { t: 'welcome' });
      // Catch the host up on phones already waiting.
      for (const c of this.clients()) {
        const cm = this.meta(c);
        if (cm) this.send(ws, { t: 'peer-join', clientId: cm.clientId });
      }
    } else {
      const clientId = newClientId();
      ws.serializeAttachment({ role: 'client', clientId });
      this.send(ws, { t: 'welcome', clientId });
      const host = this.host();
      this.send(ws, { t: 'host-state', online: !!host });
      if (host) this.send(host, { t: 'peer-join', clientId });
    }
  }

  forward(ws, m, msg) {
    if (typeof msg.payload !== 'string') return; // opaque ciphertext only
    if (m.role === 'client') {
      const host = this.host();
      if (host) this.send(host, { t: 'data', from: m.clientId, payload: msg.payload });
    } else if (m.role === 'host') {
      const target = this.client(msg.to);
      if (target) this.send(target, { t: 'data', payload: msg.payload });
    }
  }

  handleGone(ws) {
    const m = this.meta(ws);
    if (!m) return; // never said hello, or a zombie — nothing to clean up
    if (m.role === 'host') {
      // The live host left. If no other host has taken over, the phones in
      // this room are now host-offline.
      if (!this.host(ws)) {
        for (const c of this.clients()) this.send(c, { t: 'host-state', online: false });
      }
    } else if (m.role === 'client') {
      const host = this.host();
      if (host) this.send(host, { t: 'peer-leave', clientId: m.clientId });
    }
  }
}

// 8 random bytes as hex — same shape as the Node relay's clientId.
function newClientId() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}
