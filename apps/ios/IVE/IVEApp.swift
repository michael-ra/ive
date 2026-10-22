import SwiftUI

@main
struct IVEApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var settings = AppSettings.shared
    @StateObject private var lock = AppLock(settings: AppSettings.shared)

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(settings)
                .environmentObject(lock)
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var lock: AppLock
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            if let base = settings.baseURL {
                MainScreen(baseURL: base)
                    .id(base) // a new Mac gets a fresh web view
            } else {
                ConnectView()
            }

            if lock.isLocked {
                LockView()
                    .transition(.opacity)
            } else if scenePhase != .active && lock.isActiveForThisDevice && settings.baseURL != nil {
                // Hide the terminal content in the app switcher.
                PrivacyCover()
            }
        }
        .animation(.easeOut(duration: 0.18), value: lock.isLocked)
        .onChange(of: scenePhase) { _, phase in
            lock.scenePhaseChanged(phase)
        }
    }
}

struct PrivacyCover: View {
    var body: some View {
        ZStack {
            Color(uiColor: .systemBackground).ignoresSafeArea()
            BrandMark(size: 72)
        }
    }
}

/// The IVE mark from frontend/public/favicon.svg: dark rounded square, blue dot.
struct BrandMark: View {
    var size: CGFloat
    var body: some View {
        RoundedRectangle(cornerRadius: size * 6 / 32, style: .continuous)
            .fill(Color(red: 0x15 / 255, green: 0x17 / 255, blue: 0x1A / 255))
            .frame(width: size, height: size)
            .overlay(
                Circle()
                    .fill(Color(red: 0x5B / 255, green: 0x8C / 255, blue: 0xFF / 255))
                    .frame(width: size * 12 / 32, height: size * 12 / 32)
            )
            .accessibilityHidden(true)
    }
}
