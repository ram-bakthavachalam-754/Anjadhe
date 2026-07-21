import UIKit
import Capacitor
import SwiftUI
import AnjadheUI

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // During native development the SwiftUI app is the DEFAULT — so it shows
        // whether launched from Xcode or by tapping the icon. Set the env var
        // ANJADHE_WEBVIEW=1 (scheme → Run → Arguments) to load the Capacitor
        // WebView instead. Revert this default before shipping the WebView build.
        //
        // NOTE: Info.plist no longer sets UIMainStoryboardFile. UIKit used to
        // auto-instantiate Main.storyboard (the Capacitor WebView) as the root
        // window AFTER this method returned, clobbering anything set here. We now
        // build the root window explicitly for BOTH paths so neither clobbers
        // the other.
        let window = UIWindow(frame: UIScreen.main.bounds)
        // White window + white hosting view so there's no black flash between the
        // launch screen (white + logo) and SwiftUI's first painted frame. The
        // hosting controller's own view must be white too — the window color
        // alone is covered by the (otherwise black) hosting view.
        window.backgroundColor = .white
        if ProcessInfo.processInfo.environment["ANJADHE_WEBVIEW"] == nil {
            let host = UIHostingController(rootView: SpecPreviewRoot())
            host.view.backgroundColor = .white
            window.rootViewController = host
        } else {
            let sb = UIStoryboard(name: "Main", bundle: nil)
            window.rootViewController = sb.instantiateInitialViewController()
        }
        window.makeKeyAndVisible()
        self.window = window
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
