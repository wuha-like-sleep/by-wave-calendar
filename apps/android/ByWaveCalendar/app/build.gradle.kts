// :app module. Single-module project for now (everything in cn.bywave.calendar).
// If/when we split a :data module out, the network + Room layers should
// move there and :app would depend on it.

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.ksp)
}

android {
    namespace = "cn.bywave.calendar"
    compileSdk = 34

    defaultConfig {
        applicationId = "cn.bywave.calendar"
        minSdk = 26          // Android 8.0 — covers ~95% of devices in 2026.
        targetSdk = 34
        // versionCode = monotonic counter, must increment for every build
        // we hand out to anyone (even pre-release). versionName = the human
        // string we show in About. We keep these in sync with iOS:
        //   MARKETING_VERSION 1.3.3   ↔   versionName "1.3.3"
        //   CURRENT_PROJECT_VERSION 1 ↔   versionCode 1  (Android starts fresh)
        versionCode = 1
        versionName = "0.1.0"
        // The setup screen URL scheme — server's QR-pair flow sends an
        // intent back to the APP via this scheme. iOS counterpart uses
        // `bywave://` too, so the server only needs one redirect target.
        manifestPlaceholders["appAuthRedirectScheme"] = "bywave"
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false  // start with R8 off — toggle on once we
                                      // see real APK size pressure + verify
                                      // Compose/Retrofit/Serialization rules
                                      // are tight enough not to strip too much.
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
        getByName("debug") {
            applicationIdSuffix = ".debug"
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            // ML Kit + Room can pull in duplicate META-INF/.kotlin_module
            // files; exclude common offenders to keep the APK lean.
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
            excludes += "META-INF/*.kotlin_module"
        }
    }

    sourceSets {
        named("main") {
            // We use `kotlin/` instead of the default `java/` source root.
            // Android Studio handles both, but spelling it out keeps
            // `gradle compileKotlin` honest if someone drops Java code in.
            java.srcDirs("src/main/kotlin")
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.navigation.compose)

    // Compose (versions managed via the BOM so we don't list each here).
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material3.window)
    implementation(libs.compose.material.icons.extended)
    debugImplementation(libs.compose.ui.tooling)

    // Coroutines + serialization
    implementation(libs.kotlinx.coroutines.core)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)

    // Network
    implementation(libs.retrofit)
    implementation(libs.retrofit.kotlinx.serialization)
    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)

    // Persistence
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)
    implementation(libs.androidx.datastore)
    implementation(libs.androidx.security.crypto)

    // Camera + ML Kit (deferred to ScannerScreen, but registered so we
    // don't need a Gradle resync later when wiring up QR scan).
    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.mlkit.barcode.scanning)
}
