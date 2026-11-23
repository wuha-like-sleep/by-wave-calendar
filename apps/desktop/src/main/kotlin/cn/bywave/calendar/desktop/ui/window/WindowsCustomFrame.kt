// Windows 自绘窗口框的原生层 —— 不摘窗口样式,只接管两个消息。
//
// 做法(而不是 Compose 的 undecorated=true):窗口保持 AWT 默认的
// WS_THICKFRAME | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX |
// WS_MAXIMIZEBOX 样式,用 JNA 把窗口过程子类化,只拦:
//
//   · WM_NCCALCSIZE —— 先链回 AWT 原过程拿到默认客户区,再把左右
//     下三边扩回窗口边缘、上边收回「边框 + 标题栏」的高度。默认
//     客户区的上边距恰好 = 边框 + 标题栏 + AWT 菜单栏,只扣前两项,
//     菜单栏原样保留(它的高度随窗口宽度换行变化,只能从默认客户区
//     里反推,不能自己算)。结果:客户区铺满整个窗口(菜单栏除外),
//     系统标题栏消失,但边框样式还在 —— DWM 阴影、拖到屏幕边缘的
//     Aero Snap、窗口动画都由系统照旧提供。最大化时不做任何调整:
//     默认客户区正好是工作区,改了反而会溢出屏幕或压住任务栏。
//   · WM_NCHITTEST —— 按几何位置回答命中码:边缘 → 8 向缩放码,
//     标题栏右侧三钮 → HTMINBUTTON / HTMAXBUTTON / HTCLOSE,其余
//     标题栏 → HTCAPTION(拖动、双击最大化、拖到边缘分屏都由系统
//     默认过程接手),菜单栏条 → HTMENU,其余 → HTCLIENT。
//     回答 HTMAXBUTTON 是 Win11 的 Snap Layouts(悬停最大化按钮弹
//     分屏菜单)能出现的前提。
//
// 按钮的点击动作(最小化/最大化/关闭)不在这里处理:命中码是按钮码
// 时,默认窗口过程会自己发 WM_SYSCOMMAND / WM_CLOSE,关闭最终走
// Compose 的 onCloseRequest,和原生标题栏没有区别。这里只把悬停/
// 按下状态回填给 Compose 画按钮(WM_NCMOUSEMOVE 的 wParam 就是
// 命中码,和 Windows 的判断天然一致)。
//
// 其余消息一律链回 AWT 原过程 —— 最小尺寸(WM_GETMINMAXINFO)、
// 菜单、焦点、绘制都还是 AWT 在管,本文件不越界。

package cn.bywave.calendar.desktop.ui.window

import com.sun.jna.Native
import com.sun.jna.Pointer
import com.sun.jna.Structure
import com.sun.jna.win32.StdCallLibrary
import cn.bywave.calendar.desktop.util.DebugLog
import java.awt.Window
import java.util.concurrent.atomic.AtomicReference

private const val GWLP_WNDPROC = -4

private const val WM_NCCALCSIZE = 0x0083
private const val WM_NCHITTEST = 0x0084
private const val WM_MOUSEMOVE = 0x0200
private const val WM_NCMOUSEMOVE = 0x00A0
private const val WM_NCLBUTTONDOWN = 0x00A1
private const val WM_NCLBUTTONUP = 0x00A2
private const val WM_NCMOUSELEAVE = 0x02A2
private const val WM_CAPTURECHANGED = 0x0215

private const val HTCLIENT = 1
private const val HTCAPTION = 2
private const val HTMENU = 5
private const val HTMINBUTTON = 8
private const val HTMAXBUTTON = 9
private const val HTLEFT = 10
private const val HTRIGHT = 11
private const val HTTOP = 12
private const val HTTOPLEFT = 13
private const val HTTOPRIGHT = 14
private const val HTBOTTOM = 15
private const val HTBOTTOMLEFT = 16
private const val HTBOTTOMRIGHT = 17
private const val HTCLOSE = 20

private const val SM_CXSIZEFRAME = 32
private const val SM_CYSIZEFRAME = 33
private const val SM_CYCAPTION = 4
private const val SM_CXPADDEDBORDER = 92

private const val SWP_NOSIZE = 0x0001
private const val SWP_NOMOVE = 0x0002
private const val SWP_NOZORDER = 0x0004
private const val SWP_NOACTIVATE = 0x0010
private const val SWP_FRAMECHANGED = 0x0020

private const val TME_LEAVE = 0x00000002
private const val TME_NONCLIENT = 0x00000010

internal interface WndProcCallback : StdCallLibrary.StdCallCallback {
    fun callback(hwnd: Pointer, msg: Int, wParam: Long, lParam: Long): Long
}

internal open class RectStruct : Structure() {
    @JvmField var left: Int = 0
    @JvmField var top: Int = 0
    @JvmField var right: Int = 0
    @JvmField var bottom: Int = 0
    override fun getFieldOrder(): List<String> = listOf("left", "top", "right", "bottom")
}

internal class RectByRef : RectStruct(), Structure.ByReference

internal open class PointStruct : Structure() {
    @JvmField var x: Int = 0
    @JvmField var y: Int = 0
    override fun getFieldOrder(): List<String> = listOf("x", "y")
}

internal class PointByRef : PointStruct(), Structure.ByReference

internal open class TrackMouseEventStruct : Structure() {
    @JvmField var cbSize: Int = 0
    @JvmField var dwFlags: Int = 0
    @JvmField var hwndTrack: Pointer? = null
    @JvmField var dwHoverTime: Int = 0
    override fun getFieldOrder(): List<String> = listOf("cbSize", "dwFlags", "hwndTrack", "dwHoverTime")
}

internal class TrackMouseEventByRef : TrackMouseEventStruct(), Structure.ByReference

internal interface User32Frame : StdCallLibrary {
    fun SetWindowLongPtrW(hWnd: Pointer, nIndex: Int, dwNewLong: WndProcCallback): Pointer?
    fun CallWindowProcW(lpPrevWndFunc: Pointer, hWnd: Pointer, uMsg: Int, wParam: Long, lParam: Long): Long
    fun DefWindowProcW(hWnd: Pointer, uMsg: Int, wParam: Long, lParam: Long): Long
    fun GetDpiForWindow(hWnd: Pointer): Int
    fun GetSystemMetrics(nIndex: Int): Int
    fun GetSystemMetricsForDpi(nIndex: Int, dpi: Int): Int
    fun GetWindowRect(hWnd: Pointer, lpRect: RectByRef): Boolean
    fun ClientToScreen(hWnd: Pointer, lpPoint: PointByRef): Boolean
    fun IsZoomed(hWnd: Pointer): Boolean
    fun SetWindowPos(hWnd: Pointer, hWndInsertAfter: Pointer?, x: Int, y: Int, cx: Int, cy: Int, uFlags: Int): Boolean
    fun TrackMouseEvent(lpEventTrack: TrackMouseEventByRef): Boolean
}

private class FrameWndProc(
    private val hwnd: Pointer,
    private val user32: User32Frame,
    private val captionState: CaptionButtonState,
) : WndProcCallback {

    /** AWT 原窗口过程。SetWindowLongPtr 返回后才回填,回填前链调用走 DefWindowProc 兜底。 */
    val prevProc = AtomicReference<Pointer?>(null)

    private var leaveTrackingArmed = false

    override fun callback(hwnd: Pointer, msg: Int, wParam: Long, lParam: Long): Long {
        // 原生回调里异常绝不能穿透进 AWT 的消息泵 —— 任何意外都退回链调用。
        return try {
            when (msg) {
                WM_NCCALCSIZE -> handleCalcSize(wParam, lParam)
                WM_NCHITTEST -> hitTest(lParam).toLong()
                WM_NCMOUSEMOVE -> {
                    val hit = buttonForHit(wParam.toInt())
                    captionState.hovered = hit
                    // 按下后滑出按钮 = 取消按下观感(与系统按钮一致);动作本身仍由默认过程决定。
                    if (captionState.pressed != CaptionButton.NONE && captionState.pressed != hit) {
                        captionState.pressed = CaptionButton.NONE
                    }
                    armMouseLeaveTracking()
                    chain(msg, wParam, lParam)
                }
                WM_NCLBUTTONDOWN -> {
                    captionState.pressed = buttonForHit(wParam.toInt())
                    chain(msg, wParam, lParam)
                }
                WM_NCLBUTTONUP -> {
                    captionState.pressed = CaptionButton.NONE
                    chain(msg, wParam, lParam)
                }
                WM_NCMOUSELEAVE -> {
                    captionState.hovered = CaptionButton.NONE
                    captionState.pressed = CaptionButton.NONE
                    leaveTrackingArmed = false
                    chain(msg, wParam, lParam)
                }
                WM_CAPTURECHANGED -> {
                    captionState.pressed = CaptionButton.NONE
                    chain(msg, wParam, lParam)
                }
                WM_MOUSEMOVE -> {
                    // 客户区的移动大多被 Skia 子窗口吃掉,这里只作兜底清理。
                    if (captionState.hovered != CaptionButton.NONE) captionState.hovered = CaptionButton.NONE
                    chain(msg, wParam, lParam)
                }
                else -> chain(msg, wParam, lParam)
            }
        } catch (_: Throwable) {
            runCatching { chain(msg, wParam, lParam) }.getOrDefault(0L)
        }
    }

    private fun chain(msg: Int, wParam: Long, lParam: Long): Long {
        val prev = prevProc.get()
        return if (prev != null) user32.CallWindowProcW(prev, hwnd, msg, wParam, lParam)
        else user32.DefWindowProcW(hwnd, msg, wParam, lParam)
    }

    private fun handleCalcSize(wParam: Long, lParam: Long): Long {
        // wParam == 0 时 lParam 只是个 RECT 而且语义不同,默认处理即可。
        if (wParam == 0L) return chain(WM_NCCALCSIZE, wParam, lParam)
        // lParam 是 NCCALCSIZE_PARAMS,rgrc[0] 在偏移 0 处:进入时是建议的
        // 窗口矩形,链回原过程后被改成默认客户区。先把窗口矩形存下来。
        val ptr = Pointer(lParam)
        val winLeft = ptr.getInt(0)
        val winTop = ptr.getInt(4)
        val winRight = ptr.getInt(8)
        val winBottom = ptr.getInt(12)
        val result = chain(WM_NCCALCSIZE, wParam, lParam)
        if (user32.IsZoomed(hwnd)) return result
        val dpi = user32.GetDpiForWindow(hwnd).takeIf { it > 0 } ?: 96
        val fy = frameThickness(SM_CYSIZEFRAME, dpi)
        // 默认客户区的上边距 = 边框(fy)+ 标题栏 + 菜单栏。扣掉前两项,
        // 剩下的恰好是菜单栏:客户区从菜单栏下方开始铺满。只扣 fy 的话
        // 标题栏高度的非客户区还在,DWM 会在那条里继续画系统标题文字,
        // 自绘栏反而要叠在它下面 —— 必须连标题栏一起扣。maxOf 兜底:
        // 万一某个 DPI 下度量对不齐,客户区上沿也不能越过窗口上沿。
        val newTop = maxOf(ptr.getInt(4) - fy - captionHeight(dpi), winTop)
        ptr.setInt(0, winLeft)
        ptr.setInt(4, newTop)
        ptr.setInt(8, winRight)
        ptr.setInt(12, winBottom)
        return 0L
    }

    private fun hitTest(lParam: Long): Int {
        // lParam 低/高 16 位是屏幕坐标(有符号,多屏副屏可以为负)。
        val screenX = (lParam and 0xFFFFL).toShort().toInt()
        val screenY = ((lParam shr 16) and 0xFFFFL).toShort().toInt()
        val win = RectByRef()
        if (!user32.GetWindowRect(hwnd, win)) return HTCLIENT
        val origin = PointByRef()
        if (!user32.ClientToScreen(hwnd, origin)) return HTCLIENT
        val dpi = user32.GetDpiForWindow(hwnd).takeIf { it > 0 } ?: 96
        val relX = screenX - win.left
        val relY = screenY - win.top
        val width = win.right - win.left
        val height = win.bottom - win.top
        if (!user32.IsZoomed(hwnd)) {
            val fx = frameThickness(SM_CXSIZEFRAME, dpi)
            val fy = frameThickness(SM_CYSIZEFRAME, dpi)
            val onLeft = relX < fx
            val onRight = relX >= width - fx
            val onTop = relY < fy
            val onBottom = relY >= height - fy
            when {
                onTop && onLeft -> return HTTOPLEFT
                onTop && onRight -> return HTTOPRIGHT
                onBottom && onLeft -> return HTBOTTOMLEFT
                onBottom && onRight -> return HTBOTTOMRIGHT
                onLeft -> return HTLEFT
                onRight -> return HTRIGHT
                onTop -> return HTTOP
                onBottom -> return HTBOTTOM
            }
        }
        // 客户区原点的屏幕偏移 = AWT 菜单栏占掉的高度(没有菜单时为 0)。
        // 菜单条不归我们管,命中码要还给 HTMENU,不然菜单点不动。
        val clientTop = origin.y - win.top
        if (relY < clientTop) return HTMENU
        val titleH = WindowFrameMetrics.titleBarHeightPx(dpi)
        if (relY < clientTop + titleH) {
            val btnW = WindowFrameMetrics.captionButtonWidthPx(dpi)
            val fromRight = width - relX
            return when {
                fromRight < btnW -> HTCLOSE
                fromRight < btnW * 2 -> HTMAXBUTTON
                fromRight < btnW * 3 -> HTMINBUTTON
                else -> HTCAPTION
            }
        }
        return HTCLIENT
    }

    private fun buttonForHit(hit: Int): CaptionButton = when (hit) {
        HTMINBUTTON -> CaptionButton.MINIMIZE
        HTMAXBUTTON -> CaptionButton.MAXIMIZE
        HTCLOSE -> CaptionButton.CLOSE
        else -> CaptionButton.NONE
    }

    private fun armMouseLeaveTracking() {
        if (leaveTrackingArmed) return
        val tme = TrackMouseEventByRef()
        tme.cbSize = tme.size()
        tme.dwFlags = TME_LEAVE or TME_NONCLIENT
        tme.hwndTrack = hwnd
        tme.dwHoverTime = 0
        if (user32.TrackMouseEvent(tme)) leaveTrackingArmed = true
    }

    /** 可缩放边框厚度 = 边框 + 衬边距,微软自绘边框示例的口径;按窗口当前 DPI 取。 */
    private fun frameThickness(metric: Int, dpi: Int): Int = runCatching {
        user32.GetSystemMetricsForDpi(metric, dpi) + user32.GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi)
    }.getOrElse {
        user32.GetSystemMetrics(metric) + user32.GetSystemMetrics(SM_CXPADDEDBORDER)
    }

    /** 系统标题栏高度(按窗口当前 DPI 取);默认客户区的上边距里含这一项。 */
    private fun captionHeight(dpi: Int): Int = runCatching {
        user32.GetSystemMetricsForDpi(SM_CYCAPTION, dpi)
    }.getOrElse {
        user32.GetSystemMetrics(SM_CYCAPTION)
    }
}

internal object WindowsCustomFrame {

    // 强引用:窗口过程回调和 user32 句柄必须活得和进程一样久 —— 回调
    // 被 GC 回收后,下一次消息会跳进已释放的跳板,进程直接崩。
    private var user32: User32Frame? = null
    private var proc: FrameWndProc? = null

    /**
     * 给主窗口装上自绘框。成功返回 true;任何一步失败返回 false,
     * 调用方保持系统原生框照常启动 —— 自绘是观感,不是功能依赖。
     */
    fun install(window: Window, captionState: CaptionButtonState): Boolean {
        if (proc != null) return true
        return runCatching {
            val hwnd = Native.getWindowPointer(window) ?: return false
            val u32 = Native.load("user32", User32Frame::class.java)
            val p = FrameWndProc(hwnd, u32, captionState)
            val prev = u32.SetWindowLongPtrW(hwnd, GWLP_WNDPROC, p)
            if (prev == null || Pointer.nativeValue(prev) == 0L) return false
            p.prevProc.set(prev)
            user32 = u32
            proc = p
            // 立刻强制重算一次非客户区,不然要等用户下一次拖动窗口才生效。
            // 单独包一层:窗口过程已经装上了,这一步失败也不能把结果翻成
            // false —— 否则界面不画自绘栏、系统标题栏又已被接管,窗口就没框了。
            runCatching {
                u32.SetWindowPos(
                    hwnd, null, 0, 0, 0, 0,
                    SWP_NOMOVE or SWP_NOSIZE or SWP_NOZORDER or SWP_NOACTIVATE or SWP_FRAMECHANGED,
                )
            }
            DebugLog.d("WindowsCustomFrame") { "custom frame installed" }
            true
        }.onFailure {
            DebugLog.d("WindowsCustomFrame") { "install failed, keeping native frame: ${it.message}" }
        }.getOrDefault(false)
    }
}
