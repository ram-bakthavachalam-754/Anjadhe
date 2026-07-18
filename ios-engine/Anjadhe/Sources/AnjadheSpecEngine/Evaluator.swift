import Foundation
import AnjadheCore

/// Behavior port of the evaluation logic in `js/core/spec-renderer.js`:
/// computed aggregations, `showWhen`, chart grouping, and the bounded action
/// verbs. SwiftUI views call these; the logic is identical to the JS engine so
/// a spec behaves the same on Mac and iPhone. Records live in the KV store under
/// `records:<collection>` as a JSON array (the same layout the spec apps use).
public enum SpecEvaluator {

    public static func records(_ store: KVStore, _ collection: String) -> [JSONValue] {
        store.get("records:\(collection)")?.arrayValue ?? []
    }

    static func matches(_ r: JSONValue, _ whereObj: [String: JSONValue]?) -> Bool {
        guard let w = whereObj else { return true }
        for (k, v) in w where r[k] != v { return false }
        return true
    }

    static func aggOf(_ o: [String: JSONValue]) -> String? {
        ["count", "sum", "avg", "min", "max"].first { o[$0]?.stringValue != nil }
    }

    static func reduce(_ nums: [Double], _ agg: String) -> Double {
        if nums.isEmpty { return 0 }
        switch agg {
        case "sum": return nums.reduce(0, +)
        case "avg": return nums.reduce(0, +) / Double(nums.count)
        case "min": return nums.min()!
        case "max": return nums.max()!
        default: return 0
        }
    }

    /// Evaluate a computed aggregation `{count|sum|avg|min|max: coll, field?, where?}`.
    public static func aggregate(_ v: JSONValue, _ store: KVStore) -> Double {
        guard case .object(let o) = v, let agg = aggOf(o), let coll = o[agg]?.stringValue else { return 0 }
        var recs = records(store, coll)
        recs = recs.filter { matches($0, o["where"]?.objectValue) }
        if agg == "count" { return Double(recs.count) }
        let field = o["field"]?.stringValue ?? ""
        return reduce(recs.compactMap { $0[field]?.numberValue }, agg)
    }

    /// Display string for a scalar-or-computed value (matches `_resolveValue`).
    public static func resolveValue(_ v: JSONValue, _ store: KVStore) -> String {
        if case .object(let o) = v, aggOf(o) != nil {
            let n = aggregate(v, store)
            return n == n.rounded() ? String(Int(n)) : String((n * 100).rounded() / 100)
        }
        switch v {
        case .string(let s): return s
        case .number(let n): return n == n.rounded() ? String(Int(n)) : String(n)
        case .bool(let b): return b ? "true" : "false"
        default: return ""
        }
    }

    /// `showWhen`: an aggregation compared to a constant.
    public static func passesCondition(_ cond: JSONValue, _ store: KVStore) -> Bool {
        guard case .object(let o) = cond else { return true }
        let left = aggregate(cond, store)
        let right = o["value"]?.numberValue ?? 0
        switch o["op"]?.stringValue {
        case "gt": return left > right
        case "gte": return left >= right
        case "lt": return left < right
        case "lte": return left <= right
        case "eq": return left == right
        case "ne": return left != right
        default: return true
        }
    }

    // MARK: Chart data

    private static func keyString(_ v: JSONValue?) -> String {
        switch v {
        case .string(let s): return s
        case .number(let n): return n == n.rounded() ? String(Int(n)) : String(n)
        case .bool(let b): return b ? "true" : "false"
        default: return "—"
        }
    }

    /// Resolve chart.data to ordered (label, value) points — static array or a
    /// `{collection, groupBy, agg, field, where}` grouping (`_resolveChartData`).
    public static func chartData(_ d: JSONValue, _ store: KVStore) -> [(label: String, value: Double)] {
        if let arr = d.arrayValue {
            return arr.map { ($0["label"]?.stringValue ?? "", $0["value"]?.numberValue ?? 0) }
        }
        guard case .object(let o) = d, let coll = o["collection"]?.stringValue, let groupBy = o["groupBy"]?.stringValue else { return [] }
        let recs = records(store, coll).filter { matches($0, o["where"]?.objectValue) }
        var order: [String] = []
        var groups: [String: [JSONValue]] = [:]
        for r in recs {
            let key = keyString(r[groupBy])
            if groups[key] == nil { groups[key] = []; order.append(key) }
            groups[key]!.append(r)
        }
        let agg = o["agg"]?.stringValue ?? "count"
        let field = o["field"]?.stringValue ?? ""
        return order.map { label in
            let rs = groups[label]!
            let value = agg == "count" ? Double(rs.count) : reduce(rs.compactMap { $0[field]?.numberValue }, agg)
            return (label, value)
        }
    }

    // MARK: Actions

    /// Injected clock + id source so actions are deterministic in tests and
    /// match the JS record shape (`id`, `createdAt`).
    public struct Env {
        public var now: () -> String
        public var newId: () -> String
        public init(now: @escaping () -> String, newId: @escaping () -> String) { self.now = now; self.newId = newId }
        public static var live: Env {
            Env(now: { KVStore.nowISO() },
                newId: { "r_\(Int(Date().timeIntervalSince1970 * 1000))_\(Int.random(in: 0..<1_000_000))" })
        }
    }

    /// Run one bounded action verb against the store (`_runAction`). navigate /
    /// open_url are host concerns and don't touch the store.
    public static func runAction(_ a: JSONValue, _ store: KVStore, _ env: Env) {
        guard case .object(let o) = a, let verb = o["verb"]?.stringValue else { return }
        func save(_ c: String, _ arr: [JSONValue]) { store.set("records:\(c)", .array(arr), now: env.now()) }
        func newRecord(_ extra: [String: JSONValue]) -> JSONValue {
            var m: [String: JSONValue] = ["id": .string(env.newId()), "createdAt": .string(env.now())]
            for (k, v) in extra { m[k] = v }
            return .object(m)
        }
        // First record of the collection, creating one if empty (the singleton
        // counter/toggle pattern).
        func singleton(_ c: String) -> [JSONValue] {
            var arr = records(store, c)
            if arr.isEmpty { arr.append(newRecord([:])) }
            return arr
        }
        switch verb {
        case "navigate", "open_url":
            return
        case "add_record":
            guard let coll = o["collection"]?.stringValue else { return }
            var arr = records(store, coll)
            arr.append(newRecord(o["values"]?.objectValue ?? [:]))
            save(coll, arr)
        case "clear_collection":
            guard let coll = o["collection"]?.stringValue else { return }
            save(coll, [])
        case "set_field":
            guard let coll = o["collection"]?.stringValue, let field = o["field"]?.stringValue, let val = o["value"] else { return }
            var arr = singleton(coll)
            if case .object(var rec) = arr[0] { rec[field] = val; arr[0] = .object(rec) }
            save(coll, arr)
        case "increment":
            guard let coll = o["collection"]?.stringValue, let field = o["field"]?.stringValue else { return }
            let by = o["by"]?.numberValue ?? 1
            var arr = singleton(coll)
            if case .object(var rec) = arr[0] {
                let cur = rec[field]?.numberValue ?? 0
                rec[field] = .number(cur + by)
                arr[0] = .object(rec)
            }
            save(coll, arr)
        default:
            return
        }
    }
}
