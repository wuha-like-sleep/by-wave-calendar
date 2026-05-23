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

enum KeychainKey: String {
    case refreshToken = "bwc.refreshToken"
    // Stable per-Apple-ID UUID. Generated lazily on first use and
    // persisted forever. Synced via iCloud so it's the same on iPhone
    // + iPad + new device. The server uses it to dedup repeat sign-ins
    // from the same physical install — "退出登录 → 再登录" no longer
    // grows the device list.
    case clientDeviceId = "bwc.clientDeviceId"
    // Last server URL the user paired with. Synced so a fresh install
    // on another Apple device can auto-fill the server field.
    case lastServerURL = "bwc.lastServerURL"

    /// Whether this key should sync via iCloud Keychain. False = stays
    /// on this device only (safer for secrets like refresh tokens).
    var synchronizable: Bool {
        switch self {
        case .refreshToken: return false
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
            kSecAttrAccount: key.rawValue,
            kSecAttrSynchronizable: kSecAttrSynchronizableAny,
        ] as CFDictionary)
        var attrs: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key.rawValue,
            kSecValueData as String: data,
            // iCloud-synced items need a different accessibility class —
            // …AfterFirstUnlock with no DeviceOnly suffix is the right one.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
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
            kSecAttrAccount as String: key.rawValue,
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
            kSecAttrAccount: key.rawValue,
            kSecAttrSynchronizable: kSecAttrSynchronizableAny,
        ] as CFDictionary)
    }

    /// Returns the stable client-device UUID, generating + persisting it
    /// on first access. The string is a lowercase UUID without dashes
    /// (32 chars) — matches what the server zod schema accepts.
    static func clientDeviceId() -> String {
        if let existing = read(.clientDeviceId), !existing.isEmpty { return existing }
        let fresh = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        write(.clientDeviceId, value: fresh)
        return fresh
    }
}
