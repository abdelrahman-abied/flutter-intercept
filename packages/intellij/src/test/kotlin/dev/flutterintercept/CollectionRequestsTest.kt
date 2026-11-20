package dev.flutterintercept

import com.google.gson.JsonParser
import dev.flutterintercept.sidecar.RpcException
import dev.flutterintercept.ui.Collections
import dev.flutterintercept.ui.PickManyDialog
import dev.flutterintercept.ui.PickManyItem
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

    @Test
    fun pickManyRequestValidatesItemsBoundsAndDefaults() {
        val req = PickManyDialog.parseRequest(
            obj(
                """{
                    "title": "Make a fake backend (1/3)",
                    "placeholder": "Pick servers\nLine 2",
                    "okButton": "Continue",
                    "items": [
                        {"label": "api.shop.example", "description": "12 requests", "value": "https://api.shop.example", "picked": true},
                        {"label": "analytics.google.com", "description": "3 requests · third-party", "value": "https://analytics.google.com", "picked": false},
                        {"label": "plain.example"},
                        {"description": "missing label skipped"}
                    ]
                }""",
            ),
        )
        assertEquals("Make a fake backend (1/3)", req.title)
        assertEquals("Pick servers\nLine 2", req.placeholder)
        assertEquals("Continue", req.okButton)
        assertEquals(
            listOf(
                PickManyItem("api.shop.example", "12 requests", "https://api.shop.example", true),
                PickManyItem("analytics.google.com", "3 requests · third-party", "https://analytics.google.com", false),
                PickManyItem("plain.example", null, "plain.example", false),
            ),
            req.items,
        )
        assertEquals("api.shop.example — 12 requests", PickManyDialog.formatItemText(req.items[0]))
        assertEquals("plain.example", PickManyDialog.formatItemText(req.items[2]))

        // Defaults when optional fields omitted, and control characters sanitized.
        val minimal = PickManyDialog.parseRequest(obj("""{"items":[{"label":"a\nb\tc","value":"https://a.example\n"}]}"""))
        assertEquals(PickManyDialog.DEFAULT_TITLE, minimal.title)
        assertNull(minimal.placeholder)
        assertEquals(PickManyDialog.DEFAULT_OK_BUTTON, minimal.okButton)
        assertEquals("a b c", minimal.items[0].label)
        assertEquals("a b c", minimal.items[0].value) // control char in value falls back to sanitized label

        // Caps at MAX_ITEMS.
        val many = (1..250).joinToString(",") { """{"label":"h$it.example","value":"https://h$it.example","picked":true}""" }
        assertEquals(PickManyDialog.MAX_ITEMS, PickManyDialog.parseRequest(obj("""{"items":[$many]}""")).items.size)

        // Refuses missing, non-array, empty or all-invalid items.
        for (bad in listOf("""{}""", """{"items":null}""", """{"items":"a"}""", """{"items":[]}""", """{"items":[{"label":"  "}]}""")) {
            refused { PickManyDialog.parseRequest(obj(bad)) }
        }
    }
}
