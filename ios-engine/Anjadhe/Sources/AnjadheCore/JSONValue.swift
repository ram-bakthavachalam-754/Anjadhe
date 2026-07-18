import Foundation

/// A dynamic JSON value — specs and synced records are arbitrary JSON, so the
/// engine works against this rather than fixed structs. Mirrors what JS hands
/// the validator/renderer. Codable both ways so it can round-trip through the
/// store and the channel.
public indirect enum JSONValue: Hashable {
    case object([String: JSONValue])
    case array([JSONValue])
    case string(String)
    case number(Double)
    case bool(Bool)
    case null
}

extension JSONValue: Decodable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        // Bool before Double: JSONDecoder won't coerce 1/0 to Bool, and `true`
        // won't decode as Double, so order is unambiguous.
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([JSONValue].self) { self = .array(a); return }
        if let o = try? c.decode([String: JSONValue].self) { self = .object(o); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unsupported JSON value")
    }
}

extension JSONValue: Encodable {
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let o): try c.encode(o)
        case .array(let a): try c.encode(a)
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .null: try c.encodeNil()
        }
    }
}

public extension JSONValue {
    var objectValue: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }
    var arrayValue: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
    var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    var numberValue: Double? { if case .number(let n) = self { return n }; return nil }
    var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
    var isNull: Bool { if case .null = self { return true }; return false }

    /// Object-key access. Returns nil for a missing key (so `present(...)`
    /// distinguishes missing from an explicit null, matching JS `!= null`).
    subscript(_ key: String) -> JSONValue? { objectValue?[key] }

    /// Decode JSON text into a JSONValue (e.g. an app.spec.json string).
    static func parse(_ text: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }
}
