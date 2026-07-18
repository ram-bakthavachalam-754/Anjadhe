import SwiftUI
import AnjadheCore
import AnjadheSpecEngine

// Monochrome series ramp for charts/legends (on-theme).
func seriesColor(_ i: Int) -> Color {
    let shades: [Color] = [
        .primary, .secondary,
        Color.secondary.opacity(0.6), Color.secondary.opacity(0.45),
        Color.secondary.opacity(0.3), Color.secondary.opacity(0.2)
    ]
    return shades[i % shades.count]
}

func fmtNum(_ d: Double) -> String { d == d.rounded() ? String(Int(d)) : String((d * 100).rounded() / 100) }

// MARK: form

struct SpecFormView: View {
    let c: JSONValue
    @EnvironmentObject var store: AppStore
    @State private var text: [String: String] = [:]
    @State private var flags: [String: Bool] = [:]

    var fields: [JSONValue] { c["fields"]?.arrayValue ?? [] }
    var collection: String { c["collection"]?.stringValue ?? "" }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let t = c["title"]?.stringValue { Text(t).font(.headline) }
            ForEach(Array(fields.enumerated()), id: \.offset) { _, f in fieldRow(f) }
            Button(c["submitLabel"]?.stringValue ?? "Add") { submit() }
                .buttonStyle(.borderedProminent)
        }
    }

    @ViewBuilder func fieldRow(_ f: JSONValue) -> some View {
        let name = f["name"]?.stringValue ?? ""
        let label = f["label"]?.stringValue ?? name
        switch f["input"]?.stringValue ?? "text" {
        case "checkbox":
            Toggle(label, isOn: Binding(get: { flags[name] ?? false }, set: { flags[name] = $0 }))
        case "select":
            let opts = (f["options"]?.arrayValue ?? []).compactMap { $0.stringValue }
            Picker(label, selection: Binding(get: { text[name] ?? opts.first ?? "" }, set: { text[name] = $0 })) {
                ForEach(opts, id: \.self) { Text($0).tag($0) }
            }
        case "textarea":
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.caption).foregroundStyle(.secondary)
                TextEditor(text: Binding(get: { text[name] ?? "" }, set: { text[name] = $0 })).frame(height: 80)
            }
        default:
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.caption).foregroundStyle(.secondary)
                TextField(label, text: Binding(get: { text[name] ?? "" }, set: { text[name] = $0 }))
                    .textFieldStyle(.roundedBorder)
            }
        }
    }

    func submit() {
        var rec: [String: JSONValue] = [:]
        for f in fields {
            let name = f["name"]?.stringValue ?? ""
            switch f["input"]?.stringValue ?? "text" {
            case "checkbox": rec[name] = .bool(flags[name] ?? false)
            case "number": rec[name] = (text[name].flatMap(Double.init)).map(JSONValue.number) ?? .null
            default: rec[name] = .string(text[name] ?? "")
            }
        }
        store.appendRecord(collection, rec)
        text = [:]; flags = [:]
    }
}

// MARK: record_list (rows + statusField + delete; inline-edit & detail are follow-ups)

struct SpecRecordListView: View {
    let c: JSONValue
    @EnvironmentObject var store: AppStore
    var collection: String { c["collection"]?.stringValue ?? "" }

    var body: some View {
        let recs = sorted(store.records(collection))
        VStack(alignment: .leading, spacing: 6) {
            if let t = c["title"]?.stringValue { Text(t).font(.headline) }
            if recs.isEmpty {
                Text(c["empty"]?.stringValue ?? "Nothing here yet.").italic().foregroundStyle(.secondary)
            } else {
                ForEach(Array(recs.enumerated()), id: \.offset) { _, r in row(r) }
            }
        }
    }

    func sorted(_ arr: [JSONValue]) -> [JSONValue] {
        guard let by = c["sort"]?["by"]?.stringValue else { return arr }
        let asc = (c["sort"]?["dir"]?.stringValue ?? "desc") == "asc"
        return arr.sorted { a, b in
            let av = a[by].map { SpecEvaluator.resolveValue($0, store.kv) } ?? ""
            let bv = b[by].map { SpecEvaluator.resolveValue($0, store.kv) } ?? ""
            return asc ? av < bv : av > bv
        }
    }

    @ViewBuilder func row(_ r: JSONValue) -> some View {
        let fields = c["fields"]?.arrayValue?.compactMap { $0.stringValue }
            ?? r.objectValue?.keys.filter { $0 != "id" && $0 != "createdAt" }.sorted()
            ?? []
        let statusName = c["statusField"]?["name"]?.stringValue
        let statusOpts = (c["statusField"]?["options"]?.arrayValue ?? []).compactMap { $0.stringValue }
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(fields.enumerated()), id: \.offset) { i, name in
                    if name == statusName, !statusOpts.isEmpty {
                        Button(cur(r, name, statusOpts)) { cycle(r, name, statusOpts) }
                            .font(.caption).buttonStyle(.bordered)
                    } else {
                        Text(SpecEvaluator.resolveValue(r[name] ?? .null, store.kv))
                            .font(i == 0 ? .body.weight(.semibold) : .caption)
                            .foregroundStyle(i == 0 ? Color.primary : Color.secondary)
                    }
                }
            }
            Spacer()
            if c["allowDelete"]?.boolValue != false {
                Button {
                    if let id = r["id"]?.stringValue { store.deleteRecord(collection, id: id) }
                } label: { Image(systemName: "xmark.circle") }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
        Divider()
    }

    func cur(_ r: JSONValue, _ name: String, _ opts: [String]) -> String {
        let v = r[name]?.stringValue ?? ""
        return v.isEmpty ? (opts.first ?? "") : v
    }

    func cycle(_ r: JSONValue, _ name: String, _ opts: [String]) {
        guard let id = r["id"]?.stringValue else { return }
        var arr = store.records(collection)
        guard let idx = arr.firstIndex(where: { $0["id"]?.stringValue == id }), case .object(var rec) = arr[idx] else { return }
        let curIdx = opts.firstIndex(of: rec[name]?.stringValue ?? "") ?? -1
        rec[name] = .string(opts[(curIdx + 1) % opts.count])
        arr[idx] = .object(rec)
        store.saveRecords(collection, arr)
    }
}

// MARK: tabs

struct SpecTabsView: View {
    let c: JSONValue
    @EnvironmentObject var store: AppStore
    var tabs: [JSONValue] { c["tabs"]?.arrayValue ?? [] }

    var key: String {
        let id = c["id"]?.stringValue ?? tabs.compactMap { $0["label"]?.stringValue }.joined(separator: "|")
        return "__spec_tabs:\(id)"
    }
    var active: Int {
        let v = Int(store.uiState(key)?.numberValue ?? 0)
        return (v >= 0 && v < tabs.count) ? v : 0
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 14) {
                ForEach(Array(tabs.enumerated()), id: \.offset) { i, t in
                    Button(t["label"]?.stringValue ?? "") { store.setUIState(key, .number(Double(i))) }
                        .font(.subheadline.weight(i == active ? .bold : .regular))
                        .foregroundStyle(i == active ? Color.primary : Color.secondary)
                }
            }
            Divider()
            if tabs.indices.contains(active) {
                SpecNodeList(components: tabs[active]["components"]?.arrayValue ?? [])
            }
        }
    }
}

// MARK: chart / sparkline (Canvas; ports SpecEvaluator.chartData)

struct SpecChartView: View {
    let c: JSONValue
    @EnvironmentObject var store: AppStore

    var body: some View {
        let points = SpecEvaluator.chartData(c["data"] ?? .null, store.kv)
        let type = c["chartType"]?.stringValue ?? "bar"
        VStack(alignment: .leading, spacing: 6) {
            if let t = c["title"]?.stringValue {
                Text(t.uppercased()).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }
            Canvas { ctx, size in draw(ctx, size, points, type) }
                .frame(height: 160).frame(maxWidth: .infinity)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    ForEach(Array(points.enumerated()), id: \.offset) { i, p in
                        HStack(spacing: 4) {
                            RoundedRectangle(cornerRadius: 2).fill(seriesColor(i)).frame(width: 9, height: 9)
                            Text("\(p.label): \(fmtNum(p.value))").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }

    func draw(_ ctx: GraphicsContext, _ size: CGSize, _ points: [(label: String, value: Double)], _ type: String) {
        guard !points.isEmpty else { return }
        let pad: CGFloat = 8
        let w = size.width - pad * 2, h = size.height - pad * 2
        let maxV = max(points.map { $0.value }.max() ?? 0, 0.0001)

        if type == "pie" {
            let total = max(points.map { max(0, $0.value) }.reduce(0, +), 0.0001)
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let r = min(size.width, size.height) / 2 - pad
            var a0 = -Double.pi / 2
            for (i, p) in points.enumerated() {
                let a1 = a0 + (max(0, p.value) / total) * 2 * Double.pi
                var path = Path()
                path.move(to: center)
                path.addArc(center: center, radius: r, startAngle: .radians(a0), endAngle: .radians(a1), clockwise: false)
                path.closeSubpath()
                ctx.fill(path, with: .color(seriesColor(i)))
                a0 = a1
            }
        } else if type == "bar" {
            let bw = w / CGFloat(points.count)
            for (i, p) in points.enumerated() {
                let bh = CGFloat(max(0, p.value) / maxV) * h
                let rect = CGRect(x: pad + CGFloat(i) * bw + bw * 0.15, y: pad + h - bh, width: bw * 0.7, height: bh)
                ctx.fill(Path(rect), with: .color(.primary))
            }
        } else { // line / area
            let stepX = points.count > 1 ? w / CGFloat(points.count - 1) : 0
            let pts = points.enumerated().map { (i, p) in
                CGPoint(x: pad + CGFloat(i) * stepX, y: pad + h - CGFloat(max(0, p.value) / maxV) * h)
            }
            if type == "area" {
                var area = Path()
                area.move(to: CGPoint(x: pad, y: pad + h))
                pts.forEach { area.addLine(to: $0) }
                area.addLine(to: CGPoint(x: pad + CGFloat(points.count - 1) * stepX, y: pad + h))
                area.closeSubpath()
                ctx.fill(area, with: .color(.primary.opacity(0.15)))
            }
            var line = Path()
            line.addLines(pts)
            ctx.stroke(line, with: .color(.primary), lineWidth: 2)
        }
    }
}

struct SpecSparklineView: View {
    let c: JSONValue
    @EnvironmentObject var store: AppStore

    var values: [Double] {
        if let arr = c["data"]?.arrayValue { return arr.compactMap { $0.numberValue } }
        if let o = c["data"]?.objectValue, let coll = o["collection"]?.stringValue {
            let field = o["field"]?.stringValue ?? ""
            return SpecEvaluator.records(store.kv, coll).compactMap { $0[field]?.numberValue }
        }
        return []
    }

    var body: some View {
        let vals = values
        Canvas { ctx, size in
            guard vals.count >= 2 else { return }
            let mn = vals.min()!, mx = vals.max()!
            let span = (mx - mn) == 0 ? 1 : (mx - mn)
            let stepX = size.width / CGFloat(vals.count - 1)
            var path = Path()
            for (i, v) in vals.enumerated() {
                let pt = CGPoint(x: CGFloat(i) * stepX, y: size.height - CGFloat((v - mn) / span) * size.height)
                if i == 0 { path.move(to: pt) } else { path.addLine(to: pt) }
            }
            ctx.stroke(path, with: .color(.primary), lineWidth: 1.5)
        }
        .frame(width: 80, height: 20)
    }
}
