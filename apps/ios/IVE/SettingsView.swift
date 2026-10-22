import SwiftUI

/// Native settings: which Mac, the Face ID lock, keyboard bar, re-pair.
/// Opened from the reconnect screen, with a two-finger double tap on the web
/// UI, or by the web calling `iveNative.openSettings()`.
struct SettingsView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var lock: AppLock
    @Environment(\.dismiss) private var dismiss
    let onReload: () -> Void
    @State private var confirmForget = false

    private let timeouts: [(String, TimeInterval)] = [
        ("Immediately", 0), ("After 1 minute", 60), ("After 5 minutes", 300), ("After 15 minutes", 900),
    ]

    var body: some View {
        NavigationStack {
            Form {
                Section("Mac") {
                    LabeledContent("Address", value: settings.baseURL?.absoluteString ?? "-")
                        .textSelection(.enabled)
                    Button("Reload", action: onReload)
                    Button("Pair again or change Mac", role: .destructive) { confirmForget = true }
                }

                Section {
                    Toggle("Lock with \(AppLock.biometryName)", isOn: $settings.lockEnabled)
                        .disabled(!AppLock.canAuthenticate())
                        .onChange(of: settings.lockEnabled) { _, _ in lock.lockSettingChanged() }
                    Picker("Ask again", selection: $settings.lockTimeout) {
                        ForEach(timeouts, id: \.1) { Text($0.0).tag($0.1) }
                    }
                    .disabled(!settings.lockEnabled)
                } header: {
                    Text("Lock")
                } footer: {
                    if !AppLock.canAuthenticate() {
                        Text("Set a device passcode in iOS Settings to use the lock.")
                    } else {
                        Text("Falls back to your device passcode. The PIN set on the Mac (if any) is asked by the Mac on top of this.")
                    }
                }

                Section {
                    Toggle("Hide iOS keyboard bar", isOn: $settings.hideKeyboardAccessory)
                } header: {
                    Text("Keyboard")
                } footer: {
                    Text("IVE has its own key bar (Esc, Tab, Ctrl, arrows). Showing iOS's bar again takes effect after reopening the app.")
                }

                Section("Notifications") {
                    LabeledContent("Push", value: PushBridge.statusText)
                }

                Section {
                    LabeledContent("Version", value: "\(AppInfo.version) (\(AppInfo.build))")
                } footer: {
                    Text("Tip: a two-finger double tap anywhere opens these settings.")
                }
            }
            .navigationTitle("IVE")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .confirmationDialog("Disconnect this phone?", isPresented: $confirmForget, titleVisibility: .visible) {
                Button("Disconnect and pair again", role: .destructive) {
                    dismiss()
                    settings.forgetMac()
                }
            } message: {
                Text("The app forgets the Mac and its sign-in. To fully revoke the phone, also remove it under Devices in IVE on the Mac.")
            }
        }
    }
}
