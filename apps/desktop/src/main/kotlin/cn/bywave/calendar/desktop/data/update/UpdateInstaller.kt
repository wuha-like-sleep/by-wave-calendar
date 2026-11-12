// Sparkle-style in-place updater. Given a downloaded DMG, mounts it,
// writes a small shell script to /tmp that swaps the running .app for
// the new one (after this JVM exits), then exits. No drag-to-Applications,
// no Finder dance — the user clicks「下载并安装」 and the new version
// is running in ~5 seconds.
//
// v0.8 adds a Chrome / VS Code style "download-in-background, apply on
// quit" path on top of the click-to-install path:
//   - stage(dmg)   stashes a downloaded DMG + arms a JVM shutdown hook.
//                  When the user quits the app the hook spawns the same
//                  detached swap script — but with relaunch=false, so the
//                  app stays closed (quit + reopen = updated).
//   - install(dmg) is the unchanged "apply now": swap + relaunch + exit.
//                  The banner's「立即重启」button calls this. It clears the
//                  staged file first so the shutdown hook can't double-apply.
// Both paths funnel through spawnSwapScript() so the mount/verify/swap
// logic lives in exactly one place.
//
// Why a shell script instead of doing the swap from inside the JVM:
// macOS won't let us `rm -rf` our own .app while the JVM is running
// from inside it (the binaries are open, sandbox + Mandatory Access
// Control complaints). So we hand off to a detached `/bin/bash` process,
// then exitProcess(0) — the script wakes up 2 seconds later, by which
// point the JVM is gone, the .app is unreferenced, and the swap is
// safe.
//
// Fallback chain (any step failing → show DMG in Finder for manual
// install, which is exactly the v0.7.6 behaviour):
//   - hdiutil attach fails             → open(DMG) in Finder
//   - DMG has no ByWaveCalendar.app    → reveal mount in Finder
//   - Can't locate current /Applications/ByWaveCalendar.app → reveal mount
//   - Parent dir isn't writable        → reveal mount
//
// Platform support: macOS only (this file). Windows / Linux paths in
// UpdateDownloader fall back to Desktop.open() — the MSI installer
// handles its own upgrade via msiexec; .deb on Linux is a system
// install via dpkg.
//
// Log: /tmp/bywave-update.log captures the swap script's output so
// post-mortems are possible if something goes wrong. The script
// re-launches the new .app via `open`, so the user sees a flicker
// and then the updated app appears.

package cn.bywave.calendar.desktop.data.update

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.awt.Desktop
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.system.exitProcess
import cn.bywave.calendar.desktop.util.DebugLog

object UpdateInstaller {

    private val _state = MutableStateFlow<InstallState>(InstallState.Idle)
    val state: StateFlow<InstallState> = _state.asStateFlow()

    /** A downloaded DMG that's ready to apply on quit (or via「立即重启」).
     *  Set by [stage]; cleared by [install] before it exits so the
     *  shutdown hook can't double-apply. The UI observes this to show
     *  the「退出后自动更新」banner. */
    private val _staged = MutableStateFlow<java.io.File?>(null)
    val staged: StateFlow<java.io.File?> = _staged.asStateFlow()

    /** Guards single-registration of the apply-on-quit shutdown hook —
     *  [stage] may be called more than once per session (e.g. a second
     *  manifest lands), but we only want one hook. */
    private var hookRegistered = false

    sealed class InstallState {
        object Idle : InstallState()
        /** hdiutil attach in flight. */
        object Mounting : InstallState()
        /** Swap script spawned; JVM about to exit. UI should show
         *  "正在安装并重启…" then disappear when the new app launches. */
        object Swapping : InstallState()
        /** Auto-install can't run for some reason — DMG opened in Finder
         *  with a hint to drag manually. We don't exit the JVM in this
         *  case; the user can continue using the running version. */
        data class FallbackOpenedInFinder(val reason: String) : InstallState()
        data class Failed(val message: String) : InstallState()
    }

    /** Install a downloaded DMG NOW. macOS does the in-place swap +
     *  relaunch; other platforms open the file with the system default
     *  handler (so the MSI installer pops up on Windows, etc.).
     *
     *  On macOS success this call does NOT return — exitProcess(0). The
     *  swap script takes over and relaunches the new .app. This is the
     *  「立即重启」path; it clears any staged DMG first so the
     *  apply-on-quit shutdown hook can't run a second swap. */
    fun install(dmgFile: File) {
        // Clear staging BEFORE we (potentially) exit: the shutdown hook
        // reads _staged.value, so leaving it set would have the hook
        // re-run the swap on the very exitProcess(0) below.
        _staged.value = null

        val os = System.getProperty("os.name").orEmpty().lowercase()
        // Windows:真·自动更新 —— 派生一个 .cmd,等本进程退出后跑
        // msiexec 静默升级再把 APP 拉起来(此前只是 Desktop.open() 把
        // 安装向导丢给用户手点,所以「自动更新」在 Windows 上等于没有)。
        if (os.contains("win")) {
            if (spawnWindowsUpdateScript(dmgFile, relaunch = true)) {
                _state.value = InstallState.Swapping
                Thread.sleep(300)
                exitProcess(0)
            }
            return   // spawn 失败时已回落到 Desktop.open(),APP 继续运行
        }
        if (!os.contains("mac") && !os.contains("darwin")) {
            // Linux: .deb 是 dpkg/系统包管理器的地盘,交给默认处理程序。
            runCatching { Desktop.getDesktop().open(dmgFile) }
            _state.value = InstallState.FallbackOpenedInFinder(cn.bywave.calendar.desktop.i18n.I18n.t("update.installer.nonMac"))
            return
        }
        // spawnSwapScript drives state through Mounting → (fallback/Failed
        // on a precondition miss). If it returns false a precondition
        // failed and we must NOT exit the JVM (the running app stays up).
        val spawned = spawnSwapScript(dmgFile, relaunch = true, openFinderOnError = true)
        if (!spawned) return
        _state.value = InstallState.Swapping
        // Brief pause so Compose can repaint the "正在重启..." label
        // before we kill the process. The swap script's `sleep 2` covers
        // any race; this is just for the UI flash.
        Thread.sleep(300)
        exitProcess(0)
    }

    /** Stage a downloaded DMG to apply when the user quits the app. No
     *  swap happens now — we just stash the file and arm a JVM shutdown
     *  hook. The UI shows a「退出后自动更新」banner while a file is staged.
     *
     *  On non-macOS we keep the existing behaviour: there's no in-place
     *  swap, so just open the installer with the system handler (no
     *  staging). */
    fun stage(dmgFile: File) {
        val os = System.getProperty("os.name").orEmpty().lowercase()
        // Windows 现在和 macOS 一样支持「退出后自动更新」:只存文件 + 装
        // 钩子,不再在后台下载完成的瞬间冷不丁弹出安装向导(那是 1.0.15
        // 之前 Windows 用户看到的行为,既突兀又容易被当成病毒)。
        if (os.contains("mac") || os.contains("darwin") || os.contains("win")) {
            _staged.value = dmgFile
            registerShutdownHook()
            return
        }
        // Linux:没有原地升级路径,交给系统处理程序。
        runCatching { Desktop.getDesktop().open(dmgFile) }
        _state.value = InstallState.FallbackOpenedInFinder(cn.bywave.calendar.desktop.i18n.I18n.t("update.installer.nonMac"))
    }

    /** Register (once) the apply-on-quit hook. Runs on a plain thread at
     *  JVM exit — so it MUST use only blocking ProcessBuilder, no
     *  coroutines / Compose. We spawn the swap script detached with
     *  relaunch=false (the user is quitting; don't pop the app back open)
     *  and openFinderOnError=false (no Finder popup during a quit). The
     *  script's own `sleep 2` ensures the swap lands after this JVM is
     *  fully gone. */
    private fun registerShutdownHook() {
        if (hookRegistered) return
        hookRegistered = true
        Runtime.getRuntime().addShutdownHook(Thread {
            val f = _staged.value ?: return@Thread
            val os = System.getProperty("os.name").orEmpty().lowercase()
            runCatching {
                if (os.contains("win")) spawnWindowsUpdateScript(f, relaunch = false)
                else spawnSwapScript(f, relaunch = false, openFinderOnError = false)
            }
        })
    }

    /** Windows 原地升级。写一个 .cmd 到 %TEMP% 并 detach 派生:
     *    1) 等 2 秒,让本 JVM 完全退出 —— MSI 升级要删/换正在运行的
     *       exe 和 jar,进程没走干净会被 Windows 文件锁挡住;
     *    2) `msiexec /i … /passive /norestart` 执行升级。MSI 里
     *       upgradeUuid 固定,Windows 据此识别为「大版本升级」而不是
     *       并排装第二份。/passive 只显示进度条不需要点下一步;若安装
     *       范围是 per-machine 会弹一次 UAC(这是系统强制,躲不掉);
     *    3) 升级完把 APP 拉起来(relaunch=true 时);
     *    4) 脚本删掉自己。
     *  日志写到 %TEMP%\bywave-update.log,出问题能事后查。
     *  返回 true = 脚本已派生(调用方随后退出进程);false = 派生失败,
     *  已回落到 Desktop.open() 让用户手动装,APP 继续运行。 */
    private fun spawnWindowsUpdateScript(msiFile: File, relaunch: Boolean): Boolean {
        return try {
            // 当前 exe 路径:jpackage 生成的启动器(…\ByWaveCalendar.exe)。
            // 取不到就不重启 —— 宁可让用户自己点开,也不要拉起个错的东西。
            val exe = ProcessHandle.current().info().command().orElse(null)
            val tmp = File(System.getProperty("java.io.tmpdir"))
            val log = File(tmp, "bywave-update.log").absolutePath
            val script = File(tmp, "bywave-update-${System.nanoTime()}.cmd")
            val relaunchLine = if (relaunch && exe != null) "start \"\" \"$exe\"" else "rem no relaunch"
            script.writeText(
                buildString {
                    appendLine("@echo off")
                    appendLine("echo [%DATE% %TIME%] bywave update start >> \"$log\"")
                    // 等 JVM 退出,释放文件锁。
                    appendLine("timeout /t 2 /nobreak >nul")
                    appendLine("msiexec /i \"${msiFile.absolutePath}\" /passive /norestart /L*v \"$log\"")
                    appendLine("if errorlevel 1 (")
                    appendLine("  echo [%DATE% %TIME%] msiexec failed errorlevel=%errorlevel% >> \"$log\"")
                    // 静默升级失败(用户取消 UAC 等)→ 打开安装包让他手动装。
                    appendLine("  start \"\" \"${msiFile.absolutePath}\"")
                    appendLine(") else (")
                    appendLine("  echo [%DATE% %TIME%] bywave update ok >> \"$log\"")
                    appendLine("  $relaunchLine")
                    appendLine(")")
                    appendLine("del \"%~f0\"")
                },
                Charsets.US_ASCII,   // .cmd 用 ANSI 读;路径里的非 ASCII 由引号包住的绝对路径承载
            )
            ProcessBuilder("cmd", "/c", "start", "/min", "", script.absolutePath)
                .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                .redirectError(ProcessBuilder.Redirect.DISCARD)
                .start()
            true
        } catch (e: Exception) {
            DebugLog.d("ByWave Updater") { "windows spawn failed: ${e.message}" }
            runCatching { Desktop.getDesktop().open(msiFile) }
            _state.value = InstallState.FallbackOpenedInFinder(
                cn.bywave.calendar.desktop.i18n.I18n.t("update.installer.nonMac"),
            )
            false
        }
    }

    /** Shared macOS mount → locate → preconditions → write + spawn swap
     *  script. Used by BOTH [install] (relaunch=true) and the apply-on-
     *  quit shutdown hook (relaunch=false).
     *
     *  Returns true when the detached script was spawned, false on any
     *  precondition failure (mount fail / no app in DMG / can't locate or
     *  write current app / spawn error). On false it leaves [state] on a
     *  Fallback/Failed value (and, when [openFinderOnError], opens the DMG
     *  or mount in Finder for manual install). Does NOT exit the JVM —
     *  callers decide that. */
    private fun spawnSwapScript(dmgFile: File, relaunch: Boolean, openFinderOnError: Boolean): Boolean {
        _state.value = InstallState.Mounting
        val mountPoint = mountDmg(dmgFile)
        if (mountPoint == null) {
            // hdiutil failed — fall back to Finder so the user can mount
            // it manually. NOT a fatal error; their running app stays up.
            if (openFinderOnError) runCatching { Desktop.getDesktop().open(dmgFile) }
            _state.value = InstallState.FallbackOpenedInFinder(cn.bywave.calendar.desktop.i18n.I18n.t("update.installer.mountFailed"))
            return false
        }
        val newAppInDmg = File(mountPoint, "ByWaveCalendar.app")
        if (!newAppInDmg.exists()) {
            if (openFinderOnError) runCatching { Desktop.getDesktop().open(File(mountPoint)) }
            _state.value = InstallState.FallbackOpenedInFinder(cn.bywave.calendar.desktop.i18n.I18n.t("update.installer.appNotFound"))
            return false
        }
        val currentAppPath = locateCurrentAppPath()
        if (currentAppPath == null) {
            if (openFinderOnError) runCatching { Desktop.getDesktop().open(File(mountPoint)) }
            _state.value = InstallState.FallbackOpenedInFinder(
                cn.bywave.calendar.desktop.i18n.I18n.t("update.installer.locateFailed")
            )
            return false
        }
        val parent = File(currentAppPath).parentFile
        if (parent == null || !parent.canWrite()) {
            if (openFinderOnError) runCatching { Desktop.getDesktop().open(File(mountPoint)) }
            _state.value = InstallState.FallbackOpenedInFinder(
                cn.bywave.calendar.desktop.i18n.I18n.t(
                    "update.installer.noWritePermission",
                    mapOf("path" to (parent?.absolutePath ?: cn.bywave.calendar.desktop.i18n.I18n.t("update.installer.currentAppDir"))),
                )
            )
            return false
        }
        // All preconditions met — write the swap script + spawn it
        // detached. The caller decides whether to exitProcess(0).
        val scriptFile = writeSwapScript(
            mountPoint = mountPoint,
            newAppPath = newAppInDmg.absolutePath,
            currentAppPath = currentAppPath,
            relaunch = relaunch,
        )
        try {
            ProcessBuilder("/bin/bash", scriptFile.absolutePath)
                .redirectOutput(File("/tmp/bywave-update.log"))
                .redirectErrorStream(true)
                .start()
        } catch (e: Exception) {
            _state.value = InstallState.Failed(
                cn.bywave.calendar.desktop.i18n.I18n.t(
                    "update.installer.scriptFailed",
                    mapOf("error" to (e.message ?: e::class.simpleName ?: "")),
                )
            )
            return false
        }
        return true
    }

    /** `hdiutil attach -nobrowse` and parse the mount-point from
     *  tab-delimited output. Returns null on any failure — caller falls
     *  back to opening the DMG in Finder. */
    private fun mountDmg(dmg: File): String? = runCatching {
        val proc = ProcessBuilder(
            "hdiutil", "attach", dmg.absolutePath,
            "-nobrowse",   // don't show in Finder sidebar
            "-noverify",   // skip checksum (we already verified sha256)
            "-noautoopen", // don't auto-open the Finder window
        ).redirectErrorStream(true).start()
        val output = proc.inputStream.bufferedReader().readText()
        val ok = proc.waitFor(60, TimeUnit.SECONDS) && proc.exitValue() == 0
        if (!ok) return@runCatching null
        // Sample output:
        //   /dev/disk2          GUID_partition_scheme
        //   /dev/disk2s1        Apple_HFS                /Volumes/ByWaveCalendar
        // Last whitespace-separated field on a line starting with /Volumes/
        // is the mount point.
        output.lines().mapNotNull { line ->
            val parts = line.split('\t').map { it.trim() }
            parts.lastOrNull()?.takeIf { it.startsWith("/Volumes/") }
        }.firstOrNull()
    }.getOrNull()

    /** Walk up from `java.home` until we hit a directory ending in `.app` —
     *  that's the current app bundle. Compose Desktop's JRE lives at
     *  `<App>/Contents/runtime/Contents/Home`, so 4 levels up. Bounded
     *  walk so a misconfigured JVM home doesn't loop. */
    private fun locateCurrentAppPath(): String? {
        val javaHome = System.getProperty("java.home")
        if (javaHome != null) {
            var d: File? = File(javaHome)
            var hops = 0
            while (d != null && hops < 8) {
                if (d.name.endsWith(".app")) return d.absolutePath
                d = d.parentFile
                hops++
            }
        }
        // Fallback path probes — in case the JVM home walk doesn't land
        // on a .app (which would be weird for a Compose Desktop build,
        // but defensive).
        val home = System.getProperty("user.home")
        return listOf(
            "/Applications/ByWaveCalendar.app",
            "$home/Applications/ByWaveCalendar.app",
        ).firstOrNull { File(it).isDirectory }
    }

    internal fun shellLiteral(value: String): String = "'" + value.replace("'", "'\"'\"'") + "'"

    /** Stage beside the installed app, validate, then swap with rollback.
     * Untrusted or unsigned packages stay available for manual installation. */
    internal fun writeSwapScript(
        mountPoint: String,
        newAppPath: String,
        currentAppPath: String,
        relaunch: Boolean,
    ): File {
        val script = """
            |#!/bin/bash
            |PATH=/usr/bin:/bin:/usr/sbin:/sbin
            |MOUNT=${shellLiteral(mountPoint)}
            |SOURCE=${shellLiteral(newAppPath)}
            |CURRENT=${shellLiteral(currentAppPath)}
            |RELAUNCH=${if (relaunch) "1" else "0"}
            |LOG=${'$'}(mktemp -t bywave-update) || exit 1
            |fail() {
            |  echo "Update stopped; keeping the installed application." >> "${'$'}LOG"
            |  if [ "${'$'}RELAUNCH" = 1 ]; then open "${'$'}MOUNT"; fi
            |  exit 1
            |}
            |# Wait for this application's JVM, never kill unrelated instances.
            |for attempt in {1..30}; do
            |  kill -0 ${ProcessHandle.current().pid()} 2>/dev/null || break
            |  sleep 1
            |done
            |kill -0 ${ProcessHandle.current().pid()} 2>/dev/null && fail
            |# A valid ad-hoc signature alone is not Developer ID trust.
            |codesign --verify --deep --strict "${'$'}SOURCE" >> "${'$'}LOG" 2>&1 || fail
            |spctl --assess --type execute "${'$'}SOURCE" >> "${'$'}LOG" 2>&1 || fail
            |BUNDLE=${'$'}(/usr/libexec/PlistBuddy -c Print:CFBundleIdentifier "${'$'}SOURCE/Contents/Info.plist" 2>/dev/null)
            |[ "${'$'}BUNDLE" = cn.bywave.calendar.desktop ] || fail
            |OLD_TEAM=${'$'}(codesign -dv "${'$'}CURRENT" 2>&1 | sed -n 's/^TeamIdentifier=//p')
            |NEW_TEAM=${'$'}(codesign -dv "${'$'}SOURCE" 2>&1 | sed -n 's/^TeamIdentifier=//p')
            |[ -n "${'$'}NEW_TEAM" ] && [ "${'$'}NEW_TEAM" != not\ set ] || fail
            |if [ -n "${'$'}OLD_TEAM" ] && [ "${'$'}OLD_TEAM" != not\ set ]; then
            |  [ "${'$'}OLD_TEAM" = "${'$'}NEW_TEAM" ] || fail
            |fi
            |STAGE=${'$'}(mktemp -d "${'$'}(dirname "${'$'}CURRENT")/.bywave-update.XXXXXX") || fail
            |trap 'rm -rf "${'$'}STAGE/new.app"; rmdir "${'$'}STAGE" 2>/dev/null || true' EXIT
            |ditto "${'$'}SOURCE" "${'$'}STAGE/new.app" >> "${'$'}LOG" 2>&1 || fail
            |codesign --verify --deep --strict "${'$'}STAGE/new.app" >> "${'$'}LOG" 2>&1 || fail
            |spctl --assess --type execute "${'$'}STAGE/new.app" >> "${'$'}LOG" 2>&1 || fail
            |mv "${'$'}CURRENT" "${'$'}STAGE/previous.app" || fail
            |if ! mv "${'$'}STAGE/new.app" "${'$'}CURRENT"; then
            |  mv "${'$'}STAGE/previous.app" "${'$'}CURRENT"
            |  fail
            |fi
            |# Preserve quarantine; macOS remains responsible for launch approval.
            |rm -rf "${'$'}STAGE/previous.app"
            |hdiutil detach "${'$'}MOUNT" -quiet >/dev/null 2>&1 || true
            |if [ "${'$'}RELAUNCH" = 1 ]; then open "${'$'}CURRENT"; fi
            |echo "Update completed." >> "${'$'}LOG"
        """.trimMargin()
        val file = File.createTempFile("bywave-update-", ".sh")
        file.writeText(script)
        file.setExecutable(true)
        return file
    }
}
