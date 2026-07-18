import XCTest
@testable import AnjadheCore

/// Parity with the task/habit/date logic in mobile/app.js. Uses a UTC calendar
/// and a fixed "today" (Thu 2026-06-18) so day-of-week math is deterministic.
final class ScheduleLogicTests: XCTestCase {

    private let utc: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }()
    private func date(_ y: Int, _ m: Int, _ d: Int) -> Date {
        utc.date(from: DateComponents(timeZone: TimeZone(identifier: "UTC"), year: y, month: m, day: d))!
    }
    private let thu = { () -> Date in
        var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "UTC")!
        return c.date(from: DateComponents(timeZone: TimeZone(identifier: "UTC"), year: 2026, month: 6, day: 18))!
    }()

    func testDateHelpers() {
        XCTAssertEqual(DateLogic.dateStr(date(2026, 6, 18), utc), "2026-06-18")
        XCTAssertEqual(DateLogic.weekday(date(2026, 6, 18), utc), 4) // Thursday
        XCTAssertEqual(DateLogic.weekday(date(2026, 6, 20), utc), 6) // Saturday
        XCTAssertEqual(DateLogic.fmtTime("14:30"), "2:30 PM")
        XCTAssertEqual(DateLogic.fmtTime("09:05"), "9:05 AM")
        XCTAssertEqual(DateLogic.fmtTime("00:00"), "12:00 AM")
        XCTAssertEqual(DateLogic.fmtTime("12:00"), "12:00 PM")
        XCTAssertEqual(DateLogic.fmtTime("nope"), "nope")
    }

    func testRelDate() {
        XCTAssertEqual(DateLogic.relDate("2026-06-18T10:00:00.000Z", today: thu, cal: utc), "Today")
        XCTAssertEqual(DateLogic.relDate("2026-06-17", today: thu, cal: utc), "Yesterday")
        XCTAssertEqual(DateLogic.relDate("2026-06-15", today: thu, cal: utc), "3 days ago")
        XCTAssertEqual(DateLogic.relDate("", today: thu, cal: utc), "")
    }

    private func task(_ fields: [String: JSONValue]) -> JSONValue { .object(fields) }

    func testTaskRepeatModes() {
        let thu = self.thu
        let sat = date(2026, 6, 20)
        XCTAssertTrue(ScheduleLogic.taskDueOn(task(["repeat": .string("daily")]), on: thu, cal: utc))
        XCTAssertTrue(ScheduleLogic.taskDueOn(task(["repeat": .string("weekdays")]), on: thu, cal: utc))
        XCTAssertFalse(ScheduleLogic.taskDueOn(task(["repeat": .string("weekdays")]), on: sat, cal: utc))
        XCTAssertTrue(ScheduleLogic.taskDueOn(task(["repeat": .string("weekly"), "dayOfWeek": .number(4)]), on: thu, cal: utc))
        XCTAssertFalse(ScheduleLogic.taskDueOn(task(["repeat": .string("weekly"), "dayOfWeek": .number(4)]), on: sat, cal: utc))
        XCTAssertTrue(ScheduleLogic.taskDueOn(task(["repeat": .string("custom"), "repeatDays": .array([.number(1), .number(4)])]), on: thu, cal: utc))
        XCTAssertTrue(ScheduleLogic.taskDueOn(task(["repeat": .string("monthly"), "scheduledDate": .string("2026-03-18")]), on: thu, cal: utc))
        XCTAssertFalse(ScheduleLogic.taskDueOn(task(["repeat": .string("monthly"), "scheduledDate": .string("2026-03-18")]), on: sat, cal: utc))
        XCTAssertTrue(ScheduleLogic.taskDueOn(task(["repeat": .string("annually"), "scheduledDate": .string("2020-06-18")]), on: thu, cal: utc))
        XCTAssertTrue(ScheduleLogic.taskDueOn(task(["scheduledDate": .string("2026-06-18")]), on: thu, cal: utc)) // 'none'
        XCTAssertFalse(ScheduleLogic.taskDueOn(task(["scheduledDate": .string("2026-06-18")]), on: sat, cal: utc))
    }

    func testTaskDoneToday() {
        XCTAssertTrue(ScheduleLogic.taskDoneToday(task(["lastCompletedDate": .string("2026-06-18")]), today: thu, cal: utc))
        XCTAssertFalse(ScheduleLogic.taskDoneToday(task(["lastCompletedDate": .string("2026-06-17")]), today: thu, cal: utc))
    }

    private func habit(_ completions: [String], cadence: JSONValue? = nil) -> JSONValue {
        var m: [String: JSONValue] = ["completions": .array(completions.map { .object(["date": .string($0)]) })]
        if let cadence = cadence { m["cadence"] = cadence }
        return .object(m)
    }

    func testHabitCadenceAndDone() {
        let h = habit([], cadence: .object(["type": .string("specific"), "daysOfWeek": .array([.number(4)])]))
        XCTAssertTrue(ScheduleLogic.habitDueOn(h, on: thu, cal: utc))
        XCTAssertFalse(ScheduleLogic.habitDueOn(h, on: date(2026, 6, 20), cal: utc)) // Sat
        XCTAssertTrue(ScheduleLogic.habitDueOn(habit([]), on: date(2026, 6, 20), cal: utc)) // daily/unspecified
        XCTAssertTrue(ScheduleLogic.habitDoneOn(habit(["2026-06-18"]), "2026-06-18"))
        XCTAssertFalse(ScheduleLogic.habitDoneOn(habit(["2026-06-17"]), "2026-06-18"))
    }

    func testHabitStreak() {
        // Daily habit done today + the two days before → streak 3.
        XCTAssertEqual(ScheduleLogic.habitStreak(habit(["2026-06-18", "2026-06-17", "2026-06-16"]), today: thu, cal: utc), 3)
        // Gap: only today → streak 1.
        XCTAssertEqual(ScheduleLogic.habitStreak(habit(["2026-06-18", "2026-06-16"]), today: thu, cal: utc), 1)
        // Not done today but done yesterday → streak counts from yesterday (1).
        XCTAssertEqual(ScheduleLogic.habitStreak(habit(["2026-06-17"]), today: thu, cal: utc), 1)
        // Nothing → 0.
        XCTAssertEqual(ScheduleLogic.habitStreak(habit([]), today: thu, cal: utc), 0)
    }

    func testHabitRate() {
        // Daily habit, done on 5 of the last 10 days → 50%.
        let done = ["2026-06-18", "2026-06-17", "2026-06-16", "2026-06-15", "2026-06-14"]
        XCTAssertEqual(ScheduleLogic.habitRate(habit(done), days: 10, today: thu, cal: utc), 50)
    }
}
