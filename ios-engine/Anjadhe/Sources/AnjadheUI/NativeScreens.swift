import SwiftUI
import AnjadheCore
import AnjadheSpecEngine

// Native SwiftUI conversion of the mobile app's three roots (today/apps/search),
// reading the synced blobs from KVStore and using the verified ScheduleLogic.
// This is the built-in-app side of the native shell; spec apps render via
// SpecAppView. Editors/detail are follow-ups.

// MARK: Shell

public struct NativeShell: View {
    let specApps: [(name: String, spec: JSONValue)]
    @ObservedObject var store: AppStore
    @ObservedObject var sync: SyncCoordinator

    public init(store: AppStore, sync: SyncCoordinator, specApps: [(name: String, spec: JSONValue)]) {
        self.store = store
        self.sync = sync
        self.specApps = specApps
    }

    public var body: some View {
        TabView {
            TodayView().tabItem { Label("Today", systemImage: "sun.max") }
            AppsView(specApps: specApps).tabItem { Label("Apps", systemImage: "square.grid.2x2") }
            SearchView().tabItem { Label("Search", systemImage: "magnifyingglass") }
            SettingsView(sync: sync).tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .environmentObject(store)
        .tint(Theme.text) // monochrome — no system blue
    }
}

struct SettingsView: View {
    @ObservedObject var sync: SyncCoordinator

    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink {
                        SyncContent(sync: sync)
                    } label: {
                        HStack {
                            Label("Sync", systemImage: "arrow.triangle.2.circlepath")
                            Spacer()
                            Text(sync.paired ? "Paired" : "Not paired").font(.caption).foregroundStyle(Theme.textTertiary)
                        }
                    }
                } header: { Text("Devices").foregroundStyle(Theme.textSecondary) }
            }
            .groupedListStyle().scrollContentBackground(.hidden).background(Theme.bg)
            .navigationTitle("Settings")
        }
    }
}

/// The pairing/sync detail page — pushed from Settings.
struct SyncContent: View {
    @ObservedObject var sync: SyncCoordinator
    @State private var offer = ""
    @State private var showScanner = false

    var body: some View {
        Form {
            Section("Status") {
                HStack { Text("Connection"); Spacer(); Text(sync.state).foregroundStyle(.secondary) }
                HStack { Text("Paired"); Spacer(); Text(sync.paired ? "Yes" : "No").foregroundStyle(.secondary) }
                Button("Sync now") { sync.triggerSync() }
            }
            Section("Pair with your Mac") {
                Text("On your Mac, open Anjadhe's pairing screen and scan the code — or paste it below.")
                    .font(.caption).foregroundStyle(.secondary)
                #if os(iOS)
                Button { showScanner = true } label: { Label("Scan pairing code", systemImage: "qrcode.viewfinder") }
                #endif
                TextField("Paste pairing code", text: $offer, axis: .vertical).lineLimit(2...4)
                Button("Pair") { sync.pair(offerText: offer) }.disabled(offer.isEmpty)
                if let e = sync.lastPairError { Text(e).font(.caption).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Sync").inlineNavTitle()
        .scrollContentBackground(.hidden)
        .background(Theme.bg)
        #if os(iOS)
        .sheet(isPresented: $showScanner) {
            QRScannerView { code in showScanner = false; sync.pair(offerText: code) }
                .ignoresSafeArea()
        }
        #endif
    }
}

// MARK: Today

struct TodayView: View {
    @EnvironmentObject var store: AppStore
    @State private var dest: Dest?

    /// Detail destinations reachable by tapping a Today item — opens the same
    /// editors the per-app screens use.
    enum Dest: Hashable { case task(String), habit(String), note(String), journal(String) }

    var greeting: String {
        let h = Calendar.current.component(.hour, from: Date())
        return h < 12 ? "Good morning" : (h < 18 ? "Good afternoon" : "Good evening")
    }
    var dateLine: String {
        let f = DateFormatter(); f.dateFormat = "EEEE, MMMM d"; return f.string(from: Date())
    }

    var body: some View {
        let tasks = store.kv.get("app_schedule")?["scheduleItems"]?.arrayValue ?? []
        let habits = store.kv.get("app_habits")?["habits"]?.arrayValue ?? []
        let dueTasks = tasks
            .filter { ScheduleLogic.taskDueToday($0) && !ScheduleLogic.taskDoneToday($0) }
            .sorted { ($0["startTime"]?.stringValue ?? "") < ($1["startTime"]?.stringValue ?? "") }
        let dueHabits = habits.filter {
            ($0["status"]?.stringValue ?? "active") == "active" && ScheduleLogic.habitDueToday($0)
        }

        return NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(greeting).font(Theme.display(30)).foregroundStyle(Theme.text)
                        Text(dateLine).foregroundStyle(Theme.textSecondary)
                    }

                    sectionHeaderView("Today")
                    if dueTasks.isEmpty {
                        emptyText("Nothing scheduled — enjoy the space.")
                    } else {
                        ForEach(Array(dueTasks.enumerated()), id: \.offset) { _, t in taskRow(t) }
                    }

                    sectionHeaderView("Habits")
                    if dueHabits.isEmpty {
                        emptyText("No habits for today.")
                    } else {
                        ForEach(Array(dueHabits.enumerated()), id: \.offset) { _, h in habitRow(h) }
                    }

                    let cont = continueItems()
                    if !cont.isEmpty {
                        sectionHeaderView("Continue")
                        ForEach(Array(cont.enumerated()), id: \.offset) { _, item in
                            Button { dest = item.dest } label: {
                                HStack {
                                    Text(item.title).lineLimit(1).foregroundStyle(Theme.text)
                                    Spacer()
                                    Text(item.when).font(.caption).foregroundStyle(Theme.textTertiary)
                                }
                            }
                            .buttonStyle(.plain)
                            Divider()
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
            }
            .background(Theme.bg)
            .hiddenNavBar()
            .navigationDestination(isPresented: Binding(get: { dest != nil }, set: { if !$0 { dest = nil } })) {
                switch dest {
                case .task(let id): TaskEditor(id: id)
                case .habit(let id): HabitEditor(id: id)
                case .note(let id): NoteEditor(id: id)
                case .journal(let id): JournalEditor(id: id)
                case .none: EmptyView()
                }
            }
        }
    }

    func taskRow(_ t: JSONValue) -> some View {
        let id = t["id"]?.stringValue ?? ""
        return HStack(spacing: 12) {
            Button { toggleTask(id) } label: {
                Image(systemName: "circle").font(.title3)
            }.buttonStyle(.plain)
            Button { if !id.isEmpty { dest = .task(id) } } label: {
                VStack(alignment: .leading, spacing: 1) {
                    Text(t["title"]?.stringValue ?? "").fontWeight(.medium).foregroundStyle(Theme.text)
                    if let time = t["startTime"]?.stringValue, !time.isEmpty {
                        Text(DateLogic.fmtTime(time)).font(.caption).foregroundStyle(Theme.textSecondary)
                    }
                }
                Spacer()
            }.buttonStyle(.plain)
        }
        .padding(.vertical, 4)
    }

    func habitRow(_ h: JSONValue) -> some View {
        let id = h["id"]?.stringValue ?? ""
        let done = ScheduleLogic.habitDoneToday(h)
        let streak = ScheduleLogic.habitStreak(h)
        let isBreak = h["polarity"]?.stringValue == "break"
        return HStack(spacing: 12) {
            Button { toggleHabit(id) } label: {
                Image(systemName: done ? "checkmark.circle.fill" : "circle").font(.title3)
            }.buttonStyle(.plain)
            Button { if !id.isEmpty { dest = .habit(id) } } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(h["action"]?.stringValue ?? "").fontWeight(.medium).foregroundStyle(Theme.text)
                        if isBreak { Text("Avoid this").font(.caption).foregroundStyle(Theme.textSecondary) }
                    }
                    Spacer()
                }
            }.buttonStyle(.plain)
            if streak > 0 {
                Text("\(streak) day\(streak == 1 ? "" : "s")")
                    .font(.caption2).foregroundStyle(Theme.textSecondary)
                    .padding(.horizontal, 8).padding(.vertical, 2)
                    .background(Capsule().fill(Theme.surface))
                    .overlay(Capsule().strokeBorder(Theme.border))
            }
        }
        .padding(.vertical, 4)
    }

    struct ContinueItem { let title: String; let when: String; let at: String; let dest: Dest }
    func continueItems() -> [ContinueItem] {
        var out: [ContinueItem] = []
        for n in store.kv.get("app_notes")?["notes"]?.arrayValue ?? [] {
            out.append(ContinueItem(
                title: (n["title"]?.stringValue).flatMap { $0.isEmpty ? nil : $0 } ?? stripHTML(n["content"]?.stringValue ?? ""),
                when: DateLogic.relDate(n["modifiedAt"]?.stringValue ?? n["createdAt"]?.stringValue ?? ""),
                at: n["modifiedAt"]?.stringValue ?? n["createdAt"]?.stringValue ?? "",
                dest: .note(n["id"]?.stringValue ?? "")))
        }
        for e in store.kv.get("app_journal")?["entries"]?.arrayValue ?? [] {
            out.append(ContinueItem(
                title: "Journal — " + stripHTML(e["content"]?.stringValue ?? ""),
                when: DateLogic.relDate(e["modifiedAt"]?.stringValue ?? e["createdAt"]?.stringValue ?? ""),
                at: e["modifiedAt"]?.stringValue ?? e["createdAt"]?.stringValue ?? "",
                dest: .journal(e["id"]?.stringValue ?? "")))
        }
        return Array(out.sorted { $0.at > $1.at }.prefix(3))
    }

    func toggleTask(_ id: String) {
        guard var blob = store.kv.get("app_schedule")?.objectValue, var items = blob["scheduleItems"]?.arrayValue,
              let idx = items.firstIndex(where: { $0["id"]?.stringValue == id }), case .object(var t) = items[idx] else { return }
        let today = DateLogic.todayStr()
        t["lastCompletedDate"] = (t["lastCompletedDate"]?.stringValue == today) ? .null : .string(today)
        t["modifiedAt"] = .string(KVStore.nowISO())
        items[idx] = .object(t); blob["scheduleItems"] = .array(items)
        store.kv.set("app_schedule", .object(blob), now: KVStore.nowISO()); store.bump()
    }

    func toggleHabit(_ id: String) {
        guard var blob = store.kv.get("app_habits")?.objectValue, var habits = blob["habits"]?.arrayValue,
              let idx = habits.firstIndex(where: { $0["id"]?.stringValue == id }), case .object(var h) = habits[idx] else { return }
        let today = DateLogic.todayStr()
        var comps = h["completions"]?.arrayValue ?? []
        if let cIdx = comps.firstIndex(where: { $0["date"]?.stringValue == today }) { comps.remove(at: cIdx) }
        else { comps.append(.object(["date": .string(today)])) }
        h["completions"] = .array(comps); h["modifiedAt"] = .string(KVStore.nowISO())
        habits[idx] = .object(h); blob["habits"] = .array(habits)
        store.kv.set("app_habits", .object(blob), now: KVStore.nowISO()); store.bump()
    }

    func sectionHeaderView(_ t: String) -> some View {
        Text(t).sectionHeaderStyle()
    }
    func emptyText(_ t: String) -> some View { Text(t).italic().foregroundStyle(Theme.textTertiary) }
}

func stripHTML(_ s: String) -> String {
    let noTags = s.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
    let collapsed = noTags.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    return String(collapsed.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))
}

// MARK: Apps

struct AppsView: View {
    let specApps: [(name: String, spec: JSONValue)]
    @EnvironmentObject var store: AppStore

    private let cols = [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.lg) {
                    if !specApps.isEmpty {
                        Text("Your apps").sectionHeaderStyle()
                        LazyVGrid(columns: cols, spacing: 18) {
                            ForEach(Array(specApps.enumerated()), id: \.offset) { _, app in
                                tile(app.name, "square.stack.3d.up", SpecAppView(spec: app.spec, store: store))
                            }
                        }
                    }
                    Text("Built-in").sectionHeaderStyle()
                    LazyVGrid(columns: cols, spacing: 18) {
                        tile("Tasks", "checklist", TasksView())
                        tile("Goals", "target", GoalsView())
                        tile("Focus", "scope", FocusView())
                        tile("Habits", "flame", HabitsView())
                        tile("Notes", "note.text", NotesView())
                        tile("Journal", "book.closed", JournalView())
                        tile("Calendar", "calendar", CalendarView())
                        tile("Prompts", "text.bubble", PromptsView())
                        tile("Feed", "newspaper", FeedView())
                        tile("Bookmarks", "bookmark", BookmarksView())
                    }
                }
                .padding()
            }
            .navigationTitle("Apps")
            .background(Theme.bg)
        }
    }

    /// One app tile: a thin-bordered rounded square with a monochrome glyph and
    /// the app name beneath — the Minimal Book Theme, launcher-style.
    private func tile<D: View>(_ name: String, _ icon: String, _ dest: D) -> some View {
        NavigationLink(destination: dest) {
            VStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 26, weight: .regular))
                    .foregroundStyle(Theme.text)
                    .frame(maxWidth: .infinity).frame(height: 76)
                    .background(RoundedRectangle(cornerRadius: Theme.radiusMd).fill(Theme.surface))
                    .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd).strokeBorder(Theme.border))
                Text(name).font(.caption).foregroundStyle(Theme.text).lineLimit(1)
            }
        }
        .buttonStyle(.plain)
    }
}

// MARK: Search

struct SearchView: View {
    @EnvironmentObject var store: AppStore
    @State private var query = ""
    @State private var dest: SearchDest?

    enum SearchDest: Hashable { case task(String), habit(String), note(String), journal(String), goal(String), focus(String), bookmark(String), prompt(String) }
    struct Hit: Identifiable { let id = UUID(); let title: String; let kind: String; let dest: SearchDest }

    var hits: [Hit] {
        let q = query.lowercased().trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return [] }
        func has(_ s: String?) -> Bool { (s ?? "").lowercased().contains(q) }
        func id(_ v: JSONValue) -> String { v["id"]?.stringValue ?? "" }
        var out: [Hit] = []

        for n in store.items("notes", "notes") where has(n["title"]?.stringValue) || stripHTML(n["content"]?.stringValue ?? "").lowercased().contains(q) {
            let t = n["title"]?.stringValue ?? ""
            out.append(Hit(title: t.isEmpty ? stripHTML(n["content"]?.stringValue ?? "") : t, kind: "Note", dest: .note(id(n))))
        }
        for t in store.items("schedule", "scheduleItems") where has(t["title"]?.stringValue) {
            out.append(Hit(title: t["title"]?.stringValue ?? "", kind: "Task", dest: .task(id(t))))
        }
        for h in store.items("habits", "habits") where has(h["action"]?.stringValue) {
            out.append(Hit(title: h["action"]?.stringValue ?? "", kind: "Habit", dest: .habit(id(h))))
        }
        for e in store.items("journal", "entries") where stripHTML(e["content"]?.stringValue ?? "").lowercased().contains(q) {
            out.append(Hit(title: stripHTML(e["content"]?.stringValue ?? ""), kind: "Journal", dest: .journal(id(e))))
        }
        for g in store.items("goals", "goals") where has(g["title"]?.stringValue) || has(g["description"]?.stringValue) {
            out.append(Hit(title: g["title"]?.stringValue ?? "Untitled", kind: "Goal", dest: .goal(id(g))))
        }
        for f in store.items("focus", "focusItems") where has(f["title"]?.stringValue) || has(f["description"]?.stringValue) {
            out.append(Hit(title: f["title"]?.stringValue ?? "Untitled", kind: "Focus", dest: .focus(id(f))))
        }
        for b in store.items("bookmarks", "bookmarks") where has(b["title"]?.stringValue) || has(b["url"]?.stringValue) {
            out.append(Hit(title: b["title"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? (b["url"]?.stringValue ?? "Untitled"), kind: "Bookmark", dest: .bookmark(id(b))))
        }
        for p in store.items("prompts", "prompts") where has(p["title"]?.stringValue) || has(p["body"]?.stringValue) {
            out.append(Hit(title: p["title"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? "Untitled", kind: "Prompt", dest: .prompt(id(p))))
        }
        return Array(out.prefix(60))
    }

    var body: some View {
        NavigationStack {
            List {
                if query.trimmingCharacters(in: .whitespaces).isEmpty {
                    Text("Search your tasks, notes, journal, goals, focus areas, habits, bookmarks and prompts.").foregroundStyle(Theme.textTertiary)
                } else if hits.isEmpty {
                    Text("No matches.").foregroundStyle(Theme.textTertiary)
                } else {
                    ForEach(hits) { hit in
                        Button { dest = hit.dest } label: {
                            HStack {
                                Text(hit.title).lineLimit(1).foregroundStyle(Theme.text)
                                Spacer()
                                Text(hit.kind).font(.caption).foregroundStyle(Theme.textTertiary)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("Search")
            .searchable(text: $query, prompt: "Search everything")
            .navigationDestination(isPresented: Binding(get: { dest != nil }, set: { if !$0 { dest = nil } })) {
                switch dest {
                case .task(let id): TaskEditor(id: id)
                case .habit(let id): HabitEditor(id: id)
                case .note(let id): NoteEditor(id: id)
                case .journal(let id): JournalEditor(id: id)
                case .goal(let id): GoalEditor(id: id)
                case .focus(let id): FocusEditor(id: id)
                case .bookmark(let id): BookmarkEditor(id: id)
                case .prompt(let id): PromptEditor(id: id)
                case .none: EmptyView()
                }
            }
        }
    }
}
