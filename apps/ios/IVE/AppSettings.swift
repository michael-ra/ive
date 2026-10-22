import Foundation
import WebKit

/// Persistent app settings. The Mac URL is not a secret (the device
/// credential is the `ive_session` cookie in the web view's persistent data
/// store, mirrored to the Keychain), so it lives in UserDefaults.
///
/// For tests every key can be overridden with a launch argument, e.g.
/// `-IVEBaseURL http://127.0.0.1:5273 -IVELockEnabled NO`.
final class AppSettings: ObservableObject {
    static let shared = AppSettings()

    private enum Key {
        static let baseURL = "IVEBaseURL"
        static let lockEnabled = "IVELockEnabled"
        static let lockTimeout = "IVELockTimeout"
        static let hideAccessory = "IVEHideKeyboardAccessory"
    }

    private let defaults = UserDefaults.standard

    @Published var baseURL: URL? {
        didSet { defaults.set(baseURL?.absoluteString, forKey: Key.baseURL) }
    }

    /// A pairing link (`http://mac:5111/pair#CODE`) to open once in the web
    /// view right after connecting. Never persisted: the code is single use.
    @Published var pendingStartURL: URL?

    @Published var lockEnabled: Bool {
        didSet { defaults.set(lockEnabled, forKey: Key.lockEnabled) }
    }

    /// Seconds in the background before Face ID is asked again (0 = always).
    @Published var lockTimeout: TimeInterval {
        didSet { defaults.set(lockTimeout, forKey: Key.lockTimeout) }
    }

    /// Hide iOS's "< > Done" bar above the keyboard; the web UI has its own key bar.
    @Published var hideKeyboardAccessory: Bool {
        didSet { defaults.set(hideKeyboardAccessory, forKey: Key.hideAccessory) }
    }

    private init() {
        defaults.register(defaults: [
            Key.lockEnabled: true,
            Key.lockTimeout: 60.0,
            Key.hideAccessory: true,
        ])
        if let raw = defaults.string(forKey: Key.baseURL), let link = PairingLink(raw) {
            baseURL = link.base
        } else {
            baseURL = nil
        }
        lockEnabled = defaults.bool(forKey: Key.lockEnabled)
        lockTimeout = defaults.double(forKey: Key.lockTimeout)
        hideKeyboardAccessory = defaults.bool(forKey: Key.hideAccessory)
    }

    func connect(_ link: PairingLink) {
        pendingStartURL = link.start
        baseURL = link.base
    }

    /// Forget the Mac and its credential (cookies, cache, Keychain copy).
    func forgetMac() {
        if let base = baseURL { CredentialStore.delete(for: base) }
        pendingStartURL = nil
        baseURL = nil
        WKWebsiteDataStore.default().removeData(
            ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
            modifiedSince: .distantPast
        ) {}
    }
}

/// A pasted or scanned link to the Mac.
///
/// Accepts the pairing link from feat/phone-access (`http://host:port/pair#CODE`,
/// the one-time code sits in the fragment and /pair.js redeems it), a plain base
/// URL (`http://192.168.1.20:5111`) or just `host:port`.
struct PairingLink: Equatable {
    let base: URL
    let start: URL

    init?(_ raw: String) {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.contains("://") { text = "http://" + text }
        guard let comps = URLComponents(string: text),
              let scheme = comps.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = comps.host, !host.isEmpty
        else { return nil }

        var b = URLComponents()
        b.scheme = scheme
        b.host = host
        b.port = comps.port
        b.path = "/"
        guard let base = b.url else { return nil }

        var s = comps
        s.scheme = scheme
        if s.path.isEmpty { s.path = "/" }
        self.base = base
        self.start = s.url ?? base
    }

    var isPairingLink: Bool { start.path == "/pair" && !(start.fragment ?? "").isEmpty }
}
