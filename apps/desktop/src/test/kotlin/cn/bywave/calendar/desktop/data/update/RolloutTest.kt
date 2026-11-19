package cn.bywave.calendar.desktop.data.update

import cn.bywave.calendar.update.Rollout
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * 灰度分桶向量与服务端 test/rollout.test.ts、安卓 RolloutTest 钉的是
 * 同一组数字 —— 这份算法是跨端协议（服务端分桶 + 本地对 GitHub 清单
 * 再分桶），任何一端改算法，另一端的向量就会红。别只改一边。
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
        // 11111111-… 在 desktop/31 的桶是 64：比例 64 不可见、65 可见。
        assertFalse(Rollout.isInRollout("11111111-2222-3333-4444-555555555555", "desktop", 31, 64, 30, 1))
        assertTrue(Rollout.isInRollout("11111111-2222-3333-4444-555555555555", "desktop", 31, 65, 30, 1))
        assertTrue(Rollout.isInRollout("11111111-2222-3333-4444-555555555555", "desktop", 31, null, 30, 1))
    }

    @Test fun recallExemptionBeatsBucket() {
        assertTrue(Rollout.isInRollout("11111111-2222-3333-4444-555555555555", "desktop", 31, 10, 19, 20))
        assertFalse(Rollout.isInRollout("11111111-2222-3333-4444-555555555555", "desktop", 31, 10, 20, 20))
    }

    @Test fun graceWindowStates() {
        val firstSeen = 1_700_000_000_000L
        val day = 86_400_000L
        assertEquals(Rollout.ForceState.NOT_FORCED, Rollout.forceState(false, firstSeen, 7, firstSeen + 30 * day))
        assertEquals(Rollout.ForceState.IN_GRACE, Rollout.forceState(true, firstSeen, 7, firstSeen + 6 * day))
        assertEquals(Rollout.ForceState.FORCED, Rollout.forceState(true, firstSeen, 7, firstSeen + 7 * day))
        assertEquals(Rollout.ForceState.FORCED, Rollout.forceState(true, firstSeen, 0, firstSeen))
        assertEquals(firstSeen + 7 * day, Rollout.graceDeadlineMillis(firstSeen, null))
    }
}
