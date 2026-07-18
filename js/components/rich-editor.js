/**
 * Custom Rich Text Editor
 *
 * Single shared component used by Journal, Notes, and Email Compose.
 * Engine: contenteditable + document.execCommand. We've intentionally
 * stayed off ProseMirror/Tiptap to keep the surface area small and
 * dependency-free.
 *
 * Modes (opt-in via the options object on init()):
 *   - permanent toolbar (legacy): pass `toolbarClass` to bind buttons
 *   - selectionToolbar: floating toolbar appears on text selection
 *   - markdownShortcuts: `# `, `## `, `- `, `> ` etc. convert as you type
 *   - slashMenu: `/` at the start of an empty block opens a block-type menu
 *   - linkPopover: Cmd+K and the toolbar Link button open an inline
 *     popover instead of the native prompt()
 *
 * Notes still passes the old (editorId, toolbarClass, onAutoSave) shape
 * with no options — its behavior is unchanged.
 */

const RichEditor = {
    editor: null,
    toolbar: null,
    autoSaveCallback: null,
    autoSaveTimeout: null,
    inputHandler: null,
    keydownHandler: null,
    pasteHandler: null,

    // v2 state
    _options: null,
    _selectionToolbarEl: null,
    _slashMenuEl: null,
    _linkPopoverEl: null,
    _selectionChangeHandler: null,
    _emptyClickHandler: null,
    _tableToolbarEl: null,
    _tableSelectionHandler: null,
    _tableScrollHandler: null,
    _tableHandlesEl: null,
    _tableHandleHover: null,
    _handleTable: null,
    _resizing: false,
    _editorBlurHandler: null,
    _docClickHandler: null,
    _scrollHandler: null,
    _savedRange: null,

    /**
     * Initialize the rich text editor.
     *
     * @param {string}   editorId     ID of the contenteditable element
     * @param {string}   toolbarClass Class of the legacy permanent toolbar (or null/undefined)
     * @param {Function} onAutoSave   Callback for debounced auto-save
     * @param {Object}   options      Opt-in v2 features (see file header)
     */
    init(editorId, toolbarClass, onAutoSave = null, options = {}) {
        this.destroy();

        this.editor = document.getElementById(editorId);
        this.toolbar = toolbarClass ? document.querySelector(`.${toolbarClass}`) : null;
        this.autoSaveCallback = onAutoSave;
        this._options = Object.assign({
            selectionToolbar: false,
            markdownShortcuts: false,
            slashMenu: false,
            linkPopover: false,
            onWordCount: null
        }, options || {});

        if (!this.editor) {
            console.error(`Editor ${editorId} not found`);
            return;
        }

        if (this.toolbar) {
            this.setupToolbar();
        }

        // Auto-save + word count both fire on input.
        if (this.autoSaveCallback || this._options.onWordCount) {
            this.inputHandler = () => {
                if (this.autoSaveCallback) this.triggerAutoSave();
                this._emitWordCount();
            };
            this.editor.addEventListener('input', this.inputHandler);
        }

        // Keyboard shortcuts (formatting + Cmd+K + new heading/list bindings)
        this.keydownHandler = (e) => {
            this.handleKeyboardShortcuts(e);
        };
        this.editor.addEventListener('keydown', this.keydownHandler);

        // Notion-style: clicking the empty area below the content drops the
        // caret into an editable line at the end (creating one if the last
        // block is a code block / divider / image).
        this._emptyClickHandler = (e) => this._handleEmptyAreaClick(e);
        this.editor.addEventListener('mousedown', this._emptyClickHandler);

        // Sanitize pasted content
        this.pasteHandler = (e) => {
            e.preventDefault();
            const cd = e.clipboardData;
            const html = cd && cd.getData('text/html');
            const text = cd && cd.getData('text/plain');

            if (html && html.trim().length > 0) {
                const clean = this.sanitizeHtml(html);
                if (clean) {
                    document.execCommand('insertHTML', false, clean);
                    return;
                }
            }
            if (text) {
                const safe = text
                    .split(/\r?\n/)
                    .map(line => this.escapeHtml(line))
                    .join('<br>');
                document.execCommand('insertHTML', false, safe);
            }
        };
        this.editor.addEventListener('paste', this.pasteHandler);

        // Opt-in v2 features
        if (this._options.selectionToolbar) this._setupSelectionToolbar();
        if (this._options.markdownShortcuts) this._setupMarkdownShortcuts();
        if (this._options.slashMenu) this._setupSlashMenu();
        if (this._options.linkPopover) this._setupLinkPopover();
        // Tables are inserted from the slash menu, so their editing affordances
        // (Tab navigation + the floating row/column toolbar) come along with it.
        if (this._options.slashMenu) this._setupTableEditing();

        // Initial word count emission so the consumer can render `0 words`
        // immediately rather than waiting for the first keystroke.
        this._emitWordCount();
    },

    /* ---------------------------------------------------------------- */
    /*                      Sanitization & paste                         */
    /* ---------------------------------------------------------------- */

    escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    sanitizeHtml(html) {
        const ALLOWED_TAGS = new Set([
            'p', 'div', 'br', 'hr',
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
            'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'ins', 'mark',
            'ul', 'ol', 'li',
            'blockquote', 'pre', 'code',
            'a', 'img',
            'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'colgroup', 'col',
            'span', 'sub', 'sup'
        ]);
        const ALLOWED_ATTRS = {
            a: ['href'],
            img: ['src', 'alt'],
            th: ['colspan', 'rowspan'],
            td: ['colspan', 'rowspan'],
            col: ['width']
        };
        const SAFE_URL = /^(https?:|mailto:|tel:|#|\/|\.{1,2}\/)/i;
        const SAFE_IMG = /^(https?:|data:image\/)/i;

        let doc;
        try {
            doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
        } catch (err) {
            return '';
        }

        doc.querySelectorAll(
            'script, style, iframe, object, embed, form, input, button, select, textarea, link, meta, noscript, svg, math'
        ).forEach(el => el.remove());

        const walk = (node) => {
            const children = Array.from(node.childNodes);
            for (const child of children) {
                if (child.nodeType === Node.COMMENT_NODE) {
                    child.remove();
                    continue;
                }
                if (child.nodeType !== Node.ELEMENT_NODE) continue;

                const tag = child.tagName.toLowerCase();

                if (!ALLOWED_TAGS.has(tag)) {
                    while (child.firstChild) {
                        node.insertBefore(child.firstChild, child);
                    }
                    child.remove();
                    continue;
                }

                const keep = ALLOWED_ATTRS[tag] || [];
                for (const attr of Array.from(child.attributes)) {
                    const name = attr.name.toLowerCase();
                    if (!keep.includes(name) || name.startsWith('on')) {
                        child.removeAttribute(attr.name);
                    }
                }

                if (tag === 'a') {
                    const href = child.getAttribute('href');
                    if (!href || !SAFE_URL.test(href)) {
                        child.removeAttribute('href');
                    } else {
                        child.setAttribute('target', '_blank');
                        child.setAttribute('rel', 'noopener noreferrer');
                    }
                }

                if (tag === 'img') {
                    const src = child.getAttribute('src');
                    if (!src || !SAFE_IMG.test(src)) {
                        child.remove();
                        continue;
                    }
                }

                walk(child);
            }
        };
        walk(doc.body);

        return doc.body.innerHTML.trim();
    },

    /* ---------------------------------------------------------------- */
    /*                        Permanent toolbar                          */
    /* ---------------------------------------------------------------- */

    setupToolbar() {
        const buttons = this.toolbar.querySelectorAll('.toolbar-btn');
        buttons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const command = btn.dataset.command;
                const value = btn.dataset.value;
                this.executeCommand(command, value);
                this.editor.focus();
            });
        });
    },

    executeCommand(command, value = null) {
        if (command === 'createLink') {
            // Route to the inline popover when v2 mode is on, otherwise
            // fall back to the native prompt (Notes path).
            if (this._options && this._options.linkPopover) {
                this._openLinkPopover();
                return;
            }
            const url = prompt('Enter URL:');
            if (url) {
                document.execCommand(command, false, url);
            }
        } else if (value) {
            document.execCommand(command, false, value);
        } else {
            document.execCommand(command, false, null);
        }
    },

    /**
     * Inline code formatting — a wrap/unwrap toggle over the current
     * selection. execCommand has no native "code" command, so we drive it
     * through insertHTML (which keeps undo working and fires the input event
     * for auto-save). If the selection already sits inside a <code>, the
     * element is unwrapped back to plain text.
     */
    _toggleInlineCode() {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        if (!this.editor || !this.editor.contains(range.commonAncestorContainer)) return;

        // Toggle off: the caret/selection is within an existing <code>. Remove
        // the code element (and its <pre> wrapper, for block code), preserving
        // line breaks as <br> so a multi-line block doesn't collapse to one
        // line. This works with just a collapsed caret, so a note trapped
        // inside a code block can be recovered.
        const codeEl = this._closestCode(range.commonAncestorContainer);
        if (codeEl) {
            const target = (codeEl.parentNode && codeEl.parentNode.nodeName === 'PRE')
                ? codeEl.parentNode : codeEl;
            const r = document.createRange();
            r.selectNode(target);
            sel.removeAllRanges();
            sel.addRange(r);
            const raw = codeEl.textContent;
            // An empty block would unwrap to empty HTML, which insertHTML can't
            // use to replace the node — leave a <br> so the empty <pre>/<code>
            // is actually removed and an editable line remains.
            const html = raw
                ? raw.split(/\r?\n/).map(l => this.escapeHtml(l)).join('<br>')
                : '<br>';
            document.execCommand('insertHTML', false, html);
            return;
        }

        // Toggle on needs an actual selection to wrap.
        if (sel.isCollapsed) return;

        // Wrap the selected text. Code spans are plain text by definition, so
        // any inner formatting is intentionally dropped. A multi-line selection
        // becomes a <pre> block (inline <code> collapses newlines); a single
        // line stays an inline <code>.
        const text = sel.toString();
        if (!text) return;
        const safe = this.escapeHtml(text);
        const isBlock = /\r?\n/.test(text);
        document.execCommand('insertHTML', false,
            isBlock ? `<pre><code>${safe}</code></pre>` : `<code>${safe}</code>`);
        // Guarantee editable paragraphs around any block code (above/below/
        // between), then move the caret out of the code so the user can keep
        // typing normal text instead of being trapped inside the <code>/<pre>.
        if (isBlock) this._ensureBoundaryParagraphs();
        this._caretOutOfCode();
    },

    /**
     * After inserting code, drop the caret into normal, editable text. For a
     * <pre> block, guarantee an empty paragraph follows it and land there; for
     * inline <code>, place the caret just after the element.
     */
    _caretOutOfCode() {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const node = sel.anchorNode;

        // Walk up to a containing <pre> or <code> within the editor.
        let pre = null, code = null;
        let n = (node && node.nodeType === 3) ? node.parentNode : node;
        while (n && n !== this.editor) {
            if (n.nodeName === 'PRE') { pre = n; break; }
            if (n.nodeName === 'CODE' && !code) code = n;
            n = n.parentNode;
        }
        const block = pre || (code && code.parentNode && code.parentNode.nodeName === 'PRE' ? code.parentNode : null);

        const r = document.createRange();
        if (block) {
            let after = block.nextSibling;
            if (!after || (after.nodeName !== 'P' && after.nodeName !== 'DIV')) {
                const p = document.createElement('p');
                p.appendChild(document.createElement('br'));
                block.parentNode.insertBefore(p, block.nextSibling);
                after = p;
            }
            r.setStart(after, 0);
        } else if (code) {
            r.setStartAfter(code);
        } else {
            return;
        }
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
    },

    /**
     * Keep block-code (<pre>) reachable: a <pre> at the very top or bottom of
     * the note, or two adjacent <pre> blocks, leaves no normal paragraph to
     * click into — so the user can't add text above/below/between code. This
     * inserts an empty paragraph at each such boundary. Idempotent and
     * non-destructive (only adds empty paragraphs). Returns true if it changed
     * anything.
     */
    _ensureBoundaryParagraphs() {
        const ed = this.editor;
        if (!ed) return false;
        const makeP = () => {
            const p = document.createElement('p');
            p.appendChild(document.createElement('br'));
            return p;
        };
        let changed = false;

        // Leading guard.
        if (ed.firstChild && ed.firstChild.nodeName === 'PRE') {
            ed.insertBefore(makeP(), ed.firstChild);
            changed = true;
        }
        // Trailing guard.
        if (ed.lastChild && ed.lastChild.nodeName === 'PRE') {
            ed.appendChild(makeP());
            changed = true;
        }
        // Between adjacent <pre> blocks.
        let n = ed.firstChild;
        while (n) {
            const next = n.nextSibling;
            if (n.nodeName === 'PRE' && next && next.nodeName === 'PRE') {
                ed.insertBefore(makeP(), next);
                changed = true;
            }
            n = n.nextSibling;
        }
        return changed;
    },

    // Nearest ancestor <code> for a node, bounded by the editor root.
    _closestCode(node) {
        let n = (node && node.nodeType === 3) ? node.parentNode : node;
        while (n && n !== this.editor) {
            if (n.nodeName === 'CODE') return n;
            n = n.parentNode;
        }
        return null;
    },

    /**
     * Notion-style empty-space click. A click on the editor's own area (not on
     * a child block) lands either below all content or in the vertical gap
     * between two blocks — both should become editable:
     *   - below everything → caret on an editable line at the end;
     *   - in a gap between blocks (e.g. between two code blocks) → caret in an
     *     editable paragraph there, inserting a fresh one if the gap sits
     *     between blocks that can't hold a caret (code, divider, image).
     * This is what makes it possible to add normal text between code blocks.
     */
    _handleEmptyAreaClick(e) {
        // Only when the click lands on the editor itself, not on a child block.
        // NB: a leading bare text node (Chromium leaves the first typed line
        // unwrapped, wrapping only later lines in <div>) has no element to be
        // the target, so a click ON that text also reports the editor as
        // e.target — the content scan below distinguishes it from empty space.
        if (e.target !== this.editor) return;

        // Never hijack a double/triple click: those are word/paragraph select
        // gestures, and the preventDefault below would cancel the native
        // selection (the bug that made double-click-to-select-word fail in the
        // first paragraph).
        if (e.detail > 1) return;

        // Content nodes = element children plus any non-blank bare text node.
        // Measuring text nodes (via a Range) is what lets a click on the
        // leading unwrapped line be recognized as real content, not a gap.
        const children = Array.from(this.editor.childNodes).filter(n =>
            n.nodeType === Node.ELEMENT_NODE ||
            (n.nodeType === Node.TEXT_NODE && n.textContent.trim() !== '')
        );
        // Empty editor: the browser already places the caret (and we want to
        // keep the :empty placeholder), so let the default happen.
        if (children.length === 0) return;

        const rectOf = (n) => {
            if (n.nodeType === Node.ELEMENT_NODE) return n.getBoundingClientRect();
            const r = document.createRange();
            r.selectNodeContents(n);
            return r.getBoundingClientRect();
        };

        // Classify the click against the content: inside a node's vertical span
        // (a side-padding click, or a click on the unwrapped first line) is left
        // to the browser; otherwise find the first node below the click — the
        // gap is just above it.
        let below = null;
        for (const child of children) {
            const r = rectOf(child);
            if (e.clientY >= r.top && e.clientY <= r.bottom) return; // beside/on content
            if (e.clientY < r.top) { below = child; break; }
        }

        e.preventDefault();

        const caretHolds = (el) => el && /^(P|DIV|H[1-6]|LI|BLOCKQUOTE)$/.test(el.nodeName);
        const isEmptyPara = (el) => caretHolds(el) && el.textContent.trim() === '';
        const above = below ? below.previousElementSibling : this.editor.lastElementChild;

        let target;
        if (isEmptyPara(below)) {
            target = below;                       // reuse the blank line in the gap
        } else if (isEmptyPara(above)) {
            target = above;
        } else {
            target = document.createElement('p'); // insert a new line at the gap
            target.appendChild(document.createElement('br'));
            this.editor.insertBefore(target, below); // below == null → append at end
        }
        this.editor.focus({ preventScroll: true });
        this._caretToEnd(target);
    },

    // Place the caret at the end of an element (or inside an empty <br>-only
    // paragraph), collapsed.
    _caretToEnd(el) {
        const sel = window.getSelection();
        if (!sel) return;
        const r = document.createRange();
        const onlyBr = el.childNodes.length === 1 && el.firstChild.nodeName === 'BR';
        if (onlyBr) {
            r.setStart(el, 0);
            r.collapse(true);
        } else {
            r.selectNodeContents(el);
            r.collapse(false);
        }
        sel.removeAllRanges();
        sel.addRange(r);
    },

    // Nearest ancestor <pre> for a node, bounded by the editor root.
    _closestPre(node) {
        let n = (node && node.nodeType === 3) ? node.parentNode : node;
        while (n && n !== this.editor) {
            if (n.nodeName === 'PRE') return n;
            n = n.parentNode;
        }
        return null;
    },

    /**
     * Enter inside a code block always adds a newline within the <pre> — the
     * block is never split or exited. To start a fresh code section the user
     * clicks outside the block and inserts a new one. Returns true if handled.
     */
    _handleEnterInCode(e) {
        if (e.key !== 'Enter' || e.isComposing) return false;
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return false;
        const range = sel.getRangeAt(0);
        if (!this._closestPre(range.startContainer)) return false;

        e.preventDefault();
        // Insert a literal newline inside the code block. insertText keeps undo
        // working and fires the input event for auto-save.
        document.execCommand('insertText', false, '\n');
        return true;
    },

    /* ---------------------------------------------------------------- */
    /*                       Keyboard shortcuts                          */
    /* ---------------------------------------------------------------- */

    handleKeyboardShortcuts(e) {
        // Tab moves between table cells (and adds a row past the last cell).
        // Runs before the mod-key gate since Tab carries no modifier.
        if (this._handleTableTab(e)) return;

        // Enter inside a code block inserts a newline instead of splitting the
        // block. Runs before the mod-key gate since Enter carries no modifier.
        if (this._handleEnterInCode(e)) return;

        const mod = e.ctrlKey || e.metaKey;
        if (!mod) return;

        const k = e.key.toLowerCase();

        // Existing bindings
        if (k === 'b') {
            e.preventDefault();
            this.executeCommand('bold');
            return;
        }
        if (k === 'i') {
            e.preventDefault();
            this.executeCommand('italic');
            return;
        }
        if (k === 'u') {
            e.preventDefault();
            this.executeCommand('underline');
            return;
        }

        // Cmd+E — inline code (wrap/unwrap the selection)
        if (k === 'e') {
            e.preventDefault();
            this._toggleInlineCode();
            return;
        }

        // Cmd+K — link
        if (k === 'k') {
            e.preventDefault();
            this.executeCommand('createLink');
            return;
        }

        // The remaining shortcuts use Shift, and we want to no-op when
        // Shift isn't held so plain Cmd+1/2/3 etc. still fall through to
        // the OS / browser.
        if (!e.shiftKey) return;

        if (k === '1') { e.preventDefault(); this.executeCommand('formatBlock', 'h1'); return; }
        if (k === '2') { e.preventDefault(); this.executeCommand('formatBlock', 'h2'); return; }
        if (k === '3') { e.preventDefault(); this.executeCommand('formatBlock', 'h3'); return; }
        if (k === '7') { e.preventDefault(); this.executeCommand('insertOrderedList'); return; }
        if (k === '8') { e.preventDefault(); this.executeCommand('insertUnorderedList'); return; }
        if (k === '.' || k === '>') {
            e.preventDefault();
            this.executeCommand('formatBlock', 'blockquote');
            return;
        }
    },

    triggerAutoSave() {
        if (this.autoSaveTimeout) clearTimeout(this.autoSaveTimeout);
        this.autoSaveTimeout = setTimeout(() => {
            if (this.autoSaveCallback) this.autoSaveCallback();
        }, 1000);
    },

    /* ---------------------------------------------------------------- */
    /*                     Markdown-style shortcuts                      */
    /* ---------------------------------------------------------------- */

    /**
     * Convert markdown-ish prefixes into formatted blocks while typing.
     *
     * Strategy: listen for the trigger character (space) on input. When
     * the current block's text content matches a known prefix (`# `,
     * `## `, `- `, `> `, etc.), strip the prefix and apply the format.
     *
     * Inline shortcuts (**bold**, *italic*, `code`) intentionally aren't
     * implemented — they're surprisingly fiddly with execCommand and the
     * selection toolbar already covers that workflow.
     */
    _setupMarkdownShortcuts() {
        this._markdownInputHandler = (e) => {
            // Only act on a space character. `inputType === 'insertText'`
            // and `data === ' '` is the cleanest cross-browser test.
            if (e.inputType !== 'insertText' || e.data !== ' ') return;

            const sel = window.getSelection();
            if (!sel || !sel.rangeCount) return;
            const range = sel.getRangeAt(0);
            if (!this.editor.contains(range.startContainer)) return;

            const block = this._getCurrentBlock(range.startContainer);
            if (!block) return;

            // Only fire if the cursor sits inside the block's first text
            // node — otherwise the user is typing mid-paragraph and the
            // prefix isn't a real "start of line" marker.
            const text = block.textContent || '';

            const tryReplace = (prefix, format, value) => {
                if (text === prefix) {
                    e.preventDefault();
                    block.textContent = '';
                    document.execCommand(format, false, value || null);
                    return true;
                }
                return false;
            };

            if (tryReplace('# ', 'formatBlock', 'h1')) return;
            if (tryReplace('## ', 'formatBlock', 'h2')) return;
            if (tryReplace('### ', 'formatBlock', 'h3')) return;
            if (tryReplace('> ', 'formatBlock', 'blockquote')) return;
            if (tryReplace('- ', 'insertUnorderedList')) return;
            if (tryReplace('* ', 'insertUnorderedList')) return;
            if (tryReplace('1. ', 'insertOrderedList')) return;
        };
        this.editor.addEventListener('beforeinput', this._markdownInputHandler);

        // `---` + Enter at the start of an empty block → horizontal rule.
        this._markdownEnterHandler = (e) => {
            if (e.key !== 'Enter' || e.shiftKey) return;
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount) return;
            const range = sel.getRangeAt(0);
            if (!this.editor.contains(range.startContainer)) return;
            const block = this._getCurrentBlock(range.startContainer);
            if (!block) return;
            if ((block.textContent || '') === '---') {
                e.preventDefault();
                block.textContent = '';
                document.execCommand('insertHorizontalRule');
            }
        };
        this.editor.addEventListener('keydown', this._markdownEnterHandler);
    },

    _getCurrentBlock(node) {
        // Walk up to the closest block-level ancestor inside the editor.
        const BLOCKS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'LI', 'PRE']);
        let n = node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
        while (n && n !== this.editor) {
            if (BLOCKS.has(n.nodeName)) return n;
            n = n.parentNode;
        }
        return null;
    },

    /* ---------------------------------------------------------------- */
    /*                       Selection toolbar                           */
    /* ---------------------------------------------------------------- */

    _setupSelectionToolbar() {
        const el = document.createElement('div');
        el.className = 're-selection-toolbar';
        el.setAttribute('role', 'toolbar');
        el.innerHTML = `
            <button type="button" data-command="bold" title="Bold (Cmd+B)"><strong>B</strong></button>
            <button type="button" data-command="italic" title="Italic (Cmd+I)"><em>I</em></button>
            <button type="button" data-command="underline" title="Underline (Cmd+U)"><u>U</u></button>
            <button type="button" data-command="strikeThrough" title="Strikethrough"><s>S</s></button>
            <button type="button" data-action="code" title="Inline code (Cmd+E)">&lt;/&gt;</button>
            <span class="re-divider"></span>
            <button type="button" data-command="formatBlock" data-value="h1" title="Heading 1">H1</button>
            <button type="button" data-command="formatBlock" data-value="h2" title="Heading 2">H2</button>
            <button type="button" data-command="formatBlock" data-value="blockquote" title="Quote">&ldquo;</button>
            <span class="re-divider"></span>
            <button type="button" data-command="createLink" title="Link (Cmd+K)">&#128279;</button>
            ${typeof WordLookup !== 'undefined' ? '<button type="button" data-action="define" title="Define selection">Def</button>' : ''}
        `;
        document.body.appendChild(el);
        this._selectionToolbarEl = el;

        // Use mousedown so the click happens before the editor's blur
        // would otherwise collapse the selection.
        el.addEventListener('mousedown', (e) => {
            // "Define" is handled separately — it's a lookup, not an
            // execCommand. Resolves to WordLookup which renders its own
            // popover anchored to the same selection rect.
            const defineBtn = e.target.closest('button[data-action="define"]');
            if (defineBtn) {
                e.preventDefault();
                if (typeof WordLookup === 'undefined') return;
                const sel = window.getSelection();
                const text = (sel && sel.toString() || '').trim();
                if (!text) return;
                const rect = (sel && sel.rangeCount > 0)
                    ? sel.getRangeAt(0).getBoundingClientRect()
                    : null;
                this._hideSelectionToolbar();
                WordLookup.openPopover(text, rect);
                return;
            }
            // Inline code: a wrap/unwrap toggle, not an execCommand.
            const codeBtn = e.target.closest('button[data-action="code"]');
            if (codeBtn) {
                e.preventDefault();
                this._toggleInlineCode();
                this._positionSelectionToolbar();
                return;
            }
            const btn = e.target.closest('button[data-command]');
            if (!btn) return;
            e.preventDefault();
            const command = btn.dataset.command;
            const value = btn.dataset.value;
            this.executeCommand(command, value);
            this._positionSelectionToolbar();
        });

        // Reposition / show / hide on selection changes within the editor.
        this._selectionChangeHandler = () => this._positionSelectionToolbar();
        document.addEventListener('selectionchange', this._selectionChangeHandler);

        // Hide when the user scrolls or focus moves outside the editor.
        this._scrollHandler = () => this._hideSelectionToolbar();
        window.addEventListener('scroll', this._scrollHandler, true);
    },

    _positionSelectionToolbar() {
        const el = this._selectionToolbarEl;
        if (!el || !this.editor) return;

        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
            this._hideSelectionToolbar();
            return;
        }
        const range = sel.getRangeAt(0);
        if (!this.editor.contains(range.commonAncestorContainer)) {
            this._hideSelectionToolbar();
            return;
        }

        const rect = range.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) {
            this._hideSelectionToolbar();
            return;
        }

        // Hide the "Define" button when the selection isn't word-like
        // (paragraphs, sentences). Matches the WordLookup pill's own
        // heuristic so the affordance is consistent across surfaces.
        const defineBtn = el.querySelector('button[data-action="define"]');
        if (defineBtn) {
            const text = (sel.toString() || '').trim();
            const wordy = /^[\p{L}'’\-]+(\s+[\p{L}'’\-]+){0,2}$/u.test(text) && text.length <= 60;
            defineBtn.style.display = wordy ? '' : 'none';
        }

        // Show first so we can measure width.
        el.classList.add('visible');

        const tbRect = el.getBoundingClientRect();
        let top = rect.top - tbRect.height - 8;
        let left = rect.left + (rect.width / 2) - (tbRect.width / 2);

        // If the toolbar would clip above the viewport, flip it below.
        if (top < 8) top = rect.bottom + 8;
        // Keep within horizontal bounds.
        const margin = 8;
        if (left < margin) left = margin;
        if (left + tbRect.width > window.innerWidth - margin) {
            left = window.innerWidth - margin - tbRect.width;
        }

        el.style.top = `${top}px`;
        el.style.left = `${left}px`;
    },

    _hideSelectionToolbar() {
        if (this._selectionToolbarEl) {
            this._selectionToolbarEl.classList.remove('visible');
        }
    },

    /* ---------------------------------------------------------------- */
    /*                          Slash menu                               */
    /* ---------------------------------------------------------------- */

    _setupSlashMenu() {
        const el = document.createElement('div');
        el.className = 're-slash-menu';
        el.setAttribute('role', 'menu');
        document.body.appendChild(el);
        this._slashMenuEl = el;

        this._slashItems = [
            { label: 'Heading 1',     hint: 'Large title',          run: () => document.execCommand('formatBlock', false, 'h1') },
            { label: 'Heading 2',     hint: 'Section heading',      run: () => document.execCommand('formatBlock', false, 'h2') },
            { label: 'Heading 3',     hint: 'Subheading',           run: () => document.execCommand('formatBlock', false, 'h3') },
            { label: 'Bullet list',   hint: 'Unordered list',       run: () => document.execCommand('insertUnorderedList') },
            { label: 'Numbered list', hint: 'Ordered list',         run: () => document.execCommand('insertOrderedList') },
            { label: 'Quote',         hint: 'Blockquote',           run: () => document.execCommand('formatBlock', false, 'blockquote') },
            { label: 'Code',          hint: 'Inline monospace',     run: () => document.execCommand('formatBlock', false, 'pre') },
            { label: 'Divider',       hint: 'Horizontal rule',      run: () => document.execCommand('insertHorizontalRule') },
            { label: 'Table',         hint: '3×3 grid, editable',   run: () => this._insertTable(3, 3) }
        ];
        this._slashFilter = '';
        this._slashIndex = 0;
        this._slashOpen = false;
        this._slashTriggerNode = null;

        this._slashInputHandler = (e) => {
            // Open when user types `/` at the start of an empty block.
            if (this._slashOpen) {
                this._refreshSlashMenu();
                return;
            }
            if (e.inputType !== 'insertText' || e.data !== '/') return;

            const sel = window.getSelection();
            if (!sel || !sel.rangeCount) return;
            const range = sel.getRangeAt(0);
            if (!this.editor.contains(range.startContainer)) return;
            const block = this._getCurrentBlock(range.startContainer);
            if (!block) return;
            if ((block.textContent || '') !== '/') return;

            this._openSlashMenu(block);
        };
        this.editor.addEventListener('input', this._slashInputHandler);

        this._slashKeyHandler = (e) => {
            if (!this._slashOpen) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                this._closeSlashMenu();
                return;
            }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this._slashIndex = Math.min(this._slashIndex + 1, this._currentSlashItems().length - 1);
                this._renderSlashMenu();
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                this._slashIndex = Math.max(this._slashIndex - 1, 0);
                this._renderSlashMenu();
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                this._selectSlashItem();
                return;
            }
        };
        this.editor.addEventListener('keydown', this._slashKeyHandler, true);

        this._slashClickHandler = (e) => {
            if (!this._slashOpen) return;
            if (this._slashMenuEl.contains(e.target)) return;
            this._closeSlashMenu();
        };
        document.addEventListener('mousedown', this._slashClickHandler);
    },

    _openSlashMenu(block) {
        this._slashOpen = true;
        this._slashFilter = '';
        this._slashIndex = 0;
        this._slashTriggerNode = block;

        const range = window.getSelection().getRangeAt(0);
        const rect = range.getBoundingClientRect();
        const left = rect.left;
        const top = rect.bottom + 6;

        this._slashMenuEl.style.left = `${left}px`;
        this._slashMenuEl.style.top = `${top}px`;
        this._slashMenuEl.classList.add('visible');
        this._renderSlashMenu();
    },

    _refreshSlashMenu() {
        // After the `/`, the user may keep typing to filter. We re-derive
        // the filter from the trigger block's text on every input.
        if (!this._slashTriggerNode) {
            this._closeSlashMenu();
            return;
        }
        const text = this._slashTriggerNode.textContent || '';
        if (!text.startsWith('/')) {
            this._closeSlashMenu();
            return;
        }
        this._slashFilter = text.slice(1).toLowerCase();
        const items = this._currentSlashItems();
        if (this._slashIndex >= items.length) this._slashIndex = Math.max(0, items.length - 1);
        this._renderSlashMenu();
    },

    _currentSlashItems() {
        const f = this._slashFilter || '';
        if (!f) return this._slashItems;
        return this._slashItems.filter(it => it.label.toLowerCase().includes(f));
    },

    _renderSlashMenu() {
        const items = this._currentSlashItems();
        if (items.length === 0) {
            this._slashMenuEl.innerHTML = `<div class="re-slash-empty">No matches</div>`;
            return;
        }
        this._slashMenuEl.innerHTML = items.map((it, i) => `
            <div class="re-slash-item ${i === this._slashIndex ? 'active' : ''}" data-i="${i}">
                <span class="re-slash-label">${this.escapeHtml(it.label)}</span>
                <span class="re-slash-hint">${this.escapeHtml(it.hint)}</span>
            </div>
        `).join('');
        // Click to select
        this._slashMenuEl.querySelectorAll('.re-slash-item').forEach(row => {
            row.addEventListener('mousedown', (e) => {
                e.preventDefault();
                this._slashIndex = parseInt(row.dataset.i, 10);
                this._selectSlashItem();
            });
        });
    },

    _selectSlashItem() {
        const items = this._currentSlashItems();
        const item = items[this._slashIndex];
        if (!item || !this._slashTriggerNode) {
            this._closeSlashMenu();
            return;
        }
        // Strip the `/filter` from the trigger block before applying the
        // command, so the command operates on a clean empty block.
        this._slashTriggerNode.textContent = '';
        // Restore the cursor inside the now-empty block.
        const range = document.createRange();
        range.selectNodeContents(this._slashTriggerNode);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        // Run the command (uses execCommand which honors current selection).
        item.run();
        this._closeSlashMenu();
    },

    _closeSlashMenu() {
        this._slashOpen = false;
        this._slashTriggerNode = null;
        if (this._slashMenuEl) this._slashMenuEl.classList.remove('visible');
    },

    /* ---------------------------------------------------------------- */
    /*                            Tables                                 */
    /* ---------------------------------------------------------------- */

    /**
     * Insert an editable table where the slash menu was triggered. The first
     * row is a header (<th>); a trailing empty paragraph is added after the
     * table so there's always a line to continue in below it.
     */
    _insertTable(rows = 3, cols = 3) {
        const table = document.createElement('table');
        table.className = 're-table';
        // Start compact instead of spanning the whole editor column: ~11em per
        // column (a comfortable word-or-two width), capped at the full column.
        // The right-edge drag handle rewrites this as a percentage when the
        // user resizes the table.
        table.style.width = `min(${cols * 11}em, 100%)`;
        // A <colgroup> holds per-column widths (equal to start). Column drag
        // updates these; they persist with the note (table-layout: fixed reads
        // them).
        const colgroup = document.createElement('colgroup');
        for (let c = 0; c < cols; c++) {
            const col = document.createElement('col');
            this._setColWidth(col, 100 / cols);
            colgroup.appendChild(col);
        }
        table.appendChild(colgroup);
        const tbody = document.createElement('tbody');
        for (let r = 0; r < rows; r++) {
            const tr = document.createElement('tr');
            for (let c = 0; c < cols; c++) {
                const cell = document.createElement(r === 0 ? 'th' : 'td');
                cell.appendChild(document.createElement('br'));
                tr.appendChild(cell);
            }
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);

        const after = document.createElement('p');
        after.appendChild(document.createElement('br'));

        const block = this._slashTriggerNode;
        if (block && block.parentNode === this.editor) {
            this.editor.replaceChild(table, block);
            table.insertAdjacentElement('afterend', after);
            this._caretIntoCell(table.querySelector('th, td'));
        } else {
            // Fallback (not triggered from a top-level block): insert at caret.
            // execCommand fires input, so auto-save runs on its own.
            document.execCommand('insertHTML', false, table.outerHTML + '<p><br></p>');
            return;
        }
        if (this.autoSaveCallback) this.triggerAutoSave();
        this._emitWordCount();
    },

    // Nearest ancestor table cell for a node, bounded by the editor root.
    _closestCell(node) {
        let n = (node && node.nodeType === 3) ? node.parentNode : node;
        while (n && n !== this.editor) {
            if (n.nodeName === 'TD' || n.nodeName === 'TH') return n;
            n = n.parentNode;
        }
        return null;
    },

    _caretIntoCell(cell) {
        if (!cell) return;
        const sel = window.getSelection();
        const r = document.createRange();
        r.selectNodeContents(cell);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
        this._positionTableToolbar();
    },

    /**
     * Tab / Shift+Tab move between cells; Tab in the last cell appends a new
     * row (like Notion / Google Docs). Returns true if handled.
     */
    _handleTableTab(e) {
        if (e.key !== 'Tab' || e.isComposing) return false;
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return false;
        const cell = this._closestCell(sel.anchorNode);
        if (!cell) return false;

        e.preventDefault();
        const table = cell.closest('table');
        const cells = Array.from(table.querySelectorAll('th, td'));
        const idx = cells.indexOf(cell);
        let next = e.shiftKey ? cells[idx - 1] : cells[idx + 1];
        if (!e.shiftKey && !next) {
            // Past the last cell → add a row and land in its first cell.
            const lastRow = table.rows[table.rows.length - 1];
            const newRow = table.insertRow(-1);
            for (let i = 0; i < lastRow.cells.length; i++) {
                newRow.insertCell(i).appendChild(document.createElement('br'));
            }
            next = newRow.cells[0];
            if (this.autoSaveCallback) this.triggerAutoSave();
        }
        if (next) this._caretIntoCell(next);
        return true;
    },

    /* ---- floating row/column toolbar (overlay, not saved with content) ---- */

    _setupTableEditing() {
        const el = document.createElement('div');
        el.className = 're-table-toolbar';
        el.setAttribute('role', 'toolbar');
        el.innerHTML = `
            <button type="button" data-action="add-row" title="Add row below">+&nbsp;Row</button>
            <button type="button" data-action="add-col" title="Add column right">+&nbsp;Col</button>
            <span class="re-divider"></span>
            <button type="button" data-action="del-row" title="Delete row">&minus;&nbsp;Row</button>
            <button type="button" data-action="del-col" title="Delete column">&minus;&nbsp;Col</button>
            <span class="re-divider"></span>
            <button type="button" data-action="del-table" title="Delete table">&#128465;</button>
        `;
        document.body.appendChild(el);
        this._tableToolbarEl = el;

        // mousedown (not click) so the cell selection survives the button press.
        el.addEventListener('mousedown', (e) => {
            const btn = e.target.closest('button[data-action]');
            if (!btn) return;
            e.preventDefault();
            this._tableAction(btn.dataset.action);
        });

        this._tableSelectionHandler = () => { this._positionTableToolbar(); this._positionTableHandles(); };
        document.addEventListener('selectionchange', this._tableSelectionHandler);
        this._tableScrollHandler = () => { this._positionTableToolbar(); this._positionTableHandles(); };
        window.addEventListener('scroll', this._tableScrollHandler, true);

        // Column drag-resize via overlay handles on the column borders.
        this._setupTableResizeHandles();
    },

    _positionTableToolbar() {
        const el = this._tableToolbarEl;
        if (!el || !this.editor) return;
        const sel = window.getSelection();
        const cell = (sel && sel.rangeCount) ? this._closestCell(sel.anchorNode) : null;
        if (!cell || !this.editor.contains(cell)) { el.classList.remove('visible'); return; }
        const table = cell.closest('table');
        const rect = table.getBoundingClientRect();
        el.classList.add('visible');
        const tb = el.getBoundingClientRect();
        let top = rect.top - tb.height - 6;
        if (top < 6) top = rect.bottom + 6;   // flip below when clipped at the top
        el.style.top = `${top}px`;
        el.style.left = `${Math.max(6, rect.left)}px`;
    },

    _hideTableToolbar() {
        if (this._tableToolbarEl) this._tableToolbarEl.classList.remove('visible');
    },

    _tableAction(action) {
        const sel = window.getSelection();
        const cell = (sel && sel.rangeCount) ? this._closestCell(sel.anchorNode) : null;
        if (!cell) return;
        const table = cell.closest('table');
        const tr = cell.parentNode;
        const colIndex = cell.cellIndex;

        switch (action) {
            case 'add-row': {
                const newRow = table.insertRow(tr.rowIndex + 1);
                for (let i = 0; i < tr.cells.length; i++) {
                    newRow.insertCell(i).appendChild(document.createElement('br'));
                }
                break;
            }
            case 'add-col': {
                // Sync the colgroup to the *current* columns first, then insert
                // the new cells and a matching <col> so counts stay aligned.
                const cg = this._ensureColgroup(table);
                for (const row of table.rows) {
                    const useTh = row.cells[0] && row.cells[0].tagName === 'TH';
                    const ref = row.cells[colIndex + 1] || null;
                    const c = useTh ? document.createElement('th') : document.createElement('td');
                    c.appendChild(document.createElement('br'));
                    row.insertBefore(c, ref);
                }
                cg.insertBefore(document.createElement('col'), cg.children[colIndex + 1] || null);
                this._renormalizeCols(table);
                break;
            }
            case 'del-row': {
                if (table.rows.length <= 1) { this._removeTable(table); return; }
                table.deleteRow(tr.rowIndex);
                break;
            }
            case 'del-col': {
                if (table.rows[0].cells.length <= 1) { this._removeTable(table); return; }
                const cg = this._ensureColgroup(table);
                for (const row of table.rows) { if (row.cells[colIndex]) row.deleteCell(colIndex); }
                if (cg.children[colIndex]) cg.removeChild(cg.children[colIndex]);
                this._renormalizeCols(table);
                break;
            }
            case 'del-table': {
                this._removeTable(table);
                return;
            }
        }
        if (this.autoSaveCallback) this.triggerAutoSave();
        this._emitWordCount();
        this._positionTableToolbar();
    },

    _removeTable(table) {
        const p = document.createElement('p');
        p.appendChild(document.createElement('br'));
        table.parentNode.replaceChild(p, table);
        const sel = window.getSelection();
        const r = document.createRange();
        r.setStart(p, 0); r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
        this._hideTableToolbar();
        this._handleTable = null;
        this._positionTableHandles();
        if (this.autoSaveCallback) this.triggerAutoSave();
        this._emitWordCount();
    },

    /* ---- column widths / drag-resize ---- */

    // Set a column width as a percentage via inline style. (Only style — the
    // obsolete <col width> attribute conflicts with the style in some engines
    // and makes the layout oscillate mid-drag.)
    _setColWidth(col, pct) {
        col.removeAttribute('width');
        col.style.width = `${Math.round(pct * 100) / 100}%`;
    },

    // Ensure the table has a <colgroup> with one <col> per column (equal widths
    // if it was created before colgroups existed, or is out of sync).
    _ensureColgroup(table) {
        let cg = table.querySelector('colgroup');
        const cols = table.rows[0] ? table.rows[0].cells.length : 0;
        if (!cg) {
            cg = document.createElement('colgroup');
            table.insertBefore(cg, table.firstChild);
        }
        while (cg.children.length < cols) cg.appendChild(document.createElement('col'));
        while (cg.children.length > cols) cg.removeChild(cg.lastChild);
        // Strip any stale <col width> attribute (from an earlier version) that
        // would fight the inline style, and fill any missing widths.
        [...cg.children].forEach(c => {
            c.removeAttribute('width');
            if (!parseFloat(c.style.width)) this._setColWidth(c, 100 / cols);
        });
        return cg;
    },

    // Rescale all column widths so they sum to 100% (keeps proportions after a
    // column is added/removed).
    _renormalizeCols(table) {
        const cols = [...table.querySelectorAll('colgroup > col')];
        if (!cols.length) return;
        const n = cols.length;
        const ws = cols.map(c => parseFloat(c.style.width) || (100 / n));
        const sum = ws.reduce((a, b) => a + b, 0) || n;
        cols.forEach((c, i) => this._setColWidth(c, ws[i] * 100 / sum));
    },

    // Hover detection: show a col-resize cursor and arm a drag when the pointer
    // is near a column border (a cell's right edge, or the next cell's left
    // edge). Nothing is added to the saved DOM — the cursor lives on the editor
    // element, whose attributes aren't part of getHTML().
    /**
     * Column resizing uses real handle elements — fixed-position strips laid
     * over each column border of the table under the pointer — instead of
     * pixel-math edge detection inside the contenteditable. The handles live
     * in an overlay in document.body (never part of the saved note HTML), and
     * dragging uses pointer capture, so the caret, text selection, and hover
     * flicker problems of the old approach can't happen.
     */
    _setupTableResizeHandles() {
        const wrap = document.createElement('div');
        wrap.className = 're-table-handles';
        wrap.style.display = 'none';
        document.body.appendChild(wrap);
        this._tableHandlesEl = wrap;

        this._tableHandleHover = (e) => {
            if (this._resizing) return;
            const t = e.target;
            if (!t || !t.closest) return;
            if (wrap.contains(t)) return;               // over a handle — keep them
            const table = t.closest('table');
            this._handleTable = (table && this.editor && this.editor.contains(table)) ? table : null;
            this._positionTableHandles();
        };
        document.addEventListener('mousemove', this._tableHandleHover);
    },

    _positionTableHandles() {
        const wrap = this._tableHandlesEl;
        if (!wrap) return;
        const table = this._handleTable;
        if (!table || !table.isConnected || !this.editor
            || !this.editor.contains(table) || !table.rows[0]) {
            wrap.style.display = 'none';
            return;
        }
        const tRect = table.getBoundingClientRect();
        const cells = [...table.rows[0].cells];
        wrap.style.display = '';
        // One handle per column border — the right edge of every column,
        // including the last (which resizes the table as a whole).
        while (wrap.children.length < cells.length) {
            const h = document.createElement('div');
            h.className = 're-col-handle';
            h.addEventListener('pointerdown', (ev) => this._startColDrag(ev, h));
            wrap.appendChild(h);
        }
        while (wrap.children.length > cells.length) wrap.removeChild(wrap.lastChild);
        cells.forEach((c, i) => {
            const h = wrap.children[i];
            h.dataset.i = i;
            h.style.left = `${c.getBoundingClientRect().right - 4}px`;
            h.style.top = `${tRect.top}px`;
            h.style.height = `${tRect.height}px`;
        });
    },

    /**
     * Drag a column border. Interior borders trade width between the two
     * columns they separate — the table's overall width stays put. The
     * rightmost border resizes the whole table (20%–100% of the editor
     * column), Notion-style.
     */
    _startColDrag(ev, h) {
        const table = this._handleTable;
        if (!table || !table.isConnected) return;
        ev.preventDefault();
        const i = +h.dataset.i;
        const cg = this._ensureColgroup(table);
        const cols = [...cg.children];
        const n = cols.length;
        if (!n || i < 0 || i >= n) return;

        this._resizing = true;
        h.classList.add('dragging');
        document.body.classList.add('re-col-dragging');
        try { h.setPointerCapture(ev.pointerId); } catch {}

        const tableWidth = table.getBoundingClientRect().width || 1;
        const parentWidth = (table.parentNode && table.parentNode.getBoundingClientRect().width) || tableWidth;
        const startX = ev.clientX;
        const startWs = cols.map(c => parseFloat(c.style.width) || (100 / n));
        const startTablePct = (tableWidth / parentWidth) * 100;
        const MIN = 5;                       // percent of the table's width
        const lastBorder = (i === n - 1);

        const onMove = (mv) => {
            if (!table.isConnected) return;
            const dx = mv.clientX - startX;
            if (lastBorder) {
                const pct = Math.max(20, Math.min(100, startTablePct + (dx / parentWidth) * 100));
                table.style.width = `${Math.round(pct * 100) / 100}%`;
            } else {
                const dpct = (dx / tableWidth) * 100;
                let a = startWs[i] + dpct, b = startWs[i + 1] - dpct;
                if (a < MIN) { b -= (MIN - a); a = MIN; }
                if (b < MIN) { a -= (MIN - b); b = MIN; }
                this._setColWidth(cols[i], a);
                this._setColWidth(cols[i + 1], b);
            }
            this._positionTableHandles();
        };
        const onUp = (up) => {
            h.removeEventListener('pointermove', onMove);
            h.removeEventListener('pointerup', onUp);
            h.removeEventListener('pointercancel', onUp);
            try { h.releasePointerCapture(up.pointerId); } catch {}
            h.classList.remove('dragging');
            document.body.classList.remove('re-col-dragging');
            this._resizing = false;
            if (this.autoSaveCallback) this.triggerAutoSave();
            this._positionTableHandles();
        };
        h.addEventListener('pointermove', onMove);
        h.addEventListener('pointerup', onUp);
        h.addEventListener('pointercancel', onUp);
    },

    /* ---------------------------------------------------------------- */
    /*                         Link popover                              */
    /* ---------------------------------------------------------------- */

    _setupLinkPopover() {
        const el = document.createElement('div');
        el.className = 're-link-popover';
        el.innerHTML = `
            <input type="url" class="re-link-url" placeholder="https://" autocomplete="off" />
            <button type="button" class="re-link-apply">Apply</button>
            <button type="button" class="re-link-cancel" title="Cancel">&#10005;</button>
        `;
        document.body.appendChild(el);
        this._linkPopoverEl = el;

        const urlInput = el.querySelector('.re-link-url');
        const applyBtn = el.querySelector('.re-link-apply');
        const cancelBtn = el.querySelector('.re-link-cancel');

        const apply = () => {
            const url = urlInput.value.trim();
            if (!url) { this._closeLinkPopover(); return; }
            // Restore the saved selection, then create the link.
            this._restoreSelection();
            const safe = /^(https?:|mailto:|tel:|#|\/|\.{1,2}\/)/i.test(url) ? url : ('https://' + url.replace(/^\/+/, ''));
            document.execCommand('createLink', false, safe);
            this._closeLinkPopover();
            this.editor.focus();
        };

        applyBtn.addEventListener('mousedown', (e) => { e.preventDefault(); apply(); });
        cancelBtn.addEventListener('mousedown', (e) => { e.preventDefault(); this._closeLinkPopover(); this.editor.focus(); });
        urlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); apply(); }
            if (e.key === 'Escape') { e.preventDefault(); this._closeLinkPopover(); this.editor.focus(); }
        });

        this._linkDocClickHandler = (e) => {
            if (!el.classList.contains('visible')) return;
            if (el.contains(e.target)) return;
            this._closeLinkPopover();
        };
        document.addEventListener('mousedown', this._linkDocClickHandler);
    },

    _openLinkPopover() {
        const el = this._linkPopoverEl;
        if (!el) return;

        // Persist the current selection so we can wrap it with the link
        // after the user finishes typing the URL.
        this._saveSelection();

        const sel = window.getSelection();
        let rect;
        if (sel && sel.rangeCount && !sel.isCollapsed && this.editor.contains(sel.getRangeAt(0).commonAncestorContainer)) {
            rect = sel.getRangeAt(0).getBoundingClientRect();
        } else {
            // No selection — anchor to the editor's caret position.
            rect = this.editor.getBoundingClientRect();
        }

        el.classList.add('visible');
        const tbRect = el.getBoundingClientRect();
        let top = rect.bottom + 8;
        let left = rect.left + (rect.width / 2) - (tbRect.width / 2);
        if (top + tbRect.height > window.innerHeight - 8) top = rect.top - tbRect.height - 8;
        const margin = 8;
        if (left < margin) left = margin;
        if (left + tbRect.width > window.innerWidth - margin) left = window.innerWidth - margin - tbRect.width;
        el.style.top = `${top}px`;
        el.style.left = `${left}px`;

        const input = el.querySelector('.re-link-url');
        input.value = '';
        // Prefill from existing link if the selection sits inside one.
        const a = this._closestAnchorInSelection();
        if (a) input.value = a.getAttribute('href') || '';

        // Hide the selection toolbar while the link popover is open so
        // they don't stack on top of each other.
        this._hideSelectionToolbar();

        setTimeout(() => input.focus(), 0);
    },

    _closeLinkPopover() {
        if (this._linkPopoverEl) this._linkPopoverEl.classList.remove('visible');
    },

    _saveSelection() {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
            this._savedRange = sel.getRangeAt(0).cloneRange();
        }
    },

    _restoreSelection() {
        if (!this._savedRange) return;
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(this._savedRange);
    },

    _closestAnchorInSelection() {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return null;
        let n = sel.getRangeAt(0).startContainer;
        if (n.nodeType === Node.TEXT_NODE) n = n.parentNode;
        while (n && n !== this.editor) {
            if (n.nodeName === 'A') return n;
            n = n.parentNode;
        }
        return null;
    },

    /* ---------------------------------------------------------------- */
    /*                          Word count                               */
    /* ---------------------------------------------------------------- */

    _emitWordCount() {
        if (!this._options || !this._options.onWordCount || !this.editor) return;
        const text = (this.editor.textContent || '').trim();
        const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
        const chars = text.length;
        // Roughly 220 wpm reading speed.
        const minutes = words > 0 ? Math.max(1, Math.round(words / 220)) : 0;
        try {
            this._options.onWordCount({ words, chars, readingMinutes: minutes });
        } catch (_) { /* ignore consumer errors */ }
    },

    /* ---------------------------------------------------------------- */
    /*                       Public API                                  */
    /* ---------------------------------------------------------------- */

    getHTML() {
        if (!this.editor) return '';
        return this.editor.innerHTML;
    },

    getText() {
        if (!this.editor) return '';
        return this.editor.textContent || '';
    },

    setHTML(html) {
        if (!this.editor) return;
        this.editor.innerHTML = html || '';
        // Repair notes saved before the boundary guard existed (e.g. a note
        // that is entirely a code block, with nowhere to click to add text).
        this._ensureBoundaryParagraphs();
        this._emitWordCount();
    },

    clear() {
        if (!this.editor) return;
        this.editor.innerHTML = '';
        this._emitWordCount();
    },

    focus() {
        if (!this.editor) return;
        this.editor.focus();
    },

    isEmpty() {
        if (!this.editor) return true;
        return this.getText().trim().length === 0;
    },

    /* ---------------------------------------------------------------- */
    /*                             Teardown                              */
    /* ---------------------------------------------------------------- */

    destroy() {
        if (this.autoSaveTimeout) {
            clearTimeout(this.autoSaveTimeout);
        }

        if (this.editor) {
            if (this.inputHandler) this.editor.removeEventListener('input', this.inputHandler);
            if (this.keydownHandler) this.editor.removeEventListener('keydown', this.keydownHandler);
            if (this._emptyClickHandler) this.editor.removeEventListener('mousedown', this._emptyClickHandler);
            if (this.pasteHandler) this.editor.removeEventListener('paste', this.pasteHandler);
            if (this._markdownInputHandler) this.editor.removeEventListener('beforeinput', this._markdownInputHandler);
            if (this._markdownEnterHandler) this.editor.removeEventListener('keydown', this._markdownEnterHandler);
            if (this._slashInputHandler) this.editor.removeEventListener('input', this._slashInputHandler);
            if (this._slashKeyHandler) this.editor.removeEventListener('keydown', this._slashKeyHandler, true);
        }

        if (this._selectionChangeHandler) {
            document.removeEventListener('selectionchange', this._selectionChangeHandler);
        }
        if (this._scrollHandler) {
            window.removeEventListener('scroll', this._scrollHandler, true);
        }
        if (this._slashClickHandler) {
            document.removeEventListener('mousedown', this._slashClickHandler);
        }
        if (this._linkDocClickHandler) {
            document.removeEventListener('mousedown', this._linkDocClickHandler);
        }
        if (this._tableSelectionHandler) {
            document.removeEventListener('selectionchange', this._tableSelectionHandler);
        }
        if (this._tableScrollHandler) {
            window.removeEventListener('scroll', this._tableScrollHandler, true);
        }
        if (this._tableHandleHover) {
            document.removeEventListener('mousemove', this._tableHandleHover);
        }
        document.body.classList.remove('re-col-dragging');

        if (this._selectionToolbarEl && this._selectionToolbarEl.parentNode) {
            this._selectionToolbarEl.parentNode.removeChild(this._selectionToolbarEl);
        }
        if (this._tableToolbarEl && this._tableToolbarEl.parentNode) {
            this._tableToolbarEl.parentNode.removeChild(this._tableToolbarEl);
        }
        if (this._tableHandlesEl && this._tableHandlesEl.parentNode) {
            this._tableHandlesEl.parentNode.removeChild(this._tableHandlesEl);
        }
        if (this._slashMenuEl && this._slashMenuEl.parentNode) {
            this._slashMenuEl.parentNode.removeChild(this._slashMenuEl);
        }
        if (this._linkPopoverEl && this._linkPopoverEl.parentNode) {
            this._linkPopoverEl.parentNode.removeChild(this._linkPopoverEl);
        }

        this.editor = null;
        this.toolbar = null;
        this.autoSaveCallback = null;
        this.inputHandler = null;
        this.keydownHandler = null;
        this._emptyClickHandler = null;
        this.pasteHandler = null;
        this._options = null;
        this._selectionToolbarEl = null;
        this._tableToolbarEl = null;
        this._tableSelectionHandler = null;
        this._tableScrollHandler = null;
        this._tableHandlesEl = null;
        this._tableHandleHover = null;
        this._handleTable = null;
        this._resizing = false;
        this._slashMenuEl = null;
        this._linkPopoverEl = null;
        this._selectionChangeHandler = null;
        this._scrollHandler = null;
        this._slashClickHandler = null;
        this._slashInputHandler = null;
        this._slashKeyHandler = null;
        this._markdownInputHandler = null;
        this._markdownEnterHandler = null;
        this._linkDocClickHandler = null;
        this._savedRange = null;
        this._slashOpen = false;
        this._slashTriggerNode = null;
    }
};
