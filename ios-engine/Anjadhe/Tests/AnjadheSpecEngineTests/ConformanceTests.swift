import XCTest
import Foundation
@testable import AnjadheSpecEngine
import AnjadheCore

/// Runs the SAME tests/spec/corpus.json the JS engine does, against the Swift
/// validator — the cross-engine conformance gate. Also checks the Swift
/// known-types set against the committed catalog.json so the two can't drift.
final class ConformanceTests: XCTestCase {

    struct Corpus: Decodable { let cases: [Case] }
    struct Case: Decodable { let name: String; let spec: JSONValue; let expect: Expect }
    struct Expect: Decodable { let valid: Bool?; let errorIncludes: [String]? }

    struct Catalog: Decodable { let specVersion: Int; let components: [Comp] }
    struct Comp: Decodable { let type: String }

    /// Repo root, derived from this test file's path (no SwiftPM resource setup).
    private func repoRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // AnjadheSpecEngineTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // Anjadhe
            .deletingLastPathComponent() // ios-engine
            .deletingLastPathComponent() // repo root
    }

    func testCorpusValidationParity() throws {
        let url = repoRoot().appendingPathComponent("tests/spec/corpus.json")
        let corpus = try JSONDecoder().decode(Corpus.self, from: Data(contentsOf: url))
        var failures: [String] = []
        for c in corpus.cases {
            let result = SpecValidator.validate(c.spec)
            if let v = c.expect.valid, result.ok != v {
                failures.append("\(c.name): expected valid=\(v), got \(result.ok) [\(result.errors.joined(separator: " | "))]")
            }
            for sub in c.expect.errorIncludes ?? [] where !result.errors.contains(where: { $0.contains(sub) }) {
                failures.append("\(c.name): expected an error containing \"\(sub)\", got [\(result.errors.joined(separator: " | "))]")
            }
        }
        XCTAssertTrue(failures.isEmpty, "\n" + failures.joined(separator: "\n"))
        print("Swift conformance: \(corpus.cases.count) corpus cases checked.")
    }

    func testKnownTypesMatchCatalog() throws {
        let url = repoRoot().appendingPathComponent("tests/spec/catalog.json")
        let catalog = try JSONDecoder().decode(Catalog.self, from: Data(contentsOf: url))
        let catalogTypes = Set(catalog.components.map { $0.type })
        XCTAssertEqual(SpecValidator.knownTypes, catalogTypes,
                       "Swift known component types drifted from tests/spec/catalog.json")
        XCTAssertEqual(catalog.specVersion, SpecValidator.VERSION)
    }
}
