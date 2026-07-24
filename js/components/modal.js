/**
 * Modal Component
 * Using native HTML5 <dialog> element
 */

const Modal = {
    /**
     * Create and show a modal
     * @param {Object} options - Modal configuration
     * @returns {Object} Modal instance
     */
    create(options = {}) {
        const {
            title = 'Modal',
            content = '',
            className = '',
            buttons = [],
            onClose = null
        } = options;

        // Create dialog element
        const dialog = document.createElement('dialog');
        dialog.className = `modal ${className}`;

        // Modal header
        const header = document.createElement('div');
        header.className = 'modal-header';
        header.innerHTML = `
            <h3 class="modal-title">${title}</h3>
            <button class="modal-close" type="button" aria-label="Close">×</button>
        `;

        // Modal body
        const body = document.createElement('div');
        body.className = 'modal-body';

        if (typeof content === 'string') {
            body.innerHTML = content;
        } else {
            body.appendChild(content);
        }

        // Modal footer (if buttons provided)
        let footer = null;
        if (buttons.length > 0) {
            footer = document.createElement('div');
            footer.className = 'modal-footer';

            buttons.forEach(btn => {
                const button = document.createElement('button');
                button.className = btn.className || 'secondary-btn';
                button.textContent = btn.text || 'Button';
                button.type = 'button';
                button.onclick = btn.onClick || (() => { closeModal(); });
                footer.appendChild(button);
            });
        }

        // Assemble modal
        dialog.appendChild(header);
        dialog.appendChild(body);
        if (footer) {
            dialog.appendChild(footer);
        }

        // Add to document
        document.body.appendChild(dialog);

        // Close handlers
        let closed = false;
        const closeModal = () => {
            if (closed) return;
            closed = true;
            dialog.close();
            if (onClose) onClose();
            setTimeout(() => {
                if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
            }, 100);
        };

        const closeBtn = header.querySelector('.modal-close');
        closeBtn.onclick = closeModal;

        // Click outside to close. A backdrop click targets the <dialog>
        // element itself; clicks on content target children. Guarding on the
        // target (not just coordinates) keeps keyboard activation of inner
        // buttons — whose click events fire at (0,0) — from closing the modal.
        dialog.addEventListener('click', (e) => {
            if (e.target !== dialog) return;
            const rect = dialog.getBoundingClientRect();
            if (
                e.clientX < rect.left ||
                e.clientX > rect.right ||
                e.clientY < rect.top ||
                e.clientY > rect.bottom
            ) {
                closeModal();
            }
        });

        // ESC key to close (native dialog behavior)
        dialog.addEventListener('cancel', (e) => {
            e.preventDefault();
            closeModal();
        });

        // Show modal
        dialog.showModal();

        // Return modal instance
        return {
            element: dialog,
            body,
            close: closeModal
        };
    }
};
