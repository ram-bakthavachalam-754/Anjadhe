/* Anjadhe Mobile — Search (root).
   One box to jump to anything: notes, journal entries, tasks.
   As the app grows, this is the fast path the function bar can't be. */
(function () {
  var state = { q: '' };
  function reset() { state.q = ''; }

  function render(host) {
    var head = App.el('<header class="screen-head"></header>');
    head.style.setProperty('--i', 0);
    head.innerHTML = '<h1 class="screen-title">Search</h1>';
    host.appendChild(head);

    var sec = App.el('<section class="section"></section>');
    sec.style.setProperty('--i', 1);
    var input = App.el('<input class="apps-search" type="search" placeholder="Search everything…" autocomplete="off" />');
    input.value = state.q;
    var results = App.el('<div class="search-results"></div>');
    input.addEventListener('input', function () { state.q = input.value; paint(results, state.q); });
    sec.appendChild(input);
    sec.appendChild(results);
    host.appendChild(sec);

    paint(results, state.q);
  }

  function paint(host, q) {
    host.innerHTML = '';
    var query = (q || '').trim().toLowerCase();
    if (!query) {
      host.appendChild(App.el('<p class="empty">Type to search your notes, journal and tasks.</p>'));
      return;
    }
    var hits = [];
    (App.load('notes').notes || []).forEach(function (n) {
      var hay = ((n.title || '') + ' ' + App.plainText(n.content)).toLowerCase();
      if (hay.indexOf(query) >= 0) hits.push({ app: 'notes', id: n.id, title: n.title || 'Untitled', sub: 'Note' });
    });
    (App.load('journal').entries || []).forEach(function (e) {
      var hay = App.plainText(e.content).toLowerCase();
      if (hay.indexOf(query) >= 0) hits.push({ app: 'journal', id: e.id, title: App.relDate(e.date || e.createdAt) || 'Entry', sub: 'Journal' });
    });
    (App.load('schedule').scheduleItems || []).forEach(function (t) {
      if ((t.title || '').toLowerCase().indexOf(query) >= 0) hits.push({ app: 'tasks', id: t.id, title: t.title || 'Untitled', sub: 'Task' });
    });

    if (!hits.length) {
      host.appendChild(App.el('<p class="empty">No matches.</p>'));
      return;
    }
    var list = App.el('<div class="card list"></div>');
    hits.slice(0, 40).forEach(function (r) {
      var row = App.el('<button class="row" type="button"></button>');
      row.innerHTML = '<span class="row-main">'
        + '<span class="row-title">' + App.esc(r.title) + '</span>'
        + '<span class="row-sub">' + App.esc(r.sub) + '</span>'
        + '</span>';
      row.addEventListener('click', function () { App.openDetail(r.app, r.id); });
      list.appendChild(row);
    });
    host.appendChild(list);
  }

  App.registerScreen('search', { label: 'Search', render: render, reset: reset });
})();
