package cn.bywave.calendar.desktop.data.api

import cn.bywave.calendar.desktop.data.auth.ProfileStore
import cn.bywave.calendar.desktop.testutil.FakeServer
import cn.bywave.calendar.desktop.testutil.FakeServer.Companion.ok
import cn.bywave.calendar.desktop.testutil.FakeServer.Reply
import cn.bywave.calendar.desktop.testutil.resetProfileStore
import cn.bywave.calendar.desktop.testutil.testProfile
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * ApiClient 认的是**建立它的那个账号**，不是「此刻的活动账号」。
 *
 * 以前刷新时读的是活动账号的 refresh token，打的却是这个 client 建立时那台服务器。
 * 两个账号在不同服务器上时，切账号之后还在飞的请求会拿 B 的票去 A 的服务器换 ——
 * A 回 401，被判成吊销，删掉的还是 B：一个什么事都没有的账号。
 *
 * 这里起两台真的本地 HTTP 服务器，从网络这一层看「刷新打到了哪、带的是谁的票」。
 */
class ApiClientProfileBindingTest {

    private val from = "2026-10-01T00:00:00Z"
    private val to = "2026-10-02T00:00:00Z"

    @BeforeTest
    fun setUp() = resetProfileStore()

    @AfterTest
    fun tearDown() = resetProfileStore()

    @Test
    fun `切到别的账号之后，旧账号的请求用旧账号的票去旧账号的服务器换`(): Unit = runBlocking {
        FakeServer().use { a ->
            FakeServer().use { b ->
                a.handler = { hit ->
                    when (hit.path) {
                        "/api/v1/auth/refresh" ->
                            if (hit.body.contains("\"rt-a\"")) {
                                Reply(200, ok("""{"accessToken":"at-a-new","refreshToken":"rt-a-2"}"""))
                            } else {
                                Reply(401, """{"error":"invalid_refresh_token"}""")
                            }
                        "/api/v1/events" ->
                            if (hit.auth == "Bearer at-a-new") Reply(200, ok("""{"calendars":[],"events":[]}"""))
                            else Reply(401, """{"error":"unauthorized"}""")
                        else -> Reply(404, """{"error":"not_found"}""")
                    }
                }
                b.handler = { Reply(401, """{"error":"unauthorized"}""") }

                ProfileStore.save(testProfile("a", "a@example.com", serverUrl = a.url, rt = "rt-a"))
                ProfileStore.save(testProfile("b", "b@example.com", serverUrl = b.url, rt = "rt-b"))
                // 用户现在在 b。下面这个 client 是切账号之前为 a 建的。
                val clientA = ApiClient(ProfileStore.profiles.value.first { it.deviceId == "a" })
                try {
                    clientA.events(from, to)
                } finally {
                    clientA.close()
                }

                val refreshBodies = a.hits.filter { it.path == "/api/v1/auth/refresh" }.map { it.body }
                assertEquals(1, refreshBodies.size, "应该恰好换一次票：$refreshBodies")
                assertTrue(
                    refreshBodies.single().contains("\"rt-a\""),
                    "去 A 的服务器换票，带的必须是 A 的 refresh token，实际带的是：${refreshBodies.single()}",
                )
                assertTrue(b.hits.isEmpty(), "A 的请求不该打到 B 的服务器：${b.hits}")
                assertEquals(
                    listOf("a", "b"), ProfileStore.profiles.value.map { it.deviceId }.sorted(),
                    "两个账号都好好的，一个都不该被删",
                )
                assertEquals("b", ProfileStore.activeId.value, "后台请求不该把用户从 b 切走")
                assertEquals("rt-a-2", ProfileStore.refreshToken("a"), "轮换出来的新票要存给 A")
                assertEquals("rt-b", ProfileStore.refreshToken("b"), "B 的票不许被 A 的刷新结果覆盖")
                assertEquals("at-a-new", ProfileStore.accessToken("a"))
                assertNull(ProfileStore.accessToken("b"), "A 换来的 access token 不许记到 B 头上")
            }
        }
    }

    @Test
    fun `旧账号被吊销时只登出它自己，当前账号不动`(): Unit = runBlocking {
        FakeServer().use { a ->
            a.handler = { Reply(401, """{"error":"invalid_refresh_token"}""") }
            ProfileStore.save(testProfile("a", "a@example.com", serverUrl = a.url, rt = "rt-a"))
            ProfileStore.save(testProfile("b", "b@example.com", rt = "rt-b"))
            val clientA = ApiClient(ProfileStore.profiles.value.first { it.deviceId == "a" })
            try {
                assertFailsWith<ApiException> { clientA.events(from, to) }
            } finally {
                clientA.close()
            }

            assertEquals(listOf("b"), ProfileStore.profiles.value.map { it.deviceId }, "被吊销的是 a，删的也该是 a")
            assertEquals("b", ProfileStore.activeId.value)
            assertEquals(
                listOf("a@example.com"), ProfileStore.signedOutNotices.value.map { it.email },
                "a 被登出了要告诉用户",
            )
        }
    }

    @Test
    fun `匿名 client 碰到 401 不去换票、也不动任何账号`(): Unit = runBlocking {
        FakeServer().use { s ->
            s.handler = { Reply(401, """{"error":"unauthorized"}""") }
            ProfileStore.save(testProfile("a", "a@example.com", serverUrl = s.url, rt = "rt-a"))
            val anon = ApiClient(s.url)
            try {
                assertFailsWith<ApiException> { anon.events(from, to) }
            } finally {
                anon.close()
            }

            assertTrue(s.hits.none { it.path == "/api/v1/auth/refresh" }, "匿名 client 没有票可换")
            assertEquals(listOf("a"), ProfileStore.profiles.value.map { it.deviceId }, "匿名请求的 401 和已登录的账号无关")
        }
    }
}
