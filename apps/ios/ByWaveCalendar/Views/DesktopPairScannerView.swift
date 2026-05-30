// Scan-to-login flow. Mirrors Android DesktopPairScannerScreen.
//
// Two QR sources are accepted (auto-detected from the encoded URL):
//
//   1. Desktop app pair-init QR — `<server>/desktop-pair/<CODE>`.
//      Approves via POST /api/v1/devices/desktop-pair-approve. The
//      desktop's poll picks up refresh + access tokens.
//
//   2. Web /login scan-login QR — `<server>/web-pair/<CODE>`.
//      Approves via POST /api/v1/devices/web-pair-approve. The
//      browser's poll picks up the approval and the server plants
//      a session cookie on the polling browser.
//
// Four result states surface as overlay sheets:
//   .idle      → camera is live, nothing else
//   .sending   → spinner + "正在批准…"
//   .success   → ✓ + "电脑端正在自动登录" or "网页端正在自动登录"
//   .error     → ! + server's message
//   .notQR     → "二维码无法识别" + hint about where to find the right QR

import SwiftUI

struct DesktopPairScannerView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss

    /// Which pair-flow the scanned URL matched. Picks the endpoint and
    /// success-screen copy.
    private enum PairKind { case desktop, web }

    private enum Phase: Equatable {
        case idle
        case sending
        case success(PairKind)
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
            case .success(let kind):
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(.green)
                Text("已批准").font(.headline)
                Text((kind == .web
                     ? "网页端正在自动登录。可以回到电脑浏览器前继续操作。"
                     : "电脑端正在自动登录。可以回到电脑前继续操作。").loc)
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
                Text("这个二维码不像登录码。请确认扫描的是电脑端或网页端的登录二维码。")
                    .font(.subheadline).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Text("提示：电脑端「登录 ByWave Calendar」或网页 /login 的「扫码登录」标签都会显示二维码。")
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
        guard let parsed = Self.extractPairCode(from: raw) else {
            phase = .notQR
            return
        }
        phase = .sending
        Task {
            do {
                let client = APIClient(state: state)
                struct Body: Encodable { let code: String }
                struct Resp: Decodable {}
                let path = parsed.kind == .web
                    ? "/devices/web-pair-approve"
                    : "/devices/desktop-pair-approve"
                let _: Resp = try await client.post(
                    path,
                    body: Body(code: parsed.code),
                )
                let approvedKind = parsed.kind
                await MainActor.run { phase = .success(approvedKind) }
            } catch let e as APIError {
                await MainActor.run { phase = .error(Self.friendlyMessage(e)) }
            } catch {
                await MainActor.run {
                    phase = .error(error.localizedDescription)
                }
            }
        }
    }

    /// Parsed pair-code + which flow matched.
    private struct ParsedPair {
        let code: String
        let kind: PairKind
    }

    /// Extract the 8-char code from either:
    ///   `https://<server>/desktop-pair/<CODE>`  (desktop app pair)
    ///   `https://<server>/web-pair/<CODE>`      (web /login scan-login)
    /// Returns the code + matched kind, or nil for any other text.
    /// Lenient on scheme + intermediate path segments so reverse-proxy
    /// deployments with a path prefix still work. 6-16 char window keeps
    /// forward compatibility if we change the code length later.
    private static func extractPairCode(from raw: String) -> ParsedPair? {
        let nsRange = NSRange(raw.startIndex..., in: raw)
        let desktopPattern = #"https?://[^\s/]+(?:/[^\s/]+)*/desktop-pair/([A-Z0-9]{6,16})"#
        if
            let regex = try? NSRegularExpression(pattern: desktopPattern, options: [.caseInsensitive]),
            let match = regex.firstMatch(in: raw, range: nsRange),
            match.numberOfRanges >= 2,
            let range = Range(match.range(at: 1), in: raw)
        {
            return ParsedPair(code: String(raw[range]).uppercased(), kind: .desktop)
        }
        let webPattern = #"https?://[^\s/]+(?:/[^\s/]+)*/web-pair/([A-Z0-9]{6,16})"#
        if
            let regex = try? NSRegularExpression(pattern: webPattern, options: [.caseInsensitive]),
            let match = regex.firstMatch(in: raw, range: nsRange),
            match.numberOfRanges >= 2,
            let range = Range(match.range(at: 1), in: raw)
        {
            return ParsedPair(code: String(raw[range]).uppercased(), kind: .web)
        }
        return nil
    }

    private static func friendlyMessage(_ e: APIError) -> String {
        switch e {
        case .notSignedIn:
            return "未登录。请先登录后再扫码。".loc
        case .network(let inner):
            return inner.localizedDescription
        case .decode(let inner):
            return "服务器响应解析失败：%@".locFormat(inner.localizedDescription)
        case .refreshFailed(let status):
            return "登录已过期 (HTTP %lld)，请重新登录后再试。".locFormat(status)
        case .server(let status, _):
            switch status {
            case 404: return "二维码已过期或无效，请让电脑端重新生成。".loc
            case 409: return "这个登录码已经被使用过了。".loc
            case 403: return "服务器已禁用 APP 登录。".loc
            default:  return "服务器返回 %lld。".locFormat(status)
            }
        }
    }
}
