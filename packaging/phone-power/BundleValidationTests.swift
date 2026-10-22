import Foundation

@main private enum BundleTests {
    static let fm = FileManager.default
    static var passed = 0
    static func test(_ name: String, _ body: () throws -> Void) {
        do { try body(); passed += 1; print("PASS \(name)") }
        catch { fatalError("\(name): \(error)") }
    }
    static func require(_ success: @autoclosure () -> Bool) {
        if !success() { fatalError("Assertion failed") }
    }
    static func fixture(_ body: (URL, URL, URL) throws -> Void) throws {
        let base = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent(".build/bundle-test-" + UUID().uuidString)
        let app = base.appendingPathComponent("IVE.app")
        let plist = app.appendingPathComponent(EmbeddedPhoneService.plistRelativePath)
        let binary = app.appendingPathComponent(EmbeddedPhoneService.binaryRelativePath)
        try fm.createDirectory(at: plist.deletingLastPathComponent(), withIntermediateDirectories: true)
        try fm.createDirectory(at: binary.deletingLastPathComponent(), withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: base) }
        try Data("inert fixture; never executed".utf8).write(to: binary)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: binary.path)
        try manifest(EmbeddedPhoneService.expectedManifest, to: plist)
        try body(app,plist,binary)
    }
    static func manifest(_ value: [String: Any], to path: URL) throws {
        try PropertyListSerialization.data(fromPropertyList: value, format: .xml, options: 0).write(to: path)
    }
    static func rejected(_ app: URL, _ reason: String) {
        do { _ = try EmbeddedPhoneService.validateLayout(app: app); fatalError("Invalid bundle accepted") }
        catch { require(String(describing:error) == reason) }
    }
    static func main() {
        test("valid complete bundle") { try fixture { app,_,binary in require(try! EmbeddedPhoneService.validateLayout(app:app) == binary) } }
        test("missing manifest remains missing") { try fixture { app,plist,_ in
            try fm.removeItem(at:plist); rejected(app,"embedded_service_missing")
        } }
        test("missing executable remains missing") { try fixture { app,_,binary in
            try fm.removeItem(at:binary); rejected(app,"embedded_service_missing")
        } }
        test("non-executable helper rejected") { try fixture { app,_,binary in
            try fm.setAttributes([.posixPermissions:0o644],ofItemAtPath:binary.path); rejected(app,"embedded_service_not_executable")
        } }
        test("malformed manifest rejected") { try fixture { app,plist,_ in
            try Data("not a plist".utf8).write(to:plist); rejected(app,"embedded_service_invalid_manifest")
        } }
        test("oversized manifest rejected") { try fixture { app,plist,_ in
            try Data(repeating:32,count:16385).write(to:plist); rejected(app,"embedded_service_invalid_manifest")
        } }
        for key in ["Label","BundleProgram","ProgramArguments","MachServices","KeepAlive","AssociatedBundleIdentifiers"] {
            test("changed \(key) rejected") { try fixture { app,plist,_ in
                var value=EmbeddedPhoneService.expectedManifest; value[key]="unexpected"
                try manifest(value,to:plist); rejected(app,"embedded_service_invalid_manifest")
            } }
        }
        test("extra privileged program rejected") { try fixture { app,plist,_ in
            var value=EmbeddedPhoneService.expectedManifest; value["Program"]="/different/program"
            try manifest(value,to:plist); rejected(app,"embedded_service_invalid_manifest")
        } }
        for which in ["binary","manifest"] {
            test("symlink \(which) rejected") { try fixture { app,plist,binary in
                let file=which == "binary" ? binary : plist
                let target=file.appendingPathExtension("real")
                try fm.moveItem(at:file,to:target); try fm.createSymbolicLink(at:file,withDestinationURL:target)
                rejected(app,"embedded_service_invalid_layout")
            } }
        }
        test("never-seen verified service needs setup and preserves raw status") {
            require(EmbeddedPhoneService.status(3,bundleVerified:true)=="not_registered")
            require(EmbeddedPhoneService.rawStatus(3)=="not_found")
        }
        test("unverified notFound never becomes setup-ready") {
            require(EmbeddedPhoneService.status(3,bundleVerified:false)=="not_found")
            require(EmbeddedPhoneService.status(1,bundleVerified:false)=="unavailable")
        }
        test("registered and approval statuses stay distinct") {
            require(EmbeddedPhoneService.status(0,bundleVerified:true)=="not_registered")
            require(EmbeddedPhoneService.status(1,bundleVerified:true)=="ready")
            require(EmbeddedPhoneService.status(2,bundleVerified:true)=="needs_approval")
            require(EmbeddedPhoneService.status(999,bundleVerified:true)=="unavailable")
        }
        if CommandLine.arguments.count == 2 {
            test("release bundle has expected embedded service layout") {
                _ = try EmbeddedPhoneService.validateLayout(app:URL(fileURLWithPath:CommandLine.arguments[1]))
            }
        }
        print("\(passed) bundle checks passed; no service registration or power actions.")
    }
}
