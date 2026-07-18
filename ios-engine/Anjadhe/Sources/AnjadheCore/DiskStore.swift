import Foundation

/// File-backed persistence for `KVStore`.
///
/// Without this the on-device store is purely in-memory: every relaunch — and
/// every redeploy from Xcode — starts with an empty cache, which silently
/// discards ALL synced data and the channel pairing keys. That is why sync
/// looked broken and pairing dropped on every deploy: nothing was ever written
/// to disk. This writes the whole store as one JSON file in Application Support
/// (debounced, off the main thread) and hydrates it back at launch.
///
/// Pairing identity/record reach the native store via the JS bridge's `persist`
/// messages, so persisting `KVStore` is what makes pairing survive too.
public final class DiskStore {
    private let url: URL
    private let io = DispatchQueue(label: "com.anjadhe.diskstore", qos: .utility)
    private weak var kv: KVStore?
    private var saveScheduled = false

    public init(filename: String = "anjadhe-store.json", directory: URL? = nil) {
        let base = directory
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let dir = base.appendingPathComponent("Anjadhe", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        self.url = dir.appendingPathComponent(filename)
    }

    /// Path of the backing file (useful for diagnostics / tests).
    public var fileURL: URL { url }

    private struct Row: Codable { let value: JSONValue?; let deleted: Bool; let modifiedAt: String }

    /// Read the persisted rows (empty if the file is missing or unreadable).
    public func load() -> [String: RemoteEntry] {
        guard let data = try? Data(contentsOf: url),
              let rows = try? JSONDecoder().decode([String: Row].self, from: data) else { return [:] }
        return rows.mapValues { RemoteEntry(value: $0.value, deleted: $0.deleted, modifiedAt: $0.modifiedAt) }
    }

    /// Hydrate `kv` from disk now, and persist every future write back to disk.
    public func attach(to kv: KVStore) {
        self.kv = kv
        kv.hydrate(load())
        kv.persist = { [weak self] _, _ in self?.scheduleSave() }
    }

    /// Coalesce a burst of writes (e.g. a full sync touching many keys) into a
    /// single file write. Flag + snapshot are read on the main thread so we
    /// don't race the KVStore cache regardless of which thread `persist` fired on.
    private func scheduleSave() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, !self.saveScheduled else { return }
            self.saveScheduled = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                guard let self = self else { return }
                self.saveScheduled = false
                guard let snap = self.kv?.snapshot() else { return }
                self.io.async { self.write(snap) }
            }
        }
    }

    private func write(_ snapshot: [String: RemoteEntry]) {
        let rows = snapshot.mapValues { Row(value: $0.value, deleted: $0.deleted, modifiedAt: $0.modifiedAt) }
        guard let data = try? JSONEncoder().encode(rows) else { return }
        try? data.write(to: url, options: .atomic)
    }

    /// Synchronously flush the current state (call on app background/terminate
    /// so a write within the debounce window isn't lost). Must run on main.
    public func flushNow() {
        saveScheduled = false
        guard let snap = kv?.snapshot() else { return }
        io.sync { write(snap) }
    }
}
