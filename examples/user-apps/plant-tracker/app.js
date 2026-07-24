/**
 * Plant Tracker — reference user app for the Anjadhe platform.
 *
 * Demonstrates the full v1 contract (docs/PLATFORM.md):
 *   - Anjadhe.registerApp() at script-evaluation time
 *   - anjadhe.storage for persistence (synced + backed up automatically)
 *   - anjadhe.registerTool so the AI assistant can see the app's data
 *   - rendering into the #<id>-view container with design-system CSS
 */

Anjadhe.registerApp({

    init() {
        if (this._initialized) return;
        this._initialized = true;

        // Let the assistant answer "which plants need watering?" — the tool
        // ships in the prompt only when a message mentions the manifest
        // keywords (plant, water, ...).
        anjadhe.registerTool({
            type: 'function',
            function: {
                name: 'plant_tracker_list',
                description: 'List houseplants with last watered date and days since watering.',
                parameters: { type: 'object', properties: {} }
            }
        }, () => ({
            plants: this._plants().map(p => ({
                name: p.name,
                lastWatered: p.lastWatered,
                daysSinceWatered: this._daysSince(p.lastWatered)
            }))
        }));
    },

    render() {
        const view = document.getElementById('plant-tracker-view');
        if (!view) return;
        const esc = Anjadhe.ui.escapeHtml;
        const plants = this._plants();

        const rows = plants.map((p, i) => `
            <div class="plant-row">
                <div class="plant-row-main">
                    <span class="plant-name">${esc(p.name)}</span>
                    <span class="plant-meta">${this._wateredLabel(p.lastWatered)}</span>
                </div>
                <div class="plant-row-actions">
                    <button class="plant-water-btn" data-index="${i}">Watered today</button>
                    <button class="plant-delete-btn" data-index="${i}" title="Remove">&times;</button>
                </div>
            </div>`).join('');

        view.innerHTML = `
            <div class="plant-tracker">
                <header class="plant-header">
                    <h1>Plants</h1>
                    <p class="plant-subtitle">Houseplants and when you last watered them.</p>
                </header>
                <form class="plant-add-form" id="plant-add-form">
                    <input type="text" id="plant-add-input" placeholder="Add a plant..." maxlength="60">
                    <button type="submit" class="plant-add-btn">Add</button>
                </form>
                <div class="plant-list">
                    ${rows || '<p class="plant-empty">No plants yet. Add your first one above.</p>'}
                </div>
            </div>`;

        view.querySelector('#plant-add-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const input = view.querySelector('#plant-add-input');
            const name = input.value.trim();
            if (!name) return;
            const plants = this._plants();
            plants.push({ name, lastWatered: this._today() });
            anjadhe.storage.set('plants', plants);
            this.render();
        });

        view.querySelectorAll('.plant-water-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const plants = this._plants();
                plants[Number(btn.dataset.index)].lastWatered = this._today();
                anjadhe.storage.set('plants', plants);
                this.render();
            });
        });

        view.querySelectorAll('.plant-delete-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const plants = this._plants();
                plants.splice(Number(btn.dataset.index), 1);
                anjadhe.storage.set('plants', plants);
                this.render();
            });
        });
    },

    _plants() {
        return anjadhe.storage.get('plants') || [];
    },

    _today() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },

    _daysSince(dateStr) {
        if (!dateStr) return null;
        const then = new Date(dateStr + 'T00:00:00');
        return Math.max(0, Math.floor((Date.now() - then.getTime()) / 86400000));
    },

    _wateredLabel(dateStr) {
        const days = this._daysSince(dateStr);
        if (days === null) return 'never watered';
        if (days === 0) return 'watered today';
        if (days === 1) return 'watered yesterday';
        return `watered ${days} days ago`;
    }
});
