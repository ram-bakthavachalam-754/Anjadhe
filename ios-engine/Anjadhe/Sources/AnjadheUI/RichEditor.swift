import SwiftUI
#if canImport(WebKit) && os(iOS)
import WebKit

/// A rich-text editor that edits the same HTML the Mac's RichEditor produces —
/// a focused `contenteditable` surface with a small formatting toolbar, themed
/// to match (light/dark via prefers-color-scheme). Using contenteditable (not a
/// native attributed→HTML serializer) guarantees the stored HTML round-trips
/// with the desktop, so synced notes/journal entries never get mangled.
struct RichEditorView: UIViewRepresentable {
    @Binding var html: String
    var placeholder: String = "Write…"

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(context.coordinator, name: "rich")
        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.navigationDelegate = context.coordinator
        wv.scrollView.keyboardDismissMode = .interactive
        wv.isOpaque = false
        wv.backgroundColor = .clear
        // A real https base URL (not nil) gives the page a normal secure origin
        // so the Google web fonts load (opaque origins can block web-font CORS).
        wv.loadHTMLString(Self.page(placeholder), baseURL: URL(string: "https://anjadhe.app/"))
        context.coordinator.webView = wv
        return wv
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        // Don't re-inject on every render — that would reset the caret. Initial
        // content is set once on load; the binding flows JS → Swift afterward.
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        let parent: RichEditorView
        weak var webView: WKWebView?
        init(_ p: RichEditorView) { parent = p }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            webView.evaluateJavaScript("setContent(\(Self.jsString(parent.html)))")
        }
        func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
            if let s = message.body as? String { DispatchQueue.main.async { self.parent.html = s } }
        }
        static func jsString(_ s: String) -> String {
            (try? JSONEncoder().encode(s)).flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
        }
    }

    static func page(_ ph: String) -> String {
        let placeholder = ph.replacingOccurrences(of: "\"", with: "&quot;")
        return """
        <!doctype html><html><head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
        <!-- Same web fonts the Mac editor uses (index.html) so note/journal text
             matches: Inter for body, Nunito for headings. -->
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
        <style>
          :root { --bg:#fff; --text:#111; --sec:#222; --ter:#444; --border:#e4e4e4; --surface:#f8f8f8;
            --serif:'Nunito', -apple-system, BlinkMacSystemFont, sans-serif;
            --sans:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
          @media (prefers-color-scheme: dark) { :root { --bg:#161616; --text:#eee; --sec:#b8b8b8; --ter:#808080; --border:#2e2e2e; --surface:#1e1e1e; } }
          html,body { margin:0; height:100%; background:var(--bg); color:var(--text);
            font-family:var(--sans); font-feature-settings:'cv11','ss01','ss03'; -webkit-text-size-adjust:100%; }
          #tb { position:sticky; top:0; z-index:2; display:flex; gap:6px; padding:8px 12px;
            background:var(--bg); border-bottom:1px solid var(--border); }
          #tb button { font-size:15px; min-width:34px; height:30px; border:1px solid var(--border);
            background:var(--surface); color:var(--text); border-radius:6px; }
          #ed { padding:14px; min-height:60vh; outline:none; font-family:var(--sans); font-size:16px; line-height:1.75; }
          #ed:empty:before { content:attr(data-ph); color:var(--ter); }
          #ed h1,#ed h2,#ed h3 { font-family:var(--serif); font-weight:700; line-height:1.3; }
          #ed blockquote { border-left:3px solid var(--border); margin:0; padding-left:12px; color:var(--sec); }
          #ed a { color:var(--text); }
        </style></head><body>
        <div id="tb">
          <button onmousedown="event.preventDefault()" onclick="cmd('bold')"><b>B</b></button>
          <button onmousedown="event.preventDefault()" onclick="cmd('italic')"><i>I</i></button>
          <button onmousedown="event.preventDefault()" onclick="blk('H2')">H</button>
          <button onmousedown="event.preventDefault()" onclick="cmd('insertUnorderedList')">&bull;</button>
          <button onmousedown="event.preventDefault()" onclick="blk('BLOCKQUOTE')">&ldquo;</button>
        </div>
        <div id="ed" contenteditable="true" data-ph="\(placeholder)"></div>
        <script>
          var ed=document.getElementById('ed');
          function post(){try{webkit.messageHandlers.rich.postMessage(ed.innerHTML);}catch(e){}}
          function cmd(c){document.execCommand(c,false,null);post();}
          function blk(t){var cur=document.queryCommandValue('formatBlock');
            document.execCommand('formatBlock',false,(cur&&cur.toUpperCase()===t)?'P':t);post();}
          ed.addEventListener('input',post);
          window.setContent=function(h){ed.innerHTML=h||'';};
        </script></body></html>
        """
    }
}
#else
/// macOS / non-WebKit fallback so the package compiles (the app runs on iOS).
struct RichEditorView: View {
    @Binding var html: String
    var placeholder: String = "Write…"
    var body: some View { TextEditor(text: $html) }
}
#endif
