/* Anjadhe Mobile — Apps (launcher root).
   A searchable grid of every app. The long tail lives here so the function
   bar never has to grow. Tapping a tile pushes that app. */
(function () {
  var state = { q: '' };
  function reset() { state.q = ''; }

  function render(host) {
    var head = App.el('<header class="screen-head"></header>');
    head.style.setProperty('--i', 0);
    head.innerHTML = '<h1 class="screen-title">Apps</h1>';
    host.appendChild(head);

    var sec = App.el('<section class="section"></section>');
    sec.style.setProperty('--i', 1);

    var search = App.el('<input class="apps-search" type="search" placeholder="Search apps…" autocomplete="off" />');
    search.value = state.q;
    search.addEventListener('input', function () {
      state.q = search.value;
      paint(grid, state.q);
    });
    sec.appendChild(search);

    var grid = App.el('<div class="app-grid"></div>');
    paint(grid, state.q);
    sec.appendChild(grid);
    host.appendChild(sec);

    // Keep focus quirks off — don't auto-focus (would pop the keyboard on open).
  }

  function paint(grid, q) {
    grid.innerHTML = '';
    var query = (q || '').trim().toLowerCase();
    App.apps.forEach(function (id) {
      var scr = App.screens[id];
      if (!scr) return;
      if (query && (scr.label || id).toLowerCase().indexOf(query) === -1) return;
      var tile = App.el('<button class="app-tile" type="button"></button>');
      tile.innerHTML = (scr.icon || '') + '<span class="app-tile-label">' + App.esc(scr.label || id) + '</span>';
      App._attachFastTap(tile, function () { App.open(id); });
      grid.appendChild(tile);
    });
    if (!grid.children.length) {
      grid.appendChild(App.el('<p class="empty">No apps match.</p>'));
    }
  }

  App.registerScreen('apps', { label: 'Apps', render: render, reset: reset });
})();
