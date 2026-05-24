// Project-level settings for the ByWave Calendar Android app.
// Single :app module today; if we later split data/network into their
// own modules we add them here. The TOML version catalog under
// gradle/libs.versions.toml centralizes dependency versions so we don't
// chase mismatches between modules.

pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "ByWaveCalendar"
include(":app")
