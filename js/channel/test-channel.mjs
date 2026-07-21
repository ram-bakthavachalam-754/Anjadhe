/**
 * Tests for the Anjadhe secure channel.
 *
 * Exercises the full path — pairing, session handshake, encrypted frames —
 * and the failure paths that matter for the privacy guarantee: a forged
 * registration, a tampered frame, a replayed frame, and an impostor who did
 * not pair are all rejected.
 *
 * Run:  node js/channel/test-channel.mjs
 */
import {
  generateIdentity, createPairingOffer, acceptPairingOffer,
  verifyPairingRegistration, startHandshake,
} from './secure-channel.mjs';

let failed = 0;
function check(label, ok) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failed++;
}
function throws(label, fn) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  check(label, threw);
}
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b));

// Long-term identities: the Mac and the phone.
const mac = generateIdentity();
const phone = generateIdentity();

// --- pairing ---------------------------------------------------------------
console.log('\n[pairing]');
const { offer, pending } = createPairingOffer(mac, { relayUrl: 'wss://relay.example' });
check('offer carries relay url, 128-bit routing id, and host key',
  offer.relayUrl === 'wss://relay.example'
  && offer.routingId.length === 32 && offer.hostPub.length === 64);

const { registration, pairing } = acceptPairingOffer(offer, phone);
check('phone stores the authentic host key from the QR', pairing.hostPub === offer.hostPub);
check('phone keeps the relay url and routing id', pairing.routingId === offer.routingId);

const verified = verifyPairingRegistration(pending, registration);
check('Mac accepts a genuine registration', verified.ok === true);
check('Mac recovers the phone public key', verified.phonePub && eq(verified.phonePub, phone.publicKey));

// An attacker who never saw the QR cannot forge a registration: without the
// one-time pairing secret they cannot produce a matching pairConfirm.
const attacker = generateIdentity();
const forged = {
  phonePub: Buffer.from(attacker.publicKey).toString('hex'),
  pairConfirm: registration.pairConfirm,
};
check('Mac rejects a registration not backed by the QR secret',
  verifyPairingRegistration(pending, forged).ok === false);

// --- session handshake -----------------------------------------------------
console.log('\n[session handshake]');
// Phone is the initiator, Mac the responder; each knows the peer's static key.
function freshPair() {
  const init = startHandshake(phone, pairing.hostPub, 'initiator'); // hostPub is hex
  const resp = startHandshake(mac, phone.publicKey, 'responder');   // publicKey is bytes
  return {
    phone: init.complete(resp.ephemeralPublicKey),
    mac: resp.complete(init.ephemeralPublicKey),
  };
}

const link = freshPair();
let frame = link.phone.seal(enc('run the agent on this note'));
check('Mac decrypts the phone frame', dec(link.mac.open(frame)) === 'run the agent on this note');
frame = link.mac.seal(enc('here is the answer'));
check('phone decrypts the Mac frame', dec(link.phone.open(frame)) === 'here is the answer');

let streamOk = true;
for (let i = 0; i < 5; i++) {
  if (dec(link.mac.open(link.phone.seal(enc('frame ' + i)))) !== 'frame ' + i) streamOk = false;
}
check('counters advance correctly across many frames', streamOk);

// --- tamper, replay, impostor ----------------------------------------------
console.log('\n[tamper + replay + impostor]');

const tamperLink = freshPair();
const sealed = tamperLink.phone.seal(enc('sensitive data'));
const tampered = Uint8Array.from(sealed);
tampered[tampered.length - 1] ^= 0x01; // flip a bit in the Poly1305 tag
throws('a tampered frame is rejected', () => tamperLink.mac.open(tampered));

const replayLink = freshPair();
const once = replayLink.phone.seal(enc('deliver once'));
check('first delivery succeeds', dec(replayLink.mac.open(once)) === 'deliver once');
throws('the same frame replayed is rejected', () => replayLink.mac.open(once));

// An impostor holding neither the phone's nor the Mac's static key cannot
// derive the session key, so the Mac cannot decrypt anything they send.
const impostor = generateIdentity();
const iInit = startHandshake(impostor, pairing.hostPub, 'initiator');
const mResp = startHandshake(mac, phone.publicKey, 'responder'); // Mac expects the real phone
const impostorChannel = iInit.complete(mResp.ephemeralPublicKey);
const macChannel = mResp.complete(iInit.ephemeralPublicKey);
throws('an unpaired impostor cannot be decrypted by the Mac',
  () => macChannel.open(impostorChannel.seal(enc('let me in'))));

console.log(failed ? `\n${failed} CHECK(S) FAILED\n` : '\nALL CHANNEL CHECKS PASSED\n');
process.exit(failed ? 1 : 0);
