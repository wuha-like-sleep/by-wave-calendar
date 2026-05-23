// Keychain.swift
// Thin Keychain wrapper for storing the refresh token. We use the Generic
// Password class with kSecAttrAccessibleAfterFirstUnlock so the token can
// be read in the background after first unlock (needed for silent sync).

import Foundation
import Security

enum KeychainKey: String {
    case refreshToken = "bwc.refreshToken"
}

enum Keychain {
    private static let service = "cn.bywave.calendar"

    static func write(_ key: KeychainKey, value: String) {
        let data = value.data(using: .utf8) ?? Data()
        // First delete any existing item so we don't get errSecDuplicateItem.
        SecItemDelete([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: key.rawValue,
        ] as CFDictionary)
        let attrs: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key.rawValue,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        SecItemAdd(attrs as CFDictionary, nil)
    }

    static func read(_ key: KeychainKey) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key.rawValue,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
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
        ] as CFDictionary)
    }
}
