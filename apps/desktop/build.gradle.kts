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
// macOS pkgbuild + Win MSI both require MAJOR ≥ 1 in their native
// installer version metadata, even if our marketing version is < 1.
// We keep installer `version` ≥ 1.0.0 (set on packageVersion below),
// and surface the real marketing version via BuildInfo.VERSION_NAME.
// The integer BuildInfo.VERSION_CODE is what the in-app updater
// compares — keep it in lockstep with apps/desktop/releases/latest.json.
// VERSION_NAME below must equal BuildInfo.VERSION_NAME, and the manifest's
// versionCode must equal BuildInfo.VERSION_CODE (currently 18). Never let
// the marketing line (this `version`) and the updater's versionCode track
// diverge — that's what caused the "已是最新版本" misreport pre-1.0.13.
version = "1.0.13"

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
            packageVersion = "1.0.0"  // installer version — must be ≥ 1.0
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
