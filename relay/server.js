/**
 * Anjadhe relay — zero-knowledge rendezvous
 * =========================================
 * Matches a user's Mac ("host") with their paired phones ("client") by an
 * opaque routing ID, then forwards frames between them.
 *
 * The relay:
 *   - never holds any encryption key;
 *   - never inspects frame payloads — they are end-to-end encrypted with a
 *     Noise session established directly between the Mac and the phone;
 *   - only reads the small routing envelope (frame type + destination id).
 *
 * Confidentiality of the *content* is the endpoints' job (Noise). The relay's
 * only jobs are reachability — the Mac dials out, so no inbound port is needed
 * on the user's home network — and routing.
 *
 * Protocol (all control + data messages are JSON text):
 *
 *   hello       client -> relay   { t:'hello', routingId, role:'host'|'client' }
 *   welcome     relay  -> host    { t:'welcome' }
 *   welcome     relay  -> client  { t:'welcome', clientId }
 *   peer-join   relay  -> host    { t:'peer-join', clientId }
 *   peer-leave  relay  -> host    { t:'peer-leave', clientId }
 *   host-state  relay  -> client  { t:'host-state', online:boolean }
 *   data        client -> relay   { t:'data', payload }
 *   data        host   -> relay   { t:'data', to:clientId, payload }
 *   data        relay  -> host    { t:'data', from:clientId, payload }
 *   data        relay  -> client  { t:'data', payload }
 *   error       relay  -> peer    { t:'error', message }
 *
 * `payload` is opaque ciphertext (base64/hex string) — forwarded verbatim.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const DEFAULT_PORT = Number(process.env.PORT) || 8787;
const MAX_FRAME_BYTES = 32 * 1024 * 1024; // 32 MiB — a full data-sync payload can be large
const MAX_ROUTING_ID = 128;

export function startRelay(port = DEFAULT_PORT) {
  // routingId -> { host: ws|null, clients: Map<clientId, ws> }
  const rooms = new Map();

  function getRoom(id) {
    let r = rooms.get(id);
    if (!r) { r = { host: null, clients: new Map() }; rooms.set(id, r); }
    return r;
  }
  function pruneRoom(id) {
    const r = rooms.get(id);
    if (r && !r.host && r.clients.size === 0) rooms.delete(id);
  }
  function send(ws, obj) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
    res.writeHead(426); res.end('upgrade required');
  });

  const wss = new WebSocketServer({ server, maxPayload: MAX_FRAME_BYTES });

  wss.on('connection', (ws) => {
    ws.meta = null; // set once the hello handshake succeeds

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch { return send(ws, { t: 'error', message: 'bad json' }); }

      if (!ws.meta) return handleHello(ws, msg);
      if (msg.t === 'data') return forward(ws, msg);
      // unknown post-handshake messages are ignored
    });

    ws.on('close', () => unregister(ws));
    ws.on('error', () => { try { ws.close(); } catch {} });
  });

  function handleHello(ws, msg) {
    const okRole = msg.role === 'host' || msg.role === 'client';
    const okId = typeof msg.routingId === 'string'
      && msg.routingId.length > 0 && msg.routingId.length <= MAX_ROUTING_ID;
    if (msg.t !== 'hello' || !okRole || !okId) {
      send(ws, { t: 'error', message: 'expected valid hello' });
      return ws.close();
    }
    const room = getRoom(msg.routingId);
    if (msg.role === 'host') {
      // A reconnecting Mac replaces any stale host connection.
      if (room.host && room.host !== ws) { try { room.host.close(); } catch {} }
      room.host = ws;
      ws.meta = { routingId: msg.routingId, role: 'host' };
      send(ws, { t: 'welcome' });
      // Catch the host up on phones already waiting.
      for (const clientId of room.clients.keys()) send(ws, { t: 'peer-join', clientId });
    } else {
      const clientId = crypto.randomBytes(8).toString('hex');
      room.clients.set(clientId, ws);
      ws.meta = { routingId: msg.routingId, role: 'client', clientId };
      send(ws, { t: 'welcome', clientId });
      send(ws, { t: 'host-state', online: !!room.host });
      send(room.host, { t: 'peer-join', clientId });
    }
  }

  function unregister(ws) {
    if (!ws.meta) return;
    const { routingId, role, clientId } = ws.meta;
    const room = rooms.get(routingId);
    if (!room) return;
    if (role === 'host') {
      if (room.host === ws) {
        room.host = null;
        for (const c of room.clients.values()) send(c, { t: 'host-state', online: false });
      }
    } else {
      room.clients.delete(clientId);
      send(room.host, { t: 'peer-leave', clientId });
    }
    pruneRoom(routingId);
  }

  function forward(ws, msg) {
    if (typeof msg.payload !== 'string') return; // opaque ciphertext only
    const { routingId, role, clientId } = ws.meta;
    const room = rooms.get(routingId);
    if (!room) return;
    if (role === 'client') {
      send(room.host, { t: 'data', from: clientId, payload: msg.payload });
    } else {
      send(room.clients.get(msg.to), { t: 'data', payload: msg.payload });
    }
  }

  const ready = new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`anjadhe-relay listening on :${server.address().port}`);
      resolve(server.address().port);
    });
  });

  function close() {
    for (const ws of wss.clients) { try { ws.terminate(); } catch {} }
    wss.close();
    server.close();
  }

  return { server, wss, ready, close };
}

// Run directly:  node server.js
const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) startRelay();
