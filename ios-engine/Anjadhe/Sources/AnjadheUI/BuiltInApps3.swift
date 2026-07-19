import SwiftUI
import AnjadheCore

// Batch 3 of the native built-in apps: Focus areas + Goals. Same synced blobs
// the Mac uses (app_focus → focusItems, app_goals → goals), edited through
// AppStore so changes round-trip and sync.

// MARK: Focus areas

struct FocusView: View {
    @EnvironmentObject var store: AppStore
    @State private var editId: String?

    private var areas: [JSONValue] {
        store.items("focus", "focusItems").sorted { ($0["createdAt"]?.stringValue ?? "") < ($1["createdAt"]?.stringValue ?? "") }
    }

    var body: some View {
        List {
            if areas.isEmpty {
                Text("No focus areas yet. Tap + to add one.").italic().foregroundStyle(Theme.textTertiary)
            } else {
                ForEach(areas, id: \.self) { f in
                    Button { editId = f["id"]?.stringValue } label: {
                        HStack(spacing: 10) {
                            Circle().fill(Color(hexString: f["color"]?.stringValue ?? "#78909C")).frame(width: 11, height: 11)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(f["title"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? "Untitled").foregroundStyle(Theme.text)
                                let d = f["description"]?.stringValue ?? ""
                                if !d.isEmpty { Text(d).font(.caption).foregroundStyle(Theme.textTertiary).lineLimit(1) }
                            }
                            Spacer()
                        }
                    }
                }
            }
        }
        .listStyle(.plain).scrollContentBackground(.hidden).background(Theme.bg)
        .navigationTitle("Focus")
        .toolbar { ToolbarItem(placement: .primaryAction) { Button { editId = store.addItem("focus", "focusItems", ["title": .string(""), "description": .string(""), "color": .string("#4A90A4"), "parentId": .null, "profile": .string("default")]) } label: { Image(systemName: "plus") } } }
        .navigationDestination(isPresented: Binding(get: { editId != nil }, set: { if !$0 { editId = nil } })) {
            if let id = editId { FocusEditor(id: id) }
        }
    }
}

struct FocusEditor: View {
    let id: String
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""; @State private var desc = ""; @State private var color = "#4A90A4"; @State private var loaded = false

    private let palette = ["#4A90A4", "#7CB342", "#FF7043", "#AB47BC", "#EC407A", "#26A69A", "#5C6BC0", "#78909C"]
    private func patch(_ f: [String: JSONValue]) { store.patchItem("focus", "focusItems", id: id, f) }

    var body: some View {
        Form {
            Section { fieldLabel("Name"); TextField("Focus area", text: $title, axis: .vertical).lineLimit(1...4).onChange(of: title) { patch(["title": .string($0)]) } }
            Section { fieldLabel("Description"); TextField("What is this about?", text: $desc, axis: .vertical).lineLimit(2...5).onChange(of: desc) { patch(["description": .string($0)]) } }
            Section {
                fieldLabel("Color")
                HStack(spacing: 14) {
                    ForEach(palette, id: \.self) { c in
                        Circle().fill(Color(hexString: c)).frame(width: 28, height: 28)
                            .overlay(Circle().strokeBorder(Theme.text, lineWidth: color == c ? 2 : 0))
                            .onTapGesture { color = c; patch(["color": .string(c)]) }
                    }
                    Spacer()
                }
            }
            let goals = store.linkedItems("focus", id, targetApp: "goals", blobKey: "goals", arrayKey: "goals")
            if !goals.isEmpty {
                Section("Goals") {
                    ForEach(goals, id: \.self) { g in
                        NavigationLink {
                            GoalEditor(id: g["id"]?.stringValue ?? "")
                        } label: {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(g["title"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? "Untitled").foregroundStyle(Theme.text)
                                    .strikethrough(g["completed"]?.boolValue ?? false)
                                if !(g["completed"]?.boolValue ?? false) {
                                    Text(goalStatusLabel(g["status"]?.stringValue ?? "not-started")).font(.caption).foregroundStyle(goalStatusColor(g["status"]?.stringValue ?? "not-started"))
                                }
                            }
                        }
                    }
                }
            }
            let habits = store.linkedItems("focus", id, targetApp: "habits", blobKey: "habits", arrayKey: "habits")
            if !habits.isEmpty {
                Section("Habits") {
                    ForEach(habits, id: \.self) { h in
                        NavigationLink {
                            HabitEditor(id: h["id"]?.stringValue ?? "")
                        } label: {
                            Text(h["action"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? "Untitled").foregroundStyle(Theme.text)
                        }
                    }
                }
            }

            Button("Delete focus area", role: .destructive) { store.deleteItem("focus", "focusItems", id: id); dismiss() }
        }
        .scrollContentBackground(.hidden).background(Theme.bg).compactForm()
        .navigationTitle("Focus area").inlineNavTitle()
        .onAppear {
            guard !loaded, let f = store.findItem("focus", "focusItems", id: id) else { return }
            loaded = true
            title = f["title"]?.stringValue ?? ""; desc = f["description"]?.stringValue ?? ""; color = f["color"]?.stringValue ?? "#4A90A4"
        }
    }
}

// MARK: Goals

private let GOAL_TYPES: [(String, String)] = [("today", "Today"), ("week", "This Week"), ("month", "This Month"), ("year", "This Year")]
private let GOAL_STATUSES: [(String, String)] = [("not-started", "Not Started"), ("in-progress", "In Progress"), ("no-progress", "No Progress"), ("need-help", "Need Help")]

private func goalStatusLabel(_ s: String) -> String { GOAL_STATUSES.first { $0.0 == s }?.1 ?? "Not Started" }
private func goalStatusColor(_ s: String) -> Color {
    switch s {
    case "in-progress": return Theme.text
    case "no-progress": return Theme.warning
    case "need-help": return Theme.danger
    default: return Theme.textTertiary
    }
}

struct GoalsView: View {
    @EnvironmentObject var store: AppStore
    @State private var editId: String?

    private var goals: [JSONValue] { store.items("goals", "goals") }

    private func groups() -> [(String, [JSONValue])] {
        let active = goals.filter { !($0["completed"]?.boolValue ?? false) }
        var out: [(String, [JSONValue])] = []
        for (key, label) in GOAL_TYPES {
            let g = active.filter { ($0["type"]?.stringValue ?? "") == key }
            if !g.isEmpty { out.append((label, g)) }
        }
        let known = Set(GOAL_TYPES.map { $0.0 })
        let other = active.filter { !known.contains($0["type"]?.stringValue ?? "") }
        if !other.isEmpty { out.append(("Other", other)) }
        let completed = goals.filter { $0["completed"]?.boolValue ?? false }
        if !completed.isEmpty { out.append(("Completed", completed)) }
        return out
    }

    var body: some View {
        List {
            if goals.isEmpty {
                Text("No goals yet. Tap + to set one.").italic().foregroundStyle(Theme.textTertiary)
            } else {
                ForEach(groups(), id: \.0) { (label, items) in
                    Section { ForEach(items, id: \.self) { goalRow($0) } }
                        header: { Text(label).foregroundStyle(Theme.textSecondary) }
                }
            }
        }
        .groupedListStyle().scrollContentBackground(.hidden).background(Theme.bg)
        .navigationTitle("Goals")
        .toolbar { ToolbarItem(placement: .primaryAction) { Button { editId = store.addItem("goals", "goals", ["title": .string(""), "description": .string(""), "type": .string("week"), "status": .string("not-started"), "completed": .bool(false), "profile": .string("default")]) } label: { Image(systemName: "plus") } } }
        .navigationDestination(isPresented: Binding(get: { editId != nil }, set: { if !$0 { editId = nil } })) {
            if let id = editId { GoalEditor(id: id) }
        }
    }

    private func goalRow(_ g: JSONValue) -> some View {
        let id = g["id"]?.stringValue ?? ""
        let completed = g["completed"]?.boolValue ?? false
        let status = g["status"]?.stringValue ?? "not-started"
        return HStack(spacing: 12) {
            Button { store.patchItem("goals", "goals", id: id, ["completed": .bool(!completed)]) } label: {
                Image(systemName: completed ? "checkmark.circle.fill" : "circle").font(.title3)
                    .foregroundStyle(completed ? Theme.text : Theme.textTertiary)
            }.buttonStyle(.plain)
            Button { if !id.isEmpty { editId = id } } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(g["title"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? "Untitled")
                            .strikethrough(completed).foregroundStyle(completed ? Theme.textTertiary : Theme.text)
                        if !completed { Text(goalStatusLabel(status)).font(.caption).foregroundStyle(goalStatusColor(status)) }
                    }
                    Spacer()
                }
            }.buttonStyle(.plain)
        }
    }
}

struct GoalEditor: View {
    let id: String
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""; @State private var desc = ""
    @State private var type = "week"; @State private var status = "not-started"; @State private var completed = false; @State private var loaded = false

    private func patch(_ f: [String: JSONValue]) { store.patchItem("goals", "goals", id: id, f) }

    var body: some View {
        Form {
            Section { fieldLabel("Goal"); TextField("What do you want to achieve?", text: $title, axis: .vertical).lineLimit(1...4).onChange(of: title) { patch(["title": .string($0)]) } }
            Section { fieldLabel("Description"); TextField("Why does it matter / how?", text: $desc, axis: .vertical).lineLimit(2...5).onChange(of: desc) { patch(["description": .string($0)]) } }
            Picker("Timeframe", selection: $type) {
                ForEach(GOAL_TYPES, id: \.0) { Text($0.1).tag($0.0) }
            }.onChange(of: type) { patch(["type": .string($0)]) }
            Picker("Status", selection: $status) {
                ForEach(GOAL_STATUSES, id: \.0) { Text($0.1).tag($0.0) }
            }.onChange(of: status) { patch(["status": .string($0)]) }
            Toggle("Completed", isOn: $completed).onChange(of: completed) { patch(["completed": .bool($0)]) }

            let tasks = store.linkedItems("goals", id, targetApp: "schedule", blobKey: "schedule", arrayKey: "scheduleItems")
            if !tasks.isEmpty {
                Section("Tasks") {
                    ForEach(tasks, id: \.self) { t in
                        NavigationLink {
                            TaskEditor(id: t["id"]?.stringValue ?? "")
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: ScheduleLogic.taskDoneToday(t) ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(ScheduleLogic.taskDoneToday(t) ? Theme.text : Theme.textTertiary)
                                Text(t["title"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? "Untitled").foregroundStyle(Theme.text)
                                Spacer()
                                if let st = t["startTime"]?.stringValue, !st.isEmpty {
                                    Text(DateLogic.fmtTime(st)).font(.caption).foregroundStyle(Theme.textTertiary)
                                }
                            }
                        }
                    }
                }
            }

            Button("Delete goal", role: .destructive) { store.deleteItem("goals", "goals", id: id); dismiss() }
        }
        .scrollContentBackground(.hidden).background(Theme.bg).compactForm()
        .navigationTitle("Goal").inlineNavTitle()
        .onAppear {
            guard !loaded, let g = store.findItem("goals", "goals", id: id) else { return }
            loaded = true
            title = g["title"]?.stringValue ?? ""; desc = g["description"]?.stringValue ?? ""
            type = g["type"]?.stringValue ?? "week"; status = g["status"]?.stringValue ?? "not-started"; completed = g["completed"]?.boolValue ?? false
        }
    }
}
