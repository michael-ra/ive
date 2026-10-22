import LocalAuthentication
import SwiftUI

/// Face ID (or Touch ID) lock with passcode fallback. Locks on launch and
/// after the app was in the background longer than `lockTimeout`.
@MainActor
final class AppLock: ObservableObject {
    @Published private(set) var isLocked: Bool
    @Published private(set) var message: String?
    @Published private(set) var isAuthenticating = false

    private let settings: AppSettings
    private var backgroundedAt: Date?
    /// After a cancel the user taps "Unlock"; no automatic re-prompt loop.
    private var autoPromptAllowed = true

    init(settings: AppSettings) {
        self.settings = settings
        isLocked = settings.lockEnabled && settings.baseURL != nil && Self.canAuthenticate()
    }

    /// The lock only works when the device has a passcode.
    static func canAuthenticate() -> Bool {
        LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
    }

    static var biometryName: String {
        let ctx = LAContext()
        _ = ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
        switch ctx.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        default: return "Passcode"
        }
    }

    var isActiveForThisDevice: Bool { settings.lockEnabled && Self.canAuthenticate() }

    func scenePhaseChanged(_ phase: ScenePhase) {
        switch phase {
        case .background:
            if !isAuthenticating { backgroundedAt = Date() }
        case .active:
            if let since = backgroundedAt {
                backgroundedAt = nil
                if isActiveForThisDevice, settings.baseURL != nil,
                   Date().timeIntervalSince(since) >= settings.lockTimeout {
                    isLocked = true
                    autoPromptAllowed = true
                }
            }
            if isLocked && autoPromptAllowed { unlock() }
        default:
            break
        }
    }

    func lockSettingChanged() {
        if !settings.lockEnabled { isLocked = false }
    }

    func unlock() {
        guard isLocked, !isAuthenticating else { return }
        guard Self.canAuthenticate() else {
            // Passcode removed from the device: nothing to check against.
            isLocked = false
            return
        }
        isAuthenticating = true
        autoPromptAllowed = false
        message = nil
        let ctx = LAContext()
        ctx.localizedFallbackTitle = "Use Passcode"
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock IVE to see your Mac's sessions") { ok, error in
            Task { @MainActor in
                self.isAuthenticating = false
                if ok {
                    self.isLocked = false
                    self.autoPromptAllowed = true
                } else if let err = error as? LAError, err.code != .userCancel, err.code != .appCancel, err.code != .systemCancel {
                    self.message = err.localizedDescription
                }
            }
        }
    }
}

struct LockView: View {
    @EnvironmentObject private var lock: AppLock

    var body: some View {
        ZStack {
            Color(uiColor: .systemBackground).ignoresSafeArea()
            VStack(spacing: 18) {
                Spacer()
                BrandMark(size: 72)
                Text("IVE is locked")
                    .font(.title2.weight(.semibold))
                Text("Your Mac's terminals stay hidden until you unlock.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                if let msg = lock.message {
                    Text(msg).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
                }
                Spacer()
                Button {
                    lock.unlock()
                } label: {
                    Label("Unlock with \(AppLock.biometryName)", systemImage: AppLock.biometryName == "Touch ID" ? "touchid" : "faceid")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(lock.isAuthenticating)
            }
            .padding(24)
        }
    }
}
