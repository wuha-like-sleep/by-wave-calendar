package cn.bywave.calendar.event

import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive

/** A non-null wrapper makes an explicit field deletion survive explicitNulls=false.
 *  A null wrapper still means this editor does not manage the field. */
@Serializable(with = EventStringFieldSerializer::class)
data class EventStringField(val value: String?)

object EventStringFieldSerializer : KSerializer<EventStringField> {
    override val descriptor = PrimitiveSerialDescriptor("EventStringField", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: EventStringField) {
        require(encoder is JsonEncoder)
        encoder.encodeJsonElement(value.value?.let(::JsonPrimitive) ?: JsonNull)
    }
    override fun deserialize(decoder: Decoder): EventStringField {
        require(decoder is JsonDecoder)
        val value = decoder.decodeJsonElement()
        return EventStringField(if (value == JsonNull) null else value.jsonPrimitive.content)
    }
}

fun eventStringField(value: String, clearWhenEmpty: Boolean): EventStringField? =
    value.trim().takeIf(String::isNotEmpty)?.let(::EventStringField)
        ?: if (clearWhenEmpty) EventStringField(null) else null

/** All-day timestamps encode calendar dates at UTC boundaries, not instants in
 *  the device zone. Timed events continue to use the device's wall clock. */
fun eventFormDateTime(value: String, allDay: Boolean, zone: ZoneId = ZoneId.systemDefault()): LocalDateTime? =
    runCatching { Instant.parse(value).atZone(if (allDay) ZoneOffset.UTC else zone).toLocalDateTime() }.getOrNull()

/** Remember both the original instant and its displayed clock value. A
 * no-op edit must not choose a different offset in a DST overlap or after
 * the device zone changes while the editor is open. An edit that moves
 * the clock within the overlap keeps the original's offset side too —
 * eventFormIso passes it to ZonedDateTime.ofLocal as the preferred
 * offset, the same rule the desktop editor's draftInstant applies. */
data class EventFormInstant(val iso: String, val displayed: LocalDateTime)

fun eventFormIso(
    value: LocalDateTime,
    allDay: Boolean,
    isStart: Boolean,
    zone: ZoneId = ZoneId.systemDefault(),
    original: EventFormInstant? = null,
): String {
    if (!allDay && original?.displayed == value) return original.iso
    val zoned = if (allDay) {
        value.toLocalDate().atTime(if (isStart) LocalTime.MIDNIGHT else LocalTime.of(23, 59, 59))
            .atZone(ZoneOffset.UTC)
    } else {
        // DST 回拨重叠区：同一墙上时间有两个合法偏移。口径与桌面端
        // draftInstant 一致 —— 偏移取原事件在该时区下的偏移（原来在
        // 第二遍那一小时，改到重叠区内另一个分钟仍留在第二遍），不让
        // 一次小改把事件悄悄挪前一小时。以前这里直接 atZone(zone)，
        // java.time 对重叠区恒取较早偏移，与桌面端选出的瞬间能差一
        // 小时。没有原事件（新建）时 preferred 为 null，ofLocal 退回
        // 较早偏移，与 atZone 相同。preferred 对新墙上时间不合法时
        // （不在重叠区）ofLocal 自己会忽略它。
        val preferred = original?.let { runCatching { Instant.parse(it.iso) }.getOrNull() }
            ?.atZone(zone)?.offset
        ZonedDateTime.ofLocal(value, zone, preferred)
    }
    return DateTimeFormatter.ISO_OFFSET_DATE_TIME.format(zoned)
}

/** Material DatePicker uses UTC midnight millis even when the device is elsewhere. */
fun eventPickerMillis(date: LocalDate): Long = date.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
fun eventPickerDate(millis: Long): LocalDate = Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC).toLocalDate()

/** Duplicating an all-day event preserves the number of selected dates, not a
 *  duration added to the current time (which could accidentally add a day). */
fun duplicateEventRange(startsAt: String, endsAt: String, allDay: Boolean, nextStart: LocalDateTime): Pair<LocalDateTime, LocalDateTime> {
    if (allDay) {
        val startDate = eventFormDateTime(startsAt, true)?.toLocalDate()
        val endDate = eventFormDateTime(endsAt, true)?.toLocalDate()
        val days = if (startDate != null && endDate != null) {
            java.time.temporal.ChronoUnit.DAYS.between(startDate, endDate).coerceAtLeast(0)
        } else 0
        return nextStart.toLocalDate().atStartOfDay() to nextStart.toLocalDate().plusDays(days).atTime(23, 59, 59)
    }
    val duration = runCatching {
        java.time.Duration.between(Instant.parse(startsAt), Instant.parse(endsAt)).toMinutes().coerceAtLeast(15)
    }.getOrDefault(60)
    return nextStart to nextStart.plusMinutes(duration)
}

fun eventAllDayDates(startsAt: String, endsAt: String): Pair<LocalDate, LocalDate>? {
    val start = eventFormDateTime(startsAt, true) ?: return null
    val end = eventFormDateTime(endsAt, true) ?: return null
    // Canonical server end is inclusive (23:59:59); tolerate older exclusive
    // midnight payloads without showing an extra day.
    val last = if (end.toLocalTime() == LocalTime.MIDNIGHT && end.isAfter(start)) end.toLocalDate().minusDays(1) else end.toLocalDate()
    return start.toLocalDate() to maxOf(start.toLocalDate(), last)
}
