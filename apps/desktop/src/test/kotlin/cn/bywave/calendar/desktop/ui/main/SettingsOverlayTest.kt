package cn.bywave.calendar.desktop.ui.main

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.ImageComposeScene
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.PointerButton
import androidx.compose.ui.input.pointer.PointerButtons
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import cn.bywave.calendar.desktop.data.model.Profile
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * 设置页那一整层（[SettingsOverlay]）。
 *
 * 用的是 Compose 自带的离屏场景（ImageComposeScene）：不开窗口、不启动 App，
 * 在内存里排版、往指定坐标送鼠标事件，看事件落到了哪一层。
 */
@OptIn(ExperimentalComposeUiApi::class)
class SettingsOverlayTest {

    private fun profile(deviceId: String, refreshToken: String = "rt-$deviceId") = Profile(
        serverUrl = "https://cal.example.test",
        userId = "u-$deviceId",
        email = "$deviceId@example.test",
        deviceId = deviceId,
        refreshToken = refreshToken,
    )

    /** 把落到这一层的每个鼠标事件记下来。 */
    private fun Modifier.recordPointerEvents(into: MutableList<PointerEventType>) = pointerInput(Unit) {
        awaitPointerEventScope {
            while (true) {
                into += awaitPointerEvent().type
            }
        }
    }

    /**
     * 在测试线程上同步改状态。
     *
     * 直接在全局快照里改，变更通知要等 Swing 线程去发；它和 render() 撞上的时候，
     * 这一帧可能还没重组，断言读到的是旧画面 —— 测试会时红时绿。放进一个快照里
     * 改完再提交，通知就在当前线程当场发出去。
     */
    private fun change(block: () -> Unit) = Snapshot.withMutableSnapshot(block)

    /** 鼠标移过去、按下、松开 —— 一次完整的点击。 */
    private fun ImageComposeScene.click(at: Offset) {
        sendPointerEvent(PointerEventType.Move, at)
        sendPointerEvent(
            PointerEventType.Press, at,
            buttons = PointerButtons(isPrimaryPressed = true),
            button = PointerButton.Primary,
        )
        sendPointerEvent(
            PointerEventType.Release, at,
            buttons = PointerButtons(),
            button = PointerButton.Primary,
        )
    }

    @Test
    fun `点在被登出提示条上不会穿透到底下的主界面`() {
        // 底下那一层代表主界面（顶栏的「今天」「新建」那排按钮就在最上面）。
        val mainScreen = mutableListOf<PointerEventType>()
        val bannerButton = mutableListOf<PointerEventType>()
        var showSettings by mutableStateOf(false)

        val scene = ImageComposeScene(width = 600, height = 400, density = Density(1f))
        try {
            scene.setContent {
                Box(Modifier.fillMaxSize()) {
                    Box(Modifier.fillMaxSize().recordPointerEvents(mainScreen))
                    if (showSettings) {
                        SettingsOverlay(
                            profile = profile("B"),
                            banners = {
                                // 和真的提示条一样：一行文字（不接点击）+ 末尾的按钮。
                                Row(Modifier.fillMaxWidth().height(40.dp)) {
                                    Text("a@example.test 已被登出，现在显示的是 b@example.test", Modifier.weight(1f))
                                    Box(Modifier.size(40.dp).recordPointerEvents(bannerButton))
                                }
                            },
                        ) {
                            // 故意不放 Surface：真的 SettingsScreen 自己是一块 Surface，
                            // 但这一层不能指望里面的内容替它拦 —— 提示条就是画在内容
                            // 外面才漏的。
                            Box(Modifier.fillMaxSize())
                        }
                    }
                }
            }
            scene.render()

            val onBannerText = Offset(20f, 20f)
            val onBannerButton = Offset(580f, 20f)
            val onSettingsBody = Offset(300f, 250f)

            // 对照：没开设置页时，同一个位置的点击确实送到主界面 —— 保证下面
            // 「主界面什么都没收到」不是因为事件压根没送出去。
            scene.click(onBannerText)
            assertTrue(PointerEventType.Press in mainScreen, "测试本身没把点击送进去：$mainScreen")

            change { showSettings = true }
            scene.render()

            mainScreen.clear()
            scene.click(onBannerText)
            assertEquals(
                emptyList(), mainScreen,
                "点在提示条的文字上，事件穿透到了下面主界面的顶栏",
            )

            scene.click(onBannerButton)
            assertTrue(PointerEventType.Press in bannerButton, "提示条自己的按钮应该照常能点：$bannerButton")

            mainScreen.clear()
            scene.click(onSettingsBody)
            assertEquals(emptyList(), mainScreen, "点在设置页的空白处，事件穿透到了主界面")
        } finally {
            scene.close()
        }
    }

    @Test
    fun `设置页开着时换了账号，整页按新账号重建`() {
        var active by mutableStateOf(profile("A"))
        var shownFor = ""
        val loads = mutableListOf<String>()

        val scene = ImageComposeScene(width = 400, height = 300, density = Density(1f))
        try {
            scene.setContent {
                SettingsOverlay(profile = active, banners = {}) {
                    // 设置里的列表都是这个形状：进页面时按当时的账号拉一次，存进 remember。
                    val loadedFor = remember { active.deviceId }
                    SideEffect { shownFor = loadedFor }
                    LaunchedEffect(Unit) { loads += active.deviceId }
                }
            }
            scene.render()
            assertEquals("A", shownFor, "设置页内容根本没画出来")
            assertEquals(listOf("A"), loads, "设置页一打开就该按当前账号加载一次")

            change { active = profile("B") }
            scene.render()
            assertEquals("B", shownFor, "账号已经换成 B，设置页上留着的还是 A 的数据")
            assertEquals(listOf("A", "B"), loads, "账号换了，设置页没有按新账号重新加载")
        } finally {
            scene.close()
        }
    }

    @Test
    fun `同一个账号换票不会让设置页重建`() {
        // 后台每次换票都会换掉 refreshToken（ProfileStore 里的 Profile 是新对象）。
        // 这时设置页不能重建 —— 否则用户正在填的改密码表单会被清空。
        var active by mutableStateOf(profile("A", refreshToken = "rt-1"))
        val instances = mutableListOf<Any>()
        val loads = mutableListOf<String>()

        val scene = ImageComposeScene(width = 400, height = 300, density = Density(1f))
        try {
            scene.setContent {
                SettingsOverlay(profile = active, banners = {}) {
                    val instance = remember { Any() }
                    SideEffect { if (instances.lastOrNull() !== instance) instances += instance }
                    LaunchedEffect(Unit) { loads += active.deviceId }
                }
            }
            scene.render()
            assertEquals(1, instances.size, "设置页内容根本没画出来")

            change { active = profile("A", refreshToken = "rt-2") }
            scene.render()

            assertEquals(1, instances.size, "只是换了票，设置页却整页重建了")
            assertEquals(listOf("A"), loads, "只是换了票，设置页却重新加载了一遍")
        } finally {
            scene.close()
        }
    }
}
