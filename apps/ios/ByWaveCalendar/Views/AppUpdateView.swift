import SwiftUI

private struct StoreLookup: Decodable { let results: [StoreRelease] }
private struct StoreRelease: Decodable {
    let trackId: Int
    let bundleId: String
    let version: String
    let releaseNotes: String?
}

struct AppUpdateView: View {
    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var checking = false
    @State private var release: StoreRelease?
    @State private var message: String?
    @State private var checkID = UUID()
    private let storeURL = URL(string: "https://apps.apple.com/app/id6772655143")!
    private let testFlightURL = URL(string: "https://testflight.apple.com/join/rkM3hkpX")!
    private var beta: Bool { Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt" }
    private var newer: Bool { release.map { $0.version.compare(PairingService.appVersion, options: .numeric) == .orderedDescending } ?? false }
    private func t(_ key: String) -> String { ("appUpdate." + key).loc }

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                Image("BrandIcon").resizable().scaledToFit().frame(width: 92, height: 92)
                    .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                    .shadow(color: .black.opacity(0.08), radius: 18, y: 8)
                VStack(spacing: 8) {
                    Text("ByWave Calendar").font(.title2.bold())
                    Text("v\(PairingService.appVersion) (\(SettingsView.buildNumber))").font(.callout.monospacedDigit()).foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 12) {
                        if checking { ProgressView() }
                        else { Image(systemName: newer ? "arrow.down.circle.fill" : "checkmark.shield.fill").foregroundStyle(Theme.brandStart).font(.title2) }
                        Text(t(checking ? "checking" : beta ? "title" : newer ? "available" : release != nil ? "current" : "title")).font(.headline)
                        Spacer()
                    }
                    if let message { Text(message).foregroundStyle(.secondary).font(.callout) }
                    if let release {
                        Text(t("storeVersion") + " · " + release.version).font(.callout.monospacedDigit())
                        if let notes = release.releaseNotes, !notes.isEmpty { Text(notes).font(.callout).textSelection(.enabled) }
                    }
                    Text(t(beta ? "betaHelp" : "help")).font(.footnote).foregroundStyle(.secondary)
                    Button { openURL(beta ? testFlightURL : storeURL) } label: {
                        Label(t(beta ? "testFlight" : "openStore"), systemImage: "arrow.down.circle")
                            .frame(maxWidth: .infinity).padding(.vertical, 5)
                    }.buttonStyle(.borderedProminent)
                    Button { checkID = UUID() } label: { Text(t("check")).frame(maxWidth: .infinity) }
                        .buttonStyle(.bordered).disabled(checking)
                    if !beta { Button(t("testFlight")) { openURL(testFlightURL) }.frame(maxWidth: .infinity) }
                }
                .padding(22).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            }
            .frame(maxWidth: 640).padding(24).frame(maxWidth: .infinity)
        }
        .navigationTitle(t("title")).navigationBarTitleDisplayMode(.inline)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: checking)
        .task(id: checkID) { await check() }
    }

    @MainActor private func check() async {
        checking = true; message = nil
        defer { checking = false }
        do {
            var url = URLComponents(string: "https://itunes.apple.com/lookup")!
            let country = Locale.current.region?.identifier.lowercased() ?? "us"
            url.queryItems = [URLQueryItem(name: "id", value: "6772655143"), URLQueryItem(name: "country", value: country)]
            var request = URLRequest(url: url.url!, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            let (data, response) = try await URLSession.shared.data(for: request)
            guard !Task.isCancelled else { return }
            guard (response as? HTTPURLResponse)?.statusCode == 200, data.count <= 2_000_000 else { throw URLError(.badServerResponse) }
            let lookup = try JSONDecoder().decode(StoreLookup.self, from: data)
            guard let found = lookup.results.first(where: { $0.trackId == 6772655143 && $0.bundleId == Bundle.main.bundleIdentifier }),
                  found.version.range(of: "^[0-9]+(\\.[0-9]+){0,3}$", options: .regularExpression) != nil else {
                release = nil; message = t("unavailable"); return
            }
            release = found
        } catch {
            guard !Task.isCancelled else { return }
            release = nil; message = t("failed")
        }
    }
}
