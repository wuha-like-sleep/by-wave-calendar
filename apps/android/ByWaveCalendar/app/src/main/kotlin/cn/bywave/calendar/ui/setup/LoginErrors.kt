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

/** 从 HttpException 的 errorBody 里取 (错误码, 人话)。认三种形状：
 *  EnvelopeInterceptor 拆过信封之后的 `{code, message}`、没拆的
 *  `{ok:false, error:{code, message}}`、老接口的 `{error:"码", message}`。
 *  信封在服务端没写 message 时拿错误码顶上，那种 message 不是人话，丢掉。 */
internal fun parseServerError(raw: String?): Pair<String?, String?> {
    if (raw.isNullOrBlank()) return null to null
    val obj = runCatching { Json.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return null to null
    fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    val inner = obj["error"] as? JsonObject
    val code = inner?.str("code") ?: obj.str("error") ?: obj.str("code")
    val message = (inner?.str("message") ?: obj.str("message"))?.takeIf { it.isNotBlank() && it != code }
    return code to message
}

internal fun loginErrorText(status: Int?, rawBody: String?, isNetwork: Boolean): LoginErrorText {
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
        else -> null
    }
    if (res != null) return LoginErrorText.Res(res)
    if (message != null) return LoginErrorText.Server(message)
    return LoginErrorText.Status(status)
}

internal fun loginErrorText(e: Throwable): LoginErrorText {
    val http = e as? retrofit2.HttpException
    if (http != null) {
        val raw = runCatching { http.response()?.errorBody()?.string() }.getOrNull()
        return loginErrorText(http.code(), raw, isNetwork = false)
    }
    return loginErrorText(null, null, isNetwork = e is IOException)
}
