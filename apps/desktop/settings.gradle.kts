// Compose Multiplatform Desktop — Mac + Windows + Linux native app
// for ByWave Calendar. Same JetBrains-maintained Compose runtime used
// by IntelliJ + Android Studio (so it ages with the JetBrains stack).
//
// Why not a multiplatform shared module yet:
//   We could share code between Android (apps/android/) and Desktop
//   via a kotlin-multiplatform `shared` module — but the Android code
//   currently uses Room, AndroidX EncryptedSharedPreferences, CameraX,
//   and other Android-only deps. Splitting those out cleanly is its
//   own task (probably v1.1.0+). For v1.0 desktop is a standalone
//   project that talks to the same /api/v1 endpoints via Ktor.

@file:Suppress("UnstableApiUsage")

pluginManagement {
    repositories {
        gradlePluginPortal()
        google()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        maven("https://maven.pkg.jetbrains.space/public/p/compose/dev")
    }
}

rootProject.name = "ByWaveCalendar-Desktop"
