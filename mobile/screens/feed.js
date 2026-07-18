/* Anjadhe Mobile — Feed. A read-only view of the Prompt Feed: outputs your
   scheduled prompts generated on your Mac's local model, synced to the phone.
   Generation needs the local model, so it stays on the Mac — the phone only
   reads the synced `promptFeed` blob. */
(function () {
  var ICON = '<svg class="tab-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
    + '<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2.6"/>'
    + '<path d="M7 9h10M7 12.5h10M7 16h6"/></svg>';

  var COPY = '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<rect x="8.5" y="8.5" width="11" height="11" rx="2.3"/>'
    + '<path d="M15.5 8.5V6.2A2.2 2.2 0 0 0 13.3 4H6.2A2.2 2.2 0 0 0 4 6.2v7.1'
    + 'A2.2 2.2 0 0 0 6.2 15.5h2.3"/></svg>';

  var state = { openId: null };
  function reset() { state.openId = null; }
  function render(host) { state.openId ? renderDetail(host) : renderList(host); }

  function items() {
    return (App.load('promptFeed').items || []).slice().sort(function (a, b) {
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });
  }
  function findItem(id) {
    return (App.load('promptFeed').items || []).find(function (x) { return x.id === id; });
  }

  function meta(it) {
    var when = it.createdAt ? App.relDate(it.createdAt) : '';
    return [when, it.model].filter(Boolean).map(App.esc).join(' · ');
  }

  function renderList(host) {
    var feed = items();
    host.appendChild(App.topbar(App.backTitle(), function () { App.back(); }));

    var head = App.el('<header class="screen-head"></header>');
    head.style.setProperty('--i', 0);
    head.innerHTML = '<h1 class="screen-title">Feed</h1>'
      + '<p class="screen-sub">Scheduled prompt results from your Mac</p>';
    host.appendChild(head);

    var sec = App.el('<section class="section"></section>');
    sec.style.setProperty('--i', 1);

    if (!feed.length) {
      sec.appendChild(App.el('<p class="empty">No feed entries yet. Scheduled '
        + 'prompts run on your Mac and their results appear here.</p>'));
      host.appendChild(sec);
      return;
    }

    feed.forEach(function (it) {
      sec.appendChild(card(it));
    });
    host.appendChild(sec);
  }

  function card(it) {
    var c = App.el('<article class="feed-card"></article>');
    c.innerHTML = '<div class="feed-card-head">'
      + '<span class="feed-card-title">' + App.esc(it.promptTitle || 'Untitled prompt') + '</span>'
      + '<span class="feed-card-meta">' + meta(it) + '</span>'
      + '</div>';
    if (it.error) {
      c.classList.add('feed-card--error');
      c.appendChild(App.el('<div class="feed-card-error">' + App.esc(it.error) + '</div>'));
      return c;
    }
    // Render markdown the same way the Mac does; clamp the preview and open
    // the full post on tap. Links open externally rather than navigating.
    var body = App.el('<div class="feed-card-body feed-card-body--clamped"></div>');
    body.innerHTML = App.formatContent(it.content || '') || '<p>Empty response</p>';
    c.appendChild(body);
    c.classList.add('feed-card--tap');
    c.addEventListener('click', function (e) {
      var a = e.target.closest('a');
      if (a) { e.preventDefault(); App.openExternal(a.getAttribute('href')); return; }
      state.openId = it.id; App.refresh();
    });
    return c;
  }

  function renderDetail(host) {
    var it = findItem(state.openId);
    if (!it) { state.openId = null; renderList(host); return; }

    var copy = App.el('<button class="icon-btn" type="button" aria-label="Copy"></button>');
    copy.innerHTML = COPY;
    copy.addEventListener('click', function () { App.copy(it.content || ''); });

    var head = App.topbar('Feed', function () {
      App.recordBack(function () { state.openId = null; App.refresh(); });
    }, [copy]);
    host.appendChild(head);

    var wrap = App.el('<div class="feed-post"></div>');
    wrap.innerHTML = '<h1 class="feed-post-title">' + App.esc(it.promptTitle || 'Untitled prompt') + '</h1>'
      + '<p class="feed-post-meta">' + meta(it) + '</p>';
    var bodyEl = App.el('<div class="feed-post-body"></div>');
    bodyEl.innerHTML = App.formatContent(it.content || '');
    bodyEl.addEventListener('click', function (e) {
      var a = e.target.closest('a');
      if (a) { e.preventDefault(); App.openExternal(a.getAttribute('href')); }
    });
    wrap.appendChild(bodyEl);
    host.appendChild(wrap);
  }

  App.registerScreen('feed', {
    label: 'Feed', icon: ICON, render: render, reset: reset,
    openId: function (id) { state.openId = id; App.rerender(); },
  });
})();
