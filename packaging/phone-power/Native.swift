import Foundation
import ServiceManagement
import Security
import IOKit
import IOKit.ps
import Darwin

private let serviceName = "com.ive.desktop.phone-power"
private let appIdentifier = "com.ive.desktop"
private let teamID = "66Y43UAY3C"
private let helperRequirement = "anchor apple generic and identifier \"\(serviceName)\" and certificate leaf[subject.OU] = \"\(teamID)\""
private let appRequirement = "anchor apple generic and identifier \"\(appIdentifier)\" and certificate leaf[subject.OU] = \"\(teamID)\""
private let teamRequirement = "anchor apple generic and certificate leaf[subject.OU] = \"\(teamID)\""
private let serial = DispatchQueue(label: "com.ive.phone-power.policy")

private func continuousNow() -> Double {
    var scale = mach_timebase_info_data_t()
    mach_timebase_info(&scale)
    return Double(mach_continuous_time()) * Double(scale.numer) / Double(scale.denom) / 1_000_000_000
}

private func bootIdentity() throws -> String {
    var value = timeval()
    var length = MemoryLayout<timeval>.size
    guard sysctlbyname("kern.boottime", &value, &length, nil, 0) == 0 else {
        throw PowerError("boot_identity_unavailable")
    }
    return "\(value.tv_sec):\(value.tv_usec)"
}

private func processInfo(_ pid: pid_t) throws -> (AppIdentity, pid_t) {
    var info = proc_bsdinfo()
    let expected = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard pid > 1, proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, expected) == expected else {
        throw PowerError("process_not_running")
    }
    // PROC_PIDPATHINFO_MAXSIZE is 4 * MAXPATHLEN; its SDK macro is not imported
    // by Swift because the macro contains an expression.
    var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    guard proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { throw PowerError("process_path_unavailable") }
    return (AppIdentity(pid: pid, uid: info.pbi_uid, startedSeconds: info.pbi_start_tvsec,
                        startedMicroseconds: info.pbi_start_tvusec,
                        executable: String(cString: path)), pid_t(info.pbi_ppid))
}

private func validateCode(pid: pid_t, requirement: String) throws {
    var code: SecCode?
    var required: SecRequirement?
    guard SecRequirementCreateWithString(requirement as CFString, [], &required) == errSecSuccess,
          SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid as String: pid] as CFDictionary,
                                        [], &code) == errSecSuccess,
          let code, let required,
          SecCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), required) == errSecSuccess else {
        throw PowerError("untrusted_process")
    }
}

private func validateEmbeddedService(_ root: URL) throws {
    let binary = try EmbeddedPhoneService.validateLayout(app: root)
    var code: SecStaticCode?
    var required: SecRequirement?
    guard SecRequirementCreateWithString(helperRequirement as CFString, [], &required) == errSecSuccess,
          SecStaticCodeCreateWithPath(binary as CFURL, [], &code) == errSecSuccess,
          let code, let required,
          SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), required) == errSecSuccess else {
        throw PowerError("embedded_service_signature_invalid")
    }
}

private func ownAppRoot() throws -> URL {
    let path = try processInfo(getpid()).0.executable
    let url = URL(fileURLWithPath: path)
    let root = url.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    guard root.pathExtension == "app", url.path == root.appendingPathComponent("Contents/MacOS/ive-phone-power").path else {
        throw PowerError("helper_not_in_app_bundle")
    }
    return root
}

// The signed CLI cannot be used as a general root broker by arbitrary scripts.
// Its parent chain must be the signed bundled IVE backend and native app. PID
// start times are rechecked after signature checks and throughout the lease.
private func trustedOwner(clientPID: pid_t, uid: uid_t, requestedPID: pid_t?) throws -> AppIdentity {
    guard uid != 0 else { throw PowerError("interactive_user_required") }
    let root = try ownAppRoot()
    let helperPath = root.appendingPathComponent("Contents/MacOS/ive-phone-power").path
    let appPath = root.appendingPathComponent("Contents/MacOS/ive").path
    let backendPath = root.appendingPathComponent("Contents/Resources/backend/ive-backend").path
    let first = try processInfo(clientPID)
    guard first.0.uid == uid, first.0.executable == helperPath else { throw PowerError("client_path_mismatch") }
    try validateCode(pid: clientPID, requirement: helperRequirement)
    var cursor = first.1
    for _ in 0..<8 {
        let before = try processInfo(cursor)
        guard before.0.uid == uid else { throw PowerError("parent_user_mismatch") }
        if before.0.executable == appPath {
            guard requestedPID == nil || requestedPID == cursor else { throw PowerError("app_pid_mismatch") }
            try validateCode(pid: cursor, requirement: appRequirement)
            guard try processInfo(cursor).0 == before.0,
                  try processInfo(clientPID).0 == first.0 else { throw PowerError("process_identity_changed") }
            return before.0
        }
        guard before.0.executable == backendPath else { throw PowerError("untrusted_parent_chain") }
        try validateCode(pid: cursor, requirement: teamRequirement)
        guard try processInfo(cursor) == before else { throw PowerError("process_identity_changed") }
        cursor = before.1
    }
    throw PowerError("native_app_parent_not_found")
}

private func appStillAlive(_ identity: AppIdentity) -> Bool {
    do {
        guard try processInfo(identity.pid).0 == identity else { return false }
        try validateCode(pid: identity.pid, requirement: appRequirement)
        return try processInfo(identity.pid).0 == identity
    } catch { return false }
}

private func powerReading() -> PowerReading {
    var percentage: Double?
    var onBattery: Bool?
    if let blob = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
       let sources = IOPSCopyPowerSourcesList(blob)?.takeRetainedValue() as? [CFTypeRef] {
        for source in sources {
            guard let description = IOPSGetPowerSourceDescription(blob, source)?.takeUnretainedValue() as? [String: Any],
                  description[kIOPSTypeKey] as? String == kIOPSInternalBatteryType,
                  description[kIOPSIsPresentKey] as? Bool == true,
                  let current = description[kIOPSCurrentCapacityKey] as? NSNumber,
                  let maximum = description[kIOPSMaxCapacityKey] as? NSNumber,
                  maximum.doubleValue > 0 else { continue }
            percentage = current.doubleValue / maximum.doubleValue * 100
            if let sourceState = description[kIOPSPowerSourceStateKey] as? String {
                if sourceState == kIOPSBatteryPowerValue { onBattery = true }
                if sourceState == kIOPSACPowerValue { onBattery = false }
            }
            break
        }
    }
    var closed: Bool?
    let domain = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
    if domain != 0 {
        if let property = IORegistryEntryCreateCFProperty(domain, "AppleClamshellState" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue(),
           CFGetTypeID(property) == CFBooleanGetTypeID() { closed = CFEqual(property, kCFBooleanTrue) }
        IOObjectRelease(domain)
    }
    return PowerReading(battery: percentage, thermal: ProcessInfo.processInfo.thermalState.rawValue,
                        onBattery: onBattery, sampledAt: continuousNow(), lidClosed: closed)
}

private func runPMSet(_ arguments: [String]) throws -> String {
    // Every allowed command is fixed here, never assembled from client input.
    guard arguments == ["-g"] || arguments == ["sleepnow"] || arguments == ["-a", "disablesleep", "0"] ||
          arguments == ["-a", "disablesleep", "1"] || arguments == ["-g", "custom"] ||
          arguments == ["-b", "lowpowermode", "0"] || arguments == ["-b", "lowpowermode", "1"] else { throw PowerError("invalid_power_command") }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/pmset")
    process.arguments = arguments
    process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C"]
    let output = Pipe()
    process.standardOutput = output
    process.standardError = output
    let ended = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in ended.signal() }
    try process.run()
    if ended.wait(timeout: .now() + 5) == .timedOut {
        process.terminate()
        if ended.wait(timeout: .now() + 1) == .timedOut { kill(process.processIdentifier, SIGKILL) }
        throw PowerError("power_command_timeout")
    }
    let data = output.fileHandleForReading.readDataToEndOfFile()
    guard process.terminationStatus == 0, data.count < 65536,
          let text = String(data: data, encoding: .utf8) else { throw PowerError("power_command_failed") }
    return text
}

private final class MacLidAdapter: LidAdapter {
    func batteryLowPower() throws -> Bool { try parseBatteryLowPower(runPMSet(["-g", "custom"])) }
    func setBatteryLowPower(_ enabled: Bool) throws {
        _ = try runPMSet(["-b", "lowpowermode", enabled ? "1" : "0"])
        let end = continuousNow() + 3
        repeat {
            if try batteryLowPower() == enabled { return }
            Thread.sleep(forTimeInterval: 0.1)
        } while continuousNow() < end
        throw PowerError("low_power_change_not_verified")
    }

    private func appID(_ executable: String) -> String? {
        // The outer .app owns nested Electron helper apps. Only these explicit
        // non-agent bundles are eligible; terminal/browser/agent processes are
        // never selected by CPU usage, parentage or an arbitrary client path.
        var url = URL(fileURLWithPath: "/")
        for component in executable.split(separator: "/") {
            url.appendPathComponent(String(component))
            if component.hasSuffix(".app") { return Bundle(url: url)?.bundleIdentifier }
        }
        return nil
    }

    private func stopped(_ pid: pid_t) throws -> Bool {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { throw PowerError("process_not_running") }
        return info.pbi_status == SSTOP
    }

    func candidates(apps: [String], uid: UInt32) throws -> [AppIdentity] {
        guard uid > 0, apps.allSatisfy({ LidOptions.allowedApps.contains($0) }) else { throw PowerError("invalid_pause_apps") }
        if apps.isEmpty { return [] }
        let count = proc_listallpids(nil, 0)
        guard count > 0, count < 100_000 else { throw PowerError("process_list_unavailable") }
        var pids = [pid_t](repeating: 0, count: Int(count) + 256)
        let found = pids.withUnsafeMutableBytes { proc_listallpids($0.baseAddress, Int32($0.count)) }
        guard found >= 0, found <= pids.count else { throw PowerError("process_list_unavailable") }
        var result: [AppIdentity] = []
        for pid in pids.prefix(Int(found)) where pid > 1 {
            guard let identity = try? processInfo(pid).0, identity.uid == uid,
                  let id = appID(identity.executable), apps.contains(id),
                  (try? stopped(pid)) == false else { continue }
            result.append(identity)
        }
        guard result.count <= 64 else { throw PowerError("too_many_pause_processes") }
        return result
    }

    private func signalOwned(_ identity: AppIdentity, signal: Int32) throws {
        guard identity.uid > 0, let id = appID(identity.executable), LidOptions.allowedApps.contains(id) else { throw PowerError("invalid_pause_process") }
        // An exited or reused PID is no longer our process; never signal it.
        let live: AppIdentity
        do { live = try processInfo(identity.pid).0 }
        catch {
            if kill(identity.pid, 0) != 0 && errno == ESRCH { return }
            throw PowerError("pause_process_identity_unavailable")
        }
        guard live == identity else { return }
        if signal == SIGCONT && (try? stopped(identity.pid)) == false { return }
        guard kill(identity.pid, signal) == 0 || errno == ESRCH else { throw PowerError("app_signal_failed") }
        let end = continuousNow() + 0.5
        repeat {
            if let current = try? processInfo(identity.pid).0 {
                if current != identity { return }
                if (try? stopped(identity.pid)) == (signal == SIGSTOP) { return }
            } else if kill(identity.pid, 0) != 0 && errno == ESRCH { return }
            Thread.sleep(forTimeInterval: 0.01)
        } while continuousNow() < end
        throw PowerError("app_signal_not_verified")
    }
    func pause(_ identity: AppIdentity) throws { try signalOwned(identity, signal: SIGSTOP) }
    func resume(_ identity: AppIdentity) throws { try signalOwned(identity, signal: SIGCONT) }
    func pausedCount(_ identities: [AppIdentity]) -> Int {
        identities.filter { (try? processInfo($0.pid).0) == $0 && (try? stopped($0.pid)) == true }.count
    }
}

private final class MacPowerAdapter: PowerAdapter {
    func safetySleepIfLidClosed() throws {
        let domain = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
        guard domain != 0 else { throw PowerError("lid_state_unavailable") }
        defer { IOObjectRelease(domain) }
        guard let property = IORegistryEntryCreateCFProperty(domain, "AppleClamshellState" as CFString,
                    kCFAllocatorDefault, 0)?.takeRetainedValue(),
              CFGetTypeID(property) == CFBooleanGetTypeID() else { throw PowerError("lid_state_unavailable") }
        if CFEqual(property, kCFBooleanTrue) {
            // Check restoration again immediately before requesting emergency
            // sleep. Never use this path for normal stop, expiry, or app exit.
            guard !(try read().disabled) else { throw PowerError("restore_not_verified") }
            let output = try runPMSet(["sleepnow"])
            guard !output.lowercased().contains("error"), !output.lowercased().contains("failed") else {
                throw PowerError("safety_sleep_failed")
            }
        }
    }

    func read() throws -> SleepSetting {
        let output = try runPMSet(["-g"])
        guard output.contains("System-wide power settings:"), output.contains("Currently in use:") else {
            throw PowerError("power_status_unrecognized")
        }
        let systemSection = output.components(separatedBy: "Currently in use:")[0]
        let values = systemSection.split(separator: "\n").map { $0.split(whereSeparator: { $0.isWhitespace }) }
            .filter { $0.first == "SleepDisabled" }
        guard values.count <= 1, values.isEmpty || (values[0].count == 2 && ["0", "1"].contains(String(values[0][1]))) else {
            throw PowerError("power_status_unrecognized")
        }
        let domain = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
        guard domain != 0 else { throw PowerError("kernel_power_status_unavailable") }
        defer { IOObjectRelease(domain) }
        let property = IORegistryEntryCreateCFProperty(domain, "SleepDisabled" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
        var kernel = false
        if let property {
            guard CFGetTypeID(property) == CFBooleanGetTypeID() else { throw PowerError("kernel_power_status_unrecognized") }
            kernel = CFEqual(property, kCFBooleanTrue)
        }
        return SleepSetting(preference: values.first?.last == "1", kernel: kernel, keyAbsent: values.isEmpty)
    }

    func setDisabled(_ disabled: Bool) throws {
        if disabled {
            let current = powerReading()
            if let reason = current.refusal(now: continuousNow()) { throw PowerError(reason) }
        }
        _ = try runPMSet(["-a", "disablesleep", disabled ? "1" : "0"])
        // pmset can return zero after printing an error. Verify both persistence
        // and kernel state, allowing time for powerd's preference notification.
        let end = continuousNow() + 3
        repeat {
            let actual = try read()
            if disabled ? actual.verifiedActive : !actual.disabled { return }
            Thread.sleep(forTimeInterval: 0.1)
        } while continuousNow() < end
        throw PowerError("power_change_not_verified")
    }
}

private final class RootJournal: LeaseJournal {
    private let directory = "/Library/Application Support/IVE/PhonePower"
    private var path: String { directory + "/lease.json" }

    private func ensureDirectory() throws {
        for part in ["/Library/Application Support/IVE", directory] {
            if mkdir(part, 0o700) != 0 && errno != EEXIST { throw PowerError("journal_directory_unavailable") }
            var info = stat()
            guard lstat(part, &info) == 0, info.st_uid == 0,
                  (info.st_mode & S_IFMT) == S_IFDIR, (info.st_mode & 0o022) == 0 else {
                throw PowerError("journal_directory_unsafe")
            }
        }
    }

    func load() throws -> AwakeLease? {
        try ensureDirectory()
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        if fd < 0 && errno == ENOENT { return nil }
        guard fd >= 0 else { throw PowerError("journal_unreadable") }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_uid == 0, (info.st_mode & S_IFMT) == S_IFREG,
              (info.st_mode & 0o077) == 0, info.st_size > 0, info.st_size < 131072 else {
            throw PowerError("journal_unsafe")
        }
        var bytes = [UInt8](repeating: 0, count: Int(info.st_size))
        guard Darwin.read(fd, &bytes, bytes.count) == bytes.count else { throw PowerError("journal_read_failed") }
        let lease = try JSONDecoder().decode(AwakeLease.self, from: Data(bytes))
        try lease.lidOptions?.validate()
        if let recovery = lease.lidRecovery {
            guard recovery.processes.count <= 64,
                  recovery.processes.allSatisfy({ $0.uid == lease.owner.uid && $0.uid > 0 && $0.pid > 1 }) else { throw PowerError("journal_invalid") }
        }
        guard UUID(uuidString: lease.id) != nil, lease.owner.uid > 0, lease.owner.pid > 1,
              ["prepared", "active"].contains(lease.phase), lease.started.isFinite,
              lease.deadline.isFinite, (60...28800).contains(lease.deadline - lease.started) else {
            throw PowerError("journal_invalid")
        }
        return lease
    }

    func save(_ lease: AwakeLease) throws {
        try ensureDirectory()
        let data = try JSONEncoder().encode(lease)
        let temporary = directory + "/.lease-" + UUID().uuidString
        let fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw PowerError("journal_write_failed") }
        defer { close(fd); unlink(temporary) }
        let count = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
        guard count == data.count, fsync(fd) == 0, rename(temporary, path) == 0 else {
            throw PowerError("journal_commit_failed")
        }
        try syncDirectory()
    }

    func clear() throws {
        guard unlink(path) == 0 || errno == ENOENT else { throw PowerError("journal_remove_failed") }
        try syncDirectory()
    }

    private func syncDirectory() throws {
        let fd = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw PowerError("journal_sync_failed") }
        defer { close(fd) }
        guard fsync(fd) == 0 else { throw PowerError("journal_sync_failed") }
    }
}

private struct Request: Decodable {
    let action: String
    let app_pid: Int32?
    let duration_seconds: Double?
    let allow_battery: Bool?
    let lease_id: String?
    let lid_low_power: Bool?
    let pause_apps: [String]?
}

private func json(_ object: [String: Any]) -> Data {
    (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{\"ok\":false,\"reason\":\"serialization_failed\"}".utf8)
}

@objc private protocol PowerRPC {
    func request(_ data: Data, reply: @escaping (Data) -> Void)
}

private final class ConnectionHandler: NSObject, PowerRPC {
    let connection: NSXPCConnection
    let controller: LeaseController
    let boot: String
    init(connection: NSXPCConnection, controller: LeaseController, boot: String) {
        self.connection = connection; self.controller = controller; self.boot = boot
    }

    func request(_ data: Data, reply: @escaping (Data) -> Void) {
        serial.async {
            do {
                guard data.count <= 16384 else { throw PowerError("request_too_large") }
                let input = try JSONDecoder().decode(Request.self, from: data)
                let owner = try trustedOwner(clientPID: self.connection.processIdentifier,
                                             uid: self.connection.effectiveUserIdentifier,
                                             requestedPID: input.app_pid)
                let reading = powerReading()
                let now = continuousNow()
                self.controller.tick(now: now, bootID: self.boot,
                                     appAlive: self.controller.lease.map { appStillAlive($0.owner) } ?? true,
                                     reading: reading)
                switch input.action {
                case "status": break
                case "start":
                    guard input.app_pid != nil, let allowBattery = input.allow_battery else { throw PowerError("explicit_battery_choice_required") }
                    try self.controller.start(owner: owner, bootID: self.boot, now: now,
                                              wallNow: Date().timeIntervalSince1970,
                                              duration: input.duration_seconds ?? 28800,
                                              allowBattery: allowBattery, reading: reading,
                                              lidOptions: LidOptions(lowPower: input.lid_low_power ?? false,
                                                                     pauseApps: input.pause_apps ?? []))
                case "renew":
                    try self.controller.renew(id: input.lease_id ?? "", owner: owner, now: now,
                                              bootID: self.boot, reading: reading)
                case "stop": try self.controller.stop(id: input.lease_id ?? "", owner: owner)
                default: throw PowerError("unsupported_daemon_action")
                }
                var result: [String: Any] = ["ok": true, "status": self.controller.state,
                    "protocol_version": 2, "lid_saver_supported": true,
                    "lid_closed": reading.lidClosed as Any? ?? NSNull(),
                    "lid_saver_active": self.controller.lidActive,
                    "low_power_active": ProcessInfo.processInfo.isLowPowerModeEnabled,
                    "paused_processes": MacLidAdapter().pausedCount(self.controller.lease?.lidRecovery?.processes ?? []),
                    "battery_floor": 20, "heartbeat_seconds": 10, "lease_seconds": 30,
                    "max_duration_seconds": 28800, "last_verified_at": Date().timeIntervalSince1970,
                    "battery_percent": reading.battery as Any? ?? NSNull(),
                    "on_battery": reading.onBattery as Any? ?? NSNull(),
                    "reason": self.controller.reason as Any? ?? NSNull()]
                if let lease = self.controller.lease, lease.owner == owner {
                    result["lease_id"] = lease.id
                    result["expires_at"] = lease.expiresAt
                    result["allow_battery"] = lease.allowBattery
                    result["lid_low_power"] = lease.lidOptions?.lowPower ?? false
                    result["pause_apps"] = lease.lidOptions?.pauseApps ?? []
                }
                reply(json(result))
            } catch {
                reply(json(["ok": false, "status": self.controller.state, "reason": String(describing: error)]))
            }
        }
    }
}

private final class Daemon: NSObject, NSXPCListenerDelegate {
    let controller = LeaseController(power: MacPowerAdapter(), journal: RootJournal(), lid: MacLidAdapter())
    let boot: String
    private var timer: DispatchSourceTimer?
    private var signals: [DispatchSourceSignal] = []
    init(boot: String) { self.boot = boot; super.init() }

    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        guard connection.effectiveUserIdentifier != 0 else { return false }
        connection.setCodeSigningRequirement(helperRequirement)
        connection.exportedInterface = NSXPCInterface(with: PowerRPC.self)
        connection.exportedObject = ConnectionHandler(connection: connection, controller: controller, boot: boot)
        connection.invalidationHandler = { [weak connection] in connection?.exportedObject = nil }
        connection.resume()
        return true
    }

    func run() -> Never {
        serial.sync { controller.recover() }
        let listener = NSXPCListener(machServiceName: serviceName)
        listener.delegate = self
        listener.resume()
        timer = DispatchSource.makeTimerSource(queue: serial)
        timer?.schedule(deadline: .now() + 1, repeating: 2, leeway: .milliseconds(100))
        timer?.setEventHandler { [self] in
            let reading = powerReading()
            controller.tick(now: continuousNow(), bootID: boot,
                            appAlive: controller.lease.map { appStillAlive($0.owner) } ?? true, reading: reading)
        }
        timer?.resume()
        for code in [SIGTERM, SIGINT] {
            signal(code, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: code, queue: serial)
            source.setEventHandler { [self] in
                controller.restore(reason: "helper_stopping")
                exit(controller.state == "restore_failed" ? 1 : 0)
            }
            source.resume()
            signals.append(source)
        }
        withExtendedLifetime(listener) { dispatchMain() }
    }
}

@main private enum Main {
    static func main() {
        if CommandLine.arguments == [CommandLine.arguments[0], "--daemon"] {
            guard geteuid() == 0, getppid() == 1 else { exit(77) }
            do { Daemon(boot: try bootIdentity()).run() } catch { exit(78) }
        }
        do {
            guard CommandLine.arguments.count == 1 else { throw PowerError("arguments_not_supported") }
            let data = try FileHandle.standardInput.read(upToCount: 16385) ?? Data()
            guard !data.isEmpty, data.count <= 16384 else { throw PowerError("invalid_request_size") }
            let input = try JSONDecoder().decode(Request.self, from: data)
            // Local registration/settings actions have the same trusted parent
            // requirement as power actions. No browser can invoke the daemon.
            _ = try trustedOwner(clientPID: getpid(), uid: geteuid(), requestedPID: input.app_pid)
            let root = try ownAppRoot()
            guard Bundle.main.bundleURL.standardizedFileURL == root.standardizedFileURL,
                  Bundle.main.bundleIdentifier == appIdentifier else { throw PowerError("main_bundle_mismatch") }
            try validateEmbeddedService(root)
            let service = SMAppService.daemon(plistName: serviceName + ".plist")
            switch input.action {
            case "register":
                // No power change follows registration. Start requires another
                // explicit operation after macOS reports approval.
                if service.status != .enabled && service.status != .requiresApproval { try service.register() }
                output(registrationReply(service.status))
            case "open-settings":
                SMAppService.openSystemSettingsLoginItems()
                output(registrationReply(service.status))
            case "unregister":
                // Reject removing the watchdog while a lease/recovery is live.
                let current = try rpc(data: json(["action": "status", "app_pid": input.app_pid as Any? ?? NSNull()]))
                guard current["ok"] as? Bool == true, current["status"] as? String == "ready" else {
                    throw PowerError("stop_and_verify_restore_before_unregister")
                }
                try service.unregister()
                output(registrationReply(service.status))
            case "status", "start", "renew", "stop":
                if service.status != .enabled {
                    var response = registrationReply(service.status)
                    response["ok"] = input.action == "status" && response["ok"] as? Bool == true
                    response["reason"] = service.status == .requiresApproval ?
                        "macos_helper_approval_required" : "macos_helper_not_registered"
                    output(response)
                } else { output(try rpc(data: data)) }
            default: throw PowerError("unsupported_action")
            }
        } catch {
            let reason = String(describing: error)
            output(["ok": false, "status": reason == "embedded_service_missing" ? "not_found" : "unavailable", "reason": reason])
        }
    }

    private static func statusName(_ status: SMAppService.Status) -> String {
        // Every caller reaches this only after explicit bundle layout and
        // Developer ID helper signature verification above.
        EmbeddedPhoneService.status(status.rawValue, bundleVerified: true)
    }

    private static func registrationReply(_ status: SMAppService.Status) -> [String: Any] {
        ["ok": statusName(status) != "unavailable", "status": statusName(status),
         "protocol_version": 2, "lid_saver_supported": true,
         "service_status": EmbeddedPhoneService.rawStatus(status.rawValue), "bundle_verified": true]
    }

    private static func rpc(data: Data) throws -> [String: Any] {
        let connection = NSXPCConnection(machServiceName: serviceName, options: .privileged)
        connection.setCodeSigningRequirement(helperRequirement)
        connection.remoteObjectInterface = NSXPCInterface(with: PowerRPC.self)
        connection.resume()
        defer { connection.invalidate() }
        let done = DispatchSemaphore(value: 0)
        let lock = NSLock()
        var result: Data?
        var failed = false
        let proxy = connection.remoteObjectProxyWithErrorHandler { _ in
            lock.lock(); failed = true; lock.unlock(); done.signal()
        }
        guard let remote = proxy as? PowerRPC else { throw PowerError("helper_connection_failed") }
        remote.request(data) { reply in lock.lock(); result = reply; lock.unlock(); done.signal() }
        guard done.wait(timeout: .now() + 20) == .success else { throw PowerError("helper_response_timeout") }
        lock.lock(); defer { lock.unlock() }
        guard !failed, let result, let object = try JSONSerialization.jsonObject(with: result) as? [String: Any] else {
            throw PowerError("helper_connection_failed")
        }
        return object
    }

    private static func output(_ object: [String: Any]) {
        FileHandle.standardOutput.write(json(object) + Data([10]))
        exit(object["ok"] as? Bool == true ? 0 : 1)
    }
}
