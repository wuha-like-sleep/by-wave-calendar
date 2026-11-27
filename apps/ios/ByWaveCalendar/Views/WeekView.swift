// WeekView.swift
// N-column × 24-hour time grid, like iOS Calendar / Google Calendar.
// dayCount=7 时是周网格；dayCount=1 时是展开态「日」视图的单日
// 时间轴（苹果日历 iPad 日视图的形态）。
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
    let weekStart: Date     // Monday of the displayed week (dayCount=1 时就是那一天)
    let events: [EventDTO]
    let calendars: [CalendarMeta]
    let onEventChanged: () -> Void
    // 7 = 周网格；1 = 单日时间轴。展开态（Duo 展开 / iPad）的「日」
    // 视图学苹果日历：不用手机上的议程列表，而是同一套时间网格
    // 只画一列 —— 全天行、红线、点空位新建、拖动改期全部现成。
    var dayCount: Int = 7
    // 紧凑态单日时间轴上方已经有周条（星期/日期/农历一整排），
    // 网格自带的日标题行（Fri / 27）再画一遍就是同一天出现
    // 两次 —— 调用方在那种情形传 false 把标题行关掉。多日和
    // 周视图没有周条代劳，标题行保留。
    var showsDayHeader: Bool = true

    @EnvironmentObject var state: AppState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var detailFor: EventDTO?
    @State private var createSeed: (calendarId: String, start: Date)?
    // Drag-to-move state. Set when a long-press completes on an event;
    // updated as the finger moves; consumed (commit/cancel) on release.
    @State private var dragState: DragState?
    /// Column width from the event layer's latest layout pass. The drag
    /// snap math needs it at gesture-commit time; it used to estimate
    /// from UIScreen, which is wrong whenever the week view isn't the
    /// full screen width (iPad split view / Stage Manager / foldables).
    @State private var lastColumnWidth: CGFloat = 0
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
        return (0..<dayCount).compactMap { cal.date(byAdding: .day, value: $0, to: weekStart) }
    }

    // Split events: all-day stays at the top, timed go in the grid.
    private var timedEvents: [EventDTO] { events.filter { !$0.allDay } }
    private var allDayEvents: [EventDTO] { events.filter { $0.allDay } }

    var body: some View {
        // 宽度只在一个地方量：根上的 GeometryReader。日期条、全天行、
        // 网格三者共用它算出的 columnWidth，列宽 1:1 是构造出来的、
        // 不是碰巧一致。以前日期条靠 VStack 撑满、网格靠 ScrollView
        // 里的 GeometryReader 各量各的，两个来源没有任何机制保证
        // 给出同一个数——在 Duo 折叠画布（466×678pt，宽高比和普通
        // iPhone 完全不同）上迟早分家。
        // GeometryReader 本身贪婪地占满提议尺寸，VStack 不会被
        // CalendarView 的 ZStack 垂直居中（v0.7.6 那次的毛病）。
        GeometryReader { geo in
            weekContent(totalWidth: geo.size.width)
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

    // The week's vertical stack. `totalWidth` comes from the single
    // GeometryReader in body; every horizontal measurement below
    // (header columns, all-day columns, grid) derives from it.
    private func weekContent(totalWidth: CGFloat) -> some View {
        let columnWidth = (totalWidth - timeGutterWidth) / CGFloat(dayCount)
        return VStack(spacing: 0) {
            // fixedSize 是硬要求不是装饰：headerRow 里的 Color.clear
            // 时间槽垫片在纵向是完全弹性的，VStack 会把剩余高度
            // 分给它和 ScrollView —— 标题行于是膨胀到占半屏、
            // DayHeader 被竖直居中在里面，全天行和网格被顶到
            // 下半屏（展开态日视图截图里那片大黑空）。两个行都
            // 钉死理想高度，剩余高度全部归 ScrollView。
            if showsDayHeader {
                headerRow(columnWidth: columnWidth)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !allDayEvents.isEmpty {
                allDayRow(columnWidth: columnWidth)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ScrollViewReader { proxy in
                ScrollView(.vertical, showsIndicators: true) {
                    ZStack(alignment: .topLeading) {
                        gridBackground
                        eventLayer
                        nowLine
                    }
                    // Explicit width, not just height: the stack must
                    // span the same totalWidth the header used, so the
                    // grid is full-bleed on any canvas (folded Duo,
                    // unfolded, iPad split) instead of sizing to
                    // whatever its children happen to propose.
                    .frame(width: totalWidth, height: hourHeight * 24)
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
    }

    // MARK: - Header (weekday labels + date numbers)
    // Height discipline matters as much as width here. DayHeader used
    // to carry `.frame(maxHeight: .infinity)`, which made this whole
    // row height-flexible: WeekView's VStack then split its leftover
    // height between this row and the ScrollView, the row ballooned
    // to a third of the screen, and its (vertically centered) labels
    // floated mid-screen with the all-day row and grid shoved below —
    // exactly the folded-Duo screenshot. The row now takes only its
    // natural height: minHeight 52 is a floor, not a claim (the labels
    // are Dynamic Type fonts and a hard 52pt clipped them at the
    // largest sizes).
    private func headerRow(columnWidth: CGFloat) -> some View {
        HStack(spacing: 0) {
            // Time gutter spacer
            Color.clear.frame(width: timeGutterWidth)
            ForEach(dayStarts, id: \.self) { day in
                DayHeader(day: day)
                    .frame(width: columnWidth)
            }
        }
        .frame(minHeight: 52)
        .padding(.vertical, 4)
        .background(Color(.systemBackground))
        .overlay(Divider(), alignment: .bottom)
    }

    // MARK: - All-day row
    // Each pill is ~24pt tall at the default text size (caption2 line +
    // vertical padding); cap at allDayMaxRows × 24 + padding so a busy
    // all-day day can't push the time grid completely off screen. The
    // per-row allowance used to be 20pt, which under-measured the pill
    // at larger Dynamic Type sizes and let pills overlap the row frame.
    private func allDayRow(columnWidth: CGFloat) -> some View {
        let perDay = bucketAllDayByDay()
        let maxRows = min(allDayMaxRows, perDay.values.map { $0.count }.max() ?? 0)
        let rowHeight = CGFloat(maxRows) * 24 + 16
        return HStack(spacing: 0) {
            Text("全天")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .frame(width: timeGutterWidth)
            // Same fixed columnWidth as the header and the grid — the
            // pills used to distribute by maxWidth inside their own
            // HStack (with an extra 1pt inter-column spacing), a third
            // independent width model that could drift from the grid.
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
                .padding(.horizontal, 2)
                .frame(width: columnWidth, alignment: .leading)
            }
        }
        .frame(height: rowHeight)
        .padding(.vertical, 4)
        .background(Theme.subtleSurface)
        .overlay(Divider(), alignment: .bottom)
    }

    private func allDayPill(ev: EventDTO) -> some View {
        let color = Color(hex: calLookup[ev.calendarId]?.color) ?? .accentColor
        // Same fill strength (0.9) and text rule as the other clients'
        // all-day / month bars — see Theme.eventTextColor.
        let textColor = Theme.eventTextColor(forHex: calLookup[ev.calendarId]?.color)
        return Text(ev.summary)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(textColor)
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 6).padding(.vertical, 3)
            .background(color.opacity(0.9), in: RoundedRectangle(cornerRadius: Theme.Radius.eventBlock))
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
                ForEach(0..<dayCount, id: \.self) { _ in
                    Rectangle()
                        .fill(Theme.gridLine)
                        .frame(width: 0.5)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            },
        )
    }

    // MARK: - Event layer (positions all timed events)
    //
    // v1.3.2 BUGFIX — the inner ZStack used to be sized by its largest
    // child's natural frame (~ 52 × 124 — one tap-cell or one event
    // rect). All children were then `.offset(x: 244, y: 756)` etc. to
    // their grid positions. SwiftUI silently culled those rects because
    // they sit OUTSIDE the ZStack's tiny layout frame — `.offset` does
    // shift the visual position but the renderer was treating the
    // offset target area as unreachable. nowLine "worked" only because
    // its Rectangle was `.frame(width: columnWidth, ...)` which alone
    // grew the ZStack to (at least) `columnWidth` × 1.5 — wide enough
    // for the offset target to fall inside, but events still went past
    // its bottom edge.
    //
    // Fix: switch from `.frame() + .offset()` to `.position(x:, y:)`,
    // which positions children's CENTER at the given point in the
    // parent's coordinate space. Parent is the GR (full grid 414×1344).
    // This way SwiftUI knows the children are inside the parent's
    // rendering area and renders them properly. Cleaner intent too —
    // we're saying "put this rect at this point", not "lay it out at
    // 0,0 and shift visually."
    private var eventLayer: some View {
        GeometryReader { geo in
            let columnWidth = (geo.size.width - timeGutterWidth) / CGFloat(dayCount)
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
                            .position(
                                x: timeGutterWidth + (CGFloat(dayIdx) + 0.5) * columnWidth,
                                y: (CGFloat(hour) + 0.5) * hourHeight,
                            )
                            .onTapGesture {
                                guard let firstCal = calendars.first else { return }
                                let start = cal.date(bySettingHour: hour, minute: 0, second: 0, of: day) ?? day
                                createSeed = (firstCal.id, start)
                            }
                    }
                }
                ForEach(positionedEvents(width: columnWidth)) { p in
                    // `.position` anchors the view's CENTER at (x, y).
                    // positionedEvents emits top-left coords, so add
                    // half width/height to convert.
                    eventRect(for: p)
                        .position(x: p.x + p.width / 2, y: p.y + p.height / 2)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .onChange(of: columnWidth) { _, newWidth in
                lastColumnWidth = newWidth
            }
            .onAppear { lastColumnWidth = columnWidth }
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
        // Text follows the fill's luminance (Theme.eventTextColor) —
        // the drop shadow that used to prop up white text on pastel
        // calendars is gone; black text on a pale fill needs no prop.
        let textColor = Theme.eventTextColor(forHex: calLookup[p.event.calendarId]?.color)
        // Cross-day continuation: square off the corners on any side
        // where the event runs on into the neighbouring day, so the
        // per-day segments read as one continuous bar across the grid
        // instead of separate pills. Shape only — position and size
        // come from positionedEvents unchanged.
        let r = Theme.Radius.eventBlock
        let shape = UnevenRoundedRectangle(
            topLeadingRadius: p.continuesFromPreviousDay ? 0 : r,
            bottomLeadingRadius: p.continuesFromPreviousDay ? 0 : r,
            bottomTrailingRadius: p.continuesToNextDay ? 0 : r,
            topTrailingRadius: p.continuesToNextDay ? 0 : r,
            style: .continuous,
        )
        return ZStack(alignment: .bottom) {
            VStack(alignment: .leading, spacing: 2) {
                Text(p.event.summary)
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(textColor)
                    .strikethrough(isPast, color: textColor.opacity(0.85))
                    .lineLimit(p.height > 36 ? 2 : 1)
                if p.height > 44, let location = p.event.location, !location.isEmpty {
                    Text(location)
                        .font(.system(size: 10))
                        .foregroundStyle(textColor.opacity(0.9))
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 4).padding(.vertical, 3)
            .frame(width: p.width, height: max(p.height + resizeDy, 18), alignment: .topLeading)
            .background(color.opacity(bgOpacity), in: shape)
            // The title/location are fixed-size fonts inside a
            // duration-sized frame; without clipping, a two-line title
            // on a short event painted over the block below it.
            .clipShape(shape)
            // Resize handle — bottom 6pt strip, slightly darker. Gesture
            // attached separately so we can detect "is the touch on the
            // handle" by Y position in onChanged.
            Rectangle()
                .fill(Color.white.opacity(0.0001))  // hittable but invisible
                .frame(height: 12)
                .overlay(
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(textColor.opacity(0.8))
                        .frame(width: 16, height: 3)
                        .opacity(p.height > 30 ? 0.6 : 0),  // hide grip on tiny events
                )
                .contentShape(Rectangle())
                .gesture(resizeGesture(for: p))
        }
        .scaleEffect(isDragging && mode == .move ? 1.04 : 1.0)
        .shadow(color: isDragging ? .black.opacity(0.25) : .clear, radius: isDragging ? 8 : 0, y: isDragging ? 4 : 0)
        // Positional offset moved up to the eventLayer's ForEach where we
        // use `.position(x:y:)` on the whole eventRect. Only the in-drag
        // dx/dy translation stays here so the drag preview still slides
        // under the user's finger.
        .offset(x: dragDx, y: dragDy)
        .zIndex(isDragging ? 100 : 0)
        .animation(.easeOut(duration: 0.12), value: isDragging)
        // Tap = open detail; long-press + drag (on body) = move.
        .onTapGesture { detailFor = p.event }
        .gesture(dragGesture(for: p))
    }

    // Resize gesture — fires on the bottom-edge handle. Gated behind a
    // short long-press (0.3s) BEFORE the drag, exactly like move: a plain
    // vertical SCROLL over the handle used to start a resize by accident
    // while the user was just browsing their day. Requiring a deliberate
    // press-then-drag means a scroll (which never holds) can no longer
    // steal into a resize.
    private func resizeGesture(for p: PositionedEvent) -> some Gesture {
        LongPressGesture(minimumDuration: 0.3)
            .sequenced(before: DragGesture(minimumDistance: 8))
            .onChanged { value in
                switch value {
                case .first:
                    // Press in progress; nothing visible until the drag begins.
                    return
                case .second(true, let drag):
                    guard let drag else { return }
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
                default:
                    return
                }
            }
            .onEnded { _ in
                // Only commit if we actually entered the resize drag phase.
                guard let s = dragState, s.mode == .resize else { dragState = nil; return }
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
            // Require a clear 10pt drag AFTER the long-press before we start
            // moving — a micro-jitter while holding shouldn't nudge the time.
            .sequenced(before: DragGesture(minimumDistance: 10))
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
        // Day delta from horizontal translation, using the column width
        // the event layer actually laid out with (stashed via onChange
        // above). A drag can only start on a rendered event, which
        // means the event layer has laid out and stashed the real
        // width — so there is no honest fallback: the old UIScreen
        // estimate read the full device canvas, which is the wrong
        // width in split view / Stage Manager / unfolded Duo detail
        // columns. No measured width → no day shift, time-only move.
        // 钳在可见列内：单日时间轴（dayCount=1）横向拖不能把事件
        // 拖出画面消失；周网格里也以可见周为界（与原来靠列数自然
        // 限制的体感一致，只是现在显式写出来）。
        let dayDelta: Int
        if lastColumnWidth > 0 {
            let rawDayDelta = Int((s.dx / lastColumnWidth).rounded())
            dayDelta = min(max(rawDayDelta, -s.origDayIdx), dayCount - 1 - s.origDayIdx)
        } else {
            dayDelta = 0
        }
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
            // 拖动只改起止时间，删失的期次名单不归这里管：省略 = 不动。
            exdates: nil,
        )
        // 走离线队列：拖动改时间先落本地 + 入队，没网不再弹错把事件
        // 弹回原位——新位置保留显示、标待同步，网络恢复自动送出。
        // 被服务端明确拒绝（停进待处理）时，日历页顶上的待处理条
        // 会让用户去裁决。
        if let bodyData = try? JSONEncoder.iso().encode(AnyEncodable(body)) {
            state.offlineSync.enqueueUpdate(
                eventId: m.event.id, bodyData: bodyData,
                scope: scope?.rawValue, recurrenceId: recIso,
                baseStartsAt: f.string(from: m.event.startsAt),
                snapshot: [m.event], summary: m.event.summary,
            )
            await state.offlineSync.replay()
        }
        onEventChanged()
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    // MARK: - Current-time line (only on today's column)
    // 定版口径（三端一致）：线连续走，位置按当前时刻精确计算，不再
    // 每分钟跳一格。TimelineView 按秒重绘的只有这条线本身，网格与
    // 事件层不跟着刷新；视图离开层级（切到日/月/年视图）或 App
    // 退到后台时它自动停摆，不留常驻定时器。系统「减少动态效果」
    // 开启时回退到每 60 秒刷新 + 只算到分钟，即原来的跳格行为。
    private var nowLine: some View {
        TimelineView(.periodic(from: .now, by: reduceMotion ? 60 : 1)) { context in
            nowLineContent(at: context.date)
        }
    }

    private func nowLineContent(at now: Date) -> some View {
        GeometryReader { geo in
            let cal = Calendar.current
            if let todayIdx = dayStarts.firstIndex(where: { cal.isDateInToday($0) }) {
                let columnWidth = (geo.size.width - timeGutterWidth) / CGFloat(dayCount)
                let hour = cal.component(.hour, from: now)
                let minute = cal.component(.minute, from: now)
                // 连续口径把秒也算进位置：56pt 一小时，秒步进约
                // 0.016pt，肉眼就是平滑滑动。减少动态时秒归零，
                // 与每分钟一次的刷新对齐成整格跳动。
                let second = reduceMotion ? 0 : cal.component(.second, from: now)
                let y = (CGFloat(hour) + CGFloat(minute) / 60.0 + CGFloat(second) / 3600.0) * hourHeight
                let x = timeGutterWidth + CGFloat(todayIdx) * columnWidth
                ZStack(alignment: .topLeading) {
                    // Dot on left + line across the column. The red is
                    // pinned to the cross-client value (#E5484D, same as
                    // web + Android + desktop) instead of Color.red,
                    // whose system value shifts between light and dark
                    // appearances — the line must be the identical red
                    // in both. This view stays last in the grid ZStack
                    // so event blocks never cover it.
                    Circle().fill(Color(hex: "#E5484D") ?? .red).frame(width: 8, height: 8)
                        .offset(x: x - 4, y: y - 4)
                    Rectangle().fill(Color(hex: "#E5484D") ?? .red).frame(width: columnWidth, height: 1.5)
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
                        // 22pt floor, the same trade-off Android and
                        // desktop document: at the raw duration height a
                        // 15-minute block is 12pt, of which the vertical
                        // padding eats 6 — its only line of text was
                        // always clipped away. The floor lets a short
                        // block lap a few points over the next hour line
                        // rather than render text-less. y is untouched.
                        height: max(h - 2, 22),
                        continuesFromPreviousDay: ev.startsAt < dayStart,
                        continuesToNextDay: ev.endsAt > dayEnd,
                    ))
                }
            }
        }
        return out
    }

    private func bucketAllDayByDay() -> [Date: [EventDTO]] {
        // 以前这里拿本地时区的日界去比全天事件的 startsAt/endsAt，
        // 而全天存的是 UTC 午夜 —— 东八区里一个「9 月 21 日」的全天事件
        // 会同时落进 21 日和 22 日两格，界面上并排画两遍。见 AllDayDates。
        let cal = Calendar.current
        var out: [Date: [EventDTO]] = [:]
        for ev in allDayEvents {
            for day in dayStarts where AllDayDates.occupies(ev, localDay: day, calendar: cal) {
                out[day, default: []].append(ev)
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
    // Cross-day continuation, carried alongside the (unchanged)
    // position so the rect can square off the corners on a side where
    // the event runs on into the neighbouring day.
    let continuesFromPreviousDay: Bool
    let continuesToNextDay: Bool
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
