/* Anjadhe Mobile — Journal. Dated entries with a mood and a reflective editor. */
(function () {
  var ICON = '<svg class="tab-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M12 6.6C10 5.3 7.5 4.6 4.6 4.6v13c2.9 0 5.4.7 7.4 2 2-1.3 4.5-2 7.4-2v-13c-2.9 0-5.4.7-7.4 2z"/>'
    + '<path d="M12 6.6v13"/></svg>';

  var MOODS = ['great', 'good', 'okay', 'low', 'rough'];
  var state = { editingId: null };

  function reset() { state.editingId = null; }
  function render(host) { state.editingId ? renderEditor(host) : renderList(host); }

  function renderList(host) {
    var entries = App.load('journal').entries || [];

    host.appendChild(App.topbar(App.backTitle(), function () { App.back(); }));

    var head = App.el('<header class="screen-head"></header>');
    head.style.setProperty('--i', 0);
    head.innerHTML = '<h1 class="screen-title">Journal</h1>'
      + '<p class="screen-sub">' + entries.length + (entries.length === 1 ? ' entry' : ' entries') + '</p>';
    host.appendChild(head);

    var sec = App.el('<section class="section"></section>');
    sec.style.setProperty('--i', 1);

    if (!entries.length) {
      sec.appendChild(App.el('<p class="empty">No entries yet. Tap + to begin.</p>'));
    } else {
      var sorted = entries.slice().sort(function (a, b) {
        return (b.date || b.createdAt || '').localeCompare(a.date || a.createdAt || '');
      });
      var list = App.el('<div class="card list"></div>');
      sorted.forEach(function (e) {
        var row = App.el('<button class="row" type="button"></button>');
        row.innerHTML = '<span class="row-main">'
          + '<span class="row-title">' + App.esc(App.relDate(e.date || e.createdAt) || 'Entry') + '</span>'
          + '<span class="row-sub">' + App.esc(App.plainText(e.content, 76) || 'Empty entry') + '</span>'
          + '</span>'
          + (e.mood ? '<span class="pill">' + App.esc(e.mood) + '</span>' : '');
        row.addEventListener('click', function () { state.editingId = e.id; App.refresh(); });
        list.appendChild(row);
      });
      sec.appendChild(list);
    }
    host.appendChild(sec);
    host.appendChild(App.fab(App.icons.plus, createEntry));
  }

  function createEntry() {
    var data = App.load('journal');
    data.entries = data.entries || [];
    var entry = {
      id: App.newId(), content: '', mood: '', tags: [],
      date: App.nowISO(), createdAt: App.nowISO(), modifiedAt: App.nowISO(),
    };
    data.entries.unshift(entry);
    App.save('journal', data);
    state.editingId = entry.id;
    App.refresh();
  }

  function findEntry(id) {
    return (App.load('journal').entries || []).find(function (e) { return e.id === id; });
  }
  function patchEntry(id, fields) {
    var data = App.load('journal');
    var entry = (data.entries || []).find(function (x) { return x.id === id; });
    if (!entry) return;
    Object.assign(entry, fields, { modifiedAt: App.nowISO() });
    App.save('journal', data);
  }

  function renderEditor(host) {
    var entry = findEntry(state.editingId);
    if (!entry) { state.editingId = null; renderList(host); return; }

    var del = App.el('<button class="icon-btn" type="button" aria-label="Delete"></button>');
    del.innerHTML = App.icons.trash;
    del.addEventListener('click', function () { deleteEntry(entry.id); });

    var head = App.topbar('Journal', function () {
      App.recordBack(function () { state.editingId = null; App.refresh(); });
    }, [del]);
    host.appendChild(head);

    var when = new Date(entry.date || entry.createdAt);
    var dateLine = App.el('<p class="screen-sub" style="margin:-6px 0 14px 2px;"></p>');
    dateLine.textContent = isNaN(when.getTime()) ? '' : when.toLocaleDateString(undefined, {
      weekday: 'long', month: 'long', day: 'numeric',
    });
    host.appendChild(dateLine);

    var moodRow = App.el('<div class="mood-row"></div>');
    MOODS.forEach(function (m) {
      var chip = App.el('<button class="mood' + (entry.mood === m ? ' on' : '') + '" type="button"></button>');
      chip.textContent = m;
      chip.addEventListener('click', function () {
        patchEntry(entry.id, { mood: entry.mood === m ? '' : m });
        App.refresh();
      });
      moodRow.appendChild(chip);
    });
    host.appendChild(moodRow);

    var editor = App.el('<div class="editor rich-editor"></div>');
    // Rich body — edits the stored HTML directly so formatting renders and
    // round-trips with the desktop.
    var bodyEl = App.richEditor(entry.content, function (html) {
      patchEntry(entry.id, { content: App.sanitizeHtml(html) });
    }, 'How was today?');
    head.appendChild(App.formatToolbar(bodyEl));
    editor.appendChild(bodyEl);
    host.appendChild(editor);

    if (!entry.content) setTimeout(function () { bodyEl.focus(); App.caretToEnd(bodyEl); }, 60);
  }

  function deleteEntry(id) {
    if (!window.confirm('Delete this entry?')) return;
    var data = App.load('journal');
    data.entries = (data.entries || []).filter(function (e) { return e.id !== id; });
    App.save('journal', data);
    state.editingId = null;
    App.refresh();
  }

  App.registerScreen('journal', {
    label: 'Journal', icon: ICON, render: render, reset: reset,
    create: createEntry,
    openId: function (id) { state.editingId = id; App.rerender(); },
  });
})();
