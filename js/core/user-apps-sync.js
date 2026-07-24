/**
 * UserAppsSync — syncs user-built app folders across Macs (docs/PLATFORM.md).
 *
 * App code is small text, so it rides the existing encrypted kv journal:
 * each app folder maps to one store key `userappsrc-<dir>` holding the file
 * contents plus a deleted flag (tombstone). The journal's per-key
 * last-writer-wins merge gives per-app conflict resolution for free — the
 * same semantics as every other synced blob in the app.
 *
 * Loop prevention is content comparison, not flags: import only touches
 * disk when it differs from the store, export only touches the store when
 * it differs from disk. The hot-reload event caused by an import therefore
 * exports nothing, and the ping-pong stops after one hop.
 */

const UserAppsSync = {
    PREFIX: 'userappsrc-',

    init() {
        if (!this._available()) return;
        // Merges run in main on startup/refresh; if one lands mid-session
        // (forced merge, another window refreshing), reconcile again.
        window.electronSync?.onMergeResult?.((result) => {
            if (result?.merged > 0) {
                this.reconcile().catch(e => console.error('User app sync reconcile failed:', e));
            }
        });
    },

    _available() {
        return !!(window.electronApps?.list && window.electronStore?.keysWithPrefix);
    },

    /**
     * Two-way startup pass: apply remote state to disk, then publish local
     * state the store hasn't seen. Import runs first so a freshly merged
     * remote edit wins over stale local files (LWW, consistent with the
     * rest of the app); dirs the import touched are excluded from export.
     */
    async reconcile() {
        if (!this._available()) return;
        const entries = await window.electronApps.list();
        const byDir = {};
        for (const e of entries) byDir[e.dir] = e;
        const records = this._records();
        const touched = new Set();

        for (const dir in records) {
            const rec = records[dir];
            if (rec.deleted) {
                if (byDir[dir]) {
                    await window.electronApps.deleteFolder(dir);
                    touched.add(dir);
                }
                continue;
            }
            if (!rec.files) continue;
            const disk = byDir[dir];
            if (!disk || disk.error || !this._same(rec.files, this._filesOf(disk))) {
                await this._writeToDisk(dir, rec.files);
                touched.add(dir);
            }
        }

        for (const e of entries) {
            if (e.error || touched.has(e.dir)) continue;
            const rec = records[e.dir];
            if (rec?.deleted) continue; // tombstone wins this round
            const files = this._filesOf(e);
            if (rec && this._same(rec.files, files)) continue;
            this._setRecord(e.dir, { files, deleted: false });
        }
    },

    /**
     * Publish local changes for specific app dirs. Called from
     * AppManager._reloadUserApps after the file watcher reports a change —
     * which covers App Studio builds, terminal coding agents, and manual
     * edits alike. A missing folder with an existing record becomes a
     * tombstone so other Macs delete it too.
     */
    async exportDirs(dirs) {
        if (!this._available() || !Array.isArray(dirs) || !dirs.length) return;
        const entries = await window.electronApps.list();
        const byDir = {};
        for (const e of entries) byDir[e.dir] = e;
        const records = this._records();

        for (const dir of dirs) {
            const e = byDir[dir];
            const rec = records[dir];
            if (!e) {
                if (rec && !rec.deleted) this._setRecord(dir, { files: null, deleted: true });
                continue;
            }
            if (e.error) continue; // half-written folder; the next event re-runs
            const files = this._filesOf(e);
            if (rec && !rec.deleted && this._same(rec.files, files)) continue;
            this._setRecord(dir, { files, deleted: false });
        }
    },

    _records() {
        const out = {};
        const storePrefix = 'app_' + this.PREFIX;
        for (const key of window.electronStore.keysWithPrefix(storePrefix) || []) {
            const dir = key.slice(storePrefix.length);
            const rec = StorageManager.get(this.PREFIX + dir);
            if (rec) out[dir] = rec;
        }
        return out;
    },

    _setRecord(dir, rec) {
        StorageManager.set(this.PREFIX + dir, { ...rec, modifiedAt: new Date().toISOString() });
    },

    SYNCED_FILES: ['manifest.json', 'app.js', 'app.spec.json', 'app.css'],

    _filesOf(entry) {
        return {
            'manifest.json': entry.manifestRaw,
            'app.js': entry.js,
            'app.spec.json': entry.spec,
            'app.css': entry.css || ''
        };
    },

    _same(a, b) {
        if (!a || !b) return false;
        return this.SYNCED_FILES.every(name => (a[name] ?? '') === (b[name] ?? ''));
    },

    async _writeToDisk(dir, files) {
        for (const name of this.SYNCED_FILES) {
            const content = files[name];
            if (typeof content !== 'string' || (name === 'app.css' && !content)) continue;
            const result = await window.electronApps.writeFile(dir, name, content);
            if (result?.error) {
                console.error(`User app sync: writing ${dir}/${name} failed: ${result.error}`);
                return;
            }
        }
    }
};
