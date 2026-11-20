package dev.flutterintercept

import com.google.gson.JsonParser
import dev.flutterintercept.sidecar.RpcException
import dev.flutterintercept.ui.Collections
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** CONTRACTS §21.6 / §21.11: what the plugin accepts from the sidecar for "Mock from a collection…". */
class CollectionRequestsTest {
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
    fun chooserDescriptorFiltersCollectionExtensions() {
        val d = Collections.chooserDescriptor()
        assertTrue(d.isChooseFiles)
        assertFalse(d.isChooseFolders)
        assertFalse(d.isChooseMultiple)
        assertEquals("Mock from a Collection", d.title)
        assertNotNull(d.extensionFilter)
        assertTrue(d.description.contains(".json"))
        assertTrue(d.description.contains(".yaml"))
    }

    @Test
    fun pathValidationRefusesRelativeAndControlCharsWithoutEchoingPath() {
        assertNull(Collections.pathProblem("/tmp/shop.postman_collection.json"))
        for (bad in listOf("", "relative/shop.json", "/a\nb.json", "/a\u0000b.json", "/" + "a".repeat(4096))) {
            assertNotNull(bad, Collections.pathProblem(bad))
        }
        assertFalse(Collections.pathProblem("/secret-folder/a\nb.json")!!.contains("secret-folder"))
        assertEquals("/tmp/project", Collections.defaultDir(obj("""{"defaultDir":"/tmp/project"}""")))
        assertNull(Collections.defaultDir(obj("""{"defaultDir":"relative/dir"}""")))
        assertNull(Collections.defaultDir(obj("""{}""")))
    }

    @Test
    fun copyRequestRequiresPlainBasenameAndMapsButtons() {
        assertEquals("shop.postman_collection.json", Collections.copyRequest(obj("""{"fileName":" shop.postman_collection.json "}""")))
        for (bad in listOf(
            """{}""",
            """{"fileName":""}""",
            """{"fileName":"a/b.json"}""",
            """{"fileName":"a\\b.json"}""",
            """{"fileName":"a\nb.json"}""",
            """{"fileName":"${"x".repeat(201)}"}""",
        )) {
            refused { Collections.copyRequest(obj(bad)) }
        }
        assertEquals("sanitised", Collections.copyChoiceResult(Collections.COPY_SANITISED_BUTTON))
        assertEquals("as-is", Collections.copyChoiceResult(Collections.COPY_AS_IS_BUTTON))
        assertNull(Collections.copyChoiceResult(null))
        assertNull(Collections.copyChoiceResult("Cancel"))
        // Plain-text wording: never starts with <html> even for a crafted filename.
        assertFalse(Collections.copyMessage("<html><b>bad</b>").startsWith("<html", ignoreCase = true))
        assertTrue(Collections.COPY_DETAIL.contains("Without credentials"))
    }

    @Test
    fun variableRequestValidatesNameFiltersOriginsAndChecksUrls() {
        val (name, origins) = Collections.variableRequest(
            obj("""{"name":"baseUrl","origins":["https://api.shop.example","https://api.shop.example","http://localhost:8080","ftp://bad","<html>evil","not a url"]}"""),
        )
        assertEquals("baseUrl", name)
        assertEquals(listOf("https://api.shop.example", "http://localhost:8080"), origins)

        assertEquals("host_1" to emptyList<String>(), Collections.variableRequest(obj("""{"name":"host_1"}""")))
        refused { Collections.variableRequest(obj("""{}""")) }
        refused { Collections.variableRequest(obj("""{"name":"bad name"}""")) }
        refused { Collections.variableRequest(obj("""{"name":"<html>"}""")) }
        refused { Collections.variableRequest(obj("""{"name":"baseUrl","origins":"https://a.example"}""")) }

        assertTrue(Collections.isValidVariableUrl("https://api.shop.example"))
        assertTrue(Collections.isValidVariableUrl(" http://127.0.0.1:8080/v1 "))
        for (bad in listOf(null, "", "ftp://a.example", "api.shop.example", "https://a.example\nfoo", "https://" + "a".repeat(2050))) {
            assertFalse(bad.toString(), Collections.isValidVariableUrl(bad))
        }
        assertFalse(Collections.variablePrompt("baseUrl", true).startsWith("<html", ignoreCase = true))
        assertFalse(Collections.variablePrompt("baseUrl", false).startsWith("<html", ignoreCase = true))
    }

    @Test
    fun removeRequestValidatesFieldsAndMatchesVsCodeText() {
        assertEquals(
            "Shop API" to "api/shop.postman_collection.json",
            Collections.removeRequest(obj("""{"name":" Shop API ","file":" api/shop.postman_collection.json "}""")),
        )
        for (bad in listOf(
            """{}""",
            """{"name":"","file":"a.json"}""",
            """{"name":"Shop","file":""}""",
            """{"name":"a\nb","file":"a.json"}""",
            """{"name":"Shop","file":"a\nb.json"}""",
            """{"name":"${"x".repeat(201)}","file":"a.json"}""",
            """{"name":"Shop","file":"${"x".repeat(501)}"}""",
        )) {
            refused { Collections.removeRequest(obj(bad)) }
        }
        assertEquals("Stop mocking from \"Shop API\"?", Collections.removeMessage("Shop API"))
        assertEquals(
            "The link is removed from .vscode/flutter-intercept.json for everyone who uses it. api/shop.json itself is kept.",
            Collections.removeDetail("api/shop.json"),
        )
        assertEquals("Remove", Collections.REMOVE_BUTTON)
    }
}
