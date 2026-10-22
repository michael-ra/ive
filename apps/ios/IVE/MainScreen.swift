import SwiftUI
import WebKit

/// Full-screen IVE web UI with a reconnect screen when the Mac is away.
struct MainScreen: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var lock: AppLock
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model: WebModel

    init(baseURL: URL) {
        _model = StateObject(wrappedValue: WebModel(baseURL: baseURL, settings: AppSettings.shared))
    }

    var body: some View {
        ZStack {
            Color(uiColor: .systemBackground).ignoresSafeArea()

            WebViewHost(webView: model.webView)
                // Like Safari: WKWebView keeps the page out of the notch and
                // home indicator itself and handles the keyboard, so the web
                // UI's visualViewport logic behaves the same as in the browser.
                .ignoresSafeArea()
                .opacity(model.phase == .ready ? 1 : 0.001)

            switch model.phase {
            case .loading:
                VStack(spacing: 14) {
                    BrandMark(size: 56)
                    ProgressView()
                }
            case .unreachable(let detail):
                ReconnectView(baseURL: model.baseURL, detail: detail,
                              onRetry: model.retry,
                              onSettings: { model.showSettings = true })
            case .ready:
                EmptyView()
            }
        }
        .onAppear { model.start() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.checkReachability() }
        }
        .onChange(of: settings.hideKeyboardAccessory) { _, hide in
            if hide { model.webView.ive_setKeyboardAccessoryHidden() }
        }
        .sheet(isPresented: $model.showSettings) {
            SettingsView(onReload: {
                model.showSettings = false
                model.retry()
            })
            .environmentObject(settings)
            .environmentObject(lock)
        }
    }
}

private struct WebViewHost: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

struct ReconnectView: View {
    let baseURL: URL
    let detail: String
    let onRetry: () -> Void
    let onSettings: () -> Void

    private var hostLabel: String {
        "\(baseURL.host ?? "")\(baseURL.port.map { ":\($0)" } ?? "")"
    }

    private var isLAN: Bool {
        guard let h = baseURL.host else { return false }
        return h.hasPrefix("192.168.") || h.hasPrefix("10.") || h.hasPrefix("172.") || h.hasSuffix(".local")
            || h == "127.0.0.1" || h == "localhost"
    }

    var body: some View {
        ZStack {
            Color(uiColor: .systemBackground).ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Image(systemName: "desktopcomputer.trianglebadge.exclamationmark")
                        .font(.system(size: 44))
                        .foregroundStyle(.orange)
                        .padding(.top, 40)
                    Text("Can't reach your Mac")
                        .font(.title2.weight(.semibold))
                    Text(hostLabel)
                        .font(.callout.monospaced())
                        .foregroundStyle(.secondary)

                    VStack(alignment: .leading, spacing: 10) {
                        Hint(icon: "moon.zzz", text: "Is the Mac awake? A sleeping Mac doesn't answer. Wake it, or set it to not sleep while on power.")
                        if isLAN {
                            Hint(icon: "wifi", text: "This address only works on the same Wi-Fi as the Mac. Away from home, turn on the tunnel in IVE on the Mac and pair with the tunnel link.")
                            Hint(icon: "lock.shield", text: "If iOS asked about Local Network access, allow it: Settings > Privacy & Security > Local Network > IVE.")
                        } else {
                            Hint(icon: "point.3.connected.trianglepath.dotted", text: "Is the tunnel still on? A quick tunnel gets a new address each time it starts; pair again with the new link.")
                        }
                        Hint(icon: "terminal", text: "Is IVE running on the Mac? Start it with ./start.sh.")
                    }

                    Text("Trying again every few seconds…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)

                    Button(action: onRetry) {
                        Label("Try again", systemImage: "arrow.clockwise").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)

                    Button(action: onSettings) {
                        Text("Change Mac or pair again").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.large)

                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                .padding(24)
            }
        }
    }
}

private struct Hint: View {
    let icon: String
    let text: String
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .frame(width: 22)
                .foregroundStyle(.secondary)
            Text(text).font(.callout)
        }
    }
}
