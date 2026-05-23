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
//
// v1.0.1 — pulled OFF the main thread. Previously @MainActor, so
// JSON encode + disk I/O blocked the UI for 50-200ms after every
// /events response. Now uses a dedicated serial background queue;
// callers use `read()` / `write()` as async functions and SwiftUI
// only sees the parsed payload (small) on the main actor.

import Foundation

struct EventCachePayload: Codable {
    let events: [EventDTO]
    let calendars: [CalendarMeta]
    let cachedAt: Date
    let windowStart: Date
    let windowEnd: Date
}

final class EventCache: @unchecked Sendable {
    static let shared = EventCache()

    private let fileManager = FileManager.default
    /// Dedicated serial queue so reads + writes can't trample each
    /// other. Background QoS — cache work is never user-blocking.
    private let queue = DispatchQueue(label: "cn.bywave.calendar.eventcache", qos: .background)

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
        return "\(serverURL.host ?? "unknown")-\(userEmail ?? "anon")"
    }

    /// Async read — disk I/O + JSON decode happen on the background
    /// queue; only the parsed payload comes back to the caller.
    func read(key: String) async -> EventCachePayload? {
        await withCheckedContinuation { cont in
            queue.async {
                cont.resume(returning: self.readSync(key: key))
            }
        }
    }

    /// Async write — non-blocking. Caller doesn't wait for the file to
    /// land on disk; we just enqueue and return.
    func write(key: String, payload: EventCachePayload) {
        queue.async { [weak self] in
            self?.writeSync(key: key, payload: payload)
        }
    }

    /// Synchronous variants used internally on the background queue.
    /// Don't call from view code — use the async wrappers above.
    private func readSync(key: String) -> EventCachePayload? {
        guard let url = cacheURL(forUserKey: key),
              fileManager.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: url)
        else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(EventCachePayload.self, from: data)
    }

    private func writeSync(key: String, payload: EventCachePayload) {
        guard let url = cacheURL(forUserKey: key) else { return }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = []
        guard let data = try? encoder.encode(payload) else { return }
        try? data.write(to: url, options: .atomic)
    }

    func clear(key: String) {
        queue.async { [weak self] in
            guard let url = self?.cacheURL(forUserKey: key) else { return }
            try? self?.fileManager.removeItem(at: url)
        }
    }

    /// Wipe every cache file. Synchronous variant kept for sign-out
    /// where we want all caches gone before the next sign-in's load
    /// starts. Still fast (small files), tolerable.
    func clearAll() {
        queue.sync {
            guard let dir = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
            guard let entries = try? fileManager.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return }
            for entry in entries where entry.lastPathComponent.hasPrefix("event-cache-") {
                try? fileManager.removeItem(at: entry)
            }
        }
    }

    /// Profile-scoped clear — used by AppState.removeProfile. Doesn't
    /// have access to the profile's email mapping, so falls back to
    /// clearAll. Caller is removing a profile entirely so over-clearing
    /// is harmless (other profiles re-fetch on next view).
    func clearForProfile(_ profileId: String) {
        clearAll()
    }
}
