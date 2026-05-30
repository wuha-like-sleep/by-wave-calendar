// Hand-maintained build metadata. We don't auto-generate it from
// Gradle (the Android-style BuildConfig generator isn't available on
// plain Kotlin/JVM Compose Desktop targets), so this file is the
// source of truth. Bump both fields on every release; VERSION_CODE
// is a monotonically increasing integer the in-app updater uses to
// decide "is the manifest newer than what I'm running."
//
// Keep in sync with build.gradle.kts → version + packageVersion. If
// the two drift, the updater might either spam users with a non-update
// or silently skip a real one.

package cn.bywave.calendar.desktop

object BuildInfo {
    const val VERSION_NAME = "0.8.2"
    const val VERSION_CODE = 16
}
