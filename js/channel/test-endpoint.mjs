/**
 * End-to-end test for the Anjadhe channel.
 *
 * Starts a real relay, a host endpoint (the Mac) and a client endpoint (the
 * phone), and verifies that encrypted app messages round-trip through the
 * relay — and that an unpaired phone cannot establish a channel.
 *
 * Run:  node js/channel/test-endpoint.mjs
 */
import { startRelay } from '../../relay/server.js';
import { generateIdentity } from './secure-channel.mjs';
import { createHostEndpoint, createClientEndpoint } from './channel-endpoint.mjs';
import { bytesToHex } from '@noble/hashes/utils.js';

const PORT = 8811;
const RELAY = `ws://127.0.0.1:${PORT}`;
const ROUTING = 'endpoint-test-routing';

let failed = 0;
function check(label, ok) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failed++;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const relay = startRelay(PORT);
await relay.ready;

// Identities. In the real app these come from pairing; here the Mac simply
// treats `phone` as its one paired peer.
const mac = generateIdentity();
const phone = generateIdentity();
const phonePubHex = bytesToHex(phone.publicKey);

const hostInbox = [];
let macPeerId = null;
const host = createHostEndpoint({
  relayUrl: RELAY,
  routingId: ROUTING,
  identity: mac,
  isPairedPeer: (hex) => hex === phonePubHex,
  onRequest: (peerId, msg, respond) => {
    macPeerId = peerId;
    hostInbox.push(msg);
    if (msg.type === 'ping') respond({ type: 'pong', text: msg.text });
  },
});
await host.ready;
check('Mac endpoint registers with the relay', true);

const clientInbox = [];
const client = createClientEndpoint({
  relayUrl: RELAY,
  routingId: ROUTING,
  identity: phone,
  hostStaticPub: mac.publicKey,
  onMessage: (msg) => clientInbox.push(msg),
});
await client.ready;
check('phone completes the handshake with the Mac', true);

// phone -> Mac request, Mac -> phone reply
client.send({ type: 'ping', text: 'hello from the phone' });
await wait(150);
check('Mac received the phone request decrypted',
  hostInbox.length === 1 && hostInbox[0].text === 'hello from the phone');
check('phone received the encrypted reply',
  clientInbox.length === 1 && clientInbox[0].type === 'pong'
  && clientInbox[0].text === 'hello from the phone');

// many messages — exercises the per-frame counters in both directions
for (let i = 0; i < 5; i++) client.send({ type: 'ping', text: 'n' + i });
await wait(300);
check('5 further round-trips succeed',
  hostInbox.length === 6 && clientInbox.length === 6 && clientInbox[5].text === 'n4');

// unsolicited Mac -> phone push
host.sendTo(macPeerId, { type: 'push', text: 'note from the Mac' });
await wait(150);
check('Mac can push an encrypted message to the phone',
  clientInbox.length === 7 && clientInbox[6].type === 'push'
  && clientInbox[6].text === 'note from the Mac');

// an unpaired phone must not be able to establish a channel
const stranger = generateIdentity();
const strangerClient = createClientEndpoint({
  relayUrl: RELAY, routingId: ROUTING, identity: stranger,
  hostStaticPub: mac.publicKey, onMessage: () => {},
});
const outcome = await Promise.race([
  strangerClient.ready.then(() => 'connected'),
  wait(1500).then(() => 'blocked'),
]);
check('an unpaired phone cannot establish a channel', outcome === 'blocked');

strangerClient.close();
client.close();
host.close();
relay.close();
console.log(failed ? `\n${failed} CHECK(S) FAILED\n` : '\nALL ENDPOINT CHECKS PASSED\n');
process.exit(failed ? 1 : 0);
