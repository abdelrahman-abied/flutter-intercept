package dev.flutterintercept

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import dev.flutterintercept.settings.ClientCertificateEntry
import dev.flutterintercept.settings.ClientCertificates
import dev.flutterintercept.sidecar.RpcException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** CONTRACTS §20.3: what the plugin accepts from the sidecar for "Add client certificate…". */
class ClientCertificateRequestsTest {
    private fun json(text: String) = JsonParser.parseString(text)
    private fun obj(text: String) = JsonParser.parseString(text).asJsonObject

    private fun refused(block: () -> Unit): RpcException {
        try {
            block()
        } catch (e: RpcException) {
            assertEquals("invalid", e.code)
            return e
        }
        fail("expected a refusal")
        throw AssertionError()
    }

    @Test
    fun hostShapes() {
        for (ok in listOf("api.example.com", "*.corp.example:8443", " API.Example.com ", "192.0.2.10:443", "[2001:db8::1]:8443", "2001:db8::1", "svc_1.example")) {
            assertNull(ok, ClientCertificates.hostProblem(ok))
        }
        for (bad in listOf(null, "", "  ", "a b.example", "a=b.example", "a.example,b.example", "#a.example", "a/b", "x".repeat(261))) {
            assertNotNull(bad.toString(), ClientCertificates.hostProblem(bad))
        }
    }

    @Test
    fun pathsMustBeAbsoluteAndStorable() {
        assertNull(ClientCertificates.pathProblem("/certs/client.p12"))
        assertNull(ClientCertificates.pathProblem("/certs/my client.p12"))
        for (bad in listOf("", "certs/client.p12", "~/client.p12", "/certs/a,b.p12", "/certs/a\nb.p12", "/certs/a\u0000b", " /certs/a.p12", "/" + "a".repeat(4096))) {
            assertNotNull(bad, ClientCertificates.pathProblem(bad))
        }
        // The message never repeats the path.
        assertFalse(ClientCertificates.pathProblem("/secret-folder/a,b.p12")!!.contains("secret-folder"))
    }

    @Test
    fun newEntriesAreChecked() {
        val out = ClientCertificates.entriesFromSidecar(
            json("""[{"host":" api.example.com ","pfx":"/certs/client.p12"},{"host":"*.corp.example:8443","cert":"/c.pem","key":"/k.pem"}]"""),
            emptyList(),
        )
        assertEquals(2, out.size)
        assertEquals("api.example.com", out[0].host)
        assertEquals("/certs/client.p12", out[0].pfx)
        assertNull(out[0].cert)
        assertEquals("/k.pem", out[1].key)
        assertEquals(emptyList<ClientCertificateEntry>(), ClientCertificates.entriesFromSidecar(json("[]"), emptyList()))

        refused { ClientCertificates.entriesFromSidecar(json("""{"host":"a.example"}"""), emptyList()) }
        refused { ClientCertificates.entriesFromSidecar(null, emptyList()) }
        refused { ClientCertificates.entriesFromSidecar(json("""["a.example"]"""), emptyList()) }
        refused { ClientCertificates.entriesFromSidecar(json("""[{"host":"a.example","pfx":"relative/client.p12"}]"""), emptyList()) }
        refused { ClientCertificates.entriesFromSidecar(json("""[{"host":"a.example","pfx":"/a.p12","cert":"/c.pem","key":"/k.pem"}]"""), emptyList()) }
        refused { ClientCertificates.entriesFromSidecar(json("""[{"host":"a.example","cert":"/c.pem"}]"""), emptyList()) }
        refused { ClientCertificates.entriesFromSidecar(json("""[{"host":"a.example"}]"""), emptyList()) }
        refused { ClientCertificates.entriesFromSidecar(json("""[{"host":"a b","pfx":"/a.p12"}]"""), emptyList()) }
        refused { ClientCertificates.entriesFromSidecar(json("""[{"host":"a.example","pfx":7}]"""), emptyList()) }
        val many = (1..51).joinToString(",", "[", "]") { """{"host":"h$it.example","pfx":"/a.p12"}""" }
        refused { ClientCertificates.entriesFromSidecar(json(many), emptyList()) }
        val e = refused { ClientCertificates.entriesFromSidecar(json("""[{"host":"a.example","pfx":"/private-dir/a,b.p12"}]"""), emptyList()) }
        assertTrue(e.message!!.startsWith("Entry 1:"))
        assertFalse(e.message!!.contains("private-dir"))
    }

    @Test
    fun storedEntriesAreKeptAsTheyAre() {
        // Typed earlier on the settings page with a relative path: re-writing the list (adding another) must not fail on it.
        val stored = listOf(ClientCertificateEntry().also { it.host = "Old.Example"; it.pfx = "certs/old.p12" })
        val out = ClientCertificates.entriesFromSidecar(
            json("""[{"host":"old.example","pfx":"certs/old.p12"},{"host":"new.example","pfx":"/certs/new.p12"}]"""),
            stored,
        )
        assertEquals(listOf("old.example", "new.example"), out.map { it.host })
        // A changed entry is checked again.
        refused { ClientCertificates.entriesFromSidecar(json("""[{"host":"old.example","pfx":"certs/other.p12"}]"""), stored) }
    }

    @Test
    fun passphraseRequests() {
        assertEquals("api.example.com" to "s3cret", ClientCertificates.passphraseRequest(obj("""{"host":" api.example.com ","passphrase":"s3cret"}""")))
        assertEquals("api.example.com" to null, ClientCertificates.passphraseRequest(obj("""{"host":"api.example.com"}""")))
        assertEquals("api.example.com" to null, ClientCertificates.passphraseRequest(obj("""{"host":"api.example.com","passphrase":""}""")))
        refused { ClientCertificates.passphraseRequest(obj("""{"passphrase":"x"}""")) }
        refused { ClientCertificates.passphraseRequest(obj("""{"host":"a=b","passphrase":"x"}""")) }
        refused { ClientCertificates.passphraseRequest(obj("""{"host":"a.example","passphrase":1}""")) }
        val long = JsonObject().apply { addProperty("host", "a.example"); addProperty("passphrase", "p".repeat(4097)) }
        val e = refused { ClientCertificates.passphraseRequest(long) }
        assertFalse(e.message!!.contains("ppp"))
    }

    @Test
    fun chooserPerRoleAllowsAnyFile() {
        for (role in ClientCertificates.ROLES) {
            val d = ClientCertificates.chooserDescriptor(role)
            assertTrue(d.isChooseFiles)
            assertFalse(d.isChooseFolders)
            assertFalse(d.isChooseMultiple)
            assertNull("any file can be picked", d.extensionFilter)
            assertTrue(d.title.isNotBlank())
        }
        assertTrue(ClientCertificates.chooserDescriptor("pfx").description.contains(".p12"))
        assertTrue(ClientCertificates.chooserDescriptor("cert").description.contains(".crt"))
        assertTrue(ClientCertificates.chooserDescriptor("key").description.contains(".key"))
        refused { ClientCertificates.chooserDescriptor("ca") }
    }
}
