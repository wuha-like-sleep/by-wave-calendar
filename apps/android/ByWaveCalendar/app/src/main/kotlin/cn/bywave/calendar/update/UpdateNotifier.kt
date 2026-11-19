// 「新版本已经下载好」的一条系统通知。
//
// Android 对齐桌面端的口径只能对齐到这里：桌面是静默下载、退出/下次
// 启动时提示安装；Android 没有「退出时」这个时机，也不允许应用静默
// 安装（系统安装器必须由用户点确认，这条平台规则不绕）。所以这边是：
// 后台自动下载 → 校验通过 → 发一条通知，用户点通知回到 App，更新
// 面板里已经是「立即安装」状态（安装包就在缓存里，校验现成的）。
//
// 通知权限没给（Android 13+ 未授权）时静默跳过：应用内面板照常在下次
// 打开时出现，不能因为一条发不出的通知把自动下载这条路弄崩。

package cn.bywave.calendar.update

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import cn.bywave.calendar.MainActivity
import cn.bywave.calendar.R

object UpdateNotifier {
    const val CHANNEL_ID = "app_updates"
    private const val NOTIFICATION_ID = 987001

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.update_channel_name),
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply { description = context.getString(R.string.update_channel_desc) },
        )
    }

    /** APK 已下载并校验通过时调用。发不出去（没权限）就安静返回。 */
    fun notifyReady(context: Context, release: AndroidReleaseDto) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) return
        ensureChannel(context)
        val openApp = PendingIntent.getActivity(
            context, NOTIFICATION_ID,
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher_monochrome)
            .setContentTitle(context.getString(R.string.update_notify_title))
            .setContentText(context.getString(R.string.update_notify_body, "v${release.versionName}"))
            .setAutoCancel(true)
            .setContentIntent(openApp)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        runCatching { NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, n) }
    }
}
