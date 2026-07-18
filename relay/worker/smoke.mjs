/**
 * Smoke test for the Cloudflare Worker relay.
 *
 * Unlike the js/channel/test-*.mjs suites (which start the Node relay), this
 * drives the real channel endpoints against an already-running Worker — so it
 * exercises the actual Durable Object routing and hibernation handlers.
 *
 * Run:  npx wrangler dev      # in this directory — leaves it serving :8787
 *       node smoke.mjs        # in another shell
 *
 * Override the target with RELAY_URL, e.g. RELAY_URL=wss://anjadhe-relay.x.workers.dev
 */
import { generateIdentity } from '../../js/channel/secure-channel.mjs';
import { createHostEndpoint, createClientEndpoint } from '../../js/channel/channel-endpoint.mjs';
import { bytesToHex } from '@noble/hashes/utils.js';

const RELAY = process.env.RELAY_URL || 'ws://127.0.0.1:8787';
const HTTP = RELAY.replace(/^ws/, 'http');
const ROUTING = 'worker-smoke-' + Date.now().toString(36);

let failed = 0;
function check(label, ok) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failed++;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. liveness
try {
  const res = await fetch(HTTP + '/healthz');
  check('GET /healthz returns ok', res.ok && (await res.text()) === 'ok');
} catch {
  check('GET /healthz returns ok', false);
  console.error(`  could not reach the Worker at ${HTTP} — is \`wrangler dev\` running?`);
}

// 2. a paired Mac + phone round-trip an encrypted message through the Worker
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
check('Mac host registers with the Worker', true);

const clientInbox = [];
const client = createClientEndpoint({
  relayUrl: RELAY,
  routingId: ROUTING,
  identity: phone,
  hostStaticPub: mac.publicKey,
  onMessage: (msg) => clientInbox.push(msg),
});
await client.ready;
check('phone completes the handshake through the Worker', true);

client.send({ type: 'ping', text: 'hello' });
await wait(300);
check('encrypted request round-trips',
  hostInbox.length === 1 && clientInbox.length === 1
  && clientInbox[0].type === 'pong' && clientInbox[0].text === 'hello');

host.sendTo(macPeerId, { type: 'push', text: 'from the Mac' });
await wait(300);
check('Mac can push an encrypted message to the phone',
  clientInbox.length === 2 && clientInbox[1].type === 'push');

// 3. an unpaired phone must not be able to establish a channel
const stranger = generateIdentity();
const strangerClient = createClientEndpoint({
  relayUrl: RELAY, routingId: ROUTING, identity: stranger,
  hostStaticPub: mac.publicKey, onMessage: () => {},
});
const outcome = await Promise.race([
  strangerClient.ready.then(() => 'connected', () => 'blocked'),
  wait(1800).then(() => 'blocked'),
]);
check('an unpaired phone cannot establish a channel', outcome === 'blocked');

strangerClient.close();
client.close();
host.close();
console.log(failed ? `\n${failed} WORKER SMOKE CHECK(S) FAILED\n` : '\nALL WORKER SMOKE CHECKS PASSED\n');
process.exit(failed ? 1 : 0);
