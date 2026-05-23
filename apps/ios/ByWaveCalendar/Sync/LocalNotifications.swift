// LocalNotifications.swift
// On-device event reminders via UNUserNotificationCenter. No APNs / no
// server changes needed. Three things this module does:
//
//   1. Request notification permission (lazily, when first enabled)
//   2. Schedule a UNNotificationRequest for each upcoming event whose
//      start is more than (lead time) into the future
//   3. Re-schedule on every load() — replacing iOS's pending set with
//      our latest understanding of events. iOS dedupes by identifier,
//      so re-scheduling the same id is a no-op if nothing changed.
//
// Bounds:
//   - iOS limits the pending-notification set to ~64 per app. We keep
//     room by only scheduling the next 32 upcoming events.
//   - Notifications fire even when APP isn't running (system-managed).
//   - We don't fire for events that already started (lead time would
//     mean "trigger in the past").

import Foundation
import UserNotifications

@MainActor
final class LocalNotifications {
    static let shared = LocalNotifications()

    private static let enabledKey = "bwc.localNotif.enabled"
    private static let leadMinutesKey = "bwc.localNotif.leadMinutes"

    // Max events we schedule at once. iOS allows ~64; pick a safe ceiling.
    private static let maxPending = 32

    // Identifier prefix so we can clear only our requests on re-schedule
    // without touching anything else (defensive — APP shouldn't have
    // other notification sources for now, but cheap insurance).
    private static let identifierPrefix = "bwc.event."

    var isEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: Self.enabledKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.enabledKey) }
    }

    // How many minutes before an event start to fire the notification.
    // Default 15 — same as the web default reminder.
    var leadMinutes: Int {
        get {
            let raw = UserDefaults.standard.integer(forKey: Self.leadMinutesKey)
            return raw > 0 ? raw : 15
        }
        set { UserDefaults.standard.set(newValue, forKey: Self.leadMinutesKey) }
    }

    // Permission states we surface to SettingsView.
    enum Permission { case granted, denied, notDetermined }
    func permission() async -> Permission {
        let s = await UNUserNotificationCenter.current().notificationSettings()
        switch s.authorizationStatus {
        case .authorized, .provisional, .ephemeral: return .granted
        case .denied: return .denied
        case .notDetermined: return .notDetermined
        @unknown default: return .notDetermined
        }
    }

    // Show the system permission dialog. Returns true on grant.
    func requestPermission() async -> Bool {
        do {
            return try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
        } catch {
            return false
        }
    }

    // Schedule notifications for the given event list. Called from
    // CalendarView.load() after a successful fetch. Safe to call when
    // disabled (no-op).
    func reschedule(events: [EventDTO], calendars: [CalendarMeta]) async {
        guard isEnabled else {
            await clearAll()
            return
        }
        guard await permission() == .granted else { return }

        let center = UNUserNotificationCenter.current()

        // Remove our previous pending requests so we don't accumulate
        // notifications for deleted events. iOS's removeAllPending takes
        // identifier prefixes only via removePendingNotificationRequests.
        let pending = await center.pendingNotificationRequests()
        let oursIds = pending
            .map { $0.identifier }
            .filter { $0.hasPrefix(Self.identifierPrefix) }
        center.removePendingNotificationRequests(withIdentifiers: oursIds)

        let now = Date()
        let leadSec = TimeInterval(leadMinutes * 60)
        let calLookup = Dictionary(uniqueKeysWithValues: calendars.map { ($0.id, $0) })

        // Only future events whose trigger time is also future.
        let upcoming = events
            .filter { !$0.allDay }   // all-day events are noisy on phone notifications
            .filter { $0.startsAt.timeIntervalSince(now) > leadSec }
            .sorted { $0.startsAt < $1.startsAt }
            .prefix(Self.maxPending)

        for ev in upcoming {
            let content = UNMutableNotificationContent()
            content.title = ev.summary
            content.body = bodyLabel(for: ev, calendar: calLookup[ev.calendarId])
            content.sound = .default
            // Use the calendar identifier so we group reminders per event.
            content.threadIdentifier = ev.calendarId

            let triggerDate = ev.startsAt.addingTimeInterval(-leadSec)
            let comps = Calendar.current.dateComponents(
                [.year, .month, .day, .hour, .minute],
                from: triggerDate,
            )
            let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
            // Each (event, occurrence-time) pair gets a stable identifier
            // so re-schedules don't double-fire.
            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime]
            let id = "\(Self.identifierPrefix)\(ev.id)@\(iso.string(from: ev.startsAt))"
            let req = UNNotificationRequest(identifier: id, content: content, trigger: trigger)
            try? await center.add(req)
        }
    }

    // Wipe all our pending notifications. Called when user disables the
    // toggle OR signs out.
    func clearAll() async {
        let center = UNUserNotificationCenter.current()
        let pending = await center.pendingNotificationRequests()
        let oursIds = pending.map { $0.identifier }.filter { $0.hasPrefix(Self.identifierPrefix) }
        center.removePendingNotificationRequests(withIdentifiers: oursIds)
    }

    private func bodyLabel(for ev: EventDTO, calendar: CalendarMeta?) -> String {
        let f = DateFormatter(); f.locale = Locale(identifier: "zh_CN"); f.dateFormat = "HH:mm"
        var body = "\(f.string(from: ev.startsAt)) 开始"
        if let location = ev.location, !location.isEmpty {
            body += " · 📍 \(location)"
        }
        if let name = calendar?.name, !name.isEmpty {
            body += " · \(name)"
        }
        return body
    }
}
