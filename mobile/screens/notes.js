/* Anjadhe Mobile — Notes. A list of notes and a minimal writing editor. */
(function () {
  var ICON = '<svg class="tab-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M7 3.4h7l5 5v12.2H7z"/><path d="M14 3.4V8.4h5"/>'
    + '<path d="M10 12.6h6M10 16h4.5"/></svg>';

  var state = { editingId: null };

  function reset() { state.editingId = null; }

  function render(host) {
    if (state.editingId) renderEditor(host);
    else renderList(host);
  }

  // ---- list ----
  function renderList(host) {
    var notes = App.load('notes').notes || [];

    host.appendChild(App.topbar(App.backTitle(), function () { App.back(); }));

    var head = App.el('<header class="screen-head"></header>');
    head.style.setProperty('--i', 0);
    head.innerHTML = '<h1 class="screen-title">Notes</h1>'
      + '<p class="screen-sub">' + notes.length + (notes.length === 1 ? ' note' : ' notes') + '</p>';
    host.appendChild(head);

    var sec = App.el('<section class="section"></section>');
    sec.style.setProperty('--i', 1);

    if (!notes.length) {
      sec.appendChild(App.el('<p class="empty">No notes yet. Tap + to write one.</p>'));
    } else {
      var sorted = notes.slice().sort(function (a, b) {
        if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
        return (b.modifiedAt || '').localeCompare(a.modifiedAt || '');
      });
      var list = App.el('<div class="card list"></div>');
      sorted.forEach(function (n) {
        var star = n.pinned ? '<span class="row-star">' + App.icons.starFilled + '</span>' : '';
        var row = App.el('<button class="row" type="button"></button>');
        row.innerHTML = '<span class="row-main">'
          + '<span class="row-title">' + star + App.esc(n.title || 'Untitled') + '</span>'
          + '<span class="row-sub">' + App.esc(App.plainText(n.content, 72) || 'Empty note') + '</span>'
          + '</span>'
          + '<span class="row-time">' + App.esc(App.relDate(n.modifiedAt)) + '</span>';
        row.addEventListener('click', function () { state.editingId = n.id; App.refresh(); });
        list.appendChild(row);
      });
      sec.appendChild(list);
    }
    host.appendChild(sec);
    host.appendChild(App.fab(App.icons.plus, createNote));
  }

  function createNote() {
    var data = App.load('notes');
    data.notes = data.notes || [];
    var note = {
      id: App.newId(), title: '', content: '', tags: [], pinned: false,
      createdAt: App.nowISO(), modifiedAt: App.nowISO(),
    };
    data.notes.unshift(note);
    App.save('notes', data);
    state.editingId = note.id;
    App.refresh();
  }

  // ---- editor ----
  function findNote(id) {
    return (App.load('notes').notes || []).find(function (n) { return n.id === id; });
  }
  function patchNote(id, fields) {
    var data = App.load('notes');
    var note = (data.notes || []).find(function (x) { return x.id === id; });
    if (!note) return;
    Object.assign(note, fields, { modifiedAt: App.nowISO() });
    App.save('notes', data);
  }

  function renderEditor(host) {
    var note = findNote(state.editingId);
    if (!note) { state.editingId = null; renderList(host); return; }

    var pin = App.el('<button class="icon-btn' + (note.pinned ? ' starred' : '')
      + '" type="button" aria-label="Pin"></button>');
    pin.innerHTML = note.pinned ? App.icons.starFilled : App.icons.starOutline;
    pin.addEventListener('click', function () {
      patchNote(note.id, { pinned: !note.pinned });
      App.refresh();
    });
    var del = App.el('<button class="icon-btn" type="button" aria-label="Delete"></button>');
    del.innerHTML = App.icons.trash;
    del.addEventListener('click', function () { deleteNote(note.id); });

    var head = App.topbar('Notes', function () {
      App.recordBack(function () { state.editingId = null; App.refresh(); });
    }, [pin, del]);

    var editor = App.el('<div class="editor rich-editor"></div>');
    var titleEl = App.el('<input class="editor-title" type="text" placeholder="Title" />');
    titleEl.value = note.title || '';
    var saveTitle = App.debounce(function () { patchNote(note.id, { title: titleEl.value }); }, 500);
    titleEl.addEventListener('input', saveTitle);

    // Rich body — edits the stored HTML directly, so desktop formatting is
    // rendered and preserved (no plain-text round-trip).
    var bodyEl = App.richEditor(note.content, function (html) {
      patchNote(note.id, { content: App.sanitizeHtml(html) });
    }, 'Write…');

    // Formatting toolbar lives in the sticky header so it stays reachable.
    head.appendChild(App.formatToolbar(bodyEl));
    host.appendChild(head);

    editor.appendChild(titleEl);
    editor.appendChild(bodyEl);
    host.appendChild(editor);

    if (!note.title && !note.content) {
      setTimeout(function () { titleEl.focus(); }, 60);
    }
  }

  function deleteNote(id) {
    if (!window.confirm('Delete this note?')) return;
    var data = App.load('notes');
    data.notes = (data.notes || []).filter(function (n) { return n.id !== id; });
    App.save('notes', data);
    state.editingId = null;
    App.refresh();
  }

  App.registerScreen('notes', {
    label: 'Notes', icon: ICON, render: render, reset: reset,
    create: createNote,
    openId: function (id) { state.editingId = id; App.rerender(); },
  });
})();
