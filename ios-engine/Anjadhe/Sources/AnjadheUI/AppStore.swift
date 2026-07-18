import Foundation
import Combine
import AnjadheCore
import AnjadheSpecEngine

/// SwiftUI-observable wrapper around the native `KVStore`. Views read records
/// through it and re-render when `revision` bumps after any write. This is the
/// data layer for both spec apps and the built-in native screens.
public final class AppStore: ObservableObject {
    public let kv: KVStore
    @Published public private(set) var revision: Int = 0
    /// Retains the disk backer (its persist closure holds it weakly).
    private var disk: DiskStore?

    public init(kv: KVStore = KVStore()) { self.kv = kv }

    /// Build a disk-backed store: hydrate from the on-device file at launch and
    /// persist every write, so synced data AND channel pairing survive relaunch
    /// and redeploys. Use this for the real app; the bare `init` stays in-memory
    /// for tests and seeded screenshots.
    public static func persistent(directory: URL? = nil) -> AppStore {
        let kv = KVStore()
        let store = AppStore(kv: kv)
        let disk = DiskStore(directory: directory)
        disk.attach(to: kv)
        store.disk = disk
        return store
    }

    /// Flush pending writes synchronously (call on background/terminate).
    public func flush() { disk?.flushNow() }

    public func bump() { revision += 1 }

    // MARK: Records (records:<collection> arrays)

    public func records(_ collection: String) -> [JSONValue] {
        SpecEvaluator.records(kv, collection)
    }

    public func saveRecords(_ collection: String, _ arr: [JSONValue]) {
        kv.set("records:\(collection)", .array(arr), now: KVStore.nowISO())
        bump()
    }

    public func appendRecord(_ collection: String, _ fields: [String: JSONValue]) {
        var rec = fields
        rec["id"] = .string(Self.newId())
        rec["createdAt"] = .string(KVStore.nowISO())
        var arr = records(collection)
        arr.append(.object(rec))
        saveRecords(collection, arr)
    }

    public func deleteRecord(_ collection: String, id: String) {
        saveRecords(collection, records(collection).filter { $0["id"]?.stringValue != id })
    }

    // MARK: Actions / scoped UI state

    public func run(_ action: JSONValue) {
        SpecEvaluator.runAction(action, kv, .live)
        bump()
    }

    public func uiState(_ key: String) -> JSONValue? { kv.get(key) }
    public func setUIState(_ key: String, _ value: JSONValue) {
        kv.set(key, value, now: KVStore.nowISO()); bump()
    }

    public static func newId() -> String {
        "r_\(Int(Date().timeIntervalSince1970 * 1000))_\(Int.random(in: 0..<1_000_000))"
    }

    // MARK: Built-in app blobs — generic list helpers
    // Built-in apps store one blob per key (e.g. "schedule") holding an array
    // under a sub-key (e.g. "scheduleItems"). These mirror the mobile app's
    // load/save/patch helpers so each native screen stays small. All writes
    // bump the local-write hook → sync upload.

    /// The desktop StorageManager namespaces every app blob as `app_<name>`
    /// (storage-manager.js), and those are the keys that sync. The native
    /// screens pass the bare name ("schedule", "habits", …), so map it here —
    /// otherwise reads/writes miss the synced data entirely and screens look
    /// empty even when sync succeeded.
    public static func appKey(_ blobKey: String) -> String {
        blobKey.hasPrefix("app_") ? blobKey : "app_\(blobKey)"
    }

    public func items(_ blobKey: String, _ arrayKey: String) -> [JSONValue] {
        kv.get(Self.appKey(blobKey))?[arrayKey]?.arrayValue ?? []
    }

    public func saveItems(_ blobKey: String, _ arrayKey: String, _ list: [JSONValue]) {
        let key = Self.appKey(blobKey)
        var blob = kv.get(key)?.objectValue ?? [:]
        blob[arrayKey] = .array(list)
        kv.set(key, .object(blob), now: KVStore.nowISO())
        bump()
    }

    @discardableResult
    public func addItem(_ blobKey: String, _ arrayKey: String, _ fields: [String: JSONValue]) -> String {
        let id = Self.newId()
        let now = KVStore.nowISO()
        var rec = fields
        rec["id"] = .string(id)
        rec["createdAt"] = .string(now)
        rec["modifiedAt"] = .string(now)
        var arr = items(blobKey, arrayKey)
        arr.insert(.object(rec), at: 0)
        saveItems(blobKey, arrayKey, arr)
        return id
    }

    public func patchItem(_ blobKey: String, _ arrayKey: String, id: String, _ fields: [String: JSONValue]) {
        var arr = items(blobKey, arrayKey)
        guard let i = arr.firstIndex(where: { $0["id"]?.stringValue == id }), case .object(var rec) = arr[i] else { return }
        for (k, v) in fields { rec[k] = v }
        rec["modifiedAt"] = .string(KVStore.nowISO())
        arr[i] = .object(rec)
        saveItems(blobKey, arrayKey, arr)
    }

    public func deleteItem(_ blobKey: String, _ arrayKey: String, id: String) {
        saveItems(blobKey, arrayKey, items(blobKey, arrayKey).filter { $0["id"]?.stringValue != id })
    }

    public func findItem(_ blobKey: String, _ arrayKey: String, id: String) -> JSONValue? {
        items(blobKey, arrayKey).first { $0["id"]?.stringValue == id }
    }

    // MARK: Habit ↔ Tasks scheduling + focus-area links (port of mobile/app.js)

    public func linkedHabitTask(_ habitId: String) -> JSONValue? {
        items("schedule", "scheduleItems").first { $0["sourceHabitId"]?.stringValue == habitId }
    }

    /// Create / update / remove a habit's linked schedule task. `sched` is the
    /// (start, end?, notify) to project a repeating task matching the habit's
    /// cadence, or nil to unschedule.
    public func syncHabitSchedule(habitId: String, sched: (start: String, end: String?, notify: Int)?) {
        var arr = items("schedule", "scheduleItems")
        let idx = arr.firstIndex { $0["sourceHabitId"]?.stringValue == habitId }
        guard let habit = findItem("habits", "habits", id: habitId)?.objectValue else {
            if let i = idx { arr.remove(at: i); saveItems("schedule", "scheduleItems", arr) } // habit deleted
            return
        }
        guard let s = sched else {
            if let i = idx { arr.remove(at: i); saveItems("schedule", "scheduleItems", arr) }
            return
        }
        let cadence = habit["cadence"]?.objectValue
        let repeatMode = (cadence?["type"]?.stringValue == "specific") ? "custom" : "daily"
        let repeatDays: [JSONValue] = repeatMode == "custom" ? (cadence?["daysOfWeek"]?.arrayValue ?? []) : []
        let now = KVStore.nowISO()
        var fields: [String: JSONValue] = [
            "title": habit["action"] ?? .string(""), "startTime": .string(s.start),
            "endTime": s.end.map { .string($0) } ?? .null, "notifyBefore": .number(Double(s.notify)),
            "repeat": .string(repeatMode), "dayOfWeek": .null, "repeatDays": .array(repeatDays),
            "scheduledDate": .null, "reminderDaysBefore": .array([]), "modifiedAt": .string(now),
        ]
        if let i = idx, case .object(var rec) = arr[i] {
            for (k, v) in fields { rec[k] = v }
            arr[i] = .object(rec)
        } else {
            fields["id"] = .string(Self.newId()); fields["description"] = .string("")
            fields["lastCompletedDate"] = ScheduleLogic.habitDoneToday(.object(habit)) ? .string(DateLogic.todayStr()) : .null
            fields["sourceHabitId"] = .string(habitId); fields["createdAt"] = .string(now)
            arr.insert(.object(fields), at: 0)
        }
        saveItems("schedule", "scheduleItems", arr)
    }

    public func focusAreas() -> [JSONValue] { items("focus", "focusItems") }

    public func linkedFocusId(_ habitId: String) -> String {
        for l in items("links", "links") {
            let o = l.objectValue
            if o?["sourceApp"]?.stringValue == "habits", o?["sourceId"]?.stringValue == habitId, o?["targetApp"]?.stringValue == "focus" {
                return o?["targetId"]?.stringValue ?? ""
            }
            if o?["sourceApp"]?.stringValue == "focus", o?["targetApp"]?.stringValue == "habits", o?["targetId"]?.stringValue == habitId {
                return o?["sourceId"]?.stringValue ?? ""
            }
        }
        return ""
    }

    /// IDs of items in `targetApp` linked to (app, id) — checks both link
    /// directions, mirroring the Mac's LinkManager.getLinksFor. App names match
    /// the desktop: "focus", "goals", "habits", "schedule" (tasks).
    public func linkedIds(_ app: String, _ id: String, to targetApp: String) -> [String] {
        var out: [String] = []
        for l in items("links", "links") {
            guard let o = l.objectValue else { continue }
            if o["sourceApp"]?.stringValue == app, o["sourceId"]?.stringValue == id,
               o["targetApp"]?.stringValue == targetApp, let t = o["targetId"]?.stringValue {
                out.append(t)
            } else if o["targetApp"]?.stringValue == app, o["targetId"]?.stringValue == id,
                      o["sourceApp"]?.stringValue == targetApp, let s = o["sourceId"]?.stringValue {
                out.append(s)
            }
        }
        return out
    }

    /// Resolve linked items to their records (blobKey/arrayKey), dropping any
    /// dangling links whose target no longer exists.
    public func linkedItems(_ app: String, _ id: String, targetApp: String, blobKey: String, arrayKey: String) -> [JSONValue] {
        let ids = Set(linkedIds(app, id, to: targetApp))
        guard !ids.isEmpty else { return [] }
        return items(blobKey, arrayKey).filter { ids.contains($0["id"]?.stringValue ?? "") }
    }

    public func linkFocus(habitId: String, focusId: String) {
        var links = items("links", "links").filter { l in
            let o = l.objectValue
            let a = o?["sourceApp"]?.stringValue == "habits" && o?["sourceId"]?.stringValue == habitId && o?["targetApp"]?.stringValue == "focus"
            let b = o?["sourceApp"]?.stringValue == "focus" && o?["targetApp"]?.stringValue == "habits" && o?["targetId"]?.stringValue == habitId
            return !(a || b)
        }
        if !focusId.isEmpty {
            links.append(.object(["id": .string(Self.newId()), "sourceApp": .string("habits"), "sourceId": .string(habitId),
                                  "targetApp": .string("focus"), "targetId": .string(focusId), "createdAt": .string(KVStore.nowISO())]))
        }
        saveItems("links", "links", links)
    }

    /// Toggle a habit's completion for a specific day (used by the Today toggle
    /// and the stats heatmap).
    public func toggleHabitCompletion(id: String, dateStr: String) {
        guard var habit = findItem("habits", "habits", id: id)?.objectValue else { return }
        var comps = habit["completions"]?.arrayValue ?? []
        if let i = comps.firstIndex(where: { $0["date"]?.stringValue == dateStr }) {
            comps.remove(at: i)
        } else {
            comps.append(.object(["date": .string(dateStr)]))
        }
        patchItem("habits", "habits", id: id, ["completions": .array(comps)])
    }
}
