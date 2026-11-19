package cn.bywave.calendar.update

import java.security.MessageDigest

/**
 * 灰度分桶 + 强升宽限的客户端口径 —— 与服务端 src/lib/rollout.ts 是
 * 同一份协议的两份实现，必须逐位一致。
 *
 * 为什么客户端也要算一遍：服务端在 latest 接口上分桶只管得住「问本站」
 * 的请求；客户端还会去 GitHub 读同一份清单，那条路服务端够不着，只能
 * 在本地用同一个函数再判一次。老客户端不认这几个字段，会照旧全量
 * 更新 —— 灰度拦不住没装这套逻辑的版本，这是固有限制。
 *
 * 算法（改任何一处都要同步改服务端 + 两边测试向量）：
 * sha256("bywave-rollout:<platform>:<versionCode>:<deviceId>") 取前
 * 4 字节大端无符号整数，对 100 取模。platform 是 "android" / "desktop"。
 * 三个性质：确定性（同设备同版本答案恒定）、单调扩张（桶号 < 比例，
 * 比例只扩不缩）、按版本分桶（版本号进哈希输入，不让同一批设备永远
 * 第一个吃到新版）。
 */
object Rollout {

    /** 清单没写 / 写错时的灰度比例：100 = 不灰度，全量。
     *  回落方向必须是全量 —— 清单写错最多让灰度失效，不能关小更新通道。 */
    fun normalizePercent(raw: Int?): Int = (raw ?: 100).coerceIn(0, 100)

    /** 强升宽限天数：缺省 7（与 App Store phased release 的 7 天放量
     *  周期对齐），0 = 发现即强升，上限 30。 */
    fun normalizeGraceDays(raw: Int?): Int = (raw ?: 7).coerceIn(0, 30)

    fun bucket(deviceId: String, platform: String, versionCode: Int): Int {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest("bywave-rollout:$platform:$versionCode:$deviceId".toByteArray(Charsets.UTF_8))
        var v = 0L
        for (i in 0 until 4) v = (v shl 8) or (digest[i].toInt() and 0xFF).toLong()
        return (v % 100).toInt()
    }

    /**
     * 这台设备现在能不能看到这个新版本。口径与服务端 isInRollout 一致：
     * 比例 ≥ 100 恒真；没有设备标识恒真（分不了桶不装作分了）；
     * 已装版本低于最低支持版本恒真（召回豁免）；其余看桶号 < 比例。
     */
    fun isInRollout(
        deviceId: String?,
        platform: String,
        versionCode: Int,
        rolloutPercent: Int?,
        currentVersionCode: Int,
        minSupportedVersionCode: Int,
    ): Boolean {
        val percent = normalizePercent(rolloutPercent)
        if (percent >= 100) return true
        val id = deviceId?.trim().orEmpty()
        if (id.isEmpty()) return true
        if (currentVersionCode < minSupportedVersionCode) return true
        if (percent <= 0) return false
        return bucket(id, platform, versionCode) < percent
    }

    /** 强升三态：不强升 / 宽限中（只提醒，弹窗可关）/ 已强升（弹窗不可关）。 */
    enum class ForceState { NOT_FORCED, IN_GRACE, FORCED }

    /**
     * 宽限判定。被强升命中（清单 mandatory 或已装版本低于最低支持版本）
     * 不等于立刻锁死：从「第一次发现这个版本」起 graceDays 天内只提醒，
     * 过了才变不可关闭。graceDays = 0 时发现即强升。
     * firstSeenMillis 由调用方按 versionCode 持久化（第一次见到这个
     * 版本时记下，之后不许刷新 —— 刷新就等于宽限永远不到期）。
     */
    fun forceState(
        hitForce: Boolean,
        firstSeenMillis: Long,
        graceDays: Int?,
        nowMillis: Long,
    ): ForceState {
        if (!hitForce) return ForceState.NOT_FORCED
        val days = normalizeGraceDays(graceDays)
        if (days <= 0) return ForceState.FORCED
        val deadline = firstSeenMillis + days * 86_400_000L
        return if (nowMillis < deadline) ForceState.IN_GRACE else ForceState.FORCED
    }

    /** 宽限截止时刻（给 UI 显示「X 前可稍后，之后必须更新」用）。 */
    fun graceDeadlineMillis(firstSeenMillis: Long, graceDays: Int?): Long =
        firstSeenMillis + normalizeGraceDays(graceDays) * 86_400_000L
}
