package dev.flutterintercept

import com.google.gson.JsonParser
import dev.flutterintercept.api.LaunchPlan
import dev.flutterintercept.core.InterceptSidecarImpl
import dev.flutterintercept.core.ProjectRoots
import dev.flutterintercept.sidecar.InitResult
import dev.flutterintercept.sidecar.SidecarStatus
import dev.flutterintercept.sidecar.redactSecrets
import dev.flutterintercept.status.InterceptStatusBarWidget
import dev.flutterintercept.toolwindow.JcefBridge
import dev.flutterintercept.ui.UiRequestHandler
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MiscTest {
    private fun obj(s: String) = JsonParser.parseString(s).asJsonObject

    @Test
    fun parsesLaunchPlans() {
        assertEquals(
            LaunchPlan.Rewrite("/p/.dart_tool/flutter_intercept/main.dart", listOf("--dart-define=FLUTTER_INTERCEPT_PROXY=127.0.0.1:8899"), "note"),
            InterceptSidecarImpl.parsePlan(obj("""{"kind":"rewrite","program":"/p/.dart_tool/flutter_intercept/main.dart","additionalArgs":["--dart-define=FLUTTER_INTERCEPT_PROXY=127.0.0.1:8899"],"note":"note"}""")),
        )
        assertEquals(LaunchPlan.Skip("web-server device"), InterceptSidecarImpl.parsePlan(obj("""{"kind":"skip","reason":"web-server device"}""")))
        assertTrue(InterceptSidecarImpl.parsePlan(obj("""{"kind":"rewrite"}""")) is LaunchPlan.Skip)
        assertTrue(InterceptSidecarImpl.parsePlan(obj("""{"kind":"other"}""")) is LaunchPlan.Skip)
        assertTrue(InterceptSidecarImpl.parsePlan(null) is LaunchPlan.Skip)
    }

    @Test
    fun initResultNeverPrintsItsToken() {
        val r = InitResult.parse(obj("""{"uiUrl":"http://127.0.0.1:51234/?t=SECRET","mcpUrl":"http://127.0.0.1:47823/mcp","version":"0.9.0"}"""))!!
        assertFalse(r.toString().contains("SECRET"))
        assertEquals("http://127.0.0.1:51234", r.uiOrigin)
        assertNull(InitResult.parse(obj("""{"version":"1"}""")))
    }

    @Test
    fun redactsTokensInLogLines() {
        assertEquals("ui at http://127.0.0.1:1/?t=***", redactSecrets("ui at http://127.0.0.1:1/?t=abcDEF_-123"))
        assertEquals("GET /ws?x=1&t=*** 403", redactSecrets("GET /ws?x=1&t=abc 403"))
        assertFalse(redactSecrets("Authorization: Bearer eyJhbGciOi.x.y").contains("eyJhbGciOi"))
        assertEquals("sent Bearer ***", redactSecrets("sent Bearer eyJhbGciOi.x.y"))
        assertFalse(redactSecrets("""{"token":"s3cr3t"}""").contains("s3cr3t"))
        assertEquals("plain line", redactSecrets("plain line"))
    }

    @Test
    fun statusTextAndParsing() {
        val s = SidecarStatus.parse(obj("""{"proxyRunning":true,"port":8899,"enabled":true,"sessions":1,"paused":2}"""))!!
        assertEquals("Intercept: on · 2 paused", InterceptStatusBarWidget.text(s, false))
        assertEquals("Intercept: off", InterceptStatusBarWidget.text(s.copy(enabled = false), true))
        assertEquals("Intercept: on", InterceptStatusBarWidget.text(null, true))
        assertNull(SidecarStatus.parse(obj("""{"paused":1}""")))
    }

    @Test
    fun untitledFileNamesGetALanguageExtension() {
        assertEquals("response.json", UiRequestHandler.fileNameFor("response", "json"))
        assertEquals("model.dart", UiRequestHandler.fileNameFor("model.dart", "dart"))
        assertEquals("curl.sh", UiRequestHandler.fileNameFor("curl", "shellscript"))
        assertEquals("x", UiRequestHandler.fileNameFor("x", "cobol"))
        assertEquals("passwd", UiRequestHandler.fileNameFor("../../etc/passwd", null))
    }

    @Test
    fun saveFiltersAndPickItems() {
        assertEquals(listOf("json", "yaml", "yml"), UiRequestHandler.extensionsOf(obj("""{"OpenAPI":["json","yaml"],"YAML":[".yml","yaml"],"All":["*"]}""")))
        assertEquals(emptyList<String>(), UiRequestHandler.extensionsOf(null))
        val items = UiRequestHandler.parsePickItems(JsonParser.parseString("""[{"label":"A","value":"a"},{"label":"B","description":"d"},{"value":"x"}]""").asJsonArray)
        assertEquals(listOf(UiRequestHandler.PickItem("A", null, "a"), UiRequestHandler.PickItem("B", "d", "B")), items)
    }

    @Test
    fun jcefNavigationStaysOnTheUiOrigin() {
        val o = "http://127.0.0.1:51234"
        assertTrue(JcefBridge.isInternal("$o/?t=x", o))
        assertTrue(JcefBridge.isInternal("$o/assets/app.js", o))
        assertFalse(JcefBridge.isInternal("http://127.0.0.1:512345/", o))
        assertFalse(JcefBridge.isInternal("https://pub.dev/packages/http", o))
        assertTrue(JcefBridge.isInternal("about:blank", o))
    }

    @Test
    fun pubspecRootsComeFirst() {
        assertEquals(listOf("/b", "/a", "/c"), ProjectRoots.orderPubspecFirst(listOf("/a", "/b", "/c")) { it == "/b" })
    }
}
