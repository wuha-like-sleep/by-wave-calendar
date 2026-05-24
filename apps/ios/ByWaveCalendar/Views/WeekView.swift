// WeekView.swift
// 7-column × 24-hour time grid, like iOS Calendar / Google Calendar.
// Events render as colored rounded rectangles positioned by start time
// + duration. Overlapping events split their column width.
//
// Layout:
//   - All-day row at the top (1 line per all-day event, full-width per day)
//   - Header row: weekday labels (Mon-Sun) + date number, today highlighted
//   - Time gutter on left edge (40pt): 0:00, 1:00, ..., 23:00 labels
//   - Body: 7 day-columns × 24 hour-rows
//   - Horizontal red line at "now" if today is in the visible week
//
// Interactions:
//   - Tap event → EventDetailView
//   - Tap empty cell → EventEditView in .create mode, seeded with that hour
//   - Auto-scroll on appear to ~ now - 1h (so current time is visible)

import SwiftUI

struct WeekView: View {
    let weekStart: Date     // Monday of the displayed week
    let events: [EventDTO]
    let calendars: [CalendarMeta]
    let onEventChanged: () -> Void

    @EnvironmentObject var state: AppState

    @State private var detailFor: EventDTO?
    @State private var createSeed: (calendarId: String, start: Date)?
    // Drag-to-move state. Set when a long-press completes on an event;
    // updated as the finger moves; consumed (commit/cancel) on release.
    @State private var dragState: DragState?
    // After release on a recurring event, hold this until the user picks
    // a scope (or cancels), then fire the PATCH.
    @State private var pendingMove: PendingMove?
    @State private var moveErrorMessage: String?

    // Layout constants. Tuned to feel like iOS Calendar.
    private let hourHeight: CGFloat = 56
    private let timeGutterWidth: CGFloat = 44
    private let allDayMaxRows = 3

    private var calLookup: [String: CalendarMeta] {
        Dictionary(uniqueKeysWithValues: calendars.map { ($0.id, $0) })
    }

    private var dayStarts: [Date] {
        let cal = Calendar.current
        return (0..<7).compactMap { cal.date(byAdding: .day, value: $0, to: weekStart) }
    }

    // Split events: all-day stays at the top, timed go in the grid.
    private var timedEvents: [EventDTO] { events.filter { !$0.allDay } }
    private var allDayEvents: [EventDTO] { events.filter { $0.allDay } }

    var body: some View {
        // Outer VStack MUST claim the full available height — otherwise
        // CalendarView's enclosing ZStack centers us vertically and
        // headerRow ends up floating in the middle of the screen with
        // the time grid stuck at the bottom (which is exactly the bug
        // user reported in the v0.7.6 screenshot).
        VStack(spacing: 0) {
            // v1.3.2 DIAGNOSTIC — surfaces "why is week view empty?" data
            // in-app instead of needing Xcode logs. Remove once the
            // sync bug is resolved.
            diagnosticBanner
            headerRow
            if !allDayEvents.isEmpty { allDayRow }
            ScrollViewReader { proxy in
                ScrollView(.vertical, showsIndicators: true) {
                    ZStack(alignment: .topLeading) {
                        gridBackground
                        eventLayer
                        nowLine
                    }
                    .frame(height: hourHeight * 24)
                }
                .frame(maxHeight: .infinity)
                .onAppear {
                    // Land somewhere useful: an hour before current time
                    // when today is in this week; otherwise 8 AM.
                    let cal = Calendar.current
                    let now = Date()
                    let hour = dayStarts.contains(where: { cal.isDateInToday($0) })
                        ? max(0, cal.component(.hour, from: now) - 1)
                        : 8
                    proxy.scrollTo("hour-\(hour)", anchor: .top)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .sheet(item: $detailFor) { ev in
            NavigationStack {
                EventDetailView(
                    event: ev,
                    calendar: calLookup[ev.calendarId],
                    allCalendars: calendars,
                    onChanged: onEventChanged,
                )
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("关闭") { detailFor = nil }
                    }
                }
            }
        }
        .sheet(item: Binding(
            get: { createSeed.map { CreateSeedItem(id: "\($0.calendarId)@\($0.start.timeIntervalSince1970)", calendarId: $0.calendarId, start: $0.start) } },
            set: { _ in createSeed = nil },
        )) { seed in
            NavigationStack {
                EventEditView(
                    mode: .create,
                    calendars: calendars,
                    prefilledStart: seed.start,
                    onSaved: { _ in
                        createSeed = nil
                        onEventChanged()
                    },
                    onCancel: { createSeed = nil },
                )
            }
        }
        // Recurring drag → scope picker sheet. Picking commits PATCH;
        // dismissing cancels the move (parent reload puts the event
        // back since we didn't fire PATCH).
        .sheet(isPresented: Binding(
            get: { pendingMove != nil && pendingMove!.event.rrule != nil },
            set: { if !$0 { pendingMove = nil } },
        )) {
            RecurringScopePicker(action: .edit, onPick: { scope in
                if let m = pendingMove {
                    Task { await commitMove(m, scope: scope) }
                }
                pendingMove = nil
            }, onCancel: { pendingMove = nil })
        }
        .alert("移动失败", isPresented: Binding(
            get: { moveErrorMessage != nil },
            set: { if !$0 { moveErrorMessage = nil } },
        )) {
            Button("好") { moveErrorMessage = nil }
        } message: {
            Text(moveErrorMessage ?? "")
        }
    }

    // MARK: - Diagnostic banner (v1.3.2, temporary)
    // Surfaces the data the week-view rendering decisions hinge on so we
    // can tell from a screenshot whether the bug is "events empty" or
    // "events present but mis-positioned". Will be removed once the
    // iOS week-view-missing-events bug is resolved.
    private var diagnosticBanner: some View {
        let f = DateFormatter()
        f.dateFormat = "MM/dd HH:mm"
        f.timeZone = TimeZone.current
        let firstStr: String = {
            if let d = timedEvents.first?.startsAt { return f.string(from: d) }
            return "—"
        }()
        let weekStartStr = f.string(from: weekStart)
        let lastDayStr: String = {
            if let d = dayStarts.last { return f.string(from: d) }
            return "—"
        }()
        // Recompute the SAME per-day filter positionedEvents uses, so we
        // can see exactly which (day, count) buckets it produces — and
        // for the first matched event, where it would render (x, y).
        let perDayCounts: [(Int, Int)] = {
            let cal = Calendar.current
            return dayStarts.enumerated().map { (idx, day) -> (Int, Int) in
                let dayStart = cal.startOfDay(for: day)
                let dayEnd = cal.date(byAdding: .day, value: 1, to: dayStart)!
                let n = timedEvents.filter { $0.startsAt < dayEnd && $0.endsAt > dayStart }.count
                return (idx, n)
            }
        }()
        let bucketStr = perDayCounts.map { "\($0.0):\($0.1)" }.joined(separator: " ")
        let posCount = positionedEvents(width: 50).count
        return Text("DBG: ev=\(events.count) timed=\(timedEvents.count) ad=\(allDayEvents.count) days=\(dayStarts.count) cal=\(calendars.count) pos=\(posCount)\nwk=\(weekStartStr) → \(lastDayStr) · first=\(firstStr)\nbuckets=\(bucketStr)")
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.yellow.opacity(0.12))
    }

    // MARK: - Header (weekday labels + date numbers)
    // Pin to a fixed compact height (52pt) — without this constraint
    // the VStack would happily give the row whatever's left over after
    // the ScrollView claims its share, blowing the date numbers up
    // huge on tall phones.
    private var headerRow: some View {
        HStack(spacing: 0) {
            // Time gutter spacer
            Color.clear.frame(width: timeGutterWidth)
            ForEach(dayStarts, id: \.self) { day in
                DayHeader(day: day)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(height: 52)
        .padding(.vertical, 4)
        .background(Color(.systemBackground))
        .overlay(Divider(), alignment: .bottom)
    }

    // MARK: - All-day row
    // Each pill is ~20pt tall; cap at allDayMaxRows × 20 + padding so
    // a busy all-day day can't push the time grid completely off
    // screen. With 3 rows = ~70pt, comfortably under the threshold.
    private var allDayRow: some View {
        let perDay = bucketAllDayByDay()
        let maxRows = min(allDayMaxRows, perDay.values.map { $0.count }.max() ?? 0)
        let rowHeight = CGFloat(maxRows) * 20 + 16
        return HStack(spacing: 0) {
            Text("全天")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .frame(width: timeGutterWidth)
            HStack(spacing: 1) {
                ForEach(dayStarts, id: \.self) { day in
                    VStack(spacing: 2) {
                        ForEach((perDay[day] ?? []).prefix(maxRows)) { ev in
                            allDayPill(ev: ev)
                        }
                        if (perDay[day]?.count ?? 0) > maxRows {
                            Text("+\((perDay[day]?.count ?? 0) - maxRows)")
                                .font(.system(size: 9))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 2)
                }
            }
        }
        .frame(height: rowHeight)
        .padding(.vertical, 4)
        .background(Theme.subtleSurface)
        .overlay(Divider(), alignment: .bottom)
    }

    private func allDayPill(ev: EventDTO) -> some View {
        let color = Color(hex: calLookup[ev.calendarId]?.color) ?? .accentColor
        return Text(ev.summary)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.white)
            .shadow(color: .black.opacity(0.18), radius: 0.5, x: 0, y: 0.5)
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 6).padding(.vertical, 3)
            .background(color, in: RoundedRectangle(cornerRadius: 4))
            .onTapGesture { detailFor = ev }
    }

    // MARK: - Grid background (hour lines + time labels)
    private var gridBackground: some View {
        VStack(spacing: 0) {
            ForEach(0..<24, id: \.self) { hour in
                HStack(spacing: 0) {
                    Text(String(format: "%02d:00", hour))
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                        .frame(width: timeGutterWidth - 4, alignment: .trailing)
                        .padding(.trailing, 4)
                        .offset(y: -6)  // sit above its line, not on it
                    Rectangle()
                        .fill(Color.clear)
                        .frame(maxWidth: .infinity)
                }
                .frame(height: hourHeight, alignment: .top)
                .id("hour-\(hour)")
                .overlay(
                    Rectangle().fill(Theme.gridLine).frame(height: 0.5),
                    alignment: .top,
                )
            }
        }
        // Column separators
        .overlay(
            HStack(spacing: 0) {
                Color.clear.frame(width: timeGutterWidth)
                ForEach(0..<7, id: \.self) { _ in
                    Rectangle()
                        .fill(Theme.gridLine)
                        .frame(width: 0.5)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            },
        )
    }

    // MARK: - Event layer (positions all timed events)
    private var eventLayer: some View {
        GeometryReader { geo in
            let columnWidth = (geo.size.width - timeGutterWidth) / 7
            let cal = Calendar.current
            ZStack(alignment: .topLeading) {
                // Tap-to-create background — one transparent rect per
                // (day, hour) cell. Stacked behind the event rectangles
                // so events still get tapped first.
                ForEach(Array(dayStarts.enumerated()), id: \.offset) { dayIdx, day in
                    ForEach(0..<24, id: \.self) { hour in
                        Color.clear
                            .frame(width: columnWidth, height: hourHeight)
                            .contentShape(Rectangle())
                            .offset(
                                x: timeGutterWidth + CGFloat(dayIdx) * columnWidth,
                                y: CGFloat(hour) * hourHeight,
                            )
                            .onTapGesture {
                                guard let firstCal = calendars.first else { return }
                                let start = cal.date(bySettingHour: hour, minute: 0, second: 0, of: day) ?? day
                                createSeed = (firstCal.id, start)
                            }
                    }
                }
                ForEach(positionedEvents(width: columnWidth)) { p in
                    eventRect(for: p)
                }
            }
        }
    }

    private func eventRect(for p: PositionedEvent) -> some View {
        let color = Color(hex: calLookup[p.event.calendarId]?.color) ?? .accentColor
        let isDragging = dragState?.eventId == p.event.id
        let mode = dragState?.mode
        // Already-ended events fade out + get a strikethrough on the
        // title so a Saturday morning glance shows "today's left" vs
        // "today's done" at a flash.
        let isPast = p.event.endsAt < Date()
        // Move mode: rect translates dx/dy. Resize mode: rect height
        // grows by dy (start stays put); we ignore dx in resize.
        let dragDx = (isDragging && mode == .move) ? dragState!.dx : 0
        let dragDy = (isDragging && mode == .move) ? dragState!.dy : 0
        let resizeDy = (isDragging && mode == .resize) ? dragState!.dy : 0
        let bgOpacity: Double = isDragging ? 0.7 : (isPast ? 0.55 : 0.95)
        return ZStack(alignment: .bottom) {
            VStack(alignment: .leading, spacing: 2) {
                Text(p.event.summary)
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(.white)
                    // Subtle shadow keeps the title legible when the
                    // calendar color is pastel (e.g. light yellow / pink).
                    // Without it, white text vanishes on a #FBBF24 bar.
                    .shadow(color: .black.opacity(0.18), radius: 0.5, x: 0, y: 0.5)
                    .strikethrough(isPast, color: .white.opacity(0.85))
                    .lineLimit(p.height > 36 ? 2 : 1)
                if p.height > 50, let location = p.event.location, !location.isEmpty {
                    Text(location)
                        .font(.system(size: 10))
                        .foregroundStyle(.white.opacity(0.9))
                        .shadow(color: .black.opacity(0.18), radius: 0.5, x: 0, y: 0.5)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 4).padding(.vertical, 3)
            .frame(width: p.width, height: max(p.height + resizeDy, 18), alignment: .topLeading)
            .background(color.opacity(bgOpacity), in: RoundedRectangle(cornerRadius: 4))
            // Resize handle — bottom 6pt strip, slightly darker. Gesture
            // attached separately so we can detect "is the touch on the
            // handle" by Y position in onChanged.
            Rectangle()
                .fill(Color.white.opacity(0.0001))  // hittable but invisible
                .frame(height: 12)
                .overlay(
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(Color.white.opacity(0.8))
                        .frame(width: 16, height: 3)
                        .opacity(p.height > 30 ? 0.6 : 0),  // hide grip on tiny events
                )
                .contentShape(Rectangle())
                .gesture(resizeGesture(for: p))
        }
        .scaleEffect(isDragging && mode == .move ? 1.04 : 1.0)
        .shadow(color: isDragging ? .black.opacity(0.25) : .clear, radius: isDragging ? 8 : 0, y: isDragging ? 4 : 0)
        .offset(x: p.x + dragDx, y: p.y + dragDy)
        .zIndex(isDragging ? 100 : 0)
        .animation(.easeOut(duration: 0.12), value: isDragging)
        // Tap = open detail; long-press + drag (on body) = move.
        .onTapGesture { detailFor = p.event }
        .gesture(dragGesture(for: p))
    }

    // Resize gesture — fires on the bottom-edge handle. No long-press
    // needed (the handle is small + dedicated) so it's a plain drag.
    private func resizeGesture(for p: PositionedEvent) -> some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { drag in
                if dragState?.eventId != p.event.id || dragState?.mode != .resize {
                    dragState = DragState(
                        eventId: p.event.id,
                        mode: .resize,
                        origStart: p.event.startsAt,
                        origEnd: p.event.endsAt,
                        origDayIdx: dayIndex(for: p.event.startsAt) ?? 0,
                        dx: 0, dy: 0,
                    )
                    UISelectionFeedbackGenerator().selectionChanged()
                }
                dragState?.dy = drag.translation.height
            }
            .onEnded { _ in
                guard let s = dragState else { return }
                dragState = nil
                // Convert dy to minutes, snap 15-min, apply to endsAt only.
                let rawMin = (s.dy / hourHeight) * 60.0
                let snapped = Int((rawMin / 15.0).rounded()) * 15
                if abs(snapped) < 5 { return }
                guard let originalEvent = events.first(where: { $0.id == s.eventId }) else { return }
                let newEnd = Calendar.current.date(byAdding: .minute, value: snapped, to: s.origEnd)!
                // Don't allow newEnd to dip below newStart + 15 min.
                let minEnd = Calendar.current.date(byAdding: .minute, value: 15, to: originalEvent.startsAt)!
                let finalEnd = max(newEnd, minEnd)
                let move = PendingMove(event: originalEvent, newStart: originalEvent.startsAt, newEnd: finalEnd)
                if originalEvent.rrule != nil {
                    pendingMove = move
                } else {
                    Task { await commitMove(move, scope: nil) }
                }
            }
    }

    // Long-press 0.4s → drag. Visible feedback (scale + shadow + offset)
    // tied to dragState. On release, snap and commit.
    private func dragGesture(for p: PositionedEvent) -> some Gesture {
        LongPressGesture(minimumDuration: 0.4)
            .sequenced(before: DragGesture(minimumDistance: 0))
            .onChanged { value in
                switch value {
                case .first:
                    // Long-press in progress; nothing visible until drag.
                    return
                case .second(true, let drag):
                    guard let drag else { return }
                    // First tick: latch onto this event.
                    if dragState == nil || dragState?.eventId != p.event.id || dragState?.mode != .move {
                        dragState = DragState(
                            eventId: p.event.id,
                            mode: .move,
                            origStart: p.event.startsAt,
                            origEnd: p.event.endsAt,
                            origDayIdx: dayIndex(for: p.event.startsAt) ?? 0,
                            dx: 0, dy: 0,
                        )
                        // Light haptic on grab
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    }
                    dragState?.dx = drag.translation.width
                    dragState?.dy = drag.translation.height
                default: return
                }
            }
            .onEnded { _ in
                guard let s = dragState else { return }
                dragState = nil
                // Compute the new start time from the drag offset. snap
                // hour delta is "translation.height / hourHeight" rounded
                // to nearest 15-min; day delta is dx / columnWidth rounded
                // to whole columns.
                let snapped = computeSnappedMove(s)
                // No-op moves: < 5 minutes shift and same day.
                if abs(snapped.minuteDelta) < 5 && snapped.dayDelta == 0 { return }
                guard let originalEvent = events.first(where: { $0.id == s.eventId }) else { return }
                let newStart = Calendar.current.date(
                    byAdding: .minute,
                    value: snapped.minuteDelta + snapped.dayDelta * 24 * 60,
                    to: s.origStart,
                )!
                let newEnd = Calendar.current.date(
                    byAdding: .minute,
                    value: snapped.minuteDelta + snapped.dayDelta * 24 * 60,
                    to: s.origEnd,
                )!
                let move = PendingMove(event: originalEvent, newStart: newStart, newEnd: newEnd)
                if originalEvent.rrule != nil {
                    // Recurring: prompt for scope. The .sheet(isPresented:)
                    // higher up watches pendingMove and shows RecurringScopePicker.
                    pendingMove = move
                } else {
                    Task { await commitMove(move, scope: nil) }
                }
            }
    }

    // Snap the in-progress drag to grid increments. Day delta = full
    // columns. Time delta = 15-min increments within the column.
    private func computeSnappedMove(_ s: DragState) -> (minuteDelta: Int, dayDelta: Int) {
        // Day delta from horizontal translation. We need column width
        // at gesture commit time — approximate using the on-screen ratio.
        // Since columnWidth depends on layout, we use a reasonable
        // assumption: visible width / 7. Compute lazily off a stash that
        // the layer captures via GeometryReader.
        // Simpler: use the most recent columnWidth we computed in
        // positionedEvents (cached via @State would be cleaner; for v0.9
        // we read from UIScreen.main.bounds and trust it).
        let estimatedWidth = (UIScreen.main.bounds.width - timeGutterWidth) / 7
        let dayDelta = Int((s.dx / estimatedWidth).rounded())
        // Minutes from vertical translation: dy / hourHeight * 60
        let rawMin = (s.dy / hourHeight) * 60.0
        // Round to nearest 15-min step
        let snappedMin = Int((rawMin / 15.0).rounded()) * 15
        return (snappedMin, dayDelta)
    }

    // Returns the day-column index (0-6) for a given start date, if
    // it falls within the visible week. Used to seed DragState.
    private func dayIndex(for date: Date) -> Int? {
        let cal = Calendar.current
        for (i, day) in dayStarts.enumerated() where cal.isDate(date, inSameDayAs: day) {
            return i
        }
        return nil
    }

    // Fire the PATCH and let the parent reload reflect the result.
    // Failure surfaces via moveErrorMessage alert; the parent reload
    // also runs on success so the optimistic move is replaced with the
    // true server response (which may differ if there were concurrent
    // changes).
    private func commitMove(_ m: PendingMove, scope: RecurringScope?) async {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let recIso: String? = scope == nil ? nil : f.string(from: m.event.startsAt)
        let body = EventUpdateInput(
            calendarId: nil,
            summary: nil,
            description: nil,
            location: nil,
            startsAt: f.string(from: m.newStart),
            endsAt: f.string(from: m.newEnd),
            allDay: nil,
            rrule: nil,
            // Drag-to-move only changes start/end — leave the event's
            // existing timezone / attendees / category untouched. Server
            // treats a nil extra as "no change" (PATCH semantics).
            extra: nil,
            scope: scope?.rawValue,
            recurrenceId: recIso,
        )
        do {
            let client = APIClient(state: state)
            let _: EventDTO = try await client.patch("/events/\(m.event.id)", body: body)
            onEventChanged()
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch let e as APIError {
            moveErrorMessage = e.localizedDescription
            // Trigger a reload to restore the original time visually.
            onEventChanged()
        } catch {
            moveErrorMessage = error.localizedDescription
            onEventChanged()
        }
    }

    // MARK: - Current-time line (only on today's column)
    private var nowLine: some View {
        GeometryReader { geo in
            let cal = Calendar.current
            if let todayIdx = dayStarts.firstIndex(where: { cal.isDateInToday($0) }) {
                let columnWidth = (geo.size.width - timeGutterWidth) / 7
                let now = Date()
                let hour = cal.component(.hour, from: now)
                let minute = cal.component(.minute, from: now)
                let y = (CGFloat(hour) + CGFloat(minute) / 60.0) * hourHeight
                let x = timeGutterWidth + CGFloat(todayIdx) * columnWidth
                ZStack(alignment: .topLeading) {
                    // Red dot on left + line across the column
                    Circle().fill(Color.red).frame(width: 8, height: 8)
                        .offset(x: x - 4, y: y - 4)
                    Rectangle().fill(Color.red).frame(width: columnWidth, height: 1.5)
                        .offset(x: x, y: y - 0.75)
                }
            }
        }
    }

    // MARK: - Event positioning (with overlap clusters)
    private func positionedEvents(width columnWidth: CGFloat) -> [PositionedEvent] {
        var out: [PositionedEvent] = []
        let cal = Calendar.current

        for (dayIdx, day) in dayStarts.enumerated() {
            // Events that touch this day (start before day-end and end
            // after day-start). Clip event height to the day boundaries.
            let dayStart = cal.startOfDay(for: day)
            let dayEnd = cal.date(byAdding: .day, value: 1, to: dayStart)!
            let onDay = timedEvents
                .filter { $0.startsAt < dayEnd && $0.endsAt > dayStart }
                .sorted { $0.startsAt < $1.startsAt }

            // Cluster overlapping events so we can split column width
            // evenly across each cluster. A cluster's "frontier" is the
            // latest end time seen so far; a new event that starts after
            // the frontier breaks into a new cluster.
            var clusters: [[EventDTO]] = []
            var currentCluster: [EventDTO] = []
            var frontier: Date = .distantPast
            for ev in onDay {
                if ev.startsAt >= frontier {
                    if !currentCluster.isEmpty { clusters.append(currentCluster) }
                    currentCluster = [ev]
                    frontier = ev.endsAt
                } else {
                    currentCluster.append(ev)
                    if ev.endsAt > frontier { frontier = ev.endsAt }
                }
            }
            if !currentCluster.isEmpty { clusters.append(currentCluster) }

            for cluster in clusters {
                let count = CGFloat(cluster.count)
                let slotWidth = columnWidth / count
                for (i, ev) in cluster.enumerated() {
                    // Clip to the day's bounds
                    let s = max(ev.startsAt, dayStart)
                    let e = min(ev.endsAt, dayEnd)
                    let startMin = cal.component(.hour, from: s) * 60 + cal.component(.minute, from: s)
                    let durMin = max(15, Int(e.timeIntervalSince(s) / 60))  // floor at 15 min so 0-min events still render
                    let y = CGFloat(startMin) / 60.0 * hourHeight
                    let h = CGFloat(durMin) / 60.0 * hourHeight
                    let x = timeGutterWidth + CGFloat(dayIdx) * columnWidth + CGFloat(i) * slotWidth
                    out.append(PositionedEvent(
                        id: "\(ev.id)@\(ev.startsAt.timeIntervalSince1970)@\(dayIdx)",
                        event: ev,
                        x: x,
                        y: y,
                        width: slotWidth - 2,
                        height: h - 2,
                    ))
                }
            }
        }
        return out
    }

    private func bucketAllDayByDay() -> [Date: [EventDTO]] {
        let cal = Calendar.current
        var out: [Date: [EventDTO]] = [:]
        for ev in allDayEvents {
            for day in dayStarts {
                let dayStart = cal.startOfDay(for: day)
                let dayEnd = cal.date(byAdding: .day, value: 1, to: dayStart)!
                if ev.startsAt < dayEnd && ev.endsAt > dayStart {
                    out[day, default: []].append(ev)
                }
            }
        }
        return out
    }
}

// MARK: - Helpers

private struct PositionedEvent: Identifiable {
    let id: String
    let event: EventDTO
    let x: CGFloat
    let y: CGFloat
    let width: CGFloat
    let height: CGFloat
}

private struct CreateSeedItem: Identifiable {
    let id: String
    let calendarId: String
    let start: Date
}

// Held while the user is actively dragging an event with their finger.
// dx/dy are the live translation in points; we apply them as .offset on
// the event rect (move mode) or stretch the height (resize mode). On
// release we snap (15-min on Y, full-day on X) and call commitMove.
private enum DragMode { case move, resize }
private struct DragState {
    let eventId: String
    let mode: DragMode
    let origStart: Date
    let origEnd: Date
    let origDayIdx: Int
    var dx: CGFloat
    var dy: CGFloat
}

// Held between drag-release and PATCH completion. For recurring events,
// the RecurringScopePicker is presented in this state — the user picks
// scope before we actually fire the API call.
private struct PendingMove {
    let event: EventDTO
    let newStart: Date
    let newEnd: Date
}

private struct DayHeader: View {
    let day: Date
    var body: some View {
        let cal = Calendar.current
        let isToday = cal.isDateInToday(day)
        VStack(spacing: 2) {
            Text(weekdayLabel(day))
                .font(.caption2.weight(.medium))
                .foregroundStyle(isToday ? Color.accentColor : Color.secondary)
            Text("\(cal.component(.day, from: day))")
                .font(.callout.weight(isToday ? .bold : .regular))
                .frame(minWidth: 24, minHeight: 24)
                .background(isToday ? Color.accentColor : .clear, in: Circle())
                .foregroundStyle(isToday ? .white : .primary)
        }
    }
    private func weekdayLabel(_ d: Date) -> String {
        DateFormatters.weekdayShort.string(from: d)
    }
}
