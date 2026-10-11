package dev.flutterintercept

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import dev.flutterintercept.core.InterceptSidecarImpl
import dev.flutterintercept.api.LaunchPlan
import dev.flutterintercept.settings.InterceptSettingsState
import dev.flutterintercept.sidecar.InitResult
import dev.flutterintercept.sidecar.JsonLineRpc
import dev.flutterintercept.sidecar.NodeLocator
import dev.flutterintercept.sidecar.NodeLookup
import dev.flutterintercept.sidecar.RpcException
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.nio.file.Files
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * The plugin's RPC client against the real sidecar bundle (packages/sidecar/dist/sidecar.js). Skipped when Node ≥ 18
 * or the bundle is missing. Uses a temporary data dir and project, agent access off and unusual ports.
 */
class SidecarEndToEndTest {
    private val executor = Executors.newCachedThreadPool()
    private val scheduler = Executors.newSingleThreadScheduledExecutor()
    private lateinit var tmp: File
    private var process: Process? = null
    private lateinit var rpc: JsonLineRpc
    private val events = ConcurrentLinkedQueue<String>()
    private val requests = ConcurrentLinkedQueue<String>()

    @Before
    fun setUp() {
        val script = File("../sidecar/dist/sidecar.js").absoluteFile
        assumeTrue("sidecar bundle not built", script.isFile)
        val node = NodeLocator().locate(null, listOf(System.getenv("PATH")))
        assumeTrue("no Node.js 18+", node is NodeLookup.Found)
        tmp = Files.createTempDirectory("fi-e2e").toFile()
        val p = ProcessBuilder((node as NodeLookup.Found).path, script.path).directory(script.parentFile).start()
        process = p
        Thread { p.errorStream.bufferedReader().forEachLine { } }.apply { isDaemon = true }.start()
        rpc = JsonLineRpc(
            p.inputStream, p.outputStream,
            handler = { method, _: JsonElement? ->
                requests += method
                CompletableFuture.completedFuture(null)
            },
            onEvent = { e, _ -> events += e },
            onClose = {},
            executor = executor, scheduler = scheduler,
        ).start()
    }

    @After
    fun tearDown() {
        process?.let {
            if (::rpc.isInitialized) rpc.close()
            if (!it.waitFor(5, TimeUnit.SECONDS)) it.destroyForcibly()
        }
        executor.shutdownNow()
        scheduler.shutdownNow()
        if (::tmp.isInitialized) tmp.deleteRecursively()
    }

    private fun init(): InitResult {
        val app = File(tmp, "app").apply { mkdirs() }
        File(app, "pubspec.yaml").writeText("name: app\nenvironment:\n  sdk: '>=3.0.0 <4.0.0'\ndependencies:\n  flutter:\n    sdk: flutter\n")
        File(app, "lib").mkdirs()
        File(app, "lib/main.dart").writeText("void main() {}\n")
        val settings = InterceptSettingsState().apply { port = 18_899; agentAccess = "off"; agentMcpPort = 18_823 }.toSidecarSettings(null)
        val params = mapOf(
            "dataDir" to File(tmp, "data").apply { mkdirs() }.path,
            "workspaceFolders" to listOf(app.path),
            "settings" to settings,
            "theme" to "dark",
            "ide" to mapOf("name" to "Test", "version" to "0", "pluginVersion" to "0.9.0"),
        )
        return InitResult.parse(rpc.call("init", params, 30_000))!!
    }

    private class Reply(val code: Int, val setCookie: String?, val location: String?)

    /** One request, no redirects followed, optional cookie. */
    private fun fetch(url: String, cookie: String? = null): Reply {
        val c = URI(url).toURL().openConnection() as HttpURLConnection
        c.instanceFollowRedirects = false
        c.connectTimeout = 5_000
        c.readTimeout = 5_000
        cookie?.let { c.setRequestProperty("Cookie", it) }
        return try { Reply(c.responseCode, c.getHeaderField("Set-Cookie"), c.getHeaderField("Location")) } finally { c.disconnect() }
    }

    private fun get(url: String): Int = fetch(url).code

    @Test
    fun initServesTheUiAndAnswersPluginRequests() {
        val init = init()
        assertTrue(init.uiUrl, init.uiUrl.startsWith("http://127.0.0.1:"))
        assertTrue(init.uiUrl.contains("t="))
        assertTrue(get(init.uiUrl) in setOf(200, 302, 303))
        assertEquals(403, get(init.uiOrigin + "/"))

        rpc.call("theme", mapOf("theme" to "light"), 10_000)
        rpc.call("settings", mapOf("settings" to InterceptSettingsState().apply { port = 18_899; agentAccess = "off"; agentMcpPort = 18_823 }.toSidecarSettings(null)), 10_000)
        rpc.call("workspaceFolders", mapOf("workspaceFolders" to listOf(File(tmp, "app").path)), 10_000)
        rpc.call("uiVisible", mapOf("visible" to true), 10_000)
        rpc.call("command", mapOf("name" to "clear"), 10_000)

        val toggled = rpc.call("command", mapOf("name" to "toggle"), 10_000) as JsonObject
        assertFalse(toggled.get("enabled").asBoolean)
        rpc.call("command", mapOf("name" to "toggle"), 10_000)

        val agent = try { rpc.call("connectAgent", mapOf("client" to "claude"), 10_000); null } catch (e: RpcException) { e }
        assertEquals("unavailable", agent?.code)

        val plan = rpc.call("prepareLaunch", mapOf(
            "launchId" to "l1", "projectRoot" to File(tmp, "app").path, "program" to File(tmp, "app/lib/main.dart").path,
            "deviceKind" to "android-emulator", "deviceId" to "emulator-5554", "flutterMode" to "debug", "additionalArgs" to emptyList<String>(),
        ), 10_000) as JsonObject
        val parsed = InterceptSidecarImpl.parsePlan(plan)
        assertTrue("$parsed", parsed is LaunchPlan.Rewrite || parsed is LaunchPlan.Skip)
        if (parsed is LaunchPlan.Rewrite) assertTrue(parsed.additionalArgs.any { it.contains("FLUTTER_INTERCEPT") })

        val release = InterceptSidecarImpl.parsePlan(rpc.call("prepareLaunch", mapOf(
            "launchId" to "l2", "projectRoot" to File(tmp, "app").path, "program" to File(tmp, "app/lib/main.dart").path,
            "deviceKind" to "android-emulator", "flutterMode" to "release", "additionalArgs" to emptyList<String>(),
        ), 10_000) as JsonObject)
        assertTrue(release is LaunchPlan.Skip)
    }

    private fun body(url: String, method: String = "GET"): Pair<Int, String> {
        val c = URI(url).toURL().openConnection() as HttpURLConnection
        c.requestMethod = method
        c.instanceFollowRedirects = false
        c.connectTimeout = 5_000
        c.readTimeout = 5_000
        return try {
            val code = c.responseCode
            assertNull("no session cookie (REVIEW-9 #1)", c.getHeaderField("Set-Cookie"))
            code to (if (code == 200 && method == "GET") c.inputStream.bufferedReader().readText() else "")
        } finally {
            c.disconnect()
        }
    }

    /** CONTRACTS §15.4 / REVIEW-9 #1, #6: one-time page URLs, no cookie, per-page WebSocket secrets. */
    @Test
    fun oneTimeUiUrlServesThePageOnce() {
        val init = init()
        val url = (rpc.call("uiUrl", null, 10_000) as JsonObject).get("url").asString
        assertTrue(url.startsWith(init.uiOrigin + "/"))
        assertTrue(url.contains("t="))
        val other = (rpc.call("uiUrl", null, 10_000) as JsonObject).get("url").asString
        assertFalse("each call gives a new URL", url == other)

        body(url, "HEAD") // must not redeem the token (REVIEW-9 #6): the GET below still gets the page
        val (code, page) = body(url)
        assertEquals(200, code)
        assertTrue(page.contains("__FI_WS__"))
        assertEquals("a used one-time URL is refused", 403, body(url).first)
        assertEquals("no token", 403, body(init.uiOrigin + "/").first)

        val (code2, page2) = body(other)
        assertEquals(200, code2)
        val ws = Regex("""__FI_WS__\s*=\s*"([^"]+)"""")
        val s1 = ws.find(page)?.groupValues?.get(1)
        val s2 = ws.find(page2)?.groupValues?.get(1)
        assertTrue("$s1 / $s2", s1 != null && s2 != null && s1 != s2)
        assertFalse("the WebSocket secret isn't the page token", s1!!.contains(url.substringAfter("t=")))
    }

    @Test
    fun exitsWhenStdinCloses() {
        init()
        rpc.close()
        assertTrue("the sidecar must exit when the IDE goes away", process!!.waitFor(10, TimeUnit.SECONDS))
    }

    @Test
    fun shutdownStopsIt() {
        init()
        try { rpc.call("shutdown", null, 5_000) } catch (_: Exception) {}
        assertTrue(process!!.waitFor(10, TimeUnit.SECONDS))
    }

    @Test
    fun unknownMethodsAreErrors() {
        init()
        val e = try { rpc.call("nope", null, 5_000); null } catch (e: RpcException) { e } catch (e: ExecutionException) { e.cause }
        assertTrue(e is RpcException)
    }
}
