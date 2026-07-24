/**
 * Calendar UI — Renders month/week/day views and event details
 */

const CalendarUI = {

    render() {
        this.renderAccounts();
        this.renderCalendar();
        this.updateConnectVisibility();
    },

    updateConnectVisibility() {
        const connectBtn = document.getElementById('calendar-connect-btn');
        const syncBtn = document.getElementById('calendar-sync-btn');
        const newBtn = document.getElementById('calendar-new-event-btn');
        const prompt = document.getElementById('calendar-connect-prompt');
        const grid = document.getElementById('calendar-grid');

        const hasAccounts = CalendarApp.getAccounts().length > 0;

        // Google-only affordances stay gated on a connected account.
        if (connectBtn) connectBtn.style.display = hasAccounts ? 'none' : '';
        if (syncBtn) syncBtn.style.display = hasAccounts ? '' : 'none';
        if (newBtn) newBtn.style.display = hasAccounts ? '' : 'none';

        // Grid, nav, and view toggle are always visible — the calendar works
        // as a read-only view over Schedule tasks even without Google.
        if (grid) grid.style.display = '';
        document.querySelectorAll('.calendar-nav, .calendar-view-toggle').forEach(el => {
            el.style.display = '';
        });

        // Connect prompt becomes a slim banner above the grid when no accounts.
        if (prompt) prompt.style.display = hasAccounts ? 'none' : '';
    },

    updateSyncStatus(text) {
        const el = document.getElementById('calendar-sync-status');
        if (el) el.textContent = text;
    },

    // --- Calendar Grid ---

    renderCalendar() {
        const view = CalendarApp.currentView;
        this.updateDateLabel();

        // Keep the view-toggle highlight in sync with the active view (the
        // persisted view may differ from the statically-marked button).
        document.querySelectorAll('.calendar-view-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === view);
        });

        if (view === 'month') this.renderMonthView();
        else if (view === 'week') this.renderWeekView();
        else this.renderDayView();
    },

    updateDateLabel() {
        const label = document.getElementById('calendar-date-label');
        if (!label) return;

        const d = CalendarApp.currentDate;
        if (CalendarApp.currentView === 'month') {
            label.textContent = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        } else if (CalendarApp.currentView === 'week') {
            const weekStart = this.getWeekStart(d);
            const weekEnd = new Date(weekStart.getTime() + 6 * 86400000);
            const sameMonth = weekStart.getMonth() === weekEnd.getMonth();
            if (sameMonth) {
                label.textContent = `${weekStart.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} - ${weekEnd.getDate()}, ${weekEnd.getFullYear()}`;
            } else {
                label.textContent = `${weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
            }
        } else {
            label.textContent = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
        }
    },

    // Height of one hour row in the week/day time grids, in pixels. Used to
    // translate an hour into a scroll offset. Kept in sync with the CSS row
    // height for `.calendar-week-row` / `.calendar-day-row`.
    HOUR_ROW_HEIGHT: 36,

    // Scroll a time-grid body so the earliest event of the day(s) sits near the
    // top, skipping empty early-morning space. Falls back to 8 AM when there
    // are no timed events to anchor on. `earliestHour` may be < 8 (e.g. an
    // early event), in which case we scroll up to keep it visible.
    scrollTimeGridToFirstEvent(body, earliestHour) {
        if (!body) return;
        const targetHour = (earliestHour == null) ? 8 : Math.max(0, earliestHour);
        // Leave a small sliver above the first event for context.
        const pad = targetHour > 0 ? 6 : 0;
        const top = Math.max(0, targetHour * this.HOUR_ROW_HEIGHT - pad);
        requestAnimationFrame(() => { body.scrollTop = top; });
    },

    // Earliest start hour among timed events, or null if there are none.
    earliestEventHour(events) {
        let earliest = null;
        for (const ev of events) {
            if (!ev.start) continue;
            const h = ev.start.getHours();
            if (earliest == null || h < earliest) earliest = h;
        }
        return earliest;
    },

    getWeekStart(date) {
        const d = new Date(date);
        d.setDate(d.getDate() - d.getDay());
        d.setHours(0, 0, 0, 0);
        return d;
    },

    // Sweep-line column assignment for overlapping events.
    // Groups events by transitive overlap; within each group, places each
    // event in the first column that doesn't conflict. Returns a Map of
    // eventId -> { col, cols } where `cols` is the group's column count.
    layoutDayEvents(events) {
        const sorted = [...events].sort((a, b) => {
            if (a.start - b.start !== 0) return a.start - b.start;
            const aEnd = a.end || a.start;
            const bEnd = b.end || b.start;
            return bEnd - aEnd;
        });

        const layout = new Map();
        const getEnd = (e) => e.end || new Date(e.start.getTime() + 3600000);

        let group = [];
        let groupMaxEnd = 0;

        const finalizeGroup = () => {
            const cols = group.reduce((m, e) => Math.max(m, layout.get(e.id).col + 1), 1);
            for (const e of group) layout.get(e.id).cols = cols;
        };

        for (const ev of sorted) {
            if (group.length > 0 && ev.start.getTime() >= groupMaxEnd) {
                finalizeGroup();
                group = [];
                groupMaxEnd = 0;
            }

            const used = new Set();
            const evEnd = getEnd(ev);
            for (const other of group) {
                const otherEnd = getEnd(other);
                if (ev.start < otherEnd && evEnd > other.start) {
                    used.add(layout.get(other.id).col);
                }
            }
            let col = 0;
            while (used.has(col)) col++;

            layout.set(ev.id, { col, cols: 1 });
            group.push(ev);
            groupMaxEnd = Math.max(groupMaxEnd, evEnd.getTime());
        }
        if (group.length > 0) finalizeGroup();

        return layout;
    },

    renderMonthView() {
        const grid = document.getElementById('calendar-grid');
        if (!grid) return;

        const d = CalendarApp.currentDate;
        const year = d.getFullYear();
        const month = d.getMonth();
        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);
        const startDay = firstDay.getDay(); // 0=Sun
        const totalDays = lastDay.getDate();

        const today = new Date();
        const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month;

        let html = '<div class="calendar-month">';

        // Day headers
        html += '<div class="calendar-month-header">';
        ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(day => {
            html += `<div class="calendar-day-header">${day}</div>`;
        });
        html += '</div>';

        // Day cells
        html += '<div class="calendar-month-grid">';

        // Leading empty cells
        for (let i = 0; i < startDay; i++) {
            const prevDate = new Date(year, month, -(startDay - i - 1));
            html += `<div class="calendar-day-cell calendar-day-other" data-date="${CalendarApp.formatDateInput(prevDate)}">`;
            html += `<span class="calendar-day-number">${prevDate.getDate()}</span>`;
            html += this.renderDayCellEvents(prevDate);
            html += '</div>';
        }

        // Month days
        for (let day = 1; day <= totalDays; day++) {
            const cellDate = new Date(year, month, day);
            const isToday = isCurrentMonth && today.getDate() === day;

            html += `<div class="calendar-day-cell ${isToday ? 'calendar-day-today' : ''}" data-date="${CalendarApp.formatDateInput(cellDate)}">`;
            html += `<span class="calendar-day-number ${isToday ? 'today-badge' : ''}">${day}</span>`;
            html += this.renderDayCellEvents(cellDate);
            html += '</div>';
        }

        // Trailing empty cells
        const totalCells = startDay + totalDays;
        const remaining = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
        for (let i = 1; i <= remaining; i++) {
            const nextDate = new Date(year, month + 1, i);
            html += `<div class="calendar-day-cell calendar-day-other" data-date="${CalendarApp.formatDateInput(nextDate)}">`;
            html += `<span class="calendar-day-number">${nextDate.getDate()}</span>`;
            html += this.renderDayCellEvents(nextDate);
            html += '</div>';
        }

        html += '</div></div>';
        grid.innerHTML = html;

        // Bind day cell clicks
        grid.querySelectorAll('.calendar-day-cell').forEach(cell => {
            cell.addEventListener('click', (e) => {
                if (e.target.closest('.calendar-event-chip')) return;
                const dateStr = cell.dataset.date;
                if (dateStr) CalendarApp.showEventForm(null, new Date(dateStr + 'T12:00:00'));
            });
        });

        // Bind event chip clicks
        grid.querySelectorAll('.calendar-event-chip').forEach(chip => {
            chip.addEventListener('click', (e) => {
                e.stopPropagation();
                CalendarApp.openEventById(chip.dataset.eventId);
            });
        });
    },

    renderDayCellEvents(date) {
        const events = CalendarApp.getEventsForDate(date);
        if (events.length === 0) return '';

        let html = '<div class="calendar-day-events">';
        const maxShow = 3;
        events.slice(0, maxShow).forEach(ev => {
            const time = ev.allDay ? '' : CalendarApp.formatTime(ev.start);
            const extraCls = ev.source === 'schedule' ? ' calendar-event-chip-schedule'
                : '';
            html += `<div class="calendar-event-chip${extraCls}" data-event-id="${ev.id}" title="${this.escapeHtml(ev.summary)}">`;
            if (time) html += `<span class="event-chip-time">${time}</span> `;
            html += `<span class="event-chip-title">${this.escapeHtml(ev.summary)}</span>`;
            html += '</div>';
        });
        if (events.length > maxShow) {
            html += `<div class="calendar-more-events">+${events.length - maxShow} more</div>`;
        }
        html += '</div>';
        return html;
    },

    renderWeekView() {
        const grid = document.getElementById('calendar-grid');
        if (!grid) return;

        const weekStart = this.getWeekStart(CalendarApp.currentDate);
        const today = new Date();

        let html = '<div class="calendar-week">';

        // Header row
        html += '<div class="calendar-week-header"><div class="calendar-week-gutter"></div>';
        for (let i = 0; i < 7; i++) {
            const d = new Date(weekStart.getTime() + i * 86400000);
            const isToday = d.toDateString() === today.toDateString();
            html += `<div class="calendar-week-day-header ${isToday ? 'calendar-day-today' : ''}">`;
            html += `<span class="week-day-name">${d.toLocaleDateString('en-US', { weekday: 'short' })}</span>`;
            html += `<span class="week-day-num ${isToday ? 'today-badge' : ''}">${d.getDate()}</span>`;
            html += '</div>';
        }
        html += '</div>';

        // All-day row — calendar (Google) all-day events only. Untimed Schedule
        // tasks are NOT crammed here; they render as a readable per-day list
        // pinned at the top of the scroll body below. Skip the band entirely
        // when there are no all-day calendar events so it doesn't waste a strip.
        const weekAllDay = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date(weekStart.getTime() + i * 86400000);
            weekAllDay[i] = CalendarApp.getEventsForDate(d).filter(e => e.allDay && e.source !== 'schedule');
        }
        if (weekAllDay.some(list => list.length)) {
            html += '<div class="calendar-week-allday"><div class="calendar-week-gutter">All day</div>';
            for (let i = 0; i < 7; i++) {
                html += '<div class="calendar-week-allday-cell">';
                weekAllDay[i].forEach(ev => {
                    html += `<div class="calendar-event-chip" data-event-id="${ev.id}">${this.escapeHtml(ev.summary)}</div>`;
                });
                html += '</div>';
            }
            html += '</div>';
        }

        // Precompute per-day timed events + overlap column layout. Events are
        // still rendered inside their starting hour cell, but left/width is
        // assigned from the per-day layout so events with overlapping time
        // windows (even across hour boundaries) sit in distinct columns.
        const dayEvents = [];
        const dayLayouts = [];
        const dayTasks = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date(weekStart.getTime() + i * 86400000);
            const timed = CalendarApp.getEventsForDate(d).filter(e => !e.allDay && e.start);
            dayEvents[i] = timed;
            dayLayouts[i] = this.layoutDayEvents(timed);
            dayTasks[i] = CalendarApp.getEventsForDate(d).filter(e => e.allDay && e.source === 'schedule');
        }

        // Time grid
        html += '<div class="calendar-week-body">';

        // Untimed tasks as a per-day list pinned at the top of the scroll body
        // (sticky so it stays visible once the grid auto-scrolls to the first
        // event). Only render when some day in the week actually has a task.
        if (dayTasks.some(list => list.length)) {
            html += '<div class="calendar-week-taskrow">';
            html += '<div class="calendar-week-gutter calendar-week-taskrow-label">Tasks</div>';
            for (let i = 0; i < 7; i++) {
                html += '<div class="calendar-week-taskcell">';
                dayTasks[i].forEach(ev => {
                    html += `<div class="calendar-task-chip" data-event-id="${ev.id}"><span class="calendar-task-dot"></span><span class="calendar-task-label">${this.escapeHtml(ev.summary)}</span></div>`;
                });
                html += '</div>';
            }
            html += '</div>';
        }

        for (let hour = 0; hour < 24; hour++) {
            html += '<div class="calendar-week-row">';
            html += `<div class="calendar-week-gutter">${hour === 0 ? '' : CalendarApp.formatTime(new Date(2000, 0, 1, hour))}</div>`;
            for (let i = 0; i < 7; i++) {
                const d = new Date(weekStart.getTime() + i * 86400000);
                const isToday = d.toDateString() === today.toDateString();
                html += `<div class="calendar-week-cell ${isToday ? 'calendar-week-cell-today' : ''}" data-date="${CalendarApp.formatDateInput(d)}" data-hour="${hour}">`;

                // Render timed events that start in this hour. Column layout
                // (col/cols) is precomputed per day so that events with any
                // overlapping time range sit side-by-side, even when they
                // start in different hour cells.
                const events = dayEvents[i].filter(e => e.start.getHours() === hour);
                events.forEach(ev => {
                    const duration = ev.end ? (ev.end - ev.start) / 3600000 : 1;
                    const height = Math.max(duration * 100, 100); // percent of cell
                    const extraCls = ev.source === 'schedule' ? ' calendar-week-event-schedule'
                        : '';
                    const lay = dayLayouts[i].get(ev.id) || { col: 0, cols: 1 };
                    const colStyle = lay.cols > 1
                        ? `left: calc(${(lay.col / lay.cols) * 100}% + 2px); width: calc(${100 / lay.cols}% - 4px); right: auto;`
                        : '';
                    html += `<div class="calendar-week-event${extraCls}" data-event-id="${ev.id}" style="height: ${height}%; ${colStyle}">`;
                    html += `<span class="week-event-time">${CalendarApp.formatTime(ev.start)}</span> `;
                    html += `<span class="week-event-title">${this.escapeHtml(ev.summary)}</span>`;
                    html += '</div>';
                });

                html += '</div>';
            }
            html += '</div>';
        }
        html += '</div></div>';

        grid.innerHTML = html;

        // Bind clicks
        grid.querySelectorAll('.calendar-week-cell').forEach(cell => {
            cell.addEventListener('click', (e) => {
                if (e.target.closest('.calendar-week-event')) return;
                const dateStr = cell.dataset.date;
                const hour = parseInt(cell.dataset.hour);
                if (dateStr) {
                    const d = new Date(dateStr + 'T12:00:00');
                    d.setHours(hour);
                    CalendarApp.showEventForm(null, d);
                }
            });
        });

        grid.querySelectorAll('.calendar-week-event, .calendar-event-chip, .calendar-task-chip').forEach(chip => {
            chip.addEventListener('click', (e) => {
                e.stopPropagation();
                CalendarApp.openEventById(chip.dataset.eventId);
            });
        });

        // Scroll to the earliest event of the week (or 8 AM if none), skipping
        // empty early-morning hours.
        const earliest = this.earliestEventHour(dayEvents.flat());
        this.scrollTimeGridToFirstEvent(grid.querySelector('.calendar-week-body'), earliest);
    },

    renderDayView() {
        const grid = document.getElementById('calendar-grid');
        if (!grid) return;

        const d = CalendarApp.currentDate;
        const today = new Date();
        const isToday = d.toDateString() === today.toDateString();

        const allDayEvents = CalendarApp.getEventsForDate(d).filter(e => e.allDay && e.source !== 'schedule');
        const dayTaskList = CalendarApp.getEventsForDate(d).filter(e => e.allDay && e.source === 'schedule');

        let html = '<div class="calendar-day">';

        // All-day section — calendar (Google) all-day events only.
        if (allDayEvents.length > 0) {
            html += '<div class="calendar-day-allday">';
            html += '<span class="calendar-day-allday-label">All day</span>';
            allDayEvents.forEach(ev => {
                html += `<div class="calendar-event-chip" data-event-id="${ev.id}">${this.escapeHtml(ev.summary)}</div>`;
            });
            html += '</div>';
        }

        // Untimed tasks as a readable checklist, pinned above the hour grid.
        if (dayTaskList.length > 0) {
            html += '<div class="calendar-day-taskrow">';
            html += '<span class="calendar-day-taskrow-label">Tasks</span>';
            html += '<div class="calendar-day-tasklist">';
            dayTaskList.forEach(ev => {
                html += `<div class="calendar-task-chip" data-event-id="${ev.id}"><span class="calendar-task-dot"></span><span class="calendar-task-label">${this.escapeHtml(ev.summary)}</span></div>`;
            });
            html += '</div></div>';
        }

        const timedEvents = CalendarApp.getEventsForDate(d).filter(e => !e.allDay && e.start);
        const layout = this.layoutDayEvents(timedEvents);

        // Time grid
        html += '<div class="calendar-day-body">';
        for (let hour = 0; hour < 24; hour++) {
            html += '<div class="calendar-day-row">';
            html += `<div class="calendar-day-gutter">${hour === 0 ? '' : CalendarApp.formatTime(new Date(2000, 0, 1, hour))}</div>`;
            html += `<div class="calendar-day-cell ${isToday ? 'calendar-day-cell-today' : ''}" data-hour="${hour}">`;

            const events = timedEvents.filter(e => e.start.getHours() === hour);
            events.forEach(ev => {
                const duration = ev.end ? (ev.end - ev.start) / 3600000 : 1;
                const height = Math.max(duration * 100, 100);
                const extraCls = ev.source === 'schedule' ? ' calendar-day-event-schedule'
                    : '';
                const lay = layout.get(ev.id) || { col: 0, cols: 1 };
                const colStyle = lay.cols > 1
                    ? `left: calc(${(lay.col / lay.cols) * 100}% + 4px); width: calc(${100 / lay.cols}% - 8px); right: auto;`
                    : '';
                html += `<div class="calendar-day-event${extraCls}" data-event-id="${ev.id}" style="height: ${height}%; ${colStyle}">`;
                const endLabel = ev.end ? ` - ${CalendarApp.formatTime(ev.end)}` : '';
                html += `<div class="day-event-time">${CalendarApp.formatTime(ev.start)}${endLabel}</div>`;
                html += `<div class="day-event-title">${this.escapeHtml(ev.summary)}</div>`;
                if (ev.location) html += `<div class="day-event-location">${this.escapeHtml(ev.location)}</div>`;
                html += '</div>';
            });

            html += '</div></div>';
        }
        html += '</div></div>';

        grid.innerHTML = html;

        // Bind clicks
        grid.querySelectorAll('.calendar-day-cell').forEach(cell => {
            cell.addEventListener('click', (e) => {
                if (e.target.closest('.calendar-day-event')) return;
                const hour = parseInt(cell.dataset.hour);
                const clickDate = new Date(d);
                clickDate.setHours(hour, 0, 0, 0);
                CalendarApp.showEventForm(null, clickDate);
            });
        });

        grid.querySelectorAll('.calendar-day-event, .calendar-event-chip, .calendar-task-chip').forEach(chip => {
            chip.addEventListener('click', (e) => {
                e.stopPropagation();
                CalendarApp.openEventById(chip.dataset.eventId);
            });
        });

        // Scroll to the earliest event of the day (or 8 AM if none), skipping
        // empty early-morning hours.
        const earliest = this.earliestEventHour(timedEvents);
        this.scrollTimeGridToFirstEvent(grid.querySelector('.calendar-day-body'), earliest);
    },

    // --- Event Detail ---

    renderEventDetail(event) {
        const detail = document.getElementById('calendar-event-detail');
        if (!detail) return;

        const content = document.getElementById('calendar-event-detail-content');
        if (!content) return;

        const startStr = event.allDay
            ? CalendarApp.formatDateFull(event.start)
            : `${CalendarApp.formatDateFull(event.start)} at ${CalendarApp.formatTime(event.start)}`;
        const endStr = event.end
            ? (event.allDay
                ? CalendarApp.formatDateFull(event.end)
                : CalendarApp.formatTime(event.end))
            : '';

        // Labeled rows (When / Where / Who) — quiet micro-label captions
        // instead of the old emoji-prefixed lines.
        let html = `<h2 class="event-detail-title">${this.escapeHtml(event.summary)}</h2>`;
        html += `<div class="event-detail-meta">`;
        html += `<div class="event-detail-row"><span class="event-detail-row-label">When</span><span class="event-detail-row-value">${startStr}${endStr ? ` &ndash; ${endStr}` : ''}</span></div>`;
        if (event.location) {
            html += `<div class="event-detail-row"><span class="event-detail-row-label">Where</span><span class="event-detail-row-value">${this.escapeHtml(event.location)}</span></div>`;
        }
        if (event.attendees && event.attendees.length > 0) {
            const who = event.attendees.map(a =>
                `<li>${this.escapeHtml(a.email || a.displayName || 'Unknown')}${a.responseStatus ? ` <span class="event-detail-rsvp">${this.escapeHtml(a.responseStatus)}</span>` : ''}</li>`
            ).join('');
            html += `<div class="event-detail-row"><span class="event-detail-row-label">Who</span><span class="event-detail-row-value"><ul class="event-detail-attendee-list">${who}</ul></span></div>`;
        }
        if (event.description) {
            html += `<div class="event-detail-desc">${this.escapeHtml(event.description)}</div>`;
        }
        html += '</div>';

        html += '<div class="event-detail-actions">';
        html += '<button id="calendar-detail-edit-btn" class="primary-btn">Edit</button>';
        html += '<button id="calendar-detail-delete-btn" class="secondary-btn">Delete</button>';
        html += '</div>';

        content.innerHTML = html;
        detail.style.display = 'flex';

        // Bind action buttons
        document.getElementById('calendar-detail-edit-btn')?.addEventListener('click', () => {
            detail.style.display = 'none';
            CalendarApp.showEventForm(event);
        });
        document.getElementById('calendar-detail-delete-btn')?.addEventListener('click', () => {
            CalendarApp.deleteEvent();
        });
    },

    // --- Recurring Delete Prompt ---

    showRecurringDeletePrompt(event, callback) {
        // Remove any existing instance first.
        document.querySelectorAll('.calendar-recurring-delete-modal').forEach(el => el.remove());

        const modal = document.createElement('div');
        modal.className = 'calendar-recurring-delete-modal';
        modal.innerHTML = `
            <div class="calendar-recurring-delete-inner">
                <h3>Delete recurring event</h3>
                <p class="calendar-recurring-delete-desc">
                    &ldquo;${this.escapeHtml(event.summary)}&rdquo; is part of a recurring series.
                    What would you like to delete?
                </p>
                <div class="calendar-recurring-delete-options">
                    <button class="calendar-recurring-delete-option" data-mode="instance">
                        <span class="opt-title">This event</span>
                        <span class="opt-sub">Delete only this occurrence</span>
                    </button>
                    <button class="calendar-recurring-delete-option" data-mode="following">
                        <span class="opt-title">This and following events</span>
                        <span class="opt-sub">Keep earlier occurrences, remove the rest</span>
                    </button>
                    <button class="calendar-recurring-delete-option" data-mode="all">
                        <span class="opt-title">All events</span>
                        <span class="opt-sub">Delete the entire series</span>
                    </button>
                </div>
                <div class="calendar-recurring-delete-actions">
                    <button class="secondary-btn" data-mode="cancel">Cancel</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const close = (mode) => {
            modal.remove();
            document.removeEventListener('keydown', onKey);
            callback(mode === 'cancel' || !mode ? null : mode);
        };

        const onKey = (e) => {
            if (e.key === 'Escape') close('cancel');
        };
        document.addEventListener('keydown', onKey);

        modal.addEventListener('click', (e) => {
            if (e.target === modal) return close('cancel');
            const btn = e.target.closest('button[data-mode]');
            if (btn) close(btn.dataset.mode);
        });
    },

    // --- Accounts ---

    renderAccounts() {
        const container = document.getElementById('calendar-accounts-list');
        if (!container) return;

        const accounts = CalendarApp.getAccounts();
        if (accounts.length === 0) {
            container.innerHTML = '';
            return;
        }

        // Read-only display. All connect/disconnect/reconnect actions
        // moved to Settings → Connected Accounts.
        container.innerHTML = accounts.map(a => `
            <div class="calendar-account-item">
                <span class="calendar-account-email">${this.escapeHtml(a.email)}</span>
            </div>
        `).join('') + `
            <button class="calendar-accounts-manage-link" id="calendar-accounts-manage-link">
                Manage accounts in Settings &rsaquo;
            </button>
        `;

        const manageLink = document.getElementById('calendar-accounts-manage-link');
        if (manageLink) {
            manageLink.addEventListener('click', () => { AppManager.openApp('settings'); setTimeout(() => SettingsApp.openCategory('accounts'), 50); });
        }
    },

    escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
};
