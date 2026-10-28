package cn.bywave.calendar.ui.setup

import cn.bywave.calendar.R
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import java.io.IOException

/**
 * 登录、验证码、扫码登录出错时给用户看的话。
 *
 * 以前三处都是 `e.localizedMessage`：Retrofit 的 HttpException 只有一句
 * 「HTTP 401 」，于是输错密码、账号被锁、管理员关了 App 同步，用户看到的
 * 全是一个状态码；断网时则是一串 Java 异常原文。
 */
internal sealed interface LoginErrorText {
    /** 已知情况，用本地语言的文案。 */
    data class Res(val id: Int) : LoginErrorText
    /** 不认识的错误码，但服务端给了人话。 */
    data class Server(val message: String) : LoginErrorText
    /** 什么都读不到，只能报状态码。 */
    data class Status(val status: Int) : LoginErrorText
    /** 不是 HTTP 错误也不是网络错误，交给调用方的兜底文案。 */
    data object Unknown : LoginErrorText
}

/** 出错的是登录的哪一步。同一个错误码在不同步骤里意思不一样：
 *  `bad_request` 在账号密码登录里只可能是邮箱/密码的格式不对，在扫码和验证码
 *  那两步里说「邮箱或密码格式不对」就是答非所问。 */
internal enum class LoginStep { Password, Mfa, Pair }

/** 本 API 的机器码写法：全小写 ASCII 标识符（invalid_credentials / bad_request）。
 *  和桌面端 ApiErrorBody.kt 同一个判据：Fastify 默认处理器发的是 "Bad Request"
 *  （有大写有空格），反代、后台页面发的是整句话 —— 都不是本 API 的错误信封，
 *  它们带的 message 不保证是写给用户看的，也不保证是用户的语言。 */
private val MACHINE_CODE_SHAPE = Regex("^[a-z][a-z0-9]*(_[a-z0-9]+)*$")

/** 从 HttpException 的 errorBody 里取 (错误码, 人话)。认三种形状：
 *  EnvelopeInterceptor 拆过信封之后的 `{code, message}`、没拆的
 *  `{ok:false, error:{code, message}}`、老接口的 `{error:"码", message}`。
 *  信封在服务端没写 message 时拿错误码顶上，那种 message 不是人话，丢掉。
 *  错误码不是本 API 的写法时，整个 body 都不算数（码和话一起丢）。 */
internal fun parseServerError(raw: String?): Pair<String?, String?> {
    if (raw.isNullOrBlank()) return null to null
    val obj = runCatching { Json.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return null to null
    fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    val inner = obj["error"] as? JsonObject
    val code = (inner?.str("code") ?: obj.str("error") ?: obj.str("code"))?.trim()?.takeIf { it.isNotEmpty() }
    if (code != null && !MACHINE_CODE_SHAPE.matches(code)) return null to null
    val message = (inner?.str("message") ?: obj.str("message"))?.trim()?.takeIf { it.isNotEmpty() && it != code }
    return code to message
}

internal fun loginErrorText(status: Int?, rawBody: String?, isNetwork: Boolean, step: LoginStep): LoginErrorText {
    if (isNetwork) return LoginErrorText.Res(R.string.setupvm_err_network)
    if (status == null) return LoginErrorText.Unknown
    val (code, message) = parseServerError(rawBody)
    val res = when (code) {
        "invalid_credentials" -> R.string.setupvm_err_invalid_credentials
        "account_locked" -> R.string.setupvm_err_account_locked
        "account_disabled" -> R.string.setupvm_err_account_disabled
        "apps_disabled" -> R.string.setupvm_err_apps_disabled
        "invalid_code" -> R.string.setupvm_mfa_code_error
        "mfa_token_expired", "mfa_state_invalid" -> R.string.setupvm_err_mfa_expired
        "invalid_or_expired_code" -> R.string.setupvm_err_pair_code_expired
        // 账号密码登录的 bad_request 只可能是邮箱/密码不合格式；扫码和验证码两步的
        // bad_request 交给各自的兜底文案。
        "bad_request" -> if (step == LoginStep.Password) R.string.setupvm_err_bad_format else return LoginErrorText.Unknown
        else -> null
    }
    if (res != null) return LoginErrorText.Res(res)
    // 限流：服务端那句按服务端的语言写（老版本干脆是写死的中文），转发过去
    // 德语、日语用户会突然看到一句中文。按状态码出本地文案。
    if (status == 429) return LoginErrorText.Res(R.string.setupvm_err_rate_limited)
    // 5xx：那句话按定义就不是写给用户的。自建服务端没设 NODE_ENV=production 时
    // 会把异常原文回过来（数据库内网地址、服务器上的文件路径），不能上屏。
    if (status >= 500) return LoginErrorText.Res(R.string.setupvm_err_server)
    if (message != null) return LoginErrorText.Server(message)
    return LoginErrorText.Status(status)
}

internal fun loginErrorText(e: Throwable, step: LoginStep): LoginErrorText {
    val http = e as? retrofit2.HttpException
    if (http != null) {
        val raw = runCatching { http.response()?.errorBody()?.string() }.getOrNull()
        return loginErrorText(http.code(), raw, isNetwork = false, step = step)
    }
    return loginErrorText(null, null, isNetwork = e is IOException, step = step)
}
