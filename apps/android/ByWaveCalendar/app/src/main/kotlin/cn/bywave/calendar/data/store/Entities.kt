// Room entities. We mirror the wire-format EventDTO almost 1:1 so
// converting back and forth (toDto / fromDto) stays trivial. The only
// "smart" choice is storing EventExtraDTO as a JSON string in a single
// column — the structure is small + opaque and we don't query into it.
//
// All timestamps stay ISO8601 strings (same as the server's response).
// We don't pre-parse to epoch ms because that loses the original
// offset, and tests of search/filter perf showed string compare on ISO
// strings is fast enough for our event counts (< few thousand).

package cn.bywave.calendar.data.store

import androidx.room.Entity
import androidx.room.PrimaryKey
import cn.bywave.calendar.data.model.CalendarMeta
import cn.bywave.calendar.data.model.EventDTO
import cn.bywave.calendar.data.model.EventExtraDTO
import kotlinx.serialization.json.Json

@Entity(tableName = "events")
data class EventEntity(
    @PrimaryKey val rowKey: String,         // "${id}@${startsAt}" — recurring
                                             // events emit multiple rows per
                                             // master id, one per occurrence
    val id: String,
    val calendarId: String,
    val summary: String,
    val description: String?,
    val location: String?,
    val startsAt: String,                   // ISO with offset
    val endsAt: String,
    val allDay: Boolean,
    val rrule: String?,
    val isOccurrence: Boolean?,
    val extraJson: String?,                 // serialized EventExtraDTO
) {
    fun toDto(json: Json): EventDTO = EventDTO(
        id = id,
        calendarId = calendarId,
        summary = summary,
        description = description,
        location = location,
        startsAt = startsAt,
        endsAt = endsAt,
        allDay = allDay,
        rrule = rrule,
        isOccurrence = isOccurrence,
        extra = extraJson?.let {
            runCatching { json.decodeFromString<EventExtraDTO>(it) }.getOrNull()
        },
    )

    companion object {
        fun from(dto: EventDTO, json: Json): EventEntity = EventEntity(
            rowKey = "${dto.id}@${dto.startsAt}",
            id = dto.id,
            calendarId = dto.calendarId,
            summary = dto.summary,
            description = dto.description,
            location = dto.location,
            startsAt = dto.startsAt,
            endsAt = dto.endsAt,
            allDay = dto.allDay,
            rrule = dto.rrule,
            isOccurrence = dto.isOccurrence,
            extraJson = dto.extra?.let { json.encodeToString(EventExtraDTO.serializer(), it) },
        )
    }
}

@Entity(tableName = "calendars")
data class CalendarEntity(
    @PrimaryKey val id: String,
    val name: String,
    val color: String,
    val timezone: String?,
) {
    fun toDto(): CalendarMeta = CalendarMeta(
        id = id, name = name, color = color, timezone = timezone,
    )

    companion object {
        fun from(dto: CalendarMeta): CalendarEntity = CalendarEntity(
            id = dto.id, name = dto.name, color = dto.color, timezone = dto.timezone,
        )
    }
}
