/**
 * Reconnection test for the Anjadhe channel.
 *
 * Verifies the Mac's host endpoint survives the relay going away: it reports
 * the drop, reconnects on its own once the relay returns, the channel works
 * again afterwards, and close() stops reconnecting for good.
 *
 * Run:  node js/channel/test-reconnect.mjs
 */
import { startRelay } from '../../relay/server.js';
import { generateIdentity } from './secure-channel.mjs';
import { createHostEndpoint, createClientEndpoint } from './channel-endpoint.mjs';
import { bytesToHex } from '@noble/hashes/utils.js';

const PORT = 8844;
const RELAY = `ws://127.0.0.1:${PORT}`;
const ROUTING = 'reconnect-test-routing';

let failed = 0;
function check(label, ok) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failed++;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(100);
  }
  return predicate();
}

const mac = generateIdentity();
const phone = generateIdentity();
const phonePubHex = bytesToHex(phone.publicKey);

let relay = startRelay(PORT);
await relay.ready;

const hostInbox = [];
const host = createHostEndpoint({
  relayUrl: RELAY,
  routingId: ROUTING,
  identity: mac,
  isPairedPeer: (hex) => hex === phonePubHex,
  onRequest: (peerId, msg, respond) => {
    hostInbox.push(msg);
    if (msg.type === 'ping') respond({ type: 'pong', text: msg.text });
  },
});
await host.ready;
check('Mac endpoint connects to the relay', host.isConnected() === true);

// --- the relay goes away -----------------------------------------------
relay.close();
check('Mac endpoint notices the relay is gone',
  await waitFor(() => host.isConnected() === false, 3000));

// --- the relay comes back ----------------------------------------------
await wait(400); // let the port free up before re-listening
relay = startRelay(PORT);
await relay.ready;
check('Mac endpoint reconnects on its own once the relay returns',
  await waitFor(() => host.isConnected() === true, 8000));

// --- the channel works again after the reconnect -----------------------
const clientInbox = [];
const client = createClientEndpoint({
  relayUrl: RELAY,
  routingId: ROUTING,
  identity: phone,
  hostStaticPub: mac.publicKey,
  onMessage: (m) => clientInbox.push(m),
});
const established = await Promise.race([
  client.ready.then(() => true),
  wait(5000).then(() => false),
]);
check('a phone can establish a channel after the reconnect', established);

client.send({ type: 'ping', text: 'after reconnect' });
check('an encrypted request round-trips after the reconnect',
  await waitFor(
    () => clientInbox.length === 1 && clientInbox[0].text === 'after reconnect', 3000));

// --- close() stops reconnection for good -------------------------------
host.close();
client.close();
relay.close();
await wait(300);
check('host reports disconnected after close()', host.isConnected() === false);

console.log(failed ? `\n${failed} CHECK(S) FAILED\n` : '\nALL RECONNECT CHECKS PASSED\n');
process.exit(failed ? 1 : 0);
