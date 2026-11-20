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
    // v0.5 — rowKey now includes profileId so two profiles can hold
    // the same server-side event id without colliding. Same shape as
    // before for queries; the primary key just got a profile prefix.
    @PrimaryKey val rowKey: String,         // "${profileId}@${id}@${startsAt}"
    val profileId: String,                  // active profile this row belongs to
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
        fun from(dto: EventDTO, profileId: String, json: Json): EventEntity = EventEntity(
            rowKey = "$profileId@${dto.id}@${dto.startsAt}",
            profileId = profileId,
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

/**
 * 离线写队列的一条。整条 PendingOp 序列化成 JSON 存 payload 一列，
 * 表结构不随队列字段演进而变；accountKey / seq / state / eventId
 * 冗余成列是为了能直接按账号查、按顺序读、按状态计数，不必把整表
 * 解出来再过滤。
 *
 * 这张表**不**跟随账号的事件缓存一起清：退出登录清的是 events /
 * calendars（见 AppDatabase.wipeProfile），队列是用户还没送出去的
 * 改动，清掉等于丢数据。账号被彻底移除时由队列引擎按 accountKey
 * 单独清（见 EventRepository）。
 */
@Entity(tableName = "pending_ops")
data class PendingOpEntity(
    @PrimaryKey val id: String,
    val accountKey: String,
    val seq: Long,
    val eventId: String,
    val state: String,               // PendingOpState.name
    val summary: String,
    val payload: String,             // PendingOp 的 JSON 全文
)

@Entity(tableName = "calendars", primaryKeys = ["profileId", "id"])
data class CalendarEntity(
    val profileId: String,
    val id: String,
    val name: String,
    val color: String,
    val timezone: String?,
) {
    fun toDto(): CalendarMeta = CalendarMeta(
        id = id, name = name, color = color, timezone = timezone,
    )

    companion object {
        fun from(dto: CalendarMeta, profileId: String): CalendarEntity = CalendarEntity(
            profileId = profileId,
            id = dto.id,
            name = dto.name,
            color = dto.color,
            timezone = dto.timezone,
        )
    }
}
