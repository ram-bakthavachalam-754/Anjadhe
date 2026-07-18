/**
 * UI Utilities
 * Reusable UI components and helpers
 */

const UIUtils = {
    /**
     * Show a toast notification
     * @param {string} message - Message to display
     * @param {string} type - Type: 'success', 'error', 'warning'
     * @param {number} duration - Duration in ms (default: 3000)
     * @param {Object} [opts] - Optional inline action, e.g. Undo:
     *   { actionLabel: 'Undo', onAction: () => {...} }. When present the toast
     *   shows a button; clicking it runs onAction and dismisses immediately.
     */
    showToast(message, type = 'success', duration = 3000, opts = {}) {
        const container = document.getElementById('toast-container');

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;

        const icons = {
            success: '✓',
            error: '✕',
            warning: '⚠'
        };

        const actionHtml = opts.actionLabel
            ? `<button type="button" class="toast-action">${opts.actionLabel}</button>`
            : '';
        toast.innerHTML = `
            <span class="toast-icon">${icons[type] || '•'}</span>
            <span class="toast-message">${message}</span>
            ${actionHtml}
        `;

        container.appendChild(toast);

        let dismissed = false;
        const dismiss = () => {
            if (dismissed) return;
            dismissed = true;
            toast.style.animation = 'slideOutRight 0.3s ease-out';
            setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
        };

        if (opts.actionLabel) {
            const btn = toast.querySelector('.toast-action');
            btn.addEventListener('click', () => {
                try { opts.onAction && opts.onAction(); } finally { dismiss(); }
            });
        }

        setTimeout(dismiss, duration);
    },

    /**
     * Show confirmation dialog
     * @param {string} title - Dialog title
     * @param {string} message - Confirmation message
     * @param {string} icon - Icon emoji
     * @param {Object} [opts] - Optional button labels: { confirmText, cancelText }
     * @returns {Promise<boolean>}
     */
    confirm(title, message, icon = '❓', opts = {}) {
        return new Promise((resolve) => {
            const modal = Modal.create({
                title,
                className: 'confirm-dialog',
                content: `
                    <div class="confirm-icon">${icon}</div>
                    <div class="confirm-message">${message}</div>
                `,
                buttons: [
                    {
                        text: opts.cancelText || 'Cancel',
                        className: 'secondary-btn',
                        onClick: () => {
                            modal.close();
                            resolve(false);
                        }
                    },
                    {
                        text: opts.confirmText || 'Confirm',
                        className: 'primary-btn',
                        onClick: () => {
                            modal.close();
                            resolve(true);
                        }
                    }
                ]
            });
        });
    },

    /**
     * Format date to readable string
     * @param {Date|string} date
     * @returns {string}
     */
    formatDate(date) {
        const d = new Date(date);
        const now = new Date();
        const diffMs = now - d;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
        if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
        if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;

        return d.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    },

    /**
     * Format date for display
     * @param {Date|string} date
     * @returns {string}
     */
    formatDateTime(date) {
        const d = new Date(date);
        return d.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    },

    /**
     * Debounce function
     * @param {Function} func
     * @param {number} wait
     * @returns {Function}
     */
    debounce(func, wait = 300) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    },

    /**
     * Escape HTML to prevent XSS. Escapes quotes too, so the result is safe in
     * both text and attribute (title="…", href="…") contexts.
     * @param {string} text
     * @returns {string}
     */
    escapeHtml(text) {
        return String(text ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    /**
     * SECURITY (M11): sanitize a URL destined for an href/src. Model- and
     * remote-API-supplied URLs (search results, Yahoo company websites) must not
     * carry a javascript:/data:/vbscript: scheme — those execute or navigate in
     * the renderer origin on click. Returns the URL only if it's http(s), mailto,
     * tel, an in-page anchor, or a relative path; otherwise '#'.
     * @param {string} url
     * @returns {string}
     */
    safeHref(url) {
        const s = String(url ?? '').trim();
        return /^(https?:|mailto:|tel:|#|\/|\.{1,2}\/)/i.test(s) ? s : '#';
    },

    /**
     * Generate unique ID
     * @returns {string}
     */
    generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    },

    /**
     * Put a button into a busy state — disabled, spinner, optional replacement
     * label. Returns a function that restores the original label/state.
     *
     * Typical usage:
     *   const done = UIUtils.setButtonLoading(btn, 'Sending...');
     *   try { await doWork(); } finally { done(); }
     */
    setButtonLoading(btn, loadingLabel = null) {
        if (!btn) return () => {};
        const original = {
            html: btn.innerHTML,
            disabled: btn.disabled,
            ariaBusy: btn.getAttribute('aria-busy')
        };
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
        btn.classList.add('is-loading');
        const label = loadingLabel ? `<span class="btn-spinner-label">${this.escapeHtml(loadingLabel)}</span>` : '';
        btn.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span>${label}`;
        return () => {
            btn.innerHTML = original.html;
            btn.disabled = original.disabled;
            if (original.ariaBusy === null) btn.removeAttribute('aria-busy');
            else btn.setAttribute('aria-busy', original.ariaBusy);
            btn.classList.remove('is-loading');
        };
    }
};

// Add slideOutRight animation
const uiUtilsStyle = document.createElement('style');
uiUtilsStyle.textContent = `
    @keyframes slideOutRight {
        from {
            opacity: 1;
            transform: translateX(0);
        }
        to {
            opacity: 0;
            transform: translateX(100%);
        }
    }
`;
document.head.appendChild(uiUtilsStyle);
