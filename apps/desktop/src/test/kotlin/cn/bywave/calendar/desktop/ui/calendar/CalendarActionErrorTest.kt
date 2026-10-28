package cn.bywave.calendar.desktop.ui.calendar

import cn.bywave.calendar.desktop.data.api.ApiClient
import cn.bywave.calendar.desktop.data.model.EventCreateInput
import cn.bywave.calendar.desktop.data.model.EventDTO
import cn.bywave.calendar.desktop.data.model.EventUpdateInput
import cn.bywave.calendar.desktop.testutil.FakeServer
import cn.bywave.calendar.desktop.testutil.FakeServer.Companion.ok
import cn.bywave.calendar.desktop.testutil.FakeServer.Reply
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * 删除 / 拖动改时间 / 撤销删除失败时，用户得看得见。
 *
 * 以前这三条路的失败都写进 formError，而 formError 只在编辑弹窗里渲染 —— 这三条路上
 * 根本没有弹窗。于是：点了删除，事件还在，一个字的说明都没有；拖完松手，事件弹回原位，
 * 也没有任何说明；点了「撤销」，事件没回来，同样什么都没有。
 *
 * 这里用真的 ApiClient 打一台本地 HTTP 服务器，让服务端真的失败，看 CalendarState 的状态。
 */
class CalendarActionErrorTest {

    private val event = EventDTO(
        id = "e1",
        calendarId = "cal1",
        summary = "牙医复诊",
        startsAt = "2026-10-28T01:00:00Z",
        endsAt = "2026-10-28T02:00:00Z",
    )

    private val eventsJson = Json.encodeToString(ListSerializer(EventDTO.serializer()), listOf(event))

    /** 等 CalendarState 在 runBlocking 里 launch 出去的活全部跑完（包括它们又 launch 的）。 */
    private suspend fun CoroutineScope.awaitIdle() {
        val job = coroutineContext[Job]!!
        while (true) {
            val running = job.children.toList()
            if (running.isEmpty()) return
            running.forEach { it.join() }
        }
    }

    private fun serverFor(handler: (FakeServer.Hit) -> Reply?): FakeServer = FakeServer().also { s ->
        s.handler = { hit ->
            handler(hit) ?: when {
                hit.method == "GET" && hit.path == "/api/v1/events" ->
                    Reply(200, ok("""{"calendars":[],"events":$eventsJson}"""))
                else -> Reply(404, """{"error":"not_found"}""")
            }
        }
    }

    @Test
    fun `删除失败要在主界面上提示，而且说的是哪一个、为什么`(): Unit = runBlocking {
        serverFor { hit ->
            if (hit.method == "DELETE") Reply(403, """{"error":"forbidden","message":"你没有权限删除这个日历里的事件"}""") else null
        }.use { s ->
            val client = ApiClient(s.url)
            val st = CalendarState(client, this)
            st.load()
            awaitIdle()

            st.delete(event)
            awaitIdle()
            client.close()

            val msg = assertNotNull(st.ui.value.actionError, "删除失败了，主界面上必须有一句话")
            assertTrue(msg.contains("牙医复诊"), "要说清是哪一个：$msg")
            assertTrue(msg.contains("你没有权限删除这个日历里的事件"), "服务端给了理由就带上：$msg")
            assertEquals(listOf(event), st.ui.value.events, "没删成，事件要还在")
            assertNull(st.ui.value.undoDelete, "没删成就不该出「撤销」")
        }
    }

    @Test
    fun `拖动改时间失败要弹回原位并提示`(): Unit = runBlocking {
        serverFor { hit ->
            if (hit.method == "PATCH") Reply(500, """{"error":"internal_error"}""") else null
        }.use { s ->
            val client = ApiClient(s.url)
            val st = CalendarState(client, this)
            st.load()
            awaitIdle()

            st.applyMove(event, deltaMinutes = 120, deltaDays = 0)
            // 松手那一刻先画在新位置（不等请求回来）。
            assertNotEquals(event.startsAt, st.ui.value.events.single().startsAt, "松手之后应该先停在新位置")

            awaitIdle()
            client.close()

            assertEquals(listOf(event), st.ui.value.events, "请求失败了，事件必须回到原来的时间，别停在假位置")
            val msg = assertNotNull(st.ui.value.actionError, "拖动失败了，主界面上必须有一句话")
            assertTrue(msg.contains("牙医复诊"), "要说清是哪一个：$msg")
            assertNull(st.ui.value.formError, "拖动没有弹窗，写进 formError 等于没写")
        }
    }

    @Test
    fun `拉伸改结束时间失败同样弹回并提示`(): Unit = runBlocking {
        serverFor { hit ->
            if (hit.method == "PATCH") Reply(503, "") else null
        }.use { s ->
            val client = ApiClient(s.url)
            val st = CalendarState(client, this)
            st.load()
            awaitIdle()

            st.applyResize(event, deltaMinutes = 30)
            awaitIdle()
            client.close()

            assertEquals(listOf(event), st.ui.value.events)
            assertNotNull(st.ui.value.actionError)
        }
    }

    @Test
    fun `撤销删除失败要提示`(): Unit = runBlocking {
        serverFor { hit ->
            when {
                hit.method == "DELETE" -> Reply(204)
                hit.method == "POST" && hit.path.endsWith("/restore") -> Reply(500, """{"error":"internal_error"}""")
                else -> null
            }
        }.use { s ->
            val client = ApiClient(s.url)
            val st = CalendarState(client, this)
            st.delete(event)
            awaitIdle()
            assertNotNull(st.ui.value.undoDelete, "删成功了应该给「撤销」")

            st.undoLastDelete()
            awaitIdle()
            client.close()

            val msg = assertNotNull(st.ui.value.actionError, "撤销没成功，主界面上必须有一句话")
            assertTrue(msg.contains("牙医复诊"), "要说清是哪一个：$msg")
        }
    }

    @Test
    fun `编辑弹窗里保存失败照旧写在弹窗里`(): Unit = runBlocking {
        serverFor { hit ->
            if (hit.method == "PATCH") Reply(400, """{"error":"validation_failed","message":"结束时间不能早于开始时间"}""") else null
        }.use { s ->
            val client = ApiClient(s.url)
            val st = CalendarState(client, this)
            st.openEdit(event)
            st.update(event.id, null, event.startsAt, EventUpdateInput(summary = "改个名"))
            awaitIdle()
            client.close()

            assertEquals("结束时间不能早于开始时间", st.ui.value.formError, "弹窗开着，错误就写在弹窗里")
            assertNull(st.ui.value.actionError, "别在主界面上再重复一遍")
        }
    }

    @Test
    fun `保存途中把弹窗关了，失败改走主界面提示`(): Unit = runBlocking {
        serverFor { hit ->
            if (hit.method == "POST") Reply(500, """{"error":"internal_error"}""") else null
        }.use { s ->
            val client = ApiClient(s.url)
            val st = CalendarState(client, this)
            st.openCreate()
            st.create(
                EventCreateInput(
                    calendarId = "cal1",
                    summary = "新会议",
                    startsAt = "2026-10-28T03:00:00Z",
                    endsAt = "2026-10-28T04:00:00Z",
                ),
            )
            st.closeSheet() // 按了 Esc
            awaitIdle()
            client.close()

            assertNotNull(st.ui.value.actionError, "弹窗已经关了，失败只能在主界面上说")
        }
    }
}
