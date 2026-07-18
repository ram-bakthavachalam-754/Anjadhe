import SwiftUI
#if canImport(CoreText)
import CoreText
#endif

// Native port of the Mac "Minimal Book Theme" (CLAUDE.md / css/core.css):
// monochrome black-and-white, thin borders, the bundled Nunito display font
// (matching the Mac's --font-serif exactly), and the system body font
// (--font-sans). All colors adapt to light/dark exactly like the CSS variables.

extension Color {
    init(rgb: UInt) {
        self.init(.sRGB,
                  red: Double((rgb >> 16) & 0xFF) / 255,
                  green: Double((rgb >> 8) & 0xFF) / 255,
                  blue: Double(rgb & 0xFF) / 255)
    }
    /// "#RRGGBB" → Color (for user-chosen accent colors like focus areas).
    init(hexString: String) {
        let hex = hexString.trimmingCharacters(in: CharacterSet(charactersIn: " #"))
        self.init(rgb: UInt(UInt64(hex, radix: 16) ?? 0x78909C))
    }
}

#if canImport(UIKit)
import UIKit
private func dyn(_ light: UInt, _ dark: UInt) -> Color {
    Color(UIColor { trait in
        let v = trait.userInterfaceStyle == .dark ? dark : light
        return UIColor(red: CGFloat((v >> 16) & 0xFF) / 255,
                       green: CGFloat((v >> 8) & 0xFF) / 255,
                       blue: CGFloat(v & 0xFF) / 255, alpha: 1)
    })
}
#else
private func dyn(_ light: UInt, _ dark: UInt) -> Color { Color(rgb: light) }
#endif

public enum Theme {
    // Colors — (light, dark), matching css/core.css :root + [data-theme="dark"].
    public static let bg = dyn(0xFFFFFF, 0x161616)
    public static let text = dyn(0x111111, 0xEEEEEE)
    public static let textSecondary = dyn(0x222222, 0xB8B8B8)
    public static let textTertiary = dyn(0x444444, 0x808080)
    public static let border = dyn(0xE4E4E4, 0x2E2E2E)
    public static let borderLight = dyn(0xF0F0F0, 0x222222)
    public static let surface = dyn(0xF8F8F8, 0x1E1E1E)
    public static let surfaceHover = dyn(0xF2F2F2, 0x272727)
    public static let borderHover = dyn(0xC0C0C0, 0x555555)

    // Semantic (only ones allowed by the theme).
    public static let success = Color(rgb: 0x16A34A)
    public static let warning = Color(rgb: 0xD97706)
    public static let danger = Color(rgb: 0xDC2626)

    // Spacing (rem→pt at 16pt base) and radius (css px).
    public static let xs: CGFloat = 4, sm: CGFloat = 8, md: CGFloat = 16, lg: CGFloat = 24, xl: CGFloat = 32
    public static let radiusSm: CGFloat = 8, radiusMd: CGFloat = 12, radiusLg: CGFloat = 16

    /// Display type — the bundled Nunito (the Mac's `--font-serif`). Falls back
    /// to the rounded system design if Nunito isn't registered.
    public static func display(_ size: CGFloat, _ weight: Font.Weight = .bold) -> Font {
        registerFontsIfNeeded()
        #if canImport(UIKit)
        if fontsRegistered, let f = nunitoUIFont(size, uiWeight(weight)) { return Font(f) }
        #endif
        return .system(size: size, weight: weight, design: .rounded)
    }

    #if canImport(UIKit)
    /// A Nunito `UIFont` at the requested size/weight (via the variable weight
    /// axis). Used by `display()` and the nav-bar appearance.
    static func nunitoUIFont(_ size: CGFloat, _ weight: UIFont.Weight) -> UIFont? {
        registerFontsIfNeeded()
        guard fontsRegistered, let base = UIFont(name: "Nunito", size: size) else { return nil }
        let desc = base.fontDescriptor.addingAttributes([
            .traits: [UIFontDescriptor.TraitKey.weight: weight]
        ])
        return UIFont(descriptor: desc, size: size)
    }

    /// Make UIKit nav-bar titles (which SwiftUI's `.navigationTitle` renders)
    /// use Nunito too — otherwise the most prominent text on every screen stays
    /// system font while the rest of the display type is Nunito. Keeps the
    /// default background/blur; only swaps the title font. Call once at launch.
    public static func applyNavBarAppearance() {
        guard let large = nunitoUIFont(34, .bold), let inline = nunitoUIFont(17, .semibold) else { return }
        let std = UINavigationBarAppearance(); std.configureWithDefaultBackground()
        std.largeTitleTextAttributes[.font] = large
        std.titleTextAttributes[.font] = inline
        let edge = UINavigationBarAppearance(); edge.configureWithTransparentBackground()
        edge.largeTitleTextAttributes[.font] = large
        edge.titleTextAttributes[.font] = inline
        let proxy = UINavigationBar.appearance()
        proxy.standardAppearance = std
        proxy.compactAppearance = std
        proxy.scrollEdgeAppearance = edge
    }
    #endif

    // MARK: Font registration (bundled Nunito)

    private static var fontsRegistered = false
    private static var triedRegister = false

    public static func registerFontsIfNeeded() {
        guard !triedRegister else { return }
        triedRegister = true
        #if canImport(CoreText)
        guard let url = Bundle.module.url(forResource: "Nunito-Variable", withExtension: "ttf", subdirectory: "Fonts")
            ?? Bundle.module.url(forResource: "Nunito-Variable", withExtension: "ttf") else { return }
        var err: Unmanaged<CFError>?
        let ok = CTFontManagerRegisterFontsForURL(url as CFURL, .process, &err)
        #if canImport(UIKit)
        // Already-registered (re-launch) counts as available too.
        fontsRegistered = ok || (UIFont(name: "Nunito", size: 12) != nil)
        #else
        fontsRegistered = ok
        #endif
        #endif
    }

    #if canImport(UIKit)
    private static func uiWeight(_ w: Font.Weight) -> UIFont.Weight {
        switch w {
        case .ultraLight: return .ultraLight
        case .thin: return .thin
        case .light: return .light
        case .regular: return .regular
        case .medium: return .medium
        case .semibold: return .semibold
        case .bold: return .bold
        case .heavy: return .heavy
        case .black: return .black
        default: return .regular
        }
    }
    #endif

    public static func tone(_ name: String?) -> Color {
        switch name {
        case "success": return success
        case "warning": return warning
        case "danger": return danger
        default: return textSecondary
        }
    }
}

// MARK: Reusable styles

/// Card/panel: thin border, rounded, on the page background (Mac pattern).
struct ThemedCard: ViewModifier {
    var padding: CGFloat = Theme.md
    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(Theme.bg)
            .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd).strokeBorder(Theme.border))
    }
}

/// Primary button: inverted (text-color bg, bg-color label) like the Mac;
/// a `tone` paints a semantic fill with white text.
struct ThemedButton: ButtonStyle {
    var tone: Color? = nil
    var prominent: Bool = true
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .semibold))
            .padding(.horizontal, Theme.md).padding(.vertical, Theme.sm)
            .frame(maxWidth: prominent ? nil : nil)
            .background(tone ?? Theme.text)
            .foregroundStyle(tone == nil ? Theme.bg : Color.white)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusSm))
            .opacity(configuration.isPressed ? 0.75 : 1)
    }
}

extension View {
    func themedCard(padding: CGFloat = Theme.md) -> some View { modifier(ThemedCard(padding: padding)) }

    /// Uppercase, small, tracked, secondary — the Mac section header.
    func sectionHeaderStyle() -> some View {
        self.font(.system(size: 12, weight: .semibold))
            .textCase(.uppercase)
            .tracking(0.6)
            .foregroundStyle(Theme.textSecondary)
    }

    /// Apply the theme to a screen root: monochrome tint + page background.
    func themedRoot() -> some View {
        self.tint(Theme.text).background(Theme.bg)
    }
}
