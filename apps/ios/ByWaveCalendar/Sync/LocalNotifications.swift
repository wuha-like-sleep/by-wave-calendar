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
    private static let legacySweptKey = "bwc.localNotif.legacyIdsSwept"

    /// 每个账号一段独立的命名空间。不带账号段的话，退出其中一个账号
    /// 会把别的账号已经排好的提醒一起清掉。
    private static func prefix(for profileId: String) -> String {
        "\(identifierPrefix)\(profileId)."
    }

    /// 上一次排程用的输入，用于「改了提前量之后立刻重排」。只存在内存里——
    /// 用户改设置的时候人就在 App 里，这正是需要它的那一刻。
    private var lastInput: (profileId: String, events: [EventDTO], calendars: [CalendarMeta])?

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
    func reschedule(profileId: String, events: [EventDTO], calendars: [CalendarMeta]) async {
        // 记下这次的输入。用户在设置里改「提前多久」时要照着它立刻重排 ——
        // 以前那里只是把已排的清空、等下一次日历加载成功才重建，
        // 改完就退出 App 或当时没网的话，提醒会一直是空的，而界面显示的是新值。
        lastInput = (profileId, events, calendars)

        guard isEnabled else {
            await clearAllProfiles()
            return
        }
        guard await permission() == .granted else { return }

        let center = UNUserNotificationCenter.current()

        // 只清**这个账号**的。以前是按 `bwc.event.` 前缀一刀切，多账号用户
        // 退出 A 会把 B 的提醒一起清掉 —— 离线缓存那边已经改成按账号清了，
        // 通知这边一直没跟上。
        await removePending(matching: Self.prefix(for: profileId))
        await sweepLegacyIdentifiersOnce()

        let now = Date()
        let leadSec = TimeInterval(leadMinutes * 60)
        let calLookup = Dictionary(uniqueKeysWithValues: calendars.map { ($0.id, $0) })

        // 事件级提醒优先：事件带 alarms 就逐条按 alarms 排（定时事件
        // 按绝对时长偏移，全天事件按时区墙上时间偏移，见
        // alarmFireDate）；一条 alarms 都没有才回落到下面的全局
        // 提前量逻辑，而全局逻辑维持原口径 —— 只排定时事件，
        // 全天事件不排（没有 alarms 的全天事件在手机上太吵）。
        struct Candidate {
            let event: EventDTO
            let fireDate: Date
            /// alarms 里的下标；-1 = 全局提前量那条。进通知标识符，
            /// 让同一事件的多条 alarms 各自成一条、互不覆盖。
            let alarmIndex: Int
        }
        var candidates: [Candidate] = []
        for ev in events {
            let alarms = (ev.extra?.alarms ?? []).filter {
                !$0.trigger.trimmingCharacters(in: .whitespaces).isEmpty
            }
            if !alarms.isEmpty {
                for (idx, alarm) in alarms.enumerated() {
                    guard let fire = Self.alarmFireDate(
                        for: ev, trigger: alarm.trigger,
                        calendar: calLookup[ev.calendarId],
                    ), fire > now else { continue }
                    candidates.append(Candidate(event: ev, fireDate: fire, alarmIndex: idx))
                }
            } else if !ev.allDay {
                let fire = ev.startsAt.addingTimeInterval(-leadSec)
                if fire > now {
                    candidates.append(Candidate(event: ev, fireDate: fire, alarmIndex: -1))
                }
            }
        }
        // 按响的先后封顶，而不是按事件开始时间 —— 先响的先占坑。
        let upcoming = candidates
            .sorted { $0.fireDate < $1.fireDate }
            .prefix(Self.maxPending)

        for item in upcoming {
            let ev = item.event
            let content = UNMutableNotificationContent()
            content.title = ev.summary
            content.body = bodyLabel(for: ev, calendar: calLookup[ev.calendarId])
            content.sound = .default
            // Use the calendar identifier so we group reminders per event.
            content.threadIdentifier = ev.calendarId

            let comps = Calendar.current.dateComponents(
                [.year, .month, .day, .hour, .minute],
                from: item.fireDate,
            )
            let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
            // Each (event, occurrence-time) pair gets a stable identifier
            // so re-schedules don't double-fire. Alarm-based ones append
            // the alarm index so two alarms on one event don't collide.
            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime]
            var id = "\(Self.prefix(for: profileId))\(ev.id)@\(iso.string(from: ev.startsAt))"
            if item.alarmIndex >= 0 { id += "#\(item.alarmIndex)" }
            let req = UNNotificationRequest(identifier: id, content: content, trigger: trigger)
            try? await center.add(req)
        }
    }

    /// 一条 alarm 该响的绝对时刻。算不出来（trigger 解析不了、RELATED=END
    /// 却没有结束时间、全天事件拿不到时区）返回 nil，调用方跳过这一条 ——
    /// 宁可不响，也不要猜一个时刻响错。
    ///
    /// 口径与服务端 reminder_triggers.ts 的 resolveTriggerAt 一致：
    ///   · 定时事件：startsAt（RELATED=END 时 endsAt）+ 有符号时长，
    ///     纯绝对运算，跨不跨夏令时都一样。
    ///   · 全天事件：基准是事件时区当天 00:00，偏移按**墙上时间**走：
    ///     先在 UTC 日历上把日期 + 偏移做民用时间加减，得到目标墙上
    ///     读数，再按事件时区把这个读数落成绝对时刻。这样 PT9H 永远
    ///     落在当地 09:00，哪怕当天是夏令时切换日。时区取
    ///     extra.timezone，没有就用日历时区，都没有就不排。
    static func alarmFireDate(for ev: EventDTO, trigger raw: String, calendar: CalendarMeta?) -> Date? {
        guard let parsed = AlarmTriggerParser.parse(raw) else { return nil }
        if ev.allDay {
            let tzId = ev.extra?.timezone ?? calendar?.timezone
            guard let tzId, let tz = TimeZone(identifier: tzId) else { return nil }
            let anchor = parsed.relatedToEnd ? ev.endsAt : ev.startsAt
            // 全天事件的 startsAt 是那一天的 UTC 午夜，日期分量按 UTC 读。
            var utcCal = Calendar(identifier: .gregorian)
            utcCal.timeZone = TimeZone(secondsFromGMT: 0)!
            let day = utcCal.dateComponents([.year, .month, .day], from: anchor)
            guard let civilMidnight = utcCal.date(from: day) else { return nil }
            // 民用时间加减：偏移加在「假 UTC 时刻」上，读回来的分量
            // 就是目标墙上读数。
            let civil = civilMidnight.addingTimeInterval(parsed.seconds)
            let wall = utcCal.dateComponents(
                [.year, .month, .day, .hour, .minute, .second], from: civil)
            var tzCal = Calendar(identifier: .gregorian)
            tzCal.timeZone = tz
            return tzCal.date(from: wall)
        }
        let base = parsed.relatedToEnd ? ev.endsAt : ev.startsAt
        return base.addingTimeInterval(parsed.seconds)
    }

    /// 用户在设置里改了提前量之后照着上一次的数据立刻重排。
    /// 这次会话还没加载过日历时无事可做 —— 那种情况下下一次加载会建起来。
    func reapplyLeadTimeChange() async {
        guard let input = lastInput else {
            await clearAllProfiles()
            return
        }
        await reschedule(profileId: input.profileId, events: input.events, calendars: input.calendars)
    }

    /// 清掉某一个账号的待发提醒。退出登录 / 被登出 / 移除账号走这条 —— 别动其它账号的。
    func clearAll(profileId: String) async {
        // 上一次排程用的如果正是这个账号的数据，一起扔掉：不然用户接着在设置里改
        // 「提前多久」，reapplyLeadTimeChange 会照着它把刚清掉的提醒原样排回去 ——
        // 而这个账号已经退出了。
        if lastInput?.profileId == profileId { lastInput = nil }
        await removePending(matching: Self.prefix(for: profileId))
    }

    /// 清掉所有账号的。只在用户把「事件提醒」整个关掉时用。
    func clearAllProfiles() async {
        lastInput = nil
        await removePending(matching: Self.identifierPrefix)
    }

    private func removePending(matching prefix: String) async {
        let center = UNUserNotificationCenter.current()
        let pending = await center.pendingNotificationRequests()
        let ids = pending.map { $0.identifier }.filter { $0.hasPrefix(prefix) }
        center.removePendingNotificationRequests(withIdentifiers: ids)
    }

    /// 升级前排出去的通知标识符是 `bwc.event.<事件id>@<时刻>`，不带账号段，
    /// 新的按账号清永远匹配不到它们 —— 不扫一次的话，那批会变成谁也删不掉的幽灵，
    /// 照着旧数据一直响到自己到期。整个 App 生命周期只扫这一次，
    /// 被清掉的那些会在各账号下一次加载日历时重新排出来。
    private func sweepLegacyIdentifiersOnce() async {
        guard !UserDefaults.standard.bool(forKey: Self.legacySweptKey) else { return }
        UserDefaults.standard.set(true, forKey: Self.legacySweptKey)
        let center = UNUserNotificationCenter.current()
        let pending = await center.pendingNotificationRequests()
        let legacy = pending.map { $0.identifier }.filter(Self.isLegacyIdentifier)
        guard !legacy.isEmpty else { return }
        center.removePendingNotificationRequests(withIdentifiers: legacy)
    }

    /// 是不是升级前那种不带账号段的标识符。
    ///
    /// 新格式 `bwc.event.<账号id>.<事件id>@<时刻>`，账号 id 是本机生成的 UUID，
    /// 里面既没有 `.` 也没有 `@`；所以「前缀之后的第一个 `.` 出现在第一个 `@` 之前」
    /// 就是新格式，反过来（或者压根没有 `.`）就是老格式。
    /// 抽成 static 纯函数是为了这一段能单独验 —— 判错的后果是两个方向的：
    /// 判漏了留下删不掉的幽灵通知，判多了会把刚排好的新通知当场清掉。
    static func isLegacyIdentifier(_ id: String) -> Bool {
        guard id.hasPrefix(identifierPrefix) else { return false }
        let rest = id.dropFirst(identifierPrefix.count)
        guard let dot = rest.firstIndex(of: ".") else { return true }
        guard let at = rest.firstIndex(of: "@") else { return false }
        return at < dot
    }

    private func bodyLabel(for ev: EventDTO, calendar: CalendarMeta?) -> String {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "HH:mm"
        // 全天事件的 startsAt 是 UTC 午夜，格式化成 HH:mm 只会得到一个
        // 和用户无关的钟点；直接写「全天」。
        var body = ev.allDay ? "全天".loc : "%@ 开始".locFormat(f.string(from: ev.startsAt))
        if let location = ev.location, !location.isEmpty {
            body += " · 📍 \(location)"
        }
        if let name = calendar?.name, !name.isEmpty {
            body += " · \(name)"
        }
        return body
    }
}
