import SwiftUI
import AnjadheCore

// Native ports of the built-in mobile apps (mobile/screens/*.js), reading/writing
// the same synced blobs via AppStore. Pushed from the Apps tab. Batch 1:
// Bookmarks, Prompts, Feed, Tasks. (Notes/Journal/Habits/Calendar follow.)

// MARK: shared bits

func fieldLabel(_ t: String) -> some View {
    Text(t).font(.caption).foregroundStyle(Theme.textSecondary)
}

/// "yyyy-MM-dd" <-> Date (local).
enum DateStr {
    static let fmt: DateFormatter = { let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f }()
    static func toDate(_ s: String) -> Date { fmt.date(from: s) ?? Date() }
    static func toStr(_ d: Date) -> String { fmt.string(from: d) }
}
enum TimeStr {
    static let fmt: DateFormatter = { let f = DateFormatter(); f.dateFormat = "HH:mm"; return f }()
    static func toDate(_ s: String) -> Date { fmt.date(from: s) ?? (Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: Date()) ?? Date()) }
    static func toStr(_ d: Date) -> String { fmt.string(from: d) }
}

// MARK: Bookmarks

struct BookmarksView: View {
    @EnvironmentObject var store: AppStore
    @State private var editId: String?

    private var bookmarks: [JSONValue] {
        store.items("bookmarks", "bookmarks").sorted {
            ($0["modifiedAt"]?.stringValue ?? "") > ($1["modifiedAt"]?.stringValue ?? "")
        }
    }
    private func domain(_ url: String) -> String {
        var s = url
        if !s.contains("://") { s = "https://" + s }
        return URL(string: s)?.host?.replacingOccurrences(of: "www.", with: "") ?? ""
    }

    var body: some View {
        List {
            if bookmarks.isEmpty {
                Text("No bookmarks yet. Tap + to add one.").italic().foregroundStyle(Theme.textTertiary)
            } else {
                ForEach(bookmarks, id: \.self) { b in
                    Button { editId = b["id"]?.stringValue } label: {
                        HStack(spacing: 10) {
                            let dom = domain(b["url"]?.stringValue ?? "")
                            if let u = URL(string: "https://www.google.com/s2/favicons?domain=\(dom)&sz=64"), !dom.isEmpty {
                                AsyncImage(url: u) { $0.resizable() } placeholder: { Color.clear }
                                    .frame(width: 18, height: 18).clipShape(RoundedRectangle(cornerRadius: 4))
                            }
                            VStack(alignment: .leading, spacing: 1) {
                                Text(b["title"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? (dom.isEmpty ? "Untitled" : dom)).foregroundStyle(Theme.text)
                                Text(dom.isEmpty ? (b["url"]?.stringValue ?? "No URL") : dom).font(.caption).foregroundStyle(Theme.textTertiary)
                            }
                            Spacer()
                        }
                    }
                }
            }
        }
        .listStyle(.plain).scrollContentBackground(.hidden).background(Theme.bg)
        .navigationTitle("Bookmarks")
        .toolbar { ToolbarItem(placement: .primaryAction) { Button { editId = store.addItem("bookmarks", "bookmarks", ["title": .string(""), "url": .string(""), "description": .string(""), "tags": .array([])]) } label: { Image(systemName: "plus") } } }
        .navigationDestination(isPresented: Binding(get: { editId != nil }, set: { if !$0 { editId = nil } })) {
            if let id = editId { BookmarkEditor(id: id) }
        }
    }
}

struct BookmarkEditor: View {
    let id: String
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""; @State private var url = ""; @State private var desc = ""

    var body: some View {
        Form {
            Section {
                fieldLabel("Title"); TextField("Link title", text: $title, axis: .vertical).lineLimit(1...4).onChange(of: title) { store.patchItem("bookmarks", "bookmarks", id: id, ["title": .string($0)]) }
            }
            Section {
                fieldLabel("URL")
                TextField("https://", text: $url).autocorrectionDisabled().urlKeyboard()
                    .onChange(of: url) { store.patchItem("bookmarks", "bookmarks", id: id, ["url": .string($0)]) }
            }
            Section {
                fieldLabel("Description"); TextField("Optional note", text: $desc, axis: .vertical).lineLimit(2...4).onChange(of: desc) { store.patchItem("bookmarks", "bookmarks", id: id, ["description": .string($0)]) }
            }
            Button("Open link") { openURL(url) }.disabled(url.isEmpty)
            Button("Delete bookmark", role: .destructive) { store.deleteItem("bookmarks", "bookmarks", id: id); dismiss() }
        }
        .scrollContentBackground(.hidden).background(Theme.bg)
        .compactForm()
        .navigationTitle("Bookmark").inlineNavTitle()
        .onAppear {
            let b = store.findItem("bookmarks", "bookmarks", id: id)
            title = b?["title"]?.stringValue ?? ""; url = b?["url"]?.stringValue ?? ""; desc = b?["description"]?.stringValue ?? ""
        }
    }
}

// MARK: Prompts

struct PromptsView: View {
    @EnvironmentObject var store: AppStore
    @State private var editId: String?
    private var prompts: [JSONValue] {
        store.items("prompts", "prompts").sorted { ($0["modifiedAt"]?.stringValue ?? "") > ($1["modifiedAt"]?.stringValue ?? "") }
    }
    var body: some View {
        List {
            if prompts.isEmpty {
                Text("No prompts yet. Tap + to add one.").italic().foregroundStyle(Theme.textTertiary)
            } else {
                ForEach(prompts, id: \.self) { p in
                    HStack {
                        Button { editId = p["id"]?.stringValue } label: {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(p["title"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? "Untitled").foregroundStyle(Theme.text)
                                Text(plainPreview(p["body"]?.stringValue ?? "", 72)).font(.caption).foregroundStyle(Theme.textTertiary).lineLimit(1)
                            }
                            Spacer()
                        }
                        Button { copyToPasteboard(p["body"]?.stringValue ?? "") } label: { Image(systemName: "doc.on.doc") }.buttonStyle(.plain).foregroundStyle(Theme.textSecondary)
                    }
                }
            }
        }
        .listStyle(.plain).scrollContentBackground(.hidden).background(Theme.bg)
        .navigationTitle("Prompts")
        .toolbar { ToolbarItem(placement: .primaryAction) { Button { editId = store.addItem("prompts", "prompts", ["title": .string(""), "body": .string("")]) } label: { Image(systemName: "plus") } } }
        .navigationDestination(isPresented: Binding(get: { editId != nil }, set: { if !$0 { editId = nil } })) {
            if let id = editId { PromptEditor(id: id) }
        }
    }
}

struct PromptEditor: View {
    let id: String
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""; @State private var body_ = ""
    var body: some View {
        Form {
            TextField("Prompt title", text: $title, axis: .vertical).lineLimit(1...4).font(.title3.bold()).onChange(of: title) { store.patchItem("prompts", "prompts", id: id, ["title": .string($0)]) }
            Section {
                TextField("Write the prompt…", text: $body_, axis: .vertical).lineLimit(6...).onChange(of: body_) { store.patchItem("prompts", "prompts", id: id, ["body": .string($0)]) }
            }
            Button {
                if let u = configuredSearchURLString(body_, store) { openURL(u) }
            } label: { Label("Open in browser", systemImage: "safari") }
                .disabled(body_.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("Copy") { copyToPasteboard(body_) }
            Button("Delete prompt", role: .destructive) { store.deleteItem("prompts", "prompts", id: id); dismiss() }
        }
        .scrollContentBackground(.hidden).background(Theme.bg)
        .compactForm()
        .navigationTitle("Prompt").inlineNavTitle()
        .onAppear { let p = store.findItem("prompts", "prompts", id: id); title = p?["title"]?.stringValue ?? ""; body_ = p?["body"]?.stringValue ?? "" }
    }
}

// MARK: Feed (read-only)

struct FeedView: View {
    @EnvironmentObject var store: AppStore
    @State private var openId: String?
    private var feed: [JSONValue] {
        store.items("promptFeed", "items").sorted { ($0["createdAt"]?.stringValue ?? "") > ($1["createdAt"]?.stringValue ?? "") }
    }
    private func meta(_ it: JSONValue) -> String {
        [it["createdAt"]?.stringValue.map { DateLogic.relDate($0) } ?? "", it["model"]?.stringValue ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if feed.isEmpty {
                    Text("No feed entries yet. Scheduled prompts run on your Mac and their results appear here.").italic().foregroundStyle(Theme.textTertiary)
                } else {
                    ForEach(feed, id: \.self) { it in
                        Button { if it["error"]?.stringValue == nil { openId = it["id"]?.stringValue } } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                HStack { Text(it["promptTitle"]?.stringValue ?? "Untitled prompt").fontWeight(.semibold).foregroundStyle(Theme.text); Spacer(); Text(meta(it)).font(.caption2).foregroundStyle(Theme.textTertiary) }
                                if let err = it["error"]?.stringValue {
                                    Text(err).font(.caption).foregroundStyle(Theme.danger)
                                } else {
                                    markdownText(it["content"]?.stringValue ?? "Empty response").font(.callout).foregroundStyle(Theme.textSecondary).lineLimit(4)
                                }
                            }.themedCard()
                        }.buttonStyle(.plain)
                    }
                }
            }.padding()
        }
        .background(Theme.bg)
        .navigationTitle("Feed")
        .navigationDestination(isPresented: Binding(get: { openId != nil }, set: { if !$0 { openId = nil } })) {
            if let id = openId, let it = store.findItem("promptFeed", "items", id: id) { FeedDetail(item: it) }
        }
    }
}

private struct FeedDetail: View {
    let item: JSONValue
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(item["promptTitle"]?.stringValue ?? "Untitled prompt").font(Theme.display(24)).foregroundStyle(Theme.text)
                if let model = item["model"]?.stringValue, !model.isEmpty {
                    Text(model).font(.caption).foregroundStyle(Theme.textTertiary)
                }
                MarkdownView(text: item["content"]?.stringValue ?? "")
            }.frame(maxWidth: .infinity, alignment: .leading).padding()
        }
        .background(Theme.bg)
        .navigationTitle("Feed").inlineNavTitle()
        .toolbar { ToolbarItem(placement: .primaryAction) { Button { copyToPasteboard(item["content"]?.stringValue ?? "") } label: { Image(systemName: "doc.on.doc") } } }
    }
}

// MARK: Tasks

struct TasksView: View {
    @EnvironmentObject var store: AppStore
    @State private var editId: String?

    private var tasks: [JSONValue] { store.items("schedule", "scheduleItems") }

    private func groups() -> [(String, Bool, [JSONValue])] {
        let today = DateLogic.todayStr()
        var overdue: [JSONValue] = [], todayG: [JSONValue] = [], upcoming: [JSONValue] = [], noDate: [JSONValue] = [], done: [JSONValue] = []
        for t in tasks {
            if ScheduleLogic.taskDueToday(t) {
                if ScheduleLogic.taskDoneToday(t) { done.append(t) } else { todayG.append(t) }
            } else if (t["repeat"]?.stringValue ?? "none") == "none" {
                let sd = t["scheduledDate"]?.stringValue ?? ""
                if sd.isEmpty {
                    // Undated "someday" task — show it instead of dropping it.
                    if !ScheduleLogic.taskDoneToday(t) { noDate.append(t) }
                } else if sd < today { if !ScheduleLogic.taskDoneToday(t) { overdue.append(t) } }
                else if sd > today { upcoming.append(t) }
            }
        }
        func byTime(_ a: JSONValue, _ b: JSONValue) -> Bool { (a["startTime"]?.stringValue ?? "99:99") < (b["startTime"]?.stringValue ?? "99:99") }
        func byDate(_ a: JSONValue, _ b: JSONValue) -> Bool { (a["scheduledDate"]?.stringValue ?? "") < (b["scheduledDate"]?.stringValue ?? "") }
        func byTitle(_ a: JSONValue, _ b: JSONValue) -> Bool { (a["title"]?.stringValue ?? "") < (b["title"]?.stringValue ?? "") }
        return [("Overdue", true, overdue.sorted(by: byDate)), ("Today", false, todayG.sorted(by: byTime)),
                ("Upcoming", false, upcoming.sorted(by: byDate)), ("No date", false, noDate.sorted(by: byTitle)),
                ("Done today", false, done.sorted(by: byTime))]
    }

    var body: some View {
        List {
            if tasks.isEmpty {
                Text("No tasks yet. Tap + to add one.").italic().foregroundStyle(Theme.textTertiary)
            } else {
                ForEach(groups().filter { !$0.2.isEmpty }, id: \.0) { (label, danger, items) in
                    Section {
                        ForEach(items, id: \.self) { t in taskRow(t) }
                    } header: { Text(label).foregroundStyle(danger ? Theme.danger : Theme.textSecondary) }
                }
            }
        }
        .groupedListStyle().scrollContentBackground(.hidden).background(Theme.bg)
        .navigationTitle("Tasks")
        .toolbar { ToolbarItem(placement: .primaryAction) { Button { editId = store.addItem("schedule", "scheduleItems", newTaskFields()) } label: { Image(systemName: "plus") } } }
        .navigationDestination(isPresented: Binding(get: { editId != nil }, set: { if !$0 { editId = nil } })) {
            if let id = editId { TaskEditor(id: id) }
        }
    }

    private func taskRow(_ t: JSONValue) -> some View {
        let done = ScheduleLogic.taskDoneToday(t)
        var parts: [String] = []
        if (t["repeat"]?.stringValue ?? "none") == "none", let sd = t["scheduledDate"]?.stringValue, sd != DateLogic.todayStr() {
            parts.append(DateLogic.relDate(sd))
        }
        if let st = t["startTime"]?.stringValue, !st.isEmpty { parts.append(DateLogic.fmtTime(st)) }
        return HStack(spacing: 12) {
            Button { toggle(t) } label: { Image(systemName: done ? "checkmark.circle.fill" : "circle").font(.title3) }.buttonStyle(.plain)
            Button { editId = t["id"]?.stringValue } label: {
                VStack(alignment: .leading, spacing: 1) {
                    Text(t["title"]?.stringValue ?? "Untitled").strikethrough(done).foregroundStyle(done ? Theme.textTertiary : Theme.text)
                    if !parts.isEmpty { Text(parts.joined(separator: " · ")).font(.caption).foregroundStyle(Theme.textSecondary) }
                }
                Spacer()
            }
        }
    }

    private func toggle(_ t: JSONValue) {
        guard let id = t["id"]?.stringValue else { return }
        let done = ScheduleLogic.taskDoneToday(t)
        store.patchItem("schedule", "scheduleItems", id: id, ["lastCompletedDate": done ? .null : .string(DateLogic.todayStr())])
    }
    private func newTaskFields() -> [String: JSONValue] {
        ["title": .string(""), "startTime": .string(""), "notifyBefore": .number(0), "repeat": .string("none"),
         "repeatDays": .array([]), "scheduledDate": .string(DateLogic.todayStr()), "reminderDaysBefore": .array([]), "lastCompletedDate": .null]
    }
}

struct TaskEditor: View {
    let id: String
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""; @State private var notes = ""
    @State private var repeatMode = "none"
    @State private var date = Date(); @State private var time = ""
    @State private var dayOfWeek = 0; @State private var customDays: Set<Int> = []
    @State private var notify = 0; @State private var reminders: Set<Int> = []
    @State private var loaded = false

    private let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    private func patch(_ f: [String: JSONValue]) { store.patchItem("schedule", "scheduleItems", id: id, f) }

    var body: some View {
        Form {
            Section { fieldLabel("Task"); TextField("What needs doing?", text: $title, axis: .vertical).lineLimit(1...5).onChange(of: title) { patch(["title": .string($0)]) } }
            Section { fieldLabel("Notes"); TextField("Add details", text: $notes, axis: .vertical).lineLimit(2...3).onChange(of: notes) { patch(["description": .string($0)]) } }

            Picker("Repeat", selection: $repeatMode) {
                ForEach([("none", "Once"), ("daily", "Every day"), ("weekdays", "Weekdays"), ("weekly", "Weekly"), ("monthly", "Monthly"), ("annually", "Annually"), ("custom", "Custom days")], id: \.0) { Text($0.1).tag($0.0) }
            }.onChange(of: repeatMode) { v in
                var f: [String: JSONValue] = ["repeat": .string(v)]
                if v == "weekly" { f["dayOfWeek"] = .number(Double(dayOfWeek)) }
                patch(f)
            }

            if repeatMode == "none" || repeatMode == "monthly" || repeatMode == "annually" {
                DatePicker(repeatMode == "monthly" ? "Day of month" : repeatMode == "annually" ? "Date each year" : "Date", selection: $date, displayedComponents: .date)
                    .onChange(of: date) { patch(["scheduledDate": .string(DateStr.toStr($0))]) }
            }
            if repeatMode == "weekly" {
                Picker("Day of week", selection: $dayOfWeek) { ForEach(0..<7, id: \.self) { Text(["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][$0]).tag($0) } }
                    .onChange(of: dayOfWeek) { patch(["dayOfWeek": .number(Double($0))]) }
            }
            if repeatMode == "custom" {
                fieldLabel("On these days")
                HStack {
                    ForEach(0..<7, id: \.self) { d in
                        Button(weekdays[d]) {
                            if customDays.contains(d) { customDays.remove(d) } else { customDays.insert(d) }
                            patch(["repeatDays": .array(customDays.sorted().map { .number(Double($0)) })])
                        }
                        .font(.caption2).frame(maxWidth: .infinity).padding(.vertical, 6)
                        .background(customDays.contains(d) ? Theme.text : Theme.surface)
                        .foregroundStyle(customDays.contains(d) ? Theme.bg : Theme.textSecondary)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                }.buttonStyle(.plain)
            }

            Section {
                fieldLabel("Time (optional)")
                DatePicker("", selection: Binding(get: { TimeStr.toDate(time) }, set: { time = TimeStr.toStr($0); patch(["startTime": .string(time)]) }), displayedComponents: .hourAndMinute).labelsHidden()
            }
            Picker("Notify", selection: $notify) {
                ForEach([(0, "At start time"), (5, "5 min before"), (10, "10 min before"), (15, "15 min before"), (30, "30 min before")], id: \.0) { Text($0.1).tag($0.0) }
            }.onChange(of: notify) { patch(["notifyBefore": .number(Double($0))]) }

            if repeatMode == "none" {
                fieldLabel("Advance reminders")
                HStack {
                    ForEach([(1, "1d"), (2, "2d"), (3, "3d"), (5, "5d"), (7, "1w")], id: \.0) { (v, lbl) in
                        Button(lbl) {
                            if reminders.contains(v) { reminders.remove(v) } else { reminders.insert(v) }
                            patch(["reminderDaysBefore": .array(reminders.sorted(by: >).map { .number(Double($0)) })])
                        }
                        .font(.caption2).frame(maxWidth: .infinity).padding(.vertical, 6)
                        .background(reminders.contains(v) ? Theme.text : Theme.surface)
                        .foregroundStyle(reminders.contains(v) ? Theme.bg : Theme.textSecondary)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                }.buttonStyle(.plain)
            }

            Button("Delete task", role: .destructive) { store.deleteItem("schedule", "scheduleItems", id: id); dismiss() }
        }
        .scrollContentBackground(.hidden).background(Theme.bg)
        .compactForm()
        .navigationTitle("Task").inlineNavTitle()
        .onAppear(perform: load)
    }

    private func load() {
        guard !loaded, let t = store.findItem("schedule", "scheduleItems", id: id) else { return }
        loaded = true
        title = t["title"]?.stringValue ?? ""; notes = t["description"]?.stringValue ?? ""
        repeatMode = t["repeat"]?.stringValue ?? "none"
        date = DateStr.toDate(t["scheduledDate"]?.stringValue ?? DateLogic.todayStr())
        time = t["startTime"]?.stringValue ?? ""
        dayOfWeek = Int(t["dayOfWeek"]?.numberValue ?? 0)
        customDays = Set((t["repeatDays"]?.arrayValue ?? []).compactMap { $0.numberValue.map(Int.init) })
        notify = Int(t["notifyBefore"]?.numberValue ?? 0)
        reminders = Set((t["reminderDaysBefore"]?.arrayValue ?? []).compactMap { $0.numberValue.map(Int.init) })
    }
}
