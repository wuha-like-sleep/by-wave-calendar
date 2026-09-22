// Compose Multiplatform Desktop build script. One Gradle invocation
// produces a signed/notarized DMG for macOS or an MSI installer for
// Windows, depending on which host you build on (JetBrains' plugin
// requires native tooling — DMG only builds on Mac, MSI only on Win).
//
// Common commands:
//   ./gradlew packageDmg            # macOS .dmg in build/compose/binaries/
//   ./gradlew packageMsi            # Windows .msi in same dir
//   ./gradlew packageDistributionForCurrentOS  # whatever your host can do
//   ./gradlew runDistributable     # smoke-test the packaged app locally
//   ./gradlew run                   # quick iteration (no packaging)
//
// macOS signing: set the env vars before running packageDmg
//   APPLE_DEVELOPER_ID_APPLICATION  # cert name in Keychain
//   APPLE_NOTARY_KEYCHAIN_PROFILE   # `notarytool store-credentials` profile
// macOS notarization happens automatically when the cert is present.

import org.jetbrains.compose.desktop.application.dsl.TargetFormat

plugins {
    kotlin("jvm") version "2.0.20"
    // kotlinx.serialization plugin codegens .serializer() helpers for
    // @Serializable classes. Without this plugin the @Serializable
    // annotation is purely informational and the helpers don't exist.
    kotlin("plugin.serialization") version "2.0.20"
    id("org.jetbrains.compose") version "1.7.0"
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.20"
}

group = "cn.bywave.calendar.desktop"
// 安装器的版本号就是这里的 `version`,不再单独写死一个。
//
// 以前 nativeDistributions.packageVersion 硬编码成 "1.0.0",结果是
// **Windows 用户从装上第一版起就没收到过任何更新**,而程序每次都告诉他们
// 「更新成功」。原因是 jpackage 的 ProductCode 是从版本号算出来的:
//   ProductCode = UUIDv3( MD5("ProductCode/<vendor>/<appName>/<version>") )
// 版本号钉死 → 每一版的 ProductCode 逐字节相同 → msiexec 认为「同一个产品
// 已经装过了」,既不升级也不并排安装,只能进维护模式;而 Upgrade 表的可升级
// 区间是「严格小于 1.0.0」,装着 1.0.0 的机器正好掉在两行中间的缝里。
// 安装命令没带 REINSTALL=ALL,所以维护模式一个文件都不换,大概率还返回 0 ——
// 于是 UpdateInstaller 走 else 分支写「update ok」,把**旧版** exe 拉起来。
// 用户看到进度条、看到程序重启、以为好了,下次启动又弹同一个更新。
//
// 平台对版本号的真实约束(Compose 1.7.0 的 validatePackageVersions 实测):
//   · Windows:正好 3 段,MAJOR 0-255、MINOR 0-255、BUILD 0-65535。
//     **MAJOR 允许为 0** —— 这里原来的注释写的「Win MSI 要求 MAJOR ≥ 1」是错的。
//   · macOS:1-3 段,全非负整数,**第一段必须 > 0**(这条才是真的)。
//   · Linux deb:([0-9]+:)?[0-9][0-9a-zA-Z.+~-]*
// 也就是说三平台的交集是「第一段 > 0 的三段式」,1.1.1 满足。
// The integer BuildInfo.VERSION_CODE is what the in-app updater
// compares — keep it in lockstep with apps/desktop/releases/latest.json.
// VERSION_NAME below must equal BuildInfo.VERSION_NAME, and the manifest's
// versionCode must equal BuildInfo.VERSION_CODE (currently 24). Never let
// the marketing line (this `version`) and the updater's versionCode track
// diverge — that's what caused the "已是最新版本" misreport pre-1.0.13.
version = "1.1.1"

// Repositories are declared in settings.gradle.kts (RepositoriesMode.
// FAIL_ON_PROJECT_REPOS forces them centralized). Don't re-declare here.

dependencies {
    // Compose Desktop bundle — pulls in Material 3, foundation, runtime
    // from the JetBrains-maintained desktop variant. Compose Multiplatform
    // 1.7+ ships Material 3 by default.
    implementation(compose.desktop.currentOs)
    implementation(compose.material3)
    implementation(compose.materialIconsExtended)

    // Networking — Ktor. Same client paradigm as okhttp on Android but
    // pure-Kotlin Multiplatform so it runs on JVM without Android deps.
    implementation("io.ktor:ktor-client-core:2.3.12")
    implementation("io.ktor:ktor-client-cio:2.3.12")
    implementation("io.ktor:ktor-client-content-negotiation:2.3.12")
    implementation("io.ktor:ktor-serialization-kotlinx-json:2.3.12")

    // Coroutines — same as Android.
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-swing:1.9.0")

    // JSON serialization — same as Android.
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    // QR code generation — desktop displays a QR encoding the
    // approveUrl returned by /devices/desktop-pair-init. zxing-core is
    // pure-Java (no native deps), produces a BufferedImage we paint
    // straight into Compose via toComposeImageBitmap().
    implementation("com.google.zxing:core:3.5.3")
    implementation("com.google.zxing:javase:3.5.3")

    // 单元测试。桌面端以前没有 test source set —— 于是「提醒到底读的是哪一份
    // 数据」「8 种语言的文案齐不齐」这类问题只能靠人肉点，点不到就一直挂着。
    // kotlin("test") 会跟着下面的 useJUnitPlatform() 解析成 JUnit 5 变体。
    testImplementation(kotlin("test"))
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}

tasks.withType<Test>().configureEach {
    useJUnitPlatform()
    testLogging {
        events("passed", "failed", "skipped")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}

kotlin {
    // JDK 21 — what Android Studio ships bundled, so locally we never
    // need to install a separate JDK. Compose Desktop 1.7 supports
    // JDK 17/21; we pick 21 to match the Android dev environment.
    jvmToolchain(21)
}

compose.desktop {
    application {
        mainClass = "cn.bywave.calendar.desktop.MainKt"

        nativeDistributions {
            targetFormats(TargetFormat.Dmg, TargetFormat.Msi, TargetFormat.Deb)
            packageName = "ByWaveCalendar"
            // 不设 packageVersion —— Compose 的回落链是
            //   format-specific → OS-specific → packageVersion → project.version
            // 所以它自动拿上面那个 `version`。**别再写死。**
            // 写死会让每一版的 MSI ProductCode 相同,Windows 的自动更新
            // 从此静默失效(见文件头那段)。
            vendor = "ByWave"
            // ASCII-only for installer-level metadata. WiX 3.11 light.exe
            // (the linker jpackage uses for MSI) exits 311 when
            // description or copyright contain non-ASCII chars —
            // JDK-8333277. Mac DMG / Linux DEB don't care, but to keep
            // one source of truth across platforms we keep this clean.
            // The user-visible APP UI is unaffected (strings live in
            // Kotlin code, not installer metadata).
            description = "ByWave Calendar - self-hosted calendar desktop client"
            copyright = "(c) 2026 ByWave"
            // NOTE: do NOT set licenseFile here. jpackage turns it into a
            // click-through SLA embedded in the .dmg (an LPic/license
            // resource). That SLA makes `hdiutil attach` block / cancel in
            // any non-interactive context — which is exactly how the
            // in-app updater (UpdateInstaller.mountDmg) mounts the
            // downloaded DMG. With an SLA the one-click "download & install
            // → auto-relaunch" flow silently degrades to the Finder
            // fallback (user has to agree + drag manually). The project is
            // open-source (LICENSE is in the repo + the in-app About page),
            // so a DMG SLA buys us nothing and breaks seamless auto-update.

            // App icon for the OS-native installer. Each platform needs
            // a different file format; missing files just fall back to
            // a generic icon (not fatal).
            // - macOS wants .icns (use `iconutil -c icns icon.iconset/`)
            // - Windows wants .ico
            // - Linux wants .png
            // For v0.1 stub: skip icons until we have proper assets.
            macOS {
                bundleID = "cn.bywave.calendar.desktop"
                // Signing — only kicks in if env vars are set. Without
                // them the build still succeeds, just unsigned (Mac
                // users will see "unidentified developer" warning).
                signing {
                    sign.set(System.getenv("APPLE_DEVELOPER_ID_APPLICATION") != null)
                    identity.set(System.getenv("APPLE_DEVELOPER_ID_APPLICATION") ?: "")
                }
                notarization {
                    appleID.set(System.getenv("APPLE_NOTARY_APPLE_ID") ?: "")
                    password.set(System.getenv("APPLE_NOTARY_PASSWORD") ?: "")
                    teamID.set(System.getenv("APPLE_NOTARY_TEAM_ID") ?: "")
                }
                // Hardened runtime + entitlements (required for notarization).
                infoPlist {
                    extraKeysRawXml = """
                        <key>NSCameraUsageDescription</key>
                        <string>扫描二维码登录需要使用相机</string>
                        <key>LSApplicationCategoryType</key>
                        <string>public.app-category.utilities</string>
                    """.trimIndent()
                }
            }
            windows {
                // MSI installer — pulls user into Start menu + Programs.
                // upgradeUuid is REQUIRED for Win to recognize updates;
                // never change it across releases.
                upgradeUuid = "8E2D7C3A-6F4B-4A11-A19D-E2A5C4F9B3E0"
                menuGroup = "ByWave Calendar"
                shortcut = true
                dirChooser = true
            }
            linux {
                packageName = "bywave-calendar"
                debMaintainer = "info@by-wave.com"
                menuGroup = "Utility"
                appCategory = "Office"
            }
        }
    }
}
