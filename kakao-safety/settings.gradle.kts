pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // 카카오모빌리티's own repositories: the 내비 SDK, its location library, and the Kakao SDK it leans on.
        maven("https://devrepo.kakaomobility.com/repository/kakao-mobility-android-knsdk-public/") { content { includeGroup("com.kakaomobility.knsdk") } }
        maven("https://devrepo.kakaomobility.com/repository/kakao-mobility-android-locationsdk-release/") { content { includeGroup("com.kakaomobility.location.library") } }
        maven("https://devrepo.kakao.com/nexus/content/groups/public/") { content { includeGroup("com.kakao.sdk") } }
    }
}
rootProject.name = "KakaoSafety"
include(":app")
