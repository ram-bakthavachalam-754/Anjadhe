import SwiftUI

/// A lightweight Markdown *block* renderer for read-only content (the prompt
/// feed detail, etc.). SwiftUI's `AttributedString(markdown:)` only does inline
/// styling — LLM output is full of headings, lists, code blocks, quotes and
/// tables, so we scan the text into blocks and render each, mirroring the Mac's
/// `AgentUI.formatContent`. Inline styling within each block still uses the
/// system markdown attributed string.
struct MarkdownView: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(Self.parse(text).enumerated()), id: \.offset) { idx, b in
                blockView(b, first: idx == 0)
            }
        }
    }

    // MARK: rendering

    @ViewBuilder private func blockView(_ b: Block, first: Bool) -> some View {
        switch b {
        case .heading(let lvl, let s):
            // Extra breathing room above headings to separate sections (the Mac
            // uses a generous top margin) — except the very first block.
            inline(s).font(Theme.display(lvl == 1 ? 22 : lvl == 2 ? 19 : 17)).foregroundStyle(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, first ? 0 : 10)
        case .paragraph(let s):
            inline(s).foregroundStyle(Theme.text).lineSpacing(5).fixedSize(horizontal: false, vertical: true)
        case .bullets(let items):
            VStack(alignment: .leading, spacing: 7) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, it in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text("•").foregroundStyle(Theme.textSecondary)
                        inline(it).foregroundStyle(Theme.text).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                }
            }
        case .ordered(let items):
            VStack(alignment: .leading, spacing: 7) {
                ForEach(Array(items.enumerated()), id: \.offset) { i, it in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text("\(i + 1).").foregroundStyle(Theme.textSecondary).monospacedDigit()
                        inline(it).foregroundStyle(Theme.text).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                }
            }
        case .quote(let lines):
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 1).fill(Theme.border).frame(width: 3)
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, l in
                        inline(l).foregroundStyle(Theme.textSecondary).lineSpacing(5).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        case .code(let s):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(s).font(.system(.footnote, design: .monospaced)).foregroundStyle(Theme.text)
                    .padding(10).frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(RoundedRectangle(cornerRadius: Theme.radiusSm).fill(Theme.surface))
            .overlay(RoundedRectangle(cornerRadius: Theme.radiusSm).strokeBorder(Theme.border))
        case .table(let rows):
            tableView(rows)
        case .rule:
            Divider()
        }
    }

    @ViewBuilder private func tableView(_ rows: [[String]]) -> some View {
        let cols = rows.map { $0.count }.max() ?? 0
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.offset) { ri, row in
                    HStack(spacing: 0) {
                        ForEach(0..<cols, id: \.self) { ci in
                            inline(ci < row.count ? row[ci] : "")
                                .font(.caption).fontWeight(ri == 0 ? .semibold : .regular)
                                .foregroundStyle(Theme.text)
                                .frame(minWidth: 80, alignment: .leading)
                                .padding(.horizontal, 8).padding(.vertical, 6)
                                .overlay(Rectangle().strokeBorder(Theme.border, lineWidth: 0.5))
                        }
                    }
                }
            }
            .overlay(Rectangle().strokeBorder(Theme.border))
        }
    }

    private func inline(_ s: String) -> Text {
        let t = s.trimmingCharacters(in: .whitespaces)
        if let a = try? AttributedString(markdown: t, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            return Text(a)
        }
        return Text(t)
    }

    // MARK: parsing

    enum Block {
        case heading(Int, String), paragraph(String), bullets([String]), ordered([String])
        case quote([String]), code(String), table([[String]]), rule
    }

    private static func isRule(_ t: String) -> Bool {
        t.range(of: "^([-*_])( ?\\1){2,}$", options: .regularExpression) != nil
    }
    private static func isUL(_ t: String) -> Bool { t.range(of: "^[-*+]\\s+", options: .regularExpression) != nil }
    private static func isOL(_ t: String) -> Bool { t.range(of: "^\\d+[.)]\\s+", options: .regularExpression) != nil }

    static func parse(_ text: String) -> [Block] {
        var blocks: [Block] = []
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var i = 0
        func body(_ l: String, _ pat: String) -> String {
            guard let r = l.range(of: pat, options: .regularExpression) else { return l }
            return String(l[r.upperBound...])
        }
        while i < lines.count {
            let line = lines[i].trimmingCharacters(in: .whitespaces)
            if line.isEmpty { i += 1; continue }

            if line.hasPrefix("```") {
                var code: [String] = []; i += 1
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") { code.append(lines[i]); i += 1 }
                if i < lines.count { i += 1 }
                blocks.append(.code(code.joined(separator: "\n"))); continue
            }
            if Self.isRule(line) { blocks.append(.rule); i += 1; continue }
            if let m = line.range(of: "^#{1,6}\\s+", options: .regularExpression) {
                let hashes = line[line.startIndex..<m.upperBound].filter { $0 == "#" }.count
                blocks.append(.heading(min(hashes, 3), String(line[m.upperBound...]))); i += 1; continue
            }
            // table: header row of pipes followed by a |---|---| separator
            if line.contains("|"), i + 1 < lines.count,
               lines[i + 1].trimmingCharacters(in: .whitespaces).range(of: "^\\|?\\s*:?-+:?\\s*(\\|\\s*:?-+:?\\s*)+\\|?$", options: .regularExpression) != nil {
                func cells(_ l: String) -> [String] {
                    var t = l.trimmingCharacters(in: .whitespaces)
                    if t.hasPrefix("|") { t.removeFirst() }
                    if t.hasSuffix("|") { t.removeLast() }
                    return t.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
                }
                var rows = [cells(line)]; i += 2
                while i < lines.count {
                    let l = lines[i].trimmingCharacters(in: .whitespaces)
                    if l.isEmpty || !l.contains("|") { break }
                    rows.append(cells(l)); i += 1
                }
                blocks.append(.table(rows)); continue
            }
            if Self.isUL(line) {
                var items: [String] = []
                while i < lines.count, Self.isUL(lines[i].trimmingCharacters(in: .whitespaces)) {
                    items.append(body(lines[i].trimmingCharacters(in: .whitespaces), "^[-*+]\\s+")); i += 1
                }
                blocks.append(.bullets(items)); continue
            }
            if Self.isOL(line) {
                var items: [String] = []
                while i < lines.count, Self.isOL(lines[i].trimmingCharacters(in: .whitespaces)) {
                    items.append(body(lines[i].trimmingCharacters(in: .whitespaces), "^\\d+[.)]\\s+")); i += 1
                }
                blocks.append(.ordered(items)); continue
            }
            if line.hasPrefix(">") {
                var qs: [String] = []
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                    qs.append(body(lines[i].trimmingCharacters(in: .whitespaces), "^>\\s?")); i += 1
                }
                blocks.append(.quote(qs)); continue
            }
            // paragraph — gather consecutive plain lines (soft-wrapped into one)
            var para: [String] = []
            while i < lines.count {
                let l = lines[i].trimmingCharacters(in: .whitespaces)
                if l.isEmpty || l.hasPrefix("```") || l.hasPrefix("#") || l.hasPrefix(">")
                    || Self.isUL(l) || Self.isOL(l) || Self.isRule(l) { break }
                para.append(l); i += 1
            }
            if !para.isEmpty { blocks.append(.paragraph(para.joined(separator: " "))) }
        }
        return blocks
    }
}
