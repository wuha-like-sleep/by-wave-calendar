// 动效的无障碍口径收口处。
//
// Compose 没有现成的「减弱动态效果」开关可读。系统侧最接近的信号是
// 全局动画时长缩放（无障碍 / 开发者选项里的动画缩放）：用户把它关到
// 0，就是明确不想看动画。各处的过渡在动手前先问这里，缩放为 0 时
// 降级为直接切换，不要硬塞动画给已经关掉动画的人。
//
// 组合时读一次即可：这个设置改了通常也要重启进程才全面生效，
// 没必要每次重组都去查一遍系统设置。

package cn.bywave.calendar.ui.components

import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext

/** 系统是否要求减弱动态效果（动画时长缩放为 0）。 */
@Composable
fun rememberReduceMotion(): Boolean {
    val context = LocalContext.current
    return remember(context) {
        Settings.Global.getFloat(
            context.contentResolver,
            Settings.Global.ANIMATOR_DURATION_SCALE,
            1f,
        ) == 0f
    }
}
