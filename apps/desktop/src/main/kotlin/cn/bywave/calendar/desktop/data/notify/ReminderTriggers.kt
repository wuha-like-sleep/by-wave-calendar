// 事件级提醒的取值与触发时刻 —— 桌面端是这一项的首发端，口径在这里定死，
// Android / iOS 跟同一套（服务端的唯一事实源是 src/lib/reminder_triggers.ts，
// 本文件的枚举与它逐值一致，改一处必须同步另一处）。
//
// 决定（Android / iOS 照抄这一段）：
//
//   1. 事件带 extra.alarms 时，提醒完全按事件级走：逐条 alarm 算触发时刻，
//      不再叠加全局提前量。一个事件要么事件级、要么全局，二选一 —— 叠加会
//      让同一场会响两次，而用户在事件里选的「不提醒」也压不住全局那一条。
//   2. 事件没有 alarms（键不存在、为 null、或空数组）时，回落到 ReminderPrefs
//      的全局提前量，行为和事件级提醒出现之前一字不变（全天事件不走全局路，
//      照旧跳过，免得半夜刷屏）。
//   3. alarms 非空但某条 trigger 解析不了：只跳过那一条并留一条 DebugLog，
//      其余照常；一条都解析不了时不回落全局（见 1 —— 它「带 alarms」）。
//   4. 定时事件的偏移是绝对时长：startsAt + 有符号时长，跨夏令时不变。
//      全天事件的偏移是墙上时间：基准是「事件时区当天 00:00」，先在民用
//      日历上加偏移、再换算成瞬间 —— PT9H 永远落在当地 09:00，哪怕当天
//      是夏令时切换日。时区取 extra.timezone，没有再取日历的 timezone；
//      两个都没有就排不了这条全天提醒（绝不回落到本机时区，那会算出一个
//      和用户看到的日期对不上的时刻，还不报错）。

package cn.bywave.calendar.desktop.data.notify

import cn.bywave.calendar.desktop.data.model.AlarmDTO
import cn.bywave.calendar.desktop.data.model.EventExtraDTO
import cn.bywave.calendar.desktop.util.DebugLog
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.time.Duration
import java.time.Instant
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset

/** 下拉里的一档：value 是存进 extra.alarms[].trigger 的原文，labelKey 是
 *  桌面端字典里的键（和服务端的 i18nKey 同名不同前缀，文案逐条对齐）。 */
data class ReminderOption(val value: String, val labelKey: String)

/** 定时事件的档位。负号 = 事件之前，空串 = 不提醒。与服务端 TIMED_TRIGGERS 逐值一致。 */
val TIMED_REMINDER_OPTIONS: List<ReminderOption> = listOf(
    ReminderOption("", "reminder.opt.none"),
    ReminderOption("-PT0M", "reminder.opt.timed.atStart"),
    ReminderOption("-PT5M", "reminder.opt.timed.min5"),
    ReminderOption("-PT15M", "reminder.opt.timed.min15"),
    ReminderOption("-PT30M", "reminder.opt.timed.min30"),
    ReminderOption("-PT1H", "reminder.opt.timed.hour1"),
    ReminderOption("-PT2H", "reminder.opt.timed.hour2"),
    ReminderOption("-P1D", "reminder.opt.timed.day1"),
    ReminderOption("-P1W", "reminder.opt.timed.week1"),
)

/** 全天事件的档位。基准是当天 00:00，所以每一档都落在某一天的 09:00。
 *  与服务端 ALLDAY_TRIGGERS 逐值一致。 */
val ALLDAY_REMINDER_OPTIONS: List<ReminderOption> = listOf(
    ReminderOption("", "reminder.opt.none"),
    ReminderOption("PT9H", "reminder.opt.allDay.sameDay9am"),
    ReminderOption("-PT15H", "reminder.opt.allDay.dayBefore9am"),
    ReminderOption("-P1DT15H", "reminder.opt.allDay.twoDaysBefore9am"),
    ReminderOption("-P6DT15H", "reminder.opt.allDay.weekBefore9am"),
)

fun reminderOptionsFor(allDay: Boolean): List<ReminderOption> =
    if (allDay) ALLDAY_REMINDER_OPTIONS else TIMED_REMINDER_OPTIONS

/** 切换全天开关时提醒档位怎么走（和网页端口径一致）：当前值属于目标组就
 *  原样留着（「不提醒」两组都有，永远留着），不属于就换成目标组的默认档。 */
fun nextReminderValue(current: String, allDay: Boolean): String {
    val values = reminderOptionsFor(allDay).map { it.value }
    if (current in values) return current
    return if (allDay) "PT9H" else "-PT15M"
}

// ---- extra.alarms 的读写（表单侧） ----

/** 把读路径上的原始 JSON（EventExtraDTO.alarms）拆成 AlarmDTO 列表。
 *  形状不对的条目（不是对象、trigger 不是字符串或为空）直接丢 —— 那是
 *  第三方导入留下的脏数据，占着位只会让「第一条」指错。action /
 *  description 不是字符串时按没有处理，不连累整条。 */
fun parseAlarms(element: JsonElement?): List<AlarmDTO> {
    val array = element as? JsonArray ?: return emptyList()
    val out = mutableListOf<AlarmDTO>()
    for (item in array) {
        val obj = item as? JsonObject ?: continue
        val trigger = (obj["trigger"] as? JsonPrimitive)?.contentOrNull?.trim().orEmpty()
        if (trigger.isEmpty()) continue
        out += AlarmDTO(
            trigger = trigger,
            action = (obj["action"] as? JsonPrimitive)?.contentOrNull,
            description = (obj["description"] as? JsonPrimitive)?.contentOrNull,
        )
    }
    return out
}

fun alarmsOf(extra: EventExtraDTO?): List<AlarmDTO> = parseAlarms(extra?.alarms)

/** 编辑框里显示的「主提醒」：已有 alarms 里第一条落在本组枚举内的 trigger；
 *  一条都没有就 ""（不提醒）。落在组外的（导入的自定义提醒）不进下拉，
 *  但会由 [keptAlarms] 在保存时原样带回去。 */
fun mainReminder(alarms: List<AlarmDTO>, allDay: Boolean): String {
    val values = reminderOptionsFor(allDay).mapTo(HashSet()) { it.value }
    return alarms.firstOrNull { it.trigger in values }?.trigger ?: ""
}

/** 保存时要保留的「其余」提醒：既有 alarms 里不在本组枚举内的那些
 *  （导入的自定义提醒就靠这一条活下来）。枚举内的除了被选中的主提醒
 *  都不再保留 —— 下拉就是主提醒的唯一编辑面，留两条枚举内的只会让
 *  用户改了下拉、旧档位还阴魂不散。 */
fun keptAlarms(alarms: List<AlarmDTO>, allDay: Boolean): List<AlarmDTO> {
    val values = reminderOptionsFor(allDay).mapTo(HashSet()) { it.value }
    return alarms.filter { it.trigger !in values }
}

/** 保存时最终的 alarms 列表：选中的一条（action 固定 DISPLAY，
 *  description 用事件标题，和网页端拼法一致）在前，其余保留的跟在后面。
 *  选中为空且没有其余时返回空列表 —— 调用方据此发显式 null 删键。 */
fun buildAlarms(
    selected: String,
    summary: String,
    existing: List<AlarmDTO>,
    allDay: Boolean,
): List<AlarmDTO> {
    val out = mutableListOf<AlarmDTO>()
    val sel = selected.trim()
    if (sel.isNotEmpty()) {
        out += AlarmDTO(trigger = sel, action = "DISPLAY", description = summary)
    }
    out += keptAlarms(existing, allDay).filter { it.trigger != sel }
    return out
}

// ---- trigger 解析与触发时刻（调度侧） ----

/** 一条 TRIGGER 解析出来的样子。和服务端 parseTrigger 的形状对齐。 */
sealed interface ParsedTrigger {
    /** 有符号相对时长（毫秒）。负 = 事件之前，正 = 之后，0 合法。 */
    data class Relative(val ms: Long, val relatedToEnd: Boolean) : ParsedTrigger

    /** VALUE=DATE-TIME 的绝对触发时刻。 */
    data class Absolute(val at: Instant) : ParsedTrigger
}

private val DURATION_RE =
    Regex("""^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$""", RegexOption.IGNORE_CASE)

private val DATETIME_RE =
    Regex("""^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?Z?$""", RegexOption.IGNORE_CASE)

/** 有符号 ISO8601 duration → 毫秒。解析不了返回 null；0 是合法结果，
 *  调用方要用 `== null` 判空。年 / 月（P1Y、P1M）故意不认：一个月是
 *  28 还是 31 天没有答案，猜错的提醒比不提醒更难排查（与服务端一致）。 */
fun parseDurationMs(value: String): Long? {
    val m = DURATION_RE.matchEntire(value.trim()) ?: return null
    val sign = m.groupValues[1]
    val parts = listOf(
        m.groupValues[2] to 7L * 24 * 3600 * 1000,   // W
        m.groupValues[3] to 24L * 3600 * 1000,       // D
        m.groupValues[4] to 3600L * 1000,            // H
        m.groupValues[5] to 60L * 1000,              // M
        m.groupValues[6] to 1000L,                   // S
    )
    if (parts.all { it.first.isEmpty() }) return null  // 光一个 "P" / "PT"
    return runCatching {
        var total = 0L
        for ((digits, unit) in parts) {
            if (digits.isEmpty()) continue
            total = Math.addExact(total, Math.multiplyExact(digits.toLong(), unit))
        }
        if (sign == "-") -total else total
    }.getOrNull()
}

/** 解析一条 TRIGGER。认裸 duration，也认带 iCalendar 参数前缀的写法
 *  （`RELATED=END:-PT15M`、`VALUE=DATE-TIME:20260101T090000Z`），还认
 *  整行属性（`TRIGGER;...:...`）—— 导入路径上时不时会有人把整行丢进来。
 *  空串是「不提醒」的哨兵值，不是触发器，返回 null。 */
fun parseTrigger(raw: String): ParsedTrigger? {
    var text = raw.trim()
    if (text.isEmpty()) return null
    // 去掉整行属性名（"TRIGGER;" / "TRIGGER:"）。
    if (text.length > 8 && text.substring(0, 7).equals("TRIGGER", ignoreCase = true) &&
        (text[7] == ';' || text[7] == ':')
    ) {
        text = text.substring(8).trim()
    }
    if (text.isEmpty()) return null

    // 拆参数：只有第一个冒号之前那段含 = 才算参数区，否则整串都是值。
    var value = text
    var relatedToEnd = false
    val colon = text.indexOf(':')
    if (colon > 0 && text.substring(0, colon).contains('=')) {
        value = text.substring(colon + 1).trim()
        for (part in text.substring(0, colon).split(';')) {
            val eq = part.indexOf('=')
            if (eq <= 0) continue
            val name = part.substring(0, eq).trim().uppercase()
            val pv = part.substring(eq + 1).trim().uppercase()
            if (name != "RELATED") continue
            when (pv) {
                "END" -> relatedToEnd = true
                "START" -> relatedToEnd = false
                // RELATED 写了别的值 = 客户端想表达我们不懂的东西，
                // 默认按 START 算就是在猜，宁可丢（与服务端一致）。
                else -> return null
            }
        }
    }
    if (value.isEmpty()) return null

    parseDurationMs(value)?.let { return ParsedTrigger.Relative(it, relatedToEnd) }

    DATETIME_RE.matchEntire(value)?.let { m ->
        return runCatching {
            val ldt = LocalDateTime.of(
                m.groupValues[1].toInt(), m.groupValues[2].toInt(), m.groupValues[3].toInt(),
                m.groupValues[4].toInt(), m.groupValues[5].toInt(),
                m.groupValues[6].ifEmpty { "0" }.toInt(),
            )
            // 不带 Z 的浮动写法也按 UTC（与服务端一致）。LocalDateTime.of
            // 对 2 月 30 日这类不存在的日期直接抛，不会顺延到下个月。
            ParsedTrigger.Absolute(ldt.toInstant(ZoneOffset.UTC))
        }.getOrNull()
    }
    return null
}

/** 算出一条提醒该响的绝对时刻。算不出来返回 null，调用方负责留痕。
 *
 *  - 定时：基准是 startsAt（relatedToEnd 时是 endsAt，没有 endsAt 就
 *    不排 —— 退回 startsAt 算出的是错一端的时刻），加有符号绝对时长。
 *  - 全天：基准是事件时区当天 00:00，偏移按墙上时间走（见文件头第 4 条）。
 *    当天的日期分量按 UTC 读：全天事件的 startsAt 存的是当天 UTC 午夜。
 *  - 绝对触发：直接就是那个时刻。 */
fun resolveTriggerAt(
    startsAt: Instant,
    endsAt: Instant?,
    allDay: Boolean,
    timezone: String?,
    trigger: ParsedTrigger,
): Instant? {
    when (trigger) {
        is ParsedTrigger.Absolute -> return trigger.at
        is ParsedTrigger.Relative -> Unit
    }
    val rel = trigger as ParsedTrigger.Relative

    if (allDay) {
        val zone = timezone?.takeIf { it.isNotBlank() }
            ?.let { runCatching { ZoneId.of(it) }.getOrNull() }
            ?: return null
        val anchor = if (rel.relatedToEnd) endsAt else startsAt
        if (anchor == null) return null
        val civilDate = anchor.atZone(ZoneOffset.UTC).toLocalDate()
        // 先在民用日历（LocalDateTime）上加偏移，再 atZone 换算 —— 这一步
        // 是全天提醒不随夏令时漂移的关键。
        val civil = LocalDateTime.of(civilDate, LocalTime.MIDNIGHT)
            .plus(Duration.ofMillis(rel.ms))
        return civil.atZone(zone).toInstant()
    }

    val base = if (rel.relatedToEnd) endsAt else startsAt
    if (base == null) return null
    return base.plusMillis(rel.ms)
}

/** 一个事件的全部触发时刻（调度器用）。返回 null = 这个事件没有
 *  alarms、回落全局；返回列表（可能为空）= 事件级接管：逐条算，
 *  解析不了 / 算不出的跳过并留痕，一条都不剩也是空列表、不回落。 */
fun eventTriggerInstants(
    startsAt: Instant,
    endsAt: Instant?,
    allDay: Boolean,
    timezone: String?,
    alarms: List<AlarmDTO>,
): List<Instant>? {
    if (alarms.isEmpty()) return null
    val out = mutableListOf<Instant>()
    for (alarm in alarms) {
        val parsed = parseTrigger(alarm.trigger)
        val at = parsed?.let { resolveTriggerAt(startsAt, endsAt, allDay, timezone, it) }
        if (at == null) {
            DebugLog.d("ReminderTriggers") { "skip unresolvable trigger '${alarm.trigger}'" }
            continue
        }
        out += at
    }
    return out
}
