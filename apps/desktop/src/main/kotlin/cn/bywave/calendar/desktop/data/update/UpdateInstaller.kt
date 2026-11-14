// Desktop installer handoff. macOS swaps the application bundle after exit;
// Windows waits for this JVM before running MSI upgrade and optional relaunch.
// Linux delegates to the system package handler. A staged update applies on quit.

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

    /** A verified installer that's ready to apply on quit (or via「立即重启」).
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

    /** Apply now, clearing the staged update to prevent duplicate shutdown work.
     * macOS and Windows exit only after the installation helper is ready.
     * Call on a worker thread: preparation performs file and process I/O. */
    @Synchronized
    fun install(dmgFile: File) {
        // Clear staging BEFORE we (potentially) exit: the shutdown hook
        // reads _staged.value, so leaving it set would have the hook
        // re-run the swap on the very exitProcess(0) below.
        _staged.value = null

        val os = System.getProperty("os.name").orEmpty().lowercase()
        // Wait for the Unicode-safe helper to verify the MSI before exiting.
        if (os.contains("win")) {
            _state.value = InstallState.Mounting
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

    /** Stage a verified installer for apply-on-quit on macOS and Windows.
     * Linux opens its package handler immediately. */
    fun stage(dmgFile: File) {
        val os = System.getProperty("os.name").orEmpty().lowercase()
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
     *  Windows helper waits for this process; macOS uses its swap delay. */
    @Synchronized
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

    /** Start a Unicode-safe helper and wait for its readiness before exiting.
     * Windows Installer owns the upgrade; the helper waits for this exact JVM,
     * validates the staged MSI again and handles reboot/cancellation results.
     */
    private fun spawnWindowsUpdateScript(msiFile: File, relaunch: Boolean): Boolean {
        var helper: Process? = null
        var ready: File? = null
        return try {
            require(msiFile.isFile && msiFile.extension.equals("msi", ignoreCase = true))
            val exe = ProcessHandle.current().info().command().orElse(null)
            val systemRoot = System.getenv("SystemRoot") ?: error("Windows system directory unavailable")
            val powershell = File(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe")
            require(powershell.isFile) { "PowerShell unavailable" }
            val directory = java.nio.file.Files.createTempDirectory("bywave-update-").toFile()
            ready = File(directory, "ready")
            val log = File(directory, "update.log")
            val digest = java.security.MessageDigest.getInstance("SHA-256")
            msiFile.inputStream().use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    digest.update(buffer, 0, count)
                }
            }
            val hash = digest.digest().joinToString("") { "%02x".format(it) }
            val encoded = WindowsUpdateScript.encoded(WindowsUpdateScript.build(
                msiFile.absolutePath, exe, ProcessHandle.current().pid(), hash,
                log.absolutePath, ready.absolutePath, relaunch,
            ))
            require(encoded.length < 28_000) { "Installer path exceeds command length limit" }
            helper = ProcessBuilder(powershell.absolutePath, "-NoLogo", "-NoProfile", "-NonInteractive",
                "-WindowStyle", "Hidden", "-EncodedCommand", encoded)
                .redirectErrorStream(true)
                .redirectOutput(File(directory, "helper.log"))
                .start()
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
            while (!ready.isFile && helper.isAlive && System.nanoTime() < deadline) Thread.sleep(50)
            check(ready.isFile) { "Windows update helper did not become ready" }
            true
        } catch (e: Exception) {
            helper?.destroy()
            ready?.delete()
            DebugLog.d("ByWave Updater") { "windows spawn failed: ${e.message}" }
            if (relaunch) runCatching { Desktop.getDesktop().open(msiFile) }
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
