/**
 * mobile-channel.mjs — the mobile entry point for the secure channel.
 * ===================================================================
 * The iOS WebView has no module loader and cannot resolve the bare @noble
 * imports the channel modules use. scripts/build-mobile.js bundles this file
 * (with esbuild) into one classic script — js/channel/channel.bundle.js —
 * that the mobile build loads with a plain <script> tag.
 *
 * It exposes the phone-side channel API on window.AnjadheChannel; the mobile
 * bridge and the pairing UI use it from there.
 */
import {
  generateIdentity, identityToHex, identityFromHex, acceptPairingOffer,
} from './secure-channel.mjs';
import { createClientEndpoint, createPairingClient } from './channel-endpoint.mjs';
import jsQR from 'jsqr';

window.AnjadheChannel = {
  generateIdentity,
  identityToHex,
  identityFromHex,
  acceptPairingOffer,
  createClientEndpoint,
  createPairingClient,
  // Decode a QR code from a camera frame's raw RGBA pixel data.
  decodeQR(data, width, height) {
    const result = jsQR(data, width, height);
    return result ? result.data : null;
  },
};
