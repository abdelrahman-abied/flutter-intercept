// Kotlin mirrors of packages/sidecar/src/types.ts (InitResult, the `status` event) and the plugin's topic.
package dev.flutterintercept.sidecar

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.util.messages.Topic

/** types.ts `InitResult`. `toString` never shows the URLs: they carry one-time tokens. */
class InitResult(val uiUrl: String, val mcpUrl: String?, val version: String) {
    override fun toString() = "InitResult(version=$version, mcp=${mcpUrl != null})"
    override fun equals(other: Any?) = other is InitResult && other.uiUrl == uiUrl && other.mcpUrl == mcpUrl && other.version == version
    override fun hashCode() = uiUrl.hashCode()

    /** `http://127.0.0.1:<port>` of [uiUrl] (no path, no token). */
    val uiOrigin: String
        get() = try {
            val u = java.net.URI(uiUrl)
            "${u.scheme}://${u.host}${if (u.port >= 0) ":${u.port}" else ""}"
        } catch (_: Exception) {
            ""
        }

    companion object {
        fun parse(el: JsonElement?): InitResult? {
            val o = el as? JsonObject ?: return null
            val ui = o.str("uiUrl") ?: return null
            return InitResult(ui, o.str("mcpUrl"), o.str("version") ?: "")
        }
    }
}

/** types.ts `status` event data. */
data class SidecarStatus(
    val proxyRunning: Boolean,
    val port: Int?,
    val enabled: Boolean,
    val sessions: Int,
    val paused: Int,
    val lan: Boolean,
) {
    companion object {
        fun parse(el: JsonElement?): SidecarStatus? {
            val o = el as? JsonObject ?: return null
            return SidecarStatus(
                proxyRunning = o.bool("proxyRunning") ?: false,
                port = o.int("port"),
                enabled = o.bool("enabled") ?: return null,
                sessions = o.int("sessions") ?: 0,
                paused = o.int("paused") ?: 0,
                lan = o.bool("lan") ?: false,
            )
        }
    }
}

/** Application-level topic for the sidecar's lifecycle and status (tool windows, status bar). */
interface SidecarListener {
    /** The sidecar (re)started and answered `init` / sent `ready`: (re)load the UI. */
    fun ready(init: InitResult) {}
    fun status(status: SidecarStatus) {}
    /** The sidecar stopped (crash, shutdown, or it couldn't start; [problem] says why when known). */
    fun stopped(problem: String?) {}
    /** The sidecar has the new theme: reload the UI page (its state survives in sessionStorage). */
    fun themeChanged() {}

    companion object {
        val TOPIC: Topic<SidecarListener> = Topic.create("Flutter Intercept sidecar", SidecarListener::class.java)
    }
}

internal fun JsonObject.str(key: String): String? = get(key)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString
internal fun JsonObject.bool(key: String): Boolean? = get(key)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isBoolean }?.asBoolean
internal fun JsonObject.int(key: String): Int? = get(key)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.asInt

/** Masks one-time tokens and bearer secrets in a log line before it reaches idea.log (§15.2). */
fun redactSecrets(line: String): String = line
    .replace(Regex("""([?&](?:t|token)=)[^&\s"']+"""), "$1***")
    .replace(Regex("""(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+"""), "$1***")
    .replace(Regex("""(?i)("?(?:token|authorization|passphrase|password)"?\s*[:=]\s*"?)[^"\s,}]+"""), "$1***")
