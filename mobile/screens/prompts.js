/* Anjadhe Mobile — Prompts. A synced library of reusable prompts:
   browse, read, copy to the clipboard, and edit. */
(function () {
  var ICON = '<svg class="tab-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
    + '<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2.6"/>'
    + '<path d="M7.6 9.4l3 2.6-3 2.6M12.8 14.6h4.4"/></svg>';

  var COPY = '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<rect x="8.5" y="8.5" width="11" height="11" rx="2.3"/>'
    + '<path d="M15.5 8.5V6.2A2.2 2.2 0 0 0 13.3 4H6.2A2.2 2.2 0 0 0 4 6.2v7.1'
    + 'A2.2 2.2 0 0 0 6.2 15.5h2.3"/></svg>';

  var state = { editingId: null };
  function reset() { state.editingId = null; }
  function render(host) { state.editingId ? renderEditor(host) : renderList(host); }

  function renderList(host) {
    var prompts = App.load('prompts').prompts || [];
    host.appendChild(App.topbar(App.backTitle(), function () { App.back(); }));

    var head = App.el('<header class="screen-head"></header>');
    head.style.setProperty('--i', 0);
    head.innerHTML = '<h1 class="screen-title">Prompts</h1>'
      + '<p class="screen-sub">' + prompts.length
      + (prompts.length === 1 ? ' prompt' : ' prompts') + '</p>';
    host.appendChild(head);

    var sec = App.el('<section class="section"></section>');
    sec.style.setProperty('--i', 1);

    if (!prompts.length) {
      sec.appendChild(App.el('<p class="empty">No prompts yet. Tap + to add one.</p>'));
    } else {
      var sorted = prompts.slice().sort(function (a, b) {
        return (b.modifiedAt || b.createdAt || '').localeCompare(a.modifiedAt || a.createdAt || '');
      });
      var list = App.el('<div class="card list"></div>');
      sorted.forEach(function (p) {
        var row = App.el('<div class="row split"></div>');
        var main = App.el('<button class="row-main" type="button"></button>');
        main.innerHTML = '<span class="row-title">' + App.esc(p.title || 'Untitled') + '</span>'
          + '<span class="row-sub">' + App.esc(App.plainText(p.body, 72) || 'Empty prompt') + '</span>';
        main.addEventListener('click', function () { state.editingId = p.id; App.refresh(); });
        var copy = App.el('<button class="icon-btn" type="button" aria-label="Copy prompt"></button>');
        copy.innerHTML = COPY;
        copy.addEventListener('click', function () { App.copy(p.body || ''); });
        row.appendChild(main);
        row.appendChild(copy);
        list.appendChild(row);
      });
      sec.appendChild(list);
    }
    host.appendChild(sec);
    host.appendChild(App.fab(App.icons.plus, createPrompt));
  }

  function createPrompt() {
    var data = App.load('prompts');
    data.prompts = data.prompts || [];
    var p = {
      id: App.newId(), title: '', body: '', tags: [],
      createdAt: App.nowISO(), modifiedAt: App.nowISO(),
    };
    data.prompts.unshift(p);
    App.save('prompts', data);
    state.editingId = p.id;
    App.refresh();
  }

  function findPrompt(id) {
    return (App.load('prompts').prompts || []).find(function (p) { return p.id === id; });
  }
  function patchPrompt(id, fields) {
    var data = App.load('prompts');
    var p = (data.prompts || []).find(function (x) { return x.id === id; });
    if (!p) return;
    Object.assign(p, fields, { modifiedAt: App.nowISO() });
    App.save('prompts', data);
  }

  function renderEditor(host) {
    var p = findPrompt(state.editingId);
    if (!p) { state.editingId = null; renderList(host); return; }

    var copy = App.el('<button class="icon-btn" type="button" aria-label="Copy prompt"></button>');
    copy.innerHTML = COPY;
    var del = App.el('<button class="icon-btn" type="button" aria-label="Delete"></button>');
    del.innerHTML = App.icons.trash;
    del.addEventListener('click', function () { removePrompt(p.id); });

    var head = App.topbar('Prompts', function () {
      App.recordBack(function () { state.editingId = null; App.refresh(); });
    }, [copy, del]);
    host.appendChild(head);

    var editor = App.el('<div class="editor"></div>');
    var titleEl = App.el('<input class="editor-title" type="text" placeholder="Prompt title" />');
    titleEl.value = p.title || '';
    var bodyEl = App.el('<textarea class="editor-body" placeholder="Write the prompt…"></textarea>');
    bodyEl.value = p.body || '';

    copy.addEventListener('click', function () { App.copy(bodyEl.value); });

    var save = App.debounce(function () {
      patchPrompt(p.id, { title: titleEl.value, body: bodyEl.value });
    }, 500);
    titleEl.addEventListener('input', save);
    bodyEl.addEventListener('input', save);

    editor.appendChild(titleEl);
    editor.appendChild(bodyEl);
    host.appendChild(editor);

    if (!p.title && !p.body) setTimeout(function () { titleEl.focus(); }, 60);
  }

  function removePrompt(id) {
    if (!window.confirm('Delete this prompt?')) return;
    var data = App.load('prompts');
    data.prompts = (data.prompts || []).filter(function (p) { return p.id !== id; });
    App.save('prompts', data);
    state.editingId = null;
    App.refresh();
  }

  App.registerScreen('prompts', { label: 'Prompts', icon: ICON, render: render, reset: reset });
})();
