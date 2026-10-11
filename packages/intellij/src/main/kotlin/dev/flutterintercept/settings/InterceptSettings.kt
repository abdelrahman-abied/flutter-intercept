// CONTRACTS §15.1 / types.ts `SidecarSettings`: user-level (application) settings; the plugin has no project-level
// overrides for routing or agent settings (§15.2).
package dev.flutterintercept.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.util.xmlb.XmlSerializerUtil
import com.intellij.util.xmlb.annotations.Attribute
import com.intellij.util.xmlb.annotations.Tag
import com.intellij.util.xmlb.annotations.XCollection

@Tag("clientCertificate")
class ClientCertificateEntry {
    @Attribute var host: String = ""
    @Attribute var pfx: String? = null
    @Attribute var cert: String? = null
    @Attribute var key: String? = null

    fun copy(): ClientCertificateEntry = ClientCertificateEntry().also { it.host = host; it.pfx = pfx; it.cert = cert; it.key = key }
    override fun equals(other: Any?) = other is ClientCertificateEntry && other.host == host && other.pfx == pfx && other.cert == cert && other.key == key
    override fun hashCode() = listOf(host, pfx, cert, key).hashCode()
}

/** Serialized state. Field defaults are the defaults of the VS Code extension's settings. */
class InterceptSettingsState {
    var enabled: Boolean = true
    var port: Int = 8899
    var captureSource: Boolean = true
    var webEnabled: Boolean = true
    var nativeClients: String = "profile"            // profile | proxy | off
    var backgroundIsolates: String = "intercept"     // intercept | warn
    var notifications: String = "errors"             // errors | all | off
    var contractCheck: Boolean = true
    var rewriteLocalhost: Boolean = true
    var upstreamProxy: String = ""
    var upstreamProxyIgnoreCertErrors: Boolean = false

    @XCollection(style = XCollection.Style.v2, elementName = "host")
    var tlsPassthrough: MutableList<String> = mutableListOf()

    @XCollection(style = XCollection.Style.v2)
    var clientCertificates: MutableList<ClientCertificateEntry> = mutableListOf()

    var agentAccess: String = "readWrite"            // readWrite | readOnly | off
    var agentRedactSecrets: Boolean = true
    var agentScreenshots: Boolean = true
    var agentMcpPort: Int = 47823

    /** Absolute path of the `node` executable; empty = search PATH. Plugin-only (not sent to the sidecar). */
    var nodePath: String = ""

    fun copy(): InterceptSettingsState = InterceptSettingsState().also {
        XmlSerializerUtil.copyBean(this, it)
        it.tlsPassthrough = tlsPassthrough.toMutableList()
        it.clientCertificates = clientCertificates.map(ClientCertificateEntry::copy).toMutableList()
    }

    override fun equals(other: Any?): Boolean = other is InterceptSettingsState && toSidecarSettings(null) == other.toSidecarSettings(null) && nodePath == other.nodePath
    override fun hashCode(): Int = toSidecarSettings(null).hashCode()

    /**
     * The `SidecarSettings` object of types.ts, as JSON-ready maps (absent optional fields are left out). Values the
     * user typed are normalized to what the sidecar accepts.
     */
    fun toSidecarSettings(ideHttpProxy: IdeHttpProxy?): Map<String, Any> {
        val out = linkedMapOf<String, Any>(
            "enabled" to enabled,
            "port" to port.coerceIn(1, 65535),
            "captureSource" to captureSource,
            "webEnabled" to webEnabled,
            "nativeClients" to oneOf(nativeClients, NATIVE_CLIENTS, "profile"),
            "backgroundIsolates" to oneOf(backgroundIsolates, BACKGROUND_ISOLATES, "intercept"),
            "notifications" to oneOf(notifications, NOTIFICATIONS, "errors"),
            "contractCheck" to contractCheck,
            "rewriteLocalhost" to rewriteLocalhost,
        )
        upstreamProxy.trim().takeIf { it.isNotEmpty() }?.let { out["upstreamProxy"] = it }
        out["upstreamProxyIgnoreCertErrors"] = upstreamProxyIgnoreCertErrors
        out["tlsPassthrough"] = tlsPassthrough.map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        out["clientCertificates"] = clientCertificates.filter { it.host.isNotBlank() }.map { c ->
            linkedMapOf<String, Any>("host" to c.host.trim()).also { m ->
                c.pfx?.trim()?.takeIf { it.isNotEmpty() }?.let { m["pfx"] = it }
                c.cert?.trim()?.takeIf { it.isNotEmpty() }?.let { m["cert"] = it }
                c.key?.trim()?.takeIf { it.isNotEmpty() }?.let { m["key"] = it }
            }
        }
        out["agent"] = linkedMapOf(
            "access" to oneOf(agentAccess, AGENT_ACCESS, "readWrite"),
            "redactSecrets" to agentRedactSecrets,
            "screenshots" to agentScreenshots,
            "mcpPort" to agentMcpPort.coerceIn(1, 65535),
        )
        if (ideHttpProxy != null && ideHttpProxy.url != null) {
            out["ideHttpProxy"] = linkedMapOf<String, Any>("url" to ideHttpProxy.url).also { m ->
                if (ideHttpProxy.noProxy.isNotEmpty()) m["noProxy"] = ideHttpProxy.noProxy
            }
        }
        return out
    }

    companion object {
        val NATIVE_CLIENTS = listOf("profile", "proxy", "off")
        val BACKGROUND_ISOLATES = listOf("intercept", "warn")
        val NOTIFICATIONS = listOf("errors", "all", "off")
        val AGENT_ACCESS = listOf("readWrite", "readOnly", "off")
        private fun oneOf(value: String, allowed: List<String>, fallback: String) = if (value in allowed) value else fallback
    }
}

/** types.ts `SidecarSettings.ideHttpProxy`. */
data class IdeHttpProxy(val url: String?, val noProxy: List<String> = emptyList())

/** Topic payload: the settings changed (from the settings page or a status event). */
fun interface InterceptSettingsListener {
    fun settingsChanged(state: InterceptSettingsState)
}

@Service(Service.Level.APP)
@State(name = "FlutterInterceptSettings", storages = [Storage("flutter-intercept.xml")])
class InterceptSettings : PersistentStateComponent<InterceptSettingsState> {
    @Volatile private var state = InterceptSettingsState()

    override fun getState(): InterceptSettingsState = state

    override fun loadState(loaded: InterceptSettingsState) {
        state = loaded.copy()
    }

    /** A copy to edit; apply with [update]. */
    fun snapshot(): InterceptSettingsState = state.copy()

    /** Replaces the settings and tells listeners (the sidecar gets a `settings` request). */
    fun update(newState: InterceptSettingsState) {
        state = newState.copy()
        ApplicationManager.getApplication().messageBus.syncPublisher(TOPIC).settingsChanged(state.copy())
    }

    /**
     * Persists what the user changed in the sidecar's UI (types.ts `settingsChanged`: the on/off switch, a balloon's
     * "Turn off" for notifications, or Toggle's `{enabled}` answer) without echoing it back to the sidecar.
     */
    fun recordFromSidecar(enabled: Boolean?, notifications: String?) {
        val next = state.copy()
        if (enabled != null) next.enabled = enabled
        if (notifications != null && notifications in InterceptSettingsState.NOTIFICATIONS) next.notifications = notifications
        if (next != state) state = next
    }

    companion object {
        val TOPIC = com.intellij.util.messages.Topic.create("Flutter Intercept settings", InterceptSettingsListener::class.java)
        fun getInstance(): InterceptSettings = ApplicationManager.getApplication().getService(InterceptSettings::class.java)
    }
}
