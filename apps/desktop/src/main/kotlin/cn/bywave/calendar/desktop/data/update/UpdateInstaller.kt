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
        if (!os.contains("mac") && !os.contains("darwin")) {
            // Win/Linux: defer to Desktop.open(). Windows MSI handles
            // its own upgrade via msiexec; .deb is dpkg territory.
            runCatching { Desktop.getDesktop().open(dmgFile) }
            _state.value = InstallState.FallbackOpenedInFinder("非 macOS 平台 — 用系统默认安装程序打开")
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
        if (!os.contains("mac") && !os.contains("darwin")) {
            runCatching { Desktop.getDesktop().open(dmgFile) }
            _state.value = InstallState.FallbackOpenedInFinder("非 macOS 平台 — 用系统默认安装程序打开")
            return
        }
        _staged.value = dmgFile
        registerShutdownHook()
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
            val f = _staged.value
            if (f != null) {
                runCatching { spawnSwapScript(f, relaunch = false, openFinderOnError = false) }
            }
        })
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
            _state.value = InstallState.FallbackOpenedInFinder("DMG 挂载失败 —— Finder 已打开供手动安装")
            return false
        }
        val newAppInDmg = File(mountPoint, "ByWaveCalendar.app")
        if (!newAppInDmg.exists()) {
            if (openFinderOnError) runCatching { Desktop.getDesktop().open(File(mountPoint)) }
            _state.value = InstallState.FallbackOpenedInFinder("DMG 内未找到 ByWaveCalendar.app —— 请检查挂载后的卷")
            return false
        }
        val currentAppPath = locateCurrentAppPath()
        if (currentAppPath == null) {
            if (openFinderOnError) runCatching { Desktop.getDesktop().open(File(mountPoint)) }
            _state.value = InstallState.FallbackOpenedInFinder(
                "无法定位当前 APP 安装位置 —— 请从挂载的 DMG 拖到「应用程序」"
            )
            return false
        }
        val parent = File(currentAppPath).parentFile
        if (parent == null || !parent.canWrite()) {
            if (openFinderOnError) runCatching { Desktop.getDesktop().open(File(mountPoint)) }
            _state.value = InstallState.FallbackOpenedInFinder(
                "没有 ${parent?.absolutePath ?: "当前 APP 目录"} 的写权限 —— 请从挂载的 DMG 拖到「应用程序」"
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
            _state.value = InstallState.Failed("无法启动安装脚本：${e.message ?: e::class.simpleName}")
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

    /** Write the swap script to /tmp + chmod +x. Returns the script file
     *  so the caller can spawn it.
     *
     *  [relaunch]: when true (the「立即重启」path) the script ends with
     *  `open "$currentAppPath"` to relaunch the freshly-swapped app. When
     *  false (apply-on-quit) we OMIT that line — the user quit, so leave
     *  the app closed; their next launch picks up the new version.
     *
     *  [openFinderOnError]: when true, an in-script abort (signature
     *  verify fail / copy fail) does `open "$mountPoint"` so the user can
     *  install manually. When false (quit-triggered swap) we don't pop a
     *  Finder window over a user who just quit — we only log the failure.
     *  Either way the old app was already removed by then, so a failed
     *  copy leaves them to reinstall, but at least without a surprise
     *  Finder popup after quit. */
    private fun writeSwapScript(
        mountPoint: String,
        newAppPath: String,
        currentAppPath: String,
        relaunch: Boolean,
    ): File {
        // On an in-script abort: open the DMG in Finder for manual
        // install (interactive path), or just log it (quit path).
        val onErrorOpen =
            if (relaunch) """open "$mountPoint""""
            else """echo "[$(date)] not opening Finder (quit-triggered swap)" >> "${'$'}LOG""""
        // Relaunch only when applying interactively. On quit we leave the
        // app closed so the user's next launch runs the new version.
        val relaunchBlock =
            if (relaunch) {
                """
                    |# Relaunch the new .app
                    |echo "[$(date)] launching new .app" >> "${'$'}LOG"
                    |open "$currentAppPath"
                    |""".trimMargin()
            } else {
                """
                    |# Quit-triggered swap: NOT relaunching (user quit the app).
                    |echo "[$(date)] swap done, leaving app closed (quit path)" >> "${'$'}LOG"
                    |""".trimMargin()
            }
        // Heavy commenting in the script so /tmp/bywave-update.log
        // shows what step failed if the user reports an issue.
        val script = """
            |#!/bin/bash
            |set +e
            |LOG=/tmp/bywave-update.log
            |echo "[$(date)] update start" >> "${'$'}LOG"
            |echo "  mount: $mountPoint" >> "${'$'}LOG"
            |echo "  from:  $newAppPath" >> "${'$'}LOG"
            |echo "  to:    $currentAppPath" >> "${'$'}LOG"
            |
            |# Wait for the parent JVM to fully release file descriptors
            |# on the existing .app. 2s is conservative — JDK shutdown
            |# hooks generally take well under a second.
            |sleep 2
            |
            |# SECURITY: verify the new .app's code signature BEFORE we
            |# overwrite the running app + strip its quarantine attr. The
            |# in-app updater already verified the DMG's sha256 against the
            |# (HTTPS-fetched) manifest, but that only proves "this is the
            |# bytes the manifest pointed at" — if the manifest source were
            |# ever compromised, sha256 would still self-match. codesign
            |# --verify independently confirms the .app carries an intact
            |# Apple Developer ID signature. We strip com.apple.quarantine
            |# below (so Gatekeeper won't re-check on launch), so this is the
            |# last line of defense. If it fails, abort the swap and open the
            |# DMG for manual install rather than installing an unverified app.
            |echo "[$(date)] verifying code signature of new .app" >> "${'$'}LOG"
            |if ! codesign --verify --deep --strict "$newAppPath" >> "${'$'}LOG" 2>&1; then
            |  echo "[$(date)] SIGNATURE VERIFY FAILED — refusing to install" >> "${'$'}LOG"
            |  $onErrorOpen
            |  exit 1
            |fi
            |
            |# Belt-and-suspenders: kill any straggler ByWave process.
            |pkill -f "ByWaveCalendar" >> "${'$'}LOG" 2>&1
            |sleep 1
            |
            |# Swap the .app
            |echo "[$(date)] removing old .app" >> "${'$'}LOG"
            |rm -rf "$currentAppPath"
            |
            |echo "[$(date)] copying new .app from DMG (ditto)" >> "${'$'}LOG"
            |# ditto, not `cp -R`: it's Apple's recommended tool for copying
            |# signed .app bundles. cp -R can mangle extended attributes /
            |# ACLs / resource forks in edge cases, which silently corrupts
            |# the code signature; ditto preserves them faithfully so the
            |# copy stays byte-for-byte Gatekeeper-valid.
            |ditto "$newAppPath" "$currentAppPath"
            |COPY_EXIT=${'$'}?
            |
            |if [ ${'$'}COPY_EXIT -ne 0 ]; then
            |  echo "[$(date)] copy failed (exit ${'$'}COPY_EXIT) — leaving DMG mounted for manual install" >> "${'$'}LOG"
            |  $onErrorOpen
            |  exit 1
            |fi
            |
            |# Strip macOS quarantine attr so Gatekeeper doesn't re-prompt
            |# on first launch. The .app is already Developer-ID-signed +
            |# notarized + stapled, but downloaded files get the attr
            |# regardless.
            |xattr -dr com.apple.quarantine "$currentAppPath" >/dev/null 2>&1 || true
            |
            |# Re-verify the COPIED app before relaunching. We verified the
            |# source on the DMG above, but a copy can still go wrong (disk
            |# full, interrupted ditto). Since we already removed the old
            |# app, the worst case is no app at all — so if the copy doesn't
            |# verify, don't launch a broken/unsigned binary; open the DMG so
            |# the user can finish the install by hand.
            |if ! codesign --verify --deep --strict "$currentAppPath" >> "${'$'}LOG" 2>&1; then
            |  echo "[$(date)] COPIED APP FAILED VERIFY — leaving for manual install" >> "${'$'}LOG"
            |  $onErrorOpen
            |  exit 1
            |fi
            |
            |# Eject the DMG. Quiet — failure here doesn't matter (user
            |# can manually eject later from Finder).
            |hdiutil detach "$mountPoint" -quiet >/dev/null 2>&1 || true
            |
            |$relaunchBlock
            |
            |echo "[$(date)] update done" >> "${'$'}LOG"
        """.trimMargin()
        val file = File.createTempFile("bywave-update-", ".sh")
        file.writeText(script)
        file.setExecutable(true)
        return file
    }
}
