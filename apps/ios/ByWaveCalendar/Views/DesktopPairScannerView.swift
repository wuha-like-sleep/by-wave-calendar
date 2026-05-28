// Scan-to-login-desktop flow. Mirrors Android DesktopPairScannerScreen.
//
// The desktop's QR encodes a plain HTTPS URL of the form
// `<server>/desktop-pair/<CODE>` — so a phone without ByWave installed
// can still scan it with the iOS system Camera and approve via the web
// flow. When the user IS in the app, this view short-circuits the
// browser bounce: ScannerView fires raw text → we regex out the 8-char
// CODE → POST /api/v1/devices/desktop-pair-approve with the user's
// access token → desktop's polling picks up the approval.
//
// Four result states surface as overlay sheets:
//   .idle      → camera is live, nothing else
//   .sending   → spinner + "正在批准…"
//   .success   → ✓ + "电脑端正在自动登录"
//   .error     → ! + server's message
//   .notQR     → "二维码无法识别" + hint about where to find the right QR

import SwiftUI

struct DesktopPairScannerView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss

    private enum Phase: Equatable {
        case idle
        case sending
        case success
        case error(String)
        case notQR
    }

    @State private var phase: Phase = .idle

    var body: some View {
        ZStack {
            // ScannerView's onResult fires exactly once (it locks the
            // camera after first decode). We hand the raw text to the
            // approve flow; the result phase drives the overlay.
            ScannerView { result in
                switch result {
                case .success(let raw):
                    handleScanned(raw)
                case .failure(let message):
                    phase = .error(message)
                }
            }

            // Result overlay — semi-transparent backdrop + a small card
            // with the current phase. Tapping outside dismisses on
            // terminal states (success/error/notQR) but not during
            // sending (don't let the user think they cancelled while
            // the network call is in flight).
            if phase != .idle {
                Color.black.opacity(0.35).ignoresSafeArea()
                resultCard
                    .padding(.horizontal, 28)
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.18), value: phase)
        .toolbar(.hidden, for: .navigationBar)
    }

    @ViewBuilder
    private var resultCard: some View {
        VStack(spacing: 14) {
            switch phase {
            case .sending:
                ProgressView().controlSize(.large)
                Text("正在批准…").font(.headline)
                Text("正在让电脑端登录，请稍候。")
                    .font(.subheadline).foregroundStyle(.secondary)
            case .success:
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(.green)
                Text("已批准").font(.headline)
                Text("电脑端正在自动登录。可以回到电脑前继续操作。")
                    .font(.subheadline).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button("完成") { dismiss() }
                    .buttonStyle(.borderedProminent)
                    .padding(.top, 4)
            case .error(let message):
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 40))
                    .foregroundStyle(.orange)
                Text("批准失败").font(.headline)
                Text(message)
                    .font(.subheadline).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button("关闭") { dismiss() }
                    .buttonStyle(.borderedProminent)
                    .padding(.top, 4)
            case .notQR:
                Image(systemName: "qrcode.viewfinder")
                    .font(.system(size: 40))
                    .foregroundStyle(.secondary)
                Text("二维码无法识别").font(.headline)
                Text("这个二维码不像电脑端的登录码。请确认在电脑端看到的二维码上扫描。")
                    .font(.subheadline).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Text("提示：电脑端 ByWave Calendar → 用手机扫码登录 会显示一个二维码。")
                    .font(.caption).foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                Button("关闭") { dismiss() }
                    .buttonStyle(.borderedProminent)
                    .padding(.top, 4)
            case .idle:
                EmptyView()
            }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 24)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18))
    }

    private func handleScanned(_ raw: String) {
        guard let code = Self.extractDesktopPairCode(from: raw) else {
            phase = .notQR
            return
        }
        phase = .sending
        Task {
            do {
                let client = APIClient(state: state)
                struct Body: Encodable { let code: String }
                struct Resp: Decodable {}
                let _: Resp = try await client.post(
                    "/devices/desktop-pair-approve",
                    body: Body(code: code),
                )
                await MainActor.run { phase = .success }
            } catch let e as APIError {
                await MainActor.run { phase = .error(Self.friendlyMessage(e)) }
            } catch {
                await MainActor.run {
                    phase = .error(error.localizedDescription)
                }
            }
        }
    }

    /// Extract the 8-char code from a `https://<server>/desktop-pair/<CODE>`
    /// URL. Lenient on scheme + intermediate path segments so deployments
    /// behind a reverse-proxy with a path prefix still work. Returns nil
    /// when the scanned text isn't a desktop-pair URL.
    private static func extractDesktopPairCode(from raw: String) -> String? {
        // Server emits 8 uppercase-alphanumeric chars; allow 6-16 to be
        // forward-compatible if we change the length later.
        let pattern = #"https?://[^\s/]+(?:/[^\s/]+)*/desktop-pair/([A-Z0-9]{6,16})"#
        guard
            let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
            let match = regex.firstMatch(
                in: raw,
                range: NSRange(raw.startIndex..., in: raw),
            ),
            match.numberOfRanges >= 2,
            let range = Range(match.range(at: 1), in: raw)
        else {
            return nil
        }
        return String(raw[range]).uppercased()
    }

    private static func friendlyMessage(_ e: APIError) -> String {
        switch e {
        case .notSignedIn:
            return "未登录。请先登录后再扫码。"
        case .network(let inner):
            return inner.localizedDescription
        case .server(let status, _):
            switch status {
            case 404: return "二维码已过期或无效，请让电脑端重新生成。"
            case 409: return "这个登录码已经被使用过了。"
            case 403: return "服务器已禁用 APP 登录。"
            default:  return "服务器返回 \(status)。"
            }
        }
    }
}
