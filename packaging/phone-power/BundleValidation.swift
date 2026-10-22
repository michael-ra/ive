import Foundation

struct EmbeddedServiceError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

enum EmbeddedPhoneService {
    static let identifier = "com.ive.desktop.phone-power"
    static let binaryRelativePath = "Contents/MacOS/ive-phone-power"
    static let plistRelativePath = "Contents/Library/LaunchDaemons/\(identifier).plist"

    static var expectedManifest: [String: Any] {
        ["Label": identifier, "BundleProgram": binaryRelativePath,
         "ProgramArguments": ["ive-phone-power", "--daemon"],
         "MachServices": [identifier: true], "KeepAlive": true,
         "ThrottleInterval": 5, "ExitTimeOut": 20, "ProcessType": "Background",
         "AssociatedBundleIdentifiers": ["com.ive.desktop"]]
    }

    // Validate independently of the Service Management registry. .notFound is
    // ambiguous there: it also occurs for a service the OS has never seen.
    // Signature validation is an additional native caller responsibility.
    static func validateLayout(app: URL) throws -> URL {
        let root = app.standardizedFileURL.resolvingSymlinksInPath()
        let plist = root.appendingPathComponent(plistRelativePath)
        let binary = root.appendingPathComponent(binaryRelativePath)
        let fm = FileManager.default
        for file in [plist, binary] {
            guard fm.fileExists(atPath: file.path) else { throw EmbeddedServiceError("embedded_service_missing") }
            guard file.resolvingSymlinksInPath() == file,
                  (try fm.attributesOfItem(atPath: file.path))[.type] as? FileAttributeType == .typeRegular else {
                throw EmbeddedServiceError("embedded_service_invalid_layout")
            }
        }
        guard fm.isExecutableFile(atPath: binary.path) else { throw EmbeddedServiceError("embedded_service_not_executable") }
        let size = (try fm.attributesOfItem(atPath: plist.path))[.size] as? NSNumber
        guard let size, size.intValue > 0, size.intValue <= 16384 else { throw EmbeddedServiceError("embedded_service_invalid_manifest") }
        let data = try Data(contentsOf: plist)
        guard let manifest = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              NSDictionary(dictionary: manifest).isEqual(to: expectedManifest) else {
            throw EmbeddedServiceError("embedded_service_invalid_manifest")
        }
        return binary
    }

    static func rawStatus(_ raw: Int) -> String {
        switch raw {
        case 0: return "not_registered"
        case 1: return "enabled"
        case 2: return "needs_approval"
        case 3: return "not_found"
        default: return "unavailable"
        }
    }

    static func status(_ raw: Int, bundleVerified: Bool) -> String {
        // Apple DTS: a never-seen service can return .notFound; registration
        // followed by unregistration produces .notRegistered. Preserve raw
        // status for diagnosis, and never turn missing/invalid code into ready.
        // https://developer.apple.com/forums/thread/719862
        guard bundleVerified else { return raw == 3 ? "not_found" : "unavailable" }
        switch raw {
        case 0, 3: return "not_registered"
        case 1: return "ready"
        case 2: return "needs_approval"
        default: return "unavailable"
        }
    }
}
