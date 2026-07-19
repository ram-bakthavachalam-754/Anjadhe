import Foundation

/// Task-repeat and habit-cadence/streak logic ported from `mobile/app.js`
/// (`taskDueOn`, `habitDueOn`, `habitStreak`, …). Operates on `JSONValue`
/// records — the same shape the synced blobs carry — so it matches the JS
/// exactly. `today`/`cal` are injectable for deterministic tests.
public enum ScheduleLogic {

    // MARK: Tasks

    public static func taskDueOn(_ task: JSONValue, on date: Date, cal: Calendar = .current) -> Bool {
        let dow = DateLogic.weekday(date, cal)
        let ds = DateLogic.dateStr(date, cal)
        switch task["repeat"]?.stringValue ?? "none" {
        case "daily":
            return true
        case "weekdays":
            return dow >= 1 && dow <= 5
        case "weekly":
            return intOf(task["dayOfWeek"]) == dow
        case "custom":
            return (task["repeatDays"]?.arrayValue ?? []).contains { intOf($0) == dow }
        case "monthly":
            guard let sd = task["scheduledDate"]?.stringValue, sd.count >= 10 else { return false }
            return slice(sd, 8, 10) == slice(ds, 8, 10)
        case "annually":
            guard let sd = task["scheduledDate"]?.stringValue, sd.count >= 5 else { return false }
            return sliceFrom(sd, 5) == sliceFrom(ds, 5)
        default: // 'none'
            return task["scheduledDate"]?.stringValue == ds
        }
    }

    public static func taskDueToday(_ task: JSONValue, today: Date = Date(), cal: Calendar = .current) -> Bool {
        taskDueOn(task, on: today, cal: cal)
    }

    public static func taskDoneToday(_ task: JSONValue, today: Date = Date(), cal: Calendar = .current) -> Bool {
        task["lastCompletedDate"]?.stringValue == DateLogic.todayStr(today, cal)
    }

    // MARK: Habits

    public static func habitDueOn(_ habit: JSONValue, on date: Date, cal: Calendar = .current) -> Bool {
        let c = habit["cadence"]?.objectValue
        if c?["type"]?.stringValue == "specific" {
            let dow = DateLogic.weekday(date, cal)
            return (c?["daysOfWeek"]?.arrayValue ?? []).contains { intOf($0) == dow }
        }
        return true // 'daily' or unspecified
    }

    public static func habitDueToday(_ habit: JSONValue, today: Date = Date(), cal: Calendar = .current) -> Bool {
        habitDueOn(habit, on: today, cal: cal)
    }

    public static func habitDoneOn(_ habit: JSONValue, _ dStr: String) -> Bool {
        (habit["completions"]?.arrayValue ?? []).contains { $0["date"]?.stringValue == dStr }
    }

    public static func habitDoneToday(_ habit: JSONValue, today: Date = Date(), cal: Calendar = .current) -> Bool {
        habitDoneOn(habit, DateLogic.todayStr(today, cal))
    }

    /// Current unbroken streak of completed due-days (JS `habitStreak`).
    public static func habitStreak(_ habit: JSONValue, today: Date = Date(), cal: Calendar = .current) -> Int {
        var d = today
        if !habitDoneOn(habit, DateLogic.dateStr(d, cal)) { d = cal.date(byAdding: .day, value: -1, to: d)! }
        var streak = 0
        for _ in 0..<366 {
            if habitDueOn(habit, on: d, cal: cal) {
                if habitDoneOn(habit, DateLogic.dateStr(d, cal)) { streak += 1 } else { break }
            }
            d = cal.date(byAdding: .day, value: -1, to: d)!
        }
        return streak
    }

    /// Longest run of completed due-days, first completion → today (JS
    /// `habitLongestStreak`).
    public static func habitLongestStreak(_ habit: JSONValue, today: Date = Date(), cal: Calendar = .current) -> Int {
        let dates = (habit["completions"]?.arrayValue ?? []).compactMap { $0["date"]?.stringValue }.sorted()
        guard let first = dates.first, let startDate = DateLogic.parseISO(first) else { return 0 }
        var d = cal.startOfDay(for: startDate)
        let end = cal.startOfDay(for: today)
        var longest = 0, run = 0
        while d <= end {
            if habitDueOn(habit, on: d, cal: cal) {
                if habitDoneOn(habit, DateLogic.dateStr(d, cal)) { run += 1; longest = max(longest, run) }
                else { run = 0 }
            }
            d = cal.date(byAdding: .day, value: 1, to: d)!
        }
        return longest
    }

    /// Completion % over the last `days` due-days (JS `habitRate`).
    public static func habitRate(_ habit: JSONValue, days: Int = 30, today: Date = Date(), cal: Calendar = .current) -> Int {
        let n = days == 0 ? 30 : days
        var due = 0, done = 0
        for i in 0..<n {
            let d = cal.date(byAdding: .day, value: -i, to: today)!
            if habitDueOn(habit, on: d, cal: cal) {
                due += 1
                if habitDoneOn(habit, DateLogic.dateStr(d, cal)) { done += 1 }
            }
        }
        return due == 0 ? 0 : Int((Double(done) / Double(due) * 100).rounded())
    }

    // MARK: internals

    private static func intOf(_ v: JSONValue?) -> Int {
        if let n = v?.numberValue { return Int(n) }
        return -999
    }

    /// JS `String.slice(start, end)` on characters.
    static func slice(_ s: String, _ start: Int, _ end: Int) -> String {
        let chars = Array(s)
        guard start < chars.count else { return "" }
        return String(chars[start..<min(end, chars.count)])
    }
    static func sliceFrom(_ s: String, _ start: Int) -> String {
        let chars = Array(s)
        guard start < chars.count else { return "" }
        return String(chars[start...])
    }
}
