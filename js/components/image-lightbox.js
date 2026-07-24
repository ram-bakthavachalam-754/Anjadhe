/**
 * ImageLightbox — double-click any image inside an editable surface
 * (note body, journal entry) to view it full-screen. Click the image to
 * toggle actual-size zoom; click the backdrop, the × button, or press
 * Escape to close.
 */

const ImageLightbox = {
    _wired: false,

    init() {
        if (this._wired) return;
        this._wired = true;

        document.addEventListener('dblclick', (e) => {
            const img = e.target && e.target.closest && e.target.closest('img');
            if (!img || !img.src) return;
            if (!img.closest('[contenteditable="true"]')) return;
            e.preventDefault();
            // Drop the browser's dbl-click selection of the image node so
            // closing the lightbox doesn't leave it highlighted.
            window.getSelection()?.removeAllRanges();
            this.open(img.src);
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && document.getElementById('image-lightbox')) {
                e.preventDefault();
                e.stopPropagation();
                this.close();
            }
        }, true);
    },

    open(src) {
        this.close();
        const overlay = document.createElement('div');
        overlay.id = 'image-lightbox';
        overlay.className = 'image-lightbox';
        overlay.innerHTML = `
            <button type="button" class="image-lightbox-close" aria-label="Close">&times;</button>
            <img src="${src}" alt="">
        `;
        document.body.appendChild(overlay);
        document.body.classList.add('image-lightbox-open');

        overlay.addEventListener('click', (e) => {
            if (e.target.closest('.image-lightbox-close')) { this.close(); return; }
            if (e.target.tagName === 'IMG') {
                overlay.classList.toggle('is-zoomed');
                return;
            }
            this.close(); // backdrop
        });
    },

    close() {
        document.getElementById('image-lightbox')?.remove();
        document.body.classList.remove('image-lightbox-open');
    }
};

ImageLightbox.init();
