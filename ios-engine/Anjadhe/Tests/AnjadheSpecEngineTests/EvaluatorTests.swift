import XCTest
@testable import AnjadheSpecEngine
import AnjadheCore

/// Behavior parity with scripts/spec-render-smoke.js — the Swift evaluator must
/// compute the same numbers / mutations the JS engine does.
final class EvaluatorTests: XCTestCase {

    private func store(_ seed: [String: JSONValue] = [:]) -> KVStore {
        let s = KVStore()
        for (k, v) in seed { s.set(k, v, now: "2026-06-18T10:00:00.000Z") }
        return s
    }
    private func rec(_ fields: [String: JSONValue]) -> JSONValue { .object(fields) }

    func testAggregationSum() {
        let s = store(["records:expenses": .array([
            rec(["amount": .number(10)]), rec(["amount": .number(5)]), rec(["amount": .number(20)])
        ])])
        XCTAssertEqual(SpecEvaluator.aggregate(.object(["sum": .string("expenses"), "field": .string("amount")]), s), 35)
        XCTAssertEqual(SpecEvaluator.resolveValue(.object(["sum": .string("expenses"), "field": .string("amount")]), s), "35")
    }

    func testCountWithWhereFilter() {
        let s = store(["records:tasks": .array([
            rec(["done": .bool(false)]), rec(["done": .bool(true)]), rec(["done": .bool(false)])
        ])])
        let openCount = JSONValue.object(["count": .string("tasks"), "where": .object(["done": .bool(false)])])
        XCTAssertEqual(SpecEvaluator.aggregate(openCount, s), 2)
    }

    func testShowWhen() {
        let empty = store(["records:tasks": .array([])])
        let cond = JSONValue.object(["count": .string("tasks"), "where": .object(["done": .bool(false)]), "op": .string("gt"), "value": .number(0)])
        XCTAssertFalse(SpecEvaluator.passesCondition(cond, empty))
        let filled = store(["records:tasks": .array([rec(["done": .bool(false)])])])
        XCTAssertTrue(SpecEvaluator.passesCondition(cond, filled))
    }

    func testActionsIncrementSingletonAndClear() {
        let s = KVStore()
        var counter = 0
        let env = SpecEvaluator.Env(now: { "2026-06-18T10:00:00.000Z" }, newId: { counter += 1; return "r_\(counter)" })
        let inc = JSONValue.object(["verb": .string("increment"), "collection": .string("counter"), "field": .string("count")])
        SpecEvaluator.runAction(inc, s, env)
        SpecEvaluator.runAction(inc, s, env)
        let recs = SpecEvaluator.records(s, "counter")
        XCTAssertEqual(recs.count, 1)
        XCTAssertEqual(recs[0]["count"]?.numberValue, 2)

        SpecEvaluator.runAction(.object(["verb": .string("clear_collection"), "collection": .string("counter")]), s, env)
        XCTAssertEqual(SpecEvaluator.records(s, "counter").count, 0)
    }

    func testAddRecordAppendsPresetValues() {
        let s = KVStore()
        var counter = 0
        let env = SpecEvaluator.Env(now: { "2026-06-18T10:00:00.000Z" }, newId: { counter += 1; return "r_\(counter)" })
        let add = JSONValue.object(["verb": .string("add_record"), "collection": .string("logs"), "values": .object(["note": .string("hi")])])
        SpecEvaluator.runAction(add, s, env)
        let recs = SpecEvaluator.records(s, "logs")
        XCTAssertEqual(recs.count, 1)
        XCTAssertEqual(recs[0]["note"]?.stringValue, "hi")
        XCTAssertNotNil(recs[0]["id"]?.stringValue)
        XCTAssertNotNil(recs[0]["createdAt"]?.stringValue)
    }

    func testChartGrouping() {
        let s = store(["records:expenses": .array([
            rec(["category": .string("food"), "amount": .number(10)]),
            rec(["category": .string("food"), "amount": .number(5)]),
            rec(["category": .string("rent"), "amount": .number(100)])
        ])])
        let data = JSONValue.object(["collection": .string("expenses"), "groupBy": .string("category"), "agg": .string("sum"), "field": .string("amount")])
        let points = SpecEvaluator.chartData(data, s)
        let byLabel = Dictionary(uniqueKeysWithValues: points.map { ($0.label, $0.value) })
        XCTAssertEqual(byLabel["food"], 15)
        XCTAssertEqual(byLabel["rent"], 100)
    }
}
