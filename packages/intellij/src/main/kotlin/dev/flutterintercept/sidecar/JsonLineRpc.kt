// CONTRACTS §15 / packages/sidecar/src/types.ts: newline-delimited JSON over the sidecar's stdin/stdout.
package dev.flutterintercept.sidecar

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.BufferedReader
import java.io.InputStream
import java.io.InputStreamReader
import java.io.OutputStream
import java.io.OutputStreamWriter
import java.io.Writer
import java.nio.charset.StandardCharsets
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executor
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/** An `{error: {message, code?}}` response. The message is meant for people (no secrets by contract). */
class RpcException(message: String, val code: String? = null) : RuntimeException(message)

/** No response within the timeout. */
class RpcTimeoutException(val method: String, timeoutMs: Long) : RuntimeException("The sidecar didn't answer $method within ${timeoutMs} ms")

/** The connection closed (the sidecar exited) before the response arrived. */
class RpcClosedException(message: String = "The Flutter Intercept sidecar stopped") : RuntimeException(message)

/**
 * Bidirectional JSON-lines RPC:
 *   request  {id, method, params?}  either direction (ours positive, the sidecar's negative)
 *   response {id, result?, error?: {message, code?}}
 *   event    {event, data?}         sidecar → plugin only
 *
 * Reads on its own daemon thread; requests from the sidecar are handed to [handler] on [executor] and answered when
 * the returned future completes. Never logs message contents (they may carry tokens or user data).
 */
class JsonLineRpc(
    private val input: InputStream,
    output: OutputStream,
    private val handler: (method: String, params: JsonElement?) -> CompletableFuture<Any?>,
    private val onEvent: (event: String, data: JsonElement?) -> Unit,
    private val onClose: () -> Unit,
    private val executor: Executor,
    private val scheduler: ScheduledExecutorService,
    private val log: (String) -> Unit = {},
    threadName: String = "Flutter Intercept sidecar reader",
) {
    private val reader = BufferedReader(InputStreamReader(input, StandardCharsets.UTF_8))
    private val writer: Writer = OutputStreamWriter(output, StandardCharsets.UTF_8)
    private val nextId = AtomicLong(1)
    private val pending = ConcurrentHashMap<Long, Pending>()
    private val closed = AtomicBoolean(false)
    private val readerThread = Thread(::readLoop, threadName).apply { isDaemon = true }

    private class Pending(val method: String, val future: CompletableFuture<JsonElement?>)

    val isClosed: Boolean get() = closed.get()

    fun start(): JsonLineRpc {
        readerThread.start()
        return this
    }

    /** Sends a request; the future completes with `result` (JsonNull when absent) or fails with an [RpcException]. */
    fun request(method: String, params: Any?, timeoutMs: Long): CompletableFuture<JsonElement?> {
        val future = CompletableFuture<JsonElement?>()
        if (closed.get()) {
            future.completeExceptionally(RpcClosedException())
            return future
        }
        val id = nextId.getAndIncrement()
        pending[id] = Pending(method, future)
        val msg = JsonObject().apply {
            addProperty("id", id)
            addProperty("method", method)
            if (params != null) add("params", GSON.toJsonTree(params))
        }
        if (timeoutMs > 0) {
            val task = scheduler.schedule({
                pending.remove(id)?.future?.completeExceptionally(RpcTimeoutException(method, timeoutMs))
            }, timeoutMs, TimeUnit.MILLISECONDS)
            future.whenComplete { _, _ -> task.cancel(false) }
        }
        try {
            send(msg)
        } catch (e: Exception) {
            pending.remove(id)
            future.completeExceptionally(RpcClosedException("Couldn't write to the sidecar: ${e.message}"))
        }
        return future
    }

    /** Blocking [request]; rethrows the failure cause. */
    fun call(method: String, params: Any?, timeoutMs: Long): JsonElement? {
        try {
            return request(method, params, timeoutMs).get()
        } catch (e: java.util.concurrent.ExecutionException) {
            throw e.cause ?: e
        }
    }

    /** Fails every pending request and stops reading. Idempotent. */
    fun close() {
        if (!closed.compareAndSet(false, true)) return
        val failure = RpcClosedException()
        pending.values.forEach { it.future.completeExceptionally(failure) }
        pending.clear()
        try { writer.close() } catch (_: Exception) {}
        // The raw stream, not the reader: BufferedReader.close would wait for the reader thread's readLine.
        try { input.close() } catch (_: Exception) {}
        onClose()
    }

    private fun send(msg: JsonObject) {
        val line = WIRE_GSON.toJson(msg)
        synchronized(writer) {
            writer.write(line)
            writer.write("\n")
            writer.flush()
        }
    }

    private fun readLoop() {
        try {
            while (!closed.get()) {
                val line = reader.readLine() ?: break
                if (line.isBlank()) continue
                val obj = try {
                    JsonParser.parseString(line).takeIf { it.isJsonObject }?.asJsonObject
                } catch (_: Exception) {
                    null
                }
                if (obj == null) {
                    log("Ignored a malformed line from the sidecar (${line.length} chars)")
                    continue
                }
                dispatch(obj)
            }
        } catch (_: Exception) {
            // stream closed
        } finally {
            close()
        }
    }

    internal fun dispatch(obj: JsonObject) {
        val event = obj.stringOrNull("event")
        if (event != null) {
            try { onEvent(event, obj.get("data")?.takeUnless { it.isJsonNull }) } catch (e: Exception) { log("Event handler for $event failed: ${e.javaClass.simpleName}") }
            return
        }
        val idEl = obj.get("id")
        val id = if (idEl != null && idEl.isJsonPrimitive && idEl.asJsonPrimitive.isNumber) idEl.asLong else null
        val method = obj.stringOrNull("method")
        if (method != null) {
            if (id == null) {
                log("Ignored a sidecar request without an id: $method")
                return
            }
            handleIncoming(id, method, obj.get("params")?.takeUnless { it.isJsonNull })
            return
        }
        if (id == null) {
            log("Ignored a sidecar message without id, method or event")
            return
        }
        val p = pending.remove(id) ?: return // late response after a timeout
        val error = obj.get("error")
        if (error != null && !error.isJsonNull) {
            val message = (error as? JsonObject)?.stringOrNull("message") ?: "Sidecar error"
            val code = (error as? JsonObject)?.stringOrNull("code")
            p.future.completeExceptionally(RpcException(message, code))
        } else {
            p.future.complete(obj.get("result") ?: JsonNull.INSTANCE)
        }
    }

    private fun handleIncoming(id: Long, method: String, params: JsonElement?) {
        val future: CompletableFuture<Any?> = try {
            CompletableFuture.supplyAsync({ handler(method, params) }, executor).thenCompose { it }
        } catch (e: Exception) {
            CompletableFuture.failedFuture(e)
        }
        future.whenComplete { result, failure ->
            val reply = JsonObject().apply { addProperty("id", id) }
            if (failure != null) {
                val cause = (failure as? java.util.concurrent.CompletionException)?.cause ?: failure
                reply.add("error", JsonObject().apply {
                    addProperty("message", cause.message ?: cause.javaClass.simpleName)
                    (cause as? RpcException)?.code?.let { addProperty("code", it) }
                })
            } else {
                reply.add("result", if (result == null) JsonNull.INSTANCE else GSON.toJsonTree(result))
            }
            if (!closed.get()) {
                try { send(reply) } catch (_: Exception) {}
            }
        }
    }

    companion object {
        /** For params and results: nulls are omitted (optional fields are absent, as in TypeScript). */
        val GSON: Gson = GsonBuilder().disableHtmlEscaping().create()
        /** For the envelope: keeps `"result": null`. */
        private val WIRE_GSON: Gson = GsonBuilder().disableHtmlEscaping().serializeNulls().create()

        private fun JsonObject.stringOrNull(key: String): String? {
            val el = get(key) ?: return null
            return if (el.isJsonPrimitive && el.asJsonPrimitive.isString) el.asString else null
        }
    }
}
