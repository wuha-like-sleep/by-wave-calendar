// 从一个出错响应的 body 里，把「服务端写给用户看的那一句话」捞出来。
//
// 为什么单独抽成一个纯函数：这段逻辑原先内联在 ApiClient 的 errorFrom() /
// unwrap() 里，两处都要一个真的 HttpResponse 才跑得起来，于是从来没被测过。
// 没被测过的后果是下面这个坑安安静静躺了很久 ——
//
//   errorFrom() 第一句是 `obj["error"]?.jsonObject`。
//   服务端大量出错响应是**扁平**的：{ "error": "码", "message": "人话" }，
//   这里的 error 是**字符串**不是对象。kotlinx 的 .jsonObject 在
//   JsonPrimitive 上会抛 IllegalArgumentException，整个 runCatching 块
//   回 null，服务端那句人话被连锅端掉，退回 "xxx failed: HTTP nnn"，
//   再被 util/UserFacingError.kt 换成一句通用文案。
//   站长把注册关了 / 开了邀请制 / 设了域名白名单 / 今天名额用完 /
//   账号被停用 —— 服务端明明已经按用户的语言写清楚了原因和下一步，
//   桌面端用户看到的永远是同一句「出错了」。
//   unwrap() 里同一句写法更糟：它没有 runCatching 兜着，
//   IllegalArgumentException 直接从 unwrap 逃出去，连 ApiException 都不是。
//
// 服务端实际会发的信封形状（src/lib/api_response.ts + 各 routes + server.ts）：
//
//   1. v1 嵌套：{ ok:false, error:{ code, message, details? } }   ← err() 的 v1 分支
//   2. 扁平：   { error:"码", message?:"人话" }                    ← err() 的 legacy 分支、
//                                                                  routes/devices.ts 大量分支、
//                                                                  429 限流器、5xx 兜底处理器
//   3. 只有码： { error:"not_found" }                              ← 404 兜底
//   4. 非本 API：{ statusCode, error:"Bad Request", message:"…" }  ← Fastify 默认处理器，
//                                                                  message 是开发向英文
//   5. { ok:false, error:"一句中文人话" }                          ← 后台页面的写法
//
// 收口的意图没变，还是那一条：**别把内部标记摆给用户看**。所以这里区分的是
// 「服务端给了一句已经本地化、写给用户看的话」和「服务端只给了一个机器码」：
// 前者原样交出去，后者一律返回 null，由调用方退回通用文案。

package cn.bywave.calendar.desktop.data.api

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** 本 API 的机器码写法：全小写 ASCII 标识符（signup_closed / not_found /
 *  unauthorized）。用它当「这是不是本 API 的错误信封」的判据：
 *  Fastify 默认处理器发的是 "Bad Request"（有大写有空格），后台页面发的是
 *  整句中文 —— 两者都不匹配，于是它们带的 message 不会被当成人话端上去。 */
private val MACHINE_CODE_SHAPE = Regex("^[a-z][a-z0-9]*(_[a-z0-9]+)*$")

/** 宽松解析：body 是什么形状都不许抛。 */
private val bodyJson = Json { ignoreUnknownKeys = true; isLenient = true }

/**
 * 返回服务端写给用户看的那一句话；没有就返回 null。
 *
 * null 的含义是「这个 body 里没有能摆给用户看的东西」——畸形 JSON、空 body、
 * 非 JSON、只有机器码、或者压根不是本 API 发的。调用方收到 null 应当退回
 * 自己的通用文案，**不要**把码或者原始 body 端出去。
 *
 * 任何输入都不抛异常。
 */
/**
 * 按 HTTP 状态码决定「服务端这句话能不能给用户看」。
 *
 * 5xx：服务端的 500 文案按定义就不是写给用户的。自建服务端在
 * NODE_ENV 没设成 production 时（而它的默认值恰恰不是 production）
 * 会把 err.message 原样回过来 —— PG 报错里的内网 IP、数据库端口、
 * 服务器上的绝对路径。实测过：
 *     connect ECONNREFUSED 10.0.3.14:5432
 *     ENOENT: no such file or directory, open '/home/bywave/app/src/lib/x.ts'
 * 这些以前到不了界面，正是因为解析这一步有 bug 把它一起吞了；
 * 修好 bug 的同时这条路也会打开，所以要在这里单独堵住。
 * 服务端那一侧也改成无条件不外送了，但用户连的是**他自己那台**服务器，
 * 老版本长期存在，客户端这一层不能指望对面已经升级。
 *
 * 429：服务端那句是硬编码中文（「请求过于频繁，请 N 秒后再试」）。
 * 转发过去，德语/日语用户会突然看到一句中文。这一类按状态码在客户端
 * 自己出本地化文案，不要转发。
 */
private fun statusAllowsServerMessage(status: Int): Boolean =
    status < 500 && status != 429

/**
 * 带状态码的入口。**新代码一律走这个。**
 * 不带状态码的那个重载留给还没法拿到状态码的调用点，它按最保守的方式处理。
 */
internal fun userMessageFromErrorBody(raw: String, status: Int): String? {
    if (!statusAllowsServerMessage(status)) return null
    return userMessageFromErrorBody(raw)
}

internal fun userMessageFromErrorBody(raw: String): String? {
    val obj = runCatching { bodyJson.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return null

    var code: String? = null
    var message: String? = null

    when (val errEl = obj["error"]) {
        // 形状 1：{ error: { code, message } }
        is JsonObject -> {
            code = errEl.stringOrNull("code")
            message = errEl.stringOrNull("message")
        }
        // 形状 2/3/4/5：error 是标量。只有字符串才可能是码；数字/布尔说明
        // 这不是本 API 的信封，直接放弃。JsonNull 当作「没有 error 字段」。
        is JsonPrimitive -> {
            if (errEl === JsonNull) {
                message = obj.stringOrNull("message")
            } else {
                if (!errEl.isString) return null
                code = errEl.content
                message = obj.stringOrNull("message")
            }
        }
        // 没有 error 字段（或者它是数组）：只认顶层 message。
        null -> message = obj.stringOrNull("message")
        else -> return null
    }

    val m = message?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val c = code?.trim()?.takeIf { it.isNotEmpty() }

    // err() 在 v1 分支里写的是 `message: message || code`——路由没给人话时，
    // message 字段里装的其实就是那个码。这种不算人话。
    if (c != null && m == c) return null

    // code 不是本 API 的机器码写法 → 这个 body 不是本 API 发的（Fastify 默认
    // 处理器 / 反代 / 后台页面），它的 message 不保证本地化、也不保证是写给
    // 用户看的，一律不显示。
    if (c != null && !MACHINE_CODE_SHAPE.matches(c)) return null

    return m
}

/** 取一个字符串字段；字段不存在、不是标量、是数字/布尔/null 时都返回 null。 */
private fun JsonObject.stringOrNull(key: String): String? {
    val p = this[key] as? JsonPrimitive ?: return null
    return if (p.isString) p.content else null
}
