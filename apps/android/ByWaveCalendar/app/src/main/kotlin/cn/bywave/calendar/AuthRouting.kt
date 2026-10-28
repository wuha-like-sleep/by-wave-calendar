// 登录态和页面跳转之间的规矩。单独拎出来是为了能在纯 JVM 单元测试里测
// （MainActivity 里的 NavHost 要真机/模拟器才跑得起来）。

package cn.bywave.calendar

internal object AuthRouting {
    const val SETUP = "setup"
    const val SCANNER = "scanner"
    const val CALENDAR = "calendar"

    /** 没有账号也能待的页面：登录页，和从登录页点进去的扫码页。 */
    private val signedOutRoutes = setOf(SETUP, SCANNER)

    /** 进 App 那一刻定一次的起始页。之后**不跟着登录态变**，原因见 MainActivity.AppRoot。 */
    fun startRoute(signedIn: Boolean): String = if (signedIn) CALENDAR else SETUP

    /**
     * 一个账号都不剩了（自己退出最后一个 / 最后一个被服务端登出），返回栈里却还压着
     * 要账号才能用的页面（日历、设置、编辑……）→ 要清栈回登录页。
     *
     * 已经只剩登录页（和它的扫码页）时不用动，免得把用户正在填的表单冲掉。
     * [stack] 是返回栈里各页的路由，导航图本身那一层不算。
     */
    fun mustResetToSetup(signedIn: Boolean, stack: List<String?>): Boolean =
        !signedIn && stack.any { it != null && it !in signedOutRoutes }
}
