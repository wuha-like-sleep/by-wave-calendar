package cn.bywave.calendar.event

import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
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
 * the device zone changes while the editor is open. */
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
    } else value.atZone(zone)
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
