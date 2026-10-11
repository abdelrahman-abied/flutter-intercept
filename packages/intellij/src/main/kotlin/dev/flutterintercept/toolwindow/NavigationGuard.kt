// REVIEW-9 #4: what the JCEF traffic view may navigate to. It follows the sidecar's *current* origin (a restart picks
// a new port), never sends the UI's own (loopback) URLs to the system browser, and turns every reload into a fresh
// one-time URL (a served one is spent, CONTRACTS §15.4).
package dev.flutterintercept.toolwindow

import com.intellij.ide.BrowserUtil
import java.net.URI
import java.util.concurrent.ConcurrentHashMap

class NavigationGuard(
    /** The running sidecar's UI origin (`http://127.0.0.1:<port>`), or null while it's down. */
    private val currentOrigin: () -> String?,
    /** Fetch a fresh one-time URL and load it (async). */
    private val loadFresh: () -> Unit,
    private val openExternal: (String) -> Unit = { BrowserUtil.browse(it) },
) {
    enum class Decision { ALLOW, LOAD_FRESH, EXTERNAL, BLOCK }

    /** One-time URLs we asked JCEF to load; each is allowed once. */
    private val expected = ConcurrentHashMap.newKeySet<String>()

    fun expect(url: String) {
        expected += url
    }

    fun decide(target: String): Decision {
        if (target.isEmpty() || target == "about:blank" || target.startsWith("devtools://")) return Decision.ALLOW
        if (isLoopback(target)) {
            val origin = currentOrigin()
            if (origin != null && sameOrigin(target, origin) && expected.remove(target)) return Decision.ALLOW
            // A reload, a stale port after a restart, a spent token: never the system browser; reload fresh.
            return Decision.LOAD_FRESH
        }
        return if (target.startsWith("https://") || target.startsWith("http://")) Decision.EXTERNAL else Decision.BLOCK
    }

    /** True = cancel the navigation. */
    fun onBeforeBrowse(target: String): Boolean = when (decide(target)) {
        Decision.ALLOW -> false
        Decision.LOAD_FRESH -> { loadFresh(); true }
        Decision.EXTERNAL -> { openExternal(target); true }
        Decision.BLOCK -> true
    }

    /** Popups never open in JCEF; only non-loopback http(s) links go to the system browser. */
    fun onPopup(target: String?) {
        if (target != null && decide(target) == Decision.EXTERNAL) openExternal(target)
    }

    companion object {
        fun isLoopback(url: String): Boolean = try {
            val u = URI(url)
            (u.scheme == "http" || u.scheme == "https" || u.scheme == "ws") &&
                (u.host == "127.0.0.1" || u.host == "localhost" || u.host == "[::1]" || u.host == "::1")
        } catch (_: Exception) {
            false
        }

        fun sameOrigin(url: String, origin: String): Boolean = url == origin || url.startsWith("$origin/") || url.startsWith("$origin?")
    }
}
