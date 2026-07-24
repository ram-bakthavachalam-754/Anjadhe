import SwiftUI

/// An animated splash that continues from the *static* iOS launch screen (which
/// can't animate) and adds motion — a gently breathing logo plus a loading
/// spinner — then fades into the app. White background + centered logo so it
/// hands off seamlessly from the launch storyboard.
struct SplashView: View {
    var onFinished: () -> Void
    @State private var breathe = false
    @State private var spinnerIn = false

    var body: some View {
        ZStack {
            Color.white.ignoresSafeArea()
            VStack(spacing: 30) {
                logo
                    .frame(width: 132, height: 132)
                    .scaleEffect(breathe ? 1.0 : 0.9)
                    .opacity(breathe ? 1.0 : 0.78)
                ProgressView()
                    .progressViewStyle(.circular)
                    .tint(Color(white: 0.55))
                    .opacity(spinnerIn ? 1 : 0)
            }
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 0.85).repeatForever(autoreverses: true)) { breathe = true }
            withAnimation(.easeIn(duration: 0.4).delay(0.25)) { spinnerIn = true }
            // Give the breathing animation time to read, then reveal the app.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.25) { onFinished() }
        }
    }

    @ViewBuilder private var logo: some View {
        #if canImport(UIKit)
        if let url = Bundle.module.url(forResource: "launch-logo", withExtension: "png"),
           let ui = UIImage(contentsOfFile: url.path) {
            Image(uiImage: ui).resizable().scaledToFit()
        } else {
            Image(systemName: "circle.dashed").resizable().scaledToFit().foregroundStyle(.black)
        }
        #else
        Image(systemName: "circle.dashed").resizable().scaledToFit().foregroundStyle(.black)
        #endif
    }
}
