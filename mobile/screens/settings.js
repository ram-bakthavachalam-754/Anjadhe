/* Anjadhe Mobile — Settings.
   A sub-page reached from the gear in the Home header (not a tab).
   Hosts the Paired Devices section: pair this phone with a Mac, sync
   on demand, or forget the pairing. */
(function () {
  // The phone<->Mac pairing record, written by mobile-pairing.js. Read
  // straight from localStorage so this screen still renders in preview.html,
  // where the channel layer is not loaded.
  var LS_PAIRING = 'anjadhe:channel:pairing';

  function isPaired() {
    try { return !!localStorage.getItem(LS_PAIRING); } catch (e) { return false; }
  }

  function render(host) {
    host.appendChild(App.topbar(App.backTitle(), function () { App.back(); }));

    var title = App.el('<header class="screen-head"></header>');
    title.style.setProperty('--i', 0);
    title.innerHTML = '<h1 class="screen-title">Settings</h1>';
    host.appendChild(title);

    var section = App.el('<section class="section"></section>');
    section.style.setProperty('--i', 1);
    section.appendChild(App.el('<div class="section-label">Paired Devices</div>'));
    if (isPaired()) buildPaired(section);
    else buildUnpaired(section);
    host.appendChild(section);
  }

  function statusCard(on, titleText, subText) {
    var card = App.el('<div class="card"></div>');
    card.innerHTML = '<div class="pair-status">'
      + '<span class="pair-dot' + (on ? ' on' : '') + '"></span>'
      + '<div class="pair-status-main">'
      + '<div class="pair-status-title">' + App.esc(titleText) + '</div>'
      + '<div class="pair-status-sub">' + App.esc(subText) + '</div>'
      + '</div></div>';
    return card;
  }

  function button(cls, label, onClick) {
    var b = App.el('<button class="' + cls + '" type="button"></button>');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function buildUnpaired(section) {
    section.appendChild(statusCard(false, 'Not paired',
      'Pair this phone with your Mac to sync your notes, tasks and '
      + 'journal over a direct, encrypted connection.'));

    var stack = App.el('<div class="btn-stack"></div>');
    stack.appendChild(button('btn-primary', 'Pair with your Mac', startPairing));
    section.appendChild(stack);
  }

  function buildPaired(section) {
    section.appendChild(statusCard(true, 'Paired with your Mac',
      'Your notes, tasks and journal sync both ways.'));

    var stack = App.el('<div class="btn-stack"></div>');
    stack.appendChild(button('btn-primary', 'Sync now', syncNow));
    stack.appendChild(button('btn-secondary', 'Pair again', startPairing));
    section.appendChild(stack);

    var hint = App.el('<p class="pair-hint"></p>');
    hint.textContent = 'Mac stopped syncing — or removed this phone? '
      + 'Pair again to reconnect.';
    section.appendChild(hint);

    section.appendChild(button('danger-btn', 'Forget this Mac', forgetMac));
  }

  // --- actions -----------------------------------------------------------
  function startPairing() {
    if (!window.AnjadhePairing) {           // e.g. the desktop-only preview
      window.alert('Pairing is available in the installed app.');
      return;
    }
    window.AnjadhePairing.open(function (didPair) {
      App.refresh();                        // reflect the new pairing state
      if (didPair && window.AnjadheSync) window.AnjadheSync.sync();
    });
  }

  function syncNow() {
    if (window.AnjadheSync) window.AnjadheSync.sync();
  }

  function forgetMac() {
    if (!window.AnjadhePairing) return;
    if (!window.confirm('Forget this Mac? This phone will stop syncing '
      + 'until you pair again.')) return;
    window.AnjadhePairing.forget();
    App.refresh();
  }

  App.registerScreen('settings', { label: 'Settings', render: render });
})();
