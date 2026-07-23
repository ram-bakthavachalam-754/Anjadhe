/* ============================================================
   Anjadhe Mobile — core
   Data helpers, screen router, bottom-tab navigation, shared
   helpers. Sits on StorageManager (synced data).
   ============================================================ */
const App = {
  screens: {},
  // Function-bar navigation: the bottom bar holds VERBS (Today · Apps · ＋ ·
  // Search), not apps, so it never grows. Roots have no back bar; opening an
  // app or record pushes a screen with a sticky top bar while the function
  // bar stays put. `apps` is the launcher grid order.
  roots: ['today', 'apps', 'search'],
  apps: ['tasks', 'notes', 'journal', 'calendar', 'prompts', 'feed', 'bookmarks'],
  current: null,
  _returnTo: null, // which root a pushed screen returns to

  // --- data (read/written through StorageManager; sync handles the rest) ---
  load(appName) { return StorageManager.get(appName) || {}; },
  save(appName, data) { StorageManager.set(appName, data); },

  // --- screens / routing ---
  registerScreen(id, def) { this.screens[id] = Object.assign({ id: id }, def); },

  _goto(id, keepState) {
    const s = this.screens[id];
    if (!s) return;
    this.current = id;
    // Any plain navigation clears a pending deep-link return; openDetail()
    // re-sets it immediately after its own open() call.
    this._detailReturn = null;
    if (!keepState && typeof s.reset === 'function') s.reset(); // a fresh open returns to the root
    this._render();
  },
  // A function-bar tap: switch to a root, no back stack.
  root(id) { this._returnTo = null; this._goto(id); },
  // Push an app/record screen; remember the root to return to.
  open(id) {
    if (this.roots.indexOf(this.current) >= 0) this._returnTo = this.current;
    this._goto(id);
  },
  // Open a record's editor directly (deep link from Today / Calendar / Search),
  // remembering the screen we came from so the editor's Back returns straight
  // there instead of dropping onto the target app's own list.
  openDetail(appId, id) {
    const origin = this.current;
    this.open(appId);
    this._detailReturn = origin;
    const s = this.screens[appId];
    if (s && typeof s.openId === 'function') s.openId(id);
  },
  // Editor Back: if we deep-linked in, pop straight to the origin (preserving
  // that screen's state — e.g. the calendar's selected day); otherwise run the
  // screen's own "return to list" fallback.
  recordBack(showList) {
    if (this._detailReturn) {
      const to = this._detailReturn;
      this._detailReturn = null;
      this._goto(to, true);
    } else if (typeof showList === 'function') {
      showList();
    }
  },
  // Pop back to the root the current screen was opened from.
  back() { const to = this._returnTo || 'today'; this._returnTo = null; this._goto(to); },
  // Label for an app list's back button — the root it was opened from.
  backTitle() {
    const r = this._returnTo;
    return (r && this.screens[r] && this.screens[r].label) || 'Today';
  },
  // Back-compat entry: routes roots to root(), everything else to open().
  go(id) { (this.roots.indexOf(id) >= 0) ? this.root(id) : this.open(id); },
  // Force an immediate re-render of the current screen, bypassing the
  // touch-in-flight guard that refresh() uses. For USER-INITIATED navigation
  // (e.g. opening a record from Today/Search) the rebuild is intentional, so
  // it must happen now — deferring it lets the intermediate screen paint for
  // ~80ms first (a wrong record flashes "touched" before the editor opens).
  rerender() { if (this.current) this._render(); },
  refresh() {
    // Re-renders blow away the screen DOM under the user's finger if they
    // arrive mid-tap (the screen content is rebuilt via innerHTML). Defer
    // any sync-driven refresh while a touch is in flight — by the time the
    // touch ends the user has either tapped (which calls go() itself) or
    // released, and 80ms later we catch up.
    if (this._touchActive) {
      this._pendingRefresh = true;
      return;
    }
    if (this.current) this._render();
  },
  _render() {
    const s = this.screens[this.current];
    if (!s) return;
    const host = document.getElementById('screen');
    host.innerHTML = '';
    host.scrollTop = 0;
    s.render(host);
    this._syncDetailMode(host);
    this._syncActiveNav();
  },

  // A screen is a "pushed view" (an app or record opened from a root) iff it
  // rendered a `.topbar` — the three roots don't. In that mode CSS pins the
  // top bar and slides the screen in like an iOS push. The function bar
  // stays visible throughout. Driven generically so screens stay simple.
  _syncDetailMode(host) {
    const app = document.getElementById('app');
    if (!app) return;
    const isDetail = !!host.querySelector('.topbar');
    const was = app.classList.contains('detail-mode');
    app.classList.toggle('detail-mode', isDetail);
    // Scope the flex-fill layout to screens that host a rich editor so the
    // editable area grows to fill the screen (no bottom dead-space) while
    // form/list screens keep normal block flow.
    app.classList.toggle('doc-editing', !!host.querySelector('.rich-editor'));
    // One-shot slide-in only when ENTERING a pushed view — not on the
    // in-detail App.refresh() that tasks/journal fire on edits.
    if (isDetail && !was) {
      app.classList.add('detail-entering');
      clearTimeout(this._detailEnterT);
      this._detailEnterT = setTimeout(() => app.classList.remove('detail-entering'), 320);
    } else if (!isDetail) {
      app.classList.remove('detail-entering');
    }
  },

  /**
   * Wire a tap handler. Modern WKWebView/Capacitor dispatches a `click`
   * immediately for single taps as long as the target has
   * `touch-action: manipulation` and the page is properly scaled (our
   * viewport sets user-scalable=no) — so the old FastClick-style custom
   * touch handler is unnecessary AND was the source of dropped taps (it
   * preventDefault'd touchend, raced the synthesized click, and fought the
   * touch guards). A plain click listener is simpler and reliable. Kept as
   * a named helper so call sites read intentfully.
   */
  _attachFastTap(el, handler) {
    el.addEventListener('click', handler);
  },

  start() {
    this._wireTouchGuards();
    this.initNavbar();
    this.root('today');
  },

  // The function bar — built once, lives across every screen. Holds verbs
  // (Today · Apps · ＋ · Search), not apps, so it never outgrows its slots.
  initNavbar() {
    const bar = document.getElementById('navbar');
    if (!bar) return;
    bar.innerHTML = '';
    const items = [
      { id: 'today',  label: 'Today',  icon: this.icons.today,  action: () => this.root('today') },
      { id: 'apps',   label: 'Apps',   icon: this.icons.grid,   action: () => this.root('apps') },
      { id: '__add',  label: '',       icon: this.icons.plus,   action: () => this.capture(), center: true },
      { id: 'search', label: 'Search', icon: this.icons.search, action: () => this.root('search') },
    ];
    items.forEach((it) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nav' + (it.center ? ' nav-add' : '');
      btn.dataset.navId = it.id;
      btn.innerHTML = it.center
        ? '<span class="nav-add-fab">' + it.icon + '</span>'
        : '<span class="nav-pill">' + it.icon + '<span class="nav-label">' + it.label + '</span></span>';
      // The whole cell is the tap target (large = easy to hit). children are
      // pointer-events:none so the tap always lands on the button.
      this._attachFastTap(btn, it.action);
      bar.appendChild(btn);
    });
  },
  // Highlight the active root. Inside a pushed app/record, light up the root
  // it was opened from (or Apps as a sensible default).
  _syncActiveNav() {
    const bar = document.getElementById('navbar');
    if (!bar) return;
    const active = this.roots.indexOf(this.current) >= 0
      ? this.current
      : (this._returnTo || 'apps');
    bar.querySelectorAll('.nav').forEach((b) => {
      b.classList.toggle('active', b.dataset.navId === active);
    });
  },

  // The ＋ capture sheet — quick-create into any app, then jump to its editor.
  capture() {
    this.sheet([
      ['New note', () => this._captureInto('notes')],
      ['New task', () => this._captureInto('tasks')],
      ['Journal entry', () => this._captureInto('journal')],
      ['Save link', () => this._captureInto('bookmarks')],
    ]);
  },
  _captureInto(appId) {
    this.open(appId);                     // renders the app list (reset clears any edit state)
    const s = this.screens[appId];
    if (s && typeof s.create === 'function') s.create();  // creates a record + opens its editor
  },
  // A bottom action sheet. `items` = [[label, fn], …].
  sheet(items, title) {
    const backdrop = this.el('<div class="sheet-backdrop"></div>');
    const sheet = this.el('<div class="sheet"></div>');
    sheet.appendChild(this.el('<div class="sheet-grip"></div>'));
    if (title) sheet.appendChild(this.el('<div class="sheet-title">' + this.esc(title) + '</div>'));
    const close = () => {
      backdrop.classList.remove('show');
      sheet.classList.remove('show');
      setTimeout(() => { backdrop.remove(); sheet.remove(); }, 220);
    };
    items.forEach((it) => {
      const b = this.el('<button class="sheet-item" type="button"></button>');
      b.textContent = it[0];
      b.addEventListener('click', () => { close(); it[1](); });
      sheet.appendChild(b);
    });
    backdrop.addEventListener('click', close);
    document.body.appendChild(backdrop);
    document.body.appendChild(sheet);
    requestAnimationFrame(() => { backdrop.classList.add('show'); sheet.classList.add('show'); });
  },

  // While the user has a finger down, we treat the UI as "in-use" so a
  // background sync-driven refresh does not yank the DOM out from under
  // them. The flag is cleared a few frames after touchend so any tap
  // that was already on the way still finds a stable tree.
  _touchActive: false,
  _pendingRefresh: false,
  _wireTouchGuards() {
    const flush = () => {
      // Slight delay so the click event that follows touchend lands on
      // the original button BEFORE any deferred refresh rebuilds DOM.
      setTimeout(() => {
        this._touchActive = false;
        if (this._pendingRefresh) {
          this._pendingRefresh = false;
          this.refresh();
        }
      }, 80);
    };
    document.addEventListener('touchstart', () => { this._touchActive = true; }, { capture: true, passive: true });
    document.addEventListener('touchend',   flush, { capture: true, passive: true });
    document.addEventListener('touchcancel', () => { this._touchActive = false; this._pendingRefresh = false; }, { capture: true, passive: true });
  },

  // --- DOM / string helpers ---
  el(html) {
    const d = document.createElement('div');
    d.innerHTML = html.trim();
    return d.firstElementChild;
  },
  esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));
  },
  plainText(html, max) {
    const t = String(html == null ? '' : html)
      .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ')
      .replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
    return (max && t.length > max) ? t.slice(0, max).trim() + '…' : t;
  },

  // --- markdown formatter (matches the desktop AgentUI.formatContent) ------
  // The prompt-feed content is model markdown; the Mac renders it through
  // AgentUI.formatContent. This is a faithful port (block + inline) so the
  // phone shows the SAME structure — paragraphs, headers, ordered/unordered
  // (nested) lists, tables, hr, bold/italic, inline code, and links. LaTeX
  // math is left as-is (rare in scheduled-prompt output; the desktop converts
  // it to Unicode — see _renderMath there if we ever need parity on that too).
  formatContent(text) {
    if (!text) return '';
    const escaped = String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const lines = escaped.split('\n');
    const out = [];
    const listStack = [];
    let textBuffer = [];
    const self = this;

    const flushText = () => {
      if (!textBuffer.length) return;
      out.push('<p>' + textBuffer.map((l) => self._formatInline(l)).join('<br>') + '</p>');
      textBuffer = [];
    };
    const closeTopLi = () => {
      const top = listStack[listStack.length - 1];
      if (top && top.hasOpenLi) { out.push('</li>'); top.hasOpenLi = false; }
    };
    const popList = () => {
      closeTopLi();
      const t = listStack.pop();
      if (t) out.push('</' + t.type + '>');
    };
    const closeAllLists = () => { while (listStack.length) popList(); };
    const openListItem = (indent, type, content) => {
      while (listStack.length && listStack[listStack.length - 1].indent > indent) popList();
      const top = listStack[listStack.length - 1];
      if (top && top.indent === indent) {
        if (top.type !== type) popList(); else closeTopLi();
      }
      const newTop = listStack[listStack.length - 1];
      if (!newTop || newTop.indent < indent) {
        out.push('<' + type + '>');
        listStack.push({ type: type, indent: indent, hasOpenLi: false });
      }
      out.push('<li>' + self._formatInline(content));
      listStack[listStack.length - 1].hasOpenLi = true;
    };

    const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
    const isTableSeparator = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
    const parseTableRow = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '') { flushText(); i++; continue; }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flushText(); closeAllLists(); out.push('<hr>'); i++; continue;
      }
      if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        flushText(); closeAllLists();
        const headerCells = parseTableRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && isTableRow(lines[i])) { rows.push(parseTableRow(lines[i])); i++; }
        let html = '<table><thead><tr>';
        headerCells.forEach((h) => { html += '<th>' + self._formatInline(h) + '</th>'; });
        html += '</tr></thead><tbody>';
        rows.forEach((row) => {
          html += '<tr>';
          row.forEach((c) => { html += '<td>' + self._formatInline(c) + '</td>'; });
          html += '</tr>';
        });
        html += '</tbody></table>';
        out.push(html);
        continue;
      }
      const hashHeader = line.match(/^(#{1,6})\s+(.+)$/);
      if (hashHeader) {
        flushText(); closeAllLists();
        const level = hashHeader[1].length;
        const tag = level <= 2 ? 'h3' : level === 3 ? 'h4' : 'h5';
        out.push('<' + tag + '>' + self._formatInline(hashHeader[2]) + '</' + tag + '>');
        i++; continue;
      }
      const boldHeader = line.match(/^\s*\*\*(.+?)\*\*\s*$/);
      if (boldHeader) {
        flushText(); closeAllLists();
        out.push('<h4>' + self._formatInline(boldHeader[1]) + '</h4>');
        i++; continue;
      }
      const ulMatch = line.match(/^(\s*)[-*]\s+(.*)$/);
      if (ulMatch) { flushText(); openListItem(ulMatch[1].length, 'ul', ulMatch[2]); i++; continue; }
      const olMatch = line.match(/^(\s*)\d+\.\s+(.*)$/);
      if (olMatch) { flushText(); openListItem(olMatch[1].length, 'ol', olMatch[2]); i++; continue; }
      closeAllLists();
      textBuffer.push(line);
      i++;
    }
    flushText();
    closeAllLists();
    return out.join('');
  },
  _formatInline(text) {
    const codeSpans = [];
    let out = text.replace(/`([^`]+)`/g, (_, body) => {
      const token = '\x00CODE' + codeSpans.length + '\x00';
      codeSpans.push('<code>' + body + '</code>');
      return token;
    });
    const linkPlaceholders = [];
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
      const safe = /^(https?:|mailto:)/i.test(url) ? url : '#';
      const token = '\x00LINK' + linkPlaceholders.length + '\x00';
      linkPlaceholders.push('<a href="' + safe + '">' + label + '</a>');
      return token;
    });
    out = out.replace(/https?:\/\/[^\s<]+/g, (url) => {
      const m = url.match(/^(.*?)([.,;:!?)\]]*)$/);
      return '<a href="' + m[1] + '">' + m[1] + '</a>' + m[2];
    });
    out = out
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>');
    out = out.replace(/\x00CODE(\d+)\x00/g, (_, idx) => codeSpans[+idx]);
    return out.replace(/\x00LINK(\d+)\x00/g, (_, idx) => linkPlaceholders[+idx]);
  },
  // HTML <-> plain text, so the mobile textarea editors round-trip with the
  // desktop's HTML content (rich formatting is not preserved — v1).
  htmlToText(html) {
    return String(html == null ? '' : html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/\n{3,}/g, '\n\n').trim();
  },
  textToHtml(text) {
    const parts = String(text == null ? '' : text).split(/\n{2,}/);
    return parts.map((p) => '<p>' + this.esc(p).replace(/\n/g, '<br>') + '</p>').join('');
  },
  newId() { return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); },
  nowISO() { return new Date().toISOString(); },
  debounce(fn, ms) {
    let t;
    return function () {
      const args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(ctx, args), ms);
    };
  },

  // a floating "create" button, fixed above the tab bar
  fab(icon, onClick) {
    const b = this.el('<button class="fab" type="button" aria-label="Create"></button>');
    b.innerHTML = icon;
    b.addEventListener('click', onClick);
    return b;
  },

  // The sticky top bar for any pushed screen (app list or record): a chevron
  // + back label on the left, optional action buttons on the right. CSS pins
  // it to the top and carries the safe-area inset. Marks the screen as a
  // pushed view (App._syncDetailMode looks for `.topbar`).
  topbar(label, onBack, actions) {
    const bar = this.el('<div class="topbar"></div>');
    const back = this.el('<button class="topbar-back" type="button"></button>');
    back.innerHTML = this.icons.chevron + '<span></span>';
    back.querySelector('span').textContent = label || 'Back';
    back.addEventListener('click', onBack);
    bar.appendChild(back);
    if (actions && actions.length) {
      const a = this.el('<div class="topbar-actions"></div>');
      actions.forEach((el) => { if (el) a.appendChild(el); });
      bar.appendChild(a);
    }
    return bar;
  },

  // --- rich text (notes + journal) -----------------------------------
  // Content is stored as HTML — the same format the Mac's RichEditor
  // produces — so mobile edits the HTML directly via a contenteditable.
  // This both RENDERS the formatting (headings, bold, lists, quotes,
  // links…) and preserves it round-trip, and — because a contenteditable
  // grows with its content — it removes the textarea's inner scroll and
  // bottom dead-space.

  // A contenteditable rich-text body. `onChange(html)` fires debounced.
  richEditor(html, onChange, placeholder) {
    const el = this.el('<div class="rich-body" contenteditable="true" spellcheck="true"></div>');
    if (placeholder) el.setAttribute('data-placeholder', placeholder);
    el.innerHTML = (html == null ? '' : html);
    const fire = this.debounce(function () { onChange(el.innerHTML); }, 500);
    el.addEventListener('input', fire);
    return el;
  },

  // Which block element the caret sits in (H1/H2/H3/P/BLOCKQUOTE/PRE/LI),
  // so the heading/quote toggles can flip back to a paragraph.
  _currentBlockTag(editor) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return '';
    let n = sel.anchorNode;
    if (n && n.nodeType === 3) n = n.parentNode;
    while (n && n !== editor) {
      const t = (n.tagName || '').toUpperCase();
      if (/^(H1|H2|H3|P|BLOCKQUOTE|PRE|LI)$/.test(t)) return t;
      n = n.parentNode;
    }
    return '';
  },

  // A compact formatting toolbar bound to a given rich-body element. Lives
  // inside the sticky .topbar (wraps to its own row) so it stays
  // reachable while editing and never fights the on-screen keyboard.
  formatToolbar(editor) {
    const bar = this.el('<div class="rich-toolbar"></div>');
    const exec = (fn) => {
      editor.focus();
      try { fn(); } catch (e) { /* execCommand quirks — ignore */ }
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const fmtBlock = (tag) => {
      const cur = this._currentBlockTag(editor);
      document.execCommand('formatBlock', false, '<' + (cur === tag ? 'p' : tag.toLowerCase()) + '>');
    };
    const mk = (label, cls, run) => {
      const b = this.el('<button class="rich-tool ' + (cls || '') + '" type="button"></button>');
      b.textContent = label;
      // Keep the editor's selection — don't let the button steal focus.
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
      b.addEventListener('click', (e) => { e.preventDefault(); exec(run); });
      return b;
    };
    bar.appendChild(mk('B', 'rt-b', () => document.execCommand('bold')));
    bar.appendChild(mk('I', 'rt-i', () => document.execCommand('italic')));
    bar.appendChild(mk('H1', '', () => fmtBlock('H1')));
    bar.appendChild(mk('H2', '', () => fmtBlock('H2')));
    bar.appendChild(mk('List', '', () => document.execCommand('insertUnorderedList')));
    bar.appendChild(mk('Quote', '', () => fmtBlock('BLOCKQUOTE')));
    bar.appendChild(mk('Link', '', () => {
      const url = window.prompt('Link URL');
      if (url && url.trim()) document.execCommand('createLink', false, url.trim());
    }));
    return bar;
  },

  // Light save-time guard for HTML edited on the phone. Content from the
  // desktop RichEditor is already sanitized; this just blocks the obvious
  // dangerous bits in case anything is pasted in.
  sanitizeHtml(html) {
    const d = document.createElement('div');
    d.innerHTML = String(html == null ? '' : html);
    d.querySelectorAll('script,style,iframe,object,embed,link,meta,noscript').forEach((n) => n.remove());
    d.querySelectorAll('*').forEach((el) => {
      for (let i = el.attributes.length - 1; i >= 0; i--) {
        const a = el.attributes[i];
        const name = a.name.toLowerCase();
        const val = (a.value || '').trim();
        if (name.indexOf('on') === 0) { el.removeAttribute(a.name); continue; }
        if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(val)) el.removeAttribute(a.name);
      }
    });
    return d.innerHTML;
  },

  // Place the caret at the end of a contenteditable element's content.
  caretToEnd(el) {
    try {
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    } catch (e) { /* no-op */ }
  },

  // a brief confirmation toast (used by Copy and form validation)
  toast(msg) {
    let t = document.getElementById('m-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'm-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.remove('show');
    void t.offsetWidth; // restart the transition
    t.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => t.classList.remove('show'), 1700);
  },

  // copy text to the clipboard, with a toast and a legacy fallback
  copy(text) {
    const s = String(text == null ? '' : text);
    const legacy = () => {
      const ta = document.createElement('textarea');
      ta.value = s;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); this.toast('Copied'); }
      catch (e) { this.toast('Could not copy'); }
      ta.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(s).then(() => this.toast('Copied'), legacy);
    } else {
      legacy();
    }
  },

  // open a URL outside the app — @capacitor/browser shows an in-app Safari
  // view on the phone; the browser preview falls back to a new tab
  openExternal(url) {
    let u = String(url == null ? '' : url).trim();
    if (!u) return;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u;
    const fallback = () => window.open(u, '_blank');
    const cap = window.Capacitor;
    if (cap && typeof cap.registerPlugin === 'function') {
      if (this._browser === undefined) {
        try { this._browser = cap.registerPlugin('Browser'); }
        catch (e) { this._browser = null; }
      }
      if (this._browser) {
        try { Promise.resolve(this._browser.open({ url: u })).catch(fallback); }
        catch (e) { fallback(); }
        return;
      }
    }
    fallback();
  },

  // --- form helpers (shared by the Tasks editor) ---
  field(label) {
    const f = this.el('<div class="field"></div>');
    f.appendChild(this.el('<div class="field-label">' + this.esc(label) + '</div>'));
    return f;
  },
  // options: [[value, label], ...]
  segmented(options, value, onChange) {
    const seg = this.el('<div class="segmented"></div>');
    options.forEach((opt) => {
      const b = this.el('<button class="seg' + (opt[0] === value ? ' on' : '') + '" type="button"></button>');
      b.textContent = opt[1];
      b.addEventListener('click', () => { if (opt[0] !== value) onChange(opt[0]); });
      seg.appendChild(b);
    });
    return seg;
  },
  // a Sun–Sat toggle row; onChange receives the sorted array of selected indices
  dayPicker(selected, onChange) {
    const labels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const sel = (selected || []).slice();
    const row = this.el('<div class="day-row"></div>');
    labels.forEach((label, idx) => {
      const b = this.el('<button class="day' + (sel.includes(idx) ? ' on' : '') + '" type="button"></button>');
      b.textContent = label;
      b.addEventListener('click', () => {
        const at = sel.indexOf(idx);
        if (at >= 0) sel.splice(at, 1); else sel.push(idx);
        b.classList.toggle('on');
        onChange(sel.slice().sort((x, y) => x - y));
      });
      row.appendChild(b);
    });
    return row;
  },
  // a native dropdown; options: [[value, label], ...]
  select(options, value, onChange) {
    const sel = this.el('<select class="field-input field-select"></select>');
    options.forEach((opt) => {
      const o = document.createElement('option');
      o.value = opt[0];
      o.textContent = opt[1];
      if (String(opt[0]) === String(value)) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  },
  // a row of toggle chips; options: [[value, label], ...]. selected is an
  // array; onChange receives the updated array.
  chips(options, selected, onChange) {
    const sel = (selected || []).slice();
    const row = this.el('<div class="chip-row"></div>');
    options.forEach((opt) => {
      const on = sel.indexOf(opt[0]) >= 0;
      const b = this.el('<button class="chip' + (on ? ' on' : '') + '" type="button"></button>');
      b.textContent = opt[1];
      b.addEventListener('click', () => {
        const at = sel.indexOf(opt[0]);
        if (at >= 0) sel.splice(at, 1); else sel.push(opt[0]);
        b.classList.toggle('on');
        onChange(sel.slice());
      });
      row.appendChild(b);
    });
    return row;
  },

  // --- dates ---
  dateStr(d) {
    return d.getFullYear() + '-'
      + String(d.getMonth() + 1).padStart(2, '0') + '-'
      + String(d.getDate()).padStart(2, '0');
  },
  todayStr() { return this.dateStr(new Date()); },
  relDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    const d0 = new Date(d); d0.setHours(0, 0, 0, 0);
    const days = Math.round((t0 - d0) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days > 1 && days < 7) return days + ' days ago';
    if (days < 0) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  },
  // "14:30" -> "2:30 PM". Returns the input unchanged if it isn't HH:MM.
  fmtTime(hhmm) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm == null ? '' : hhmm));
    if (!m) return hhmm || '';
    const h = parseInt(m[1], 10);
    const ap = h < 12 ? 'AM' : 'PM';
    const h12 = (h % 12) || 12;
    return h12 + ':' + m[2] + ' ' + ap;
  },

  // --- task scheduling (matches the desktop repeat model) ---
  // Whether a task lands on a given day — handles every repeat mode.
  taskDueOn(task, d) {
    const dow = d.getDay();
    const ds = this.dateStr(d);
    switch (task.repeat) {
      case 'daily': return true;
      case 'weekdays': return dow >= 1 && dow <= 5;
      case 'weekly': return task.dayOfWeek === dow;
      case 'custom': return Array.isArray(task.repeatDays) && task.repeatDays.includes(dow);
      case 'monthly': return !!task.scheduledDate && task.scheduledDate.slice(8, 10) === ds.slice(8, 10);
      case 'annually': return !!task.scheduledDate && task.scheduledDate.slice(5) === ds.slice(5);
      default: return task.scheduledDate === ds; // 'none'
    }
  },
  taskDueToday(task) { return this.taskDueOn(task, new Date()); },
  taskDoneToday(task) { return task.lastCompletedDate === this.todayStr(); },

  // shared inline icons
  icons: {
    check: '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>',
    plus: '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    chevron: '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
    trash: '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4.5h6V7M7.5 7l1 13h7l1-13"/></svg>',
    starOutline: '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 4l2.5 5.4 5.9.6-4.4 4 1.2 5.8L12 22l-5.2 3.0 1.2-5.8-4.4-4 5.9-.6z" transform="translate(0 -2)"/></svg>',
    starFilled: '<svg class="i" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.6 5.6 6.1.6-4.6 4.1 1.3 6L12 21l-5.4 2.9 1.3-6-4.6-4.1 6.1-.6z"/></svg>',
    // function-bar icons
    today: '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 11.2 12 4l8.5 7.2"/><path d="M6 10v9.5h12V10"/></svg>',
    grid: '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/></svg>',
    search: '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-3.6-3.6"/></svg>',
  },
};
