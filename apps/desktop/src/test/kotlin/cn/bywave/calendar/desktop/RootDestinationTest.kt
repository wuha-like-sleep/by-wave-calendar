package cn.bywave.calendar.desktop

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * 已登录状态下点「添加账号」进到登录页，要能退回去。
 *
 * 以前那一页没有取消也没有返回，只能配对成功或者退出 App —— 用户只是想看看
 * 「添加账号」长什么样，结果被困在里面。
 */
class RootDestinationTest {

    @Test
    fun `从添加账号进来的登录页可以取消`() {
        assertEquals(
            RootDestination.Setup(cancelable = true),
            rootDestination(hasActiveProfile = true, addingAccount = true),
            "本机还登着账号，登录页必须给一条退回去的路",
        )
    }

    @Test
    fun `一个账号都没有时登录页没有退路`() {
        assertEquals(RootDestination.Setup(cancelable = false), rootDestination(hasActiveProfile = false, addingAccount = false))
        // 「添加账号」途中原来那个账号被服务端登出了：退回去也没有东西可看。
        assertEquals(RootDestination.Setup(cancelable = false), rootDestination(hasActiveProfile = false, addingAccount = true))
    }

    @Test
    fun `平时显示主界面`() {
        assertEquals(RootDestination.Main, rootDestination(hasActiveProfile = true, addingAccount = false))
    }
}
