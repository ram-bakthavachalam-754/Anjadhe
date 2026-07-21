/**
 * Test for the desktop channel service.
 *
 * Verifies the Mac-side service against a real relay: it persists its
 * identity and routing id, runs the pairing flow, serves decrypted requests
 * to a dispatcher, and remembers paired phones across a restart.
 *
 * Run:  node js/channel/test-desktop-channel.mjs
 */
import { startRelay } from '../../relay/server.js';
import { generateIdentity, acceptPairingOffer } from './secure-channel.mjs';
import { createClientEndpoint, createPairingClient } from './channel-endpoint.mjs';
import { createDesktopChannel } from './desktop-channel.mjs';

const PORT = 8833;
const RELAY = `ws://127.0.0.1:${PORT}`;

let failed = 0;
function check(label, ok) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failed++;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake of the app's synchronous key/value store.
function makeStorage() {
  const m = new Map();
  return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, v); } };
}

const relay = startRelay(PORT);
await relay.ready;

const storage = makeStorage();
const requests = [];
const desktop = createDesktopChannel({
  storage,
  relayUrl: RELAY,
  onRequest: (msg) => { requests.push(msg); return { type: 'pong', text: msg.text }; },
});
await desktop.start();
check('desktop channel connects to the relay', true);

const info = desktop.getPublicInfo();
check('desktop has a routing id and host key',
  info.routingId.length === 32 && info.hostPub.length === 64);
check('identity persisted to storage', !!storage.get('channel.identity'));
check('routing id persisted to storage', storage.get('channel.routingId') === info.routingId);

// --- pairing -----------------------------------------------------------
const phone = generateIdentity();
const offer = desktop.beginPairing();
check('pairing offer reuses the desktop routing id', offer.routingId === info.routingId);
check('desktop reports it is in pairing mode', desktop.isPairing() === true);

const { registration, pairing } = acceptPairingOffer(offer, phone);
const pairResult = await createPairingClient({
  relayUrl: RELAY, routingId: pairing.routingId, registration,
}).result;
check('desktop accepts the phone pairing', pairResult.ok === true);
check('desktop now lists one paired phone', desktop.listPairedDevices().length === 1);
check('pairing mode clears after a successful pair', desktop.isPairing() === false);

// --- a request over the established session ----------------------------
const inbox = [];
const session = createClientEndpoint({
  relayUrl: RELAY, routingId: pairing.routingId, identity: phone,
  hostStaticPub: pairing.hostPub, onMessage: (m) => inbox.push(m),
});
await session.ready;
session.send({ type: 'ping', text: 'hello mac' });
await wait(200);
check('desktop dispatcher received the decrypted request',
  requests.length === 1 && requests[0].text === 'hello mac');
check('phone received the dispatcher reply',
  inbox.length === 1 && inbox[0].type === 'pong' && inbox[0].text === 'hello mac');

// --- push notification (broadcastToPeers) ------------------------------
// The Mac pushes an unsolicited message to every connected paired phone —
// used by main.js after a journal write to nudge phones to pull fresh
// state without polling.
const pushBefore = inbox.length;
const reached = desktop.broadcastToPeers({ type: 'data-changed', keys: ['app_schedule'] });
check('broadcastToPeers reports one recipient', reached === 1);
await wait(200);
check('phone received the pushed data-changed',
  inbox.length === pushBefore + 1
  && inbox[inbox.length - 1].type === 'data-changed'
  && Array.isArray(inbox[inbox.length - 1].keys)
  && inbox[inbox.length - 1].keys[0] === 'app_schedule');

// --- onClose fires when the relay socket drops ------------------------
// The mobile sync uses this to drive reconnect. Closing the session from
// the phone side should trip onClose on a NEW client we open with the
// onClose hook wired.
let closeFired = false;
const session2 = createClientEndpoint({
  relayUrl: RELAY, routingId: pairing.routingId, identity: phone,
  hostStaticPub: pairing.hostPub, onMessage: () => {},
  onClose: () => { closeFired = true; },
});
await session2.ready;
session2.close();
await wait(200);
check('client endpoint onClose fires on close()', closeFired === true);

session.close();
desktop.close();

// --- persistence across a restart --------------------------------------
const desktop2 = createDesktopChannel({ storage, relayUrl: RELAY, onRequest: () => ({}) });
const info2 = desktop2.getPublicInfo();
check('identity is stable across a restart', info2.hostPub === info.hostPub);
check('routing id is stable across a restart', info2.routingId === info.routingId);
check('paired phone is remembered across a restart', desktop2.listPairedDevices().length === 1);

relay.close();
console.log(failed ? `\n${failed} CHECK(S) FAILED\n` : '\nALL DESKTOP-CHANNEL CHECKS PASSED\n');
process.exit(failed ? 1 : 0);
