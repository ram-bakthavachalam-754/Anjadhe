import Foundation
import Combine
import AnjadheCore
#if canImport(WebKit)
import WebKit
#endif
#if canImport(UIKit)
import UIKit
#endif

/// Stage-1 sync bridge (docs/MOBILE_NATIVE.md). Hosts the proven JS channel +
/// delta-sync + pairing stack in a hidden WKWebView, but backs its storage with
/// the native `KVStore` via `native-bridge.js`:
///   • on load, the native store snapshot is hydrated into the JS mirror;
///   • the JS `__anjadheStore` forwards every write here as a `persist` message,
///     which we apply to `KVStore` (and bump the UI);
///   • native UI writes are forwarded INTO the JS mirror (`applyLocalWrite`) so
///     the channel uploads them — without re-posting back (loop-free).
///
/// The bridge mechanics are unit-tested (native-bridge-test.js); the live
/// channel needs a paired Mac + relay and is verified on-device. Pairing (a QR
/// flow) is a follow-up.
public final class SyncCoordinator: NSObject, ObservableObject {
    /// Mirrors AnjadheSync states: offline / connecting / syncing / idle / error.
    @Published public private(set) var state: String = "offline"
    @Published public private(set) var paired: Bool = false
    @Published public private(set) var lastPairError: String?

    private let store: AppStore
    #if canImport(WebKit)
    private var webView: WKWebView?
    #endif

    public init(store: AppStore) {
        self.store = store
        super.init()
    }

    /// Start the hidden sync host. `baseURL` points at the bundled web assets
    /// directory (the app's `www/`) so the script `src`s resolve; the default
    /// host HTML loads native-bridge.js + the channel bundle + pairing + sync.
    public func start(baseURL: URL, html: String? = nil) {
        // Route native user writes into the JS mirror so the channel uploads
        // them (remote-applied writes don't fire these, so no loop).
        store.kv.onLocalWrite = { [weak self] key, value in self?.pushLocal(key, value) }
        store.kv.onLocalDelete = { [weak self] key in self?.pushLocalDelete(key) }
        #if canImport(WebKit)
        let cfg = WKWebViewConfiguration()
        let ucc = WKUserContentController()
        ucc.add(self, name: "anjadhe")
        cfg.userContentController = ucc
        let wv = WKWebView(frame: CGRect(x: 0, y: 0, width: 1, height: 1), configuration: cfg)
        wv.navigationDelegate = self
        self.webView = wv
        #if os(iOS)
        // A WKWebView that isn't in the view hierarchy gets its JS timers and
        // network deprioritized/suspended by iOS — which silently stalls the
        // sync channel (pairing's local crypto still works, but the relay
        // connection never runs). Attach it to the window, effectively invisible
        // but live, so sync actually happens.
        attachToWindow(wv)
        #endif
        wv.loadHTMLString(html ?? Self.defaultHostHTML, baseURL: baseURL)
        #endif
    }

    #if canImport(WebKit) && os(iOS)
    private func attachToWindow(_ wv: WKWebView, attempt: Int = 0) {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap { $0.windows }.first { $0.isKeyWindow } ?? scenes.first?.windows.first
        guard let window = window else {
            if attempt < 12 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.attachToWindow(wv, attempt: attempt + 1) } }
            return
        }
        wv.alpha = 0.01                       // >0 so iOS keeps it running, but invisible
        wv.isUserInteractionEnabled = false
        window.addSubview(wv)
        window.sendSubviewToBack(wv)
    }
    #endif

    /// Pair with the Mac using a scanned/pasted offer string (the JSON the Mac's
    /// pairing QR encodes). Runs the channel handshake in the JS host and reports
    /// back via `paired`/`lastPairError`.
    public func pair(offerText: String) {
        let js = "window.AnjadhePairing && AnjadhePairing.pairWithOffer(\(Self.jsString(offerText)))"
            + ".then(function(r){ try{ window.webkit.messageHandlers.anjadhe.postMessage({type:'pairResult', ok:!!r.ok, error:r.error||''}); }catch(e){} });"
        eval(js)
    }

    /// Forward a native UI write into the JS mirror so the channel uploads it.
    public func pushLocal(_ key: String, _ value: JSONValue) {
        guard let json = Self.jsonString(value) else { return }
        eval("window.__anjadheBridge && __anjadheBridge.applyLocalWrite(\(Self.jsString(key)), \(json), \(Self.jsString(KVStore.nowISO())));")
    }

    public func pushLocalDelete(_ key: String) {
        eval("window.__anjadheBridge && __anjadheBridge.applyLocalDelete(\(Self.jsString(key)), \(Self.jsString(KVStore.nowISO())));")
    }

    public func triggerSync() {
        eval("window.AnjadheSync && AnjadheSync.sync();")
    }

    // MARK: internals

    private func eval(_ js: String) {
        #if canImport(WebKit)
        webView?.evaluateJavaScript(js, completionHandler: nil)
        #endif
    }

    /// Hydrate the JS mirror with the full native store snapshot.
    fileprivate func hydrate() {
        var rows: [String: WireRow] = [:]
        for (k, e) in store.kv.snapshot() { rows[k] = WireRow(entry: e) }
        print("[sync] hydrate JS mirror from native snapshot — \(rows.count) keys (\(store.kv.liveKeys.count) live)")
        guard let data = try? JSONEncoder().encode(rows), let json = String(data: data, encoding: .utf8) else { return }
        eval("window.__anjadheBridge && __anjadheBridge.hydrate(\(json));")
        // Re-derive the paired flag from the now-hydrated pairing record so the
        // Sync tab shows the truth on launch (it was resetting to "No" every
        // relaunch even while the pairing persisted and sync worked).
        eval("try { window.webkit.messageHandlers.anjadhe.postMessage({ type:'pairedStatus', ok: !!(window.AnjadhePairing && AnjadhePairing.isPaired()) }); } catch(e){}")
        eval("window.AnjadheSync && AnjadheSync.sync();")
    }

    private static func jsString(_ s: String) -> String {
        (try? JSONEncoder().encode(s)).flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
    }
    private static func jsonString(_ v: JSONValue) -> String? {
        (try? JSONEncoder().encode(v)).flatMap { String(data: $0, encoding: .utf8) }
    }

    static let defaultHostHTML = """
    <!doctype html><html><head><meta charset="utf-8"></head><body>
    <script>
      // Forward the sync stack's console output to native (Xcode console) so an
      // on-device sync can be debugged. Must run BEFORE the other scripts.
      (function () {
        ['log', 'warn', 'error'].forEach(function (lvl) {
          var orig = console[lvl];
          console[lvl] = function () {
            try { window.webkit.messageHandlers.anjadhe.postMessage({ type: 'log', level: lvl, text: Array.prototype.map.call(arguments, String).join(' ') }); } catch (e) {}
            try { orig.apply(console, arguments); } catch (e) {}
          };
        });
        window.onerror = function (m, s, l) { try { window.webkit.messageHandlers.anjadhe.postMessage({ type: 'log', level: 'error', text: 'window.onerror: ' + m + ' @' + l }); } catch (e) {} };
      })();
    </script>
    <script src="js/adapter/native-bridge.js"></script>
    <script src="js/channel/channel.bundle.js"></script>
    <script src="js/adapter/mobile-pairing.js"></script>
    <script src="js/adapter/mobile-sync.js"></script>
    <script>
      // Forward AnjadheSync state changes to native so the UI can show them.
      (function hook() {
        if (window.AnjadheSync && window.AnjadheSync.onStateChange) {
          window.AnjadheSync.onStateChange(function (s) {
            try { window.webkit.messageHandlers.anjadhe.postMessage({ type: 'syncState', state: s }); } catch (e) {}
          });
        } else { setTimeout(hook, 200); }
      })();
    </script>
    </body></html>
    """

    // Wire shapes for (de)serializing across the bridge.
    struct WireRow: Encodable {
        let entry: RemoteEntry
        enum CodingKeys: String, CodingKey { case value, deleted, modifiedAt }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(entry.modifiedAt, forKey: .modifiedAt)
            if entry.deleted { try c.encode(true, forKey: .deleted) }
            else { try c.encode(entry.value ?? .null, forKey: .value) }
        }
    }
    struct BridgeMessage: Decodable {
        let type: String
        let key: String?
        let entry: WireEntry?
        let state: String?
        let ok: Bool?
        let error: String?
        let level: String?
        let text: String?
    }
    struct WireEntry: Decodable {
        let value: JSONValue?
        let deleted: Bool?
        let modifiedAt: String
    }
}

#if canImport(WebKit)
extension SyncCoordinator: WKScriptMessageHandler {
    public func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let data = try? JSONSerialization.data(withJSONObject: message.body) else {
            print("[sync] DROPPED bridge message — not JSON-serializable")
            return
        }
        guard let msg = try? JSONDecoder().decode(BridgeMessage.self, from: data) else {
            // A persist whose value failed to decode would be silently lost —
            // that would explain data syncing at the protocol level but never
            // reaching the native store/screens. Log it.
            let preview = String(data: data, encoding: .utf8)?.prefix(160) ?? ""
            print("[sync] DROPPED undecodable bridge message: \(preview)")
            return
        }
        switch msg.type {
        case "persist":
            guard let key = msg.key, let entry = msg.entry else { print("[sync] persist missing key/entry"); return }
            if entry.deleted == true {
                store.kv.applyRemoteDelete(key, modifiedAt: entry.modifiedAt)
            } else {
                store.kv.applyRemote(key, value: entry.value ?? .null, modifiedAt: entry.modifiedAt)
            }
            // The channel identity/pairing MUST survive even an immediate quit
            // right after pairing — flush it to disk synchronously instead of
            // waiting on the debounce, or pairing is lost on the next launch.
            if key.hasPrefix("anjadhe:channel:") { print("[sync] channel key persisted (flushed): \(key)"); store.flush() }
            DispatchQueue.main.async { self.store.bump() }
        case "log":
            print("[sync] \(msg.level ?? "log"): \(msg.text ?? "")")
        case "pairedStatus":
            let ok = msg.ok ?? false
            print("[sync] paired status on launch: \(ok)")
            DispatchQueue.main.async { self.paired = ok }
        case "syncState":
            if let s = msg.state { DispatchQueue.main.async { self.state = s } }
            print("[sync] state → \(msg.state ?? "?")")
        case "pairResult":
            DispatchQueue.main.async {
                self.paired = msg.ok ?? false
                self.lastPairError = (msg.ok == true) ? nil : (msg.error ?? "Pairing failed")
            }
            if msg.ok == true { triggerSync() }
        default:
            break
        }
    }
}

extension SyncCoordinator: WKNavigationDelegate {
    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        hydrate()
    }
}
#endif
