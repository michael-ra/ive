import UIKit
import UserNotifications

/// Native push (APNs).
///
/// On launch the app registers for remote notifications silently (no prompt;
/// that needs only the Push Notifications entitlement, see
/// Config/IVE-*.entitlements). WebModel sends the token to the Mac
/// (`POST /api/phone/apns-token`). Only when the Mac answers that it has an
/// APNs key configured does the app ask for permission to show alerts, so a
/// user without native push set up never sees a pointless prompt.
///
/// `IVEPushEnabled` in Config/Info.plist switches all of this off (e.g. for a
/// build signed with a free Personal Team, which has no push capability).
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // Must be set before launch finishes so a tap that cold-launched the
        // app is delivered to didReceive below.
        UNUserNotificationCenter.current().delegate = self
        if PushBridge.isEnabled {
            application.registerForRemoteNotifications()
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushBridge.shared.token = deviceToken.map { String(format: "%02x", $0) }.joined()
        PushBridge.shared.lastError = nil
        NotificationCenter.default.post(name: PushBridge.tokenChanged, object: nil)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushBridge.shared.lastError = error.localizedDescription
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
        #if DEBUG
        // Simulator testing (`xcrun simctl push` cannot tap a banner): with
        // the launch argument `-IVEAutoOpenPushes YES` a push shown while the
        // app is open is handled as if it had been tapped.
        if UserDefaults.standard.bool(forKey: "IVEAutoOpenPushes"),
           let path = notification.request.content.userInfo["path"] as? String {
            DispatchQueue.main.async { PushBridge.shared.open(path: path) }
        }
        #endif
    }

    /// The Mac sends `"path": "/#session-<id>"`; tapping opens that session.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier,
           let path = response.notification.request.content.userInfo["path"] as? String {
            DispatchQueue.main.async { PushBridge.shared.open(path: path) }
        }
        completionHandler()
    }
}

final class PushBridge {
    static let shared = PushBridge()
    static let tokenChanged = Notification.Name("IVEPushTokenChanged")
    static let openPath = Notification.Name("IVEPushOpenPath")

    var token: String?
    var lastError: String?
    /// Set when the Mac reported it has an APNs key (answer to the token POST).
    var macConfigured: Bool?
    private(set) var authorization: UNAuthorizationStatus = .notDetermined
    /// A tapped notification's path, kept until a web view takes it (the tap
    /// may cold-launch the app before any web view exists).
    private(set) var pendingPath: String?

    static var isEnabled: Bool {
        Bundle.main.object(forInfoDictionaryKey: "IVEPushEnabled") as? Bool ?? true
    }

    static var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    func open(path: String) {
        pendingPath = path
        NotificationCenter.default.post(name: PushBridge.openPath, object: nil, userInfo: ["path": path])
    }

    func takePendingPath() -> String? {
        defer { pendingPath = nil }
        return pendingPath
    }

    /// Ask for alert permission once the Mac can actually send pushes.
    func macReported(configured: Bool) {
        macConfigured = configured
        guard configured else { return }
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            self.authorization = settings.authorizationStatus
            guard settings.authorizationStatus == .notDetermined else { return }
            center.requestAuthorization(options: [.alert, .badge, .sound]) { _, _ in
                center.getNotificationSettings { self.authorization = $0.authorizationStatus }
            }
        }
    }

    static var statusText: String {
        if !isEnabled { return "Off in this build" }
        if let e = shared.lastError { return "Failed: \(e)" }
        if shared.token == nil { return "Waiting for Apple" }
        if shared.macConfigured == false { return "Mac has no APNs key yet" }
        if shared.authorization == .denied { return "Blocked in iOS Settings" }
        if shared.macConfigured == true { return "On" }
        return "Registered"
    }
}
