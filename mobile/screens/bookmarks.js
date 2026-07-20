/* Anjadhe Mobile — Bookmarks. Your saved links; tapping one opens it in
   the system browser. Add, edit, and delete links here too — all synced. */
(function () {
  var ICON = '<svg class="tab-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
    + '<circle cx="12" cy="12" r="8.6"/>'
    + '<path d="M3.5 12h17M12 3.4c2.6 2.5 2.6 14.7 0 17.2M12 3.4c-2.6 2.5-2.6 14.7 0 17.2"/></svg>';

  var EDIT = '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M14.5 5.5l4 4M4 20l1-4L16 5a2.1 2.1 0 0 1 3 3L8 19z"/></svg>';

  var state = { editingId: null };
  function reset() { state.editingId = null; }
  function render(host) { state.editingId ? renderEditor(host) : renderList(host); }

  function domain(url) {
    try {
      var u = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : 'https://' + url;
      return new URL(u).hostname.replace(/^www\./, '');
    } catch (e) { return ''; }
  }

  function renderList(host) {
    var bookmarks = App.load('bookmarks').bookmarks || [];
    host.appendChild(App.topbar(App.backTitle(), function () { App.back(); }));

    var head = App.el('<header class="screen-head"></header>');
    head.style.setProperty('--i', 0);
    head.innerHTML = '<h1 class="screen-title">Bookmarks</h1>'
      + '<p class="screen-sub">' + bookmarks.length
      + (bookmarks.length === 1 ? ' link' : ' links') + '</p>';
    host.appendChild(head);

    var sec = App.el('<section class="section"></section>');
    sec.style.setProperty('--i', 1);

    if (!bookmarks.length) {
      sec.appendChild(App.el('<p class="empty">No bookmarks yet. Tap + to add one.</p>'));
    } else {
      var sorted = bookmarks.slice().sort(function (a, b) {
        return (b.modifiedAt || b.createdAt || '').localeCompare(a.modifiedAt || a.createdAt || '');
      });
      var list = App.el('<div class="card list"></div>');
      sorted.forEach(function (b) { list.appendChild(bookmarkRow(b)); });
      sec.appendChild(list);
    }
    host.appendChild(sec);
    host.appendChild(App.fab(App.icons.plus, createBookmark));
  }

  function bookmarkRow(b) {
    var row = App.el('<div class="row split"></div>');
    var dom = domain(b.url);

    var fav = App.el('<span class="bm-fav"></span>');
    if (dom) {
      var img = document.createElement('img');
      img.src = 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(dom) + '&sz=64';
      img.alt = '';
      img.addEventListener('error', function () { img.remove(); });
      fav.appendChild(img);
    }

    var main = App.el('<button class="row-main" type="button"></button>');
    main.innerHTML = '<span class="row-title">' + App.esc(b.title || dom || 'Untitled') + '</span>'
      + '<span class="row-sub">' + App.esc(dom || b.url || 'No URL') + '</span>';
    main.addEventListener('click', function () {
      if (b.url) App.openExternal(b.url);
      else { state.editingId = b.id; App.refresh(); }
    });

    var edit = App.el('<button class="icon-btn" type="button" aria-label="Edit bookmark"></button>');
    edit.innerHTML = EDIT;
    edit.addEventListener('click', function () { state.editingId = b.id; App.refresh(); });

    row.appendChild(fav);
    row.appendChild(main);
    row.appendChild(edit);
    return row;
  }

  function createBookmark() {
    var data = App.load('bookmarks');
    data.bookmarks = data.bookmarks || [];
    var b = {
      id: App.newId(), title: '', url: '', description: '',
      group: null, notes: '', tags: [],
      createdAt: App.nowISO(), modifiedAt: App.nowISO(),
    };
    data.bookmarks.unshift(b);
    App.save('bookmarks', data);
    state.editingId = b.id;
    App.refresh();
  }

  function findBookmark(id) {
    return (App.load('bookmarks').bookmarks || []).find(function (b) { return b.id === id; });
  }
  function patchBookmark(id, fields) {
    var data = App.load('bookmarks');
    var b = (data.bookmarks || []).find(function (x) { return x.id === id; });
    if (!b) return;
    Object.assign(b, fields, { modifiedAt: App.nowISO() });
    App.save('bookmarks', data);
  }

  function renderEditor(host) {
    var b = findBookmark(state.editingId);
    if (!b) { state.editingId = null; renderList(host); return; }

    var head = App.topbar('Bookmarks', function () {
      App.recordBack(function () { state.editingId = null; App.refresh(); });
    });
    host.appendChild(head);

    var form = App.el('<div class="form"></div>');

    var f1 = App.field('Title');
    var titleEl = App.el('<input class="field-input" type="text" placeholder="Link title" />');
    titleEl.value = b.title || '';
    titleEl.addEventListener('input', App.debounce(function () {
      patchBookmark(b.id, { title: titleEl.value.trim() });
    }, 450));
    f1.appendChild(titleEl);
    form.appendChild(f1);

    var f2 = App.field('URL');
    var urlEl = App.el('<input class="field-input" type="url" inputmode="url" '
      + 'autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="https://" />');
    urlEl.value = b.url || '';
    urlEl.addEventListener('input', App.debounce(function () {
      patchBookmark(b.id, { url: urlEl.value.trim() });
    }, 450));
    f2.appendChild(urlEl);
    form.appendChild(f2);

    var f3 = App.field('Description');
    var descEl = App.el('<textarea class="field-input" rows="3" placeholder="Optional note"></textarea>');
    descEl.value = b.description || '';
    descEl.addEventListener('input', App.debounce(function () {
      patchBookmark(b.id, { description: descEl.value.trim() });
    }, 450));
    f3.appendChild(descEl);
    form.appendChild(f3);

    var open = App.el('<button class="btn-primary" type="button">Open link</button>');
    open.addEventListener('click', function () {
      var url = urlEl.value.trim();
      if (url) App.openExternal(url);
      else { App.toast('Add a URL first'); urlEl.focus(); }
    });
    form.appendChild(open);

    var del = App.el('<button class="danger-btn" type="button">Delete bookmark</button>');
    del.addEventListener('click', function () {
      if (!window.confirm('Delete this bookmark?')) return;
      var data = App.load('bookmarks');
      data.bookmarks = (data.bookmarks || []).filter(function (x) { return x.id !== b.id; });
      App.save('bookmarks', data);
      state.editingId = null;
      App.refresh();
    });
    form.appendChild(del);

    host.appendChild(form);
    if (!b.url && !b.title) setTimeout(function () { urlEl.focus(); }, 60);
  }

  App.registerScreen('bookmarks', {
    label: 'Bookmarks', icon: ICON, render: render, reset: reset,
    create: createBookmark,
    openId: function (id) { state.editingId = id; App.rerender(); },
  });
})();
