// 测试用的本地 HTTP 服务器 + ProfileStore 复位。
//
// 用 JDK 自带的 com.sun.net.httpserver，不引新依赖。ApiClient 是真的 Ktor CIO
// 客户端、走真的 HTTP —— 「刷新打到了哪台服务器、带的是谁的票」这种问题，
// 只有从网络这一层看才看得见。

package cn.bywave.calendar.desktop.testutil

import cn.bywave.calendar.desktop.data.auth.ProfileStore
import cn.bywave.calendar.desktop.data.model.Profile
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.nio.file.Files
import java.nio.file.Paths
import java.util.concurrent.CopyOnWriteArrayList

class FakeServer : AutoCloseable {
    data class Hit(
        val method: String,
        val path: String,
        val query: String?,
        val auth: String?,
        val body: String,
    )

    data class Reply(val status: Int, val body: String = "")

    /** 收到过的每一个请求，按顺序。 */
    val hits = CopyOnWriteArrayList<Hit>()

    @Volatile
    var handler: (Hit) -> Reply = { Reply(404, """{"error":"not_found"}""") }

    private val server: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
        createContext("/") { ex ->
            val hit = Hit(
                method = ex.requestMethod,
                path = ex.requestURI.path,
                query = ex.requestURI.rawQuery,
                auth = ex.requestHeaders.getFirst("Authorization"),
                body = ex.requestBody.readBytes().decodeToString(),
            )
            hits += hit
            val reply = runCatching { handler(hit) }.getOrElse { Reply(500, """{"error":"test_handler_threw"}""") }
            val bytes = reply.body.toByteArray()
            ex.responseHeaders.add("Content-Type", "application/json")
            if (bytes.isEmpty()) {
                ex.sendResponseHeaders(reply.status, -1)
            } else {
                ex.sendResponseHeaders(reply.status, bytes.size.toLong())
                ex.responseBody.use { it.write(bytes) }
            }
            ex.close()
        }
        start()
    }

    val url: String get() = "http://127.0.0.1:${server.address.port}"

    override fun close() {
        server.stop(0)
    }

    companion object {
        /** 成功信封 { ok: true, data: ... }。 */
        fun ok(data: String) = """{"ok":true,"data":$data}"""
    }
}

/** 把 ProfileStore 清回「刚装好、一个账号都没有」。测试进程的 user.home 指在
 *  构建目录里（见 build.gradle.kts），这里删的不是开发机上真实的文件。 */
fun resetProfileStore() {
    val home = System.getProperty("user.home")
    check(home.contains("test-home")) { "测试进程的 user.home 没被隔离（$home），拒绝动 profiles.json" }
    Files.deleteIfExists(Paths.get(home, ".bywave-calendar", "profiles.json"))
    ProfileStore.reloadForTest()
}

fun testProfile(id: String, email: String, serverUrl: String = "https://$id.example.test", rt: String = "rt-$id") =
    Profile(
        serverUrl = serverUrl,
        userId = "user-$id",
        email = email,
        deviceId = id,
        refreshToken = rt,
    )
