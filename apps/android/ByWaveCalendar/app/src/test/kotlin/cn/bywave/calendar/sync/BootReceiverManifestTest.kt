// 门禁五：手机重启一次，提醒不许全部消失。
//
// 出事的形状：manifest 的注释写着「The receiver also acts on boot completed」，
// 而 ReminderReceiver 既没有 intent-filter 也 exported="false" —— 系统的
// BOOT_COMPLETED 永远送不到它。注释说到了，代码没做到，没有任何东西会报错。
//
// 这条门禁读真的 AndroidManifest.xml，逐条比对接收器的声明。纯 JVM，不需要
// 模拟器。

package cn.bywave.calendar.sync

import cn.bywave.calendar.ResLocales
import cn.bywave.calendar.data.store.REMINDERS_DEFAULT
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

class BootReceiverManifestTest {

    private val manifest: Element by lazy {
        val f = File(ResLocales.resDir.parentFile, "AndroidManifest.xml")
        assertTrue("找不到 AndroidManifest.xml：${f.absolutePath}", f.isFile)
        // 必须开 namespaceAware，否则 android:exported 这类带前缀的属性
        // 用 getAttributeNS 全都读成空串 —— 断言会「绿着而洞开着」。
        val factory = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
        factory.newDocumentBuilder().parse(f).documentElement
    }

    private val androidNs = "http://schemas.android.com/apk/res/android"

    private fun receivers(): List<Element> {
        val nodes = manifest.getElementsByTagName("receiver")
        return (0 until nodes.length).map { nodes.item(it) as Element }
    }

    private fun Element.androidName(): String = getAttributeNS(androidNs, "name")

    @Test
    fun `BootReceiver 声明了而且是导出的`() {
        val boot = receivers().firstOrNull { it.androidName() == ".sync.BootReceiver" }
        assertTrue("manifest 里没有 .sync.BootReceiver —— 重启之后提醒不会回来", boot != null)
        boot!!
        // BOOT_COMPLETED 是系统进程发过来的，不导出就收不到。这一条写错
        // 不会报任何错，只会静悄悄收不到广播。
        assertEquals(
            "BootReceiver 必须 exported=true，否则收不到系统广播",
            "true", boot.getAttributeNS(androidNs, "exported"),
        )
    }

    @Test
    fun `BootReceiver 的 intent-filter 里有开机和覆盖安装`() {
        val boot = receivers().first { it.androidName() == ".sync.BootReceiver" }
        val actions = boot.getElementsByTagName("action").let { nodes ->
            (0 until nodes.length).map { (nodes.item(it) as Element).getAttributeNS(androidNs, "name") }
        }.toSet()
        assertTrue("少了 BOOT_COMPLETED：$actions", "android.intent.action.BOOT_COMPLETED" in actions)
        // 覆盖安装同样会清空 AlarmManager 里的 PendingIntent，而我们是直接
        // 发 APK 的，这条路走得比重启还勤。
        assertTrue("少了 MY_PACKAGE_REPLACED：$actions", "android.intent.action.MY_PACKAGE_REPLACED" in actions)

        // manifest 注册了、代码里不认，等于白注册。两边必须对得上。
        val unhandled = actions - BootReceiver.HANDLED
        assertTrue("manifest 注册了但 onReceive 不认的 action：$unhandled", unhandled.isEmpty())
    }

    @Test
    fun `RECEIVE_BOOT_COMPLETED 权限还在`() {
        val nodes = manifest.getElementsByTagName("uses-permission")
        val perms = (0 until nodes.length)
            .map { (nodes.item(it) as Element).getAttributeNS(androidNs, "name") }
            .toSet()
        assertTrue(
            "没有 RECEIVE_BOOT_COMPLETED，intent-filter 写了也收不到",
            "android.permission.RECEIVE_BOOT_COMPLETED" in perms,
        )
    }

    /** ReminderReceiver 只该处理自己排的闹钟，不该被当成开机接收器。 */
    @Test
    fun `ReminderReceiver 仍然不导出且没有 intent-filter`() {
        val reminder = receivers().first { it.androidName() == ".sync.ReminderReceiver" }
        assertEquals("false", reminder.getAttributeNS(androidNs, "exported"))
        assertEquals(
            "ReminderReceiver 不该有 intent-filter：它拿不到事件标题就直接 return",
            0, reminder.getElementsByTagName("intent-filter").length,
        )
    }

    /** 手机才是最该响的那一端，默认值要和桌面端一致。 */
    @Test
    fun `提醒默认是开的`() {
        assertTrue("提醒默认又被改回关了", REMINDERS_DEFAULT)
    }
}
