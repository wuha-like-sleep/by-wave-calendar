// 错误文案收口的两条边：
//   · 内部标记、机器码、裸 HTTP 状态 —— 不许摆给用户。
//   · 服务端明确写给人看的那一句 —— 不许一起吞掉。
//
// 第二条是这次复查挖出来的：ApiClient 里有 8 个分支自己拼
// "xxx failed: $status $body"，拼完正好撞上「内部标记」判定，于是
// 「日历不存在」「管理员已停用 APP 同步。请进入网页后台…」这种能照着
// 做的说明，到用户眼前全变成「删除失败」四个字。

package cn.bywave.calendar.desktop.util

import cn.bywave.calendar.desktop.data.api.ApiException
import cn.bywave.calendar.desktop.i18n.I18n
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class UserFacingErrorTest {

    private val fallbackKey = "error.deleteFailed"
    private val fallback: String get() = I18n.t(fallbackKey)

    /** 服务端写给人看的那一句必须原样显示。 */
    @Test
    fun `服务端的人话原样显示`() {
        for (msg in listOf(
            "日历不存在",
            "当前密码错误",
            "管理员已停用 APP 同步。请进入网页后台 → 管理 → API & APPs → 「打开 APP 登录」开关后重试。",
            "今日注册名额已满，请明天再试",
        )) {
            assertEquals(
                msg,
                userFacingError(ApiException(400, msg), fallbackKey),
                "服务端说了人话却被换成了通用文案，用户拿不到任何能照着做的信息",
            )
        }
    }

    /**
     * 服务端是按用户的语言发这句话的，不是只有中文。
     *
     * 这一条守的是 userFacingError 里那几条「像不像内部标记」的启发式判断
     * （contains(" failed: ") / startsWith("HTTP ") / 机器码正则）不要误伤
     * 真实文案。英文和德文里 fail/failed 是常用词，判断稍微一收紧，整片
     * 非中文用户就会退回通用文案 —— 而且不报任何错，中文环境下测不出来。
     * 取的是 src/lib/i18n/locales/{en,de,fr}.ts 里 appleLogin.* 的原文。
     */
    @Test
    fun `非中文的服务端文案也不许被误判成内部标记`() {
        for (msg in listOf(
            "This site is not accepting new accounts at the moment. If you already have one, sign in the way you did before; otherwise please ask the site administrator.",
            "The account could not be created. Please try again in a moment; if it keeps failing, ask the site administrator.",
            "Your sign-in could not be saved on this device. Please try again in a moment; if it keeps failing, ask the site administrator.",
            "Das Konto konnte nicht angelegt werden. Versuche es gleich noch einmal; wenn es weiterhin fehlschlägt, wende dich an die Administration der Seite.",
            "Ce site n'accepte pas de nouveaux comptes pour le moment. Si vous en avez déjà un, connectez-vous comme avant ; sinon, contactez la personne qui administre le site.",
        )) {
            assertEquals(
                msg,
                userFacingError(ApiException(403, msg), fallbackKey),
                "服务端按用户语言写好的说明被当成内部标记换掉了：$msg",
            )
        }
    }

    /** 内部标记 / 机器码 / 裸状态 一律换成通用文案。 */
    @Test
    fun `内部标记不许摆给用户`() {
        for (msg in listOf(
            "decode_failed: Unexpected JSON token at offset 12",
            "missing_data",
            "HTTP 500",
            "validation_failed",
            "calendar delete failed: 500 Internal Server Error {\"ok\":false}",
        )) {
            assertEquals(
                fallback,
                userFacingError(ApiException(500, msg), fallbackKey),
                "内部标记 `$msg` 被原样摆到界面上了",
            )
        }
    }

    /** 不是 ApiException 的（网络层原文带主机和 IP）一律换掉。 */
    @Test
    fun `网络层异常换成通用文案`() {
        assertEquals(
            fallback,
            userFacingError(java.net.ConnectException("Connection refused: bywave.example.com/203.0.113.9:443"), fallbackKey),
            "网络层原文（带主机名和 IP）被摆到界面上了",
        )
    }
}

/**
 * 源码层的门禁：ApiClient 里不许再手工拼 "xxx failed: ${'$'}{resp.status} ${'$'}body"。
 *
 * 为什么用扫源码而不是跑接口：这类分支只有服务端回非 2xx 时才走到，桌面端
 * 没有可用的假服务端，写成集成测试的成本远大于收益；而「谁又手工拼了一个
 * 会被自己吞掉的字符串」纯粹是语法层就能判死的事。
 */
class ApiClientErrorShapeTest {

    private fun apiClientSource(): String {
        val rel = "src/main/kotlin/cn/bywave/calendar/desktop/data/api/ApiClient.kt"
        val f = listOf(File(rel), File("apps/desktop/$rel")).firstOrNull { it.isFile }
            ?: error("找不到 ApiClient.kt，当前工作目录是 ${File(".").absolutePath}")
        return f.readText()
    }

    @Test
    fun `非 2xx 分支必须走 errorFrom 而不是自己拼字符串`() {
        val flat = apiClientSource().replace(Regex("\\s+"), "")
        // 手工拼的形状：throw ApiException(resp.status.value, "……failed:${resp.status}…
        val handRolled = Regex("""throwApiException\(resp\.status\.value,"[^"]*failed:\$\{resp\.status}""")
        val hits = handRolled.findAll(flat).map { it.value }.toList()
        assertTrue(
            hits.isEmpty(),
            "这些分支自己拼了带 \" failed: \" 的消息，userFacingError 会把整句（连同服务端那句人话）换成通用文案。" +
                "改成 throw errorFrom(resp, \"…\")：\n" + hits.joinToString("\n"),
        )
    }
}
