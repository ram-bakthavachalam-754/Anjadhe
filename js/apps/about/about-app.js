/**
 * About App
 * Shows app overview — same content as the home page welcome screen
 */

const AboutApp = {
    init() {
        Breadcrumb.render('about-breadcrumb', [
            { label: 'About' }
        ]);
    },

    render() {
        const view = document.getElementById('about-view');
        if (!view.dataset.bound) {
            view.dataset.bound = 'true';
            view.querySelectorAll('[data-app]').forEach(card => {
                card.addEventListener('click', () => {
                    AppManager.openApp(card.dataset.app);
                });
            });
            document.getElementById('about-alpha-pill')?.addEventListener('click', () => {
                this.showAlphaInfo();
            });
            document.getElementById('about-source-link')?.addEventListener('click', (e) => {
                e.preventDefault();
                window.electronAuth?.openExternal?.('https://github.com/Anjadhe/Anjadhe');
            });
        }
    },

    // "Closed Alpha" pill (About header) → what that phase means.
    showAlphaInfo() {
        Modal.create({
            title: 'Closed Alpha',
            className: 'about-alpha-modal',
            content: `
                <p>
                    Closed alpha means the app is usable end-to-end but still being shaped with a small group of early users.
                    Features may change, move, or be rewritten; rough edges are expected; and occasional breakage is part of the deal.
                </p>
                <p>
                    Your data stays on your Mac &mdash; closed alpha applies to the product, not your files.
                    Auto-updates ship frequently, so you&rsquo;ll usually be on the latest build within a day of a fix.
                    If something feels wrong or missing, that&rsquo;s exactly the kind of feedback this phase is for.
                </p>`,
        });
    }
};

AppManager.register('about', AboutApp);
