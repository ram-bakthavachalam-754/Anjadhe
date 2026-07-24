/* Anjadhe Mobile — Tasks. Grouped Overdue / Today / Upcoming with completion. */
(function () {
  var ICON = '<svg class="tab-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M10 6.5h10M10 12h10M10 17.5h10"/>'
    + '<path d="M3.6 6l1.3 1.3 2.5-2.9M3.6 12l1.3 1.3 2.5-2.9"/>'
    + '<circle cx="5" cy="17.5" r="0.6" fill="currentColor"/></svg>';

  var state = { editingId: null };
  function reset() { state.editingId = null; }
  function render(host) { state.editingId ? renderEditor(host) : renderList(host); }

  function renderList(host) {
    var tasks = App.load('schedule').scheduleItems || [];
    var today = App.todayStr();
    var overdue = [], todayG = [], upcoming = [], done = [];

    host.appendChild(App.topbar(App.backTitle(), function () { App.back(); }));

    tasks.forEach(function (t) {
      if (App.taskDueToday(t)) {
        (App.taskDoneToday(t) ? done : todayG).push(t);
      } else if (t.repeat === 'none' && t.scheduledDate) {
        if (t.scheduledDate < today) { if (!App.taskDoneToday(t)) overdue.push(t); }
        else if (t.scheduledDate > today) upcoming.push(t);
      }
    });
    var byTime = function (a, b) { return (a.startTime || '99:99').localeCompare(b.startTime || '99:99'); };
    var byDate = function (a, b) { return (a.scheduledDate || '').localeCompare(b.scheduledDate || ''); };
    overdue.sort(byDate); todayG.sort(byTime); upcoming.sort(byDate); done.sort(byTime);

    var head = App.el('<header class="screen-head"></header>');
    head.style.setProperty('--i', 0);
    var sub = !tasks.length ? ''
      : (todayG.length ? todayG.length + ' left today' : 'All clear for today');
    head.innerHTML = '<h1 class="screen-title">Tasks</h1>'
      + (sub ? '<p class="screen-sub">' + sub + '</p>' : '');
    host.appendChild(head);

    if (!tasks.length) {
      var e = App.el('<section class="section"></section>');
      e.style.setProperty('--i', 1);
      e.innerHTML = '<p class="empty">No tasks yet. Tap + to add one.</p>';
      host.appendChild(e);
    } else {
      var idx = { v: 1 };
      group(host, 'Overdue', overdue, idx, true);
      group(host, 'Today', todayG, idx, false);
      group(host, 'Upcoming', upcoming, idx, false);
      group(host, 'Done today', done, idx, false);
    }
    host.appendChild(App.fab(App.icons.plus, createTask));
  }

  function group(host, label, items, idx, danger) {
    if (!items.length) return;
    var sec = App.el('<section class="section"></section>');
    sec.style.setProperty('--i', idx.v++);
    sec.innerHTML = '<div class="group-label' + (danger ? ' overdue' : '') + '">'
      + label + '<span class="count">' + items.length + '</span></div>';
    var list = App.el('<div class="card list"></div>');
    items.forEach(function (t) { list.appendChild(taskRow(t)); });
    sec.appendChild(list);
    host.appendChild(sec);
  }

  function taskRow(t) {
    var done = App.taskDoneToday(t);
    var row = App.el('<div class="row split"></div>');

    var check = App.el('<button class="check' + (done ? ' on' : '')
      + '" type="button" aria-label="Complete"></button>');
    if (done) check.innerHTML = App.icons.check;
    check.addEventListener('click', function () { toggle(t.id); });

    // Date shows for any non-today dated task (overdue / upcoming); time is
    // 12-hour. Today's tasks and repeaters just show the time.
    var parts = [];
    if (t.repeat === 'none' && t.scheduledDate && t.scheduledDate !== App.todayStr()) {
      parts.push(App.relDate(t.scheduledDate + 'T00:00:00'));
    }
    if (t.startTime) parts.push(App.fmtTime(t.startTime));
    var meta = parts.join(' · ');
    var main = App.el('<button class="row-main" type="button"></button>');
    main.innerHTML = '<span class="row-title' + (done ? ' done' : '') + '">'
      + App.esc(t.title || 'Untitled') + '</span>'
      + (meta ? '<span class="row-sub">' + App.esc(meta) + '</span>' : '');
    main.addEventListener('click', function () { state.editingId = t.id; App.refresh(); });

    row.appendChild(check);
    row.appendChild(main);
    return row;
  }

  function toggle(id) {
    var data = App.load('schedule');
    var t = (data.scheduleItems || []).find(function (x) { return x.id === id; });
    if (!t) return;
    t.lastCompletedDate = App.taskDoneToday(t) ? null : App.todayStr();
    t.modifiedAt = App.nowISO();
    App.save('schedule', data);
    App.refresh();
  }

  function createTask() {
    var data = App.load('schedule');
    data.scheduleItems = data.scheduleItems || [];
    var t = {
      id: App.newId(), title: '', startTime: '', endTime: null, notifyBefore: 0,
      repeat: 'none', dayOfWeek: null, repeatDays: [], scheduledDate: App.todayStr(),
      reminderDaysBefore: [], lastCompletedDate: null,
      createdAt: App.nowISO(), modifiedAt: App.nowISO(),
    };
    data.scheduleItems.unshift(t);
    App.save('schedule', data);
    state.editingId = t.id;
    App.refresh();
  }

  function findTask(id) {
    return (App.load('schedule').scheduleItems || []).find(function (t) { return t.id === id; });
  }
  function patchTask(id, fields) {
    var data = App.load('schedule');
    var t = (data.scheduleItems || []).find(function (x) { return x.id === id; });
    if (!t) return;
    Object.assign(t, fields, { modifiedAt: App.nowISO() });
    App.save('schedule', data);
  }

  function renderEditor(host) {
    var t = findTask(state.editingId);
    if (!t) { state.editingId = null; renderList(host); return; }

    var head = App.topbar('Tasks', function () {
      App.recordBack(function () { state.editingId = null; App.refresh(); });
    });
    host.appendChild(head);

    var form = App.el('<div class="form"></div>');

    var f1 = App.field('Task');
    var titleEl = App.el('<input class="field-input" type="text" placeholder="What needs doing?" />');
    titleEl.value = t.title || '';
    titleEl.addEventListener('input', App.debounce(function () {
      patchTask(t.id, { title: titleEl.value });
    }, 450));
    f1.appendChild(titleEl);
    form.appendChild(f1);

    var fDesc = App.field('Notes (optional)');
    var descEl = App.el('<textarea class="field-input" rows="2" placeholder="Add details"></textarea>');
    descEl.value = t.description || '';
    descEl.addEventListener('input', App.debounce(function () {
      patchTask(t.id, { description: descEl.value });
    }, 450));
    fDesc.appendChild(descEl);
    form.appendChild(fDesc);

    // Repeat — full set, matching the desktop. Changing it re-renders so the
    // dependent control (date / weekday / day picker) follows.
    var REPEATS = ['none', 'daily', 'weekdays', 'weekly', 'monthly', 'annually', 'custom'];
    var repeat = REPEATS.indexOf(t.repeat) >= 0 ? t.repeat : 'none';
    var f2 = App.field('Repeat');
    f2.appendChild(App.select(
      [['none', 'Once'], ['daily', 'Every day'], ['weekdays', 'Weekdays'],
        ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['annually', 'Annually'],
        ['custom', 'Custom days']],
      repeat,
      function (v) {
        var patch = { repeat: v };
        // Seed a weekday so a weekly task actually fires (desktop defaults to Sunday).
        if (v === 'weekly' && (t.dayOfWeek === null || t.dayOfWeek === undefined)) patch.dayOfWeek = 0;
        patchTask(t.id, patch);
        App.refresh();
      }
    ));
    form.appendChild(f2);

    // Date — for one-time, monthly (day-of-month), and annual (month + day).
    if (repeat === 'none' || repeat === 'monthly' || repeat === 'annually') {
      var dLabel = repeat === 'monthly' ? 'Day of month'
        : repeat === 'annually' ? 'Date each year' : 'Date';
      var fDate = App.field(dLabel);
      var dateEl = App.el('<input class="field-input" type="date" />');
      dateEl.value = t.scheduledDate || App.todayStr();
      dateEl.addEventListener('change', function () { patchTask(t.id, { scheduledDate: dateEl.value }); });
      fDate.appendChild(dateEl);
      form.appendChild(fDate);
    }

    // Weekly — a single weekday.
    if (repeat === 'weekly') {
      var fDow = App.field('Day of week');
      fDow.appendChild(App.select(
        [['0', 'Sunday'], ['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'],
          ['4', 'Thursday'], ['5', 'Friday'], ['6', 'Saturday']],
        String(t.dayOfWeek || 0),
        function (v) { patchTask(t.id, { dayOfWeek: parseInt(v, 10) }); }
      ));
      form.appendChild(fDow);
    }

    // Custom — any set of weekdays.
    if (repeat === 'custom') {
      var fDays = App.field('On these days');
      fDays.appendChild(App.dayPicker(t.repeatDays || [], function (days) {
        patchTask(t.id, { repeatDays: days });
      }));
      form.appendChild(fDays);
    }

    var f3 = App.field('Time (optional)');
    var timeEl = App.el('<input class="field-input" type="time" />');
    timeEl.value = t.startTime || '';
    timeEl.addEventListener('change', function () { patchTask(t.id, { startTime: timeEl.value }); });
    f3.appendChild(timeEl);
    form.appendChild(f3);

    var fNotify = App.field('Notify');
    fNotify.appendChild(App.select(
      [['0', 'At start time'], ['5', '5 min before'], ['10', '10 min before'],
        ['15', '15 min before'], ['30', '30 min before']],
      String(t.notifyBefore || 0),
      function (v) { patchTask(t.id, { notifyBefore: parseInt(v, 10) }); }
    ));
    form.appendChild(fNotify);

    // Advance reminders — only meaningful for one-time tasks (same as desktop).
    if (repeat === 'none') {
      var fRem = App.field('Advance reminders');
      fRem.appendChild(App.chips(
        [[1, '1 day'], [2, '2 days'], [3, '3 days'], [5, '5 days'], [7, '1 week']],
        (t.reminderDaysBefore || []).slice(),
        function (days) {
          patchTask(t.id, { reminderDaysBefore: days.slice().sort(function (a, b) { return b - a; }) });
        }
      ));
      form.appendChild(fRem);
    }

    var del = App.el('<button class="danger-btn" type="button">Delete task</button>');
    del.addEventListener('click', function () { remove(t.id); });
    form.appendChild(del);

    host.appendChild(form);
    if (!t.title) setTimeout(function () { titleEl.focus(); }, 60);
  }

  function remove(id) {
    if (!window.confirm('Delete this task?')) return;
    var data = App.load('schedule');
    data.scheduleItems = (data.scheduleItems || []).filter(function (t) { return t.id !== id; });
    App.save('schedule', data);
    state.editingId = null;
    App.refresh();
  }

  App.registerScreen('tasks', {
    label: 'Tasks', icon: ICON, render: render, reset: reset,
    create: createTask,
    openId: function (id) { state.editingId = id; App.rerender(); },
  });
})();
