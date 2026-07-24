/* Anjadhe Mobile — Calendar. A read-only month view of synced Google
   Calendar events and scheduled tasks, with a per-day agenda. Events are
   created on the Mac (the phone has no calendar account), so this screen
   only shows them — it never writes events. */
(function () {
  var ICON = '<svg class="tab-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
    + '<rect x="3.4" y="5" width="17.2" height="15.6" rx="2.6"/>'
    + '<path d="M3.4 9.6h17.2M8 3v4M16 3v4"/></svg>';

  var ARROW_L = '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>';
  var ARROW_R = '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>';

  var DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  var state = { y: 0, m: 0, sel: '' };

  function reset() {
    var now = new Date();
    state.y = now.getFullYear();
    state.m = now.getMonth();
    state.sel = App.todayStr();
  }

  // Local Y-M-D of an event. All-day events keep their stored date as-is —
  // parsing them through Date would shift across the timezone boundary.
  function eventDate(ev) {
    if (!ev || !ev.start) return '';
    if (ev.allDay) return String(ev.start).slice(0, 10);
    var d = new Date(ev.start);
    return isNaN(d.getTime()) ? '' : App.dateStr(d);
  }

  function eventsByDate() {
    var map = {};
    (App.load('calendar').events || []).forEach(function (ev) {
      var key = eventDate(ev);
      if (key) (map[key] = map[key] || []).push(ev);
    });
    return map;
  }

  function render(host) {
    if (!state.sel) reset();
    var byDate = eventsByDate();
    var tasks = App.load('schedule').scheduleItems || [];

    host.appendChild(App.topbar(App.backTitle(), function () { App.back(); }));

    var head = App.el('<header class="screen-head"></header>');
    head.style.setProperty('--i', 0);
    head.innerHTML = '<h1 class="screen-title">Calendar</h1>';
    host.appendChild(head);

    var sec = App.el('<section class="section"></section>');
    sec.style.setProperty('--i', 1);

    var nav = App.el('<div class="cal-nav"></div>');
    var prev = App.el('<button class="cal-arrow" type="button" aria-label="Previous month"></button>');
    prev.innerHTML = ARROW_L;
    prev.addEventListener('click', function () { step(-1); });
    var next = App.el('<button class="cal-arrow" type="button" aria-label="Next month"></button>');
    next.innerHTML = ARROW_R;
    next.addEventListener('click', function () { step(1); });
    var label = App.el('<div class="cal-month"></div>');
    label.textContent = MONTHS[state.m] + ' ' + state.y;
    nav.appendChild(prev);
    nav.appendChild(label);
    nav.appendChild(next);
    sec.appendChild(nav);
    sec.appendChild(buildGrid(byDate, tasks));
    host.appendChild(sec);

    host.appendChild(buildAgenda(byDate, tasks));
  }

  function step(delta) {
    state.m += delta;
    if (state.m < 0) { state.m = 11; state.y--; }
    else if (state.m > 11) { state.m = 0; state.y++; }
    App.refresh();
  }

  function dayHasItems(ds, byDate, tasks) {
    if ((byDate[ds] || []).length) return true;
    var d = new Date(ds + 'T00:00:00');
    return tasks.some(function (t) { return App.taskDueOn(t, d); });
  }

  function buildGrid(byDate, tasks) {
    var grid = App.el('<div class="cal-grid"></div>');
    DOW.forEach(function (d) {
      grid.appendChild(App.el('<div class="cal-dow">' + d + '</div>'));
    });

    var startDow = new Date(state.y, state.m, 1).getDay();
    var daysInMonth = new Date(state.y, state.m + 1, 0).getDate();
    var totalCells = Math.ceil((startDow + daysInMonth) / 7) * 7;
    var cell = new Date(state.y, state.m, 1 - startDow);
    var today = App.todayStr();

    for (var i = 0; i < totalCells; i++) {
      var ds = App.dateStr(cell);
      var btn = App.el('<button class="cal-cell" type="button"></button>');
      if (cell.getMonth() !== state.m) btn.classList.add('dim');
      if (ds === today) btn.classList.add('today');
      if (ds === state.sel) btn.classList.add('sel');
      var dot = dayHasItems(ds, byDate, tasks) ? ' on' : '';
      btn.innerHTML = '<span class="cal-num">' + cell.getDate() + '</span>'
        + '<span class="cal-dot' + dot + '"></span>';
      (function (dateStr) {
        btn.addEventListener('click', function () {
          state.sel = dateStr;
          var d = new Date(dateStr + 'T00:00:00');
          state.y = d.getFullYear();
          state.m = d.getMonth();
          App.refresh();
        });
      })(ds);
      grid.appendChild(btn);
      cell.setDate(cell.getDate() + 1);
    }
    return grid;
  }

  function fmtTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function buildAgenda(byDate, tasks) {
    var s = App.el('<section class="section"></section>');
    s.style.setProperty('--i', 2);

    var d = new Date(state.sel + 'T00:00:00');
    var label = isNaN(d.getTime()) ? 'Day'
      : d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    s.appendChild(App.el('<div class="section-label">' + App.esc(label) + '</div>'));

    var events = (byDate[state.sel] || []).slice().sort(function (a, b) {
      if (!!a.allDay !== !!b.allDay) return a.allDay ? -1 : 1;
      return String(a.start || '').localeCompare(String(b.start || ''));
    });
    var dayTasks = tasks
      .filter(function (t) { return App.taskDueOn(t, d); })
      .sort(function (a, b) {
        return (a.startTime || '99:99').localeCompare(b.startTime || '99:99');
      });

    if (!events.length && !dayTasks.length) {
      s.appendChild(App.el('<p class="empty">Nothing on this day.</p>'));
      return s;
    }

    var list = App.el('<div class="card list"></div>');
    events.forEach(function (ev) { list.appendChild(eventRow(ev)); });
    dayTasks.forEach(function (t) { list.appendChild(taskRow(t)); });
    s.appendChild(list);
    return s;
  }

  function eventRow(ev) {
    var row = App.el('<div class="row"></div>');
    var time = ev.allDay ? 'All day' : fmtTime(ev.start);
    row.innerHTML = '<span class="row-main">'
      + '<span class="row-title">' + App.esc(ev.summary || '(No title)') + '</span>'
      + (ev.location ? '<span class="row-sub">' + App.esc(ev.location) + '</span>' : '')
      + '</span>'
      + (time ? '<span class="row-time">' + App.esc(time) + '</span>' : '');
    if (ev.htmlLink) {
      row.classList.add('tappable');
      row.addEventListener('click', function () { App.openExternal(ev.htmlLink); });
    }
    return row;
  }

  function taskRow(t) {
    // Completion is tracked per "today" only, so the check is interactive
    // on today and a static marker on any other day.
    var isToday = state.sel === App.todayStr();
    var done = isToday && App.taskDoneToday(t);
    var row = App.el('<div class="row split"></div>');

    var check = App.el('<button class="check' + (done ? ' on' : '')
      + (isToday ? '' : ' muted') + '" type="button" aria-label="Complete"></button>');
    if (done) check.innerHTML = App.icons.check;
    check.disabled = !isToday;
    if (isToday) check.addEventListener('click', function () { toggleTask(t.id); });

    var main = App.el('<button class="row-main" type="button"></button>');
    main.innerHTML = '<span class="row-title' + (done ? ' done' : '') + '">'
      + App.esc(t.title || 'Untitled') + '</span>'
      + '<span class="row-sub">Task</span>';
    main.addEventListener('click', function () { openTask(t.id); });

    row.appendChild(check);
    row.appendChild(main);
    if (t.startTime) {
      row.appendChild(App.el('<span class="row-time">' + App.esc(App.fmtTime(t.startTime)) + '</span>'));
    }
    return row;
  }

  // Open a specific task in the Tasks editor; Back returns to the calendar.
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

  App.registerScreen('calendar', { label: 'Calendar', icon: ICON, render: render, reset: reset });
})();
