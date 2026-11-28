package cn.bywave.calendar.desktop.ui.calendar

import cn.bywave.calendar.desktop.data.model.EventCreateInput
import cn.bywave.calendar.desktop.data.model.EventDTO
import cn.bywave.calendar.desktop.data.model.EventUpdateInput
import cn.bywave.calendar.desktop.data.offline.AttentionResolution
import cn.bywave.calendar.desktop.testutil.FakeServer
import cn.bywave.calendar.desktop.testutil.FakeServer.Companion.ok
import cn.bywave.calendar.desktop.testutil.FakeServer.Reply
import cn.bywave.calendar.desktop.testutil.calendarStateTest
import cn.bywave.calendar.sync.PendingOpKind
import cn.bywave.calendar.sync.PendingOpState
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Real HTTP failures remain visible through the offline queue. Rejected writes
 * need attention; temporary failures retain the user's edit for a retry. Undo
 * after a completed delete still reports restore failures on the main screen. */
class CalendarActionErrorTest {
    private val event = EventDTO(id = "e1", calendarId = "cal1", summary = "牙医复诊",
        startsAt = "2026-10-28T01:00:00Z", endsAt = "2026-10-28T02:00:00Z")
    private val eventsJson = Json.encodeToString(ListSerializer(EventDTO.serializer()), listOf(event))
    private fun serverFor(handler: (FakeServer.Hit) -> Reply?) = FakeServer().also { server ->
        server.handler = { hit -> handler(hit) ?: when {
            hit.method == "GET" && hit.path == "/api/v1/events" -> Reply(200, ok("""{"calendars":[],"events":$eventsJson}"""))
            else -> Reply(404, """{"error":"not_found"}""")
        } }
    }

    @Test fun `删除被拒绝保留待处理原因和原快照，确认之前不发请求`(): Unit = calendarStateTest {
        serverFor { hit -> if (hit.method == "DELETE") Reply(403, """{"error":"forbidden","message":"你没有权限删除这个日历里的事件"}""") else null }.use { server ->
            val state = createState(testClient(server.url))
            state.load(); awaitIdle()
            state.delete(event); awaitIdle()
            assertNotNull(state.ui.value.pendingConfirmDelete)
            assertEquals(0, server.hits.count { it.method == "DELETE" })
            state.resolveConfirmDelete(true); awaitIdle()
            val op = state.ui.value.pendingOps.single()
            assertEquals(PendingOpKind.DELETE, op.kind)
            assertEquals(PendingOpState.ATTENTION, op.state)
            assertEquals(event.summary, op.summary)
            assertTrue(assertNotNull(op.errorMessage).contains("你没有权限删除这个日历里的事件"))
            assertTrue(assertNotNull(op.snapshotJson).contains(event.startsAt))
            assertTrue(event.id in state.ui.value.pendingSyncIds)
            assertEquals(1, server.hits.count { it.method == "DELETE" })
            state.offline.resolveAttention(op.id, AttentionResolution.DISCARD)
            state.load(useCache = false); awaitIdle()
            assertEquals(listOf(event), state.ui.value.events, "放弃被拒绝的删除后原事件仍可恢复显示")
            assertEquals(emptyList(), state.ui.value.pendingOps)
        }
    }

    @Test fun `拖动暂时失败保留新位置并显示待同步，不丢失原期次标识`(): Unit = calendarStateTest {
        serverFor { hit -> if (hit.method == "PATCH") Reply(500, """{"error":"internal_error"}""") else null }.use { server ->
            val state = createState(testClient(server.url))
            state.load(); awaitIdle()
            state.applyMove(event, deltaMinutes = 120, deltaDays = 0)
            assertNotEquals(event.startsAt, state.ui.value.events.single().startsAt)
            awaitIdle()
            val op = state.ui.value.pendingOps.single()
            assertEquals(PendingOpKind.UPDATE, op.kind)
            assertEquals(PendingOpState.PENDING, op.state)
            assertEquals(1, op.attempts)
            assertTrue(op.nextRetryAtMs > 0)
            assertEquals(event.startsAt, op.baseStartsAt, "重放仍应定位拖动前的原期次")
            assertTrue(assertNotNull(op.payloadJson).contains(state.ui.value.events.single().startsAt))
            assertTrue(event.id in state.ui.value.pendingSyncIds)
            assertNotEquals(event.startsAt, state.ui.value.events.single().startsAt)
            assertEquals(1, server.hits.count { it.method == "PATCH" })
            assertNull(state.ui.value.formError)
        }
    }

    @Test fun `拉伸暂时失败保留结束时间并标记待同步`(): Unit = calendarStateTest {
        serverFor { hit -> if (hit.method == "PATCH") Reply(503, "") else null }.use { server ->
            val state = createState(testClient(server.url))
            state.load(); awaitIdle()
            state.applyResize(event, deltaMinutes = 30); awaitIdle()
            assertEquals(event.startsAt, state.ui.value.events.single().startsAt)
            assertNotEquals(event.endsAt, state.ui.value.events.single().endsAt)
            val op = state.ui.value.pendingOps.single()
            assertEquals(PendingOpState.PENDING, op.state)
            assertEquals(1, op.attempts)
            assertTrue(event.id in state.ui.value.pendingSyncIds)
            assertEquals(1, server.hits.count { it.method == "PATCH" })
        }
    }

    @Test fun `撤销已经同步的删除失败要在主界面提示`(): Unit = calendarStateTest {
        serverFor { hit -> when {
            hit.method == "DELETE" -> Reply(204)
            hit.method == "POST" && hit.path.endsWith("/restore") -> Reply(500, """{"error":"internal_error"}""")
            else -> null
        } }.use { server ->
            val state = createState(testClient(server.url))
            state.delete(event); state.resolveConfirmDelete(true); awaitIdle()
            assertEquals(emptyList(), state.ui.value.pendingOps)
            assertNotNull(state.ui.value.undoDelete)
            state.undoLastDelete(); awaitIdle()
            assertTrue(assertNotNull(state.ui.value.actionError).contains(event.summary))
            assertEquals(1, server.hits.count { it.path.endsWith("/restore") })
            assertNotNull(state.ui.value.undoDelete, "失败后仍能重试撤销")
        }
    }

    @Test fun `编辑被拒绝保留服务端说明供待处理面板显示`(): Unit = calendarStateTest {
        serverFor { hit -> if (hit.method == "PATCH") Reply(400, """{"error":"validation_failed","message":"结束时间不能早于开始时间"}""") else null }.use { server ->
            val state = createState(testClient(server.url))
            state.load(); awaitIdle()
            state.openEdit(event)
            state.update(event.id, null, event.startsAt, EventUpdateInput(summary = "改个名")); awaitIdle()
            val op = state.ui.value.pendingOps.single()
            assertEquals(PendingOpState.ATTENTION, op.state)
            assertTrue(assertNotNull(op.errorMessage).contains("结束时间不能早于开始时间"))
            assertTrue(assertNotNull(op.payloadJson).contains("改个名"))
            assertEquals(1, server.hits.count { it.method == "PATCH" })
        }
    }

    @Test fun `保存时关闭弹窗仍保留新建事件和可见待同步状态`(): Unit = calendarStateTest {
        serverFor { hit -> if (hit.method == "POST") Reply(500, """{"error":"internal_error"}""") else null }.use { server ->
            val state = createState(testClient(server.url))
            state.openCreate()
            state.create(EventCreateInput(calendarId = "cal1", summary = "新会议",
                startsAt = "2026-10-28T03:00:00Z", endsAt = "2026-10-28T04:00:00Z"))
            state.closeSheet(); awaitIdle()
            val op = state.ui.value.pendingOps.single()
            assertEquals(PendingOpKind.CREATE, op.kind)
            assertEquals(PendingOpState.PENDING, op.state)
            assertEquals(1, op.attempts)
            assertEquals("新会议", op.summary)
            assertTrue(state.ui.value.events.any { it.id == op.eventId && it.summary == "新会议" })
            assertTrue(op.eventId in state.ui.value.pendingSyncIds)
            assertNull(state.ui.value.activeSheet)
            assertEquals(1, server.hits.count { it.method == "POST" })
        }
    }

    @Test fun `删除失败显式重试成功后清空待同步状态`(): Unit = calendarStateTest {
        var deletes = 0
        serverFor { hit -> if (hit.method == "DELETE") {
            deletes++; if (deletes == 1) Reply(500, """{"error":"internal_error"}""") else Reply(204)
        } else null }.use { server ->
            val state = createState(testClient(server.url))
            state.load(); awaitIdle()
            state.delete(event); state.resolveConfirmDelete(true); awaitIdle()
            val op = state.ui.value.pendingOps.single()
            assertEquals(PendingOpState.PENDING, op.state)
            state.offline.resolveAttention(op.id, AttentionResolution.KEEP_MINE); awaitIdle()
            assertEquals(2, deletes)
            assertEquals(emptyList(), state.ui.value.pendingOps)
            assertEquals(emptySet(), state.ui.value.pendingSyncIds)
            assertNull(state.ui.value.actionError)
            assertNotNull(state.ui.value.undoDelete)
        }
    }

    @Test fun `没有标题的事件撤销失败时不写成空引号`(): Unit = calendarStateTest {
        serverFor { hit -> when {
            hit.method == "DELETE" -> Reply(204)
            hit.method == "POST" && hit.path.endsWith("/restore") -> Reply(500, """{"error":"internal_error"}""")
            else -> null
        } }.use { server ->
            val state = createState(testClient(server.url))
            state.delete(event.copy(summary = "")); state.resolveConfirmDelete(true); awaitIdle()
            state.undoLastDelete(); awaitIdle()
            val message = assertNotNull(state.ui.value.actionError)
            assertTrue("「」" !in message && "\"\"" !in message)
            assertEquals(1, server.hits.count { it.path.endsWith("/restore") })
        }
    }
}
