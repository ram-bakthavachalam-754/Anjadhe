/**
 * Schedule quick-add natural-language parser.
 *
 * Deterministic, synchronous, dependency-free. Given the raw quick-add string
 * and today's local date (YYYY-MM-DD), it pulls out a date, a time (or time
 * range), and a repeat rule, and returns the cleaned task title plus a set of
 * human-readable chips describing what it recognized.
 *
 * Design rules that keep it from mangling ordinary titles:
 *   - Times must carry am/pm, a colon, an "at" prefix, or be noon/midnight.
 *     Bare integers ("Read chapter 3") are never treated as times.
 *   - Dates must use month names, weekday names, relative keywords, or a
 *     slash/dash numeric format. Bare integers are never treated as dates.
 *   - Repeats must use "every", a plural weekday ("mondays"), or one of the
 *     explicit words (daily/weekly/monthly/annually/weekdays).
 *
 * The parser is pure: it takes todayISO as a parameter (never reads the clock)
 * so it is fully testable and deterministic. Output field names match the
 * schedule item schema (scheduledDate, startTime, endTime, repeat, dayOfWeek,
 * repeatDays) so the caller can spread them straight onto a new task.
 */
const ScheduleQuickParse = {
    WEEKDAYS: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
    WEEKDAY_ABBR: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    MONTHS: ['january', 'february', 'march', 'april', 'may', 'june',
             'july', 'august', 'september', 'october', 'november', 'december'],
    MONTH_ABBR: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],

    // --- date helpers (local, no clock reads) ---
    _toDate(iso) { return new Date(iso + 'T00:00:00'); },
    _fmt(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    },
    _addDays(iso, n) { const d = this._toDate(iso); d.setDate(d.getDate() + n); return this._fmt(d); },
    _addMonths(iso, n) { const d = this._toDate(iso); d.setMonth(d.getMonth() + n); return this._fmt(d); },
    _addYears(iso, n) { const d = this._toDate(iso); d.setFullYear(d.getFullYear() + n); return this._fmt(d); },
    _dow(iso) { return this._toDate(iso).getDay(); },

    // Next date on which day-of-month `day` falls, from `iso` inclusive. Rolls
    // to next month once the day has passed, and clamps to the month's length
    // (so "31st" in a 30-day month lands on the 30th).
    _nextDayOfMonth(iso, day) {
        const t = this._toDate(iso);
        let y = t.getFullYear(), mo = t.getMonth();
        if (t.getDate() > day) { mo++; if (mo > 11) { mo = 0; y++; } }
        const daysInMonth = new Date(y, mo + 1, 0).getDate();
        return this._fmt(new Date(y, mo, Math.min(day, daysInMonth)));
    },

    _ordinal(n) {
        const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
        return n + (s[(v - 20) % 10] || s[v] || s[0]);
    },

    // Days until the next occurrence of weekday `target` from `iso`
    // (0 = the same day). `next` forces the following week's occurrence.
    _deltaToWeekday(iso, target, next) {
        const base = (target - this._dow(iso) + 7) % 7;
        if (next) return base === 0 ? 7 : base + 7;
        return base;
    },

    _weekdayIndex(word) {
        word = word.toLowerCase();
        return this.WEEKDAYS.findIndex(d => d === word || d.slice(0, 3) === word.slice(0, 3));
    },
    _monthIndex(word) {
        word = word.toLowerCase();
        return this.MONTHS.findIndex(m => m === word || m.slice(0, 3) === word.slice(0, 3));
    },

    /**
     * Convert an hour/minute/meridiem triple to "HH:MM" 24-hour text.
     * `meridiem` is 'am' | 'pm' | null. When null and `hint` is 'clock' we
     * apply a friendly heuristic for a bare "at N": 1-6 -> afternoon, 7-11 ->
     * morning, 12 -> noon.
     */
    _clock(h, m, meridiem, hint) {
        m = m || 0;
        if (meridiem === 'am') { if (h === 12) h = 0; }
        else if (meridiem === 'pm') { if (h !== 12) h += 12; }
        else if (hint === 'clock') { if (h >= 1 && h <= 6) h += 12; }
        if (h > 23 || m > 59) return null;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    },

    _fmtClockLabel(hhmm) {
        const [h, m] = hhmm.split(':').map(Number);
        const period = h >= 12 ? 'PM' : 'AM';
        const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
        return `${h12}:${String(m).padStart(2, '0')} ${period}`;
    },

    _fmtDateLabel(iso, todayISO) {
        const delta = Math.round((this._toDate(iso) - this._toDate(todayISO)) / 86400000);
        if (delta === 0) return 'Today';
        if (delta === 1) return 'Tomorrow';
        if (delta === -1) return 'Yesterday';
        const d = this._toDate(iso);
        const wd = this.WEEKDAY_ABBR[d.getDay()];
        const md = `${this.MONTH_ABBR[d.getMonth()]} ${d.getDate()}`;
        if (delta > 1 && delta <= 6) return wd;
        if (d.getFullYear() === this._toDate(todayISO).getFullYear()) return `${wd}, ${md}`;
        return `${wd}, ${md}, ${d.getFullYear()}`;
    },

    /**
     * Parse a raw quick-add string.
     * @param {string} raw
     * @param {string} todayISO - today's local date, YYYY-MM-DD
     * @returns {{title:string, hasParse:boolean, fields:object, chips:Array}}
     */
    parse(raw, todayISO) {
        let work = ' ' + (raw || '') + ' ';
        const fields = {
            scheduledDate: null, startTime: '', endTime: null,
            repeat: 'none', dayOfWeek: null, repeatDays: []
        };
        const chips = [];

        // Replace the first regex match in `work` with a space, returning the
        // match array (or null). Case-insensitive, space-padded boundaries.
        const eat = (re) => {
            const m = work.match(re);
            if (!m) return null;
            work = work.slice(0, m.index) + ' ' + work.slice(m.index + m[0].length);
            return m;
        };

        // --- 1. time range (requires am/pm or colon on the end side) ---
        const range = eat(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
        if (range) {
            const end = this._clock(+range[4], +range[5], range[6].toLowerCase());
            // Start inherits the end meridiem when it lacks its own.
            const startMer = range[3] ? range[3].toLowerCase() : range[6].toLowerCase();
            const start = this._clock(+range[1], +range[2], startMer);
            if (start && end) {
                fields.startTime = start;
                fields.endTime = end;
                chips.push({ kind: 'time', label: `${this._fmtClockLabel(start)}–${this._fmtClockLabel(end)}` });
            }
        }

        // --- 2. single time ---
        if (!fields.startTime) {
            let t = eat(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);  // (at) 3pm, 3:30pm
            if (t) {
                const hhmm = this._clock(+t[1], +t[2], t[3].toLowerCase());
                if (hhmm) { fields.startTime = hhmm; chips.push({ kind: 'time', label: this._fmtClockLabel(hhmm) }); }
            } else if ((t = eat(/\b(?:at\s+)?(\d{1,2}):(\d{2})\b/))) {   // 14:30, at 9:15 (24h)
                const hhmm = this._clock(+t[1], +t[2], null);
                if (hhmm) { fields.startTime = hhmm; chips.push({ kind: 'time', label: this._fmtClockLabel(hhmm) }); }
            } else if ((t = eat(/\bat\s+(\d{1,2})\b/i))) {              // at 3 (bare hour)
                const hhmm = this._clock(+t[1], 0, null, 'clock');
                if (hhmm) { fields.startTime = hhmm; chips.push({ kind: 'time', label: this._fmtClockLabel(hhmm) }); }
            } else if ((t = eat(/\b(?:at\s+)?noon\b/i))) {
                fields.startTime = '12:00'; chips.push({ kind: 'time', label: '12:00 PM' });
            } else if ((t = eat(/\b(?:at\s+)?midnight\b/i))) {
                fields.startTime = '00:00'; chips.push({ kind: 'time', label: '12:00 AM' });
            }
        }

        // --- 3. repeat ---
        const wd = '(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)';
        let rep;
        if ((rep = eat(/\b(?:every\s*day|everyday|daily)\b/i))) {
            fields.repeat = 'daily';
            chips.push({ kind: 'repeat', label: 'Daily' });
        } else if ((rep = eat(/\b(?:every\s*weekdays?|weekdays)\b/i))) {
            fields.repeat = 'weekdays';
            chips.push({ kind: 'repeat', label: 'Weekdays' });
        } else if ((rep = eat(new RegExp(`\\bevery\\s+${wd}(?:\\s*(?:,|and|&|\\s)\\s*${wd})+`, 'i')))) {
            // "every mon, wed, fri" -> custom multi-day
            const days = [];
            const re = new RegExp(wd, 'gi');
            let mm;
            while ((mm = re.exec(rep[0]))) { const i = this._weekdayIndex(mm[1]); if (i >= 0 && !days.includes(i)) days.push(i); }
            days.sort();
            fields.repeat = 'custom';
            fields.repeatDays = days;
            fields.dayOfWeek = days[0];
            chips.push({ kind: 'repeat', label: days.map(d => this.WEEKDAY_ABBR[d]).join(', ') });
        } else if ((rep = eat(new RegExp(`\\b(?:every\\s+${wd}|${wd}s)\\b`, 'i')))) {
            // "every monday" or "mondays" -> weekly
            const i = this._weekdayIndex(rep[1] || rep[2]);
            if (i >= 0) {
                fields.repeat = 'weekly';
                fields.dayOfWeek = i;
                chips.push({ kind: 'repeat', label: `Every ${this.WEEKDAY_ABBR[i]}` });
            }
        } else if ((rep = eat(/\b(?:every\s*week|weekly)\b/i))) {
            fields.repeat = 'weekly';
            fields.dayOfWeek = this._dow(todayISO);
            chips.push({ kind: 'repeat', label: `Every ${this.WEEKDAY_ABBR[fields.dayOfWeek]}` });
        } else if ((rep = eat(/\b(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+of\s+(?:every|each|the)\s+month\b/i))
                || (rep = eat(/\b(?:every\s*month|monthly)\s+on\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/i))) {
            // "5th of every month" / "monthly on the 5th" -> monthly on a day.
            // The day is stored via scheduledDate (getRepeatLabel reads its day).
            const day = Math.min(31, Math.max(1, +rep[1]));
            fields.repeat = 'monthly';
            fields.scheduledDate = this._nextDayOfMonth(todayISO, day);
            chips.push({ kind: 'repeat', label: `Monthly (${this._ordinal(day)})` });
        } else if ((rep = eat(/\b(?:every\s*month|monthly)\b/i))) {
            fields.repeat = 'monthly';
            chips.push({ kind: 'repeat', label: 'Monthly' });
        } else if ((rep = eat(/\b(?:every\s*year|yearly|annually|annual)\b/i))) {
            fields.repeat = 'annually';
            chips.push({ kind: 'repeat', label: 'Annually' });
        }

        // --- 4. date (only one) ---
        let dateISO = null;
        let m;
        if ((m = eat(/\b(today|tod)\b/i))) dateISO = todayISO;
        else if ((m = eat(/\b(tomorrow|tmrw|tmr|tmw|tom)\b/i))) dateISO = this._addDays(todayISO, 1);
        else if ((m = eat(/\byesterday\b/i))) dateISO = this._addDays(todayISO, -1);
        else if ((m = eat(/\bthis\s*weekend\b/i))) dateISO = this._addDays(todayISO, this._deltaToWeekday(todayISO, 6, false));
        else if ((m = eat(/\bnext\s*week\b/i))) dateISO = this._addDays(todayISO, 7);
        else if ((m = eat(/\bnext\s*month\b/i))) dateISO = this._addMonths(todayISO, 1);
        else if ((m = eat(/\bnext\s*year\b/i))) dateISO = this._addYears(todayISO, 1);
        else if ((m = eat(/\bin\s+(\d{1,3})\s*(day|week|month|year)s?\b/i))) {
            const n = +m[1], unit = m[2].toLowerCase();
            dateISO = unit === 'day' ? this._addDays(todayISO, n)
                : unit === 'week' ? this._addDays(todayISO, n * 7)
                : unit === 'month' ? this._addMonths(todayISO, n)
                : this._addYears(todayISO, n);
        } else if ((m = eat(new RegExp(`\\b(next|this)?\\s*${wd}\\b`, 'i')))) {
            const i = this._weekdayIndex(m[2]);
            if (i >= 0) dateISO = this._addDays(todayISO, this._deltaToWeekday(todayISO, i, /next/i.test(m[1] || '')));
        } else if ((m = eat(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/i))) {
            dateISO = this._monthDayISO(this._monthIndex(m[1]), +m[2], m[3] ? +m[3] : null, todayISO);
        } else if ((m = eat(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:,?\s*(\d{4}))?\b/i))) {
            dateISO = this._monthDayISO(this._monthIndex(m[2]), +m[1], m[3] ? +m[3] : null, todayISO);
        } else if ((m = eat(/\b(\d{4})-(\d{2})-(\d{2})\b/))) {
            dateISO = `${m[1]}-${m[2]}-${m[3]}`;
        } else if ((m = eat(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) {
            let yr = m[3] ? +m[3] : this._toDate(todayISO).getFullYear();
            if (yr < 100) yr += 2000;
            const mo = String(+m[1]).padStart(2, '0'), da = String(+m[2]).padStart(2, '0');
            dateISO = `${yr}-${mo}-${da}`;
        } else if ((m = eat(/\bon\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/i))
                || (m = eat(/\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/i))) {
            // A day-of-month with no month named ("on the 5th", "the 15th") ->
            // the next time that day comes around.
            dateISO = this._nextDayOfMonth(todayISO, Math.min(31, Math.max(1, +m[1])));
        }

        if (dateISO) {
            fields.scheduledDate = dateISO;
            chips.push({ kind: 'date', label: this._fmtDateLabel(dateISO, todayISO) });
        }

        // For a recurring rule with no explicit date, anchor the task on the
        // next occurrence so it lands in the right agenda bucket.
        if (!fields.scheduledDate) {
            if (fields.repeat === 'weekly' && fields.dayOfWeek != null) {
                fields.scheduledDate = this._addDays(todayISO, this._deltaToWeekday(todayISO, fields.dayOfWeek, false));
            } else if (fields.repeat === 'custom' && fields.repeatDays.length) {
                const next = Math.min(...fields.repeatDays.map(d => this._deltaToWeekday(todayISO, d, false)));
                fields.scheduledDate = this._addDays(todayISO, next);
            }
        }

        const title = work.replace(/\s+/g, ' ').trim();
        return { title, hasParse: chips.length > 0, fields, chips };
    },

    // Month/day (optional year) -> ISO. With no year, roll to next year only
    // when the date has already passed this year, so "jul 4" always means the
    // upcoming July 4th.
    _monthDayISO(monthIdx, day, year, todayISO) {
        if (monthIdx < 0 || day < 1 || day > 31) return null;
        const today = this._toDate(todayISO);
        let y = year != null ? year : today.getFullYear();
        const mk = (yy) => `${yy}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (year == null && this._toDate(mk(y)) < today) y += 1;
        return mk(y);
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = ScheduleQuickParse;
