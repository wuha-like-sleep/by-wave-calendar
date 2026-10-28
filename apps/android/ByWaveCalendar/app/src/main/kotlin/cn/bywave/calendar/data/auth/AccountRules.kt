// 账号列表的几条规矩：删掉一个账号之后谁接班、被服务端登出之后提示放在哪。
//
// 单独拎成纯函数，是因为 ProfileStore 绑着加密 SharedPreferences，纯 JVM 单元测试里
// 建不出来（本模块没有 Robolectric）；规矩写在这里，ProfileStore 只管读写和持久化，
// 测试直接测这里的行为。

package cn.bywave.calendar.data.auth

import kotlinx.serialization.Serializable

/**
 * 「某个账号被服务端登出了」—— 日历页顶上那条提示。
 *
 * 只记账号本身（哪台服务器、哪个邮箱），原因不存：会走到这里的只有服务端吊销这一种
 * （改密码 / 重置密码 / 后台移除设备 / 后台停用），文案在显示那一刻按当时的界面语言取。
 */
@Serializable
data class SignedOutNotice(
    val serverUrl: String,
    val email: String,
)

internal object AccountRules {

    data class AfterRemoval(val remaining: List<Profile>, val activeId: String?)

    /**
     * 删掉一个账号。删的是当前账号时，换到剩下的里**最近用过**的那个；
     * 一个都不剩就是 null（回登录页）。删的不是当前账号，当前账号不动。
     */
    fun remove(profiles: List<Profile>, activeId: String?, removedId: String): AfterRemoval {
        val remaining = profiles.filterNot { it.id == removedId }
        val nextActive = if (activeId == removedId) {
            remaining.maxByOrNull { it.lastUsedAt }?.id
        } else {
            activeId
        }
        return AfterRemoval(remaining, nextActive)
    }

    /** 被服务端登出一个账号之后，说明放在哪。 */
    data class SignOutTell(
        /** 日历页提示的新队列。 */
        val notices: List<SignedOutNotice>,
        /** 一个账号都不剩、要回登录页 → 原因在登录页上说。 */
        val reasonOnSetupPage: Boolean,
    )

    /**
     * 被服务端登出 [gone] 之后（[profiles] 是删之前的账号列表），说明放在哪：
     *
     * - 本机还登着别的账号：日历页挂一条，写清被登出的是谁。**不能静默切走** —— 以前就是
     *   这样，原因只记给登录页，而这时根本不会回登录页；用户以为自己还在原来那个账号里，
     *   看到的、新建的日程其实都是另一个账号的。登录页这时不记原因，不然它会一直挂着，
     *   等哪天用户点「添加另一个账号」时冒出来。
     * - 一个都不剩：回登录页，原因在登录页上说；日历页的提示清空，留着的话下次登录进来
     *   会冒出一条早就过时的提示。
     *
     * 同一个账号只记一条。
     */
    fun tellAfterPassiveSignOut(
        profiles: List<Profile>,
        gone: Profile,
        current: List<SignedOutNotice>,
    ): SignOutTell {
        val anyAccountLeft = profiles.any { it.id != gone.id }
        if (!anyAccountLeft) return SignOutTell(notices = emptyList(), reasonOnSetupPage = true)
        val notice = SignedOutNotice(serverUrl = gone.serverUrl, email = gone.email)
        return SignOutTell(notices = current.filterNot { it == notice } + notice, reasonOnSetupPage = false)
    }

    /** 重新登录了某个账号，关于它的「已被登出」提示就过时了。 */
    fun noticesAfterSignIn(
        current: List<SignedOutNotice>,
        serverUrl: String,
        email: String,
    ): List<SignedOutNotice> =
        current.filterNot { it.serverUrl == serverUrl && it.email == email }
}
