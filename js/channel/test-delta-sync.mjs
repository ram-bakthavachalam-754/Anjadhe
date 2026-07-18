/**
 * Delta-sync protocol test.
 *
 * Drives the two-stage sync (sync-manifest → sync-plan → sync-values →
 * sync-values-ack) against a mock Mac dispatcher that mirrors what
 * `main.js` does, and verifies:
 *   - the phone uploads only timestamps in stage 1 (not values)
 *   - the Mac sends down only keys it is newer on
 *   - the Mac asks for only keys the phone is newer on
 *   - the phone uploads only the keys the Mac asked for
 *   - keys both sides agree on never travel
 *
 * Run:  node js/channel/test-delta-sync.mjs
 */
import { startRelay } from '../../relay/server.js';
import { generateIdentity, acceptPairingOffer } from './secure-channel.mjs';
import { createClientEndpoint, createPairingClient } from './channel-endpoint.mjs';
import { createDesktopChannel } from './desktop-channel.mjs';

const PORT = 8855;
const RELAY = `ws://127.0.0.1:${PORT}`;

let failed = 0;
function check(label, ok, details) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${details ? ' — ' + details : ''}`);
  if (!ok) failed++;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ISO = (s) => new Date(s).toISOString();
const SYNC_EXCLUDE_KEYS = new Set(['llm-logs']);

// ---- mock Mac --------------------------------------------------------
// `macSet` is the canonical Mac-side dataset: key → {value, modifiedAt}.
// In real life this comes from the iCloud sync journal; here it's a Map
// so the test stays self-contained.
const macSet = new Map();
function setMac(key, value, at) { macSet.set(key, { value, modifiedAt: ISO(at) }); }

// The dispatcher mirrors handleSyncManifest / handleSyncValues from main.js.
function dispatch(msg) {
  if (msg.type === 'ping') return { type: 'pong' };
  if (msg.type === 'sync-manifest') {
    const phoneManifest = msg.manifest || {};
    const send = {};
    const want = [];
    const seen = new Set();
    for (const [key, mine] of macSet) {
      if (SYNC_EXCLUDE_KEYS.has(key)) continue;
      seen.add(key);
      const theirs = phoneManifest[key];
      if (!theirs) send[key] = mine;
      else if (new Date(mine.modifiedAt) > new Date(theirs)) send[key] = mine;
      else if (new Date(theirs) > new Date(mine.modifiedAt)) want.push(key);
    }
    for (const key of Object.keys(phoneManifest)) {
      if (SYNC_EXCLUDE_KEYS.has(key) || seen.has(key)) continue;
      want.push(key);
    }
    return { type: 'sync-plan', send, want };
  }
  if (msg.type === 'sync-values') {
    let applied = 0;
    for (const [key, incoming] of Object.entries(msg.values || {})) {
      if (SYNC_EXCLUDE_KEYS.has(key)) continue;
      const mine = macSet.get(key);
      if (mine && new Date(mine.modifiedAt) >= new Date(incoming.modifiedAt)) continue;
      if (incoming.deleted) macSet.set(key, { deleted: true, modifiedAt: incoming.modifiedAt });
      else macSet.set(key, { value: incoming.value, modifiedAt: incoming.modifiedAt });
      applied++;
    }
    return { type: 'sync-values-ack', applied };
  }
  return { ok: false, error: 'unsupported: ' + msg.type };
}

// Seed: the Mac has three keys at known times.
setMac('app_notes', { notes: ['n-mac'] }, '2026-06-01T10:00:00Z');
setMac('app_schedule', { items: ['t-mac'] }, '2026-06-01T10:00:00Z');
setMac('app_journal', { entries: ['j-mac'] }, '2026-06-01T10:00:00Z');

const relay = startRelay(PORT);
await relay.ready;

const storage = (() => {
  const m = new Map();
  return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, v); } };
})();
const desktop = createDesktopChannel({ storage, relayUrl: RELAY, onRequest: dispatch });
await desktop.start();

const phone = generateIdentity();
const offer = desktop.beginPairing();
const { registration, pairing } = acceptPairingOffer(offer, phone);
await createPairingClient({ relayUrl: RELAY, routingId: pairing.routingId, registration }).result;

// ---- the phone ------------------------------------------------------
const phoneSet = new Map(); // {key → {value, modifiedAt}}
const wireUp = []; // every payload the phone *sends* (for size assertions)
const wireDown = []; // every payload the phone *receives*

function exportManifest() {
  const out = {};
  for (const [key, entry] of phoneSet) out[key] = entry.modifiedAt;
  return out;
}
function exportValues(keys) {
  const out = {};
  for (const k of keys) if (phoneSet.has(k)) out[k] = phoneSet.get(k);
  return out;
}

// The phone starts with one key that's newer than the Mac (a task it
// created offline) and one key in sync with the Mac.
phoneSet.set('app_journal', { value: { entries: ['j-mac'] }, modifiedAt: ISO('2026-06-01T10:00:00Z') });
phoneSet.set('app_schedule', { value: { items: ['t-mac', 't-phone'] }, modifiedAt: ISO('2026-06-01T12:00:00Z') });
// app_notes intentionally missing → the Mac should push it down.

const session = createClientEndpoint({
  relayUrl: RELAY, routingId: pairing.routingId, identity: phone,
  hostStaticPub: pairing.hostPub,
  onMessage: (msg) => {
    wireDown.push(msg);
    if (msg.type === 'sync-plan') {
      // Stage-1 reply: apply Mac → phone changes
      for (const [k, v] of Object.entries(msg.send || {})) {
        phoneSet.set(k, { value: v.value, modifiedAt: v.modifiedAt });
      }
      // Stage 2: upload values for what the Mac wants
      const payload = { type: 'sync-values', values: exportValues(msg.want || []) };
      wireUp.push(payload);
      session.send(payload);
    }
  },
});
await session.ready;

// Stage 1: send the manifest only — no values.
const manifest = exportManifest();
const stage1 = { type: 'sync-manifest', manifest };
wireUp.push(stage1);
session.send(stage1);
await wait(400); // give the two stages time to round-trip

// ---- assertions ------------------------------------------------------

// 1. Stage-1 payload carries timestamps only, never values.
const sentManifest = wireUp[0];
check('stage 1 payload is a manifest', sentManifest.type === 'sync-manifest');
const stage1Json = JSON.stringify(sentManifest);
check('stage 1 has no embedded values',
  !stage1Json.includes('t-phone') && !stage1Json.includes('t-mac'),
  `bytes=${stage1Json.length}`);

// 2. The Mac's sync-plan sends down ONLY app_notes (phone is missing it)
//    and asks for app_schedule (phone is newer). It does NOT touch
//    app_journal (timestamps match).
const plan = wireDown.find((m) => m.type === 'sync-plan');
check('Mac replied with a sync-plan', !!plan);
check('plan.send contains app_notes', plan.send && 'app_notes' in plan.send);
check('plan.send does NOT contain app_schedule', !(plan.send && 'app_schedule' in plan.send));
check('plan.send does NOT contain app_journal (in sync)',
  !(plan.send && 'app_journal' in plan.send));
check('plan.want contains app_schedule', plan.want.includes('app_schedule'));
check('plan.want does NOT contain app_journal (in sync)',
  !plan.want.includes('app_journal'));

// 3. Stage 2 carries values for app_schedule only — not for any in-sync key.
const stage2 = wireUp.find((m) => m.type === 'sync-values');
check('phone uploaded stage 2 values', !!stage2);
check('stage 2 includes app_schedule',
  stage2 && stage2.values && 'app_schedule' in stage2.values);
check('stage 2 does NOT include app_journal',
  !(stage2 && stage2.values && 'app_journal' in stage2.values));

// 4. The Mac's view of app_schedule is now the phone's newer value.
const macAfter = macSet.get('app_schedule');
check('Mac applied the phone\'s newer app_schedule',
  macAfter && macAfter.value.items.includes('t-phone'));

// 5. The phone's view of app_notes is now the Mac's value.
const phoneNotes = phoneSet.get('app_notes');
check('phone applied the Mac\'s app_notes', phoneNotes && phoneNotes.value.notes[0] === 'n-mac');

// 6. Wire size proof: stage-1 payload (manifest only) is much smaller
//    than the equivalent full-set sync would have been. We approximate
//    the full-set size by serializing every value the phone holds.
const fullSetSize = JSON.stringify({
  type: 'sync',
  changes: Object.fromEntries(phoneSet),
}).length;
check('stage-1 manifest is much smaller than a full-set sync',
  stage1Json.length < fullSetSize / 2,
  `manifest=${stage1Json.length}B  full-set=${fullSetSize}B`);

// ---- tombstones: phone deletes a key → Mac applies the delete --------
// The phone deletes app_journal (with a fresh tombstone timestamp). Next
// sync: manifest still includes the key (so the Mac can compare); stage 2
// uploads a `{deleted: true, modifiedAt}` entry; the Mac stores a
// tombstone of its own.
const tombAt = ISO('2026-06-01T15:00:00Z');
phoneSet.set('app_journal', { deleted: true, modifiedAt: tombAt });
function tombManifest() {
  const out = {};
  for (const [k, e] of phoneSet) out[k] = e.modifiedAt;
  return out;
}
function tombValues(keys) {
  const out = {};
  for (const k of keys) {
    const e = phoneSet.get(k);
    if (!e) continue;
    out[k] = e.deleted
      ? { deleted: true, modifiedAt: e.modifiedAt }
      : { value: e.value, modifiedAt: e.modifiedAt };
  }
  return out;
}

// Second sync round (re-uses the open session — exactly like push would).
const wireUp2 = [];
const wireDown2 = [];
session.close();
const session2 = createClientEndpoint({
  relayUrl: RELAY, routingId: pairing.routingId, identity: phone,
  hostStaticPub: pairing.hostPub,
  onMessage: (m) => {
    wireDown2.push(m);
    if (m.type === 'sync-plan') {
      // Apply Mac → phone (including any tombstones).
      for (const [k, v] of Object.entries(m.send || {})) {
        if (v.deleted) phoneSet.set(k, { deleted: true, modifiedAt: v.modifiedAt });
        else phoneSet.set(k, { value: v.value, modifiedAt: v.modifiedAt });
      }
      const payload = { type: 'sync-values', values: tombValues(m.want || []) };
      wireUp2.push(payload);
      session2.send(payload);
    }
  },
});
await session2.ready;
const stage1B = { type: 'sync-manifest', manifest: tombManifest() };
wireUp2.push(stage1B);
session2.send(stage1B);
await wait(400);

const planB = wireDown2.find((m) => m.type === 'sync-plan');
check('round 2: Mac asks for app_journal (phone has newer tombstone)',
  planB && planB.want.includes('app_journal'));
const valsB = wireUp2.find((m) => m.type === 'sync-values');
check('round 2: phone uploads a tombstone, not a value',
  valsB && valsB.values && valsB.values.app_journal
  && valsB.values.app_journal.deleted === true
  && !('value' in valsB.values.app_journal));
const macJournalAfter = macSet.get('app_journal');
check('round 2: Mac stored a tombstone for app_journal',
  macJournalAfter && macJournalAfter.deleted === true);

// ---- tombstones: Mac deletes a key → phone applies the delete --------
// The Mac tombstones app_notes (newer timestamp than what the phone has).
// Next manifest exchange: Mac sends down the tombstone in plan.send and
// the phone calls applyRemoteDelete (simulated here via phoneSet writes).
macSet.set('app_notes', { deleted: true, modifiedAt: ISO('2026-06-01T16:00:00Z') });

const wireUp3 = [];
const wireDown3 = [];
session2.close();
const session3 = createClientEndpoint({
  relayUrl: RELAY, routingId: pairing.routingId, identity: phone,
  hostStaticPub: pairing.hostPub,
  onMessage: (m) => {
    wireDown3.push(m);
    if (m.type === 'sync-plan') {
      for (const [k, v] of Object.entries(m.send || {})) {
        if (v.deleted) phoneSet.set(k, { deleted: true, modifiedAt: v.modifiedAt });
        else phoneSet.set(k, { value: v.value, modifiedAt: v.modifiedAt });
      }
      const payload = { type: 'sync-values', values: tombValues(m.want || []) };
      wireUp3.push(payload);
      session3.send(payload);
    }
  },
});
await session3.ready;
session3.send({ type: 'sync-manifest', manifest: tombManifest() });
await wait(400);

const planC = wireDown3.find((m) => m.type === 'sync-plan');
check('round 3: Mac\'s sync-plan carries a tombstone for app_notes',
  planC && planC.send && planC.send.app_notes && planC.send.app_notes.deleted === true);
const phoneNotesAfter = phoneSet.get('app_notes');
check('round 3: phone marked app_notes as deleted',
  phoneNotesAfter && phoneNotesAfter.deleted === true);

session3.close();
desktop.close();
relay.close();
console.log(failed ? `\n${failed} CHECK(S) FAILED\n` : '\nALL DELTA-SYNC CHECKS PASSED\n');
process.exit(failed ? 1 : 0);
