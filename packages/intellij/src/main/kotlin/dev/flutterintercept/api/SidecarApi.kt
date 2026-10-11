// CONTRACTS §15: what the run integration (agent R) needs from the plugin core (agent K). Lead-owned.
package dev.flutterintercept.api

import com.intellij.openapi.project.Project

/** Mirrors packages/sidecar/src/types.ts `DeviceKind`. */
enum class DeviceKind(val wire: String) {
    ANDROID_EMULATOR("android-emulator"), ANDROID_DEVICE("android-device"), IOS_SIMULATOR("ios-simulator"),
    IOS_DEVICE("ios-device"), MACOS("macos"), LINUX("linux"), WINDOWS("windows"), WEB("web"), OTHER("other"),
}

data class LaunchRequest(
    val launchId: String,
    val projectRoot: String,
    val program: String,
    val deviceId: String?,
    val deviceKind: DeviceKind,
    val flutterMode: String,          // debug | profile | release
    val additionalArgs: List<String>,
)

sealed class LaunchPlan {
    data class Rewrite(val program: String, val additionalArgs: List<String>, val note: String?) : LaunchPlan()
    data class Skip(val reason: String) : LaunchPlan()
}

/** Project service implemented by the core (K); the run integration (R) only uses this. */
interface InterceptSidecar {
    /** True when interception is on and the sidecar runs (starts it lazily). */
    fun isEnabled(): Boolean
    /** Blocking, bounded (≤ 10 s); returns Skip with a reason on any failure — a launch is never blocked by us. */
    fun prepareLaunch(request: LaunchRequest): LaunchPlan
    /** `webLaunchUrl`: Flutter Web app URL when known (screenshots of the right tab). */
    fun sessionStarted(launchId: String, sessionId: String, deviceId: String?, vmServiceUri: String?, webLaunchUrl: String? = null)
    fun sessionEnded(sessionId: String)

    companion object {
        fun getInstance(project: Project): InterceptSidecar = project.getService(InterceptSidecar::class.java)
    }
}
