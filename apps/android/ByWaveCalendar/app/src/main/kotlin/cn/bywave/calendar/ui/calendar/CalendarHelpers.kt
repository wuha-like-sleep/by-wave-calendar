// Shared helpers for the three calendar views. Keep formatters + color
// parsing in one place so DayView / WeekView / MonthView don't drift.
//
// All time math is in the device's local TimeZone via ZoneId.systemDefault().
// Matches iOS (Calendar.current uses system TZ); both clients render the
// same UTC instant in the user's local clock.

package cn.bywave.calendar.ui.calendar

import android.text.format.DateFormat
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import cn.bywave.calendar.R
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.EventDTO
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

internal val FALLBACK_COLOR = Color(0xFF6640E9)

internal fun parseHex(hex: String?): Color {
    if (hex.isNullOrBlank()) return FALLBACK_COLOR
    val cleaned = hex.removePrefix("#")
    return runCatching {
        val v = cleaned.toLong(16)
        Color(
            red = ((v shr 16) and 0xff) / 255f,
            green = ((v shr 8) and 0xff) / 255f,
            blue = (v and 0xff) / 255f,
        )
    }.getOrDefault(FALLBACK_COLOR)
}

internal fun calendarColor(event: EventDTO, calendars: List<CalendarMeta>): Color =
    parseHex(calendars.firstOrNull { it.id == event.calendarId }?.color)

internal fun calendarName(event: EventDTO, calendars: List<CalendarMeta>): String? =
    calendars.firstOrNull { it.id == event.calendarId }?.name

/** Parse the server's ISO8601 string. Returns null on bad data. */
internal fun parseInstant(iso: String?): Instant? =
    iso?.let { runCatching { Instant.parse(it) }.getOrNull() }

internal fun toLocal(i: Instant?): LocalDateTime? =
    i?.atZone(ZoneId.systemDefault())?.toLocalDateTime()

internal fun toLocalDate(i: Instant?): LocalDate? =
    i?.atZone(ZoneId.systemDefault())?.toLocalDate()

/** True if `event` touches the given day in the device's local TZ. */
internal fun eventOnDay(event: EventDTO, day: LocalDate): Boolean {
    val zone = ZoneId.systemDefault()
    val s = parseInstant(event.startsAt) ?: return false
    val e = parseInstant(event.endsAt) ?: return false
    val dayStart = day.atStartOfDay(zone).toInstant()
    val dayEnd = day.plusDays(1).atStartOfDay(zone).toInstant()
    return s.isBefore(dayEnd) && e.isAfter(dayStart)
}

/** Mon-anchored start of the week containing `date`. Mirrors iOS
 *  startOfWeek which sets firstWeekday=2. */
internal fun startOfWeek(date: LocalDate): LocalDate =
    date.minusDays((date.dayOfWeek.value - DayOfWeek.MONDAY.value).toLong())

internal fun dayStartsOfWeek(anchor: LocalDate): List<LocalDate> {
    val start = startOfWeek(anchor)
    return (0L..6L).map { start.plusDays(it) }
}

// ---- Formatters ----
//
// 日期/时间的排法必须跟着「界面语言 + 系统的 12/24 小时开关」走。
// 这里原本写死了 "yyyy 年 M 月 d 日" 和 "HH:mm"：结果是把 APP 切到英文
// / 日文 / 德文，顶部日期照样是中文的年月日；手机调成 12 小时制，事件
// 时间也还是 24 小时。
//
// 修法不是给 8 种语言各写一份 pattern（那会随着语言增加一直加），而是
// 只描述「要哪些字段」——年、月、日、星期——交给 getBestDateTimePattern
// 按该语言的本地习惯排序并挑分隔符。12/24 小时用 DateFormat.is24HourFormat
// 读系统开关，而不是假定某种语言一定用哪种。

/** 按 skeleton 取该语言的本地排法。默认实现就是平台的 ICU。
 *  单独抽出来是为了能在纯 JVM 单元测试里换成别的数据源 —— 平台这个方法
 *  在单元测试的 android.jar 桩里是抛 "Stub!" 的。 */
internal typealias BestPatternProvider = (Locale, String) -> String

internal val PlatformBestPattern: BestPatternProvider = { locale, skeleton ->
    DateFormat.getBestDateTimePattern(locale, skeleton)
}

/** 一套按当前语言 + 12/24 小时设置算好的格式器。构造一次复用，
 *  DateTimeFormatter 本身线程安全。
 *
 *  ⚠️ 五个 formatter 都是构造时求值的 val，也就是说 of() 一抛，
 *  rememberCalendarFormats() 的调用方（日/周/月视图顶栏、搜索、事件编辑）
 *  全部当场崩。of() 因此必须是**全函数**：
 *    ① 先把 ICU pattern 降级成 java.time 认识的写法（DateTimePatternCompat.kt）；
 *    ② 外面再包 runCatching，失败回落到固定 pattern。
 *  两道都要有 —— ① 管的是已知的语法差异，② 管的是以后 CLDR 数据再变出
 *  什么我们没预料到的写法。
 */
internal class CalendarFormats(
    private val locale: Locale,
    use24Hour: Boolean,
    private val bestPattern: BestPatternProvider = PlatformBestPattern,
) {
    private val zone: ZoneId = ZoneId.systemDefault()

    private fun of(skeleton: String, fallback: String): DateTimeFormatter {
        val safe = runCatching { bestPattern(locale, skeleton) }
            .map { toJavaTimePattern(it) }
            .getOrNull()
            ?.takeIf { it.isNotBlank() }
        val built = safe?.let { runCatching { build(it) }.getOrNull() }
        // 回落用的 pattern 全是 ASCII、全在 java.time 的字母表里，
        // 任何 JVM / 任何语言都不会抛。
        return built ?: build(fallback)
    }

    private fun build(pattern: String): DateTimeFormatter =
        DateTimeFormatter.ofPattern(pattern, locale).withZone(zone)

    /** 12:30 / 12:30 PM —— 跟随系统开关。 */
    val time: DateTimeFormatter =
        of(if (use24Hour) "Hm" else "hm", if (use24Hour) "HH:mm" else "h:mm a")

    /** 日视图顶栏：2026年9月21日星期一 / Monday, September 21, 2026 */
    val dayHeader: DateTimeFormatter = of("yMMMMdEEEE", "yyyy-MM-dd EEEE")

    /** 周视图顶栏的起止两端：9月21日 / Sep 21 */
    val monthDay: DateTimeFormatter = of("MMMd", "MM-dd")

    /** 月视图顶栏：2026年9月 / September 2026 */
    val monthHeader: DateTimeFormatter = of("yMMMM", "yyyy-MM")

    /** 表单里的日期按钮：2026年9月21日 / Sep 21, 2026（不带星期，
     *  按钮放不下一整句「星期一」）。 */
    val monthDayYear: DateTimeFormatter = of("yMMMd", "yyyy-MM-dd")
}

@Composable
internal fun rememberCalendarFormats(): CalendarFormats {
    val context = LocalContext.current
    // 用 Configuration 里的 locale，而不是 Locale.getDefault()。
    // APP 内语言在本仓是这么落地的（见 i18n/LocaleHelper.kt）：
    //   - Android 13+：平台 LocaleManager.setApplicationLocales；
    //   - Android 12 及以下：BywaveApp / MainActivity 的 attachBaseContext
    //     里用 createConfigurationContext 换一个 Configuration。
    // 两条路都只保证 Configuration 里的 locale 是对的，进程默认 Locale
    // （Locale.getDefault()）在第二条路上根本不变 —— 用后者会让「APP 语言」
    // 这个设置对日期不生效。
    val locale = LocalConfiguration.current.locales[0]
    val use24Hour = DateFormat.is24HourFormat(context)
    return remember(locale, use24Hour) { CalendarFormats(locale, use24Hour) }
}

internal fun formatTimeRange(
    event: EventDTO,
    formats: CalendarFormats,
    allDayLabel: String,
): String {
    if (event.allDay) return allDayLabel
    val s = parseInstant(event.startsAt) ?: return "—"
    val e = parseInstant(event.endsAt) ?: return "—"
    val sameDay = toLocalDate(s) == toLocalDate(e)
    return if (sameDay) "${formats.time.format(s)} – ${formats.time.format(e)}"
           else "${formats.time.format(s)} – …" // 跨天，完整日期在详情页
}

/** 列表行里的时间文案。allDay 的事件以前在这里硬编码成「全天」，
 *  于是英文界面的搜索结果里会冒出两个中文字。 */
@Composable
internal fun eventTimeText(event: EventDTO): String {
    val formats = rememberCalendarFormats()
    val allDayLabel = stringResource(R.string.event_allday)
    return formatTimeRange(event, formats, allDayLabel)
}

internal fun formatAnchor(
    mode: ViewMode,
    anchor: LocalDate,
    formats: CalendarFormats,
): String = when (mode) {
    ViewMode.Day -> formats.dayHeader.format(anchor)
    ViewMode.Week -> {
        val s = startOfWeek(anchor); val e = s.plusDays(6)
        "${formats.monthDay.format(s)} – ${formats.monthDay.format(e)}"
    }
    ViewMode.Month -> formats.monthHeader.format(anchor)
}

@Composable
internal fun mutedTextColor() = MaterialTheme.colorScheme.onSurfaceVariant
