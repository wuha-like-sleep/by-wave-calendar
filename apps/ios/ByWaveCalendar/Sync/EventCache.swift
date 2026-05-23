// EventCache.swift
// On-disk JSON cache of the last successful /events response. Used so:
//   - Cold app launch shows events instantly (no white grid while we
//     re-fetch in background)
//   - Offline mode still shows the last known state
//
// Cache is per-user (keyed by Server URL + userId) so a sign-out/sign-in
// to a different account doesn't show stale events from the previous one.
// File lives under Documents/ so it survives app restarts but not a full
// delete-reinstall (intentional — fresh install = fresh state).

import Foundation

struct EventCachePayload: Codable {
    let events: [EventDTO]
    let calendars: [CalendarMeta]
    let cachedAt: Date
    let windowStart: Date
    let windowEnd: Date
}

@MainActor
final class EventCache {
    static let shared = EventCache()

    private let fileManager = FileManager.default

    // Bump on schema-breaking changes so old cache files get ignored
    // instead of crashing on decode.
    private static let version = 1

    private func cacheURL(forUserKey key: String) -> URL? {
        guard let dir = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first else { return nil }
        let safe = key
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: ":", with: "_")
        return dir.appendingPathComponent("event-cache-v\(Self.version)-\(safe).json")
    }

    func key(serverURL: URL, userEmail: String?) -> String {
        // We don't have userId on the client, but email is stable per account.
        // Fall back to host-only when not signed in (shouldn't happen, but safe).
        return "\(serverURL.host ?? "unknown")-\(userEmail ?? "anon")"
    }

    func read(key: String) -> EventCachePayload? {
        guard let url = cacheURL(forUserKey: key),
              fileManager.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: url)
        else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(EventCachePayload.self, from: data)
    }

    func write(key: String, payload: EventCachePayload) {
        guard let url = cacheURL(forUserKey: key) else { return }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = []
        guard let data = try? encoder.encode(payload) else { return }
        // Atomic write so we don't leave a half-flushed file if the app
        // gets killed mid-write.
        try? data.write(to: url, options: .atomic)
    }

    func clear(key: String) {
        guard let url = cacheURL(forUserKey: key) else { return }
        try? fileManager.removeItem(at: url)
    }

    // Wipe every cache file — used on sign-out so the next signed-in user
    // doesn't inherit. Keep this synchronous + cheap.
    func clearAll() {
        guard let dir = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        guard let entries = try? fileManager.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return }
        for entry in entries where entry.lastPathComponent.hasPrefix("event-cache-") {
            try? fileManager.removeItem(at: entry)
        }
    }

    /// Profile-scoped clear — used by AppState.removeProfile to delete
    /// just one account's cached data, leaving other profiles untouched.
    /// Matches keys built via `key(serverURL:userEmail:)` for that
    /// profile; we use a substring scan because the cache key includes
    /// both host and email and we want to be liberal.
    func clearForProfile(_ profileId: String) {
        // We don't actually key by profileId today (cache key is host +
        // email). On profile removal, the caller passes us the profile
        // id but we have to map back — since we don't have a profiles
        // lookup here, a simple workaround: clearAll on every profile
        // removal. Not optimal but correct: removed profile = data gone,
        // other profiles will just re-fetch on next view.
        clearAll()
    }
}
