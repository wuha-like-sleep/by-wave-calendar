// AppState.swift
// Global state, refactored in v0.10.0 to support multiple signed-in
// profiles (Google-style account switcher).
//
// One Profile == one signed-in account on one server. Each Profile has
// its own Keychain-stored refresh token (scoped by Profile.id), its own
// EventCache namespace, and its own email / display name. The active
// profile is the one currently driving the UI; switching profiles is a
// matter of re-pointing `activeProfileId` and reloading.
//
// Legacy compat: builds before v0.10.0 stored everything under unscoped
// keys (bwc.serverURL, bwc.refreshToken, bwc.userEmail). On first launch
// of v0.10.0 we migrate those into a single Profile so the existing
// signed-in user isn't kicked out.

import Foundation
import Combine
import SwiftUI

enum AppearanceMode: String, CaseIterable, Identifiable {
    case system
    case light
    case dark
    var id: String { rawValue }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }

    var label: String {
        switch self {
        case .system: return "跟随系统"
        case .light: return "浅色"
        case .dark: return "深色"
        }
    }
}

/// One just-deleted event, offered for undo via the snackbar in
/// CalendarView (对齐 Android 0.11.1 的「已删除 · 撤销」). `token`
/// distinguishes successive deletes so the 5s auto-dismiss timer of an
/// older snackbar can't dismiss a newer one.
struct PendingUndoDelete: Equatable {
    let eventId: String
    let summary: String
    let token: UUID
}

/// 「某个账号被服务端登出了，已经换到另一个账号」的提示。CalendarView 把它摆在
/// 日历顶上（导航栏下面），用户点 × 才消失。
///
/// 换过去这件事不能是悄悄的：不说的话，用户会以为自己还在原来那个账号里。
/// 这里只记被登出的是谁；「现在用的是谁」在显示时从当前账号现取，
/// 所以之后再切账号也不会写错。
struct AccountNotice: Equatable {
    /// 被登出的那个账号。它重新登录成功、或被移除时，提示跟着消失。
    let profileId: String
    /// 被登出的账号在提示里叫什么（一般就是邮箱）。
    let accountLabel: String
    /// 它所在的服务器。只在两个账号邮箱一样（不同服务器）时拿来区分。
    let accountHost: String
}

@MainActor
final class AppState: ObservableObject {
    // MARK: - Published state

    /// All profiles the user has ever added (signed-in OR signed-out).
    /// Sorted by most-recently-used first when shown in the switcher.
    @Published var profiles: [Profile] = []
    /// Currently driving the UI. Nil means SetupView gets shown.
    @Published var activeProfileId: String?

    /// True while bootstrap is in flight (silent refresh attempt). UI
    /// shows the splash overlay while this is true.
    @Published var isBootstrapping: Bool = true

    /// True when the active profile has a working refresh + access
    /// token. Drives Setup ↔ Calendar branching in RootView.
    @Published var isSignedIn: Bool = false

    /// 上一次被动登出的原因，显示在配对页顶部。
    ///
    /// 为什么需要它：设备被吊销（改密码 / 重置密码 / 后台移除）时，
    /// 用户看到的只是一个空白配对页——分不清是自己被踢了、还是网络有问题、
    /// 还是 App 坏了。把原因带过来，他才知道该做什么。
    /// 用户开始重新配对时由 SetupView 清空。
    @Published var signedOutReason: String?

    /// 被服务端登出、但本机还有别的已登录账号时，切过去之后显示的提示。
    /// 见 AccountNotice。
    @Published var accountNotice: AccountNotice?

    func dismissAccountNotice() {
        accountNotice = nil
    }

    /// User-chosen appearance override (跟随系统 / 浅色 / 深色). Cross-
    /// profile setting — persisted globally, not per profile.
    @Published var appearance: AppearanceMode = AppearanceMode(rawValue:
        UserDefaults.standard.string(forKey: "bwc.appearance") ?? ""
    ) ?? .system {
        didSet { UserDefaults.standard.set(appearance.rawValue, forKey: Self.appearanceKey) }
    }

    /// Brand accent for the current profile. Mirrored from
    /// activeProfile.themeAccentHex; falls back to brand purple. Kept
    /// as @Published so the .tint modifier at the root re-renders
    /// when the user switches profile or server admin updates the
    /// palette.
    @Published var themeAccentHex: String = UserDefaults.standard.string(forKey: "bwc.themeAccent") ?? "#4F46E5"
    var themeAccent: Color {
        Color(hex: themeAccentHex) ?? Color(red: 79/255, green: 70/255, blue: 229/255)
    }

    /// Backwards-compat: what server version are we talking to, and
    /// which iOS-facing features does it support. Refreshed alongside
    /// the theme on every bootstrap + profile switch. Defaults to
    /// .unknown which optimistically enables every feature (so a brand
    /// new server we haven't probed yet doesn't get UI hidden).
    @Published var serverCapabilities: ServerCapabilities = .unknown

    /// Set right after a successful series-scope delete; CalendarView
    /// overlays the undo snackbar while non-nil. Instance/future-scoped
    /// deletes of recurring events never set this — POST /restore can't
    /// undo an exdate/UNTIL edit, only a soft-delete.
    @Published var pendingUndoDelete: PendingUndoDelete?

    func noteEventDeleted(id: String, summary: String) {
        pendingUndoDelete = PendingUndoDelete(eventId: id, summary: summary, token: UUID())
    }

    /// Hidden calendar IDs — cross-profile to match legacy behavior.
    /// Could become per-profile in a future refactor but most users
    /// only have one server, so global is fine for now.
    @Published var hiddenCalendarIds: Set<String> = Set(
        UserDefaults.standard.stringArray(forKey: "bwc.hiddenCalendarIds") ?? []
    ) {
        didSet {
            UserDefaults.standard.set(Array(hiddenCalendarIds), forKey: Self.hiddenCalsKey)
        }
    }

    // MARK: - Access token (in-memory only)

    /// Per-active-profile access JWT + expiry. Wiped on profile switch
    /// so the next API call refreshes from the new profile's refresh
    /// token. Never persisted.
    private(set) var accessToken: String?
    private var accessTokenExpiresAt: Date?

    // MARK: - UserDefaults keys

    private static let profilesKey = "bwc.profiles"
    private static let activeProfileKey = "bwc.activeProfileId"
    private static let appearanceKey = "bwc.appearance"
    private static let hiddenCalsKey = "bwc.hiddenCalendarIds"
    // Legacy keys from pre-multi-account builds — only read for migration.
    private static let legacyServerURLKey = "bwc.serverURL"
    private static let legacyUserEmailKey = "bwc.userEmail"
    private static let legacyUserNameKey = "bwc.userName"

    // MARK: - Convenience accessors (active profile)

    /// Active profile's server URL. Read by every API call.
    var serverURL: URL? { activeProfile?.serverURL }
    var currentUserEmail: String? { activeProfile?.userEmail }
    var currentUserName: String? { activeProfile?.userName }
    var activeProfile: Profile? {
        guard let id = activeProfileId else { return nil }
        return profiles.first(where: { $0.id == id })
    }

    func visibleEvents(_ events: [EventDTO]) -> [EventDTO] {
        if hiddenCalendarIds.isEmpty { return events }
        return events.filter { !hiddenCalendarIds.contains($0.calendarId) }
    }

    // MARK: - Bootstrap

    init() {
        loadProfiles()
        Task { await bootstrap() }
    }

    /// Read persisted profiles + migrate legacy single-profile state
    /// from older versions.
    private func loadProfiles() {
        if let data = UserDefaults.standard.data(forKey: Self.profilesKey),
           let decoded = try? JSONDecoder.iso().decode([Profile].self, from: data)
        {
            profiles = decoded
        }
        activeProfileId = UserDefaults.standard.string(forKey: Self.activeProfileKey)

        // Migration: if no profiles yet but the legacy bwc.serverURL +
        // bwc.refreshToken are present, lift them into a single profile.
        if profiles.isEmpty,
           let urlStr = UserDefaults.standard.string(forKey: Self.legacyServerURLKey),
           let legacyToken = Keychain.read(.legacyRefreshToken)
        {
            let id = UUID().uuidString
            let migrated = Profile(
                id: id,
                serverURLString: urlStr,
                userEmail: UserDefaults.standard.string(forKey: Self.legacyUserEmailKey),
                userName: UserDefaults.standard.string(forKey: Self.legacyUserNameKey),
                themeAccentHex: UserDefaults.standard.string(forKey: "bwc.themeAccent"),
                lastUsedAt: Date(),
            )
            // Move the refresh token to the scoped key, then nuke legacy.
            Keychain.write(.refreshToken(profileId: id), value: legacyToken)
            Keychain.delete(.legacyRefreshToken)
            UserDefaults.standard.removeObject(forKey: Self.legacyServerURLKey)
            UserDefaults.standard.removeObject(forKey: Self.legacyUserEmailKey)
            UserDefaults.standard.removeObject(forKey: Self.legacyUserNameKey)

            profiles = [migrated]
            activeProfileId = id
            persistProfiles()
        }

        // Validate active id — if it points to a deleted profile, snap
        // to the most-recent surviving one (or nil if none).
        if let id = activeProfileId, !profiles.contains(where: { $0.id == id }) {
            activeProfileId = profiles.sorted(by: { $0.lastUsedAt > $1.lastUsedAt }).first?.id
        }

        // If we have profiles but no active selection, pick the most
        // recent one.
        if activeProfileId == nil, let mostRecent = profiles.sorted(by: { $0.lastUsedAt > $1.lastUsedAt }).first {
            activeProfileId = mostRecent.id
        }

        // Sync accent hex from active profile (if it has one).
        if let accent = activeProfile?.themeAccentHex, !accent.isEmpty {
            themeAccentHex = accent
        }
    }

    /// Try to silently refresh the active profile's access token. Called
    /// once at launch.
    func bootstrap() async {
        guard let activeId = activeProfileId else {
            isSignedIn = false
            isBootstrapping = false
            return
        }
        // Probe for the refresh token under this profile's scope.
        guard Keychain.read(.refreshToken(profileId: activeId)) != nil else {
            isSignedIn = false
            isBootstrapping = false
            return
        }
        let signedIn: Bool
        do {
            try await refreshIfNeeded(force: true)
            signedIn = true
        } catch APIError.deviceRevoked {
            // 服务端明确说这台设备不认了（改密码 / 重置密码 / 后台移除设备）。
            // refreshIfNeeded 里已经交给 handleSessionRevoked 处理过了：
            // 本机还有别的账号就已经切过去（下面的 guard 会让位给那一次切换），
            // 没有就停在登录页。
            signedIn = false
        } catch APIError.notSignedIn {
            // 真的没有凭据可用（profile 没了 / Keychain 读不到）。
            signedIn = false
        } catch {
            // **网络不好、服务器挂了、DNS 解析不了，一律不算「没登录」。**
            //
            // refreshIfNeeded 特意把 401 和这些分开了（见那边的注释：前者要登出，
            // 后者应当保持登录、继续用离线缓存），而这里原来是一个 catch 全抹平：
            // 飞机上、地铁里、或者服务器抖一下，打开 App 看到的就是登录页 ——
            // 而他的账号什么事都没有。重新登一次又好了，于是这事看起来很随机。
            //
            // 凭据还在 Keychain 里，保持登录状态；下一次请求会自己再试一次刷新，
            // 真被吊销了那一次会走上面的 deviceRevoked 分支。
            signedIn = true
        }
        // 等刷新的这段时间里换过账号了（被吊销后自动切到别的账号、或用户自己切）：
        // 这一次的结果属于上一个账号，不许拿来定当前账号是不是登录着 ——
        // 换账号的那一步自己会再跑一次 bootstrap 收尾。
        // 不看的话，「A 被吊销 → 自动切到 B」之后 A 这边会再补一句
        // isSignedIn = false，B 明明登录着却被扔到登录页。
        guard activeProfileId == activeId else { return }
        // 兜底：凭据已经被收掉（不管是哪条路收的），就不能算登录着。
        isSignedIn = signedIn && Keychain.read(.refreshToken(profileId: activeId)) != nil
        isBootstrapping = false
        // Fire-and-forget theme fetch for the active profile.
        Task { await self.refreshThemeFromServer() }
    }

    /// Pull /api/v1/health/app and update the active profile's theme
    /// PLUS the cached `serverCapabilities` so the rest of the APP can
    /// branch on what the server supports. Older servers don't have
    /// /api/v1/health/app — we fall back to the much older /health
    /// (which only returns version + status, no theme).
    func refreshThemeFromServer() async {
        guard let serverURL else { return }
        let base = serverURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))

        // Try the modern endpoint first (v0.7.4+).
        var payload: [String: Any]?
        if let url = URL(string: base + "/api/v1/health/app") {
            var req = URLRequest(url: url)
            req.timeoutInterval = 8
            if let (data, resp) = try? await URLSession.shared.data(for: req),
               let http = resp as? HTTPURLResponse,
               (200..<300).contains(http.statusCode)
            {
                let outer = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
                payload = (outer["data"] as? [String: Any]) ?? outer
            }
        }

        // Fall back to /health for older servers. Only gives us version,
        // not theme — accent stays at the previously-cached value.
        if payload == nil, let url = URL(string: base + "/health") {
            var req = URLRequest(url: url)
            req.timeoutInterval = 8
            if let (data, _) = try? await URLSession.shared.data(for: req) {
                payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            }
        }

        guard let payload else { return }

        // Update ServerCapabilities from the payload. `.from` reads the
        // explicit `capabilities` object + `capabilityVersion` when the
        // server reports them (new servers, #77), and degrades to
        // version-only inference for old servers / the /health fallback.
        if (payload["version"] as? String)?.isEmpty == false || payload["capabilities"] != nil {
            serverCapabilities = ServerCapabilities.from(payload: payload)
        }

        // Update theme only when the response actually has the field
        // (newer endpoint only).
        if let accent = payload["themeAccent"] as? String, !accent.isEmpty {
            themeAccentHex = accent
            UserDefaults.standard.set(accent, forKey: "bwc.themeAccent")
            if let id = activeProfileId,
               let idx = profiles.firstIndex(where: { $0.id == id })
            {
                profiles[idx].themeAccentHex = accent
                persistProfiles()
            }
        }
    }

    // MARK: - Profile lifecycle

    /// Called by SetupView after a successful pair-claim / login. If a
    /// profile already exists for (serverURL, userEmail), updates it in
    /// place (refreshing the token). Otherwise creates a new profile.
    func completePairing(serverURL: URL, refreshToken: String, accessToken: String, accessTokenExpiresAt: Date, userEmail: String?, userName: String?) {
        // 重新登录成功，上一次被踢的提示就该消失了。
        signedOutReason = nil
        // De-dup: same server + same email = same profile.
        let urlStr = serverURL.absoluteString
        let existingIdx = profiles.firstIndex(where: { p in
            p.serverURLString == urlStr && (p.userEmail ?? "") == (userEmail ?? "")
        })
        let profileId: String
        if let idx = existingIdx {
            profileId = profiles[idx].id
            profiles[idx].userEmail = userEmail ?? profiles[idx].userEmail
            profiles[idx].userName = userName ?? profiles[idx].userName
            profiles[idx].lastUsedAt = Date()
            if let accent = profiles[idx].themeAccentHex, !accent.isEmpty {
                themeAccentHex = accent
            }
        } else {
            let p = Profile(
                id: UUID().uuidString,
                serverURLString: urlStr,
                userEmail: userEmail,
                userName: userName,
                themeAccentHex: nil,
                lastUsedAt: Date(),
            )
            profileId = p.id
            profiles.append(p)
        }
        // 「添加另一个账号」登进去的是别的账号时，界面要整个换过去。
        //
        // 以前这里只改了 activeProfileId：日历视图不会重新挂载，手上还是上一个账号
        // 的日程，要等最长 60 秒的下一次轮询才换 —— 而右上角的头像已经换成了新账号，
        // 用户看到的是「新账号的头像 + 旧账号的日程」。
        // 现在和 switchProfile 一样先收掉上一个账号的界面状态和系统日历镜像；
        // 日历视图靠 RootView 上的 .id(activeProfileId) 整个重新挂载，当场读新账号的数据。
        // 不必像 switchProfile 那样再跑一次 bootstrap：刚登录拿到的令牌就是新的。
        if profileId != activeProfileId {
            endActiveSession()
            EventKitMirror.shared.tearDown()
        }
        Keychain.write(.refreshToken(profileId: profileId), value: refreshToken)
        activeProfileId = profileId
        self.accessToken = accessToken
        self.accessTokenExpiresAt = accessTokenExpiresAt
        isSignedIn = true
        isBootstrapping = false
        // 被登出的那个账号重新登进来了，「它被登出了」的提示就过期了。
        if accountNotice?.profileId == profileId { accountNotice = nil }
        persistProfiles()
        Task { await self.refreshThemeFromServer() }
    }

    /// Switch to a previously-added profile. If that profile is signed
    /// out (no refresh token), it shows SetupView pre-filled. Otherwise
    /// it silently refreshes and the calendar loads with new data.
    func switchProfile(to id: String) {
        guard let idx = profiles.firstIndex(where: { $0.id == id }) else { return }
        // Clear in-memory token (and per-account UI state) from old profile.
        endActiveSession()
        activeProfileId = id
        profiles[idx].lastUsedAt = Date()
        if let accent = profiles[idx].themeAccentHex {
            themeAccentHex = accent
        }
        persistProfiles()
        // 提醒现在按账号分命名空间，切账号**不清**其它账号的 ——
        // 两个账号都是用户自己加上去的，切到 B 就把 A 的提醒静音掉会很意外，
        // 而通知正文里本来就带着日历名，分得清是哪一个。
        EventKitMirror.shared.tearDown()
        // Re-bootstrap to refresh access token + theme for the new profile.
        rebootstrap()
    }

    /// Soft sign-out: clear refresh token for the active profile but
    /// KEEP the profile entry in the list (so the user can sign back
    /// in without re-typing the host). UI flips to SetupView.
    ///
    /// 这是用户自己点的「退出登录」。服务端把人登出走的是 handleSessionRevoked。
    func signOut() {
        guard let profile = activeProfile else { return }
        // 人要回登录页了；别等他下次登进来，日历顶上又冒出一条早就过去的提示。
        accountNotice = nil
        retireCredentials(of: profile)
        endActiveSession()
        isSignedIn = false
        // Stay on the same activeProfileId — SetupView pre-fills its URL.
    }

    /// Hard remove a profile from the list. Used by the switcher's
    /// "remove account" swipe action.
    func removeProfile(id: String) {
        guard let removed = profiles.first(where: { $0.id == id }) else { return }
        let wasActive = (id == activeProfileId)
        // 和退出登录收的是同一份清单。以前这里只删了 refresh token 和离线缓存，
        // 那个账号排好的本地提醒会一直弹下去（正文就是它的日程标题），
        // 而提醒是按账号 id 分段的 —— 账号从列表里消失以后，再也没有办法清掉它们。
        retireCredentials(of: removed)
        profiles.removeAll(where: { $0.id == id })
        if accountNotice?.profileId == id { accountNotice = nil }
        guard wasActive else {
            persistProfiles()
            return
        }
        // 移除的是正在显示的账号：换到别的账号上，让日历整个重新挂载、重新加载。
        // 以前只是改了 activeProfileId，日历视图还捧着被移除账号的日程，
        // 要等最长 60 秒后的下一次轮询才换掉。
        // 优先换到还登录着的那个；都没登录就换到最近用过的（会落到登录页，和以前一样）。
        endActiveSession()
        if let next = mostRecentSignedInProfile(excluding: id)
            ?? profiles.max(by: { $0.lastUsedAt < $1.lastUsedAt })
        {
            switchProfile(to: next.id)
        } else {
            activeProfileId = nil
            isSignedIn = false
            persistProfiles()
        }
    }

    /// 服务端不再认 `profileId` 在这台设备上的登录了：refresh 回 401
    /// （改密码 / 重置密码 / 后台移除设备 / 后台停用账号都会这样）。
    ///
    /// 三端统一的规矩：
    ///   · 本机还登着别的账号 → 切到最近用过的那个，**同时**在日历顶上挂一条提示，
    ///     写清是哪个账号被登出、为什么；用户点 × 才消失。
    ///   · 没有别的账号了 → 回登录页，登录页上写原因。
    /// 以前不管有没有别的账号都直接回登录页，而登录页上够不着本机别的账号。
    private func handleSessionRevoked(profileId: String) {
        guard let revoked = profiles.first(where: { $0.id == profileId }) else { return }
        retireCredentials(of: revoked)
        let notice = AccountNotice(
            profileId: profileId,
            accountLabel: revoked.displayLabel,
            accountHost: revoked.displaySubtitle,
        )
        guard profileId == activeProfileId else {
            // 刷新请求还在路上时用户已经自己切走了：只收拾被登出的那个账号，
            // 当前界面不动 —— 但仍然要告诉他那个账号被登出了。
            accountNotice = notice
            return
        }
        endActiveSession()
        if let next = mostRecentSignedInProfile(excluding: profileId) {
            accountNotice = notice
            switchProfile(to: next.id)
        } else {
            // 登录页上有自己的原因提示（signedOutReason），这条就不用留着了。
            accountNotice = nil
            signedOutReason = "密码已更改或此设备已被移除，请重新登录".loc
            isSignedIn = false
        }
    }

    /// 把一个账号在本机留下的登录凭据和数据收掉：refresh token、离线缓存、
    /// 排好的本地提醒；它正显示在界面上的话，再加上系统日历里的镜像。
    /// 主动退出、被服务端登出、从列表里移除，走的都是这一份清单。
    private func retireCredentials(of profile: Profile) {
        Keychain.delete(.refreshToken(profileId: profile.id))
        // 只清这个账号的缓存。以前退出登录用的是 clearAll()，会把其它账号的离线日历
        // 一起删掉——多账号用户为了修一个登录问题退出 A，回头发现 B 也空了。
        if let url = profile.serverURL {
            EventCache.shared.clearForUserKey(
                EventCache.shared.key(serverURL: url, userEmail: profile.userEmail))
        }
        // 提醒也只清这个账号的 —— 和上面那条离线缓存踩过的是同一个坑。
        let pid = profile.id
        Task { await LocalNotifications.shared.clearAll(profileId: pid) }
        // 系统日历镜像整台设备只有一份，里面永远只装着「当前显示的那个账号」的日程
        // （每次切账号都会 tearDown）。收的不是当前账号时，镜像里没有它的东西，别去动。
        if profile.id == activeProfileId {
            EventKitMirror.shared.tearDown()
        }
    }

    /// 当前显示的账号要下场了（切走 / 退出 / 被登出 / 被移除）：清掉只属于它的内存状态。
    private func endActiveSession() {
        accessToken = nil
        accessTokenExpiresAt = nil
        // 「撤销删除」是对上一个账号的服务器发的；换了账号再点，只会拿着新账号的
        // 令牌去恢复一个不属于它的事件。
        pendingUndoDelete = nil
    }

    /// 本机还登录着的账号里最近用过的那个（有 refresh token 才算登录着）。
    private func mostRecentSignedInProfile(excluding id: String) -> Profile? {
        profiles
            .filter { $0.id != id && Keychain.read(.refreshToken(profileId: $0.id)) != nil }
            .max(by: { $0.lastUsedAt < $1.lastUsedAt })
    }

    /// 让 RootView 先显示启动画面、重新跑一次 bootstrap。
    ///
    /// isBootstrapping 在这里**同步**置上：以前是放在 Task 里置的，换账号那一刻
    /// 日历视图会先按新账号挂载一次、发起加载，紧接着又被启动画面换掉。
    private func rebootstrap() {
        isBootstrapping = true
        Task { await bootstrap() }
    }

    /// Persist the profiles array + active id to UserDefaults.
    private func persistProfiles() {
        if let data = try? JSONEncoder.iso().encode(profiles) {
            UserDefaults.standard.set(data, forKey: Self.profilesKey)
        }
        UserDefaults.standard.set(activeProfileId, forKey: Self.activeProfileKey)
    }

    // MARK: - Access-token plumbing

    func currentAccessToken() async throws -> String {
        try await refreshIfNeeded(force: false)
        guard let token = accessToken else { throw APIError.notSignedIn }
        return token
    }

    func invalidateAccessToken() {
        accessToken = nil
        accessTokenExpiresAt = nil
    }

    /// Hits /api/v1/auth/refresh using the active profile's refresh token.
    private func refreshIfNeeded(force: Bool) async throws {
        if !force,
           let exp = accessTokenExpiresAt,
           exp.timeIntervalSinceNow > 300
        {
            return
        }
        guard let id = activeProfileId else { throw APIError.notSignedIn }
        guard let serverURL = activeProfile?.serverURL else { throw APIError.notSignedIn }
        guard let refresh = Keychain.read(.refreshToken(profileId: id)) else { throw APIError.notSignedIn }
        var req = URLRequest(url: serverURL.appendingPathComponent("/api/v1/auth/refresh"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["refreshToken": refresh])
        let (data, resp) = try await URLSession.shared.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
        // 401 = 服务端明确说这张 refresh token 不认了（改密码 / 重置密码 /
        // 后台移除设备都会吊销）。这和「服务器 500」「网络断了」是两回事：
        // 前者必须登出并告诉用户原因，后者应当保持登录、继续用离线缓存。
        //
        // 以前这里一律抛 refreshFailed 且不清凭据，结果 App 变成僵尸：
        // 日历照常显示上次同步的内容，新建/编辑/删除全部失败，
        // 而界面上没有任何地方告诉用户「你被登出了」。
        if status == 401 {
            // 请求在路上时这个账号刚好重新登录过、换了新的 refresh token：
            // 401 说的是被换掉的旧令牌，不是这个账号被登出了。不能拿它去删新令牌。
            let current = Keychain.read(.refreshToken(profileId: id))
            // 令牌已经没了：并发的另一次刷新先拿到 401、已经按「被登出」收拾过了
            // （冷启动时 bootstrap 和推送注册各刷一次，就会这样撞上）。
            // 这里同样是被登出，不能报成 refreshFailed —— bootstrap 会把那当成
            // 「网络不好」而保持登录，用户就停在一个空日历加「请先登录」的空壳里。
            guard let current else { throw APIError.deviceRevoked }
            guard current == refresh else {
                if activeProfileId == id, accessToken != nil { return }
                throw APIError.refreshFailed(status: status)
            }
            handleSessionRevoked(profileId: id)
            throw APIError.deviceRevoked
        }
        guard status == 200 else {
            throw APIError.refreshFailed(status: status)
        }
        let outer = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        let payload = (outer["data"] as? [String: Any]) ?? outer
        guard let token = payload["accessToken"] as? String,
              let expIso = payload["accessTokenExpiresAt"] as? String,
              let exp = Self.parseIsoLenient(expIso)
        else {
            throw APIError.refreshFailed(status: 200)
        }
        // 请求在路上时换过账号了：这是上一个账号的令牌，装到当前账号身上的话，
        // 接下来的请求会拿着 A 的令牌、在 B 的名下取数据。丢掉它。
        guard activeProfileId == id else { throw CancellationError() }
        self.accessToken = token
        self.accessTokenExpiresAt = exp
    }

    /// Parse the server's ISO8601 timestamp. The server emits
    /// `Date.toISOString()` which includes fractional seconds
    /// ("2026-05-25T11:30:00.000Z"); default ISO8601DateFormatter()
    /// rejects those. Try the fractional-seconds variant first, fall
    /// back to the plain one for safety.
    ///
    /// This is THE iOS v1.3.4 critical bug: without `.withFractionalSeconds`
    /// every /auth/refresh response parsed as nil and threw refreshFailed,
    /// forcing the user to sign in again every time access token expired
    /// (1h). The visible symptom was "wake up the next morning, app is
    /// logged out."
    static func parseIsoLenient(_ s: String) -> Date? {
        let withFrac = ISO8601DateFormatter()
        withFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withFrac.date(from: s) { return d }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: s)
    }
}

// JSONEncoder.iso() / JSONDecoder.iso() helpers are defined in
// APIClient.swift as internal extensions, so they're already visible
// here. Don't redeclare — that's what caused the v0.10.3 build break.
