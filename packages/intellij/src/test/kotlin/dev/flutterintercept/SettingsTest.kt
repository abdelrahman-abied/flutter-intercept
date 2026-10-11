package dev.flutterintercept

import com.google.gson.JsonObject
import com.intellij.util.xmlb.XmlSerializer
import dev.flutterintercept.settings.ClientCertificateEntry
import dev.flutterintercept.settings.ClientCertificates
import dev.flutterintercept.settings.IdeHttpProxy
import dev.flutterintercept.settings.InterceptSettingsState
import dev.flutterintercept.sidecar.JsonLineRpc
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SettingsTest {
    private fun sample() = InterceptSettingsState().apply {
        enabled = false
        port = 9001
        nativeClients = "proxy"
        upstreamProxy = " http://127.0.0.1:8888 "
        tlsPassthrough = mutableListOf("*.bank.example", " ", "*.bank.example", "pinned.example")
        clientCertificates = mutableListOf(
            ClientCertificateEntry().also { it.host = "api.example"; it.pfx = "/certs/client.p12" },
            ClientCertificateEntry().also { it.host = "*.corp.example"; it.cert = "/c.pem"; it.key = "/k.pem" },
        )
        agentAccess = "readOnly"
        agentMcpPort = 50000
        nodePath = "/opt/homebrew/bin/node"
    }

    @Test
    fun roundTripsThroughXml() {
        val s = sample()
        val element = XmlSerializer.serialize(s)
        val back = XmlSerializer.deserialize(element, InterceptSettingsState::class.java)
        assertEquals(s.toSidecarSettings(null), back.toSidecarSettings(null))
        assertEquals("/opt/homebrew/bin/node", back.nodePath)
        assertEquals(2, back.clientCertificates.size)
        assertEquals("/k.pem", back.clientCertificates[1].key)
        assertEquals(s, back)
    }

    @Test
    fun defaultsMatchTheVsCodeExtension() {
        val m = InterceptSettingsState().toSidecarSettings(null)
        assertEquals(true, m["enabled"])
        assertEquals(8899, m["port"])
        assertEquals("profile", m["nativeClients"])
        assertEquals("intercept", m["backgroundIsolates"])
        assertEquals("errors", m["notifications"])
        assertEquals(mapOf("access" to "readWrite", "redactSecrets" to true, "screenshots" to true, "mcpPort" to 47823), m["agent"])
        assertFalse(m.containsKey("upstreamProxy"))
        assertFalse(m.containsKey("ideHttpProxy"))
    }

    @Test
    fun sidecarJsonHasExactlyTheTypesTsKeys() {
        val json = JsonLineRpc.GSON.toJsonTree(sample().toSidecarSettings(IdeHttpProxy("http://proxy.corp:3128", listOf("localhost")))).asJsonObject
        assertEquals(
            setOf("enabled", "port", "captureSource", "webEnabled", "nativeClients", "backgroundIsolates", "notifications", "contractCheck",
                "rewriteLocalhost", "upstreamProxy", "upstreamProxyIgnoreCertErrors", "tlsPassthrough", "clientCertificates", "agent", "ideHttpProxy"),
            json.keySet(),
        )
        assertEquals("http://127.0.0.1:8888", json.get("upstreamProxy").asString)
        assertEquals(listOf("*.bank.example", "pinned.example"), json.getAsJsonArray("tlsPassthrough").map { it.asString })
        val certs = json.getAsJsonArray("clientCertificates")
        assertEquals(setOf("host", "pfx"), (certs[0] as JsonObject).keySet())
        assertEquals(setOf("host", "cert", "key"), (certs[1] as JsonObject).keySet())
        assertEquals(setOf("access", "redactSecrets", "screenshots", "mcpPort"), json.getAsJsonObject("agent").keySet())
        assertEquals("http://proxy.corp:3128", json.getAsJsonObject("ideHttpProxy").get("url").asString)
        assertFalse("nodePath is plugin-only", json.has("nodePath"))
    }

    @Test
    fun invalidValuesAreNormalized() {
        val m = InterceptSettingsState().apply { nativeClients = "bogus"; agentAccess = "admin"; port = 70000; notifications = "" }.toSidecarSettings(null)
        assertEquals("profile", m["nativeClients"])
        assertEquals("errors", m["notifications"])
        assertEquals(65535, m["port"])
        @Suppress("UNCHECKED_CAST")
        assertEquals("readWrite", (m["agent"] as Map<String, Any>)["access"])
    }

    @Test
    fun copyIsDeep() {
        val s = sample()
        val c = s.copy()
        c.tlsPassthrough.add("x")
        c.clientCertificates[0].host = "changed"
        assertEquals(4, s.tlsPassthrough.size)
        assertEquals("api.example", s.clientCertificates[0].host)
    }

    @Test
    fun passphraseChangeIsStoredThenSettingsAreResent() {
        val calls = mutableListOf<String>()
        ClientCertificates.applyPassphrase("api.example", "pw", store = { h, p -> calls += "store $h ${p != null}" }, resend = { calls += "resend" })
        ClientCertificates.applyPassphrase("api.example", "", store = { h, p -> calls += "store $h ${!p.isNullOrEmpty()}" }, resend = { calls += "resend" })
        assertEquals(listOf("store api.example true", "resend", "store api.example false", "resend"), calls)
    }

    @Test
    fun clientCertificateLines() {
        val (entries, bad) = ClientCertificates.parse(
            """
            # comment
            api.example = /certs/client.p12
            *.corp.example = /c.pem, /k.pem

            broken line
            x = a, b, c
            = /nohost.p12
            """.trimIndent(),
        )
        assertEquals(listOf(5, 6, 7), bad)
        assertEquals(2, entries.size)
        assertEquals("/certs/client.p12", entries[0].pfx)
        assertEquals("/k.pem", entries[1].key)
        assertEquals("api.example = /certs/client.p12\n*.corp.example = /c.pem, /k.pem", ClientCertificates.format(entries))
        assertEquals("flutterIntercept.clientCertificatePassphrase:api.example", ClientCertificates.passphraseKey(" API.example "))
        assertTrue(ClientCertificates.parse(ClientCertificates.format(entries)).second.isEmpty())
    }
}
