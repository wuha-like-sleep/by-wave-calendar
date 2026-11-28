// 自绘窗口框的 Compose 侧:度量、标题栏按钮状态、标题栏组件。
//
// 为什么要自绘:系统原生标题栏(尤其 Windows 的 Win32 标题栏)和应用
// 自己的界面是两个画风 —— 颜色不跟主题、深色模式下还是一条白杠。
// 这里画一条与应用融为一体的标题栏,原生侧(WindowsCustomFrame)负责
// 把系统标题栏去掉、并把命中测试(拖动/缩放/按钮)交还给系统处理。
//
// 分工要说清:标题栏里的三个窗口按钮(最小化/最大化/关闭)在这里只负责
// 「画」,不接点击 —— 指针落在它们身上时,Windows 收到的是非客户区
// 命中码(HTMINBUTTON 等),事件根本不进 Compose。按钮的悬停/按下
// 状态由原生窗口过程回填到 CaptionButtonState,动作(最小化/最大化/
// 关闭)由系统默认窗口过程执行,和原生标题栏完全一致 —— Win11 把
// 鼠标悬停在最大化按钮上弹出的分屏菜单(Snap Layouts)也是靠这条
// 路径才有的。

package cn.bywave.calendar.desktop.ui.window

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.WindowState
import cn.bywave.calendar.desktop.i18n.I18n
import cn.bywave.calendar.desktop.ui.theme.BrandMark
import kotlin.math.roundToInt

/** 标题栏几何。原生命中测试按 DPI 换算成像素,用的是同一组 dp 值。 */
internal object WindowFrameMetrics {
    /** 标题栏总高(含底部 1dp 分隔线)。 */
    val TitleBarHeight: Dp = 40.dp

    /** 每个窗口控制按钮的宽 —— 46dp 是 Windows 标题栏按钮的惯例宽。 */
    val CaptionButtonWidth: Dp = 46.dp

    fun titleBarHeightPx(dpi: Int): Int = (TitleBarHeight.value * dpi / 96f).roundToInt()
    fun captionButtonWidthPx(dpi: Int): Int = (CaptionButtonWidth.value * dpi / 96f).roundToInt()
}

/** 标题栏右侧的三个窗口控制按钮。MAXIMIZE 是「最大化/还原」同一个钮。 */
internal enum class CaptionButton { NONE, MINIMIZE, MAXIMIZE, CLOSE }

/**
 * 按钮的悬停/按下状态。写入方是 Windows 原生窗口过程(在 AWT 原生
 * 线程上),读取方是 Compose —— 用 snapshot 状态保证跨线程可见。
 */
internal class CaptionButtonState {
    var hovered by mutableStateOf(CaptionButton.NONE)
    var pressed by mutableStateOf(CaptionButton.NONE)
}

// Windows 关闭按钮的悬停/按下红 —— 系统标题栏同款取值。
private val CloseHoverRed = Color(0xFFE81123)
private val ClosePressedRed = Color(0xFFF1707A)

/**
 * 自绘标题栏:左 = 品牌标记 + 应用名,右 = 最小化/最大化/关闭。
 * 只在 Windows 自绘框安装成功时挂载(见 Main.kt);安装失败保持原生框,
 * 这一条不会出现,也就不会和系统标题栏叠在一起。
 */
@Composable
internal fun CustomTitleBar(
    windowState: WindowState,
    captionState: CaptionButtonState,
    modifier: Modifier = Modifier,
) {
    // 与 Main.kt 的 MenuBar 同款写法:订阅 locale 让 t() 跟着语言切换重算。
    val locale by I18n.current.collectAsState()
    val tr = remember(locale) { { key: String -> I18n.t(key) } }
    val maximized = windowState.placement == androidx.compose.ui.window.WindowPlacement.Maximized
    // 原生标题栏在窗口失焦时标题与按钮字形会变灰,这里跟上 —— 不然
    // 两个窗口并排时看不出哪个是活的,一眼就是「仿的」。悬停/按下
    // 高亮不受影响:系统对失焦窗口的按钮悬停照样给反馈。
    val focused = LocalWindowInfo.current.isWindowFocused
    Column(
        modifier = modifier
            .fillMaxWidth()
            .height(WindowFrameMetrics.TitleBarHeight)
            .background(MaterialTheme.colorScheme.surface),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().weight(1f),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Spacer(Modifier.width(12.dp))
            BrandMark(20.dp)
            Spacer(Modifier.width(8.dp))
            Text(
                text = "ByWave Calendar",
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = if (focused) 1f else 0.55f),
                maxLines = 1,
            )
            Spacer(Modifier.weight(1f))
            CaptionButtonBox(
                button = CaptionButton.MINIMIZE,
                captionState = captionState,
                windowFocused = focused,
                description = tr("window.minimize"),
            ) { fg, _ -> CaptionGlyph(CaptionButton.MINIMIZE, restore = false, color = fg, fill = fg) }
            CaptionButtonBox(
                button = CaptionButton.MAXIMIZE,
                captionState = captionState,
                windowFocused = focused,
                description = if (maximized) tr("window.restore") else tr("window.maximize"),
            ) { fg, bg ->
                CaptionGlyph(CaptionButton.MAXIMIZE, restore = maximized, color = fg, fill = bg)
            }
            CaptionButtonBox(
                button = CaptionButton.CLOSE,
                captionState = captionState,
                windowFocused = focused,
                description = tr("window.close"),
            ) { fg, _ -> CaptionGlyph(CaptionButton.CLOSE, restore = false, color = fg, fill = fg) }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f))
    }
}

@Composable
private fun CaptionButtonBox(
    button: CaptionButton,
    captionState: CaptionButtonState,
    windowFocused: Boolean,
    description: String,
    glyph: @Composable (fg: Color, bg: Color) -> Unit,
) {
    val hovered = captionState.hovered == button
    val pressed = captionState.pressed == button
    val isClose = button == CaptionButton.CLOSE
    val onSurface = MaterialTheme.colorScheme.onSurface
    val bg = when {
        isClose && pressed -> ClosePressedRed
        isClose && hovered -> CloseHoverRed
        pressed -> onSurface.copy(alpha = 0.13f)
        hovered -> onSurface.copy(alpha = 0.08f)
        else -> Color.Transparent
    }
    val fg = when {
        isClose && (hovered || pressed) -> Color.White
        !windowFocused -> onSurface.copy(alpha = 0.55f)
        else -> onSurface
    }
    // 还原字形的前框要用底色填充(盖住后框的线条),底色就是按钮当前的背景;
    // 未悬停时按钮透明,填充色就是标题栏的 surface。
    val fill = if (bg == Color.Transparent) MaterialTheme.colorScheme.surface else bg
    Box(
        modifier = Modifier
            .width(WindowFrameMetrics.CaptionButtonWidth)
            .fillMaxHeight()
            .background(bg)
            .semantics { contentDescription = description },
        contentAlignment = Alignment.Center,
    ) {
        glyph(fg, fill)
    }
}

/**
 * 按钮字形用 Canvas 画线,不用字体字符 —— 「─ ▢ ✕」这类字形在不同
 * 系统字体下粗细位置全不一样,画出来的线条粗细(1dp)处处一致。
 */
@Composable
private fun CaptionGlyph(button: CaptionButton, restore: Boolean, color: Color, fill: Color) {
    Canvas(Modifier.size(10.dp)) {
        val stroke = 1.dp.toPx()
        val w = size.width
        val h = size.height
        when (button) {
            CaptionButton.MINIMIZE ->
                drawLine(color, Offset(0f, h / 2f), Offset(w, h / 2f), stroke)
            CaptionButton.CLOSE -> {
                drawLine(color, Offset(0f, 0f), Offset(w, h), stroke)
                drawLine(color, Offset(0f, h), Offset(w, 0f), stroke)
            }
            CaptionButton.MAXIMIZE -> if (!restore) {
                val inset = stroke / 2f
                drawRect(
                    color,
                    topLeft = Offset(inset, inset),
                    size = Size(w - stroke, h - stroke),
                    style = Stroke(stroke),
                )
            } else {
                // 还原:右上一个后框、左下一个前框,前框填底色盖住后框的左下角。
                val off = 2.5.dp.toPx()
                val s = w - off
                drawRect(color, topLeft = Offset(off, 0f), size = Size(s, s), style = Stroke(stroke))
                drawRect(fill, topLeft = Offset(0f, off), size = Size(s, s))
                drawRect(color, topLeft = Offset(0f, off), size = Size(s, s), style = Stroke(stroke))
            }
            CaptionButton.NONE -> Unit
        }
    }
}
