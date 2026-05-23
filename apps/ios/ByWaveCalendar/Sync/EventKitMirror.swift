// EventKitMirror.swift
// One-way mirror of ByWave events → iOS system Calendar (EventKit).
// When enabled, every successful loadEvents() also writes the same
// events into a dedicated "ByWave Calendar" inside the user's EventKit
// store. iOS Calendar app / Spotlight / Siri then surface them
// alongside iCloud / Gmail / etc.
//
// Design:
//   - One EventKit calendar per APP install ("ByWave Calendar"),
//     not per-ByWave-calendar. Simpler. Color = brand purple.
//   - Source = local store (so it works without iCloud sync turned on).
//   - Mapping: serverEventId → EKEvent.eventIdentifier in UserDefaults.
//   - Delete-then-create on each upsert is simpler than diffing fields;
//     we'll revisit if it becomes a perf issue.
//   - Two-way sync is OUT — if the user edits an event in iOS Calendar,
//     it'll get reverted on next mirror. We document this in SettingsView.
//
// Privacy: opt-in via SettingsView toggle. Permission requested
// lazily on first enable. NEVER call mirror() without the toggle on.

import EventKit
import Foundation

@MainActor
final class EventKitMirror {
    static let shared = EventKitMirror()

    private let store = EKEventStore()
    private let calendarTitle = "ByWave Calendar"
    // Brand purple, matches the splash gradient mid-stop. EventKit
    // calendars only accept CGColor → use 0xFF on UIColor channels.
    private let calendarColor = CGColor(red: 79/255.0, green: 70/255.0, blue: 229/255.0, alpha: 1.0)

    private static let mappingKey = "bwc.ekMirror.mapping"
    private static let calendarIdKey = "bwc.ekMirror.calendarId"
    private static let enabledKey = "bwc.ekMirror.enabled"

    var isEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: Self.enabledKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.enabledKey) }
    }

    enum Permission { case granted, denied, notDetermined }
    var permission: Permission {
        let status = EKEventStore.authorizationStatus(for: .event)
        if #available(iOS 17.0, *) {
            switch status {
            case .fullAccess, .authorized: return .granted
            case .denied, .restricted: return .denied
            case .notDetermined, .writeOnly: return .notDetermined
            @unknown default: return .notDetermined
            }
        } else {
            switch status {
            case .authorized: return .granted
            case .denied, .restricted: return .denied
            case .notDetermined: return .notDetermined
            // iOS 17+ cases — unreachable here at runtime but the
            // compiler still requires them to be handled because they
            // exist in the EKAuthorizationStatus enum at type-level.
            case .fullAccess: return .granted
            case .writeOnly: return .notDetermined
            @unknown default: return .notDetermined
            }
        }
    }

    // Request permission. Returns true if we ended up with full access.
    func requestAccess() async -> Bool {
        if #available(iOS 17.0, *) {
            do {
                return try await store.requestFullAccessToEvents()
            } catch {
                return false
            }
        } else {
            return await withCheckedContinuation { cont in
                store.requestAccess(to: .event) { granted, _ in
                    cont.resume(returning: granted)
                }
            }
        }
    }

    // Reset all mirror state — used when user signs out, or when they
    // toggle the mirror off and we want to clean up the calendar.
    func tearDown() {
        if let calId = UserDefaults.standard.string(forKey: Self.calendarIdKey),
           let cal = store.calendar(withIdentifier: calId) {
            try? store.removeCalendar(cal, commit: true)
        }
        UserDefaults.standard.removeObject(forKey: Self.mappingKey)
        UserDefaults.standard.removeObject(forKey: Self.calendarIdKey)
    }

    // Main entry. Mirrors the given event list into our calendar. Called
    // from CalendarView.load() AFTER the API fetch succeeds. The window
    // (`from`/`to`) is used to scope deletions: don't touch local events
    // outside this range, because the server didn't tell us about them.
    func mirror(events: [EventDTO], windowStart: Date, windowEnd: Date) async {
        guard isEnabled else { return }
        guard permission == .granted else { return }

        guard let calendar = findOrCreateCalendar() else { return }

        var mapping = (UserDefaults.standard.dictionary(forKey: Self.mappingKey) as? [String: String]) ?? [:]

        let serverIds = Set(events.map { stableKey(for: $0) })

        // Upsert each server event
        for ev in events {
            let key = stableKey(for: ev)
            if let existingId = mapping[key],
               let existing = store.event(withIdentifier: existingId) {
                apply(server: ev, to: existing)
                try? store.save(existing, span: .thisEvent, commit: false)
            } else {
                let new = EKEvent(eventStore: store)
                new.calendar = calendar
                apply(server: ev, to: new)
                do {
                    try store.save(new, span: .thisEvent, commit: false)
                    if let id = new.eventIdentifier { mapping[key] = id }
                } catch {
                    // single-event save failure shouldn't abort the whole mirror
                    continue
                }
            }
        }

        // Delete entries that have a mapping but no longer appear in the
        // server response — bounded to the window so we don't nuke events
        // outside the time range the server told us about.
        let predicate = store.predicateForEvents(withStart: windowStart, end: windowEnd, calendars: [calendar])
        let localEventsInWindow = store.events(matching: predicate)
        let mappedIds = Set(mapping.values)
        for local in localEventsInWindow {
            guard let id = local.eventIdentifier, mappedIds.contains(id) else { continue }
            // Find which mapping key points here
            let key = mapping.first { $0.value == id }?.key
            if let key, !serverIds.contains(key) {
                try? store.remove(local, span: .thisEvent, commit: false)
                mapping.removeValue(forKey: key)
            }
        }

        try? store.commit()
        UserDefaults.standard.set(mapping, forKey: Self.mappingKey)
    }

    // Choose a stable key for the (event, occurrence) pair. The server's
    // expansion gives us per-occurrence rows whose id matches the master;
    // we disambiguate by start time so each occurrence gets its own
    // EKEvent. Non-recurring events use the plain id.
    private func stableKey(for e: EventDTO) -> String {
        if e.isOccurrence == true {
            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime]
            return "\(e.id)@\(iso.string(from: e.startsAt))"
        }
        return e.id
    }

    private func apply(server: EventDTO, to ek: EKEvent) {
        ek.title = server.summary
        ek.notes = server.description
        ek.location = server.location
        ek.startDate = server.startsAt
        ek.endDate = server.endsAt
        ek.isAllDay = server.allDay
        // We don't mirror RRULE — server already expanded it, and EKEvent
        // recurrence rules are a whole separate API surface. Each
        // occurrence is its own EKEvent in our mirror.
    }

    private func findOrCreateCalendar() -> EKCalendar? {
        if let calId = UserDefaults.standard.string(forKey: Self.calendarIdKey),
           let cal = store.calendar(withIdentifier: calId) {
            return cal
        }
        // Find by title (in case the stored ID was lost across reinstall).
        if let existing = store.calendars(for: .event).first(where: { $0.title == calendarTitle && $0.source.sourceType == .local }) {
            UserDefaults.standard.set(existing.calendarIdentifier, forKey: Self.calendarIdKey)
            return existing
        }
        // Create fresh — prefer .local source so users without iCloud
        // can still mirror, and iCloud users don't get duplicated rows.
        guard let localSource = store.sources.first(where: { $0.sourceType == .local })
            ?? store.defaultCalendarForNewEvents?.source
        else { return nil }
        let cal = EKCalendar(for: .event, eventStore: store)
        cal.title = calendarTitle
        cal.cgColor = calendarColor
        cal.source = localSource
        do {
            try store.saveCalendar(cal, commit: true)
            UserDefaults.standard.set(cal.calendarIdentifier, forKey: Self.calendarIdKey)
            return cal
        } catch {
            return nil
        }
    }
}
