/**
 * mobile-pairing.js — device pairing for the iOS app.
 * ===================================================
 * Shows a "Pair with your Mac" overlay, scans the QR the desktop displays
 * (camera + the bundled jsQR decoder), and runs the pairing handshake over
 * the relay. On first run with no stored pairing it opens automatically.
 *
 * It also exposes `window.AnjadhePairing` so the Settings screen can open
 * the overlay on demand — to pair after the first-run prompt was skipped,
 * or to re-pair if the Mac dropped this device — and forget the pairing.
 *
 * Mobile-only — injected by scripts/build-mobile.js after channel.bundle.js
 * (which provides window.AnjadheChannel) and mobile-bridge.js.
 *
 * On success it stores the phone's identity and the pairing record in
 * localStorage.
 */
(function () {
  'use strict';
  if (!window.__ANJADHE_MOBILE__) return;

  const LS_IDENTITY = 'anjadhe:channel:identity'; // phone X25519 identity (hex)
  const LS_PAIRING = 'anjadhe:channel:pairing';   // stored pairing record

  // Persist the identity/pairing record durably. In the native host the sync
  // WebView is rebuilt from loadHTMLString each launch (no durable localStorage),
  // so route through electronStore → native KVStore → disk; the native bridge
  // keeps these `anjadhe:channel:*` keys device-local (never synced to the Mac).
  // On the Capacitor web build, localStorage on the real origin is durable.
  const nativeStore = window.__ANJADHE_NATIVE_HOST__ && window.electronStore ? window.electronStore : null;
  function load(key) {
    if (nativeStore) { const v = nativeStore.get(key); return v == null ? null : v; }
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }
  function save(key, value) {
    if (nativeStore) { try { nativeStore.set(key, value); } catch { /* ignore */ } return; }
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  }
  function remove(key) {
    if (nativeStore) { try { nativeStore.delete(key); } catch { /* ignore */ } return; }
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }

  // The phone's long-term identity — generated once, persisted thereafter.
  function phoneIdentity() {
    const stored = load(LS_IDENTITY);
    if (stored && stored.secretKey && stored.publicKey) {
      return window.AnjadheChannel.identityFromHex(stored);
    }
    const fresh = window.AnjadheChannel.generateIdentity();
    save(LS_IDENTITY, window.AnjadheChannel.identityToHex(fresh));
    return fresh;
  }

  const STYLE = `
    #anj-pair { position: fixed; inset: 0; z-index: 100000;
      background: var(--color-bg, #fff); color: var(--color-text, #111);
      display: flex; flex-direction: column;
      font-family: var(--font-sans, -apple-system, system-ui, sans-serif); }
    #anj-pair .anj-body { flex: 1; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 16px;
      padding: 32px; text-align: center; }
    #anj-pair h1 { font-family: var(--font-serif, inherit);
      font-size: 1.55rem; font-weight: 700; margin: 0; }
    #anj-pair p { margin: 0; max-width: 300px; line-height: 1.5;
      font-size: 0.95rem; color: var(--color-text-secondary, #555); }
    #anj-pair button { font: inherit; font-size: 1rem; font-weight: 600;
      padding: 12px 24px; border-radius: 10px; border: none; cursor: pointer; }
    #anj-pair .anj-primary { background: var(--color-text, #111);
      color: var(--color-bg, #fff); }
    #anj-pair .anj-link { background: none; font-weight: 400; padding: 8px;
      color: var(--color-text-secondary, #666); text-decoration: underline; }
    #anj-pair .anj-scan { flex: 1; width: 100%; display: flex; flex-direction: column; }
    #anj-pair .anj-cam { position: relative; flex: 1; background: #000; overflow: hidden; }
    #anj-pair video { width: 100%; height: 100%; object-fit: cover; }
    #anj-pair .anj-reticle { position: absolute; inset: 0; display: flex;
      align-items: center; justify-content: center; pointer-events: none; }
    #anj-pair .anj-reticle::after { content: ''; width: 220px; height: 220px;
      border: 3px solid rgba(255,255,255,0.9); border-radius: 16px; }
    #anj-pair .anj-bar { padding: 16px; display: flex; flex-direction: column;
      align-items: center; gap: 8px; background: var(--color-bg, #fff); }
    #anj-pair .anj-spinner { width: 28px; height: 28px; border-radius: 50%;
      border: 3px solid var(--color-border, #ddd);
      border-top-color: var(--color-text, #111);
      animation: anj-spin 0.8s linear infinite; }
    @keyframes anj-spin { to { transform: rotate(360deg); } }
    #anj-pair .anj-check { font-size: 3rem; line-height: 1; }
  `;

  let overlay = null;
  let stream = null;
  let rafId = 0;
  let onCloseCb = null;          // invoked once when the overlay is dismissed
  let pairedThisSession = false; // did a pairing succeed while the overlay was up?

  function el(html) {
    const wrap = document.createElement('div');
    wrap.innerHTML = html.trim();
    return wrap.firstChild;
  }

  function stopCamera() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  }

  function dismiss() {
    stopCamera();
    if (overlay) { overlay.remove(); overlay = null; }
    const cb = onCloseCb;
    onCloseCb = null;
    if (cb) { try { cb(pairedThisSession); } catch (e) { /* ignore */ } }
  }

  function show(node) {
    if (!overlay) {
      overlay = el('<div id="anj-pair"></div>');
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = '';
    overlay.appendChild(node);
  }

  function viewIntro() {
    stopCamera();
    const node = el(`
      <div class="anj-body">
        <h1>Pair with your Mac</h1>
        <p>On your Mac: open Anjadhe, then Settings &rarr; Paired Devices &rarr;
           "Pair a device". Scan the code it shows.</p>
        <button class="anj-primary" data-act="scan">Scan your Mac's code</button>
        <button class="anj-link" data-act="skip">Not now</button>
      </div>
    `);
    node.querySelector('[data-act="scan"]').onclick = startScan;
    node.querySelector('[data-act="skip"]').onclick = dismiss;
    show(node);
  }

  function viewPairing() {
    show(el(`
      <div class="anj-body">
        <div class="anj-spinner"></div>
        <p>Pairing with your Mac&hellip;</p>
      </div>
    `));
  }

  function viewSuccess() {
    stopCamera();
    const node = el(`
      <div class="anj-body">
        <div class="anj-check">&#10003;</div>
        <h1>Paired</h1>
        <p>This phone is now paired with your Mac.</p>
        <button class="anj-primary" data-act="done">Done</button>
      </div>
    `);
    node.querySelector('[data-act="done"]').onclick = dismiss;
    show(node);
  }

  function viewError(message) {
    stopCamera();
    const node = el(`
      <div class="anj-body">
        <h1>Pairing didn't work</h1>
        <p>${String(message).replace(/</g, '&lt;')}</p>
        <button class="anj-primary" data-act="retry">Try again</button>
        <button class="anj-link" data-act="skip">Not now</button>
      </div>
    `);
    node.querySelector('[data-act="retry"]').onclick = viewIntro;
    node.querySelector('[data-act="skip"]').onclick = dismiss;
    show(node);
  }

  async function startScan() {
    const node = el(`
      <div class="anj-scan">
        <div class="anj-cam">
          <video playsinline muted></video>
          <div class="anj-reticle"></div>
        </div>
        <div class="anj-bar">
          <p>Point at the QR code on your Mac.</p>
          <button class="anj-link" data-act="cancel">Cancel</button>
        </div>
      </div>
    `);
    node.querySelector('[data-act="cancel"]').onclick = viewIntro;
    show(node);

    const video = node.querySelector('video');
    video.muted = true;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }, audio: false,
      });
    } catch (err) {
      viewError('Camera access is needed to scan the code. ' + (err.message || ''));
      return;
    }
    video.srcObject = stream;
    try { await video.play(); } catch { /* ignore */ }

    const tick = () => {
      if (!stream) return; // cancelled
      if (video.readyState >= video.HAVE_ENOUGH_DATA && video.videoWidth) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const text = window.AnjadheChannel.decodeQR(frame.data, frame.width, frame.height);
        if (text) { onScanned(text); return; }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  // Core accept logic, DOM-free, reusable by both the in-WebView camera flow
  // and the native pairing path (window.AnjadhePairing.pairWithOffer). Parses
  // the offer text, runs the channel handshake, and persists the pairing on
  // success. Returns { ok, error?, pairing? }.
  async function acceptOfferText(text) {
    let offer = null;
    try { offer = JSON.parse(text); } catch { /* not JSON */ }
    if (!offer || offer.v !== 1 || !offer.relayUrl || !offer.routingId) {
      return { ok: false, error: 'That is not an Anjadhe pairing code.' };
    }
    try {
      const identity = phoneIdentity();
      const { registration, pairing } = window.AnjadheChannel.acceptPairingOffer(offer, identity);
      const pc = window.AnjadheChannel.createPairingClient({
        relayUrl: offer.relayUrl, routingId: offer.routingId, registration,
      });
      const result = await Promise.race([
        pc.result,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('Timed out. Is your Mac on the same Wi-Fi with Anjadhe open?')),
          20000,
        )),
      ]);
      pc.close();
      if (result && result.ok) {
        save(LS_PAIRING, pairing);
        pairedThisSession = true;
        return { ok: true, pairing: pairing };
      }
      return { ok: false, error: (result && result.error) || 'Your Mac refused the pairing.' };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : 'Pairing failed.' };
    }
  }

  async function onScanned(text) {
    stopCamera();
    viewPairing();
    const r = await acceptOfferText(text);
    if (r.ok) viewSuccess(); else viewError(r.error);
  }

  function ensureStyle() {
    if (document.getElementById('anj-pair-style')) return;
    const styleTag = document.createElement('style');
    styleTag.id = 'anj-pair-style';
    styleTag.textContent = STYLE;
    document.head.appendChild(styleTag);
  }

  // Open the pairing overlay on demand. `cb(didPair)` fires once when the
  // overlay closes — didPair is true only if a pairing actually succeeded.
  // Used by the Settings screen to pair (or re-pair) after first run.
  function open(cb) {
    if (!window.AnjadheChannel) {           // channel bundle missing
      if (cb) { try { cb(false); } catch (e) { /* ignore */ } }
      return;
    }
    onCloseCb = cb || null;
    pairedThisSession = false;
    ensureStyle();
    viewIntro();
  }

  // Drop the stored pairing — the phone stops syncing until paired again.
  function forget() {
    remove(LS_PAIRING);
  }

  function start() {
    // The native iOS sync host drives pairing itself (native QR/offer → the
    // pairWithOffer bridge), so it must NOT auto-open the DOM camera overlay.
    if (window.__ANJADHE_NATIVE_HOST__) return;
    if (load(LS_PAIRING)) return;        // already paired — nothing to do
    if (!window.AnjadheChannel) return;  // channel bundle missing
    // First run: pair, and sync straight away once it succeeds.
    open(function (didPair) {
      if (didPair && window.AnjadheSync) window.AnjadheSync.sync();
    });
  }

  // Let the Settings screen re-open pairing, check it, or drop it. The native
  // host uses pairWithOffer (a scanned/pasted offer string → handshake).
  window.AnjadhePairing = {
    open: open,
    forget: forget,
    isPaired: function () { return !!load(LS_PAIRING); },
    pairWithOffer: function (text) { return acceptOfferText(text); },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
