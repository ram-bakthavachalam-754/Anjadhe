#!/usr/bin/env node
/**
 * build-mobile.js — assemble the Capacitor web bundle into ./www
 *
 * The mobile app is a separate, purpose-built front-end (the `mobile/`
 * directory) — not the desktop UI. This script assembles it:
 *
 *   1. the mobile front-end       — mobile/  (shell, styles, screens)
 *   2. the data + channel layer   — StorageManager, the mobile bridge,
 *                                   pairing, and sync
 *   3. the secure channel bundle  — esbuild bundles the ESM channel +
 *                                   @noble crypto into one classic script
 *
 * Run:  npm run build:mobile
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'www');

// Data/channel-layer files copied verbatim (shared with the desktop build).
const SHARED_FILES = [
  'js/core/storage-manager.js',
  'js/adapter/mobile-bridge.js',
  'js/adapter/mobile-pairing.js',
  'js/adapter/mobile-sync.js',
  // Shipped so the native iOS sync host (a hidden WKWebView) can load it instead
  // of mobile-bridge.js — backs storage with the native KVStore (SyncCoordinator,
  // docs/MOBILE_NATIVE.md). The normal mobile index.html does not load it.
  'js/adapter/native-bridge.js',
];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// 1. The mobile front-end.
fs.cpSync(path.join(root, 'mobile'), out, { recursive: true });

// 2. The data + channel layer it sits on.
for (const rel of SHARED_FILES) {
  const dst = path.join(out, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(root, rel), dst);
}

// 3. Bundle the secure channel (ESM + @noble) into one classic script.
require('esbuild').buildSync({
  entryPoints: [path.join(root, 'js', 'channel', 'mobile-channel.mjs')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  outfile: path.join(out, 'js', 'channel', 'channel.bundle.js'),
});

console.log('build-mobile: wrote ' + path.relative(root, out) + '/');
console.log('  ' + fs.readdirSync(out).join(', '));
