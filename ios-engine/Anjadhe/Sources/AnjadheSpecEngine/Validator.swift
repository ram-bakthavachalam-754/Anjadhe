import Foundation
import AnjadheCore

/// Validation result — mirrors `AppSpec.validate`'s `{ ok, errors }`.
public struct ValidationResult: Equatable {
    public let ok: Bool
    public let errors: [String]
}

/// A faithful Swift port of the App Spec contract in `js/core/app-spec.js`.
/// Error strings match the JS exactly so the SAME `tests/spec/corpus.json`
/// passes here — that's the cross-engine conformance gate (docs/IOS_ENGINE.md).
/// When the JS validator changes, change it here and re-run the corpus.
public enum SpecValidator {

    // MARK: Contract constants (must match app-spec.js, incl. ordering used in
    // error messages)
    static let VERSION = 1
    static let MAX_COMPONENTS = 100
    static let MAX_DEPTH = 4
    static let FIELD_INPUTS = ["text", "textarea", "number", "date", "checkbox", "select"]
    static let AGGS = ["count", "sum", "avg", "min", "max"]
    static let COMPARE_OPS = ["gt", "gte", "lt", "lte", "eq", "ne"]
    static let TONES = ["neutral", "success", "warning", "danger"]
    static let ACTION_VERBS = ["navigate", "open_url", "add_record", "set_field", "increment", "clear_collection"]
    static let CHART_TYPES = ["bar", "line", "pie", "area"]
    static let ICONS = ["star", "heart", "check", "x", "home", "calendar", "clock", "flag", "bell", "bolt", "book", "plus", "arrow-up", "arrow-down"]
    static let nameRegexString = "/^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/"

    public static let knownTypes: Set<String> = [
        "paragraph", "section", "divider", "card", "columns", "tabs",
        "summary_grid", "list", "table", "form", "record_list", "lookup",
        "progress", "stat", "badge", "key_value", "gauge", "timeline",
        "button", "chart", "sparkline", "image", "icon"
    ]

    // MARK: Internals
    final class Errors { var list: [String] = []; func add(_ s: String) { list.append(s) } }
    final class Ctx { var n = 0; var collections = Set<String>(); var countRefs: [String] = [] }

    private static let nameRE = try! NSRegularExpression(pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,40}$")
    static func isName(_ s: String?) -> Bool {
        guard let s = s else { return false }
        return nameRE.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }
    static func isHTTP(_ s: String?) -> Bool {
        guard let s = s else { return false }
        return s.hasPrefix("http://") || s.hasPrefix("https://")
    }
    private static let placeholderRE = try! NSRegularExpression(pattern: "\\{(\\w+)\\}")
    /// Names of `{field}` placeholders in a URL template (e.g. ["latitude","longitude"]).
    static func placeholders(in s: String?) -> [String] {
        guard let s = s else { return [] }
        let ns = s as NSString
        return placeholderRE.matches(in: s, range: NSRange(location: 0, length: ns.length))
            .compactMap { $0.numberOfRanges > 1 ? ns.substring(with: $0.range(at: 1)) : nil }
    }
    static func present(_ v: JSONValue?) -> Bool { v != nil && !(v!.isNull) }
    static func displayScalar(_ v: JSONValue?) -> String {
        switch v {
        case .string(let s): return s
        case .number(let n): return n == n.rounded() ? String(Int(n)) : String(n)
        case .bool(let b): return b ? "true" : "false"
        case .null: return "null"
        default: return ""
        }
    }

    // MARK: Entry point

    public static func validate(_ raw: JSONValue) -> ValidationResult {
        let errors = Errors()
        guard case .object(let root) = raw else {
            return ValidationResult(ok: false, errors: ["spec must be a JSON object"])
        }
        if root["specVersion"]?.numberValue != Double(VERSION) {
            errors.add("specVersion must be \(VERSION)")
        }
        if let t = root["title"], !t.isNull, t.stringValue == nil {
            errors.add("title must be a string")
        }
        let comps = root["components"]?.arrayValue
        if comps == nil || comps!.isEmpty {
            errors.add("components must be a non-empty array")
        } else {
            let ctx = Ctx()
            validateComponents(comps!, errors, 1, ctx)
            if ctx.n > MAX_COMPONENTS { errors.add("too many components (\(ctx.n) > \(MAX_COMPONENTS))") }
            for ref in ctx.countRefs where !ctx.collections.contains(ref) {
                let list = ctx.collections.isEmpty ? "none declared" : ctx.collections.sorted().joined(separator: ", ")
                errors.add("computed aggregation \"\(ref)\" must exactly match a collection used by a form or record_list (\(list))")
            }
        }
        return ValidationResult(ok: errors.list.isEmpty, errors: errors.list)
    }

    static func validateComponents(_ comps: [JSONValue], _ errors: Errors, _ depth: Int, _ ctx: Ctx) {
        if depth > MAX_DEPTH { errors.add("sections nested deeper than \(MAX_DEPTH)"); return }
        for c in comps {
            ctx.n += 1
            guard case .object(let obj) = c else { errors.add("component must be an object"); continue }
            let rawType = obj["type"]?.stringValue
            let loc = rawType ?? "?"
            guard let t = rawType, knownTypes.contains(t) else {
                errors.add("unknown component type \"\(rawType ?? "?")\"")
                continue
            }
            validateComponent(t, obj, errors, loc, depth, ctx)
            if let sw = obj["showWhen"], !sw.isNull {
                validateShowWhen(sw, errors, loc, ctx)
            }
        }
    }

    // MARK: Shared validators

    @discardableResult
    static func validateComputed(_ v: JSONValue, _ errors: Errors, _ loc: String, _ ctx: Ctx, _ label: String) -> String? {
        guard case .object(let o) = v else {
            errors.add("\(loc): \(label) must be a computed aggregation object")
            return nil
        }
        let presentAggs = AGGS.filter { o[$0] != nil }
        if presentAggs.count != 1 {
            errors.add("\(loc): \(label) must have exactly one of \(AGGS.joined(separator: "/"))")
            return nil
        }
        let agg = presentAggs[0]
        guard let coll = o[agg]?.stringValue, isName(coll) else {
            errors.add("\(loc): \(label) \(agg) must be a bare collection name (no dots or paths), got \"\(displayScalar(o[agg]))\"")
            return nil
        }
        ctx.countRefs.append(coll)
        if agg != "count" && !isName(o["field"]?.stringValue) {
            errors.add("\(loc): \(label) \(agg) needs a numeric \"field\" to aggregate")
        }
        if let w = o["where"], !w.isNull, w.objectValue == nil {
            errors.add("\(loc): \(label) where must be an object of field:value filters")
        }
        return agg
    }

    static func validateShowWhen(_ sw: JSONValue, _ errors: Errors, _ loc: String, _ ctx: Ctx) {
        guard validateComputed(sw, errors, loc, ctx, "showWhen") != nil, case .object(let o) = sw else { return }
        if !(o["op"]?.stringValue.map(COMPARE_OPS.contains) ?? false) {
            errors.add("\(loc): showWhen.op must be one of \(COMPARE_OPS.joined(separator: ", "))")
        }
        if o["value"]?.numberValue == nil {
            errors.add("\(loc): showWhen.value must be a number")
        }
    }

    static func validateAction(_ a: JSONValue, _ errors: Errors, _ loc: String, _ ctx: Ctx) {
        guard case .object(let o) = a else { errors.add("\(loc): action must be an object"); return }
        guard let verb = o["verb"]?.stringValue, ACTION_VERBS.contains(verb) else {
            errors.add("\(loc): action.verb must be one of \(ACTION_VERBS.joined(separator: ", "))")
            return
        }
        func declareCollection() {
            if let coll = o["collection"]?.stringValue, isName(coll) { ctx.collections.insert(coll) }
            else { errors.add("\(loc): \(verb) action needs a \"collection\" name") }
        }
        switch verb {
        case "navigate":
            if (o["app"]?.stringValue ?? "").isEmpty { errors.add("\(loc): navigate action needs an \"app\" id") }
        case "open_url":
            if !isHTTP(o["url"]?.stringValue) { errors.add("\(loc): open_url action needs an http(s) \"url\"") }
        case "add_record":
            declareCollection()
            if o["values"]?.objectValue == nil { errors.add("\(loc): add_record action needs a \"values\" object") }
        case "clear_collection":
            declareCollection()
        case "set_field":
            declareCollection()
            if !isName(o["field"]?.stringValue) { errors.add("\(loc): set_field action needs a \"field\"") }
            if o["value"] == nil { errors.add("\(loc): set_field action needs a \"value\"") }
        case "increment":
            declareCollection()
            if !isName(o["field"]?.stringValue) { errors.add("\(loc): increment action needs a \"field\"") }
            if let by = o["by"], !by.isNull, by.numberValue == nil { errors.add("\(loc): increment action \"by\" must be a number") }
        default: break
        }
    }

    static func validateScalar(_ v: JSONValue?, _ errors: Errors, _ loc: String, _ ctx: Ctx) {
        if let v = v, v.objectValue != nil {
            validateComputed(v, errors, loc, ctx, "value")
        } else if !(v != nil && (v!.stringValue != nil || v!.numberValue != nil)) {
            errors.add("\(loc): value must be a string, number, or a computed aggregation")
        }
    }

    static func validateValueMax(_ o: [String: JSONValue], _ errors: Errors, _ loc: String, _ ctx: Ctx) {
        for key in ["value", "max"] {
            let v = o[key]
            if v == nil || v!.isNull {
                errors.add("\(loc): needs value and max (numbers or a computed aggregation)")
            } else if v!.objectValue != nil {
                validateComputed(v!, errors, loc, ctx, key)
            } else if v!.numberValue == nil {
                errors.add("\(loc): \(key) must be a number or a computed aggregation")
            }
        }
    }

    static func validateFields(_ fields: [JSONValue], _ errors: Errors, _ loc: String) {
        for f in fields {
            let fo = f.objectValue
            if fo == nil || !isName(fo?["name"]?.stringValue) { errors.add("\(loc): field name must match \(nameRegexString)") }
            let inputV = fo?["input"]
            let kind = (inputV == nil || inputV!.isNull) ? "text" : (inputV!.stringValue ?? "")
            if !FIELD_INPUTS.contains(kind) { errors.add("\(loc): field input must be one of \(FIELD_INPUTS.joined(separator: ", "))") }
            if kind == "select" {
                let opts = fo?["options"]?.arrayValue
                if opts == nil || opts!.isEmpty { errors.add("\(loc): select field needs options") }
            }
        }
    }

    static func validateCollection(_ o: [String: JSONValue], _ errors: Errors, _ loc: String, _ ctx: Ctx) {
        if let coll = o["collection"]?.stringValue, isName(coll) { ctx.collections.insert(coll) }
        else { errors.add("\(loc): collection must be a short identifier") }
    }

    static func validateChartData(_ d: JSONValue?, _ errors: Errors, _ loc: String, _ ctx: Ctx) {
        if let arr = d?.arrayValue {
            if arr.isEmpty { errors.add("\(loc): data array must be non-empty"); return }
            for p in arr {
                guard let po = p.objectValue, let label = po["label"]?.stringValue else { errors.add("\(loc): each data point needs a label"); continue }
                if po["value"]?.numberValue == nil { errors.add("\(loc): data point \"\(label)\" value must be a number") }
            }
        } else if let o = d?.objectValue {
            if let coll = o["collection"]?.stringValue, isName(coll) { ctx.countRefs.append(coll) }
            else { errors.add("\(loc): data.collection must be a collection name") }
            if !isName(o["groupBy"]?.stringValue) { errors.add("\(loc): data.groupBy must be a field name") }
            if let agg = o["agg"], !agg.isNull, !(agg.stringValue.map(AGGS.contains) ?? false) { errors.add("\(loc): data.agg must be one of \(AGGS.joined(separator: "/"))") }
            if let aggS = o["agg"]?.stringValue, aggS != "count", !isName(o["field"]?.stringValue) { errors.add("\(loc): data.agg \(aggS) needs a numeric \"field\"") }
            if let w = o["where"], !w.isNull, w.objectValue == nil { errors.add("\(loc): data.where must be an object") }
        } else {
            errors.add("\(loc): data must be an array of {label,value} or a {collection,groupBy} grouping")
        }
    }

    // MARK: Per-component validation (mirror of the COMPONENTS registry)

    static func validateComponent(_ type: String, _ obj: [String: JSONValue], _ errors: Errors, _ loc: String, _ depth: Int, _ ctx: Ctx) {
        switch type {
        case "paragraph":
            if obj["text"]?.stringValue == nil { errors.add("\(loc): text must be a string") }

        case "section":
            if let comps = obj["components"]?.arrayValue { validateComponents(comps, errors, depth + 1, ctx) }
            else { errors.add("\(loc): components must be an array") }

        case "divider":
            break

        case "card":
            if let title = obj["title"], !title.isNull, title.stringValue == nil { errors.add("\(loc): title must be a string") }
            if let comps = obj["components"]?.arrayValue { validateComponents(comps, errors, depth + 1, ctx) }
            else { errors.add("\(loc): components must be an array") }

        case "columns":
            if let count = obj["count"], !count.isNull {
                if let n = count.numberValue, n == n.rounded(), n >= 2, n <= 4 { } else { errors.add("\(loc): count must be an integer from 2 to 4") }
            }
            let comps = obj["components"]?.arrayValue
            if comps == nil || comps!.isEmpty { errors.add("\(loc): components must be a non-empty array") }
            else { validateComponents(comps!, errors, depth + 1, ctx) }

        case "tabs":
            if let id = obj["id"], !id.isNull, !isName(id.stringValue) { errors.add("\(loc): id must be a short identifier") }
            guard let tabs = obj["tabs"]?.arrayValue, !tabs.isEmpty else { errors.add("\(loc): tabs must be a non-empty array"); return }
            for t in tabs {
                guard let to = t.objectValue, let label = to["label"]?.stringValue else { errors.add("\(loc): each tab needs a label"); continue }
                if let comps = to["components"]?.arrayValue { validateComponents(comps, errors, depth + 1, ctx) }
                else { errors.add("\(loc): tab \"\(label)\" needs a components array") }
            }

        case "summary_grid":
            guard let items = obj["items"]?.arrayValue, !items.isEmpty else { errors.add("\(loc): items must be a non-empty array"); return }
            for item in items {
                guard let it = item.objectValue, it["label"]?.stringValue != nil else { errors.add("\(loc): each item needs a label"); continue }
                let v = it["value"]
                if let v = v, v.objectValue != nil {
                    validateComputed(v, errors, loc, ctx, "value")
                } else if !(v != nil && (v!.stringValue != nil || v!.numberValue != nil)) {
                    errors.add("\(loc): item value must be a string, number, or a computed aggregation")
                }
            }

        case "list":
            let items = obj["items"]?.arrayValue
            if items == nil || items!.contains(where: { $0.stringValue == nil }) { errors.add("\(loc): items must be an array of strings") }

        case "table":
            let headers = obj["headers"]?.arrayValue
            if headers == nil || headers!.contains(where: { $0.stringValue == nil }) { errors.add("\(loc): headers must be an array of strings") }
            let rows = obj["rows"]?.arrayValue
            if rows == nil || rows!.contains(where: { $0.arrayValue == nil }) { errors.add("\(loc): rows must be an array of arrays") }

        case "form":
            validateCollection(obj, errors, loc, ctx)
            let fields = obj["fields"]?.arrayValue
            if fields == nil || fields!.isEmpty { errors.add("\(loc): fields must be a non-empty array") }
            else { validateFields(fields!, errors, loc) }

        case "record_list":
            validateCollection(obj, errors, loc, ctx)
            if let f = obj["fields"], !f.isNull, (f.arrayValue == nil || f.arrayValue!.contains(where: { $0.stringValue == nil })) {
                errors.add("\(loc): fields must be an array of field names")
            }
            if let sort = obj["sort"], !sort.isNull, (sort.objectValue == nil || sort.objectValue!["by"]?.stringValue == nil) {
                errors.add("\(loc): sort must be { by, dir? }")
            }
            if let ef = obj["editFields"], !ef.isNull {
                if ef.arrayValue == nil || ef.arrayValue!.isEmpty { errors.add("\(loc): editFields must be a non-empty array of field definitions") }
                else { validateFields(ef.arrayValue!, errors, loc) }
            }
            if let detail = obj["detail"], !detail.isNull {
                if let d = detail.objectValue {
                    if let df = d["fields"], !df.isNull, (df.arrayValue == nil || df.arrayValue!.contains(where: { $0.stringValue == nil })) {
                        errors.add("\(loc): detail.fields must be an array of field names")
                    }
                    if let dt = d["title"], !dt.isNull, dt.stringValue == nil { errors.add("\(loc): detail.title must be a field name") }
                    if let ds = d["source"], !ds.isNull {
                        if let s = ds.objectValue {
                            let url = s["url"]?.stringValue
                            let phs = placeholders(in: url)
                            if url == nil || !isHTTP(url) || phs.isEmpty { errors.add("\(loc): detail.source.url must be an http(s) URL with at least one {field} placeholder (e.g. {key} or {latitude})") }
                            if phs.contains("key") && !isName(s["key"]?.stringValue) { errors.add("\(loc): detail.source.key must name the record field that fills {key}") }
                            if s["map"]?.objectValue == nil || s["map"]!.objectValue!.isEmpty { errors.add("\(loc): detail.source.map must map record fields to result paths") }
                        } else {
                            errors.add("\(loc): detail.source must be an object")
                        }
                    }
                } else {
                    errors.add("\(loc): detail must be an object")
                }
            }
            if let sf = obj["statusField"], !sf.isNull {
                let so = sf.objectValue
                if so == nil || !isName(so?["name"]?.stringValue) { errors.add("\(loc): statusField.name must be a short identifier") }
                let opts = so?["options"]?.arrayValue
                if opts == nil || opts!.count < 2 || opts!.contains(where: { $0.stringValue == nil }) { errors.add("\(loc): statusField.options must be 2+ strings") }
            }

        case "lookup":
            validateCollection(obj, errors, loc, ctx)
            guard let src = obj["source"]?.objectValue else {
                errors.add("\(loc): source must be an object { url, resultsPath?, label, fields }")
                return
            }
            let url = src["url"]?.stringValue
            if url == nil || !isHTTP(url) {
                errors.add("\(loc): source.url must be an http(s) URL containing {query}")
            } else if !url!.contains("{query}") {
                errors.add("\(loc): source.url must include the {query} placeholder")
            }
            if src["label"]?.stringValue == nil { errors.add("\(loc): source.label must be the result field to show (a string path)") }
            if src["fields"]?.objectValue == nil || src["fields"]!.objectValue!.isEmpty { errors.add("\(loc): source.fields must map record fields to result paths") }
            if let def = obj["defaults"], !def.isNull, def.objectValue == nil { errors.add("\(loc): defaults must be an object of fixed field values") }

        case "progress":
            validateValueMax(obj, errors, loc, ctx)

        case "stat":
            if obj["label"]?.stringValue == nil { errors.add("\(loc): label must be a string") }
            validateScalar(obj["value"], errors, loc, ctx)
            if let cap = obj["caption"], !cap.isNull, cap.stringValue == nil { errors.add("\(loc): caption must be a string") }

        case "badge":
            if obj["text"]?.stringValue == nil { errors.add("\(loc): text must be a string") }
            if let tone = obj["tone"], !tone.isNull, !(tone.stringValue.map(TONES.contains) ?? false) { errors.add("\(loc): tone must be \(TONES.joined(separator: ", "))") }

        case "key_value":
            if let title = obj["title"], !title.isNull, title.stringValue == nil { errors.add("\(loc): title must be a string") }
            guard let items = obj["items"]?.arrayValue, !items.isEmpty else { errors.add("\(loc): items must be a non-empty array"); return }
            for item in items {
                guard let it = item.objectValue, it["label"]?.stringValue != nil else { errors.add("\(loc): each item needs a label"); continue }
                validateScalar(it["value"], errors, loc, ctx)
            }

        case "gauge":
            validateValueMax(obj, errors, loc, ctx)
            if let label = obj["label"], !label.isNull, label.stringValue == nil { errors.add("\(loc): label must be a string") }

        case "timeline":
            if let title = obj["title"], !title.isNull, title.stringValue == nil { errors.add("\(loc): title must be a string") }
            guard let items = obj["items"]?.arrayValue, !items.isEmpty else { errors.add("\(loc): items must be a non-empty array"); return }
            for item in items {
                guard let it = item.objectValue, it["label"]?.stringValue != nil else { errors.add("\(loc): each timeline item needs a label"); continue }
                if let tm = it["time"], !tm.isNull, tm.stringValue == nil { errors.add("\(loc): timeline item time must be a string") }
                if let dt = it["detail"], !dt.isNull, dt.stringValue == nil { errors.add("\(loc): timeline item detail must be a string") }
            }

        case "button":
            if obj["label"]?.stringValue == nil { errors.add("\(loc): label must be a string") }
            if let action = obj["action"], !action.isNull { validateAction(action, errors, loc, ctx) }
            else { errors.add("\(loc): button needs an action") }
            if let tone = obj["tone"], !tone.isNull, !(tone.stringValue.map(TONES.contains) ?? false) { errors.add("\(loc): tone must be \(TONES.joined(separator: ", "))") }

        case "chart":
            if !(obj["chartType"]?.stringValue.map(CHART_TYPES.contains) ?? false) { errors.add("\(loc): chartType must be \(CHART_TYPES.joined(separator: ", "))") }
            if let title = obj["title"], !title.isNull, title.stringValue == nil { errors.add("\(loc): title must be a string") }
            validateChartData(obj["data"], errors, loc, ctx)

        case "sparkline":
            let d = obj["data"]
            if let arr = d?.arrayValue {
                if arr.isEmpty || arr.contains(where: { $0.numberValue == nil }) { errors.add("\(loc): data must be a non-empty array of numbers") }
            } else if let o = d?.objectValue {
                if let coll = o["collection"]?.stringValue, isName(coll) { ctx.countRefs.append(coll) }
                else { errors.add("\(loc): data.collection must be a collection name") }
                if !isName(o["field"]?.stringValue) { errors.add("\(loc): data.field must be a numeric field name") }
                if let w = o["where"], !w.isNull, w.objectValue == nil { errors.add("\(loc): data.where must be an object") }
            } else {
                errors.add("\(loc): data must be an array of numbers or a {collection, field} series")
            }

        case "image":
            if !isHTTP(obj["url"]?.stringValue) { errors.add("\(loc): url must be an http(s) URL") }
            if let alt = obj["alt"], !alt.isNull, alt.stringValue == nil { errors.add("\(loc): alt must be a string") }
            if let cap = obj["caption"], !cap.isNull, cap.stringValue == nil { errors.add("\(loc): caption must be a string") }

        case "icon":
            if !(obj["name"]?.stringValue.map(ICONS.contains) ?? false) { errors.add("\(loc): name must be one of \(ICONS.joined(separator: ", "))") }
            if let label = obj["label"], !label.isNull, label.stringValue == nil { errors.add("\(loc): label must be a string") }

        default:
            break
        }
    }
}
