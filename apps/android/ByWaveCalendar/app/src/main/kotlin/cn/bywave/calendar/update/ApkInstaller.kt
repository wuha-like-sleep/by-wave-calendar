// Hands a downloaded APK file off to the system installer. Android
// flow:
//
//   1. Check pm.canRequestPackageInstalls() — Android 8+ requires the
//      user to grant "install unknown apps" for THIS app, one time.
//   2. If not granted → launch ACTION_MANAGE_UNKNOWN_APP_SOURCES with
//      our package URI. User toggles the switch, comes back.
//   3. Build a content:// URI via FileProvider rooted at cache/updates.
//   4. ACTION_VIEW with application/vnd.android.package-archive +
//      FLAG_GRANT_READ_URI_PERMISSION. System installer takes over,
//      shows its confirm screen. User taps "安装".
//   5. APP gets replaced. Next cold launch is the new version.
//
// We can NEVER skip step 4's confirm — only system-signed apps (carrier
// pre-installs) can silent-install, which is by design. Users see one
// system dialog per update. That's the baseline OS contract; no APP
// can do better outside of the Play Store install path.

package cn.bywave.calendar.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File

sealed class InstallResult {
    object Launched : InstallResult()
    /** Need the user to grant "install from this source" first.
     *  The caller should launch the supplied intent and wait for the
     *  user to return. */
    data class NeedsUnknownSources(val settingsIntent: Intent) : InstallResult()
    data class Failed(val message: String) : InstallResult()
}

object ApkInstaller {
    /** Try to launch the system installer for [apk]. Returns
     *  Launched on success, NeedsUnknownSources if the user must grant
     *  the per-app toggle first, or Failed for any other error. */
    fun install(context: Context, apk: File): InstallResult {
        if (!apk.exists() || apk.length() <= 0) {
            return InstallResult.Failed("安装包文件不存在或为空")
        }

        // Permission gate (Android 8.0+).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val canInstall = context.packageManager.canRequestPackageInstalls()
            if (!canInstall) {
                val settings = Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:${context.packageName}"),
                ).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                return InstallResult.NeedsUnknownSources(settings)
            }
        }

        return try {
            val authority = "${context.packageName}.fileprovider"
            val uri = FileProvider.getUriForFile(context, authority, apk)
            val install = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(install)
            InstallResult.Launched
        } catch (e: Exception) {
            InstallResult.Failed(e.localizedMessage ?: "无法启动系统安装程序")
        }
    }
}
