// Top-level build file. Module-level config lives in app/build.gradle.kts.
// Plugins are declared with `apply false` here so subprojects can apply
// them by id without re-declaring versions — Gradle's recommended
// pattern with the version catalog.

plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.compose.compiler) apply false
    alias(libs.plugins.ksp) apply false
}
