/**
 * Calendar App — Google Calendar integration
 * Connects via OAuth, displays events in month/week/day views,
 * supports create, edit, and delete operations.
 */

const CalendarApp = {
    events: [],
    accounts: [],
    calendars: [],
    currentView: 'week', // month | week | day
    currentDate: new Date(),
    selectedEvent: null,
    isSyncing: false,
    lastSyncTime: null,
    syncTimer: null,
    showTasks: true,

    init() {
        this.loadData();
        this.bindEvents();
        this.startAutoSync();
        // AppManager calls init() on every navigation here, so this is the
        // "user opened the calendar" hook — pull fresh events right away
        // instead of making them wait out the 5-minute timer.
        this.syncIfStale();
    },

    // Sync from Google unless the cache is fresher than maxAgeMs. Used by
    // app-open (above) and the agent's calendar tools so on-demand reads
    // reflect what's actually on Google, not a stale local cache.
    syncIfStale(maxAgeMs = 60 * 1000) {
        if (this.isSyncing || this.getAccounts().length === 0) return Promise.resolve();
        const last = this.lastSyncTime ? new Date(this.lastSyncTime).getTime() : 0;
        if (Date.now() - last < maxAgeMs) return Promise.resolve();
        return this.syncEvents();
    },

    loadData() {
        const data = StorageManager.get('calendar') || {};
        this.accounts = data.accounts || [];
        this.events = this._dedupEvents((data.events || []).map(e => ({
            ...e,
            start: e.start ? new Date(e.start) : null,
            end: e.end ? new Date(e.end) : null
        })));
        this.calendars = data.calendars || [];
        this.lastSyncTime = data.lastSyncTime || null;
        this.showTasks = data.showTasks !== false;
        if (['month', 'week', 'day'].includes(data.currentView)) {
            this.currentView = data.currentView;
        }
    },

    // All-day events arrive from Google as date-only strings ("2026-07-16").
    // new Date("2026-07-16") parses as UTC midnight — the previous *evening*
    // in western timezones — so a tomorrow all-day event rendered on today.
    // Date-only values must be parsed as LOCAL midnight.
    _parseEventDate(value) {
        if (!value) return null;
        if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
            const [y, m, d] = value.split('-').map(Number);
            return new Date(y, m - 1, d);
        }
        return new Date(value);
    },

    // Shape a synced Google event into the local store's event record.
    _toLocalEvent(ev, accountEmail) {
        return {
            id: ev.id,
            calendarId: ev.calendarId || 'primary',
            summary: ev.summary || '(No title)',
            description: ev.description || '',
            location: ev.location || '',
            start: this._parseEventDate(ev.start),
            end: this._parseEventDate(ev.end),
            allDay: ev.allDay || false,
            account: accountEmail,
            htmlLink: ev.htmlLink || '',
            status: ev.status || 'confirmed',
            colorId: ev.colorId || null,
            attendees: ev.attendees || [],
            recurrence: ev.recurrence || null,
            recurringEventId: ev.recurringEventId || null
        };
    },

    // Collapse any duplicate rows that share the same (account, id) pair.
    // Duplicates can slip in if a previous sync filtered by a stale account
    // string (e.g., before an account rename) and failed to clear the old
    // rows before pushing fresh ones. Keep the last occurrence so the most
    // recently synced version wins.
    _dedupEvents(events) {
        const byKey = new Map();
        for (const ev of events) {
            if (!ev?.id) continue;
            byKey.set(`${ev.account || ''}::${ev.id}`, ev);
        }
        return Array.from(byKey.values());
    },

    saveData() {
        StorageManager.set('calendar', {
            accounts: this.accounts,
            events: this.events.map(e => ({
                ...e,
                start: e.start ? e.start.toISOString() : null,
                end: e.end ? e.end.toISOString() : null
            })),
            calendars: this.calendars,
            lastSyncTime: this.lastSyncTime,
            showTasks: this.showTasks,
            currentView: this.currentView
        });
    },

    render() {
        // Ensure Schedule data is hydrated — a user may open Calendar before
        // ever visiting Schedule, in which case ScheduleApp.scheduleItems is
        // still the empty default and we'd render an empty calendar.
        if (typeof ScheduleApp !== 'undefined' && typeof ScheduleApp.loadData === 'function') {
            ScheduleApp.loadData();
        }
        CalendarUI.render();
    },

    bindEvents() {
        // Always re-render the breadcrumb (the target container may have been
        // re-mounted), but only wire up button listeners once. AppManager
        // calls init() — and therefore bindEvents() — every time the user
        // navigates to this app; without this guard, each navigation stacks
        // another listener on every button, and clicking Save would fire
        // saveEvent N times, creating N duplicate events on Google.
        Breadcrumb.render('calendar-breadcrumb', [
            { label: 'Calendar' }
        ]);
        if (this._eventsBound) return;
        this._eventsBound = true;

        // Connect/disconnect actions live in Settings → Connected Accounts now
        document.getElementById('calendar-sync-btn')?.addEventListener('click', () => this.syncEvents());

        // Refresh when the user switches back to Anjadhe while looking at the
        // calendar — the common "created an event in Google Calendar in the
        // browser, now show it here" path. Google has no push channel a local
        // desktop app can subscribe to, so re-focus is the freshness signal.
        window.addEventListener('focus', () => {
            if (AppManager.currentApp === 'calendar') this.syncIfStale(15 * 1000);
        });
        document.getElementById('calendar-new-event-btn')?.addEventListener('click', () => this.showEventForm());

        // Navigation
        document.getElementById('calendar-prev-btn')?.addEventListener('click', () => this.navigate(-1));
        document.getElementById('calendar-next-btn')?.addEventListener('click', () => this.navigate(1));
        document.getElementById('calendar-today-btn')?.addEventListener('click', () => this.goToToday());

        // View toggles
        document.querySelectorAll('.calendar-view-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.currentView = btn.dataset.view;
                this.saveData();
                document.querySelectorAll('.calendar-view-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                CalendarUI.renderCalendar();
            });
        });

        // Show/hide Schedule tasks on the calendar
        const showTasksInput = document.getElementById('calendar-show-tasks');
        if (showTasksInput) {
            showTasksInput.checked = this.showTasks;
            showTasksInput.addEventListener('change', (e) => {
                this.showTasks = e.target.checked;
                this.saveData();
                CalendarUI.renderCalendar();
            });
        }

        // Event form
        document.getElementById('calendar-event-save-btn')?.addEventListener('click', () => this.saveEvent());
        document.getElementById('calendar-event-cancel-btn')?.addEventListener('click', () => this.hideEventForm());
        document.getElementById('calendar-event-delete-btn')?.addEventListener('click', () => this.deleteEvent());

        // All-day toggle
        document.getElementById('calendar-event-allday')?.addEventListener('change', (e) => {
            const timeInputs = document.querySelectorAll('.calendar-event-time-input');
            timeInputs.forEach(el => el.style.display = e.target.checked ? 'none' : '');
        });

        // Event detail back
        document.getElementById('calendar-detail-back-btn')?.addEventListener('click', () => this.hideEventDetail());

        // Close overlays on backdrop click
        document.getElementById('calendar-event-form')?.addEventListener('click', (e) => {
            if (e.target.id === 'calendar-event-form') this.hideEventForm();
        });
        document.getElementById('calendar-event-detail')?.addEventListener('click', (e) => {
            if (e.target.id === 'calendar-event-detail') this.hideEventDetail();
        });
    },

    // --- Navigation ---

    navigate(direction) {
        const d = this.currentDate;
        if (this.currentView === 'month') {
            this.currentDate = new Date(d.getFullYear(), d.getMonth() + direction, 1);
        } else if (this.currentView === 'week') {
            this.currentDate = new Date(d.getTime() + direction * 7 * 86400000);
        } else {
            this.currentDate = new Date(d.getTime() + direction * 86400000);
        }
        CalendarUI.renderCalendar();
    },

    goToToday() {
        this.currentDate = new Date();
        CalendarUI.renderCalendar();
    },

    // --- Google Calendar OAuth ---

    async connectAccount() {
        const btn = document.getElementById('calendar-connect-btn');
        if (btn) btn.disabled = true;

        try {
            const result = await window.electronCalendar.startOAuth();
            if (result?.success) {
                const existing = this.accounts.find(a => a.email === result.email);
                if (!existing) {
                    this.accounts.push({
                        id: this.generateId(),
                        email: result.email,
                        provider: 'google',
                        profile: ProfileManager.getProfileForNewItem(),
                        connectedAt: new Date().toISOString()
                    });
                    this.saveData();
                }
                if (typeof UIUtils !== 'undefined') {
                    UIUtils.showToast(`Connected ${result.email}`, 'success');
                }
                await this.syncEvents();
                CalendarUI.render();
            } else {
                console.error('Calendar OAuth failed:', result?.error);
                if (typeof UIUtils !== 'undefined') {
                    UIUtils.showToast(`Calendar connection failed: ${result?.error || 'unknown error'}`, 'error');
                }
            }
        } catch (err) {
            console.error('Calendar connect error:', err);
            if (typeof UIUtils !== 'undefined') {
                UIUtils.showToast(`Calendar connect error: ${err.message}`, 'error');
            }
        } finally {
            if (btn) btn.disabled = false;
        }
    },

    /**
     * Re-authenticate an existing calendar account whose refresh token has
     * gone bad. Opens the same OAuth flow as connectAccount; the existing
     * tokens are overwritten on the main-process side and the existing
     * account row in this.accounts is reused (no duplicate).
     */
    async reconnectAccount(email) {
        if (typeof UIUtils !== 'undefined') {
            UIUtils.showToast(`Re-authenticate as ${email}`, 'info');
        }
        await this.connectAccount();
    },

    // Called by AccountsManager.remove when a Google account is removed from
    // Settings → Connected Accounts. Operates directly on stored data so it
    // works whether or not the Calendar view has been opened in this session.
    cleanupAccountData(email) {
        const data = StorageManager.get('calendar') || {};
        const events = (data.events || []).filter(e => e.account !== email);
        const calendars = (data.calendars || []).filter(c => c.account !== email);

        StorageManager.set('calendar', { ...data, events, calendars });

        if (Array.isArray(this.events)) {
            this.events = events;
            this.calendars = calendars;
            if (typeof CalendarUI !== 'undefined' && typeof CalendarUI.render === 'function') {
                CalendarUI.render();
            }
        }
    },

    // --- Sync ---

    startAutoSync() {
        if (this.syncTimer) clearInterval(this.syncTimer);
        // Incremental sync (syncToken) makes a no-change poll a few hundred
        // bytes, so poll every minute while the user is looking at the
        // calendar; back off to every 5 minutes in the background.
        this._autoSyncTick = 0;
        this.syncTimer = setInterval(() => {
            if (this.accounts.length === 0) return;
            this._autoSyncTick++;
            const watching = typeof AppManager !== 'undefined' && AppManager.currentApp === 'calendar';
            if (watching || this._autoSyncTick % 5 === 0) this.syncEvents();
        }, 60 * 1000);
    },

    async syncEvents() {
        if (this.isSyncing || this.accounts.length === 0) return;
        this.isSyncing = true;
        CalendarUI.updateSyncStatus('Syncing...');
        const syncBtn = document.getElementById('calendar-sync-btn');
        const doneBtn = UIUtils.setButtonLoading(syncBtn, 'Syncing...');

        // Track which accounts succeeded and which failed so we can show
        // a meaningful status (and not silently mark "synced" when nothing
        // actually came back).
        const failedAccounts = [];
        const reconnectAccounts = [];
        let totalEventCount = 0;
        let successfulAccountCount = 0;

        try {
            for (const account of this.accounts) {
                // Fetch calendar list
                const calResult = await window.electronCalendar.listCalendars(account.email);
                if (calResult?.error) {
                    console.error('[calendar] listCalendars error for', account.email, ':', calResult.error);
                    if (calResult.error.includes('reconnect') || calResult.error.includes('authent')) {
                        reconnectAccounts.push(account.email);
                    } else {
                        failedAccounts.push({ email: account.email, error: calResult.error });
                    }
                    continue; // skip event fetch for this account, no point
                }
                if (calResult?.calendars) {
                    // Remove old calendars for this account and add new
                    this.calendars = this.calendars.filter(c => c.account !== account.email);
                    calResult.calendars.forEach(cal => {
                        this.calendars.push({
                            id: cal.id,
                            summary: cal.summary,
                            backgroundColor: cal.backgroundColor,
                            primary: cal.primary || false,
                            selected: cal.selected || false,
                            accessRole: cal.accessRole || 'reader',
                            account: account.email
                        });
                    });
                }

                // Sync every calendar the user has visible in Google's UI
                // (`selected`), not just primary — family/shared/classroom
                // calendars were invisible here otherwise. Primary is always
                // included as a safety net.
                const calendarIds = (calResult?.calendars || [])
                    .filter(c => c.primary || c.selected)
                    .map(c => c.id);
                if (calendarIds.length === 0) calendarIds.push('primary');

                // Fetch events for next 90 days and past 30 days
                const now = new Date();
                const timeMin = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
                const timeMax = new Date(now.getFullYear(), now.getMonth() + 3, 0).toISOString();

                const evResult = await window.electronCalendar.syncEvents(account.email, { timeMin, timeMax, calendarIds });
                console.log('[calendar] syncEvents result:', evResult?.error || (evResult?.calendars || []).map(c => `${c.calendarId}: ${c.failed ? 'failed' : `${c.mode} ${c.events.length}`}`).join(', '));

                if (evResult?.error) {
                    console.error('[calendar] syncEvents error for', account.email, ':', evResult.error);
                    if (evResult.error.includes('reconnect') || evResult.error.includes('authent')) {
                        if (!reconnectAccounts.includes(account.email)) reconnectAccounts.push(account.email);
                    } else {
                        failedAccounts.push({ email: account.email, error: evResult.error });
                    }
                    continue;
                }

                if (evResult?.calendars) {
                    // Drop cached events from calendars no longer in the
                    // synced set (unchecked in Google's UI, revoked share) —
                    // with per-calendar merging below they'd linger forever.
                    const syncedCals = new Set(calendarIds);
                    this.events = this.events.filter(e =>
                        e.account !== account.email || syncedCals.has(e.calendarId));

                    for (const cal of evResult.calendars) {
                        if (cal.failed) continue; // keep this calendar's cache
                        if (cal.mode === 'full') {
                            // Full window fetch: replace this calendar wholesale
                            this.events = this.events.filter(e =>
                                e.account !== account.email || e.calendarId !== cal.calendarId);
                            cal.events
                                .filter(ev => ev.status !== 'cancelled')
                                .forEach(ev => this.events.push(this._toLocalEvent(ev, account.email)));
                        } else {
                            // Incremental: apply the delta — upsert changes,
                            // remove cancellations.
                            for (const ev of cal.events) {
                                const idx = this.events.findIndex(e =>
                                    e.account === account.email && e.calendarId === cal.calendarId && e.id === ev.id);
                                if (ev.status === 'cancelled') {
                                    if (idx >= 0) this.events.splice(idx, 1);
                                } else if (idx >= 0) {
                                    this.events[idx] = this._toLocalEvent(ev, account.email);
                                } else {
                                    this.events.push(this._toLocalEvent(ev, account.email));
                                }
                            }
                        }
                    }
                    totalEventCount += this.events.filter(e => e.account === account.email).length;
                    successfulAccountCount++;
                }
            }

            // Only mark "lastSyncTime" if at least one account actually succeeded.
            // Otherwise the user sees "Synced just now" while nothing happened.
            if (successfulAccountCount > 0) {
                this.lastSyncTime = new Date().toISOString();
            }

            // Defensive: collapse any duplicate rows (same account+id).
            // Drop rows whose account is no longer connected so stale copies
            // from a renamed/removed account can't linger forever.
            const liveAccounts = new Set(this.accounts.map(a => a.email));
            this.events = this._dedupEvents(
                this.events.filter(e => !e.account || liveAccounts.has(e.account))
            );

            this.saveData();
            CalendarUI.renderCalendar();

            // Report status. Reconnect failures take priority since they're
            // actionable; other errors come next; success last.
            if (reconnectAccounts.length > 0) {
                const list = reconnectAccounts.join(', ');
                CalendarUI.updateSyncStatus(`Reconnect required: ${list}`);
                if (typeof UIUtils !== 'undefined') {
                    UIUtils.showToast(`Calendar account needs reconnection: ${list}`, 'error');
                }
            } else if (failedAccounts.length > 0) {
                CalendarUI.updateSyncStatus(`Sync failed for ${failedAccounts.length} account(s)`);
                if (typeof UIUtils !== 'undefined') {
                    UIUtils.showToast(`Calendar sync failed: ${failedAccounts[0].error}`, 'error');
                }
            } else {
                CalendarUI.updateSyncStatus(this.lastSyncTime ? `Synced ${totalEventCount} events ${this.formatTimeAgo(this.lastSyncTime)}` : 'No events');
            }
        } catch (err) {
            console.error('Calendar sync failed:', err);
            CalendarUI.updateSyncStatus('Sync failed');
            if (typeof UIUtils !== 'undefined') {
                UIUtils.showToast(`Calendar sync error: ${err.message}`, 'error');
            }
        } finally {
            this.isSyncing = false;
            doneBtn();
        }
    },

    // --- Event CRUD ---

    showEventForm(event = null, date = null) {
        // Event creation requires a Google account — the form writes back via OAuth.
        if (!event && this.getAccounts().length === 0) return;

        this.selectedEvent = event;
        const form = document.getElementById('calendar-event-form');
        if (!form) return;

        form.style.display = 'flex';
        document.getElementById('calendar-event-form-title').textContent = event ? 'Edit Event' : 'New Event';
        document.getElementById('calendar-event-delete-btn').style.display = event ? '' : 'none';

        // Populate account select
        const accountSelect = document.getElementById('calendar-event-account');
        accountSelect.innerHTML = this.accounts.map(a =>
            `<option value="${a.email}" ${event && event.account === a.email ? 'selected' : ''}>${a.email}</option>`
        ).join('');

        if (event) {
            document.getElementById('calendar-event-title').value = event.summary || '';
            document.getElementById('calendar-event-description').value = event.description || '';
            document.getElementById('calendar-event-location').value = event.location || '';
            document.getElementById('calendar-event-allday').checked = event.allDay;

            if (event.allDay) {
                document.getElementById('calendar-event-start-date').value = this.formatDateInput(event.start);
                document.getElementById('calendar-event-end-date').value = this.formatDateInput(event.end || event.start);
                document.getElementById('calendar-event-start-time').value = '';
                document.getElementById('calendar-event-end-time').value = '';
            } else {
                document.getElementById('calendar-event-start-date').value = this.formatDateInput(event.start);
                document.getElementById('calendar-event-end-date').value = this.formatDateInput(event.end || event.start);
                document.getElementById('calendar-event-start-time').value = this.formatTimeInput(event.start);
                document.getElementById('calendar-event-end-time').value = this.formatTimeInput(event.end || event.start);
            }
        } else {
            const startDate = date || new Date();
            document.getElementById('calendar-event-title').value = '';
            document.getElementById('calendar-event-description').value = '';
            document.getElementById('calendar-event-location').value = '';
            document.getElementById('calendar-event-allday').checked = false;
            document.getElementById('calendar-event-start-date').value = this.formatDateInput(startDate);
            document.getElementById('calendar-event-end-date').value = this.formatDateInput(startDate);

            // Default to next hour
            const hour = startDate.getHours() + 1;
            document.getElementById('calendar-event-start-time').value = `${String(hour % 24).padStart(2, '0')}:00`;
            document.getElementById('calendar-event-end-time').value = `${String((hour + 1) % 24).padStart(2, '0')}:00`;
        }

        // Toggle time inputs based on all-day
        const timeInputs = document.querySelectorAll('.calendar-event-time-input');
        timeInputs.forEach(el => el.style.display = document.getElementById('calendar-event-allday').checked ? 'none' : '');

        document.getElementById('calendar-event-title').focus();
    },

    hideEventForm() {
        const form = document.getElementById('calendar-event-form');
        if (form) form.style.display = 'none';
        this.selectedEvent = null;
    },

    async saveEvent() {
        const title = document.getElementById('calendar-event-title').value.trim();
        if (!title) return;

        const account = document.getElementById('calendar-event-account').value;
        if (!account) return;

        const allDay = document.getElementById('calendar-event-allday').checked;
        const startDate = document.getElementById('calendar-event-start-date').value;
        const endDate = document.getElementById('calendar-event-end-date').value;
        const startTime = document.getElementById('calendar-event-start-time').value;
        const endTime = document.getElementById('calendar-event-end-time').value;
        const description = document.getElementById('calendar-event-description').value.trim();
        const location = document.getElementById('calendar-event-location').value.trim();

        let startObj, endObj;
        if (allDay) {
            startObj = { date: startDate };
            endObj = { date: endDate || startDate };
        } else {
            startObj = { dateTime: new Date(`${startDate}T${startTime}`).toISOString() };
            endObj = { dateTime: new Date(`${endDate || startDate}T${endTime}`).toISOString() };
        }

        const eventData = {
            summary: title,
            description,
            location,
            start: startObj,
            end: endObj
        };

        const saveBtn = document.getElementById('calendar-event-save-btn');
        const done = UIUtils.setButtonLoading(saveBtn, 'Saving...');

        try {
            let result;
            if (this.selectedEvent) {
                result = await window.electronCalendar.updateEvent(
                    account,
                    this.selectedEvent.calendarId || 'primary',
                    this.selectedEvent.id,
                    eventData
                );
            } else {
                result = await window.electronCalendar.createEvent(account, 'primary', eventData);
            }

            if (result?.success || result?.event) {
                // Optimistic local update: insert/patch the event right away so
                // the user sees it in the grid immediately, then kick off a
                // background sync to reconcile any server-computed fields
                // (colors, attendees, recurring-instance expansion).
                const serverEv = result.event || {};
                const startObjLocal = allDay
                    ? new Date(`${startDate}T00:00:00`)
                    : new Date(`${startDate}T${startTime}`);
                const endObjLocal = allDay
                    ? new Date(`${endDate || startDate}T00:00:00`)
                    : new Date(`${endDate || startDate}T${endTime}`);

                if (this.selectedEvent) {
                    Object.assign(this.selectedEvent, {
                        summary: title,
                        description,
                        location,
                        start: startObjLocal,
                        end: endObjLocal,
                        allDay
                    });
                } else if (serverEv.id) {
                    this.events.push({
                        id: serverEv.id,
                        calendarId: 'primary',
                        summary: title,
                        description,
                        location,
                        start: startObjLocal,
                        end: endObjLocal,
                        allDay,
                        account,
                        htmlLink: serverEv.htmlLink || '',
                        status: serverEv.status || 'confirmed',
                        colorId: serverEv.colorId || null,
                        attendees: [],
                        recurrence: null,
                        recurringEventId: null
                    });
                }
                this.saveData();
                this.hideEventForm();
                CalendarUI.render();

                // Background reconcile — don't await.
                this.syncEvents();
            } else {
                console.error('Save event failed:', result?.error);
                UIUtils.showToast(result?.error || 'Failed to save event', 'error');
            }
        } catch (err) {
            console.error('Save event error:', err);
            UIUtils.showToast('Failed to save event', 'error');
        } finally {
            done();
        }
    },

    async deleteEvent() {
        if (!this.selectedEvent) return;
        const event = this.selectedEvent;

        // A recurring instance has `recurringEventId` pointing at its master.
        // Because we fetch with singleEvents=true, the master itself never
        // shows up in the list — only instances do — so this is the only
        // signal we get from the synced payload.
        const isRecurring = !!event.recurringEventId;

        if (!isRecurring) {
            const confirmed = confirm(`Delete "${event.summary}"?`);
            if (!confirmed) return;
            await this._performDelete(event, 'single');
            return;
        }

        CalendarUI.showRecurringDeletePrompt(event, async (mode) => {
            if (!mode) return;
            await this._performDelete(event, mode);
        });
    },

    async _performDelete(event, mode) {
        const deleteBtn = document.getElementById('calendar-event-delete-btn');
        const done = UIUtils.setButtonLoading(deleteBtn, 'Deleting...');
        try {
            let result;
            const calendarId = event.calendarId || 'primary';
            const masterId = event.recurringEventId || event.id;

            if (mode === 'single' || mode === 'instance') {
                // Delete just this occurrence. Google accepts a DELETE on
                // the expanded instance id and records it as a cancelled
                // exception to the series.
                result = await window.electronCalendar.deleteEvent(
                    event.account, calendarId, event.id
                );
            } else if (mode === 'all') {
                // Delete the whole series by removing the master.
                result = await window.electronCalendar.deleteEvent(
                    event.account, calendarId, masterId
                );
            } else if (mode === 'following') {
                result = await this._deleteFollowingOccurrences(event, calendarId, masterId);
            } else {
                return;
            }

            if (result?.success) {
                // Optimistic local removal so the grid updates immediately;
                // background sync will reconcile any side effects (e.g.,
                // master trim on "following").
                if (mode === 'single' || mode === 'instance') {
                    this.events = this.events.filter(e => e.id !== event.id);
                } else if (mode === 'all') {
                    this.events = this.events.filter(e =>
                        e.id !== masterId && e.recurringEventId !== masterId
                    );
                }
                this.saveData();
                this.hideEventForm();
                this.hideEventDetail();
                CalendarUI.render();
                this.syncEvents();
            } else {
                console.error('Delete event failed:', result?.error);
                if (typeof UIUtils !== 'undefined') {
                    UIUtils.showToast(`Delete failed: ${result?.error || 'unknown error'}`, 'error');
                }
            }
        } catch (err) {
            console.error('Delete event error:', err);
            if (typeof UIUtils !== 'undefined') {
                UIUtils.showToast(`Delete error: ${err.message}`, 'error');
            }
        } finally {
            done();
        }
    },

    /**
     * Trim a recurring series so it ends before `event.start`. Fetches the
     * master to read its RRULE, rewrites the UNTIL clause, and PATCHes the
     * master. If the instance being deleted is the very first occurrence
     * (or the master has no RRULE), falls back to deleting the whole series.
     */
    async _deleteFollowingOccurrences(event, calendarId, masterId) {
        const masterResult = await window.electronCalendar.getEvent(
            event.account, calendarId, masterId
        );
        if (masterResult?.error || !masterResult?.event) {
            return { error: masterResult?.error || 'Failed to fetch master event' };
        }
        const master = masterResult.event;
        const recurrence = Array.isArray(master.recurrence) ? master.recurrence : [];

        // If the master start is at or after this instance, trimming would
        // leave an empty (or backwards) series — just delete the whole thing.
        const masterStart = master.start?.dateTime || master.start?.date;
        if (masterStart) {
            const masterStartDate = new Date(masterStart);
            if (masterStartDate >= event.start) {
                return await window.electronCalendar.deleteEvent(
                    event.account, calendarId, masterId
                );
            }
        }

        if (recurrence.length === 0) {
            return await window.electronCalendar.deleteEvent(
                event.account, calendarId, masterId
            );
        }

        // UNTIL is inclusive in RFC 5545, so subtract 1 second to ensure
        // this instance and all after are excluded.
        const untilMoment = new Date(event.start.getTime() - 1000);
        const untilStr = event.allDay
            ? this._formatRruleDate(untilMoment)
            : this._formatRruleDateTime(untilMoment);

        let modified = false;
        const newRecurrence = recurrence.map(rule => {
            if (!rule.startsWith('RRULE:')) return rule;
            const parts = rule.substring(6).split(';').filter(p => p.length > 0);
            // Drop any existing UNTIL / COUNT (they're mutually exclusive
            // with each other and with the new UNTIL we're adding).
            const filtered = parts.filter(p => !p.startsWith('UNTIL=') && !p.startsWith('COUNT='));
            filtered.push(`UNTIL=${untilStr}`);
            modified = true;
            return `RRULE:${filtered.join(';')}`;
        });

        if (!modified) {
            // No RRULE found (e.g., series defined only by RDATE). Fall back.
            return await window.electronCalendar.deleteEvent(
                event.account, calendarId, masterId
            );
        }

        return await window.electronCalendar.updateEvent(
            event.account, calendarId, masterId,
            { recurrence: newRecurrence }
        );
    },

    _formatRruleDate(date) {
        // YYYYMMDD (used for DATE-valued UNTIL on all-day events)
        return `${date.getUTCFullYear()}` +
            `${String(date.getUTCMonth() + 1).padStart(2, '0')}` +
            `${String(date.getUTCDate()).padStart(2, '0')}`;
    },

    _formatRruleDateTime(date) {
        // YYYYMMDDTHHMMSSZ (UTC, used for DATE-TIME UNTIL)
        return `${date.getUTCFullYear()}` +
            `${String(date.getUTCMonth() + 1).padStart(2, '0')}` +
            `${String(date.getUTCDate()).padStart(2, '0')}` +
            `T${String(date.getUTCHours()).padStart(2, '0')}` +
            `${String(date.getUTCMinutes()).padStart(2, '0')}` +
            `${String(date.getUTCSeconds()).padStart(2, '0')}Z`;
    },

    showEventDetail(event) {
        this.selectedEvent = event;
        CalendarUI.renderEventDetail(event);
    },

    hideEventDetail() {
        const detail = document.getElementById('calendar-event-detail');
        if (detail) detail.style.display = 'none';
        this.selectedEvent = null;
    },

    // --- Helpers ---

    getAccounts() {
        return ProfileManager.filterByActiveProfile(this.accounts);
    },

    getEventsForDate(date) {
        const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const dayEnd = new Date(dayStart.getTime() + 86400000);
        const profileEmails = new Set(this.getAccounts().map(a => a.email));

        const googleEvents = this.events.filter(e => {
            if (!e.start) return false;
            if (!profileEmails.has(e.account)) return false;
            if (e.allDay) {
                const eStart = new Date(e.start.getFullYear(), e.start.getMonth(), e.start.getDate());
                const eEnd = e.end ? new Date(e.end.getFullYear(), e.end.getMonth(), e.end.getDate()) : new Date(eStart.getTime() + 86400000);
                return eStart < dayEnd && eEnd > dayStart;
            }
            return e.start < dayEnd && (e.end || e.start) > dayStart;
        });

        const scheduleEvents = this.getScheduleEventsForDate(date);

        return [...googleEvents, ...scheduleEvents].sort((a, b) => {
            if (a.allDay && !b.allDay) return -1;
            if (!a.allDay && b.allDay) return 1;
            return a.start - b.start;
        });
    },

    // Expands Schedule-app tasks into calendar-event-shaped records for a given date.
    // Schedule items are local-wall-clock tasks (no timezone) — we snap their
    // HH:MM startTime onto the requested date. One-time items match scheduledDate;
    // recurring items reuse ScheduleApp's own repeat helpers.
    getScheduleEventsForDate(date) {
        if (!this.showTasks) return [];
        if (typeof ScheduleApp === 'undefined' || !Array.isArray(ScheduleApp.scheduleItems)) return [];

        const y = date.getFullYear();
        const m = date.getMonth();
        const d = date.getDate();
        const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

        const items = typeof ProfileManager !== 'undefined'
            ? ProfileManager.filterByActiveProfile(ScheduleApp.scheduleItems)
            : ScheduleApp.scheduleItems;

        const results = [];
        for (const item of items) {
            const isRepeating = item.repeat && item.repeat !== 'none';
            // occursOn handles one-time (own date), recurring (day/date match),
            // and the start-date bound (no occurrences before the anchor).
            if (!ScheduleApp.occursOn(item, dateStr)) continue;

            // Hide resolved tasks — completed OR abandoned (deliberately not
            // done counts as done). For recurring tasks resolution is per-day
            // (lastCompletedDate === dateStr / abandoned mark on that day);
            // for one-time tasks any completion or abandonment resolves the
            // task, so drop it from every date including its scheduled one.
            if (isRepeating) {
                if (item.lastCompletedDate === dateStr) continue;
                if (ScheduleApp.isAbandonedOn(item, dateStr)) continue;
            } else {
                if (item.lastCompletedDate) continue;
                if (ScheduleApp.lastAbandonedDate(item)) continue;
            }

            // Timed tasks land in their hour slot; timeless tasks (a date but
            // no clock time — the common case for quick-added items) surface as
            // all-day chips instead of being dropped from the calendar.
            const timed = this.parseScheduleTime(dateStr, item.startTime);
            const allDay = !timed;
            const start = timed || new Date(y, m, d, 0, 0, 0, 0);
            const end = timed && item.endTime ? this.parseScheduleTime(dateStr, item.endTime) : null;

            results.push({
                id: `sched:${item.id}`,
                scheduleId: item.id,
                source: 'schedule',
                summary: item.title,
                start,
                end,
                allDay,
                account: null
            });
        }
        return results;
    },

    parseScheduleTime(dateStr, hhmm) {
        if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
        const [h, m] = hhmm.split(':').map(Number);
        const [y, mo, da] = dateStr.split('-').map(Number);
        return new Date(y, mo - 1, da, h, m, 0, 0);
    },

    // Unified opener used by chip clicks. Schedule-sourced chips route back
    // to the Schedule editor; Google events open the read/edit detail panel.
    openEventById(eventId) {
        if (!eventId) return;
        if (eventId.startsWith('sched:')) {
            const scheduleId = eventId.slice(6);
            AppManager.openApp('schedule');
            setTimeout(() => ScheduleApp.openEditor(scheduleId, { origin: 'calendar' }), 0);
            return;
        }
        const event = this.events.find(ev => ev.id === eventId);
        if (event) this.showEventDetail(event);
    },

    formatDateInput(date) {
        if (!date) return '';
        const d = date instanceof Date ? date : new Date(date);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },

    formatTimeInput(date) {
        if (!date) return '';
        const d = date instanceof Date ? date : new Date(date);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    },

    formatTime(date) {
        if (!date) return '';
        const d = date instanceof Date ? date : new Date(date);
        const h = d.getHours();
        const m = d.getMinutes();
        const ampm = h >= 12 ? 'PM' : 'AM';
        const h12 = h % 12 || 12;
        return m === 0 ? `${h12} ${ampm}` : `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
    },

    formatDateFull(date) {
        if (!date) return '';
        return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    },

    formatTimeAgo(isoString) {
        const diff = Date.now() - new Date(isoString).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}h ago`;
        return `${Math.floor(hours / 24)}d ago`;
    },

    generateId() {
        return 'cal_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    }
};

AppManager.register('calendar', CalendarApp);

// AgentContext provider — exposes the currently-selected calendar event
// (set when the user opens the event editor / detail). Calendar events
// are mostly user-authored, but invitation descriptions can include
// arbitrary text from external organizers — we still treat the event as
// trusted (the user explicitly accepted the invite to see it) and rely
// on framing rather than tool-blocking. Returns null when no event is
// open; today's events are already in the global briefing.
if (typeof AgentContext !== 'undefined') {
    AgentContext.register('calendar', () => {
        const ev = CalendarApp.selectedEvent;
        if (!ev) return null;

        const start = ev.start || '';
        const end = ev.end || '';
        const desc = String(ev.description || '').slice(0, 1500);
        const eventId = ev.id || '';
        const calendarId = ev.calendarId || 'primary';

        return {
            recordKey: 'calendar:' + calendarId + ':' + eventId,
            recordLabel: ev.summary || '(event)',
            title: 'CURRENT CALENDAR EVENT',
            body: `The user is viewing or editing the calendar event below. The event is available as context, not a constraint:

- When the user's question is about "this event", "this meeting", "this invite", or asks to reschedule / update / delete it, work with the data below. To modify it, call update_calendar_event with calendarId: "${calendarId}", eventId: "${eventId}". To delete, delete_calendar_event with the same ids.
- For general questions, answer normally.

Title: ${ev.summary || '(untitled)'}
Start: ${start}
End: ${end}
Location: ${ev.location || '(none)'}
Calendar: ${calendarId}
Event id: ${eventId}

Description:
${desc || '(none)'}`,
            suggestedPrompts: [
                'What is this meeting about?',
                'Help me prepare for this',
                'Draft an agenda'
            ]
        };
    });
}
