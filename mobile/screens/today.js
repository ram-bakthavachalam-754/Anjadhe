/* Anjadhe Mobile — Today (home root).
   The companion's heart: resume what you were writing, then check off
   today's tasks. Reads come from synced data. */
(function () {
  var SETTINGS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
    + '<circle cx="12" cy="12" r="3"/>'
    + '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06'
    + 'a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09'
    + 'A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06'
    + 'a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09'
    + 'A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06'
    + 'a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09'
    + 'a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06'
    + 'a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09'
    + 'a1.65 1.65 0 0 0-1.51 1z"/></svg>';

  var SYNC_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M3 12a9 9 0 0 1 15.5-6.3"/><path d="M21 4v5h-5"/>'
    + '<path d="M21 12a9 9 0 0 1-15.5 6.3"/><path d="M3 20v-5h5"/></svg>';

  function stateLabel(s) {
    if (s === 'syncing') return 'Syncing with your Mac…';
    if (s === 'idle') return 'In sync — tap to sync now';
    if (s === 'connecting') return 'Connecting to your Mac…';
    if (s === 'error') return 'Sync failed — tap to retry';
    return 'Offline — tap to retry';
  }

  function greeting() {
    var h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }
  function dateLine() {
    return new Date().toLocaleDateString(undefined, {
      weekday: 'long', month: 'long', day: 'numeric',
    });
  }

  function render(host) {
    var counter = { i: 0 };
    var tasks = App.load('schedule').scheduleItems || [];
    var notes = App.load('notes').notes || [];
    var entries = App.load('journal').entries || [];

    // --- header (compact: greeting + date, with sync + settings) ---
    var head = App.el('<header class="screen-head has-action"></header>');
    head.style.setProperty('--i', counter.i++);
    head.innerHTML = '<div class="head-text">'
      + '<h1 class="greeting">' + greeting() + '</h1>'
      + '<p class="screen-sub">' + App.esc(dateLine()) + '</p>'
      + '</div>';
    var actions = App.el('<div class="head-actions"></div>');

    var sync = App.el('<button class="head-action head-sync" type="button" aria-label="Sync status"></button>');
    sync.innerHTML = SYNC_ICON;
    sync.addEventListener('click', function () { if (window.AnjadheSync) window.AnjadheSync.sync(); });
    if (window.AnjadheSync && typeof window.AnjadheSync.onStateChange === 'function') {
      var unsub = window.AnjadheSync.onStateChange(function (s) {
        if (!document.contains(sync)) { if (unsub) unsub(); return; }
        sync.setAttribute('data-state', s);
        sync.setAttribute('title', stateLabel(s));
      });
    } else {
      sync.setAttribute('data-state', 'offline');
    }
    actions.appendChild(sync);

    var gear = App.el('<button class="head-action" type="button" aria-label="Settings"></button>');
    gear.innerHTML = SETTINGS_ICON;
    gear.addEventListener('click', function () { App.open('settings'); });
    actions.appendChild(gear);

    head.appendChild(actions);
    host.appendChild(head);

    // --- today's tasks ---
    var todays = tasks
      .filter(function (t) { return App.taskDueToday(t) && !App.taskDoneToday(t); })
      .sort(function (a, b) { return (a.startTime || '99:99').localeCompare(b.startTime || '99:99'); });
    host.appendChild(taskSection(todays, counter));

    // --- continue (resume on mobile) ---
    var resume = []
      .concat(notes.map(function (n) {
        return { kind: 'notes', id: n.id, at: n.modifiedAt || n.createdAt,
          title: n.title || 'Untitled', sub: App.plainText(n.content, 60) || 'Empty note' };
      }))
      .concat(entries.map(function (e) {
        return { kind: 'journal', id: e.id, at: e.modifiedAt || e.date || e.createdAt,
          title: App.relDate(e.date || e.createdAt) || 'Entry',
          sub: App.plainText(e.content, 60) || 'Empty entry' };
      }))
      .filter(function (r) { return r.at; })
      .sort(function (a, b) { return (b.at || '').localeCompare(a.at || ''); })
      .slice(0, 3);
    if (resume.length) host.appendChild(continueSection(resume, counter));
  }

  function section(counter) {
    var s = App.el('<section class="section"></section>');
    s.style.setProperty('--i', counter.i++);
    return s;
  }

  function continueSection(items, counter) {
    var s = section(counter);
    s.innerHTML = '<div class="section-label">Continue</div>';
    var list = App.el('<div class="card list"></div>');
    items.forEach(function (r) {
      var row = App.el('<button class="row" type="button"></button>');
      row.innerHTML = '<span class="row-main">'
        + '<span class="row-title">' + App.esc(r.title) + '</span>'
        + '<span class="row-sub">' + App.esc(r.sub) + '</span>'
        + '</span>'
        + '<span class="row-time">' + App.esc(r.at ? App.relDate(r.at) : '') + '</span>';
      row.addEventListener('click', function () { openRecord(r.kind, r.id); });
      list.appendChild(row);
    });
    s.appendChild(list);
    return s;
  }

  // Open a specific note/journal record (resume); Back returns to Today.
  function openRecord(kind, id) { App.openDetail(kind, id); }

  function taskSection(todays, counter) {
    var s = section(counter);
    s.innerHTML = '<div class="section-label">Today</div>';
    if (!todays.length) {
      s.appendChild(App.el('<p class="empty">Nothing scheduled — enjoy the space.</p>'));
      return s;
    }
    var list = App.el('<div class="card list"></div>');
    todays.forEach(function (t) {
      var row = App.el('<div class="row split"></div>');

      var check = App.el('<button class="check" type="button" aria-label="Complete"></button>');
      check.addEventListener('click', function () { toggleTask(t.id); });

      var main = App.el('<button class="row-main" type="button"></button>');
      main.innerHTML = '<span class="row-title">' + App.esc(t.title || 'Untitled') + '</span>'
        + (t.startTime ? '<span class="row-sub">' + App.esc(App.fmtTime(t.startTime)) + '</span>' : '');
      main.addEventListener('click', function () { openTask(t.id); });

      row.appendChild(check);
      row.appendChild(main);
      list.appendChild(row);
    });
    s.appendChild(list);
    return s;
  }

  // Open a specific task in the Tasks editor; Back returns to Today.
  function openTask(id) { App.openDetail('tasks', id); }

  function toggleTask(id) {
    var data = App.load('schedule');
    var t = (data.scheduleItems || []).find(function (x) { return x.id === id; });
    if (!t) return;
    t.lastCompletedDate = App.taskDoneToday(t) ? null : App.todayStr();
    t.modifiedAt = App.nowISO();
    App.save('schedule', data);
    App.refresh();
  }

  App.registerScreen('today', { label: 'Today', render: render });
})();
