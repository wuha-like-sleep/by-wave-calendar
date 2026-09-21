// 开机 / APP 被覆盖安装之后，把提醒重新排一遍。
//
// 为什么需要它：AlarmManager 里的 PendingIntent **不跨重启**，也不跨一次
// 覆盖安装。原来 manifest 上写着「The receiver also acts on boot completed」，
// 但 ReminderReceiver 根本没有任何 intent-filter，而且 exported="false" ——
// 系统的 BOOT_COMPLETED 广播永远送不到它；就算送到了，ReminderReceiver.
// onReceive 第一件事是从 intent 里取事件标题，取不到直接 return，本来也
// 处理不了开机广播。
//
// 结果是：手机重启一次，之前排好的提醒全部永久消失，而设置页那个开关还
// 开着 —— 用户不会收到任何提醒，也不会收到任何提示。
//
// 收哪些广播：
//   - BOOT_COMPLETED：正常开机。接收器**必须 exported 才收得到**（这是
//     系统进程发过来的），所以这个 receiver 和 ReminderReceiver 不能合并。
//   - MY_PACKAGE_REPLACED：覆盖安装（我们是直接发 APK 的，这条路走得很勤），
//     同样会把已排的闹钟清空。
//   - QUICKBOOT_POWERON：部分国产 ROM 的「快速开机」用这个代替 BOOT_COMPLETED。
// 这几条都在 Android 8+ 隐式广播限制的豁免名单里，静态注册收得到。

package cn.bywave.calendar.sync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import cn.bywave.calendar.BywaveApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action !in HANDLED) return

        // 重排要读 Room + 读 DataStore，都是挂起的；goAsync 让系统多等一会儿
        // （几秒的预算，够跑完最多 64 条），别在主线程上硬等。
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                Reminders.ensureChannel(context.applicationContext)
                // applySyncPreferences 本来就是「把开关的当前状态落到系统上」：
                // 开着就按缓存里的事件重排，关着就取消。开机后要的正是这个，
                // 不用另写一套排期逻辑（另写一套就会和设置页那条路慢慢长歪）。
                BywaveApp.instance.repository.applySyncPreferences()
            } catch (_: Throwable) {
                // 开机广播里不做任何会打扰用户的事。排不上就等下一次同步。
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        private const val QUICKBOOT = "android.intent.action.QUICKBOOT_POWERON"
        private const val HTC_QUICKBOOT = "com.htc.intent.action.QUICKBOOT_POWERON"

        internal val HANDLED = setOf(
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            QUICKBOOT,
            HTC_QUICKBOOT,
        )
    }
}
