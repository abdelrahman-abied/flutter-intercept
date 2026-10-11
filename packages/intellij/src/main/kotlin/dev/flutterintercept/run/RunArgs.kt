// CONTRACTS §15.1 "Run integration": pure helpers (no IDE state) for patching a Flutter run configuration's launch.
// See docs/spikes/intellij-run.md for why the generated entry is passed as `--target=` instead of replacing the
// configuration's Dart entrypoint.
package dev.flutterintercept.run

import com.intellij.util.execution.ParametersListUtil
import dev.flutterintercept.api.DeviceKind
import java.nio.file.Files
import java.nio.file.Path

object RunArgs {
    /**
     * Same parsing as the Flutter plugin's `SdkFields.getAdditionalArgsParsed()`
     * (`ParametersListUtil.parse(s, false, false, true)` without empty entries).
     */
    fun parse(additionalArgs: String?): List<String> =
        if (additionalArgs.isNullOrBlank()) emptyList()
        else ParametersListUtil.parse(additionalArgs, false, false, true).filter { it.isNotEmpty() }

    /** Inverse of [parse]: quotes arguments that contain spaces or quotes. */
    fun join(args: List<String>): String = ParametersListUtil.join(args)

    /**
     * The `flutter run` target named in [args] (`-t X`, `-tX`, `--target X`, `--target=X`; the last one wins, as in
     * package:args), or null. flutter_tools prefers it over the positional entrypoint the Flutter plugin appends.
     */
    fun targetOf(args: List<String>): String? {
        var target: String? = null
        var i = 0
        while (i < args.size) {
            val a = args[i]
            when {
                a == "-t" || a == "--target" -> { if (i + 1 < args.size) target = args[i + 1]; i++ }
                a.startsWith("--target=") -> target = a.substring("--target=".length)
                a.startsWith("-t") && !a.startsWith("--") && a.length > 2 -> target = a.substring(2)
            }
            i++
        }
        return target
    }

    /** [args] without any target option (see [targetOf]). */
    fun stripTarget(args: List<String>): List<String> {
        val out = ArrayList<String>(args.size)
        var i = 0
        while (i < args.size) {
            val a = args[i]
            when {
                a == "-t" || a == "--target" -> i++ // skip the value too
                a.startsWith("--target=") -> Unit
                a.startsWith("-t") && !a.startsWith("--") && a.length > 2 -> Unit
                else -> out.add(a)
            }
            i++
        }
        return out
    }

    /** [args] with exactly one target: `--target=<target>` (last, so it wins even over a stray user option). */
    fun withTarget(args: List<String>, target: String): List<String> = stripTarget(args) + "--target=$target"

    /** `--target` value for [program]: relative to the app dir (`flutter run`'s working directory) when inside it. */
    fun targetArg(program: Path, appDir: Path): String {
        val p = program.toAbsolutePath().normalize()
        val root = appDir.toAbsolutePath().normalize()
        return if (p.startsWith(root)) root.relativize(p).joinToString("/") else p.toString()
    }

    /** Nearest directory at or above [file] containing `pubspec.yaml` (bounded walk). */
    fun findPubspecRoot(file: Path): Path? {
        var dir: Path? = file.toAbsolutePath().normalize().let { if (Files.isDirectory(it)) it else it.parent }
        var depth = 0
        while (dir != null && depth < 64) {
            if (Files.isRegularFile(dir.resolve("pubspec.yaml"))) return dir
            dir = dir.parent
            depth++
        }
        return null
    }

    /**
     * debug | profile | release for one launch. [launchMode] is the Flutter plugin's `FlutterLaunchMode` name
     * (its Release / Profile actions put it in the environment), [profiling] is true for the "Android Profiler"
     * executor (the plugin then launches with `--profile`), and the user's own `--release` / `--profile` args count too.
     */
    fun flutterMode(launchMode: String?, profiling: Boolean, args: List<String>): String = when {
        launchMode.equals("release", ignoreCase = true) || "--release" in args -> "release"
        launchMode.equals("profile", ignoreCase = true) || profiling || "--profile" in args -> "profile"
        else -> "debug"
    }

    /**
     * Flutter daemon device fields → [DeviceKind]. Measured on the daemon's `device.added` events
     * (docs/spikes/intellij-run.md): `platformType` android / ios / macos / linux / windows / web, `platform`
     * android-arm64 / ios / darwin / linux-x64 / windows-x64 / web-javascript, `emulator` true for emulators and
     * simulators.
     */
    fun deviceKind(deviceId: String?, platform: String?, platformType: String?, emulator: Boolean): DeviceKind {
        val type = platformType?.lowercase().orEmpty()
        val plat = platform?.lowercase().orEmpty()
        return when {
            type == "android" || plat.startsWith("android") ->
                if (emulator || deviceId?.matches(Regex("emulator-\\d+")) == true) DeviceKind.ANDROID_EMULATOR else DeviceKind.ANDROID_DEVICE
            type == "ios" || plat == "ios" -> if (emulator) DeviceKind.IOS_SIMULATOR else DeviceKind.IOS_DEVICE
            type == "macos" || plat == "darwin" || plat.startsWith("darwin") -> DeviceKind.MACOS
            type == "linux" || plat.startsWith("linux") -> DeviceKind.LINUX
            type == "windows" || plat.startsWith("windows") -> DeviceKind.WINDOWS
            type == "web" || plat.startsWith("web") || deviceId == "chrome" || deviceId == "edge" || deviceId == "web-server" -> DeviceKind.WEB
            else -> DeviceKind.OTHER
        }
    }

    /** The additional args for the patched launch: the sidecar's list (it replaces the user's) with our target. */
    fun patchedArgs(sidecarArgs: List<String>, program: Path, originalProgram: Path, appDir: Path): List<String> {
        val same = program.toAbsolutePath().normalize() == originalProgram.toAbsolutePath().normalize()
        // Unchanged program (Flutter Web: browser flags only) keeps whatever target the args already name.
        return if (same) sidecarArgs else withTarget(sidecarArgs, targetArg(program, appDir))
    }
}
