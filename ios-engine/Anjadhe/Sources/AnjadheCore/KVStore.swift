import Foundation

/// One synced entry as seen on the wire (the channel's value/tombstone shape).
public struct RemoteEntry: Equatable {
    public var value: JSONValue?   // nil when deleted
    public var deleted: Bool
    public var modifiedAt: String
    public init(value: JSONValue?, deleted: Bool, modifiedAt: String) {
        self.value = value; self.deleted = deleted; self.modifiedAt = modifiedAt
    }
}

/// The on-device key→JSON store and the sync seam — a native port of the
/// in-memory cache + `window.__anjadheStore` interface in
/// js/adapter/mobile-bridge.js. It owns the merge semantics (last-writer-wins by
/// `modifiedAt`, tombstones); persistence (SQLite/files) plugs in behind
/// `persist`, and the channel (JS-in-WebView now, native later) drives it
/// through `exportManifest`/`exportValues`/`applyRemoteSet`. This is the seam
/// the staged-hybrid architecture pivots on (docs/MOBILE_NATIVE.md).
public final class KVStore {
    enum Entry {
        case live(JSONValue, String)   // value, modifiedAt
        case tomb(String)              // tombAt
    }

    public static let epoch = "1970-01-01T00:00:00.000Z"

    private var cache: [String: Entry] = [:]
    /// Persistence hook (fire-and-forget), injected by the app. Tests leave it nil.
    public var persist: ((_ key: String, _ entry: RemoteEntry) -> Void)?

    /// Fired ONLY on local user writes (`set`/`delete`), not on `applyRemote*`
    /// — so the sync layer uploads user changes without looping on
    /// remote-applied ones. The SyncCoordinator forwards these into the JS mirror.
    public var onLocalWrite: ((_ key: String, _ value: JSONValue) -> Void)?
    public var onLocalDelete: ((_ key: String) -> Void)?

    public init() {}

    /// Rehydrate the cache from persisted rows at launch.
    public func hydrate(_ rows: [String: RemoteEntry]) {
        for (k, e) in rows {
            cache[k] = e.deleted ? .tomb(e.modifiedAt) : .live(e.value ?? .null, e.modifiedAt)
        }
    }

    // MARK: Local reads/writes (the electronStore surface)

    public func get(_ key: String) -> JSONValue? {
        if case .live(let v, _)? = cache[key] { return v }
        return nil
    }

    public func has(_ key: String) -> Bool {
        if case .live? = cache[key] { return true }
        return false
    }

    @discardableResult
    public func set(_ key: String, _ value: JSONValue, now: String) -> Bool {
        cache[key] = .live(value, now)
        persist?(key, RemoteEntry(value: value, deleted: false, modifiedAt: now))
        onLocalWrite?(key, value)
        return true
    }

    @discardableResult
    public func delete(_ key: String, now: String) -> Bool {
        cache[key] = .tomb(now)
        persist?(key, RemoteEntry(value: nil, deleted: true, modifiedAt: now))
        onLocalDelete?(key)
        return true
    }

    public var liveKeys: [String] {
        cache.compactMap { if case .live = $0.value { return $0.key }; return nil }
    }

    // MARK: Sync seam (mirror of __anjadheStore)

    public func localModifiedAt(_ key: String) -> String {
        switch cache[key] {
        case .live(_, let m): return m
        case .tomb(let a): return a
        case nil: return Self.epoch
        }
    }

    /// {key: timestamp} for every key incl. tombstones — tiny, cheap to build.
    public func exportManifest() -> [String: String] {
        var m: [String: String] = [:]
        for (k, e) in cache {
            switch e { case .live(_, let at): m[k] = at; case .tomb(let at): m[k] = at }
        }
        return m
    }

    /// Every entry (live + tombstones) — the snapshot the native sync host
    /// hydrates the JS mirror with at boot.
    public func snapshot() -> [String: RemoteEntry] {
        var out: [String: RemoteEntry] = [:]
        for (k, e) in cache {
            switch e {
            case .live(let v, let at): out[k] = RemoteEntry(value: v, deleted: false, modifiedAt: at)
            case .tomb(let at): out[k] = RemoteEntry(value: nil, deleted: true, modifiedAt: at)
            }
        }
        return out
    }

    /// Values (or tombstones) for a specific subset of keys.
    public func exportValues(_ keys: [String]) -> [String: RemoteEntry] {
        var out: [String: RemoteEntry] = [:]
        for k in keys {
            switch cache[k] {
            case .live(let v, let at): out[k] = RemoteEntry(value: v, deleted: false, modifiedAt: at)
            case .tomb(let at): out[k] = RemoteEntry(value: nil, deleted: true, modifiedAt: at)
            case nil: break
            }
        }
        return out
    }

    /// Apply a value from the Mac, keeping the Mac's timestamp (not "now").
    public func applyRemote(_ key: String, value: JSONValue, modifiedAt: String) {
        cache[key] = .live(value, modifiedAt)
        persist?(key, RemoteEntry(value: value, deleted: false, modifiedAt: modifiedAt))
    }

    public func applyRemoteDelete(_ key: String, modifiedAt: String) {
        cache[key] = .tomb(modifiedAt)
        persist?(key, RemoteEntry(value: nil, deleted: true, modifiedAt: modifiedAt))
    }

    /// Merge a {key: entry} set from the Mac, applying only strictly-newer
    /// remotes (mirror of applyValues in js/adapter/mobile-sync.js). Returns the
    /// number of keys changed.
    @discardableResult
    public func applyRemoteSet(_ values: [String: RemoteEntry]) -> Int {
        var applied = 0
        for (key, remote) in values where !remote.modifiedAt.isEmpty {
            if Self.date(remote.modifiedAt) <= Self.date(localModifiedAt(key)) { continue }
            if remote.deleted {
                applyRemoteDelete(key, modifiedAt: remote.modifiedAt)
            } else if let v = remote.value {
                applyRemote(key, value: v, modifiedAt: remote.modifiedAt)
            }
            applied += 1
        }
        return applied
    }

    // MARK: Timestamps

    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func date(_ s: String) -> Date {
        isoFractional.date(from: s) ?? isoPlain.date(from: s) ?? Date(timeIntervalSince1970: 0)
    }

    /// ISO-8601 with milliseconds + Z, matching JS `new Date().toISOString()`.
    public static func nowISO(_ date: Date = Date()) -> String {
        isoFractional.string(from: date)
    }
}
