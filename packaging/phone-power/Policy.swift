import Foundation

// Pure policy model: this file has no system power, IPC, process, or file APIs.
struct PowerReading {
    let battery: Double?
    let thermal: Int? // ProcessInfo.ThermalState raw value
    let onBattery: Bool?
    let sampledAt: Double
    var lidClosed: Bool? = false

    func refusal(now: Double) -> String? {
        guard sampledAt.isFinite, now.isFinite, sampledAt <= now,
              now - sampledAt <= 5 else { return "stale_power_data" }
        guard let battery, battery.isFinite, (0...100).contains(battery) else {
            return "battery_unavailable"
        }
        guard onBattery != nil else { return "power_source_unavailable" }
        guard battery > 20 else { return "battery_cutoff" }
        guard let thermal, (0...3).contains(thermal) else { return "thermal_unavailable" }
        return thermal >= 2 ? "thermal_cutoff" : nil
    }
}

struct AppIdentity: Codable, Equatable {
    let pid: Int32
    let uid: UInt32
    let startedSeconds: UInt64
    let startedMicroseconds: UInt64
    let executable: String
}

struct AwakeLease: Codable {
    let id: String
    let owner: AppIdentity
    let bootID: String
    let started: Double
    let deadline: Double
    let expiresAt: Double // Wall-clock display only; never used for enforcement.
    var heartbeat: Double
    var phase: String
    let originalKeyAbsent: Bool
    let allowBattery: Bool
    // Optional for recovery of journals written by older IVE releases.
    var lidOptions: LidOptions?
    var lidRecovery: LidRecovery?

    func stopReason(now: Double, bootID: String, appAlive: Bool,
                    reading: PowerReading) -> String? {
        if self.bootID != bootID { return "reboot" }
        if !appAlive { return "app_exited" }
        if !now.isFinite || now < started || now < heartbeat { return "clock_invalid" }
        if now >= deadline { return "duration_ended" }
        if now - heartbeat >= 30 { return "heartbeat_expired" }
        if !allowBattery && reading.onBattery == true { return "battery_not_allowed" }
        return reading.refusal(now: now)
    }

    static func make(owner: AppIdentity, bootID: String, now: Double,
                     wallNow: Double, duration: Double, originalKeyAbsent: Bool,
                     allowBattery: Bool) throws -> AwakeLease {
        guard duration.isFinite, (60...28800).contains(duration), now.isFinite,
              wallNow.isFinite, !bootID.isEmpty else { throw PowerError("invalid_duration") }
        return AwakeLease(id: UUID().uuidString, owner: owner, bootID: bootID,
                          started: now, deadline: now + duration,
                          expiresAt: wallNow + duration, heartbeat: now,
                          phase: "prepared", originalKeyAbsent: originalKeyAbsent,
                          allowBattery: allowBattery)
    }
}

struct LidOptions: Codable, Equatable {
    static let allowedApps = ["com.tinyspeck.slackmacgap", "com.hnc.Discord", "net.whatsapp.WhatsApp", "com.spotify.client"]
    let lowPower: Bool
    let pauseApps: [String]
    var enabled: Bool { lowPower || !pauseApps.isEmpty }
    func validate() throws {
        guard pauseApps.count <= Self.allowedApps.count,
              Set(pauseApps).count == pauseApps.count,
              pauseApps.allSatisfy({ Self.allowedApps.contains($0) }) else {
            throw PowerError("invalid_pause_apps")
        }
    }
}

struct LidRecovery: Codable {
    let originalLowPower: Bool?
    let processes: [AppIdentity]
}

protocol LidAdapter {
    func batteryLowPower() throws -> Bool
    func setBatteryLowPower(_ enabled: Bool) throws
    func candidates(apps: [String], uid: UInt32) throws -> [AppIdentity]
    func pause(_ identity: AppIdentity) throws
    func resume(_ identity: AppIdentity) throws
}

// Kept pure so malformed/unknown pmset output is tested without changing macOS.
func parseBatteryLowPower(_ output: String) throws -> Bool {
    var battery = false
    var values: [String] = []
    for line in output.components(separatedBy: .newlines) {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasSuffix(":") { battery = trimmed == "Battery Power:"; continue }
        let fields = trimmed.split(whereSeparator: { $0.isWhitespace })
        if battery && fields.first == "lowpowermode" {
            guard fields.count == 2 else { throw PowerError("low_power_status_unrecognized") }
            values.append(String(fields[1]))
        }
    }
    guard values.count == 1, ["0", "1"].contains(values[0]) else { throw PowerError("low_power_status_unrecognized") }
    return values[0] == "1"
}

struct PowerError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

struct SleepSetting {
    let preference: Bool
    let kernel: Bool
    let keyAbsent: Bool
    var disabled: Bool { preference || kernel }
    var verifiedActive: Bool { preference && kernel }
}

protocol PowerAdapter {
    func read() throws -> SleepSetting
    func setDisabled(_ disabled: Bool) throws
    // Called only after verified restoration for consented safety cutoffs.
    // Unknown lid state must throw; an open lid must never be forced asleep.
    func safetySleepIfLidClosed() throws
}

protocol LeaseJournal {
    func load() throws -> AwakeLease?
    func save(_ lease: AwakeLease) throws
    func clear() throws
}

// Serialized by the daemon's one queue. A prepared record must survive a crash
// before the first power write; recovery never resumes a previous session.
final class LeaseController {
    let power: PowerAdapter
    let journal: LeaseJournal
    let lid: LidAdapter?
    private(set) var lidActive = false
    private(set) var lease: AwakeLease?
    private(set) var state = "ready"
    private(set) var reason: String?

    init(power: PowerAdapter, journal: LeaseJournal, lid: LidAdapter? = nil) {
        self.power = power
        self.journal = journal
        self.lid = lid
    }

    func recover() {
        do {
            lease = try journal.load()
            if lease != nil { restore(reason: "helper_restarted") }
        } catch {
            state = "blocked"
            reason = "recovery_journal_unreadable"
        }
    }

    func start(owner: AppIdentity, bootID: String, now: Double, wallNow: Double,
               duration: Double, allowBattery: Bool, reading: PowerReading,
               lidOptions: LidOptions? = nil) throws {
        guard state == "ready", lease == nil else { throw PowerError("session_already_active_or_blocked") }
        try lidOptions?.validate()
        if lidOptions?.enabled == true && (lid == nil || reading.lidClosed == nil) {
            throw PowerError("lid_state_unavailable")
        }
        if let refusal = reading.refusal(now: now) { throw PowerError(refusal) }
        if !allowBattery && reading.onBattery == true { throw PowerError("battery_not_allowed") }
        let original = try power.read()
        guard !original.disabled else { throw PowerError("sleep_already_disabled_elsewhere") }
        var candidate = try AwakeLease.make(owner: owner, bootID: bootID, now: now,
                                            wallNow: wallNow, duration: duration,
                                            originalKeyAbsent: original.keyAbsent, allowBattery: allowBattery)
        candidate.lidOptions = lidOptions
        try journal.save(candidate)
        lease = candidate
        state = "activating"
        do {
            try power.setDisabled(true)
            guard try power.read().verifiedActive else { throw PowerError("activation_not_verified") }
            lease?.phase = "active"
            try journal.save(lease!)
            state = "active"
            reason = nil
            try updateLid(reading)
        } catch {
            restore(reason: "activation_failed")
            throw error
        }
    }

    func renew(id: String, owner: AppIdentity, now: Double, bootID: String,
               reading: PowerReading) throws {
        guard let current = lease, current.id == id, current.owner == owner else {
            throw PowerError("lease_not_owned")
        }
        tick(now: now, bootID: bootID, appAlive: true, reading: reading)
        guard state == "active", lease != nil else { throw PowerError(reason ?? "lease_ended") }
        lease?.heartbeat = now // Deliberately does not extend the hard deadline.
    }

    func stop(id: String, owner: AppIdentity) throws {
        guard let current = lease, current.id == id, current.owner == owner else {
            throw PowerError("lease_not_owned")
        }
        restore(reason: "stopped")
        if state == "restore_failed" { throw PowerError("restore_failed") }
    }

    func tick(now: Double, bootID: String, appAlive: Bool, reading: PowerReading) {
        guard let current = lease else { return }
        if state == "restore_failed" { restore(reason: reason ?? "restore_failed"); return }
        if let stop = current.stopReason(now: now, bootID: bootID, appAlive: appAlive, reading: reading) {
            restore(reason: stop)
            return
        }
        do {
            // Never fight another power manager by re-enabling a cleared flag.
            if !(try power.read().verifiedActive) { restore(reason: "power_setting_changed"); return }
            try updateLid(reading)
        } catch { restore(reason: "power_status_unavailable") }
    }

    private func updateLid(_ reading: PowerReading) throws {
        guard let options = lease?.lidOptions, options.enabled else { return }
        guard let closed = reading.lidClosed, let lid else { throw PowerError("lid_state_unavailable") }
        if !closed {
            try restoreLid()
            return
        }
        guard !lidActive, let current = lease else { return }
        let original = options.lowPower ? try lid.batteryLowPower() : nil
        let processes = try lid.candidates(apps: options.pauseApps, uid: current.owner.uid)
        // Journal all intended mutations before the first setting or signal.
        lease?.lidRecovery = LidRecovery(originalLowPower: original, processes: processes)
        try journal.save(lease!)
        if original == false { try lid.setBatteryLowPower(true) }
        for process in processes { try lid.pause(process) }
        lidActive = true
    }

    private func restoreLid() throws {
        guard let recovery = lease?.lidRecovery else { lidActive = false; return }
        guard let lid else { throw PowerError("lid_adapter_unavailable") }
        var failure: Error?
        // Attempt every restoration, even when one app or setting fails.
        for process in recovery.processes {
            do { try lid.resume(process) } catch { failure = error }
        }
        if recovery.originalLowPower == false {
            do { if try lid.batteryLowPower() { try lid.setBatteryLowPower(false) } }
            catch { failure = error }
        }
        if let failure { throw failure }
        lease?.lidRecovery = nil
        try journal.save(lease!)
        lidActive = false
    }

    func restore(reason: String) {
        guard lease != nil else { return }
        state = "restoring"
        self.reason = reason
        var failure: Error?
        do { try restoreLid() } catch { failure = error }
        do {
            // Ownership comes from the root-only journal, not a read-time guess.
            // false is the original behavior for both absent and false values.
            try power.setDisabled(false)
            guard !(try power.read().disabled) else { throw PowerError("restore_not_verified") }
            if ["battery_cutoff", "thermal_cutoff", "battery_unavailable", "thermal_unavailable",
                "stale_power_data", "power_source_unavailable"].contains(reason) {
                try power.safetySleepIfLidClosed()
            }
        } catch { failure = error }
        do {
            if let failure { throw failure }
            try journal.clear(); lease = nil; state = "ready"; lidActive = false
        } catch {
            // Keep the recovery record and reject new starts until restored.
            state = "restore_failed"
        }
    }
}
