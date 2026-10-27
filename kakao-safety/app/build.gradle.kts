plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "kr.webnavi.kakaosafety"
    compileSdk = 35
    defaultConfig {
        // The package and the signing key's hash are what the Kakao app registers (카카오 디벨로퍼스 → 플랫폼 → Android).
        applicationId = "kr.webnavi.kakaosafety"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }
    signingConfigs {
        create("release") {
            storeFile = rootProject.file("signing/kakaosafety.keystore")
            storePassword = System.getenv("KS_PASS") ?: "webnavi"
            keyAlias = "kakaosafety"
            keyPassword = System.getenv("KS_PASS") ?: "webnavi"
        }
    }
    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("com.kakaomobility.knsdk:knsdk_ui:1.12.8-hotfix02")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
    implementation("androidx.core:core-ktx:1.13.1")
    // The SDK's own screens use these without declaring them.
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
}
