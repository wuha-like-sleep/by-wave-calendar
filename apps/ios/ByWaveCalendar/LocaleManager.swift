// LocaleManager.swift
// In-APP language override. Without this, iOS picks the bundle locale
// (zh-Hans.lproj / en.lproj) based on the device's system language —
// users who want a different APP language than their device language
// have no way to ask for it.
//
// Pattern:
//   1. User picks a language in SettingsView → 语言
//   2. We persist the choice to UserDefaults
//   3. We immediately set `AppleLanguages` so the *next* app launch
//      uses the chosen bundle
//   4. We show an alert prompting the user to fully relaunch the APP
//      (iOS doesn't let us swap the bundle locale mid-process — the
//      cleanest path is to ask for a restart; the alternative is
//      swizzling `Bundle.localizedString(forKey:value:table:)` which
//      is fragile across iOS releases)
//
// Why not swizzle Bundle? It works for SwiftUI Text("…") most of the
// time but breaks for system-supplied dialogs (action sheets, share
// sheets, EventKit prompts), and Apple has flagged it in App Store
// reviews before. A relaunch-with-AppleLanguages-override is the path
// of least surprise and matches how Tencent / Apple's own multi-locale
// settings work (Safari, Wechat, etc.).

import Foundation
import SwiftUI

@MainActor
final class LocaleManager: ObservableObject {

    static let shared = LocaleManager()

    /// UserDefaults key for the user's chosen language tag. Empty string
    /// (or absent) = "follow system locale". Non-empty must be one of
    /// SUPPORTED below.
    private static let storageKey = "bwc.locale"

    /// Supported language tags. Order = order shown in the picker.
    /// "" represents the「跟随系统」option. Each non-empty entry MUST have a
    /// matching <code>.lproj/Localizable.strings bundle — we ship all 8
    /// below. Labels are endonyms (every language shown in its own name),
    /// the standard for language pickers. (Previously this list only had
    /// zh-Hans + en, so users couldn't pick the 6 other languages we'd
    /// already fully translated — that was the "iOS 语言没做完" report.)
    static let supported: [(code: String, label: String)] = [
        ("",          "跟随系统"),
        ("zh-Hans",   "简体中文"),
        ("zh-Hant",   "繁體中文"),
        ("en",        "English"),
        ("ja",        "日本語"),
        ("ko",        "한국어"),
        ("es",        "Español"),
        ("fr",        "Français"),
        ("de",        "Deutsch"),
    ]

    @Published private(set) var current: String

    private init() {
        self.current = UserDefaults.standard.string(forKey: Self.storageKey) ?? ""
    }

    /// Call from the App's body BEFORE any SwiftUI views mount. Reads
    /// the saved choice and writes it into `AppleLanguages` so the
    /// bundle resolver picks the right .lproj/Localizable.strings
    /// during the current launch.
    ///
    /// Idempotent — safe to call multiple times. Returns immediately
    /// if no override is set.
    static func applyEarly() {
        let saved = UserDefaults.standard.string(forKey: storageKey) ?? ""
        guard !saved.isEmpty else { return }
        // AppleLanguages is an ordered list of language tags; first
        // entry wins. We prepend our choice rather than replacing the
        // whole list so a downstream library that depends on the full
        // chain still has fallbacks below it.
        let existing = UserDefaults.standard.stringArray(forKey: "AppleLanguages") ?? []
        // Avoid duplicating if already at the front.
        if existing.first != saved {
            var newList = [saved]
            newList.append(contentsOf: existing.filter { $0 != saved })
            UserDefaults.standard.set(newList, forKey: "AppleLanguages")
            UserDefaults.standard.synchronize()
        }
    }

    /// Persist the user's choice. Caller is responsible for prompting
    /// the user to relaunch (iOS won't re-bind Localizable.strings
    /// mid-process). Pass empty string to clear the override.
    func setLocale(_ code: String) {
        let normalized = code.isEmpty || Self.supported.contains(where: { $0.code == code }) ? code : ""
        UserDefaults.standard.set(normalized, forKey: Self.storageKey)
        // Also pre-populate AppleLanguages so the user's NEXT relaunch
        // picks up the new bundle without re-running applyEarly().
        if normalized.isEmpty {
            // Clear our override so iOS goes back to system locale.
            // We don't try to surgically remove only OUR entry from
            // AppleLanguages — just trust the system to repopulate.
            UserDefaults.standard.removeObject(forKey: "AppleLanguages")
        } else {
            UserDefaults.standard.set([normalized], forKey: "AppleLanguages")
        }
        UserDefaults.standard.synchronize()
        current = normalized
    }

    /// Human-friendly label for the currently-effective language —
    /// useful for the Settings cell's trailing detail view.
    var currentLabel: String {
        if current.isEmpty {
            // "跟随系统" + the system-resolved language for context. Resolve
            // the endonym from `supported` (prefix match: "zh" → zh-Hans,
            // "ja" → 日本語, …) so every shipped language reads naturally.
            let sys = Locale.current.language.languageCode?.identifier ?? "?"
            let sysLabel = Self.supported.first { !$0.code.isEmpty && $0.code.hasPrefix(sys) }?.label ?? sys
            return "跟随系统 · \(sysLabel)"
        }
        return Self.supported.first(where: { $0.code == current })?.label ?? current
    }
}

// MARK: - Localization helpers
//
// The view layer's convention is `Text("中文")` — SwiftUI auto-resolves a
// string literal as a LocalizedStringKey through NSLocalizedString, so the
// Chinese source string IS the lookup key (see Localizable.strings). That
// only works for *literals*, though: the moment a value is a `String`
// (a stored property, a switch result, an interpolation, `.navigationTitle`,
// an error message, etc.) SwiftUI uses the non-localizing `Text(_ verbatim:)`
// init and the user sees raw Chinese in every other language.
//
// These helpers route those non-literal cases through the SAME bundle so
// they pick up the right .lproj/Localizable.strings translation. Both honor
// the in-APP `AppleLanguages` override LocaleManager writes, because
// `String(localized:)` resolves through `Bundle.main` like every other lookup.
extension String {
    /// Localize a Chinese source string used as a *key*. Use on String
    /// values that can't be a plain `Text("…")` literal — `.navigationTitle`,
    /// `.alert` titles built from a variable, enum-backed labels, etc.
    /// Returns the original string when no translation exists (so an
    /// un-keyed string degrades to its Chinese source, never to "").
    var loc: String {
        String(localized: String.LocalizationValue(self))
    }

    /// Localize a `%@`/`%lld`-style format key and fill in its arguments.
    /// Keeps interpolation out of the lookup key so the dictionary entry
    /// stays stable across counts/values, e.g.
    ///   "%lld 分钟".locFormat(min)  →  "5 分钟" / "5 minutes" / …
    func locFormat(_ args: CVarArg...) -> String {
        String(format: self.loc, arguments: args)
    }
}
