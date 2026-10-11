// CONTRACTS §15.1: reads the `flutter run --machine` events this integration needs from the run process's stdout.
package dev.flutterintercept.run

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/** What a launch has told us so far (`app.debugPort`, `app.webLaunchUrl`, `app.started`, `app.stop`). */
class DaemonEvents {
    @Volatile var vmServiceUri: String? = null; private set
    @Volatile var webLaunchUrl: String? = null; private set
    @Volatile var started: Boolean = false; private set
    @Volatile var stopped: Boolean = false; private set

    private val pending = StringBuilder()

    /** Feeds raw stdout text (any chunking). Returns true when this chunk contained `app.started`. */
    @Synchronized
    fun feed(text: String): Boolean {
        pending.append(text)
        var sawStarted = false
        while (true) {
            val nl = pending.indexOf("\n")
            if (nl < 0) break
            val line = pending.substring(0, nl).trim()
            pending.delete(0, nl + 1)
            if (line(line)) sawStarted = true
        }
        // A runaway line without a newline (e.g. a huge app.log) is dropped, never buffered without bound.
        if (pending.length > MAX_PENDING) pending.setLength(0)
        return sawStarted
    }

    /** One stdout line; true when it is `app.started`. Non-JSON lines and unrelated events are ignored cheaply. */
    private fun line(line: String): Boolean {
        if (!line.startsWith("[{") || INTERESTING.none { line.contains(it) }) return false
        val array: JsonArray = try {
            JsonParser.parseString(line).takeIf { it.isJsonArray }?.asJsonArray ?: return false
        } catch (_: Exception) {
            return false
        }
        var sawStarted = false
        for (el in array) {
            val ev = el.takeIf { it.isJsonObject }?.asJsonObject ?: continue
            val params = ev.get("params")?.takeIf { it.isJsonObject }?.asJsonObject
            when (ev.str("event")) {
                "app.debugPort" -> params?.str("wsUri")?.let { vmServiceUri = it }
                "app.webLaunchUrl" -> params?.str("url")?.let { webLaunchUrl = it }
                "app.started" -> { started = true; sawStarted = true }
                "app.stop" -> stopped = true
            }
        }
        return sawStarted
    }

    private fun JsonObject.str(key: String): String? =
        get(key)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString?.takeIf { it.isNotBlank() }

    companion object {
        private const val MAX_PENDING = 1 shl 20
        private val INTERESTING = listOf("\"app.debugPort\"", "\"app.webLaunchUrl\"", "\"app.started\"", "\"app.stop\"")
    }
}
