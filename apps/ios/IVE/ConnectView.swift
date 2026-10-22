import SwiftUI

/// First run: "Connect to your Mac" by scanning the pairing QR or pasting the link.
struct ConnectView: View {
    @EnvironmentObject private var settings: AppSettings
    @State private var link = ""
    @State private var error: String?
    @State private var scanning = false
    @FocusState private var fieldFocused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    HStack(spacing: 14) {
                        BrandMark(size: 52)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Connect to your Mac")
                                .font(.title2.weight(.semibold))
                            Text("Everything keeps running on the Mac. This phone shows and types.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.top, 12)

                    VStack(alignment: .leading, spacing: 10) {
                        Step(n: 1, text: "Open IVE on your Mac.")
                        Step(n: 2, text: "Choose \"Pair a phone\". IVE shows a QR code and a link.")
                        Step(n: 3, text: "Scan the code here, or paste the link below.")
                    }

                    Button {
                        scanning = true
                    } label: {
                        Label("Scan QR code", systemImage: "qrcode.viewfinder")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Or paste the pairing link")
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(.secondary)
                        HStack(spacing: 8) {
                            TextField("Pairing link from your Mac", text: $link)
                                .textFieldStyle(.roundedBorder)
                                .keyboardType(.URL)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .submitLabel(.go)
                                .focused($fieldFocused)
                                .onSubmit(connectFromField)
                                .accessibilityIdentifier("pairing-link")
                            PasteButton(payloadType: String.self) { strings in
                                guard let s = strings.first else { return }
                                Task { @MainActor in
                                    link = s
                                    connectFromField()
                                }
                            }
                            .labelStyle(.iconOnly)
                            .buttonBorderShape(.roundedRectangle)
                        }
                        Button(action: connectFromField) {
                            Text("Connect").frame(maxWidth: .infinity)
                        }
                            .buttonStyle(.bordered)
                            .controlSize(.large)
                            .disabled(link.trimmingCharacters(in: .whitespaces).isEmpty)
                        if let error {
                            Text(error)
                                .font(.footnote)
                                .foregroundStyle(.red)
                        }
                    }

                    Text("The phone needs to reach the Mac: same Wi-Fi, or the tunnel link IVE shows when the tunnel is on. The pairing code works once and expires after 5 minutes.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .padding(20)
            }
            .scrollDismissesKeyboard(.interactively)
            .sheet(isPresented: $scanning) {
                ScannerSheet { value in
                    scanning = false
                    link = value
                    connect(value)
                }
            }
        }
    }

    private func connectFromField() {
        fieldFocused = false
        connect(link)
    }

    private func connect(_ raw: String) {
        guard let parsed = PairingLink(raw) else {
            error = "That doesn't look like an IVE link. It should start with http:// or https://."
            return
        }
        error = nil
        settings.connect(parsed)
    }
}

private struct Step: View {
    let n: Int
    let text: String
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("\(n)")
                .font(.footnote.weight(.semibold).monospacedDigit())
                .frame(width: 22, height: 22)
                .background(Circle().fill(Color.accentColor.opacity(0.15)))
            Text(text).font(.callout)
        }
    }
}

private struct ScannerSheet: View {
    let onCode: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                if let problem {
                    VStack(spacing: 12) {
                        Image(systemName: "camera.metering.unknown").font(.largeTitle)
                        Text(problem).multilineTextAlignment(.center)
                        if problem.contains("Settings") {
                            Button("Open Settings") {
                                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                    .foregroundStyle(.white)
                    .padding(30)
                } else {
                    QRScannerView(onCode: { code in
                        guard PairingLink(code) != nil else { return }
                        UINotificationFeedbackGenerator().notificationOccurred(.success)
                        onCode(code)
                    }, onProblem: { problem = $0 })
                    .ignoresSafeArea()
                    RoundedRectangle(cornerRadius: 24)
                        .stroke(.white.opacity(0.9), lineWidth: 3)
                        .frame(width: 250, height: 250)
                }
            }
            .navigationTitle("Scan pairing code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}
