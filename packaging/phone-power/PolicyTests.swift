import Foundation

private final class FakePower: PowerAdapter {
    var preference = false
    var kernel = false
    var absent = true
    var failEnable = false
    var failRestore = false
    var failRead = false
    var writes: [Bool] = []
    var lidClosed = true
    var failLidRead = false
    var sleeps = 0
    func read() throws -> SleepSetting {
        if failRead { throw PowerError("read_failed") }
        return SleepSetting(preference: preference, kernel: kernel, keyAbsent: absent)
    }
    func setDisabled(_ disabled: Bool) throws {
        writes.append(disabled)
        if disabled && failEnable || !disabled && failRestore { throw PowerError("write_failed") }
        preference = disabled; kernel = disabled; absent = false
    }
    func safetySleepIfLidClosed() throws {
        if preference || kernel { fatalError("Sleep requested before verified restore") }
        if failLidRead { throw PowerError("lid_state_unavailable") }
        if lidClosed { sleeps += 1 }
    }
}

private final class FakeJournal: LeaseJournal {
    var record: AwakeLease?
    var failSave = false
    var failLoad = false
    var onSave: (() -> Void)?
    func load() throws -> AwakeLease? {
        if failLoad { throw PowerError("corrupt") }
        return record
    }
    func save(_ lease: AwakeLease) throws {
        if failSave { throw PowerError("disk_full") }
        record = lease; onSave?()
    }
    func clear() throws { record = nil }
}

private final class FakeLid: LidAdapter {
    var lowPower = false
    var writes: [Bool] = []
    var running: [AppIdentity] = []
    var paused: [AppIdentity] = []
    var resumed: [AppIdentity] = []
    var failPause = false
    var failRestore = false
    var onMutation: (() -> Void)?
    func batteryLowPower() throws -> Bool { lowPower }
    func setBatteryLowPower(_ enabled: Bool) throws {
        onMutation?()
        if !enabled && failRestore { throw PowerError("restore_failed") }
        lowPower = enabled; writes.append(enabled)
    }
    func candidates(apps: [String], uid: UInt32) throws -> [AppIdentity] { apps.isEmpty ? [] : running }
    func pause(_ identity: AppIdentity) throws {
        onMutation?(); paused.append(identity)
        if failPause { throw PowerError("pause_failed") }
    }
    func resume(_ identity: AppIdentity) throws { resumed.append(identity); paused.removeAll { $0 == identity } }
}

@main private enum Tests {
    static let owner = AppIdentity(pid: 101, uid: 501, startedSeconds: 100, startedMicroseconds: 1, executable: "/fake/IVE.app/Contents/MacOS/ive")
    static var passed = 0
    static func reading(_ at: Double = 100, battery: Double? = 80, thermal: Int? = 0, onBattery: Bool? = true) -> PowerReading {
        PowerReading(battery: battery, thermal: thermal, onBattery: onBattery, sampledAt: at)
    }
    static func check(_ condition: @autoclosure () -> Bool, _ message: String) {
        guard condition() else { fatalError(message) }
    }
    static func test(_ name: String, _ body: () throws -> Void) {
        do { try body(); passed += 1; print("PASS \(name)") }
        catch { fatalError("\(name): \(error)") }
    }
    static func rejects(_ body: () throws -> Void) {
        do { try body(); fatalError("Expected rejection") } catch {}
    }
    static func fixture() -> (LeaseController, FakePower, FakeJournal) {
        let power = FakePower(), journal = FakeJournal()
        return (LeaseController(power: power, journal: journal), power, journal)
    }
    static func start(_ c: LeaseController, duration: Double = 28800, allowBattery: Bool = true) throws {
        try c.start(owner: owner, bootID: "boot-a", now: 100, wallNow: 1000,
                    duration: duration, allowBattery: allowBattery, reading: reading())
    }
    static func main() {
        test("journal precedes power write") {
            let (c,p,j) = fixture()
            j.onSave = { if j.record?.phase == "prepared" { check(p.writes.isEmpty, "write before journal") } }
            try start(c); check(c.state == "active", "not active"); check(j.record?.phase == "active", "not committed")
        }
        test("journal failure cannot change system") {
            let (c,p,j) = fixture(); j.failSave = true
            rejects { try start(c) }; check(p.writes.isEmpty, "power changed")
        }
        test("existing global override is never acquired") {
            let (c,p,j) = fixture(); p.preference = true
            rejects { try start(c) }; check(p.writes.isEmpty && j.record == nil, "foreign override modified")
        }
        test("kernel-only override is never acquired") {
            let (c,p,_) = fixture(); p.kernel = true
            rejects { try start(c) }; check(p.writes.isEmpty, "foreign kernel override modified")
        }
        test("failed activation restores and reports failure") {
            let (c,p,j) = fixture(); p.failEnable = true
            rejects { try start(c) }; check(c.state == "ready" && j.record == nil && p.writes == [true,false], "rollback failed")
        }
        test("lease expires exactly at 30 seconds") {
            let (c,p,_) = fixture(); try start(c)
            c.tick(now: 130, bootID: "boot-a", appAlive: true, reading: reading(130))
            check(c.state == "ready" && !p.kernel && c.reason == "heartbeat_expired", "lease did not expire")
        }
        test("renew cannot extend hard eight hour limit") {
            let (c,_,_) = fixture(); try start(c)
            let id = c.lease!.id, deadline = c.lease!.deadline
            try c.renew(id: id, owner: owner, now: 110, bootID: "boot-a", reading: reading(110))
            check(c.lease!.deadline == deadline, "hard deadline extended")
            c.tick(now: deadline, bootID: "boot-a", appAlive: true, reading: reading(deadline))
            check(c.reason == "duration_ended" && c.state == "ready", "duration not enforced")
        }
        test("late heartbeat cannot resurrect lease") {
            let (c,_,_) = fixture(); try start(c); let id = c.lease!.id
            rejects { try c.renew(id: id, owner: owner, now: 130, bootID: "boot-a", reading: reading(130)) }
            check(c.state == "ready", "late lease survived")
        }
        test("wrong owner and lease cannot stop or renew") {
            let (c,_,_) = fixture(); try start(c)
            let foreign = AppIdentity(pid: 102, uid: 501, startedSeconds: 100, startedMicroseconds: 1, executable: owner.executable)
            rejects { try c.stop(id: c.lease!.id, owner: foreign) }
            rejects { try c.renew(id: "wrong", owner: owner, now: 110, bootID: "boot-a", reading: reading(110)) }
            check(c.state == "active", "foreign caller changed lease")
        }
        test("app crash restores even with fresh heartbeat") {
            let (c,p,_) = fixture(); try start(c)
            c.tick(now: 102, bootID: "boot-a", appAlive: false, reading: reading(102))
            check(c.reason == "app_exited" && !p.kernel, "crash not restored")
        }
        for phase in ["prepared", "active"] {
            test("restart recovers \(phase) journal without resuming") {
                let (c,p,j) = fixture(); try start(c); j.record?.phase = phase
                let restarted = LeaseController(power: p, journal: j); restarted.recover()
                check(restarted.state == "ready" && restarted.lease == nil && !p.kernel && j.record == nil, "recovery failed")
            }
        }
        test("reboot invalidates old lease") {
            let (c,p,_) = fixture(); try start(c)
            c.tick(now: 1, bootID: "boot-b", appAlive: true, reading: reading(1))
            check(c.reason == "reboot" && !p.kernel, "old boot survived")
        }
        for (name, sample) in [("20 percent",reading(102,battery:20)),("missing battery",reading(102,battery:nil)),
                               ("unknown source",reading(102,onBattery:nil)),("thermal serious",reading(102,thermal:2)),
                               ("thermal critical",reading(102,thermal:3)),("unknown thermal",reading(102,thermal:nil)),
                               ("stale sample",reading(90)),("future sample",reading(110))] {
            test("fail closed: \(name)") {
                let (c,p,_) = fixture(); try start(c)
                c.tick(now: 102, bootID: "boot-a", appAlive: true, reading: sample)
                check(c.state == "ready" && !p.kernel, "unsafe state retained")
            }
        }
        test("battery opt-out rejects start on battery") {
            let (c,p,_) = fixture(); rejects { try start(c,allowBattery:false) }; check(p.writes.isEmpty,"changed power")
        }
        test("battery opt-out restores on unplug") {
            let (c,p,_) = fixture()
            try c.start(owner: owner, bootID: "boot-a", now: 100, wallNow: 1000, duration: 1000,
                        allowBattery: false, reading: reading(onBattery:false))
            c.tick(now: 102, bootID: "boot-a", appAlive: true, reading: reading(102))
            check(c.reason == "battery_not_allowed" && !p.kernel, "unplug ignored")
        }
        test("restore failure retains journal and blocks new starts") {
            let (c,p,j) = fixture(); try start(c); p.failRestore = true
            rejects { try c.stop(id: c.lease!.id,owner:owner) }
            rejects { try start(c) }
            check(c.state == "restore_failed" && j.record != nil, "lost recovery record")
            p.failRestore = false
            c.tick(now: 104,bootID:"boot-a",appAlive:true,reading:reading(104))
            check(c.state == "ready" && j.record == nil && !p.kernel, "restore retry failed")
        }
        test("corrupt journal blocks instead of guessing ownership") {
            let (c,p,j) = fixture(); j.failLoad = true; c.recover()
            rejects { try start(c) }; check(c.state == "blocked" && p.writes.isEmpty, "corrupt journal adopted")
        }
        test("external clear is not counteracted") {
            let (c,p,_) = fixture(); try start(c); p.kernel = false
            c.tick(now:102,bootID:"boot-a",appAlive:true,reading:reading(102))
            check(c.reason == "power_setting_changed" && p.writes == [true,false], "external change re-enabled")
        }
        test("invalid durations rejected without power change") {
            for duration in [0.0,59,28801,Double.infinity,Double.nan] {
                let (c,p,_) = fixture(); rejects { try start(c,duration:duration) }; check(p.writes.isEmpty,"invalid duration wrote")
            }
        }
        test("battery safety sleep follows restoration with closed lid") {
            let (c,p,_) = fixture(); try start(c)
            c.tick(now:102,bootID:"boot-a",appAlive:true,reading:reading(102,battery:20))
            check(c.state == "ready" && p.sleeps == 1 && !p.kernel,"missing closed-lid safety sleep")
        }
        test("thermal safety sleep follows restoration with closed lid") {
            let (c,p,_) = fixture(); try start(c)
            c.tick(now:102,bootID:"boot-a",appAlive:true,reading:reading(102,thermal:2))
            check(p.sleeps == 1 && !p.kernel,"missing thermal safety sleep")
        }
        test("open lid never forces safety sleep") {
            let (c,p,_) = fixture(); try start(c); p.lidClosed = false
            c.tick(now:102,bootID:"boot-a",appAlive:true,reading:reading(102,battery:20))
            check(c.state == "ready" && p.sleeps == 0,"forced open-lid sleep")
        }
        test("unknown lid preserves recovery while allowing ordinary sleep") {
            let (c,p,j) = fixture(); try start(c); p.failLidRead = true
            c.tick(now:102,bootID:"boot-a",appAlive:true,reading:reading(102,battery:20))
            check(c.state == "restore_failed" && !p.kernel && j.record != nil && p.sleeps == 0,"unknown lid guessed")
        }
        test("normal stop never forces sleep") {
            let (c,p,_) = fixture(); try start(c); try c.stop(id:c.lease!.id,owner:owner)
            check(c.state == "ready" && p.sleeps == 0,"manual stop forced sleep")
        }
        test("failed restoration cannot force safety sleep") {
            let (c,p,_) = fixture(); try start(c); p.failRestore = true
            c.tick(now:102,bootID:"boot-a",appAlive:true,reading:reading(102,battery:20))
            check(c.state == "restore_failed" && p.sleeps == 0,"sleep before restore")
        }
        let options = LidOptions(lowPower: true, pauseApps: ["com.hnc.Discord"])
        let discord = AppIdentity(pid: 201, uid: 501, startedSeconds: 99, startedMicroseconds: 1,
                                  executable: "/Applications/Discord.app/Contents/MacOS/Discord")
        func fixtureLid() -> (LeaseController, FakePower, FakeJournal, FakeLid) {
            let p = FakePower(), j = FakeJournal(), l = FakeLid(); l.running = [discord]
            return (LeaseController(power: p, journal: j, lid: l), p, j, l)
        }
        func sample(_ time: Double, closed: Bool?) -> PowerReading {
            var r = reading(time); r.lidClosed = closed; return r
        }
        func arm(_ c: LeaseController, closed: Bool = false, options: LidOptions? = options) throws {
            try c.start(owner: owner, bootID: "boot-a", now: 100, wallNow: 1000,
                        duration: 3600, allowBattery: true, reading: sample(100, closed: closed), lidOptions: options)
        }
        test("arming with open lid never saves power or pauses apps") {
            let (c,_,j,l) = fixtureLid(); try arm(c)
            check(c.state == "active" && !c.lidActive && l.writes.isEmpty && l.paused.isEmpty && j.record?.lidRecovery == nil, "acted before close")
        }
        test("lid close starts saver; lid open restores while timer stays armed") {
            let (c,_,j,l) = fixtureLid(); try arm(c)
            l.onMutation = { check(j.record?.lidRecovery?.processes == [discord], "lid mutation before journal") }
            c.tick(now: 102, bootID: "boot-a", appAlive: true, reading: sample(102, closed: true))
            check(c.lidActive && l.lowPower && l.paused == [discord], "close did not start saver")
            c.tick(now: 104, bootID: "boot-a", appAlive: true, reading: sample(104, closed: true))
            check(l.writes == [true] && l.paused.count == 1, "closed polling repeats mutations")
            c.tick(now: 106, bootID: "boot-a", appAlive: true, reading: sample(106, closed: false))
            check(c.state == "active" && !c.lidActive && !l.lowPower && l.paused.isEmpty && j.record?.lidRecovery == nil, "open did not restore")
            c.tick(now: 108, bootID: "boot-a", appAlive: true, reading: sample(108, closed: true))
            check(c.lidActive && l.writes == [true,false,true], "second close failed")
        }
        test("mode off ignores every lid transition") {
            let (c,_,_,l) = fixtureLid()
            c.tick(now: 102, bootID: "boot-a", appAlive: true, reading: sample(102, closed: true))
            check(l.writes.isEmpty && l.paused.isEmpty, "disabled mode acted")
        }
        test("already enabled low power remains enabled after reopening") {
            let (c,_,_,l) = fixtureLid(); l.lowPower = true; try arm(c, closed: true)
            c.tick(now: 102, bootID: "boot-a", appAlive: true, reading: sample(102, closed: false))
            check(l.lowPower && l.writes.isEmpty && l.paused.isEmpty, "changed pre-existing low power")
        }
        test("unselected apps are never paused") {
            let (c,_,_,l) = fixtureLid(); try arm(c, closed: true, options: LidOptions(lowPower: true, pauseApps: []))
            check(l.lowPower && l.paused.isEmpty, "paused unselected apps")
        }
        test("pausing without low power does not touch battery settings") {
            let (c,_,_,l) = fixtureLid(); try arm(c, closed: true, options: LidOptions(lowPower: false, pauseApps: ["com.hnc.Discord"]))
            check(l.paused == [discord] && l.writes.isEmpty, "unexpected battery write")
        }
        test("stop with closed lid restores apps and battery") {
            let (c,p,j,l) = fixtureLid(); try arm(c, closed: true); try c.stop(id: c.lease!.id, owner: owner)
            check(c.state == "ready" && !l.lowPower && l.paused.isEmpty && !p.kernel && j.record == nil, "stop lost restoration")
        }
        test("helper restart restores lid mutations without resuming session") {
            let (c,p,j,l) = fixtureLid(); try arm(c, closed: true)
            let recovered = LeaseController(power: p, journal: j, lid: l); recovered.recover()
            check(recovered.state == "ready" && !l.lowPower && l.paused.isEmpty && !p.kernel, "restart kept lid actions")
        }
        test("app crash restores lid mutations") {
            let (c,p,_,l) = fixtureLid(); try arm(c, closed: true)
            c.tick(now: 102, bootID: "boot-a", appAlive: false, reading: sample(102, closed: true))
            check(c.state == "ready" && !l.lowPower && l.paused.isEmpty && !p.kernel, "crash kept lid actions")
        }
        test("timer restores lid mutations") {
            let (c,p,_,l) = fixtureLid(); try arm(c, closed: true)
            c.tick(now: 3700, bootID: "boot-a", appAlive: true, reading: sample(3700, closed: true))
            check(c.reason == "duration_ended" && !l.lowPower && l.paused.isEmpty && !p.kernel, "timer kept lid actions")
        }
        test("partial pause failure restores every intended process") {
            let (c,p,j,l) = fixtureLid(); l.failPause = true; rejects { try arm(c, closed: true) }
            check(c.state == "ready" && l.paused.isEmpty && !l.lowPower && !p.kernel && j.record == nil, "partial pause leaked")
        }
        test("low power restore failure still resumes apps and allows sleep") {
            let (c,p,j,l) = fixtureLid(); try arm(c, closed: true); l.failRestore = true
            rejects { try c.stop(id: c.lease!.id, owner: owner) }
            check(c.state == "restore_failed" && !p.kernel && l.paused.isEmpty && j.record != nil, "failed restore lost watchdog")
            l.failRestore = false
            c.tick(now: 104, bootID: "boot-a", appAlive: true, reading: sample(104, closed: false))
            check(c.state == "ready" && !l.lowPower && j.record == nil, "restore retry failed")
        }
        test("unknown lid state ends armed saver without guessing") {
            let (c,p,_,l) = fixtureLid(); try arm(c, closed: true)
            c.tick(now: 102, bootID: "boot-a", appAlive: true, reading: sample(102, closed: nil))
            check(c.state == "ready" && !p.kernel && !l.lowPower && l.paused.isEmpty, "unknown lid retained mutations")
        }
        test("agents browsers and arbitrary bundle ids cannot be frozen") {
            for app in ["com.apple.Terminal", "com.google.Chrome", "com.ive.desktop", "/bin/sh", "anything"] {
                let (c,p,_,l) = fixtureLid()
                rejects { try arm(c, closed: true, options: LidOptions(lowPower: true, pauseApps: [app])) }
                check(p.writes.isEmpty && l.writes.isEmpty, "invalid app changed settings")
            }
        }
        test("old journals remain decodable") {
            let (c,_,_,_) = fixtureLid(); try arm(c)
            var obj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(c.lease!)) as! [String: Any]
            obj.removeValue(forKey: "lidOptions"); obj.removeValue(forKey: "lidRecovery")
            let decoded = try JSONDecoder().decode(AwakeLease.self, from: JSONSerialization.data(withJSONObject: obj))
            check(decoded.lidOptions == nil && decoded.lidRecovery == nil, "old journal incompatible")
        }
        test("battery parser ignores AC profile and rejects missing ambiguous values") {
            let value = try parseBatteryLowPower("Battery Power:\n lowpowermode 1\nAC Power:\n lowpowermode 0\n")
            check(value, "wrong source")
            for value in ["", "AC Power:\n lowpowermode 1", "Battery Power:\n lowpowermode 2", "Battery Power:\n lowpowermode 0\n lowpowermode 1"] {
                rejects { _ = try parseBatteryLowPower(value) }
            }
        }
        print("\(passed) policy checks passed; fake adapters only; no system power writes.")
    }
}
