import Foundation
import Security
import WebKit

/// Mirrors the device credential (the `ive_session` cookie that
/// /api/phone/pair/complete sets) into the Keychain, so a wiped web view
/// data store does not silently unpair the phone. The web view's persistent
/// WKWebsiteDataStore stays the source of truth; the Keychain copy is only
/// restored when the cookie is missing.
enum CredentialStore {
    static let cookieName = "ive_session"
    private static let service = "eu.aiforeu.ive.credential"

    private struct Stored: Codable {
        var name: String
        var value: String
        var domain: String
        var path: String
        var expires: Date?
        var secure: Bool
    }

    private static func account(for base: URL) -> String {
        "\(base.scheme ?? "http")://\(base.host ?? "")\(base.port.map { ":\($0)" } ?? "")"
    }

    /// Copy the credential cookie for `base` from the web view into the Keychain.
    static func capture(from store: WKHTTPCookieStore, for base: URL) {
        store.getAllCookies { cookies in
            guard let host = base.host,
                  let cookie = cookies.first(where: { $0.name == cookieName && host.hasSuffix($0.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))) })
            else { return }
            let stored = Stored(name: cookie.name, value: cookie.value, domain: cookie.domain,
                                path: cookie.path, expires: cookie.expiresDate, secure: cookie.isSecure)
            guard let data = try? JSONEncoder().encode(stored) else { return }
            write(data, account: account(for: base))
        }
    }

    /// Put the Keychain copy back into the web view if the cookie is gone.
    static func restore(into store: WKHTTPCookieStore, for base: URL, completion: @escaping () -> Void) {
        store.getAllCookies { cookies in
            let host = base.host ?? ""
            let present = cookies.contains { $0.name == cookieName && host.hasSuffix($0.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))) }
            guard !present,
                  let data = read(account: account(for: base)),
                  let stored = try? JSONDecoder().decode(Stored.self, from: data)
            else { completion(); return }
            if let exp = stored.expires, exp < Date() { delete(for: base); completion(); return }
            var props: [HTTPCookiePropertyKey: Any] = [
                .name: stored.name, .value: stored.value, .domain: stored.domain, .path: stored.path,
                HTTPCookiePropertyKey("HttpOnly"): "TRUE",
            ]
            if let exp = stored.expires { props[.expires] = exp }
            if stored.secure { props[.secure] = "TRUE" }
            guard let cookie = HTTPCookie(properties: props) else { completion(); return }
            store.setCookie(cookie) { completion() }
        }
    }

    static func delete(for base: URL) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(for: base),
        ]
        SecItemDelete(query as CFDictionary)
    }

    private static func write(_ data: Data, account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attrs: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        if SecItemUpdate(query as CFDictionary, attrs as CFDictionary) == errSecItemNotFound {
            SecItemAdd(query.merging(attrs) { $1 } as CFDictionary, nil)
        }
    }

    private static func read(account: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }
}
