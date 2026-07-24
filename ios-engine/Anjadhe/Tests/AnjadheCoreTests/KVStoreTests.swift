import XCTest
@testable import AnjadheCore

final class KVStoreTests: XCTestCase {
    func testSetGetDelete() {
        let s = KVStore()
        XCTAssertNil(s.get("a"))
        s.set("a", .string("x"), now: "2026-06-18T10:00:00.000Z")
        XCTAssertEqual(s.get("a"), .string("x"))
        XCTAssertTrue(s.has("a"))
        s.delete("a", now: "2026-06-18T11:00:00.000Z")
        XCTAssertNil(s.get("a"))
        XCTAssertFalse(s.has("a"))
    }

    func testManifestAndLocalModifiedAt() {
        let s = KVStore()
        XCTAssertEqual(s.localModifiedAt("missing"), KVStore.epoch)
        s.set("a", .number(1), now: "2026-06-18T10:00:00.000Z")
        s.delete("b", now: "2026-06-18T09:00:00.000Z")
        let m = s.exportManifest()
        XCTAssertEqual(m["a"], "2026-06-18T10:00:00.000Z")
        XCTAssertEqual(m["b"], "2026-06-18T09:00:00.000Z") // tombstone timestamp
    }

    func testApplyRemoteSetIsLastWriterWins() {
        let s = KVStore()
        s.set("a", .string("local"), now: "2026-06-18T10:00:00.000Z")

        // Older remote is ignored.
        XCTAssertEqual(s.applyRemoteSet([
            "a": RemoteEntry(value: .string("old"), deleted: false, modifiedAt: "2026-06-18T09:00:00.000Z")
        ]), 0)
        XCTAssertEqual(s.get("a"), .string("local"))

        // Strictly-newer remote wins.
        XCTAssertEqual(s.applyRemoteSet([
            "a": RemoteEntry(value: .string("new"), deleted: false, modifiedAt: "2026-06-18T11:00:00.000Z")
        ]), 1)
        XCTAssertEqual(s.get("a"), .string("new"))

        // Newer delete tombstones it (keeps the Mac's timestamp).
        XCTAssertEqual(s.applyRemoteSet([
            "a": RemoteEntry(value: nil, deleted: true, modifiedAt: "2026-06-18T12:00:00.000Z")
        ]), 1)
        XCTAssertNil(s.get("a"))
        XCTAssertEqual(s.localModifiedAt("a"), "2026-06-18T12:00:00.000Z")
    }

    func testFirstSyncAdoptsMacData() {
        // Empty local store + remote set => phone adopts the Mac's data.
        let s = KVStore()
        let applied = s.applyRemoteSet([
            "notes": RemoteEntry(value: .object(["notes": .array([])]), deleted: false, modifiedAt: "2026-06-18T10:00:00.000Z")
        ])
        XCTAssertEqual(applied, 1)
        XCTAssertEqual(s.exportValues(["notes"])["notes"]?.modifiedAt, "2026-06-18T10:00:00.000Z")
        XCTAssertEqual(s.exportValues(["notes"])["notes"]?.deleted, false)
    }

    func testPersistHookFires() {
        let s = KVStore()
        var writes: [String] = []
        s.persist = { key, entry in writes.append("\(key):\(entry.deleted ? "del" : "set")") }
        s.set("a", .number(1), now: "2026-06-18T10:00:00.000Z")
        s.delete("a", now: "2026-06-18T11:00:00.000Z")
        s.applyRemote("b", value: .bool(true), modifiedAt: "2026-06-18T10:00:00.000Z")
        XCTAssertEqual(writes, ["a:set", "a:del", "b:set"])
    }

    func testDiskStoreRoundTrip() throws {
        // A unique temp dir so the test is isolated and repeatable.
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("anjadhe-disktest-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        // Write through one store, flush, then load into a fresh store.
        let kv1 = KVStore()
        let disk1 = DiskStore(directory: dir)
        disk1.attach(to: kv1)
        kv1.set("schedule", try JSONValue.parse(#"{"scheduleItems":[{"id":"t1"}]}"#), now: "2026-06-18T10:00:00.000Z")
        kv1.set("anjadhe:channel:identity", .string("pub-hex"), now: "2026-06-18T10:01:00.000Z")
        kv1.delete("old", now: "2026-06-18T10:02:00.000Z")
        disk1.flushNow()

        let rows = DiskStore(directory: dir).load()
        XCTAssertEqual(rows["schedule"]?.value?["scheduleItems"]?.arrayValue?.count, 1)
        XCTAssertEqual(rows["anjadhe:channel:identity"]?.value, .string("pub-hex")) // pairing survives
        XCTAssertEqual(rows["old"]?.deleted, true)                                  // tombstone survives

        let kv2 = KVStore()
        DiskStore(directory: dir).attach(to: kv2)
        XCTAssertEqual(kv2.get("anjadhe:channel:identity"), .string("pub-hex"))
        XCTAssertNil(kv2.get("old"))
    }

    func testRoundTripJSONValue() throws {
        let v = try JSONValue.parse(#"{"a":1,"b":[true,null,"x"],"c":{"d":2.5}}"#)
        let data = try JSONEncoder().encode(v)
        let again = try JSONDecoder().decode(JSONValue.self, from: data)
        XCTAssertEqual(v, again)
        XCTAssertEqual(v["a"], .number(1))
        XCTAssertEqual(v["b"]?.arrayValue?.count, 3)
    }
}
