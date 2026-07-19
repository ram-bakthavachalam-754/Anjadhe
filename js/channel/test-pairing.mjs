/**
 * Pairing + session test for the Anjadhe channel.
 *
 * Verifies the one-time QR-pairing flow over the relay: an unpaired phone is
 * refused a session, the pairing exchange registers the phone with the Mac,
 * and a session then succeeds — all against a real relay.
 *
 * Run:  node js/channel/test-pairing.mjs
 */
import { startRelay } from '../../relay/server.js';
import {
  generateIdentity, createPairingOffer, acceptPairingOffer, verifyPairingRegistration,
} from './secure-channel.mjs';
import { createHostEndpoint, createClientEndpoint, createPairingClient } from './channel-endpoint.mjs';
import { bytesToHex } from '@noble/hashes/utils.js';

const PORT = 8822;
const RELAY = `ws://127.0.0.1:${PORT}`;
const ROUTING = 'pairing-test-' + Date.now();

let failed = 0;
function check(label, ok) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failed++;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const relay = startRelay(PORT);
await relay.ready;

// The Mac: one stable identity, one stable routing id.
const mac = generateIdentity();
const pairedPeers = new Set(); // hex static public keys of paired phones
let pairingState = null;       // set while the Mac is showing a pairing QR

const sessionInbox = [];
const host = createHostEndpoint({
  relayUrl: RELAY,
  routingId: ROUTING,
  identity: mac,
  isPairedPeer: (hex) => pairedPeers.has(hex),
  onRequest: (peerId, msg, respond) => {
    if (msg.type === 'ping') respond({ type: 'pong', text: msg.text });
  },
  onPairing: (clientId, registration, reply) => {
    if (!pairingState) return reply({ ok: false, error: 'not in pairing mode' });
    const result = verifyPairingRegistration(pairingState.pending, registration);
    if (result.ok) {
      pairedPeers.add(bytesToHex(result.phonePub));
      pairingState = null; // the pairing secret is one-time
      reply({ ok: true });
    } else {
      reply({ ok: false, error: 'verification failed' });
    }
  },
});
await host.ready;
check('Mac host endpoint registered', true);

const phone = generateIdentity();

// Before pairing, the phone must not be able to open a session.
const preSession = createClientEndpoint({
  relayUrl: RELAY, routingId: ROUTING, identity: phone,
  hostStaticPub: mac.publicKey, onMessage: () => {},
});
const preOutcome = await Promise.race([
  preSession.ready.then(() => 'connected'),
  wait(1200).then(() => 'blocked'),
]);
check('an unpaired phone cannot open a session', preOutcome === 'blocked');
preSession.close();

// The Mac enters pairing mode and produces a QR offer.
pairingState = createPairingOffer(mac, { relayUrl: RELAY, routingId: ROUTING });
check('the QR offer reuses the Mac stable routing id', pairingState.offer.routingId === ROUTING);

// The phone "scans" the QR and runs the pairing exchange over the relay.
const { registration, pairing } = acceptPairingOffer(pairingState.offer, phone);
const pairResult = await createPairingClient({
  relayUrl: RELAY, routingId: pairing.routingId, registration,
}).result;
check('the Mac accepts the phone pairing', pairResult.ok === true);
check('the Mac recorded the phone as a paired peer', pairedPeers.has(bytesToHex(phone.publicKey)));

// Now a session must succeed.
const session = createClientEndpoint({
  relayUrl: RELAY, routingId: pairing.routingId, identity: phone,
  hostStaticPub: pairing.hostPub, onMessage: (m) => sessionInbox.push(m),
});
await session.ready;
check('the paired phone now opens a session', true);
session.send({ type: 'ping', text: 'paired and talking' });
await wait(200);
check('an encrypted request round-trips after pairing',
  sessionInbox.length === 1 && sessionInbox[0].text === 'paired and talking');

session.close();
host.close();
relay.close();
console.log(failed ? `\n${failed} CHECK(S) FAILED\n` : '\nALL PAIRING CHECKS PASSED\n');
process.exit(failed ? 1 : 0);
