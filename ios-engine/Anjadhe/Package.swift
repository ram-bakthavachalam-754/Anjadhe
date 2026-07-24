// swift-tools-version:5.9
import PackageDescription

// The Anjadhe native core — platform-agnostic Swift, no SwiftUI/UIKit, so it
// `swift test`s on the command line. Two libraries:
//   • AnjadheCore       — JSONValue + the on-device KV store (the sync seam that
//                         mirrors js/adapter/mobile-bridge.js + __anjadheStore).
//   • AnjadheSpecEngine — the spec contract port (js/core/app-spec.js), run
//                         against the SAME tests/spec/corpus.json. See
//                         docs/IOS_ENGINE.md and docs/MOBILE_NATIVE.md.
// SwiftUI views layer on top of these inside the Xcode app.
let package = Package(
    name: "Anjadhe",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "AnjadheCore", targets: ["AnjadheCore"]),
        .library(name: "AnjadheSpecEngine", targets: ["AnjadheSpecEngine"]),
        .library(name: "AnjadheUI", targets: ["AnjadheUI"]),
    ],
    targets: [
        .target(name: "AnjadheCore"),
        .target(name: "AnjadheSpecEngine", dependencies: ["AnjadheCore"]),
        // SwiftUI layer: the native spec renderer + built-in screens. Compiles on
        // macOS (so `swift build` type-checks it); runs in the iOS app. Bundles
        // the Nunito display font so titles/headings match the Mac exactly.
        .target(name: "AnjadheUI", dependencies: ["AnjadheCore", "AnjadheSpecEngine"],
                resources: [.process("Resources")]),
        .testTarget(name: "AnjadheCoreTests", dependencies: ["AnjadheCore"]),
        .testTarget(name: "AnjadheSpecEngineTests", dependencies: ["AnjadheSpecEngine", "AnjadheCore"]),
    ]
)
