package cn.bywave.calendar.update

import org.junit.Assert.*
import org.junit.Test

/**
 * 灰度分桶向量与服务端 test/rollout.test.ts 钉的是同一组数字 ——
 * 这份算法是跨端协议（服务端分桶 + 本地对 GitHub 清单再分桶），
 * 任何一端改算法，另一端的向量就会红。别只改一边。
 */
class RolloutTest {
    @Test fun bucketVectorsMatchServer() {
        assertEquals(73, Rollout.bucket("device-alpha", "android", 26))
        assertEquals(7, Rollout.bucket("device-beta", "android", 26))
        assertEquals(64, Rollout.bucket("11111111-2222-3333-4444-555555555555", "desktop", 31))
        assertEquals(82, Rollout.bucket("device-alpha", "desktop", 26))
        assertEquals(89, Rollout.bucket("device-alpha", "android", 27))
    }

    @Test fun rolloutGateBoundaries() {
        // device-beta 在 android/26 的桶是 7：比例 7 不可见、8 可见。
        assertFalse(Rollout.isInRollout("device-beta", "android", 26, 7, 25, 1))
        assertTrue(Rollout.isInRollout("device-beta", "android", 26, 8, 25, 1))
        assertFalse(Rollout.isInRollout("device-beta", "android", 26, 0, 25, 1))
        assertTrue(Rollout.isInRollout("device-alpha", "android", 26, 100, 25, 1))
        // 清单没写（null）= 全量。
        assertTrue(Rollout.isInRollout("device-alpha", "android", 26, null, 25, 1))
    }

    @Test fun recallExemptionBeatsBucket() {
        // device-alpha 桶 73、灰度只开 10%，但已装版本低于最低支持 → 放行。
        assertTrue(Rollout.isInRollout("device-alpha", "android", 26, 10, 19, 20))
        // 恰好等于最低版本不算「低于」。
        assertFalse(Rollout.isInRollout("device-alpha", "android", 26, 10, 20, 20))
    }

    @Test fun noDeviceIdIsNotARolloutSubject() {
        assertTrue(Rollout.isInRollout(null, "android", 26, 10, 25, 1))
        assertTrue(Rollout.isInRollout("", "android", 26, 10, 25, 1))
    }

    @Test fun graceWindowStates() {
        val firstSeen = 1_700_000_000_000L
        val day = 86_400_000L
        // 没被强升命中 → 永远 NOT_FORCED。
        assertEquals(Rollout.ForceState.NOT_FORCED, Rollout.forceState(false, firstSeen, 7, firstSeen + 30 * day))
        // 宽限内只提醒，过了截止才强升。边界：恰好到截止时刻 = 已强升。
        assertEquals(Rollout.ForceState.IN_GRACE, Rollout.forceState(true, firstSeen, 7, firstSeen + 6 * day))
        assertEquals(Rollout.ForceState.FORCED, Rollout.forceState(true, firstSeen, 7, firstSeen + 7 * day))
        assertEquals(Rollout.ForceState.FORCED, Rollout.forceState(true, firstSeen, 7, firstSeen + 8 * day))
        // graceDays = 0 → 发现即强升；缺省（null）按 7 天。
        assertEquals(Rollout.ForceState.FORCED, Rollout.forceState(true, firstSeen, 0, firstSeen))
        assertEquals(Rollout.ForceState.IN_GRACE, Rollout.forceState(true, firstSeen, null, firstSeen + day))
        assertEquals(firstSeen + 7 * day, Rollout.graceDeadlineMillis(firstSeen, null))
    }
}
