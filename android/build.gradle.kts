import com.android.build.api.dsl.LibraryExtension
import org.jetbrains.kotlin.gradle.dsl.KotlinAndroidProjectExtension
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion

plugins {
    id("com.android.library") version "9.4.0" apply false
    id("com.vanniktech.maven.publish") version "0.34.0" apply false
}

// Every module is an Android library published to Maven Central as com.unifiedplay.data:<module>
// (group, version and POM in gradle.properties; each module's name and description in its own).
subprojects {
    apply(plugin = "com.android.library")
    apply(plugin = "com.vanniktech.maven.publish")
    extensions.configure<LibraryExtension> {
        namespace = if (name == "core") "com.unifiedplay.data" else "com.unifiedplay.data.$name"
        compileSdk = 36
        defaultConfig { minSdk = 24 }
        compileOptions {
            sourceCompatibility = JavaVersion.VERSION_17
            targetCompatibility = JavaVersion.VERSION_17
        }
    }
    // Apps on Kotlin 2.0 and later can use the libraries: their code, metadata and stdlib stay at 2.0.
    extensions.configure<KotlinAndroidProjectExtension> {
        coreLibrariesVersion = "2.0.21"
        compilerOptions {
            apiVersion.set(KotlinVersion.KOTLIN_2_0)
            languageVersion.set(KotlinVersion.KOTLIN_2_0)
        }
    }
    if (name != "core") dependencies { "api"(project(":core")) }
}
