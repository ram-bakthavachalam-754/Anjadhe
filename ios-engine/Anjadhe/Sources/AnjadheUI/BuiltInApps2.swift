import SwiftUI
import AnjadheCore

// Batch 2 of the native built-in apps: Notes, Journal, Habits, Calendar.
// Rich-text editing (notes/journal) is plain-text for now (content round-trips
// with the Mac's simple HTML); a formatting toolbar is a follow-up. Habit
// schedule-into-tasks and focus-area links are also follow-ups.

// MARK: Notes

struct NotesView: View {
    @EnvironmentObject var store: AppStore
    @State private var editId: String?
    private var notes: [JSONValue] {
        store.items("notes", "notes").sorted {
            let ap = $0["pinned"]?.boolValue ?? false, bp = $1["pinned"]?.boolValue ?? false
            if ap != bp { return ap }
            return ($0["modifiedAt"]?.stringValue ?? "") > ($1["modifiedAt"]?.stringValue ?? "")
        }
    }
    var body: some View {
        List {
            if notes.isEmpty {
                Text("No notes yet. Tap + to write one.").italic().foregroundStyle(Theme.textTertiary)
            } else {
                ForEach(notes, id: \.self) { n in
                    Button { editId = n["id"]?.stringValue } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 1) {
                                HStack(spacing: 4) {
                                    if n["pinned"]?.boolValue == true { Image(systemName: "star.fill").font(.caption2).foregroundStyle(Theme.textSecondary) }
                                    Text(n["title"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? "Untitled").foregroundStyle(Theme.text)
                                }
                                Text(plainPreview(n["content"]?.stringValue ?? "", 72)).font(.caption).foregroundStyle(Theme.textTertiary).lineLimit(1)
                            }
                            Spacer()
                            Text(DateLogic.relDate(n["modifiedAt"]?.stringValue ?? "")).font(.caption2).foregroundStyle(Theme.textTertiary)
                        }
                    }
                }
            }
        }
        .listStyle(.plain).scrollContentBackground(.hidden).background(Theme.bg)
        .navigationTitle("Notes")
        .toolbar { ToolbarItem(placement: .primaryAction) { Button { editId = store.addItem("notes", "notes", ["title": .string(""), "content": .string(""), "pinned": .bool(false), "tags": .array([])]) } label: { Image(systemName: "plus") } } }
        .navigationDestination(isPresented: Binding(get: { editId != nil }, set: { if !$0 { editId = nil } })) {
            if let id = editId { NoteEditor(id: id) }
        }
    }
}

struct NoteEditor: View {
    let id: String
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""; @State private var html = ""; @State private var pinned = false; @State private var loaded = false
    var body: some View {
        VStack(spacing: 0) {
            TextField("Title", text: $title, axis: .vertical).lineLimit(1...4).font(.title3.bold()).padding(.horizontal).padding(.top, 8)
                .onChange(of: title) { store.patchItem("notes", "notes", id: id, ["title": .string($0)]) }
            Divider().padding(.top, 8)
            RichEditorView(html: $html, placeholder: "Write…")
                .onChange(of: html) { store.patchItem("notes", "notes", id: id, ["content": .string($0)]) }
        }
        .background(Theme.bg)
        .navigationTitle("Note").inlineNavTitle()
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button { pinned.toggle(); store.patchItem("notes", "notes", id: id, ["pinned": .bool(pinned)]) } label: { Image(systemName: pinned ? "star.fill" : "star") }
                Button(role: .destructive) { store.deleteItem("notes", "notes", id: id); dismiss() } label: { Image(systemName: "trash") }
            }
        }
        .onAppear {
            guard !loaded, let n = store.findItem("notes", "notes", id: id) else { return }
            loaded = true
            title = n["title"]?.stringValue ?? ""; html = n["content"]?.stringValue ?? ""; pinned = n["pinned"]?.boolValue ?? false
        }
    }
}

// MARK: Journal

private let MOODS = ["great", "good", "okay", "low", "rough"]

struct JournalView: View {
    @EnvironmentObject var store: AppStore
    @State private var editId: String?
    private var entries: [JSONValue] {
        store.items("journal", "entries").sorted { ($0["date"]?.stringValue ?? $0["createdAt"]?.stringValue ?? "") > ($1["date"]?.stringValue ?? $1["createdAt"]?.stringValue ?? "") }
    }
    var body: some View {
        List {
            if entries.isEmpty {
                Text("No entries yet. Tap + to begin.").italic().foregroundStyle(Theme.textTertiary)
            } else {
                ForEach(entries, id: \.self) { e in
                    Button { editId = e["id"]?.stringValue } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(DateLogic.relDate(e["date"]?.stringValue ?? e["createdAt"]?.stringValue ?? "")).foregroundStyle(Theme.text)
                                Text(plainPreview(e["content"]?.stringValue ?? "", 76)).font(.caption).foregroundStyle(Theme.textTertiary).lineLimit(1)
                            }
                            Spacer()
                            if let m = e["mood"]?.stringValue, !m.isEmpty {
                                Text(m).font(.caption2).foregroundStyle(Theme.textSecondary).padding(.horizontal, 8).padding(.vertical, 2).background(Capsule().fill(Theme.surface)).overlay(Capsule().strokeBorder(Theme.border))
                            }
                        }
                    }
                }
            }
        }
        .listStyle(.plain).scrollContentBackground(.hidden).background(Theme.bg)
        .navigationTitle("Journal")
        .toolbar { ToolbarItem(placement: .primaryAction) { Button { editId = store.addItem("journal", "entries", ["content": .string(""), "mood": .string(""), "tags": .array([]), "date": .string(KVStore.nowISO())]) } label: { Image(systemName: "plus") } } }
        .navigationDestination(isPresented: Binding(get: { editId != nil }, set: { if !$0 { editId = nil } })) {
            if let id = editId { JournalEditor(id: id) }
        }
    }
}

struct JournalEditor: View {
    let id: String
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var html = ""; @State private var mood = ""; @State private var loaded = false
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                ForEach(MOODS, id: \.self) { m in
                    Button(m) {
                        mood = (mood == m) ? "" : m
                        store.patchItem("journal", "entries", id: id, ["mood": .string(mood)])
                    }
                    .font(.caption).frame(maxWidth: .infinity).padding(.vertical, 6)
                    .background(mood == m ? Theme.text : Theme.surface)
                    .foregroundStyle(mood == m ? Theme.bg : Theme.textSecondary)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                }
            }.buttonStyle(.plain).padding()
            Divider()
            RichEditorView(html: $html, placeholder: "How was today?")
                .onChange(of: html) { store.patchItem("journal", "entries", id: id, ["content": .string($0)]) }
        }
        .background(Theme.bg)
        .navigationTitle("Journal").inlineNavTitle()
        .toolbar { ToolbarItem(placement: .primaryAction) { Button(role: .destructive) { store.deleteItem("journal", "entries", id: id); dismiss() } label: { Image(systemName: "trash") } } }
        .onAppear {
            guard !loaded, let e = store.findItem("journal", "entries", id: id) else { return }
            loaded = true
            html = e["content"]?.stringValue ?? ""; mood = e["mood"]?.stringValue ?? ""
        }
    }
}

// MARK: Habits

struct HabitsView: View {
    @EnvironmentObject var store: AppStore
    @State private var editId: String?
    @State private var tab = "list"

    private var habits: [JSONValue] {
        store.items("habits", "habits").filter { ($0["status"]?.stringValue ?? "active") == "active" }
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $tab) { Text("Habits").tag("list"); Text("Stats").tag("stats") }
                .pickerStyle(.segmented).padding()
            if tab == "stats" { statsList } else { habitList }
        }
        .background(Theme.bg)
        .navigationTitle("Habits")
        .toolbar { ToolbarItem(placement: .primaryAction) { Button { editId = store.addItem("habits", "habits", newHabitFields()) } label: { Image(systemName: "plus") } } }
        .navigationDestination(isPresented: Binding(get: { editId != nil }, set: { if !$0 { editId = nil } })) {
            if let id = editId { HabitEditor(id: id) }
        }
    }

    private var sortedHabits: [JSONValue] {
        habits.sorted {
            let ad = ScheduleLogic.habitDueToday($0), bd = ScheduleLogic.habitDueToday($1)
            if ad != bd { return ad }
            let ac = ScheduleLogic.habitDoneToday($0), bc = ScheduleLogic.habitDoneToday($1)
            if ac != bc { return !ac }
            return false
        }
    }

    private var habitList: some View {
        List {
            if habits.isEmpty {
                Text("No habits yet. Tap + to add one.").italic().foregroundStyle(Theme.textTertiary)
            } else {
                ForEach(sortedHabits, id: \.self) { h in habitRow(h) }
            }
        }.listStyle(.plain).scrollContentBackground(.hidden).background(Theme.bg)
    }

    private func habitRow(_ h: JSONValue) -> some View {
        let done = ScheduleLogic.habitDoneToday(h)
        let streak = ScheduleLogic.habitStreak(h)
        let isBreak = h["polarity"]?.stringValue == "break"
        return HStack(spacing: 12) {
            Button { if let id = h["id"]?.stringValue { store.toggleHabitCompletion(id: id, dateStr: DateLogic.todayStr()) } } label: {
                Image(systemName: done ? "checkmark.circle.fill" : "circle").font(.title3)
            }.buttonStyle(.plain)
            Button { editId = h["id"]?.stringValue } label: {
                VStack(alignment: .leading, spacing: 1) {
                    Text(h["action"]?.stringValue ?? "Untitled").foregroundStyle(Theme.text)
                    if isBreak { Text("Avoid this").font(.caption).foregroundStyle(Theme.textSecondary) }
                }
                Spacer()
                if streak > 0 {
                    Text("\(streak)d").font(.caption2).foregroundStyle(Theme.textSecondary).padding(.horizontal, 8).padding(.vertical, 2).background(Capsule().fill(Theme.surface)).overlay(Capsule().strokeBorder(Theme.border))
                }
            }
        }
    }

    private var statsList: some View {
        ScrollView {
            VStack(spacing: 14) {
                ForEach(habits, id: \.self) { h in
                    VStack(alignment: .leading, spacing: 10) {
                        Button { editId = h["id"]?.stringValue } label: {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(h["action"]?.stringValue ?? "Untitled").fontWeight(.semibold).foregroundStyle(Theme.text)
                                if let ident = h["identity"]?.stringValue, !ident.isEmpty { Text(ident).font(.caption).foregroundStyle(Theme.textSecondary) }
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }
                        HStack {
                            statBlock("\(ScheduleLogic.habitStreak(h))", "Current")
                            statBlock("\(ScheduleLogic.habitLongestStreak(h))", "Longest")
                            statBlock("\(ScheduleLogic.habitRate(h, days: 30))%", "30-day")
                        }
                        HabitHeatmap(habit: h, weeks: 14)
                    }.themedCard()
                }
            }.padding()
        }
    }
    private func statBlock(_ v: String, _ l: String) -> some View {
        VStack(spacing: 2) { Text(v).font(Theme.display(20)); Text(l).font(.caption2).foregroundStyle(Theme.textTertiary) }.frame(maxWidth: .infinity)
    }

    private func newHabitFields() -> [String: JSONValue] {
        ["action": .string(""), "identity": .string(""), "cue": .string(""), "craving": .string(""), "reward": .string(""),
         "polarity": .string("build"), "cadence": .object(["type": .string("daily")]), "status": .string("active"), "completions": .array([])]
    }
}

/// GitHub-style completion grid: columns = weeks (Sun→Sat). Filled = done,
/// outline = due-but-missed, faint = not scheduled. Tap to toggle.
private struct HabitHeatmap: View {
    let habit: JSONValue
    let weeks: Int
    @EnvironmentObject var store: AppStore
    private let cal = Calendar.current

    var body: some View {
        let today = cal.startOfDay(for: Date())
        let todayDow = cal.component(.weekday, from: today) - 1
        let start = cal.date(byAdding: .day, value: -(todayDow + (weeks - 1) * 7), to: today)!
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 3) {
                ForEach(0..<weeks, id: \.self) { w in
                    VStack(spacing: 3) {
                        ForEach(0..<7, id: \.self) { d in
                            cell(cal.date(byAdding: .day, value: w * 7 + d, to: start)!, today: today)
                        }
                    }
                }
            }
        }
    }

    private func cell(_ date: Date, today: Date) -> some View {
        let ds = DateLogic.dateStr(date, cal)
        let future = date > today
        let due = ScheduleLogic.habitDueOn(habit, on: date, cal: cal)
        let done = ScheduleLogic.habitDoneOn(habit, ds)
        let fill: Color = done ? Theme.text : (future || !due ? Theme.surface : Theme.bg)
        return RoundedRectangle(cornerRadius: 2)
            .fill(fill)
            .overlay(RoundedRectangle(cornerRadius: 2).strokeBorder(done ? Color.clear : Theme.border))
            .frame(width: 13, height: 13)
            .opacity(future ? 0.35 : 1)
            .onTapGesture { if !future, let id = habit["id"]?.stringValue { store.toggleHabitCompletion(id: id, dateStr: ds) } }
    }
}

struct HabitEditor: View {
    let id: String
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var action = ""; @State private var identity = ""
    @State private var polarity = "build"; @State private var cadence = "daily"; @State private var days: Set<Int> = []
    @State private var cue = ""; @State private var craving = ""; @State private var reward = ""
    @State private var scheduleOn = false; @State private var scheduleStart = Date(); @State private var scheduleNotify = 0
    @State private var focusId = ""
    @State private var loaded = false
    private let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    private func patch(_ f: [String: JSONValue]) { store.patchItem("habits", "habits", id: id, f) }
    // Keep a linked schedule task in step when action/cadence change.
    private func resync() {
        guard let t = store.linkedHabitTask(id)?.objectValue else { return }
        store.syncHabitSchedule(habitId: id, sched: (t["startTime"]?.stringValue ?? "", t["endTime"]?.stringValue, Int(t["notifyBefore"]?.numberValue ?? 0)))
    }
    private func applySchedule() {
        guard scheduleOn else { return }
        store.syncHabitSchedule(habitId: id, sched: (TimeStr.toStr(scheduleStart), nil, scheduleNotify))
    }

    var body: some View {
        Form {
            Section { fieldLabel("Habit"); TextField("e.g. Read for 20 minutes", text: $action, axis: .vertical).lineLimit(1...5).onChange(of: action) { patch(["action": .string($0)]); resync() } }
            Section { fieldLabel("Identity (optional)"); TextField("e.g. I am a reader", text: $identity).onChange(of: identity) { patch(["identity": .string($0)]) } }

            Picker("I want to", selection: $polarity) { Text("Build it").tag("build"); Text("Break it").tag("break") }
                .pickerStyle(.segmented).onChange(of: polarity) { patch(["polarity": .string($0)]) }

            Picker("Repeat", selection: $cadence) { Text("Every day").tag("daily"); Text("Specific days").tag("specific") }
                .pickerStyle(.segmented).onChange(of: cadence) { v in
                    patch(["cadence": v == "specific" ? .object(["type": .string("specific"), "daysOfWeek": .array(days.sorted().map { .number(Double($0)) })]) : .object(["type": .string("daily")])])
                    resync()
                }
            if cadence == "specific" {
                HStack {
                    ForEach(0..<7, id: \.self) { d in
                        Button(weekdays[d]) {
                            if days.contains(d) { days.remove(d) } else { days.insert(d) }
                            patch(["cadence": .object(["type": .string("specific"), "daysOfWeek": .array(days.sorted().map { .number(Double($0)) })])])
                        }
                        .font(.caption2).frame(maxWidth: .infinity).padding(.vertical, 6)
                        .background(days.contains(d) ? Theme.text : Theme.surface)
                        .foregroundStyle(days.contains(d) ? Theme.bg : Theme.textSecondary)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                }.buttonStyle(.plain)
            }

            Section {
                Toggle("Schedule into Tasks", isOn: $scheduleOn).onChange(of: scheduleOn) { on in
                    if on { store.syncHabitSchedule(habitId: id, sched: (TimeStr.toStr(scheduleStart), nil, scheduleNotify)) }
                    else { store.syncHabitSchedule(habitId: id, sched: nil) }
                }
                if scheduleOn {
                    DatePicker("Time", selection: $scheduleStart, displayedComponents: .hourAndMinute).onChange(of: scheduleStart) { _ in applySchedule() }
                    Picker("Notify", selection: $scheduleNotify) {
                        ForEach([(0, "At start time"), (5, "5 min before"), (10, "10 min before"), (15, "15 min before"), (30, "30 min before")], id: \.0) { Text($0.1).tag($0.0) }
                    }.onChange(of: scheduleNotify) { _ in applySchedule() }
                }
            }

            Section {
                fieldLabel("Cue"); TextField("Make it obvious", text: $cue).onChange(of: cue) { patch(["cue": .string($0)]) }
                fieldLabel("Craving (optional)"); TextField("Make it attractive", text: $craving).onChange(of: craving) { patch(["craving": .string($0)]) }
                fieldLabel("Reward (optional)"); TextField("Make it satisfying", text: $reward).onChange(of: reward) { patch(["reward": .string($0)]) }
            }

            let areas = store.focusAreas()
            if !areas.isEmpty {
                Picker("Linked focus area", selection: $focusId) {
                    Text("None").tag("")
                    ForEach(areas, id: \.self) { a in Text(a["title"]?.stringValue ?? "Untitled").tag(a["id"]?.stringValue ?? "") }
                }.onChange(of: focusId) { store.linkFocus(habitId: id, focusId: $0) }
            }

            Button("Delete habit", role: .destructive) {
                store.syncHabitSchedule(habitId: id, sched: nil)
                store.linkFocus(habitId: id, focusId: "")
                store.deleteItem("habits", "habits", id: id); dismiss()
            }
        }
        .scrollContentBackground(.hidden).background(Theme.bg)
        .compactForm()
        .navigationTitle("Habit").inlineNavTitle()
        .onAppear(perform: load)
    }
    private func load() {
        guard !loaded, let h = store.findItem("habits", "habits", id: id) else { return }
        loaded = true
        action = h["action"]?.stringValue ?? ""; identity = h["identity"]?.stringValue ?? ""
        polarity = h["polarity"]?.stringValue == "break" ? "break" : "build"
        let c = h["cadence"]?.objectValue
        cadence = (c?["type"]?.stringValue == "specific") ? "specific" : "daily"
        days = Set((c?["daysOfWeek"]?.arrayValue ?? []).compactMap { $0.numberValue.map(Int.init) })
        cue = h["cue"]?.stringValue ?? ""; craving = h["craving"]?.stringValue ?? ""; reward = h["reward"]?.stringValue ?? ""
        if let t = store.linkedHabitTask(id)?.objectValue {
            scheduleOn = true
            scheduleStart = TimeStr.toDate(t["startTime"]?.stringValue ?? "")
            scheduleNotify = Int(t["notifyBefore"]?.numberValue ?? 0)
        }
        focusId = store.linkedFocusId(id)
    }
}

// MARK: Calendar (read-only month + agenda)

struct CalendarView: View {
    @EnvironmentObject var store: AppStore
    @State private var monthAnchor = Date()
    @State private var selected = DateLogic.todayStr()
    private let cal = Calendar.current
    private let monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

    private func eventDate(_ ev: JSONValue) -> String {
        guard let start = ev["start"]?.stringValue else { return "" }
        if ev["allDay"]?.boolValue == true { return String(start.prefix(10)) }
        return DateLogic.parseISO(start).map { DateLogic.dateStr($0, cal) } ?? ""
    }
    private var eventsByDate: [String: [JSONValue]] {
        var m: [String: [JSONValue]] = [:]
        for ev in store.items("calendar", "events") { let k = eventDate(ev); if !k.isEmpty { m[k, default: []].append(ev) } }
        return m
    }
    private var tasks: [JSONValue] { store.items("schedule", "scheduleItems") }

    var body: some View {
        let comps = cal.dateComponents([.year, .month], from: monthAnchor)
        let year = comps.year ?? 2026, month = comps.month ?? 1
        return ScrollView {
            VStack(spacing: 14) {
                HStack {
                    Button { monthAnchor = cal.date(byAdding: .month, value: -1, to: monthAnchor)! } label: { Image(systemName: "chevron.left") }
                    Spacer(); Text("\(monthNames[month - 1]) \(String(year))").font(.headline); Spacer()
                    Button { monthAnchor = cal.date(byAdding: .month, value: 1, to: monthAnchor)! } label: { Image(systemName: "chevron.right") }
                }
                monthGrid(year: year, month: month)
                agenda
            }.padding()
        }
        .background(Theme.bg)
        .navigationTitle("Calendar").inlineNavTitle()
    }

    private func monthGrid(year: Int, month: Int) -> some View {
        let byDate = eventsByDate
        let first = cal.date(from: DateComponents(year: year, month: month, day: 1))!
        let startDow = cal.component(.weekday, from: first) - 1
        let daysInMonth = cal.range(of: .day, in: .month, for: first)!.count
        let total = Int((Double(startDow + daysInMonth) / 7).rounded(.up)) * 7
        let gridStart = cal.date(byAdding: .day, value: -startDow, to: first)!
        let cols = Array(repeating: GridItem(.flexible(), spacing: 2), count: 7)
        return VStack(spacing: 6) {
            HStack { ForEach(["S", "M", "T", "W", "T", "F", "S"], id: \.self) { Text($0).font(.caption2).foregroundStyle(Theme.textTertiary).frame(maxWidth: .infinity) } }
            LazyVGrid(columns: cols, spacing: 4) {
                ForEach(0..<total, id: \.self) { i in
                    let date = cal.date(byAdding: .day, value: i, to: gridStart)!
                    let ds = DateLogic.dateStr(date, cal)
                    let inMonth = cal.component(.month, from: date) == month
                    let hasItems = (byDate[ds]?.isEmpty == false) || tasks.contains { ScheduleLogic.taskDueOn($0, on: date, cal: cal) }
                    Button { selected = ds } label: {
                        VStack(spacing: 2) {
                            Text("\(cal.component(.day, from: date))").font(.callout)
                                .foregroundStyle(inMonth ? Theme.text : Theme.textTertiary)
                            Circle().fill(hasItems ? Theme.text : .clear).frame(width: 5, height: 5)
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 4)
                        .background(RoundedRectangle(cornerRadius: 8).fill(ds == selected ? Theme.surface : .clear))
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(ds == DateLogic.todayStr() ? Theme.text : .clear, lineWidth: 1))
                    }.buttonStyle(.plain)
                }
            }
        }
    }

    private var agenda: some View {
        let byDate = eventsByDate
        // `selected` is a bare yyyy-MM-dd produced from the LOCAL grid, so rebuild
        // it as a local-midnight date. Going through parseISO (UTC midnight) would
        // shift both the label and weekday-based taskDueOn back a day in a
        // behind-UTC zone.
        let date = Self.localMidnight(selected, cal) ?? Date()
        let events = (byDate[selected] ?? []).sorted {
            let aa = $0["allDay"]?.boolValue ?? false, ba = $1["allDay"]?.boolValue ?? false
            if aa != ba { return aa }
            return ($0["start"]?.stringValue ?? "") < ($1["start"]?.stringValue ?? "")
        }
        let dayTasks = tasks.filter { ScheduleLogic.taskDueOn($0, on: date, cal: cal) }
            .sorted { ($0["startTime"]?.stringValue ?? "99:99") < ($1["startTime"]?.stringValue ?? "99:99") }
        let isToday = selected == DateLogic.todayStr()
        return VStack(alignment: .leading, spacing: 8) {
            Text(agendaLabel(date)).sectionHeaderStyle()
            if events.isEmpty && dayTasks.isEmpty {
                Text("Nothing on this day.").italic().foregroundStyle(Theme.textTertiary)
            } else {
                ForEach(events, id: \.self) { ev in
                    HStack {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(ev["summary"]?.stringValue ?? "(No title)").foregroundStyle(Theme.text)
                            if let loc = ev["location"]?.stringValue, !loc.isEmpty { Text(loc).font(.caption).foregroundStyle(Theme.textSecondary) }
                        }
                        Spacer()
                        Text(eventTime(ev)).font(.caption).foregroundStyle(Theme.textTertiary)
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { if let link = ev["htmlLink"]?.stringValue { openURL(link) } }
                    Divider()
                }
                ForEach(dayTasks, id: \.self) { t in
                    HStack(spacing: 12) {
                        Image(systemName: (isToday && ScheduleLogic.taskDoneToday(t)) ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(isToday ? Theme.text : Theme.textTertiary)
                            .onTapGesture { if isToday, let id = t["id"]?.stringValue { let d = ScheduleLogic.taskDoneToday(t); store.patchItem("schedule", "scheduleItems", id: id, ["lastCompletedDate": d ? .null : .string(DateLogic.todayStr())]) } }
                        VStack(alignment: .leading, spacing: 1) { Text(t["title"]?.stringValue ?? "Untitled").foregroundStyle(Theme.text); Text("Task").font(.caption).foregroundStyle(Theme.textTertiary) }
                        Spacer()
                        if let st = t["startTime"]?.stringValue, !st.isEmpty { Text(DateLogic.fmtTime(st)).font(.caption).foregroundStyle(Theme.textTertiary) }
                    }
                    Divider()
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Parse a bare `yyyy-MM-dd` into midnight in the given (local) calendar.
    private static func localMidnight(_ ymd: String, _ cal: Calendar) -> Date? {
        let p = ymd.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3 else { return nil }
        return cal.date(from: DateComponents(year: p[0], month: p[1], day: p[2]))
    }
    private func agendaLabel(_ d: Date) -> String { let f = DateFormatter(); f.dateFormat = "EEEE, MMMM d"; return f.string(from: d) }
    private func eventTime(_ ev: JSONValue) -> String {
        if ev["allDay"]?.boolValue == true { return "All day" }
        guard let d = DateLogic.parseISO(ev["start"]?.stringValue ?? "") else { return "" }
        let f = DateFormatter(); f.timeStyle = .short; return f.string(from: d)
    }
}
