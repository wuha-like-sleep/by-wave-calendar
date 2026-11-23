package cn.bywave.calendar.data.store

import cn.bywave.calendar.data.model.EventDTO
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 增量同步本地应用计划（EventSyncPlan）的纯逻辑测试：整组替换、
 * 删除、日历剪枝、离线队列保护、本地新建行排除。本机无 JDK /
 * Android SDK，这份测试随代码提交、在有工具链的环境跑。
 */
class EventSyncPlanTest {

    private fun dto(id: String, calendarId: String = "c1", startsAt: String = "t1") = EventDTO(
        id = id, calendarId = calendarId, summary = "s-$id",
        startsAt = startsAt, endsAt = startsAt,
    )

    private fun keys(events: List<EventDTO>): List<String> =
        events.map { "${it.id}@${it.startsAt}" }.sorted()

    private fun plan(
        previous: List<EventDTO>,
        upserted: Set<String> = emptySet(),
        deleted: Set<String> = emptySet(),
        incoming: List<EventDTO> = emptyList(),
        visible: Set<String> = setOf("c1", "c2"),
        protectedIds: Set<String> = emptySet(),
        createIds: Set<String> = emptySet(),
    ) = EventSyncPlan.applyDelta(previous, upserted, deleted, incoming, visible, protectedIds, createIds)

    @Test fun upsertReplacesWholeGroup() {
        val out = plan(
            previous = listOf(dto("a", startsAt = "t1"), dto("a", startsAt = "t2"), dto("b")),
            upserted = setOf("a"),
            incoming = listOf(dto("a", startsAt = "t3")),
        )
        assertEquals(listOf("a@t3", "b@t1"), keys(out))
    }

    @Test fun upsertWithNoIncomingRowsRemovesGroup() {
        // 母事件移出窗口：upserted 里有它、响应里没有行 → 删干净。
        val out = plan(
            previous = listOf(dto("a"), dto("b")),
            upserted = setOf("a"),
            incoming = emptyList(),
        )
        assertEquals(listOf("b@t1"), keys(out))
    }

    @Test fun deletedIdsRemoved() {
        val out = plan(
            previous = listOf(dto("a"), dto("b")),
            deleted = setOf("b"),
        )
        assertEquals(listOf("a@t1"), keys(out))
    }

    @Test fun protectedMastersUntouched() {
        // 队列还没落定的母事件：upsert 与 delete 都跳过，服务端给的
        // 新行也不收（本地版本说了算）。
        val out = plan(
            previous = listOf(dto("c"), dto("d")),
            upserted = setOf("c"),
            deleted = setOf("d"),
            incoming = listOf(dto("c", startsAt = "t3")),
            protectedIds = setOf("c", "d"),
        )
        assertEquals(listOf("c@t1", "d@t1"), keys(out))
    }

    @Test fun vanishedCalendarPrunedExceptProtected() {
        val out = plan(
            previous = listOf(
                dto("a", calendarId = "c1"),
                dto("b", calendarId = "gone"),
                dto("e", calendarId = "gone"),
            ),
            protectedIds = setOf("e"),
        )
        assertEquals(listOf("a@t1", "e@t1"), keys(out))
    }

    @Test fun localCreateRowsExcludedFromMirror() {
        // 本地新建行不算服务端镜像：排除掉，由 mergeServerEvents
        // 从 previousLocal 统一接回，避免同一行出现两次。
        val out = plan(
            previous = listOf(dto("a"), dto("local:u1")),
            createIds = setOf("local:u1"),
        )
        assertEquals(listOf("a@t1"), keys(out))
    }
}
