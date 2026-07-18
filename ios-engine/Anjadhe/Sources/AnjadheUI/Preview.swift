import SwiftUI
import AnjadheCore

/// The native app root. Builds a disk-backed store that hydrates persisted data
/// + pairing at launch and persists every write (so nothing is lost on relaunch
/// or redeploy), starts the hidden JS sync host, and shows the native shell.
/// AppDelegate installs this as the root unless `ANJADHE_WEBVIEW=1` selects the
/// Capacitor WebView instead.
public struct SpecPreviewRoot: View {
    @StateObject private var store: AppStore
    @StateObject private var sync: SyncCoordinator

    public init() {
        // Register the bundled Nunito display font + apply it to nav-bar titles
        // before the first render so titles match the Mac immediately.
        #if canImport(UIKit)
        Theme.applyNavBarAppearance()
        #endif
        let appStore = AppStore.persistent()
        _store = StateObject(wrappedValue: appStore)
        _sync = StateObject(wrappedValue: SyncCoordinator(store: appStore))
    }

    @Environment(\.scenePhase) private var scenePhase
    @State private var showSplash = true

    public var body: some View {
        ZStack {
            // The shell mounts immediately and loads (sync host, disk hydrate)
            // underneath the splash, so when the splash fades the app is ready.
            shell.tint(Theme.text)
                .onChange(of: scenePhase) { phase in if phase != .active { store.flush() } }
            if showSplash {
                SplashView { withAnimation(.easeOut(duration: 0.4)) { showSplash = false } }
                    .transition(.opacity)
                    .zIndex(1)
            }
        }
    }

    private var shell: some View {
        // Real synced spec apps will populate the Apps tab once that's wired.
        NativeShell(store: store, sync: sync, specApps: [])
            .onAppear {
                // Start the hidden JS sync host against the bundled web assets.
                if let www = Bundle.main.url(forResource: "public", withExtension: nil) { sync.start(baseURL: www) }
            }
    }
}
