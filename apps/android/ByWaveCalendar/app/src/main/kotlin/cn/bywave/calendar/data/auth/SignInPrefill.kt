// 日历页「某账号已被登出」提示条上点「重新登录」，登录页要预填那个账号的服务器和邮箱。
//
// 以前那个按钮和「添加账号」是同一个回调，进去是一张空白登录页：用户要自己回想
// 那个账号在哪台服务器上、邮箱怎么拼，而提示条上明明写着。
//
// 为什么不走导航参数：登录页的路由叫 "setup"，扫码页靠 getBackStackEntry("setup")
// 拿登录页的 ViewModel，「一个账号都不剩就清栈回登录页」也按路由名判断；改成带
// 参数的路由，这几处要一起改，漏一处就是运行时崩溃。这里是一次性的交接格子：
// 点按钮时放进去，登录页的 ViewModel 建出来那一刻取走，取一次就空。
//
// 格子自己不知道会不会有登录页来取。放进去却没人取的那一份，靠 MainActivity 里
// 两条规矩挡住，不让它被以后哪张登录页捡到：
//   · 往登录页跳的每一处都先表态 ——「重新登录」放那个账号，「添加账号」和
//     「一个账号都不剩、清栈回登录页」都清空；
//   · 连点「重新登录」的第二下什么都不放（登录页已经在栈顶，launchSingleTop
//     不会再建一张来取），见 AuthRouting.signInAgainOpensSetup。

package cn.bywave.calendar.data.auth

import java.util.concurrent.atomic.AtomicReference

/** 登录页要预填的服务器地址和邮箱。 */
data class SignInPrefill(val serverUrl: String, val email: String)

/** 一次性交接：[put] 放进去，[take] 取走并清空。 */
internal class SignInPrefillSlot {
    private val ref = AtomicReference<SignInPrefill?>(null)

    /** 放 null 就是清空（普通的「添加账号」要一张空白登录页）。 */
    fun put(prefill: SignInPrefill?) = ref.set(prefill)

    /** 取走；取过一次之后再取是 null，免得以后哪次「添加账号」冒出一个旧账号。 */
    fun take(): SignInPrefill? = ref.getAndSet(null)
}
