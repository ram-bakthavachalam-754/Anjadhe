/**
 * TagPicker
 *
 * Floating popover for picking from a list of existing tags or creating a
 * new one. Anchored below a trigger button. Used by Notes and Journal so
 * the "+ Add tag" affordance behaves the same in both places.
 *
 * Usage:
 *   TagPicker.open({
 *       anchor: btnEl,
 *       suggestions: ['work', 'ideas'],
 *       selected: ['work'],
 *       placeholder: 'Search or create…',
 *       container: dialogEl,   // optional — see below
 *       onAdd: (name) => { ... }
 *   });
 *
 * By default the popover is appended to <body>. Pass `container` when the
 * anchor lives inside an element that renders in the top layer (e.g. a
 * <dialog> opened with showModal()) — a body-level popover would otherwise
 * be painted behind it. Positioning stays correct either way.
 *
 * onAdd fires when the user picks an existing tag or commits a new name.
 * The popover stays open after a pick so multiple tags can be added in
 * a row; user clicks outside (or hits Escape) to dismiss.
 */
const TagPicker = {
    _el: null,
    _docHandler: null,
    _keyHandler: null,
    _config: null,

    open(config) {
        this.close();
        this._config = config;

        const el = document.createElement('div');
        el.className = 'tag-picker-popover';
        el.innerHTML = `
            <input type="text" class="tag-picker-search" placeholder="${config.placeholder || 'Search or create…'}" autocomplete="off">
            <div class="tag-picker-list" role="listbox"></div>
        `;
        (config.container || document.body).appendChild(el);
        this._el = el;

        // `position: fixed` is relative to the viewport unless an ancestor
        // establishes a containing block (e.g. a <dialog> with a transform).
        // Measure the containing block's origin so the popover lands under
        // the anchor regardless of where it was appended.
        const rect = config.anchor.getBoundingClientRect();
        el.style.top = '0px';
        el.style.left = '0px';
        const origin = el.getBoundingClientRect();
        el.style.top = `${rect.bottom + 6 - origin.top}px`;
        el.style.left = `${rect.left - origin.left}px`;

        const search = el.querySelector('.tag-picker-search');
        const list = el.querySelector('.tag-picker-list');

        const render = (query = '') => {
            const q = query.trim().toLowerCase();
            const selected = new Set((config.selected || []).map(s => s.toLowerCase()));
            const all = (config.suggestions || []).filter(Boolean);
            const filtered = q
                ? all.filter(t => t.toLowerCase().includes(q))
                : all;
            const exact = all.some(t => t.toLowerCase() === q);

            let html = '';
            if (filtered.length === 0 && !q) {
                html = '<div class="tag-picker-empty">No tags yet</div>';
            } else {
                html = filtered.map(name => {
                    const isSelected = selected.has(name.toLowerCase());
                    return `
                        <button type="button" class="tag-picker-item" data-name="${this._escape(name)}" ${isSelected ? 'data-selected="true" disabled' : ''}>
                            <span>${this._escape(name)}</span>
                            ${isSelected ? '<span class="tag-picker-check">&#10003;</span>' : ''}
                        </button>
                    `;
                }).join('');
            }

            if (q && !exact) {
                html += `
                    <button type="button" class="tag-picker-item tag-picker-create" data-create="${this._escape(query.trim())}">
                        <span>+ Create &ldquo;${this._escape(query.trim())}&rdquo;</span>
                    </button>
                `;
            }

            list.innerHTML = html;
        };

        render('');
        setTimeout(() => search.focus(), 0);

        search.addEventListener('input', () => render(search.value));

        list.addEventListener('click', (e) => {
            const btn = e.target.closest('.tag-picker-item');
            if (!btn || btn.disabled) return;
            const name = btn.dataset.create || btn.dataset.name;
            if (name) {
                config.onAdd?.(name);
                config.selected = [...(config.selected || []), name];
                search.value = '';
                render('');
                search.focus();
            }
        });

        search.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const first = list.querySelector('.tag-picker-item:not([disabled])');
                if (first) first.click();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.close();
            }
        });

        // Close on click outside
        this._docHandler = (e) => {
            if (!this._el) return;
            if (this._el.contains(e.target)) return;
            if (e.target === config.anchor) return;
            this.close();
        };
        // Defer to avoid catching the click that opened the picker.
        setTimeout(() => document.addEventListener('mousedown', this._docHandler), 0);

        this._keyHandler = (e) => {
            if (e.key === 'Escape') this.close();
        };
        document.addEventListener('keydown', this._keyHandler);
    },

    close() {
        if (this._el) {
            this._el.remove();
            this._el = null;
        }
        if (this._docHandler) {
            document.removeEventListener('mousedown', this._docHandler);
            this._docHandler = null;
        }
        if (this._keyHandler) {
            document.removeEventListener('keydown', this._keyHandler);
            this._keyHandler = null;
        }
        this._config?.onClose?.();
        this._config = null;
    },

    _escape(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
};

if (typeof window !== 'undefined') window.TagPicker = TagPicker;
