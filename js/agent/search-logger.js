/**
 * Search Logger — minimal transparency log for web searches.
 *
 * The intent is to show exactly what text left this machine for the search
 * provider, not to mirror the response. We store the query, timestamp,
 * duration, result count, provider, and error (if any). Titles, URLs, and
 * snippets from the provider are deliberately not persisted.
 */

const SearchLogger = {
    logs: [],
    maxLogs: 100,
    _storageKey: 'search-logs',

    loadFromStorage() {
        try {
            const saved = StorageManager.get(this._storageKey);
            if (Array.isArray(saved)) {
                this.logs = saved.slice(0, this.maxLogs);
            }
        } catch (e) {
            console.warn('Failed to load search logs from storage:', e);
        }
    },

    _persist() {
        try {
            StorageManager.set(this._storageKey, this.logs);
        } catch (e) {
            console.warn('Failed to persist search logs:', e);
        }
    },

    record({ query, durationMs, results, error, provider }) {
        const entry = {
            id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
            timestamp: new Date().toISOString(),
            query: String(query || ''),
            provider: provider || null,
            durationMs: durationMs != null ? Math.round(durationMs) : null,
            resultCount: Array.isArray(results) ? results.length : 0,
            error: error || null
        };
        this.logs.unshift(entry);
        if (this.logs.length > this.maxLogs) {
            this.logs = this.logs.slice(0, this.maxLogs);
        }
        this._persist();
    },

    clear() {
        this.logs = [];
        this._persist();
    }
};
