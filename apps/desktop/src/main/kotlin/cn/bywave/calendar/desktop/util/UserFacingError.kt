// 异常 → 用户看得懂的一句话。

package cn.bywave.calendar.desktop.util

import cn.bywave.calendar.desktop.data.api.ApiException

/**
 * 把一个异常翻成「能摆在界面上给用户看」的一句话。
 *
 * 在这之前,出错时界面直接显示 `e.localizedMessage`,于是用户会在日历顶部
 * 读到这种东西:
 *   decode_failed: Unexpected JSON token at offset 12
 *   calendar delete failed: 500 Internal Server Error {"ok":false,...}
 *   missing_data
 *   Connection refused: bywave.example.com/203.0.113.9:443
 * 前三种是写给开发看的内部标记,还顺带把字段名和接口行为抖了出来;第四种
 * 是网络层原文,带着主机和 IP。用户从这里面得不到任何可执行的信息。
 *
 * 规则:只有服务端明确给了一句人话(error.message)时才原样显示;内部标记、
 * 纯机器码(validation_failed 这种)、裸 HTTP 状态、以及所有非 ApiException
 * 的异常,一律换成本地化的通用文案。
 */
private val MACHINE_CODE = Regex("^[a-z0-9]+(_[a-z0-9]+)+$")

internal fun userFacingError(e: Throwable, fallbackKey: String): String {
    val fallback = cn.bywave.calendar.desktop.i18n.I18n.t(fallbackKey)
    val msg = (e as? ApiException)?.message?.trim().orEmpty()
    if (msg.isEmpty()) return fallback
    val internal = msg.startsWith("decode_failed") ||
        msg == "missing_data" ||
        msg.startsWith("HTTP ") ||
        msg.contains(" failed: ") ||
        MACHINE_CODE.matches(msg)
    return if (internal) fallback else msg
}
