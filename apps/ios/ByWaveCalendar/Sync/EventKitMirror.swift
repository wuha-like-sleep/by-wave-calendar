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
//   - Source = LOCAL only (sourceType == .local). We explicitly
//     refuse to fall back to iCloud / Exchange / CalDAV sources
//     even if .local is somehow missing — users complained that
//     creating a calendar on a remote source meant their data was
//     getting synced through iCloud Calendar to all other devices,
//     defeating the whole point of self-hosting. If no local source
//     exists on this device, mirror is a no-op and the toggle in
//     SettingsView shows a hint.
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
    private static let calendarMappingKey = "bwc.ekMirror.sourceCalendars"
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
           let cal = store.calendar(withIdentifier: calId), cal.source.sourceType == .local {
            try? store.removeCalendar(cal, commit: true)
        }
        UserDefaults.standard.removeObject(forKey: Self.mappingKey)
        UserDefaults.standard.removeObject(forKey: Self.calendarIdKey)
        UserDefaults.standard.removeObject(forKey: Self.calendarMappingKey)
    }

    // Main entry. Mirrors the given event list into our calendar. Called
    // from CalendarView.load() AFTER the API fetch succeeds. The window
    // (`from`/`to`) is used to scope deletions: don't touch local events
    // outside this range, because the server didn't tell us about them.
    @discardableResult
    func mirror(events allEvents: [EventDTO], windowStart: Date, windowEnd: Date, selectedCalendarIDs: Set<String>? = nil) async -> Bool {
        guard isEnabled, permission == .granted else { return false }
        guard let calendar = findOrCreateCalendar() else { return false }
        let events = allEvents.filter { selectedCalendarIDs == nil || selectedCalendarIDs!.contains($0.calendarId) }
        var sources = (UserDefaults.standard.dictionary(forKey: Self.calendarMappingKey) as? [String: String]) ?? [:]
        var failed = false
        var savedEvents: [String: EKEvent] = [:]

        var mapping = (UserDefaults.standard.dictionary(forKey: Self.mappingKey) as? [String: String]) ?? [:]

        let serverIds = Set(events.map { stableKey(for: $0) })

        // Upsert each server event
        for ev in events {
            let key = stableKey(for: ev)
            sources[key] = ev.calendarId
            if let existingId = mapping[key],
               let existing = store.event(withIdentifier: existingId) {
                apply(server: ev, to: existing)
                do { try store.save(existing, span: .thisEvent, commit: false); savedEvents[key] = existing } catch { failed = true }
            } else {
                let new = EKEvent(eventStore: store)
                new.calendar = calendar
                apply(server: ev, to: new)
                do {
                    try store.save(new, span: .thisEvent, commit: false)
                    savedEvents[key] = new
                } catch {
                    // single-event save failure shouldn't abort the whole mirror
                    failed = true
                    continue
                }
            }
        }

        // Delete entries that have a mapping but no longer appear in the
        // server response — bounded to the window so we don't nuke events
        // outside the time range the server told us about.
        let predicate = store.predicateForEvents(withStart: windowStart, end: windowEnd, calendars: [calendar])
        let localEventsInWindow = store.events(matching: predicate)
        let keysByID = Dictionary(mapping.map { ($0.value, $0.key) }, uniquingKeysWith: { first, _ in first })
        let mappedIds = Set(keysByID.keys)
        for local in localEventsInWindow {
            guard let id = local.eventIdentifier, mappedIds.contains(id) else { continue }
            // Find which mapping key points here
            let key = keysByID[id]
            if let key, !serverIds.contains(key) {
                do {
                    try store.remove(local, span: .thisEvent, commit: false)
                    mapping.removeValue(forKey: key)
                    sources.removeValue(forKey: key)
                } catch { failed = true }
            }
        }

        do { try store.commit() } catch { store.reset(); return false }
        // EventKit assigns permanent identifiers on commit. Reading them earlier
        // can lose the mapping, leaving copies that future deletions cannot find.
        for (key, event) in savedEvents {
            if let id = event.eventIdentifier { mapping[key] = id } else { failed = true }
        }
        UserDefaults.standard.set(mapping, forKey: Self.mappingKey)
        UserDefaults.standard.set(sources, forKey: Self.calendarMappingKey)
        return !failed
    }

    func selectedCalendars(profileID: String) -> Set<String>? {
        UserDefaults.standard.stringArray(forKey: "bwc.ekMirror.selection." + profileID).map { Set($0) }
    }

    func selectCalendars(_ ids: Set<String>, profileID: String) {
        UserDefaults.standard.set(Array(ids), forKey: "bwc.ekMirror.selection." + profileID)
        guard permission == .granted else { return }
        var mapping = (UserDefaults.standard.dictionary(forKey: Self.mappingKey) as? [String: String]) ?? [:]
        var sources = (UserDefaults.standard.dictionary(forKey: Self.calendarMappingKey) as? [String: String]) ?? [:]
        for (key, calendarID) in sources where !ids.contains(calendarID) {
            if let eventID = mapping[key], let event = store.event(withIdentifier: eventID) {
                do { try store.remove(event, span: .thisEvent, commit: true) } catch { continue }
            }
            mapping.removeValue(forKey: key); sources.removeValue(forKey: key)
        }
        UserDefaults.standard.set(mapping, forKey: Self.mappingKey)
        UserDefaults.standard.set(sources, forKey: Self.calendarMappingKey)
    }

    // Choose a stable key for the (event, occurrence) pair. The server's
    // expansion gives us per-occurrence rows whose id matches the master;
    // we disambiguate by start time so each occurrence gets its own
    // EKEvent. Non-recurring events use the plain id.
    private static let occurrenceStamp: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private func stableKey(for e: EventDTO) -> String {
        if e.isOccurrence == true {
            return "\(e.id)@\(Self.occurrenceStamp.string(from: e.startsAt))"
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
        // All-day dates arrive as UTC midnights (the app's AllDayDates
        // day math is UTC-based). EventKit reads an all-day event's day
        // in the EVENT's time zone, falling back to the device zone —
        // in UTC− zones an unpinned all-day event lands on the previous
        // day. Pin all-day events to GMT so the day is the same
        // everywhere; timed events keep absolute dates (zone-free).
        // Set both ways: an event edited from all-day to timed must not
        // keep a stale GMT pin from an earlier mirror.
        ek.timeZone = server.allDay ? TimeZone(secondsFromGMT: 0) : nil
        // We don't mirror RRULE — server already expanded it, and EKEvent
        // recurrence rules are a whole separate API surface. Each
        // occurrence is its own EKEvent in our mirror.
    }

    private func findOrCreateCalendar() -> EKCalendar? {
        // Migration (v1.7+): if a previously-saved calendar ID points to
        // a calendar on a REMOTE source (iCloud / Exchange / CalDAV /
        // Subscribed), wipe the stored ID + mapping so we recreate on
        // the local source. Older builds had a buggy fallback that put
        // the calendar on iCloud whenever the local source wasn't the
        // user's default — meaning their data was actually syncing
        // through iCloud Calendar across devices. We don't delete the
        // remote calendar (could contain user-edited events) — the
        // user can clean it up in the iOS Calendar app at their
        // convenience.
        if let calId = UserDefaults.standard.string(forKey: Self.calendarIdKey),
           let cal = store.calendar(withIdentifier: calId) {
            if cal.source.sourceType == .local {
                return cal
            }
            // Remote-sourced calendar — orphan it and start fresh local.
            NSLog("[ByWave EventKitMirror] dropping stale calendarId on non-local source (was %@) — will create a fresh local one", cal.source.title)
            UserDefaults.standard.removeObject(forKey: Self.calendarIdKey)
            // Also wipe the serverEventId → EKEvent mapping so we don't
            // try to update events in the orphaned remote calendar.
            UserDefaults.standard.removeObject(forKey: Self.mappingKey)
        }
        // A matching title does not prove ownership. Only the saved identifier
        // may be reused; otherwise create an independent managed calendar.
        // Create fresh — ONLY on the local source. No iCloud fallback;
        // if .local doesn't exist on this device, the mirror is a
        // no-op for this session. See file header for rationale.
        guard let localSource = store.sources.first(where: { $0.sourceType == .local })
        else {
            // EKEventStore.sources doesn't expose .local on every device
            // configuration (e.g. macOS Catalyst with all iCloud Calendar
            // off; rare iOS configurations). When this happens we'd rather
            // bail than silently fall through to a remote source — that's
            // the entire bug we're guarding against. Surface user-facing
            // copy on both platforms.
            NSLog("[ByWave EventKitMirror] no local EKSource available — mirror disabled. iOS: enable 「On My iPhone」calendars in 设置 → 日历 → 账户. macOS: enable 「On My Mac」 in System Settings → Internet Accounts.")
            return nil
        }
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
