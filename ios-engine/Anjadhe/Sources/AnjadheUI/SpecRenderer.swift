import SwiftUI
import AnjadheCore
import AnjadheSpecEngine

// The native SwiftUI spec renderer — the iOS counterpart of spec-renderer.js.
// It renders a validated App Spec into SwiftUI, using the verified
// SpecValidator/SpecEvaluator for validation, computed values, showWhen, and
// actions. Visual polish is iterated in the simulator; this establishes the
// component mapping and wiring. record_list inline-edit + detail view are the
// known follow-ups (marked below).

// MARK: Theme helpers

func toneColor(_ tone: String?) -> Color { Theme.tone(tone) }

func sfSymbol(_ name: String?) -> String {
    switch name {
    case "star": return "star.fill"
    case "heart": return "heart.fill"
    case "check": return "checkmark"
    case "x": return "xmark"
    case "home": return "house.fill"
    case "calendar": return "calendar"
    case "clock": return "clock.fill"
    case "flag": return "flag.fill"
    case "bell": return "bell.fill"
    case "bolt": return "bolt.fill"
    case "book": return "book.fill"
    case "plus": return "plus"
    case "arrow-up": return "arrow.up"
    case "arrow-down": return "arrow.down"
    default: return "questionmark"
    }
}

// MARK: Top-level

/// Renders a whole spec app. Validates first; shows the validation errors if the
/// spec is bad (the loader would normally reject it, but this keeps the engine
/// honest on hand-authored input).
public struct SpecAppView: View {
    let spec: JSONValue
    @ObservedObject var store: AppStore

    public init(spec: JSONValue, store: AppStore) {
        self.spec = spec
        self.store = store
    }

    public var body: some View {
        let result = SpecValidator.validate(spec)
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if !result.ok {
                    ForEach(Array(result.errors.enumerated()), id: \.offset) { _, e in
                        Text(e).font(.footnote).foregroundStyle(.red)
                    }
                } else {
                    if let title = spec["title"]?.stringValue {
                        Text(title).font(Theme.display(28)).foregroundStyle(Theme.text)
                    }
                    SpecNodeList(components: spec["components"]?.arrayValue ?? [])
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
        .background(Theme.bg)
        .tint(Theme.text)
        .environmentObject(store)
    }
}

/// A vertical run of components.
struct SpecNodeList: View {
    let components: [JSONValue]
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(components.enumerated()), id: \.offset) { _, c in
                SpecNode(c: c)
            }
        }
    }
}

/// One component. `showWhen` gates visibility; the switch maps each type. AnyView
/// keeps the 23-case switch easy on the type-checker.
struct SpecNode: View {
    let c: JSONValue
    @EnvironmentObject var store: AppStore

    var body: some View {
        if let sw = c["showWhen"], !sw.isNull, !SpecEvaluator.passesCondition(sw, store.kv) {
            EmptyView()
        } else {
            content
        }
    }

    func val(_ v: JSONValue?) -> String { v.map { SpecEvaluator.resolveValue($0, store.kv) } ?? "" }

    var content: AnyView {
        switch c["type"]?.stringValue ?? "" {
        case "paragraph":
            return AnyView(Text(c["text"]?.stringValue ?? "").frame(maxWidth: .infinity, alignment: .leading))

        case "section":
            return AnyView(VStack(alignment: .leading, spacing: 10) {
                if let t = c["title"]?.stringValue { sectionHeader(t) }
                SpecNodeList(components: c["components"]?.arrayValue ?? [])
            })

        case "divider":
            return AnyView(Divider())

        case "card":
            return AnyView(VStack(alignment: .leading, spacing: 10) {
                if let t = c["title"]?.stringValue { sectionHeader(t) }
                SpecNodeList(components: c["components"]?.arrayValue ?? [])
            }
            .padding()
            .background(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border)))

        case "columns":
            let n = max(2, min(4, Int(c["count"]?.numberValue ?? 2)))
            return AnyView(LazyVGrid(columns: Array(repeating: GridItem(.flexible(), alignment: .top), count: n), spacing: 12) {
                ForEach(Array((c["components"]?.arrayValue ?? []).enumerated()), id: \.offset) { _, child in
                    SpecNode(c: child)
                }
            })

        case "tabs":
            return AnyView(SpecTabsView(c: c))

        case "summary_grid":
            return AnyView(LazyVGrid(columns: [GridItem(.adaptive(minimum: 110))], spacing: 10) {
                ForEach(Array((c["items"]?.arrayValue ?? []).enumerated()), id: \.offset) { _, item in
                    VStack(spacing: 4) {
                        Text(val(item["value"])).font(Theme.display(22))
                        Text(item["label"]?.stringValue ?? "").font(.caption).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border))
                }
            })

        case "list":
            let ordered = c["ordered"]?.boolValue ?? false
            let items = c["items"]?.arrayValue ?? []
            return AnyView(VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { i, it in
                    Text("\(ordered ? "\(i + 1)." : "•") \(it.stringValue ?? "")")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            })

        case "table":
            return AnyView(tableView())

        case "form":
            return AnyView(SpecFormView(c: c))

        case "record_list":
            return AnyView(SpecRecordListView(c: c))

        case "lookup":
            // Network autocomplete is a follow-up; render the input affordance.
            return AnyView(VStack(alignment: .leading, spacing: 6) {
                if let t = c["title"]?.stringValue { sectionHeader(t) }
                Text(c["placeholder"]?.stringValue ?? "Search…")
                    .foregroundStyle(.secondary)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border))
            })

        case "progress":
            let v = SpecEvaluator.aggregate(c["value"] ?? .null, store.kv)
            let m = numberOrAgg(c["max"])
            return AnyView(VStack(alignment: .leading, spacing: 4) {
                if let l = c["label"]?.stringValue { Text(l).font(.caption).foregroundStyle(.secondary) }
                ProgressView(value: m > 0 ? min(1, v / m) : 0)
                Text("\(fmt(v)) / \(fmt(m))").font(.caption2).foregroundStyle(.secondary)
            })

        case "stat":
            return AnyView(VStack(spacing: 3) {
                Text(val(c["value"])).font(Theme.display(34))
                Text(c["label"]?.stringValue ?? "").font(.subheadline).foregroundStyle(.secondary)
                if let cap = c["caption"]?.stringValue { Text(cap).font(.caption2).foregroundStyle(.tertiary) }
            }
            .frame(maxWidth: .infinity)
            .padding()
            .background(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border)))

        case "badge":
            let tone = c["tone"]?.stringValue
            return AnyView(Text(c["text"]?.stringValue ?? "")
                .font(.caption.bold())
                .padding(.horizontal, 8).padding(.vertical, 2)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(toneColor(tone)))
                .foregroundStyle(toneColor(tone)))

        case "key_value":
            return AnyView(VStack(alignment: .leading, spacing: 6) {
                if let t = c["title"]?.stringValue { sectionHeader(t) }
                ForEach(Array((c["items"]?.arrayValue ?? []).enumerated()), id: \.offset) { _, item in
                    HStack {
                        Text(item["label"]?.stringValue ?? "").foregroundStyle(.secondary)
                        Spacer()
                        Text(val(item["value"])).fontWeight(.semibold)
                    }
                    Divider()
                }
            })

        case "gauge":
            let v = SpecEvaluator.aggregate(c["value"] ?? .null, store.kv)
            let m = numberOrAgg(c["max"])
            let pct = m > 0 ? min(1, max(0, v / m)) : 0
            return AnyView(VStack(spacing: 6) {
                Gauge(value: pct) { EmptyView() } currentValueLabel: { Text("\(Int(pct * 100))%") }
                    .gaugeStyle(.accessoryCircularCapacity)
                if let l = c["label"]?.stringValue { Text(l).font(.caption).foregroundStyle(.secondary) }
            }.frame(maxWidth: .infinity))

        case "timeline":
            return AnyView(VStack(alignment: .leading, spacing: 0) {
                if let t = c["title"]?.stringValue { sectionHeader(t) }
                ForEach(Array((c["items"]?.arrayValue ?? []).enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .top, spacing: 10) {
                        Circle().fill(Color.primary).frame(width: 8, height: 8).padding(.top, 6)
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(item["label"]?.stringValue ?? "").fontWeight(.semibold)
                                Spacer()
                                if let tm = item["time"]?.stringValue { Text(tm).font(.caption2).foregroundStyle(.tertiary) }
                            }
                            if let d = item["detail"]?.stringValue { Text(d).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                    .padding(.bottom, 10)
                }
            })

        case "button":
            let tone = c["tone"]?.stringValue
            let isNeutral = (tone == nil || tone == "neutral")
            return AnyView(Button(c["label"]?.stringValue ?? "") {
                if let action = c["action"] { store.run(action) }
            }
            .buttonStyle(ThemedButton(tone: isNeutral ? nil : toneColor(tone))))

        case "chart":
            return AnyView(SpecChartView(c: c))

        case "sparkline":
            return AnyView(SpecSparklineView(c: c))

        case "image":
            return AnyView(VStack(alignment: .leading, spacing: 4) {
                if let url = (c["url"]?.stringValue).flatMap(URL.init) {
                    AsyncImage(url: url) { img in img.resizable().scaledToFit() } placeholder: { ProgressView() }
                        .frame(maxWidth: .infinity)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }
                if let cap = c["caption"]?.stringValue { Text(cap).font(.caption2).foregroundStyle(.tertiary) }
            })

        case "icon":
            return AnyView(HStack(spacing: 6) {
                Image(systemName: sfSymbol(c["name"]?.stringValue))
                if let l = c["label"]?.stringValue { Text(l).foregroundStyle(.secondary) }
            })

        default:
            return AnyView(EmptyView())
        }
    }

    // MARK: small helpers

    func sectionHeader(_ t: String) -> some View {
        Text(t.uppercased()).font(.caption.weight(.semibold)).tracking(0.6).foregroundStyle(.secondary)
    }

    func numberOrAgg(_ v: JSONValue?) -> Double {
        guard let v = v else { return 0 }
        if case .object = v { return SpecEvaluator.aggregate(v, store.kv) }
        return v.numberValue ?? 0
    }

    func fmt(_ d: Double) -> String { d == d.rounded() ? String(Int(d)) : String((d * 100).rounded() / 100) }

    func tableView() -> some View {
        let headers = c["headers"]?.arrayValue ?? []
        let rows = c["rows"]?.arrayValue ?? []
        return VStack(alignment: .leading, spacing: 6) {
            if let t = c["title"]?.stringValue { Text(t).font(.headline) }
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                GridRow {
                    ForEach(Array(headers.enumerated()), id: \.offset) { _, h in
                        Text(h.stringValue ?? "").font(.caption.bold()).foregroundStyle(.secondary)
                    }
                }
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array((row.arrayValue ?? []).enumerated()), id: \.offset) { _, cell in
                            Text(SpecEvaluator.resolveValue(cell, store.kv))
                        }
                    }
                }
            }
        }
    }
}
