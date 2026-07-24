/**
 * NavResizer — the ONE drag-to-resize handle for two-pane sidebar layouts
 * (Tasks and Plan navs; the Schedule view keeps its original inline copy).
 * Dragging updates the width live via a CSS custom property on the layout;
 * mouse-up persists it per-machine (localStorage); double-click resets.
 */

const NavResizer = {
    /**
     * @param {Object} o
     *   o.layoutSel   selector for the layout element carrying the width var
     *   o.resizerId   id of the handle element
     *   o.cssVar      custom property name (e.g. '--actions-nav-width')
     *   o.storageKey  localStorage key for the saved width
     *   o.defaultW    default width in px
     *   o.min / o.max clamp range in px
     */
    attach({ layoutSel, resizerId, cssVar, storageKey, defaultW, min = 140, max = 360 }) {
        const resizer = document.getElementById(resizerId);
        if (!resizer) return;
        // Replace the node to drop listeners from any earlier init() pass.
        const fresh = resizer.cloneNode(true);
        resizer.parentNode.replaceChild(fresh, resizer);

        const apply = (width) => {
            const w = Math.round(Math.min(max, Math.max(min, width)));
            const layout = document.querySelector(layoutSel);
            if (layout) layout.style.setProperty(cssVar, w + 'px');
            return w;
        };
        const current = () => {
            const layout = document.querySelector(layoutSel);
            const w = parseInt(layout?.style.getPropertyValue(cssVar), 10);
            return Number.isFinite(w) ? w : defaultW;
        };
        const save = (width) => {
            try { localStorage.setItem(storageKey, String(width)); } catch (_) { /* ignore */ }
        };

        // Restore the width saved on this machine (default otherwise).
        let saved = defaultW;
        try {
            const raw = parseInt(localStorage.getItem(storageKey), 10);
            if (Number.isFinite(raw)) saved = raw;
        } catch (_) { /* ignore */ }
        apply(saved);

        let startX = 0;
        let startWidth = 0;
        const onMove = (e) => { apply(startWidth + (e.clientX - startX)); };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            fresh.classList.remove('dragging');
            document.body.classList.remove('nav-resizing');
            save(current());
        };

        fresh.addEventListener('mousedown', (e) => {
            e.preventDefault();
            startX = e.clientX;
            startWidth = current();
            fresh.classList.add('dragging');
            document.body.classList.add('nav-resizing');
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        // Double-click the handle to snap back to the default width.
        fresh.addEventListener('dblclick', () => { save(apply(defaultW)); });
    }
};
