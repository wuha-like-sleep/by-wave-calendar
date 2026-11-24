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
// Result states surface as overlay sheets:
//   .idle      → camera is live, nothing else
//   .confirm   → a pair code was recognized — STOP and ask first.
//                Nothing has been sent yet. The card shows the account,
//                the server in the code, and the code itself; only the
//                批准登录 tap calls the approve endpoint. Mirrors
//                Android's confirmation dialog. (This flow used to
//                approve the instant the camera decoded a code — the
//                only zero-confirmation action in the app, and the one
//                with the heaviest consequence: whoever hands you a
//                code to "just scan" walked away with your account.)
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
    private enum PairKind: Equatable { case desktop, web }

    private enum Phase: Equatable {
        case idle
        case confirm(ParsedPair)
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

    /// Account label for the confirmation card: "名字 · 邮箱", whichever
    /// parts the active profile has (same shape as Android's dialog).
    private var accountLabel: String {
        let parts = [state.currentUserName, state.currentUserEmail]
            .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        return parts.isEmpty ? "—" : parts.joined(separator: " · ")
    }

    /// Host (with port) of the server the active profile is signed in
    /// to — compared against the host inside the scanned code.
    private var myServerHost: String { Self.host(of: state.serverURL) }

    private func detailRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(label)
                .font(.subheadline).foregroundStyle(.secondary)
            Text(value)
                .font(.subheadline).fontWeight(.medium)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private var resultCard: some View {
        VStack(spacing: 14) {
            switch phase {
            case .confirm(let parsed):
                // The scan stop-point. Information order mirrors
                // Android's confirmation dialog: what happens, account,
                // server, code, host-mismatch warning, the
                // only-approve-your-own warning, and the honest note
                // that the server offers no requester details.
                VStack(alignment: .leading, spacing: 10) {
                    Text("要批准这次登录吗？".loc)
                        .font(.headline)
                        .frame(maxWidth: .infinity, alignment: .center)
                    Text((parsed.kind == .web
                         ? "批准后，那个浏览器会以下面这个账号登录，能看到并修改你的全部日历。"
                         : "批准后，这台电脑会以下面这个账号登录，能看到并修改你的全部日历。").loc)
                        .font(.subheadline)
                    detailRow("账号".loc, accountLabel)
                    detailRow("服务器".loc, parsed.host.isEmpty ? "—" : parsed.host)
                    detailRow("配对码".loc, parsed.code)
                    if !parsed.host.isEmpty && !myServerHost.isEmpty
                        && parsed.host.caseInsensitiveCompare(myServerHost) != .orderedSame {
                        Text("这个码来自另一台服务器：%@；你现在登录的是 %@。".locFormat(parsed.host, myServerHost))
                            .font(.footnote).foregroundStyle(.red)
                    }
                    Text("只有你自己刚刚在电脑上发起了这次登录，才应该批准。别人拿给你「扫一下」的码，扫完就等于把账号交给了他。".loc)
                        .font(.footnote).foregroundStyle(.red)
                    Text("服务器没有提供发起方的更多信息（设备、IP、时间）。".loc)
                        .font(.footnote).foregroundStyle(.secondary)
                    HStack(spacing: 12) {
                        Button("取消".loc) { dismiss() }
                            .buttonStyle(.bordered)
                        Spacer()
                        Button("批准登录".loc) { approve(parsed) }
                            .buttonStyle(.borderedProminent)
                            .tint(.red)
                    }
                    .padding(.top, 4)
                }
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
        // Not signed in → there is nothing to approve with. Say so now
        // instead of after a confirmation tap (Android's NotSignedIn
        // branch does the same).
        guard state.isSignedIn else {
            phase = .error("未登录。请先登录后再扫码。".loc)
            return
        }
        // STOP. Scanning alone sends nothing — the confirmation card
        // shows what would happen and approve() runs only on an
        // explicit 批准登录 tap. Cancelling just dismisses.
        phase = .confirm(parsed)
    }

    /// The only path that talks to the server, and it is reachable
    /// exclusively from the confirmation card's 批准登录 button.
    private func approve(_ parsed: ParsedPair) {
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

    /// Parsed pair-code + which flow matched + the host the code
    /// points at (display + mismatch warning only — the approve
    /// request always goes to the active profile's own server).
    private struct ParsedPair: Equatable {
        let code: String
        let kind: PairKind
        let host: String
    }

    /// "https://cal.example.com:8443/x" → "cal.example.com:8443".
    /// Empty string when the URL has no host part we can read.
    private static func extractHost(from raw: String) -> String {
        let nsRange = NSRange(raw.startIndex..., in: raw)
        let pattern = #"https?://([^/\s]+)"#
        guard
            let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
            let match = regex.firstMatch(in: raw, range: nsRange),
            match.numberOfRanges >= 2,
            let range = Range(match.range(at: 1), in: raw)
        else { return "" }
        return String(raw[range])
    }

    /// Host (with port) of a server URL, for the mismatch comparison.
    private static func host(of url: URL?) -> String {
        guard let url else { return "" }
        var h = url.host ?? ""
        if let p = url.port { h += ":\(p)" }
        return h
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
        let host = extractHost(from: raw)
        let desktopPattern = #"https?://[^\s/]+(?:/[^\s/]+)*/desktop-pair/([A-Z0-9]{6,16})"#
        if
            let regex = try? NSRegularExpression(pattern: desktopPattern, options: [.caseInsensitive]),
            let match = regex.firstMatch(in: raw, range: nsRange),
            match.numberOfRanges >= 2,
            let range = Range(match.range(at: 1), in: raw)
        {
            return ParsedPair(code: String(raw[range]).uppercased(), kind: .desktop, host: host)
        }
        let webPattern = #"https?://[^\s/]+(?:/[^\s/]+)*/web-pair/([A-Z0-9]{6,16})"#
        if
            let regex = try? NSRegularExpression(pattern: webPattern, options: [.caseInsensitive]),
            let match = regex.firstMatch(in: raw, range: nsRange),
            match.numberOfRanges >= 2,
            let range = Range(match.range(at: 1), in: raw)
        {
            return ParsedPair(code: String(raw[range]).uppercased(), kind: .web, host: host)
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
        case .refreshFailed:
            return "登录已失效，请重新登录后再试。".loc
        case .deviceRevoked:
            return "密码已更改或此设备已被移除，请重新登录后再试。".loc
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
