/**
 * Storage Manager
 * Interface for storage via Electron (SQLite backend)
 */

const StorageManager = {
    /**
     * Get data for a specific app
     * @param {string} appName - Name of the app
     * @returns {object} App data
     */
    get(appName) {
        try {
            return window.electronStore.get(`app_${appName}`) || null;
        } catch (error) {
            console.error(`Error reading ${appName} data:`, error);
            return null;
        }
    },

    /**
     * Save data for a specific app
     * @param {string} appName - Name of the app
     * @param {object} data - Data to save
     */
    set(appName, data) {
        try {
            window.electronStore.set(`app_${appName}`, data);
            return true;
        } catch (error) {
            console.error(`Error saving ${appName} data:`, error);
            return false;
        }
    },

    /**
     * Get all data from all apps
     * @returns {object} All app data
     */
    getAll() {
        const allData = {};
        const store = window.electronStore.getAll();
        for (const key in store) {
            if (key.startsWith('app_')) {
                const appName = key.replace('app_', '');
                allData[appName] = store[key];
            }
        }
        return allData;
    },

    /**
     * Clear data for a specific app
     * @param {string} appName - Name of the app
     */
    clear(appName) {
        try {
            window.electronStore.delete(`app_${appName}`);
            return true;
        } catch (error) {
            console.error(`Error clearing ${appName} data:`, error);
            return false;
        }
    },

    /**
     * Clear all app data
     */
    clearAll() {
        try {
            window.electronStore.clear();
            return true;
        } catch (error) {
            console.error('Error clearing all data:', error);
            return false;
        }
    },

    /**
     * Get storage usage information
     * @returns {object} Storage stats
     */
    getStorageInfo() {
        let totalSize = 0;
        const appSizes = {};

        const store = window.electronStore.getAll();
        for (const key in store) {
            if (key.startsWith('app_')) {
                const value = JSON.stringify(store[key]);
                const size = new Blob([value]).size;
                const appName = key.replace('app_', '');
                appSizes[appName] = size;
                totalSize += size;
            }
        }

        return {
            totalSize,
            totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
            appSizes,
            itemCount: Object.keys(appSizes).length
        };
    },

    /**
     * Get storage file path
     * @returns {string}
     */
    getStoragePath() {
        return window.electronStore.getPath();
    }
};
