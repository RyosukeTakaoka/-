import Foundation
@testable import OniGameCore

/// 形を問わない JSON の値（JS 版の出力と Swift 版の出力を比べるため）
enum JSONValue: Decodable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    static func of<T: Encodable>(_ value: T) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
    }

    subscript(key: String) -> JSONValue? {
        if case let .object(o) = self { return o[key] }
        return nil
    }

    func removing(_ key: String) -> JSONValue {
        guard case var .object(o) = self else { return self }
        o[key] = nil
        return .object(o)
    }
}

/// expected と actual の違いを列挙する。null と「キーが無い」は同じとみなし、数値は誤差を許す
/// （sin・cos などの数学関数は、JS エンジンと OS のライブラリで最後の桁が違うことがあるため）
func jsonDiff(_ expected: JSONValue?, _ actual: JSONValue?, path: String = "$", tolerance: Double = 1e-9) -> [String] {
    let e = expected ?? .null
    let a = actual ?? .null
    switch (e, a) {
    case (.null, .null):
        return []
    case let (.number(x), .number(y)):
        let scale = max(1, abs(x), abs(y))
        return abs(x - y) <= tolerance * scale ? [] : ["\(path): \(x) != \(y)"]
    case let (.object(x), .object(y)):
        return Set(x.keys).union(y.keys).sorted().flatMap { jsonDiff(x[$0], y[$0], path: "\(path).\($0)", tolerance: tolerance) }
    case let (.array(x), .array(y)):
        if x.count != y.count { return ["\(path): 配列の長さ \(x.count) != \(y.count)"] }
        return zip(x, y).enumerated().flatMap { i, pair in jsonDiff(pair.0, pair.1, path: "\(path)[\(i)]", tolerance: tolerance) }
    default:
        return e == a ? [] : ["\(path): \(e) != \(a)"]
    }
}
