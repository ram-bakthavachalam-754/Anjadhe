/**
 * Smoke test for the Anjadhe relay.
 *
 * Starts a relay on a test port, connects a fake "host" (the Mac) and a fake
 * "client" (the phone), and checks that opaque frames are forwarded verbatim
 * in both directions. Uses Node's built-in WebSocket client.
 *
 * Run:  npm test   (from the relay/ directory)
 */
import { startRelay } from './server.js';

const PORT = 8799;
const ROUTING = 'test-routing-' + Date.now();

function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const queue = [];
  const waiters = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    const w = waiters.shift();
    if (w) w(msg); else queue.push(msg);
  });
  ws.opened = new Promise((resolve) => ws.addEventListener('open', () => resolve()));
  ws.sendJSON = (obj) => ws.send(JSON.stringify(obj));
  ws.next = () => new Promise((resolve, reject) => {
    const queued = queue.shift();
    if (queued) return resolve(queued);
    const timer = setTimeout(() => reject(new Error('timed out waiting for message')), 3000);
    waiters.push((m) => { clearTimeout(timer); resolve(m); });
  });
  return ws;
}

let failed = false;
function check(label, ok) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failed = true;
}

const relay = startRelay(PORT);
await relay.ready;

try {
  // --- host (the Mac) connects ------------------------------------------
  const host = connect();
  await host.opened;
  host.sendJSON({ t: 'hello', routingId: ROUTING, role: 'host' });
  check('host receives welcome', (await host.next()).t === 'welcome');

  // --- client (the phone) connects --------------------------------------
  const client = connect();
  await client.opened;
  client.sendJSON({ t: 'hello', routingId: ROUTING, role: 'client' });
  const welcome = await client.next();
  check('client receives welcome with clientId',
    welcome.t === 'welcome' && typeof welcome.clientId === 'string');
  const clientId = welcome.clientId;
  check('client told host is online', (await client.next()).online === true);

  // --- host learns of the new phone -------------------------------------
  const join = await host.next();
  check('host receives peer-join for that clientId',
    join.t === 'peer-join' && join.clientId === clientId);

  // --- phone -> Mac frame forwarded verbatim ----------------------------
  client.sendJSON({ t: 'data', payload: 'CIPHERTEXT-FROM-PHONE' });
  const toHost = await host.next();
  check('Mac receives the phone frame unchanged',
    toHost.t === 'data' && toHost.from === clientId
    && toHost.payload === 'CIPHERTEXT-FROM-PHONE');

  // --- Mac -> phone frame forwarded verbatim ----------------------------
  host.sendJSON({ t: 'data', to: clientId, payload: 'CIPHERTEXT-FROM-MAC' });
  const toClient = await client.next();
  check('phone receives the Mac frame unchanged',
    toClient.t === 'data' && toClient.payload === 'CIPHERTEXT-FROM-MAC');

  // --- phone disconnect notifies the host -------------------------------
  client.close();
  const leave = await host.next();
  check('host receives peer-leave when phone disconnects',
    leave.t === 'peer-leave' && leave.clientId === clientId);

  host.close();
} catch (err) {
  console.error('  FAIL exception:', err.message);
  failed = true;
}

relay.close();
console.log(failed ? '\nSMOKE TEST FAILED\n' : '\nSMOKE TEST PASSED\n');
process.exit(failed ? 1 : 0);
