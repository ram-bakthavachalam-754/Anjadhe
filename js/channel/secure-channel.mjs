/**
 * Anjadhe secure channel
 * ======================
 * The cryptographic core of the phone-to-Mac link. This is what makes the
 * relay's "zero-knowledge" property real: the relay forwards opaque frames,
 * and only the two paired endpoints can read them.
 *
 * It runs identically in Node (the Electron main process on the Mac) and in
 * the iOS WebView (the Capacitor app), built entirely on audited primitives
 * from the @noble libraries — no hand-rolled crypto.
 *
 *   - X25519                  key agreement        (@noble/curves)
 *   - ChaCha20-Poly1305        authenticated frames (@noble/ciphers)
 *   - HKDF-SHA256 / HMAC-SHA256 key derivation, pairing proof (@noble/hashes)
 *
 * Two phases:
 *
 *  1. Pairing (one-time, bootstrapped by an in-person QR scan).
 *     The Mac shows a QR carrying its static public key, the relay address,
 *     a fresh routing ID, and a one-time pairing secret. The QR scan is the
 *     out-of-band authenticated channel:
 *       - the phone learns the Mac's *authentic* static key from the QR;
 *       - the phone proves it scanned the QR by returning an HMAC over the
 *         pairing secret (which never travels the network).
 *     After pairing, each side holds the other's authenticated static key.
 *
 *  2. Session (per connection).
 *     Both sides already know the peer's static key, so the handshake only
 *     exchanges fresh ephemeral X25519 keys. The session key mixes four DH
 *     results — ee (forward secrecy) and es/se/ss (mutual authentication) —
 *     the Noise "KK" shape. Frames are ChaCha20-Poly1305 with a per-direction
 *     key and a strictly increasing counter, so replay and reorder are
 *     rejected and a nonce is never reused.
 */
import { x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  randomBytes, bytesToHex, hexToBytes, concatBytes, utf8ToBytes,
} from '@noble/hashes/utils.js';

const PAIR_CONTEXT = utf8ToBytes('anjadhe-pair-v1');
const CHANNEL_INFO = utf8ToBytes('anjadhe-channel-v1');
const KEY_BYTES = 32;
const TAG_BYTES = 16;
const COUNTER_BYTES = 8;

// --- helpers ---------------------------------------------------------------

function asBytes(v) {
  return typeof v === 'string' ? hexToBytes(v) : v;
}

/** Constant-time equality — @noble/hashes v2 utils has no such helper. */
function ctEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function counterToBytes(counter) {
  const out = new Uint8Array(COUNTER_BYTES);
  let c = counter;
  for (let i = COUNTER_BYTES - 1; i >= 0; i--) { out[i] = Number(c & 0xffn); c >>= 8n; }
  return out;
}

function bytesToCounter(bytes) {
  let c = 0n;
  for (let i = 0; i < COUNTER_BYTES; i++) c = (c << 8n) | BigInt(bytes[i]);
  return c;
}

/** 12-byte ChaCha20-Poly1305 nonce: 4 zero bytes || 8-byte big-endian counter. */
function nonceFromCounter(counter) {
  const nonce = new Uint8Array(12);
  nonce.set(counterToBytes(counter), 4);
  return nonce;
}

// --- identity --------------------------------------------------------------

/** A long-term X25519 identity. Generated once per device, stored thereafter. */
export function generateIdentity() {
  const secretKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(secretKey);
  return { secretKey, publicKey };
}

export function identityToHex(identity) {
  return {
    secretKey: bytesToHex(identity.secretKey),
    publicKey: bytesToHex(identity.publicKey),
  };
}

export function identityFromHex(hex) {
  return { secretKey: hexToBytes(hex.secretKey), publicKey: hexToBytes(hex.publicKey) };
}

// --- pairing ---------------------------------------------------------------

/** HMAC the phone uses to prove it scanned the Mac's QR. */
function pairConfirmTag(pairingSecret, hostPub, peerPub) {
  return hmac(sha256, pairingSecret, concatBytes(PAIR_CONTEXT, hostPub, peerPub));
}

/**
 * Mac side. Produces the data to render as a pairing QR, plus a `pending`
 * record the Mac keeps in memory until the phone's registration arrives.
 * The pairing secret is one-time — discard `pending` once paired or expired.
 */
export function createPairingOffer(hostIdentity, { relayUrl, routingId }) {
  if (!relayUrl) throw new Error('pairing: relayUrl is required');
  // A Mac keeps one stable routing id (its relay rendezvous address) and
  // reuses it across every pairing; only the pairing secret is one-time.
  const rid = routingId || bytesToHex(randomBytes(16));
  const pairingSecret = randomBytes(32);
  return {
    offer: {
      v: 1,
      relayUrl,
      routingId: rid,
      hostPub: bytesToHex(hostIdentity.publicKey),
      pairingSecret: bytesToHex(pairingSecret),
    },
    pending: {
      routingId: rid,
      relayUrl,
      hostPub: hostIdentity.publicKey,
      pairingSecret,
    },
  };
}

/**
 * Phone side. Consumes a scanned QR offer. Returns `registration` to send to
 * the Mac (over the relay) and `pairing` for the phone to store permanently.
 */
export function acceptPairingOffer(offer, phoneIdentity) {
  if (!offer || offer.v !== 1) throw new Error('pairing: unsupported offer');
  const hostPub = hexToBytes(offer.hostPub);
  const pairingSecret = hexToBytes(offer.pairingSecret);
  const phonePub = phoneIdentity.publicKey;
  return {
    registration: {
      phonePub: bytesToHex(phonePub),
      pairConfirm: bytesToHex(pairConfirmTag(pairingSecret, hostPub, phonePub)),
    },
    pairing: {
      relayUrl: offer.relayUrl,
      routingId: offer.routingId,
      hostPub: offer.hostPub,
      selfPub: bytesToHex(phonePub),
    },
  };
}

/**
 * Mac side. Verifies the phone's registration against the pending offer.
 * On success the Mac should store `phonePub` as an authenticated paired peer.
 */
export function verifyPairingRegistration(pending, registration) {
  const phonePub = hexToBytes(registration.phonePub);
  const expected = pairConfirmTag(pending.pairingSecret, pending.hostPub, phonePub);
  const ok = ctEqual(expected, hexToBytes(registration.pairConfirm));
  return { ok, phonePub: ok ? phonePub : null };
}

// --- session handshake -----------------------------------------------------

/**
 * Begin a session handshake. `role` is 'initiator' (the phone, by convention)
 * or 'responder' (the Mac). Send `ephemeralPublicKey` to the peer, then call
 * `complete()` with the peer's ephemeral public key to obtain a SecureChannel.
 */
export function startHandshake(selfIdentity, peerStaticPub, role) {
  if (role !== 'initiator' && role !== 'responder') {
    throw new Error("handshake: role must be 'initiator' or 'responder'");
  }
  const peerStatic = asBytes(peerStaticPub);
  const ephSecret = x25519.utils.randomSecretKey();
  const ephPublic = x25519.getPublicKey(ephSecret);

  function complete(peerEphemeralPubInput) {
    const peerEph = asBytes(peerEphemeralPubInput);

    // ee gives forward secrecy; ss/es/se bind both static identities.
    const ee = x25519.getSharedSecret(ephSecret, peerEph);
    const ss = x25519.getSharedSecret(selfIdentity.secretKey, peerStatic);
    let es; // initiator_static · responder_ephemeral
    let se; // initiator_ephemeral · responder_static
    if (role === 'initiator') {
      es = x25519.getSharedSecret(selfIdentity.secretKey, peerEph);
      se = x25519.getSharedSecret(ephSecret, peerStatic);
    } else {
      es = x25519.getSharedSecret(ephSecret, peerStatic);
      se = x25519.getSharedSecret(selfIdentity.secretKey, peerEph);
    }

    // Transcript binds the derived key to both ephemerals and both statics,
    // ordered initiator-first so both sides compute it identically.
    let iEph, rEph, iStatic, rStatic;
    if (role === 'initiator') {
      iEph = ephPublic; rEph = peerEph;
      iStatic = selfIdentity.publicKey; rStatic = peerStatic;
    } else {
      iEph = peerEph; rEph = ephPublic;
      iStatic = peerStatic; rStatic = selfIdentity.publicKey;
    }
    const transcript = sha256(concatBytes(iEph, rEph, iStatic, rStatic));

    const master = hkdf(sha256, concatBytes(ee, es, se, ss), transcript, CHANNEL_INFO, 64);
    const keyI2R = master.slice(0, KEY_BYTES);
    const keyR2I = master.slice(KEY_BYTES, 64);
    const sendKey = role === 'initiator' ? keyI2R : keyR2I;
    const recvKey = role === 'initiator' ? keyR2I : keyI2R;
    return new SecureChannel(sendKey, recvKey);
  }

  return { role, ephemeralPublicKey: ephPublic, complete };
}

/**
 * An established channel. `seal` encrypts an outbound frame; `open` decrypts
 * an inbound one. Frame layout: 8-byte big-endian counter || ciphertext+tag.
 * The relay forwards these verbatim and cannot read them.
 */
export class SecureChannel {
  constructor(sendKey, recvKey) {
    this._sendKey = sendKey;
    this._recvKey = recvKey;
    this._sendCounter = 0n;
    this._recvCounter = 0n;
  }

  seal(plaintext) {
    const counter = this._sendCounter;
    const ciphertext = chacha20poly1305(this._sendKey, nonceFromCounter(counter)).encrypt(plaintext);
    const frame = new Uint8Array(COUNTER_BYTES + ciphertext.length);
    frame.set(counterToBytes(counter), 0);
    frame.set(ciphertext, COUNTER_BYTES);
    this._sendCounter = counter + 1n;
    return frame;
  }

  open(frame) {
    if (frame.length < COUNTER_BYTES + TAG_BYTES) {
      throw new Error('channel: frame too short');
    }
    const counter = bytesToCounter(frame.subarray(0, COUNTER_BYTES));
    // Strictly sequential: the channel rides an ordered, reliable transport,
    // so any gap means a replayed, reordered, or injected frame.
    if (counter !== this._recvCounter) {
      throw new Error('channel: counter mismatch — replay or reorder rejected');
    }
    // .decrypt throws if the Poly1305 tag fails (tampered ciphertext/counter).
    const plaintext = chacha20poly1305(this._recvKey, nonceFromCounter(counter)).decrypt(
      frame.subarray(COUNTER_BYTES),
    );
    this._recvCounter = counter + 1n;
    return plaintext;
  }
}
