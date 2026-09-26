// Keychain.swift
// Thin Keychain wrapper for storing the refresh token and other small
// pieces of cross-launch state. Uses the Generic Password class with
// kSecAttrAccessibleAfterFirstUnlock so values can be read in the
// background after first unlock (needed for silent sync).
//
// Some keys are tagged "synchronizable" (sync via iCloud Keychain across
// Apple-ID-linked devices). Per-key choice rather than a global flag —
// the refresh token must NEVER sync (each device gets its own from the
// pair-claim flow), but the server URL + stable clientDeviceId benefit
// from syncing so the user lands on the same server on a new iPhone
// without re-typing it.

import Foundation
import Security

enum KeychainKey: Equatable {
    /// Refresh token — scoped per-profile so multiple sign-ins to
    /// different servers/accounts don't collide. The String is the
    /// Profile.id (UUID). Never synced via iCloud — each device must
    /// claim its own.
    case refreshToken(profileId: String)
    /// Legacy unparameterized refresh token slot from pre-multi-account
    /// builds. Only read for migration; new writes go to the scoped
    /// variant above.
    case legacyRefreshToken
    /// Stable per-Apple-ID UUID. Generated lazily on first use and
    /// persisted forever. **不再使用。** 它走 iCloud 同步，于是同一个 Apple ID 下的
    /// iPhone 和 iPad 拿到同一个编号，服务端把它们当成同一台设备，两台来回把
    /// 对方挤下线。现在用 .localDeviceId（只存在本机）。保留这个 case 只是为了
    /// 不改动旧条目的键名。
    case clientDeviceId
    /// 只存在这台设备上的设备编号。见 Keychain.clientDeviceId() 上的说明。
    case localDeviceId
    /// Last server URL the user paired with. Synced so a fresh install
    /// on another Apple device can auto-fill the server field.
    case lastServerURL

    /// Keychain account string. Profile-scoped keys append the id so
    /// each account gets its own slot.
    var accountKey: String {
        switch self {
        case .refreshToken(let pid): return "bwc.refreshToken.\(pid)"
        case .legacyRefreshToken: return "bwc.refreshToken"
        case .clientDeviceId: return "bwc.clientDeviceId"
        case .localDeviceId: return "bwc.clientDeviceId.local"
        case .lastServerURL: return "bwc.lastServerURL"
        }
    }

    /// 这一条是不是只许留在这台设备上（连加密备份恢复到新机器都不带过去）。
    var isDeviceBound: Bool {
        if case .localDeviceId = self { return true }
        return false
    }

    /// Whether this key should sync via iCloud Keychain. False = stays
    /// on this device only (safer for secrets like refresh tokens).
    var synchronizable: Bool {
        switch self {
        case .refreshToken, .legacyRefreshToken, .localDeviceId: return false
        case .clientDeviceId, .lastServerURL: return true
        }
    }
}

enum Keychain {
    private static let service = "cn.bywave.calendar"

    static func write(_ key: KeychainKey, value: String) {
        let data = value.data(using: .utf8) ?? Data()
        // First delete any existing item so we don't get errSecDuplicateItem.
        // The delete query has to match the synchronizable attribute we
        // wrote with — pass kSecAttrSynchronizableAny to cover both.
        SecItemDelete([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: key.accountKey,
            kSecAttrSynchronizable: kSecAttrSynchronizableAny,
        ] as CFDictionary)
        var attrs: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key.accountKey,
            kSecValueData as String: data,
            // iCloud-synced items need a different accessibility class —
            // …AfterFirstUnlock with no DeviceOnly suffix is the right one.
            kSecAttrAccessible as String: key.isDeviceBound
                // 设备编号**不许离开这台设备** —— 连加密备份恢复到新手机都不带过去，
                // 否则新旧两台手机又会拿到同一个编号，互相把对方挤下线。
                ? kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
                : kSecAttrAccessibleAfterFirstUnlock,
        ]
        if key.synchronizable {
            attrs[kSecAttrSynchronizable as String] = kCFBooleanTrue
        }
        SecItemAdd(attrs as CFDictionary, nil)
    }

    static func read(_ key: KeychainKey) -> String? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key.accountKey,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        // For synchronizable keys, also accept local items (legacy upgrade
        // path: items written before we enabled iCloud sync are still
        // marked non-synchronizable; Any matches both).
        if key.synchronizable {
            query[kSecAttrSynchronizable as String] = kSecAttrSynchronizableAny
        }
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess,
              let data = result as? Data,
              let s = String(data: data, encoding: .utf8)
        else { return nil }
        return s
    }

    static func delete(_ key: KeychainKey) {
        SecItemDelete([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: key.accountKey,
            kSecAttrSynchronizable: kSecAttrSynchronizableAny,
        ] as CFDictionary)
    }

    /// 这台设备的编号，第一次用时生成并存下。32 位小写、不带连字符，和服务端的
    /// 校验一致。服务端靠它认出「同一台设备退出后又登回来」，免得「我的设备」里
    /// 每登一次就多一行。
    ///
    /// **它只存在这台设备上。** 原来存在会走 iCloud 同步的那个键里（.clientDeviceId），
    /// 本意是卸载重装后还认得出来 —— 副作用是同一个 Apple ID 下的 iPhone 和 iPad
    /// 拿到的是同一个编号，服务端把 iPad 上的登录当成「iPhone 重新登录」，换掉了
    /// iPhone 的令牌，两台来回把对方挤下线。
    ///
    /// 不同步的钥匙串条目在卸载重装后本来就还在，所以「重装后认得出」这个本意不受影响。
    /// 换了一个新键名：旧的那个同步条目不再读，已经装在两台设备上的旧编号各自作废，
    /// 每台设备在这里生成自己的。
    static func clientDeviceId() -> String {
        if let existing = read(.localDeviceId), !existing.isEmpty { return existing }
        let fresh = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        write(.localDeviceId, value: fresh)
        return fresh
    }
}
