// Flutter Intercept for Android Studio / IntelliJ IDEA (CONTRACTS §15).
// Build: JAVA_HOME=<JDK 25+, e.g. Android Studio's bundled JBR> ./gradlew buildPlugin
// The sidecar must be built first: `npm run build -w @flutter-intercept/sidecar` (repo root).
import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.4.21"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "dev.flutterintercept"
version = providers.gradleProperty("pluginVersion").get()

val platformLocalPath = providers.gradleProperty("platformLocalPath").get()
val asPluginsDir = File(System.getProperty("user.home"), "Library/Application Support/Google/AndroidStudio2026.2.1/plugins")

/** A local plugin folder: the property when set, else the Android Studio config's plugins folder, else null. */
fun localPluginDir(property: String, folder: String): File? {
    val configured = providers.gradleProperty(property).orNull?.trim().orEmpty()
    val dir = if (configured.isNotEmpty()) File(configured) else File(asPluginsDir, folder)
    return dir.takeIf { it.isDirectory }
}

val flutterPluginDir = localPluginDir("flutterPluginPath", "flutter-intellij")
val dartPluginDir = localPluginDir("dartPluginPath", "Dart")

/** Where the sidecar bundle (`sidecar.js` + `webview/`) is built by `npm run build -w @flutter-intercept/sidecar`. */
val sidecarDist = layout.projectDirectory.dir("../sidecar/dist")
val skipSidecar = providers.gradleProperty("skipSidecar").map { it.toBoolean() }.getOrElse(false)

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_25)
        freeCompilerArgs.add("-Xjdk-release=25")
        jvmDefault.set(org.jetbrains.kotlin.gradle.dsl.JvmDefaultMode.NO_COMPATIBILITY)
    }
}

java {
    sourceCompatibility = JavaVersion.VERSION_25
    targetCompatibility = JavaVersion.VERSION_25
}

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        local(platformLocalPath)
        if (flutterPluginDir != null) localPlugin(flutterPluginDir.absolutePath)
        else plugin("io.flutter", providers.gradleProperty("flutterPluginVersion").get())
        if (dartPluginDir != null) localPlugin(dartPluginDir.absolutePath)
        else plugin("Dart", providers.gradleProperty("dartPluginVersion").get())
        testFramework(TestFrameworkType.Platform)
    }
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.opentest4j:opentest4j:1.3.0")
}

intellijPlatform {
    buildSearchableOptions = false
    pluginConfiguration {
        id = "dev.flutterintercept"
        name = "Flutter Intercept"
        version = project.version.toString()
        ideaVersion {
            sinceBuild = providers.gradleProperty("pluginSinceBuild")
            untilBuild = provider { null }
        }
    }
    pluginVerification {
        ides {
            local(platformLocalPath)
        }
    }
}

val checkSidecar = tasks.register("checkSidecar") {
    description = "Fails clearly when the sidecar bundle hasn't been built."
    val sidecarJs = sidecarDist.file("sidecar.js").asFile
    val skip = skipSidecar
    doLast {
        if (!skip && !sidecarJs.isFile) {
            throw GradleException(
                "The sidecar bundle is missing: ${sidecarJs.absolutePath}\n" +
                    "Build it first from the repository root: npm run build -w @flutter-intercept/sidecar\n" +
                    "(or pass -PskipSidecar=true for a plugin without it, e.g. to use -Dflutter.intercept.sidecar=<path>)",
            )
        }
    }
}

tasks {
    prepareSandbox {
        dependsOn(checkSidecar)
        // Ships as <plugin>/sidecar/sidecar.js and <plugin>/sidecar/webview/* (CONTRACTS §15.3).
        from(sidecarDist) {
            into(pluginName.map { "$it/sidecar" })
            exclude("**/*.map")
        }
    }

    runIde {
        // Dev fallback: when the sandbox has no bundled sidecar, the plugin uses the repo's build.
        jvmArgumentProviders.add(CommandLineArgumentProvider {
            listOf("-Dflutter.intercept.sidecar=${sidecarDist.file("sidecar.js").asFile.absolutePath}")
        })
    }

    test {
        useJUnit()
    }
}
