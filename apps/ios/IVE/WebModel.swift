import SwiftUI
import UIKit
import WebKit

/// Owns the WKWebView that shows the IVE web UI and tracks whether the Mac
/// is reachable.
@MainActor
final class WebModel: NSObject, ObservableObject {
    enum Phase: Equatable {
        case loading
        case ready
        case unreachable(String)
    }

    @Published private(set) var phase: Phase = .loading
    @Published var showSettings = false

    let baseURL: URL
    let webView: WKWebView
    private let settings: AppSettings
    private var retryTimer: Timer?
    private var hasLoadedOnce = false
    private var pullToRefreshAllowed = true
    private let refresh = UIRefreshControl()

    init(baseURL: URL, settings: AppSettings) {
        self.baseURL = baseURL
        self.settings = settings

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // persistent: holds the device cookie
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsPictureInPictureMediaPlayback = true
        config.dataDetectorTypes = []
        // Look like iOS Safari to the web UI (its phone detection keys off
        // the UA) and say we are the native shell.
        config.applicationNameForUserAgent = "Version/18.0 Mobile/15E148 Safari/604.1 IVE-iOS/\(AppInfo.version)"
        config.defaultWebpagePreferences.preferredContentMode = .mobile

        let ucc = WKUserContentController()
        ucc.addUserScript(WKUserScript(source: NativeBridge.documentStartScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        ucc.addUserScript(WKUserScript(source: NativeBridge.documentEndScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        config.userContentController = ucc

        webView = WKWebView(frame: .zero, configuration: config)
        super.init()

        let proxy = WeakMessageProxy(self)
        ucc.add(proxy, name: NativeBridge.hapticHandler)
        ucc.add(proxy, name: NativeBridge.nativeHandler)

        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsLinkPreview = false // long-press in the terminal selects text, no preview pop-up
        webView.allowsBackForwardNavigationGestures = false
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground
        webView.scrollView.keyboardDismissMode = .none
        #if DEBUG
        webView.isInspectable = true
        #endif

        refresh.addTarget(self, action: #selector(pulledToRefresh), for: .valueChanged)
        webView.scrollView.refreshControl = refresh

        let twoFingerDoubleTap = UITapGestureRecognizer(target: self, action: #selector(openSettingsGesture))
        twoFingerDoubleTap.numberOfTouchesRequired = 2
        twoFingerDoubleTap.numberOfTapsRequired = 2
        twoFingerDoubleTap.cancelsTouchesInView = false
        webView.addGestureRecognizer(twoFingerDoubleTap)

        if settings.hideKeyboardAccessory { webView.ive_setKeyboardAccessoryHidden() }

        NotificationCenter.default.addObserver(self, selector: #selector(pushTokenChanged), name: PushBridge.tokenChanged, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(openFromNotification(_:)), name: PushBridge.openPath, object: nil)
    }

    deinit {
        retryTimer?.invalidate()
    }

    // MARK: Loading

    func start() {
        let first = settings.pendingStartURL
        settings.pendingStartURL = nil
        // A notification tap that launched the app opens its session directly.
        let fromPush = PushBridge.shared.takePendingPath().flatMap(sameOriginURL(for:))
        CredentialStore.restore(into: webView.configuration.websiteDataStore.httpCookieStore, for: baseURL) { [weak self] in
            Task { @MainActor in self?.load(first ?? fromPush ?? self?.baseURL) }
        }
    }

    private func load(_ url: URL?) {
        guard let url else { return }
        phase = hasLoadedOnce ? phase : .loading
        webView.load(URLRequest(url: url, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 12))
    }

    func retry() {
        phase = .loading
        load(baseURL)
    }

    /// When coming back from the background: if the Mac went away meanwhile
    /// (asleep, other network), show the reconnect screen instead of a dead UI.
    func checkReachability() {
        guard phase == .ready else { if case .unreachable = phase { retry() }; return }
        let js = """
        return await fetch('/', {method: 'HEAD', cache: 'no-store', credentials: 'same-origin'}).then(r => r.status).catch(() => 0)
        """
        webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self else { return }
            if case .success(let v) = result, let status = v as? Int, status == 0 {
                self.markUnreachable("The Mac stopped answering.")
            }
        }
    }

    @objc private func pulledToRefresh() {
        if case .unreachable = phase { retry() } else { webView.reload() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { self.refresh.endRefreshing() }
    }

    @objc private func openSettingsGesture() { showSettings = true }

    private func setPullToRefresh(_ on: Bool) {
        guard on != pullToRefreshAllowed else { return }
        pullToRefreshAllowed = on
        webView.scrollView.refreshControl = on ? refresh : nil
    }

    private func markUnreachable(_ detail: String) {
        phase = .unreachable(detail)
        retryTimer?.invalidate()
        retryTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, case .unreachable = self.phase,
                      UIApplication.shared.applicationState == .active else { return }
                self.load(self.baseURL)
            }
        }
    }

    private func isSameOrigin(_ url: URL) -> Bool {
        url.host?.lowercased() == baseURL.host?.lowercased()
            && (url.port ?? defaultPort(url)) == (baseURL.port ?? defaultPort(baseURL))
    }

    private func defaultPort(_ url: URL) -> Int { url.scheme == "https" ? 443 : 80 }

    // MARK: Push

    @objc private func pushTokenChanged() { sendPushToken() }

    private func sendPushToken() {
        guard let token = PushBridge.shared.token else { return }
        let payload: [String: Any] = [
            "token": token,
            "environment": PushBridge.environment,
            "bundle_id": Bundle.main.bundleIdentifier ?? "",
            "device": UIDevice.current.model,
        ]
        // The Mac binds the token to this paired phone (ive_session cookie)
        // and says whether it has an APNs key; only then ask for permission.
        let js = """
        window.iveNative && (window.iveNative.apnsToken = payload.token);
        window.dispatchEvent(new CustomEvent('ive:apns-token', {detail: payload}));
        try {
          const r = await fetch('/api/phone/apns-token', {method: 'POST', credentials: 'same-origin',
            headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
          if (!r.ok) return {status: r.status};
          const body = await r.json();
          return {status: r.status, configured: !!body.apns_configured};
        } catch (e) { return {status: 0}; }
        """
        webView.callAsyncJavaScript(js, arguments: ["payload": payload], in: nil, in: .page) { result in
            guard case .success(let value) = result, let dict = value as? [String: Any],
                  (dict["status"] as? Int) == 200 else { return }
            PushBridge.shared.macReported(configured: dict["configured"] as? Bool ?? false)
        }
    }

    private func sameOriginURL(for path: String) -> URL? {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL, isSameOrigin(url) else { return nil }
        return url
    }

    @objc private func openFromNotification(_ note: Notification) {
        guard let path = PushBridge.shared.takePendingPath(), let url = sameOriginURL(for: path) else { return }
        if phase == .ready, let current = webView.url, current.path == url.path, current.query == url.query,
           let fragment = url.fragment {
            // Same page: switch the hash so the web UI opens the session
            // without a reload (App.jsx listens for hashchange).
            let js = "location.hash = " + Self.jsString("#" + fragment)
            webView.evaluateJavaScript(js, completionHandler: nil)
        } else {
            load(url)
        }
    }

    private static func jsString(_ s: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"\"]".utf8)
        let arr = String(decoding: data, as: UTF8.self)
        return String(arr.dropFirst().dropLast())
    }

    // MARK: Bridge

    fileprivate func handle(_ message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              let origin = message.frameInfo.request.url, isSameOrigin(origin)
        else { return }
        let body = message.body as? [String: Any] ?? [:]
        switch message.name {
        case NativeBridge.hapticHandler:
            Haptics.play(body["style"] as? String ?? "light")
        case NativeBridge.nativeHandler:
            switch body["type"] as? String {
            case "pullToRefresh":
                setPullToRefresh(body["enabled"] as? Bool ?? true)
            case "openSettings":
                showSettings = true
            case "openExternal":
                if let s = body["url"] as? String, let url = URL(string: s),
                   ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
                    UIApplication.shared.open(url)
                }
            default:
                break
            }
        default:
            break
        }
    }
}

// MARK: - Navigation

extension WebModel: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, let scheme = url.scheme?.lowercased() else {
            decisionHandler(.allow); return
        }
        if !["http", "https", "about", "blob", "data"].contains(scheme) {
            // tel:, mailto:, itms-apps:, x-apple.systempreferences: …
            UIApplication.shared.open(url)
            decisionHandler(.cancel); return
        }
        let isMain = action.targetFrame?.isMainFrame ?? true
        if (scheme == "http" || scheme == "https"), isMain, !isSameOrigin(url),
           action.navigationType == .linkActivated || action.targetFrame == nil {
            // Links out of IVE (docs, GitHub, OAuth pages) open in Safari.
            UIApplication.shared.open(url)
            decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        hasLoadedOnce = true
        phase = .ready
        retryTimer?.invalidate()
        retryTimer = nil
        refresh.endRefreshing()
        CredentialStore.capture(from: webView.configuration.websiteDataStore.httpCookieStore, for: baseURL)
        sendPushToken()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleLoadError(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleLoadError(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    private func handleLoadError(_ error: Error) {
        refresh.endRefreshing()
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        // "Frame load interrupted" when a link is handed to Safari.
        if ns.domain == "WebKitErrorDomain" && ns.code == 102 { return }
        markUnreachable(ns.localizedDescription)
    }
}

// MARK: - UI delegate (window.open, alert/confirm/prompt, camera/mic)

extension WebModel: WKUIDelegate {
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if isSameOrigin(url) { webView.load(action.request) } else { UIApplication.shared.open(url) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, orElse: completionHandler)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert) { completionHandler(false) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (String?) -> Void) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
        present(alert) { completionHandler(nil) }
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == baseURL.host ? .prompt : .deny)
    }

    private func present(_ alert: UIAlertController, orElse fallback: @escaping () -> Void) {
        guard var top = webView.window?.rootViewController else { fallback(); return }
        while let next = top.presentedViewController { top = next }
        top.present(alert, animated: true)
    }
}

/// WKUserContentController retains its handlers; this breaks the cycle.
private final class WeakMessageProxy: NSObject, WKScriptMessageHandler {
    weak var target: WebModel?
    init(_ target: WebModel) { self.target = target }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated { target?.handle(message) }
    }
}

enum AppInfo {
    static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }
    static var build: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
    }
}

enum Haptics {
    static func play(_ style: String) {
        switch style {
        case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
        case "warning": UINotificationFeedbackGenerator().notificationOccurred(.warning)
        case "error": UINotificationFeedbackGenerator().notificationOccurred(.error)
        case "selection": UISelectionFeedbackGenerator().selectionChanged()
        case "medium": UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        case "heavy": UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
        case "rigid": UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
        case "soft": UIImpactFeedbackGenerator(style: .soft).impactOccurred()
        default: UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }
    }
}
