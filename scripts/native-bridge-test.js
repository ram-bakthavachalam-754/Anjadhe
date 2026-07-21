#!/usr/bin/env node
/**
 * Tests the native-bridge.js shim's cache/manifest/LWW/bridge logic in Node
 * (no WebView), the verifiable half of the Stage-1 sync bridge. The live
 * channel round-trip needs a paired Mac + relay and is verified on-device.
 *   npm run test:bridge   (or: node scripts/native-bridge-test.js)
 */
'use strict';
const path = require('path');
const { createStore } = require(path.join(__dirname, '..', 'js', 'adapter', 'native-bridge.js'));

const failures = [];
let passed = 0;
function check(name, cond, detail) { cond ? passed++ : failures.push(name + (detail ? ' — ' + detail : '')); }

// A store whose native `post` we capture, with no AnjadheSync (push no-ops).
function make() {
  const posted = [];
  const s = createStore((msg) => posted.push(msg), () => null);
  return { s, posted };
}

// 1. Local writes update the mirror AND forward to native.
{
  const { s, posted } = make();
  s.electronStore.set('schedule', { scheduleItems: [] });
  check('set reflects in get', JSON.stringify(s.electronStore.get('schedule')) === JSON.stringify({ scheduleItems: [] }));
  check('set forwards a persist to native', posted.length === 1 && posted[0].type === 'persist' && posted[0].key === 'schedule');
  check('persist carries value + modifiedAt', !!posted[0].entry.value && !!posted[0].entry.modifiedAt);
  s.electronStore.delete('schedule');
  check('delete tombstones in mirror', s.electronStore.get('schedule') === null);
  check('delete forwards a tombstone to native', posted[1].entry.deleted === true);
}

// 2. applyRemote (from mobile-sync) updates mirror + forwards to native.
{
  const { s, posted } = make();
  s.anjadheStore.applyRemote('notes', { notes: [1] }, '2026-06-18T10:00:00.000Z');
  check('applyRemote reflects in get', JSON.stringify(s.electronStore.get('notes')) === JSON.stringify({ notes: [1] }));
  check('applyRemote keeps the Mac timestamp', s.anjadheStore.localModifiedAt('notes') === '2026-06-18T10:00:00.000Z');
  check('applyRemote forwards to native', posted.length === 1 && posted[0].entry.modifiedAt === '2026-06-18T10:00:00.000Z');
  s.anjadheStore.applyRemoteDelete('notes', '2026-06-18T11:00:00.000Z');
  check('applyRemoteDelete tombstones', s.electronStore.get('notes') === null);
}

// 3. Manifest + exportValues are correct (used by the delta protocol).
{
  const { s } = make();
  s.anjadheStore.applyRemote('a', { x: 1 }, '2026-06-18T10:00:00.000Z');
  s.anjadheStore.applyRemoteDelete('b', '2026-06-18T09:00:00.000Z');
  const m = s.anjadheStore.exportManifest();
  check('manifest has live timestamp', m.a === '2026-06-18T10:00:00.000Z');
  check('manifest has tombstone timestamp', m.b === '2026-06-18T09:00:00.000Z');
  const vals = s.anjadheStore.exportValues(['a', 'b']);
  check('exportValues live', vals.a && vals.a.value.x === 1);
  check('exportValues tombstone', vals.b && vals.b.deleted === true);
  check('localModifiedAt missing → epoch', s.anjadheStore.localModifiedAt('missing') === '1970-01-01T00:00:00.000Z');
}

// 4. hydrate seeds the mirror from a native snapshot (boot).
{
  const { s } = make();
  s.bridge.hydrate({
    schedule: { value: { scheduleItems: [{ id: 's1' }] }, modifiedAt: '2026-06-18T10:00:00.000Z' },
    gone: { deleted: true, modifiedAt: '2026-06-18T09:00:00.000Z' },
  });
  check('hydrate restores live value', s.electronStore.get('schedule').scheduleItems[0].id === 's1');
  check('hydrate restores tombstone', s.electronStore.get('gone') === null);
  check('hydrate restores manifest', s.anjadheStore.exportManifest().gone === '2026-06-18T09:00:00.000Z');
}

// 5. applyLocalWrite (native UI write) updates mirror WITHOUT re-posting to
//    native (loop prevention) but stays exportable for the next sync upload.
{
  const { s, posted } = make();
  s.bridge.applyLocalWrite('notes', { notes: [{ id: 'n1' }] }, '2026-06-18T12:00:00.000Z');
  check('applyLocalWrite reflects in get', s.electronStore.get('notes').notes[0].id === 'n1');
  check('applyLocalWrite does NOT re-post to native', posted.length === 0);
  check('applyLocalWrite is exportable for upload', s.anjadheStore.exportValues(['notes']).notes.value.notes[0].id === 'n1');
}

// 6. Channel keys are device-local: persisted to native (so pairing survives
//    relaunch) but never advertised/uploaded to the Mac, and the Mac can't
//    overwrite them.
{
  const { s, posted } = make();
  s.electronStore.set('anjadhe:channel:identity', { publicKey: 'pub', secretKey: 'sec' });
  check('channel key persists to native (disk)', posted.length === 1 && posted[0].key === 'anjadhe:channel:identity');
  check('channel key readable locally', s.electronStore.get('anjadhe:channel:identity').publicKey === 'pub');
  // Mix in a normal synced key.
  s.electronStore.set('schedule', { scheduleItems: [] });
  check('channel key excluded from manifest', s.anjadheStore.exportManifest()['anjadhe:channel:identity'] === undefined);
  check('normal key still in manifest', !!s.anjadheStore.exportManifest().schedule);
  check('channel key excluded from exportSet', s.anjadheStore.exportSet()['anjadhe:channel:identity'] === undefined);
  check('channel key excluded from exportValues', s.anjadheStore.exportValues(['anjadhe:channel:identity'])['anjadhe:channel:identity'] === undefined);
  // The Mac must never clobber the phone's identity.
  s.anjadheStore.applyRemote('anjadhe:channel:identity', { publicKey: 'EVIL' }, '2099-01-01T00:00:00.000Z');
  check('applyRemote ignores channel keys', s.electronStore.get('anjadhe:channel:identity').publicKey === 'pub');
}

// 7. hydrate signals readiness via the onHydrated callback (sync waits on it).
{
  let hydrated = 0;
  const s = createStore(() => {}, () => null, () => { hydrated++; });
  s.bridge.hydrate({ a: { value: 1, modifiedAt: '2026-06-18T10:00:00.000Z' } });
  check('hydrate fires onHydrated', hydrated === 1);
}

const total = passed + failures.length;
console.log(`\nNative bridge: ${passed}/${total} checks passed.`);
if (failures.length) { console.error('\nFailures:\n  ' + failures.join('\n  ') + '\n'); process.exit(1); }
console.log('All native-bridge checks passed.\n');
