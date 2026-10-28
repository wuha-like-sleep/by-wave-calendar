package cn.bywave.calendar.data.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 某个账号被服务端登出（改密码 / 重置密码 / 后台移除设备 / 后台停用）之后：
 *
 * - 本机还登着别的账号 → 切到最近用过的那个，**同时**在日历页写清是哪个账号被登出。
 *   以前是静默切走：原因只记给登录页，而这时根本不会回登录页，用户以为自己还在
 *   原来那个账号里。
 * - 一个都不剩 → 回登录页，原因在登录页上说。
 */
class AccountRulesTest {

    private fun profile(id: String, email: String, lastUsedAt: Long, server: String = "https://cal.example.com") =
        Profile(id = id, serverUrl = server, email = email, refreshToken = "rt-$id", lastUsedAt = lastUsedAt)

    private val alice = profile("a", "alice@example.com", lastUsedAt = 300)
    private val bob = profile("b", "bob@example.com", lastUsedAt = 100)
    private val carol = profile("c", "carol@example.com", lastUsedAt = 200)

    // ---- 谁接班 ----

    @Test
    fun `当前账号被删_切到剩下里最近用过的那个而不是列表里排第一的`() {
        val after = AccountRules.remove(listOf(alice, bob, carol), activeId = "a", removedId = "a")
        assertEquals(listOf(bob, carol), after.remaining)
        assertEquals("carol 最近用过（200 > 100），该切到她", "c", after.activeId)
    }

    @Test
    fun `删的不是当前账号_当前账号不动`() {
        val after = AccountRules.remove(listOf(alice, bob, carol), activeId = "a", removedId = "c")
        assertEquals(listOf(alice, bob), after.remaining)
        assertEquals("a", after.activeId)
    }

    @Test
    fun `最后一个账号被删_没有当前账号`() {
        val after = AccountRules.remove(listOf(alice), activeId = "a", removedId = "a")
        assertTrue(after.remaining.isEmpty())
        assertNull(after.activeId)
    }

    // ---- 说明放在哪 ----

    @Test
    fun `还登着别的账号_日历页写清被登出的是哪个邮箱_登录页不记原因`() {
        val tell = AccountRules.tellAfterPassiveSignOut(listOf(alice, bob), gone = alice, current = emptyList())
        assertEquals(
            "被登出的账号要原样记下来，日历页提示靠它说出是谁",
            listOf(SignedOutNotice(serverUrl = alice.serverUrl, email = "alice@example.com")),
            tell.notices,
        )
        assertFalse(
            "这时不会回登录页；记了的话它会一直挂着，等用户哪天点「添加另一个账号」时冒出来",
            tell.reasonOnSetupPage,
        )
    }

    @Test
    fun `一个都不剩_原因放登录页_日历页提示清空`() {
        val stale = listOf(SignedOutNotice(serverUrl = carol.serverUrl, email = carol.email))
        val tell = AccountRules.tellAfterPassiveSignOut(listOf(alice), gone = alice, current = stale)
        assertTrue("一个账号都不剩要回登录页，原因得在登录页上说", tell.reasonOnSetupPage)
        assertTrue("留着的话下次登录进来日历页会冒出一条早就过时的提示", tell.notices.isEmpty())
    }

    @Test
    fun `先后两个账号被登出_两条都在_按先后排`() {
        val first = AccountRules.tellAfterPassiveSignOut(listOf(alice, bob, carol), gone = alice, current = emptyList())
        val second = AccountRules.tellAfterPassiveSignOut(listOf(bob, carol), gone = carol, current = first.notices)
        assertEquals(listOf("alice@example.com", "carol@example.com"), second.notices.map { it.email })
    }

    @Test
    fun `同一个账号不重复记`() {
        val once = AccountRules.tellAfterPassiveSignOut(listOf(alice, bob), gone = alice, current = emptyList())
        val twice = AccountRules.tellAfterPassiveSignOut(listOf(alice, bob), gone = alice, current = once.notices)
        assertEquals(1, twice.notices.size)
    }

    @Test
    fun `不同服务器上的同名邮箱是两个账号`() {
        val other = profile("x", "alice@example.com", lastUsedAt = 50, server = "https://other.example.org")
        val first = AccountRules.tellAfterPassiveSignOut(listOf(alice, other, bob), gone = alice, current = emptyList())
        val second = AccountRules.tellAfterPassiveSignOut(listOf(other, bob), gone = other, current = first.notices)
        assertEquals(2, second.notices.size)
    }

    @Test
    fun `重新登录回来的账号_它的提示消失_别人的留着`() {
        val notices = listOf(
            SignedOutNotice(serverUrl = alice.serverUrl, email = alice.email),
            SignedOutNotice(serverUrl = carol.serverUrl, email = carol.email),
        )
        val after = AccountRules.noticesAfterSignIn(notices, serverUrl = alice.serverUrl, email = alice.email)
        assertEquals(listOf("carol@example.com"), after.map { it.email })
    }

    // ---- 删账号之后提示还留不留 ----

    @Test
    fun `自己退出了最后一个账号_旧提示一起清掉`() {
        val notice = SignedOutNotice(serverUrl = bob.serverUrl, email = bob.email)
        assertEquals(emptyList<SignedOutNotice>(), AccountRules.noticesAfterRemoval(listOf(notice), remaining = emptyList()))
    }

    @Test
    fun `还剩账号_提示原样留着`() {
        val notice = SignedOutNotice(serverUrl = bob.serverUrl, email = bob.email)
        assertEquals(listOf(notice), AccountRules.noticesAfterRemoval(listOf(notice), remaining = listOf(alice)))
    }
}
