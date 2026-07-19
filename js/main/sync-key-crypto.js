/**
 * sync-key-crypto — passphrase wrapping for the multi-device sync key
 * (SECURITY-AUDIT.md H6). Main process only; pure Node crypto, no Electron,
 * so it unit-tests without launching the app.
 *
 * The 32-byte sync key encrypts the iCloud journal + backups. Storing it as
 * plaintext next to that ciphertext gave the encryption ~zero work factor
 * against anyone who can read iCloud. Here we wrap it under a key derived from
 * the user's passphrase (scrypt), so iCloud holds only the wrapped blob — the
 * passphrase never leaves the device, and the raw key is unrecoverable from
 * iCloud alone.
 *
 * Wrapped format (JSON, stored as `.sync-key.enc` in the sync dir):
 *   { v, kdf:'scrypt', N, r, p, salt, nonce, ct, tag }   (salt/nonce/ct/tag base64)
 * KEK  = scrypt(passphrase, salt, {N,r,p}) -> 32 bytes
 * ct   = AES-256-GCM(rawKey, KEK, nonce); tag = GCM auth tag
 */

const crypto = require('crypto');

// scrypt cost. N=2^16 → ~64MB, ~100ms on a modern Mac — deliberately slow so an
// offline guess against a leaked wrapped blob is expensive, but fine for an
// interactive one-time unlock. maxmem must exceed 128*N*r.
const SCRYPT = { N: 1 << 16, r: 8, p: 1, keyLen: 32, maxmem: 160 * 1024 * 1024 };

function deriveKek(passphrase, salt) {
    const pass = Buffer.from(String(passphrase), 'utf8');
    return crypto.scryptSync(pass, salt, SCRYPT.keyLen, {
        N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem,
    });
}

/**
 * Wrap a raw 32-byte key under a passphrase. Returns the JSON-serializable
 * wrapped object. Throws on a bad key or empty passphrase.
 */
function wrapKey(rawKey, passphrase) {
    if (!Buffer.isBuffer(rawKey) || rawKey.length !== 32) {
        throw new Error('wrapKey: rawKey must be a 32-byte Buffer');
    }
    if (!passphrase || !String(passphrase).length) {
        throw new Error('wrapKey: passphrase required');
    }
    const salt = crypto.randomBytes(16);
    const nonce = crypto.randomBytes(12);
    const kek = deriveKek(passphrase, salt);
    const cipher = crypto.createCipheriv('aes-256-gcm', kek, nonce);
    const ct = Buffer.concat([cipher.update(rawKey), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
        v: 1,
        kdf: 'scrypt',
        N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
        salt: salt.toString('base64'),
        nonce: nonce.toString('base64'),
        ct: ct.toString('base64'),
        tag: tag.toString('base64'),
    };
}

/**
 * Unwrap a wrapped object with a passphrase → the raw 32-byte key Buffer.
 * Throws `WRONG_PASSPHRASE` on GCM auth failure (bad passphrase or tampering),
 * or a format error on a malformed blob.
 */
function unwrapKey(wrapped, passphrase) {
    if (!wrapped || typeof wrapped !== 'object') throw new Error('unwrapKey: malformed wrapped key');
    const N = Number(wrapped.N) || SCRYPT.N;
    const r = Number(wrapped.r) || SCRYPT.r;
    const p = Number(wrapped.p) || SCRYPT.p;
    let salt, nonce, ct, tag;
    try {
        salt = Buffer.from(wrapped.salt, 'base64');
        nonce = Buffer.from(wrapped.nonce, 'base64');
        ct = Buffer.from(wrapped.ct, 'base64');
        tag = Buffer.from(wrapped.tag, 'base64');
    } catch {
        throw new Error('unwrapKey: malformed wrapped key');
    }
    if (!salt.length || nonce.length !== 12 || !ct.length || tag.length !== 16) {
        throw new Error('unwrapKey: malformed wrapped key');
    }
    const pass = Buffer.from(String(passphrase), 'utf8');
    const kek = crypto.scryptSync(pass, salt, SCRYPT.keyLen, { N, r, p, maxmem: SCRYPT.maxmem });
    const decipher = crypto.createDecipheriv('aes-256-gcm', kek, nonce);
    decipher.setAuthTag(tag);
    let raw;
    try {
        raw = Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch {
        const err = new Error('Incorrect passphrase');
        err.code = 'WRONG_PASSPHRASE';
        throw err;
    }
    if (raw.length !== 32) throw new Error('unwrapKey: recovered key has wrong length');
    return raw;
}

module.exports = { wrapKey, unwrapKey, _SCRYPT: SCRYPT };
