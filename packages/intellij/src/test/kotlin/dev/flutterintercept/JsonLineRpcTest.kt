package dev.flutterintercept

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import dev.flutterintercept.sidecar.JsonLineRpc
import dev.flutterintercept.sidecar.RpcClosedException
import dev.flutterintercept.sidecar.RpcException
import dev.flutterintercept.sidecar.RpcTimeoutException
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/** Frames and matching of the stdio protocol (types.ts header), with a fake sidecar on piped streams. */
class JsonLineRpcTest {
    private val executor = Executors.newCachedThreadPool()
    private val scheduler = Executors.newSingleThreadScheduledExecutor()

    // plugin → sidecar
    private lateinit var fromPlugin: BufferedReader
    // sidecar → plugin
    private lateinit var toPlugin: OutputStreamWriter
    private lateinit var rpc: JsonLineRpc

    private val events = LinkedBlockingQueue<Pair<String, JsonElement?>>()
    private val incoming = LinkedBlockingQueue<Pair<String, JsonElement?>>()
    private val closed = CountDownLatch(1)
    private var handler: (String, JsonElement?) -> CompletableFuture<Any?> = { m, p ->
        incoming.add(m to p)
        CompletableFuture.completedFuture(mapOf("ok" to true))
    }

    @Before
    fun setUp() {
        val pluginOut = PipedOutputStream()
        fromPlugin = BufferedReader(InputStreamReader(PipedInputStream(pluginOut, 1 shl 16), Charsets.UTF_8))
        val sidecarOut = PipedOutputStream()
        val pluginIn = PipedInputStream(sidecarOut, 1 shl 16)
        toPlugin = OutputStreamWriter(sidecarOut, Charsets.UTF_8)
        rpc = JsonLineRpc(
            input = pluginIn, output = pluginOut,
            handler = { m, p -> handler(m, p) },
            onEvent = { e, d -> events.add(e to d) },
            onClose = { closed.countDown() },
            executor = executor, scheduler = scheduler,
        ).start()
    }

    @After
    fun tearDown() {
        rpc.close()
        executor.shutdownNow()
        scheduler.shutdownNow()
    }

    private fun sidecarSends(json: String) {
        toPlugin.write(json + "\n")
        toPlugin.flush()
    }

    private fun sidecarReads(): JsonObject = JsonParser.parseString(fromPlugin.readLine()).asJsonObject

    @Test
    fun requestGetsItsResponseByIdAndIdsArePositive() {
        val f1 = rpc.request("init", mapOf("dataDir" to "/tmp/x", "absent" to null), 5_000)
        val f2 = rpc.request("theme", mapOf("theme" to "dark"), 5_000)
        val r1 = sidecarReads()
        val r2 = sidecarReads()
        assertEquals("init", r1.get("method").asString)
        assertTrue(r1.get("id").asLong > 0)
        assertTrue(r2.get("id").asLong > r1.get("id").asLong)
        assertEquals("/tmp/x", r1.getAsJsonObject("params").get("dataDir").asString)
        assertFalse("null params fields are omitted", r1.getAsJsonObject("params").has("absent"))
        // Answer out of order.
        sidecarSends("""{"id":${r2.get("id")},"result":null}""")
        sidecarSends("""{"id":${r1.get("id")},"result":{"uiUrl":"http://127.0.0.1:1/?t=x","version":"0.9.0"}}""")
        assertEquals("0.9.0", f1.get(2, TimeUnit.SECONDS)!!.asJsonObject.get("version").asString)
        assertTrue(f2.get(2, TimeUnit.SECONDS)!!.isJsonNull)
    }

    @Test
    fun errorResponseFailsWithMessageAndCode() {
        val f = rpc.request("prepareLaunch", emptyMap<String, Any>(), 5_000)
        val id = sidecarReads().get("id")
        sidecarSends("""{"id":$id,"error":{"message":"no pubspec","code":"bad-root"}}""")
        val e = try { f.get(2, TimeUnit.SECONDS); null } catch (e: ExecutionException) { e.cause }
        assertTrue(e is RpcException)
        assertEquals("no pubspec", e!!.message)
        assertEquals("bad-root", (e as RpcException).code)
    }

    @Test
    fun requestTimesOutAndALateResponseIsIgnored() {
        val f = rpc.request("slow", null, 100)
        val req = sidecarReads()
        assertFalse(req.has("params"))
        val e = try { f.get(2, TimeUnit.SECONDS); null } catch (e: ExecutionException) { e.cause }
        assertTrue(e is RpcTimeoutException)
        sidecarSends("""{"id":${req.get("id")},"result":1}""")
        // Still alive afterwards.
        val g = rpc.request("ping", null, 2_000)
        val id = sidecarReads().get("id")
        sidecarSends("""{"id":$id,"result":2}""")
        assertEquals(2, g.get(2, TimeUnit.SECONDS)!!.asInt)
    }

    @Test
    fun sidecarRequestsWithNegativeIdsAreAnswered() {
        sidecarSends("""{"id":-1,"method":"ui.clipboard","params":{"text":"hello"}}""")
        val reply = sidecarReads()
        assertEquals(-1, reply.get("id").asLong)
        assertTrue(reply.getAsJsonObject("result").get("ok").asBoolean)
        val (method, params) = incoming.poll(2, TimeUnit.SECONDS)!!
        assertEquals("ui.clipboard", method)
        assertEquals("hello", params!!.asJsonObject.get("text").asString)
    }

    @Test
    fun nullResultIsSentExplicitlyAndFailuresBecomeErrors() {
        handler = { m, _ -> if (m == "ui.pick") CompletableFuture.completedFuture(null) else CompletableFuture.failedFuture(RpcException("outside", "outside_workspace")) }
        sidecarSends("""{"id":-2,"method":"ui.pick","params":{"items":[]}}""")
        val r = sidecarReads()
        assertEquals(-2, r.get("id").asLong)
        assertTrue("result: null must be present", r.has("result") && r.get("result").isJsonNull)
        sidecarSends("""{"id":-3,"method":"ui.openFile","params":{"path":"/etc/passwd"}}""")
        val err = sidecarReads()
        assertEquals("outside", err.getAsJsonObject("error").get("message").asString)
        assertEquals("outside_workspace", err.getAsJsonObject("error").get("code").asString)
        assertFalse(err.has("result"))
    }

    @Test
    fun eventsAreDispatchedAndGarbageIsSkipped() {
        sidecarSends("not json")
        sidecarSends("[1,2]")
        sidecarSends("")
        sidecarSends("""{"event":"status","data":{"enabled":true,"paused":2}}""")
        val (name, data) = events.poll(2, TimeUnit.SECONDS)!!
        assertEquals("status", name)
        assertEquals(2, data!!.asJsonObject.get("paused").asInt)
    }

    @Test
    fun unicodeAndNewlinesInStringsStayOneFrame() {
        val f = rpc.request("ui", mapOf("text" to "line1\nline2 — ✓ <tag>"), 5_000)
        val req = sidecarReads()
        assertEquals("line1\nline2 — ✓ <tag>", req.getAsJsonObject("params").get("text").asString)
        sidecarSends("""{"id":${req.get("id")},"result":"é "}""")
        assertEquals("é ", f.get(2, TimeUnit.SECONDS)!!.asString)
    }

    @Test
    fun closingFailsPendingRequests() {
        val f = rpc.request("init", null, 10_000)
        sidecarReads()
        toPlugin.close() // the sidecar exits
        val e = try { f.get(2, TimeUnit.SECONDS); null } catch (e: ExecutionException) { e.cause }
        assertTrue(e is RpcClosedException)
        assertTrue(closed.await(2, TimeUnit.SECONDS))
        assertTrue(rpc.isClosed)
        val after = rpc.request("x", null, 1_000)
        assertTrue(after.isCompletedExceptionally)
    }

    @Test
    fun oversizeLinesAreDroppedAndReadingGoesOn() {
        rpc.close()
        val sidecarOut = PipedOutputStream()
        val pluginIn = PipedInputStream(sidecarOut, 1 shl 16)
        val w = OutputStreamWriter(sidecarOut, Charsets.UTF_8)
        val logs = LinkedBlockingQueue<String>()
        rpc = JsonLineRpc(pluginIn, java.io.ByteArrayOutputStream(), handler = { _, _ -> CompletableFuture.completedFuture(null) },
            onEvent = { e, d -> events.add(e to d) }, onClose = {}, executor = executor, scheduler = scheduler,
            log = { logs.add(it) }, maxLineChars = 100).start()
        w.write("""{"event":"log","data":{"line":"${"x".repeat(500)}"}}""" + "\n")
        w.write("""{"event":"status","data":{"enabled":true}}""" + "\r\n")
        w.flush()
        val (name, _) = events.poll(2, TimeUnit.SECONDS)!!
        assertEquals("status", name)
        assertTrue(logs.poll(2, TimeUnit.SECONDS)!!.contains("longer than 100"))
        assertNull(events.poll(100, TimeUnit.MILLISECONDS))
        assertEquals(16 * 1024 * 1024, JsonLineRpc.MAX_LINE_CHARS)
    }

    @Test
    fun messagesWithoutIdOrMethodAreIgnored() {
        sidecarSends("""{"result":1}""")
        sidecarSends("""{"method":"ui.reveal"}""")
        val f = rpc.request("ping", null, 2_000)
        val id = sidecarReads().get("id")
        sidecarSends("""{"id":$id}""")
        assertTrue(f.get(2, TimeUnit.SECONDS)!!.isJsonNull)
        assertNull(incoming.poll(100, TimeUnit.MILLISECONDS))
    }
}
