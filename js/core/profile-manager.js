/**
 * ProfileManager — manages user profiles (Work, Personal, etc.)
 * Profiles are a filter lens on the same data store.
 * Each item gets a `profile` field; items without one belong to 'default'.
 */

const ProfileManager = {
    _storageKey: 'profiles',
    _cache: null,
    _profileAwareKeys: ['schedule', 'goals', 'focus', 'notes', 'tags', 'bookmarks', 'journal', 'email', 'portfolio', 'calendar', 'agent-conversations'],

    // The ACTIVE profile is per-window, not shared. The `profiles` blob holds
    // only the profile *definitions* (which are shared + synced across Macs).
    // The selection lives in this window's sessionStorage (survives reload,
    // but is isolated from other windows and never syncs), mirrored in memory.
    // Each new window therefore starts on 'default' until the user switches.
    _sessionKey: 'anjadhe.activeProfileId',
    _activeProfileId: null,

    // --- Storage (profile definitions only) ---

    _load() {
        if (this._cache) return this._cache;
        const data = StorageManager.get(this._storageKey);
        if (data && data.profiles && data.profiles.length > 0) {
            this._cache = data;
        } else {
            this._cache = {
                profiles: [{ id: 'default', name: 'Default', createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString() }]
            };
            this._save(this._cache);
        }
        return this._cache;
    },

    _save(data) {
        this._cache = data;
        StorageManager.set(this._storageKey, data);
    },

    _readSessionActive() {
        try { return window.sessionStorage.getItem(this._sessionKey); } catch (_) { return null; }
    },

    _writeSessionActive(id) {
        try { window.sessionStorage.setItem(this._sessionKey, id); } catch (_) {}
    },

    // --- Queries ---

    getProfiles() {
        return this._load().profiles;
    },

    getActiveProfileId() {
        // Seed once from this window's sessionStorage; new windows have none,
        // so they start on 'default'. Legacy blobs may still carry a synced
        // activeProfileId — we deliberately ignore it (selection is per-window).
        if (this._activeProfileId == null) {
            this._activeProfileId = this._readSessionActive() || 'default';
        }
        // If the chosen profile was deleted (possibly in another window), fall
        // back to default rather than filtering against a ghost id.
        const exists = this.getProfiles().some(p => p.id === this._activeProfileId);
        return exists ? this._activeProfileId : 'default';
    },

    getProfileName(profileId) {
        const profile = this.getProfiles().find(p => p.id === profileId);
        return profile ? profile.name : 'Default';
    },

    getActiveProfileName() {
        return this.getProfileName(this.getActiveProfileId());
    },

    // --- Mutations ---

    setActiveProfile(profileId) {
        // Per-window only: update this window's memory + sessionStorage. Do NOT
        // write to the shared `profiles` blob, so other windows and other Macs
        // keep their own active selection.
        this._activeProfileId = profileId;
        this._writeSessionActive(profileId);
        this._onProfileChanged();
    },

    createProfile(name) {
        const data = this._load();
        const id = 'prof_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const profile = { id, name: name.trim(), createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString() };
        data.profiles.push(profile);
        this._save(data);
        this.renderSwitcher();
        return profile;
    },

    renameProfile(profileId, newName) {
        if (profileId === 'default') return;
        const data = this._load();
        const profile = data.profiles.find(p => p.id === profileId);
        if (!profile) return;
        profile.name = newName.trim();
        profile.modifiedAt = new Date().toISOString();
        this._save(data);
        this.renderSwitcher();
        if (this.getActiveProfileId() === profileId) {
            this._updateSwitcherLabel();
        }
    },

    deleteProfile(profileId) {
        if (profileId === 'default') return;
        // Was this window on the deleted profile? Check the raw selection
        // (the getter would already have fallen back once it's gone).
        const wasActive = this._activeProfileId === profileId
            || this._readSessionActive() === profileId;
        const data = this._load();
        data.profiles = data.profiles.filter(p => p.id !== profileId);
        this._save(data);
        if (wasActive) {
            this._activeProfileId = 'default';
            this._writeSessionActive('default');
        }
        this._reassignItemsToDefault(profileId);
        this.renderSwitcher();
        this._onProfileChanged();
    },

    // --- Core Filter ---

    filterByActiveProfile(items) {
        const activeId = this.getActiveProfileId();
        return items.filter(item => (item.profile || 'default') === activeId);
    },

    getProfileForNewItem() {
        return this.getActiveProfileId();
    },

    // --- Reassign on delete ---

    _reassignItemsToDefault(profileId) {
        for (const key of this._profileAwareKeys) {
            const data = StorageManager.get(key);
            if (!data) continue;

            let changed = false;
            const arrayKeys = Object.keys(data);
            for (const ak of arrayKeys) {
                if (Array.isArray(data[ak])) {
                    for (const item of data[ak]) {
                        if (item.profile === profileId) {
                            item.profile = 'default';
                            changed = true;
                        }
                    }
                }
            }
            if (changed) {
                StorageManager.set(key, data);
            }
        }
    },

    // --- UI: Titlebar Switcher ---

    init() {
        this._load();
        this.renderSwitcher();
        this._attachSwitcherListeners();
    },

    renderSwitcher() {
        const dropdown = document.getElementById('profile-switcher-dropdown');
        if (!dropdown) return;

        const profiles = this.getProfiles();
        const activeId = this.getActiveProfileId();

        let html = '';

        for (const p of profiles) {
            html += `<button class="profile-switcher-item ${p.id === activeId ? 'active' : ''}" data-profile-id="${p.id}">${p.name}</button>`;
        }

        html += '<div class="profile-switcher-divider"></div>';
        html += `<button class="profile-switcher-item profile-switcher-action" id="profile-switcher-new">+ New Profile</button>`;
        html += `<button class="profile-switcher-item profile-switcher-action" id="profile-switcher-manage">Manage Profiles</button>`;

        dropdown.innerHTML = html;
        this._updateSwitcherLabel();

        // Re-attach item click listeners
        dropdown.querySelectorAll('.profile-switcher-item[data-profile-id]').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = item.dataset.profileId;
                this.setActiveProfile(id);
                dropdown.classList.remove('open');
            });
        });

        // New profile action
        const newBtn = document.getElementById('profile-switcher-new');
        if (newBtn) {
            newBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                dropdown.classList.remove('open');
                this._showNewProfileModal();
            });
        }

        // Manage profiles action
        const manageBtn = document.getElementById('profile-switcher-manage');
        if (manageBtn) {
            manageBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                dropdown.classList.remove('open');
                AppManager.openApp('settings');
                setTimeout(() => SettingsApp.openProfileSettings(), 0);
            });
        }
    },

    _updateSwitcherLabel() {
        const label = document.getElementById('profile-switcher-label');
        if (label) {
            label.textContent = this.getActiveProfileName();
        }
    },

    _attachSwitcherListeners() {
        const btn = document.getElementById('profile-switcher-btn');
        const dropdown = document.getElementById('profile-switcher-dropdown');
        if (!btn || !dropdown) return;

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.classList.toggle('open');
        });

        // Close on outside click
        document.addEventListener('click', () => {
            dropdown.classList.remove('open');
        });
    },

    // --- Profile Change Handler ---

    _onProfileChanged() {
        this._updateSwitcherLabel();
        this.renderSwitcher();

        // Re-render dashboard
        if (typeof AppManager !== 'undefined') {
            AppManager.updateStats();

            // Re-render current app if open
            const current = AppManager.currentApp;
            if (current && AppManager.apps[current]) {
                const app = AppManager.apps[current];
                if (app.render) app.render();
            }
        }
    },

    // --- Modals ---

    _showNewProfileModal(onCreated) {
        let modal;
        modal = Modal.create({
            title: 'New Profile',
            content: `
                <div class="form-group">
                    <label class="form-label">Profile Name</label>
                    <input type="text" id="new-profile-name-input" placeholder="e.g. Work, Personal...">
                </div>
            `,
            buttons: [
                { text: 'Cancel', className: 'secondary-btn', onClick: () => modal.close() },
                {
                    text: 'Create',
                    className: 'primary-btn',
                    onClick: () => {
                        const input = document.getElementById('new-profile-name-input');
                        const name = (input?.value || '').trim();
                        if (!name) {
                            UIUtils.showToast('Please enter a name', 'error');
                            return;
                        }
                        const profile = this.createProfile(name);
                        this.setActiveProfile(profile.id);
                        modal.close();
                        UIUtils.showToast(`Profile "${name}" created`, 'success');
                        if (onCreated) onCreated(profile);
                    }
                }
            ]
        });
        setTimeout(() => document.getElementById('new-profile-name-input')?.focus(), 100);
    },

    _showRenameProfileModal(profileId, currentName, onRenamed) {
        let modal;
        modal = Modal.create({
            title: 'Rename Profile',
            content: `
                <div class="form-group">
                    <label class="form-label">Profile Name</label>
                    <input type="text" id="rename-profile-name-input" value="${currentName}">
                </div>
            `,
            buttons: [
                { text: 'Cancel', className: 'secondary-btn', onClick: () => modal.close() },
                {
                    text: 'Save',
                    className: 'primary-btn',
                    onClick: () => {
                        const input = document.getElementById('rename-profile-name-input');
                        const name = (input?.value || '').trim();
                        if (!name) {
                            UIUtils.showToast('Please enter a name', 'error');
                            return;
                        }
                        this.renameProfile(profileId, name);
                        modal.close();
                        UIUtils.showToast('Profile renamed', 'success');
                        if (onRenamed) onRenamed();
                    }
                }
            ]
        });
        setTimeout(() => {
            const input = document.getElementById('rename-profile-name-input');
            if (input) { input.focus(); input.select(); }
        }, 100);
    }
};
