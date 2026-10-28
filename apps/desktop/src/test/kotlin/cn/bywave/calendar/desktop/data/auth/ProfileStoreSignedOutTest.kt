package cn.bywave.calendar.desktop.data.auth

import cn.bywave.calendar.desktop.testutil.resetProfileStore
import cn.bywave.calendar.desktop.testutil.testProfile
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * 某个账号被服务端登出（改密码 / 重置密码 / 后台移除设备 / 后台停用）之后，桌面端怎么办。
 *
 * 以前：删掉**当前活动账号**，然后**静默**切到列表里第一个账号。原因记进了一个只有
 * 登录页才读的字段 —— 还有别的账号时根本不会回登录页，所以那句话永远不显示。用户
 * 以为自己还在原来那个账号里，看着的却是另一个账号的日历。
 *
 * 定下来的产品行为（三端统一）：
 *  · 还有别的账号 → 切到最近用过的那个，同时挂一条写明「哪个邮箱、为什么」的提示；
 *  · 一个都不剩 → 回登录页，登录页上显示原因。
 */
class ProfileStoreSignedOutTest {

    @BeforeTest
    fun setUp() = resetProfileStore()

    @AfterTest
    fun tearDown() = resetProfileStore()

    @Test
    fun `还有别的账号时切到最近用过的那个，并且告诉用户是哪个账号被登出了`() {
        ProfileStore.save(testProfile("a", "a@example.com"))
        ProfileStore.save(testProfile("b", "b@example.com"))
        ProfileStore.save(testProfile("c", "c@example.com"))
        // 用户先用 c，再切到 a。最近用过的顺序：a、c、b。
        ProfileStore.setActive("a")

        ProfileStore.markSignedOut("a", "auth.sessionRevoked")

        assertEquals(
            "c", ProfileStore.activeId.value,
            "应该切到刚才还在用的 c，而不是列表里排第一的 b",
        )
        val notices = ProfileStore.signedOutNotices.value
        assertEquals(
            listOf("a@example.com"), notices.map { it.email },
            "被登出时不许静默切走 —— 要挂一条写明邮箱的提示",
        )
        assertEquals("auth.sessionRevoked", notices.single().reasonKey)
        assertNull(
            ProfileStore.signedOutReasonKey.value,
            "还有账号时不回登录页；登录页的原因不该被设上（设上了会在下次打开登录页时冒出一句过期的话）",
        )
    }

    @Test
    fun `被登出的不是当前账号时，留在当前账号，但仍然提示`() {
        ProfileStore.save(testProfile("a", "a@example.com"))
        ProfileStore.save(testProfile("b", "b@example.com")) // 当前是 b

        ProfileStore.markSignedOut("a", "auth.sessionRevoked")

        assertEquals("b", ProfileStore.activeId.value, "当前账号什么事都没有，不该被切走")
        assertEquals(listOf("b"), ProfileStore.profiles.value.map { it.deviceId })
        assertEquals(listOf("a@example.com"), ProfileStore.signedOutNotices.value.map { it.email })
    }

    @Test
    fun `最后一个账号被登出时回登录页，登录页上有原因`() {
        ProfileStore.save(testProfile("a", "a@example.com"))

        ProfileStore.markSignedOut("a", "auth.sessionRevoked")

        assertNull(ProfileStore.profile.value, "一个账号都不剩，界面应该回登录页")
        assertEquals("auth.sessionRevoked", ProfileStore.signedOutReasonKey.value, "登录页要能说出为什么")
        assertTrue(ProfileStore.signedOutNotices.value.isEmpty(), "主界面的提示用不上了，别留着")
    }

    @Test
    fun `已经不在本机的账号再被判吊销，什么都不动`() {
        ProfileStore.save(testProfile("a", "a@example.com"))
        ProfileStore.save(testProfile("b", "b@example.com"))

        ProfileStore.markSignedOut("gone", "auth.sessionRevoked")

        assertEquals(listOf("a", "b"), ProfileStore.profiles.value.map { it.deviceId })
        assertEquals("b", ProfileStore.activeId.value)
        assertTrue(ProfileStore.signedOutNotices.value.isEmpty())
    }

    @Test
    fun `重新登回被踢掉的那个账号，提示自动收掉`() {
        ProfileStore.save(testProfile("a", "a@example.com"))
        ProfileStore.save(testProfile("b", "b@example.com"))
        ProfileStore.markSignedOut("a", "auth.sessionRevoked")
        assertEquals(1, ProfileStore.signedOutNotices.value.size)

        // 重新扫码配对：服务端会发一个新的 deviceId。
        ProfileStore.save(testProfile("a2", "A@example.com", serverUrl = "https://a.example.test"))

        assertTrue(ProfileStore.signedOutNotices.value.isEmpty(), "账号已经登回来了，还挂着「已被登出」就是错话")
    }

    @Test
    fun `最近用过的顺序重启之后还在`() {
        ProfileStore.save(testProfile("a", "a@example.com"))
        ProfileStore.save(testProfile("b", "b@example.com"))
        ProfileStore.save(testProfile("c", "c@example.com"))
        ProfileStore.setActive("c")
        ProfileStore.setActive("b") // 最近：b、c、a —— 列表顺序是 a、b、c，两种规则答案不同

        ProfileStore.reloadForTest() // 等于重启一次 App
        ProfileStore.markSignedOut("b", "auth.sessionRevoked")

        assertEquals("c", ProfileStore.activeId.value, "重启之后「最近用过」不能丢，否则又退化成列表第一个（a）")
    }

    @Test
    fun `挑下一个账号的规则`() {
        assertEquals("c", pickFallbackProfileId(listOf("b", "c"), listOf("a", "c", "b")))
        assertEquals("b", pickFallbackProfileId(listOf("b", "c"), emptyList()), "没有使用记录时按列表顺序")
        assertEquals("b", pickFallbackProfileId(listOf("b", "c"), listOf("x", "y")), "记录里的都不在了也按列表顺序")
        assertNull(pickFallbackProfileId(emptyList(), listOf("a")))
    }
}
