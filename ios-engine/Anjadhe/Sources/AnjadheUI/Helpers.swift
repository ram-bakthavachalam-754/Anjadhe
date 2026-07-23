import SwiftUI
import AnjadheCore
#if canImport(UIKit)
import UIKit
#endif

/// Build a search/prompt URL for `query` using the Mac's configured search
/// engine (the `app_browse_settings` blob's `searchEngine` / `customSearchUrl`).
/// Mirrors browse-app.js `_SEARCH_ENGINES` + `_buildSearchUrl` so "Open in
/// browser" lands in the same engine the user picked on the Mac.
func configuredSearchURLString(_ query: String, _ store: AppStore) -> String? {
    let engines: [String: String] = [
        "duckduckgo": "https://duckduckgo.com/?q=%s",
        "google": "https://www.google.com/search?q=%s",
        "bing": "https://www.bing.com/search?q=%s",
        "startpage": "https://www.startpage.com/do/search?q=%s",
        "kagi": "https://kagi.com/search?q=%s",
        "brave": "https://search.brave.com/search?q=%s",
        "ecosia": "https://www.ecosia.org/search?q=%s",
    ]
    let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !q.isEmpty else { return nil }
    // Match JS encodeURIComponent (encode everything but these unreserved chars).
    let allowed = CharacterSet(charactersIn: "-_.!~*'()").union(.alphanumerics)
    let encoded = q.addingPercentEncoding(withAllowedCharacters: allowed) ?? q
    let settings = store.kv.get("app_browse_settings")?.objectValue
    let engine = settings?["searchEngine"]?.stringValue ?? "duckduckgo"
    var template = engines[engine] ?? engines["duckduckgo"]!
    if engine == "custom" {
        let custom = settings?["customSearchUrl"]?.stringValue ?? ""
        template = (custom.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil && custom.contains("%s"))
            ? custom : engines["duckduckgo"]!
    }
    return template.replacingOccurrences(of: "%s", with: encoded)
}

/// Copy text to the system pasteboard.
func copyToPasteboard(_ s: String) {
    #if canImport(UIKit)
    UIPasteboard.general.string = s
    #endif
}

/// Open a URL in the system browser (adds https:// if missing).
func openURL(_ s: String) {
    var u = s.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !u.isEmpty else { return }
    if !u.contains("://") { u = "https://" + u }
    #if canImport(UIKit)
    if let url = URL(string: u) { UIApplication.shared.open(url) }
    #endif
}

/// Strip HTML tags, collapse whitespace, truncate — for list previews.
func plainPreview(_ html: String, _ max: Int) -> String {
    let noTags = html.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
    let collapsed = noTags.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    return String(collapsed.prefix(max))
}

/// Render markdown into a `Text` (inline bold/italic/code/links; block syntax
/// is approximated — full parity with the Mac's formatter is a follow-up).
func markdownText(_ s: String) -> Text {
    if let attr = try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
        return Text(attr)
    }
    return Text(s)
}

/// HTML → plain text (for editing notes/journal as plain text). Rich-formatting
/// editing with a toolbar is a follow-up; this preserves content round-tripping
/// with the Mac's simple <p> format.
func htmlToText(_ html: String) -> String {
    var s = html.replacingOccurrences(of: "<br\\s*/?>", with: "\n", options: .regularExpression)
    s = s.replacingOccurrences(of: "</p>", with: "\n\n")
    s = s.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
    for (k, v) in ["&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&nbsp;": " "] {
        s = s.replacingOccurrences(of: k, with: v)
    }
    return s.trimmingCharacters(in: .whitespacesAndNewlines)
}

/// Plain text → simple HTML paragraphs (matches the Mac's textToHtml).
func textToHtml(_ text: String) -> String {
    text.components(separatedBy: "\n\n").map { p -> String in
        let esc = p.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\n", with: "<br>")
        return "<p>\(esc)</p>"
    }.joined()
}

// Cross-platform shims so AnjadheUI compiles on macOS (for `swift build`) while
// using iOS-only modifiers on device.
extension View {
    @ViewBuilder func inlineNavTitle() -> some View {
        #if os(iOS)
        self.navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }
    /// Hide the navigation bar for this view (the Today root uses its greeting as
    /// the title, so an empty bar would just add chrome). Pushed editors show
    /// their own bar normally.
    @ViewBuilder func hiddenNavBar() -> some View {
        #if os(iOS)
        self.toolbar(.hidden, for: .navigationBar)
        #else
        self
        #endif
    }
    /// Tighten a Form/List's inter-section spacing — the default leaves a lot of
    /// empty space between fields on the detail pages. Compact on iOS 17+, with
    /// a smaller min row height everywhere so rows aren't tall either.
    @ViewBuilder func compactForm() -> some View {
        #if os(iOS)
        if #available(iOS 17.0, *) {
            self.listSectionSpacing(.compact).environment(\.defaultMinListRowHeight, 30)
        } else {
            self.environment(\.defaultMinListRowHeight, 30)
        }
        #else
        self
        #endif
    }
    @ViewBuilder func urlKeyboard() -> some View {
        #if os(iOS)
        self.textInputAutocapitalization(.never).keyboardType(.URL)
        #else
        self
        #endif
    }
    @ViewBuilder func groupedListStyle() -> some View {
        #if os(iOS)
        self.listStyle(.insetGrouped)
        #else
        self.listStyle(.plain)
        #endif
    }
}
