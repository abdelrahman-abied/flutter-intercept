// REVIEW-9 #3: the one-time UI URL never goes on a process command line (visible to other local users through `ps`).
// The system browser gets a private redirect file instead; only its path is visible, and it is deleted after a minute.
package dev.flutterintercept.toolwindow

import com.google.gson.GsonBuilder
import com.intellij.ide.BrowserUtil
import com.intellij.util.concurrency.AppExecutorUtil
import java.io.File
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions
import java.security.SecureRandom
import java.util.concurrent.TimeUnit

object BrowserLauncher {
    const val LIFETIME_MS = 60_000L
    private const val PREFIX = "open-"
    private val random = SecureRandom()
    /** HTML-escaping Gson: `<`, `>`, `&`, `'`, `=` become \uXXXX, so the URL can't end the script element. */
    private val jsGson = GsonBuilder().create()

    /** `<dataDir>/browser`, 0700. */
    fun redirectDir(dataDir: File): File = File(dataDir, "browser").also { dir ->
        dir.mkdirs()
        try {
            Files.setPosixFilePermissions(dir.toPath(), PosixFilePermissions.fromString("rwx------"))
        } catch (_: Exception) {
        }
    }

    /** Writes a 0600 HTML file with a random name that sends the browser on to [url]. */
    fun writeRedirect(url: String, dir: File): File {
        require(url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:")) { "Not a loopback UI URL" }
        val name = PREFIX + ByteArray(16).also(random::nextBytes).joinToString("") { "%02x".format(it) } + ".html"
        val path = dir.toPath().resolve(name)
        try {
            Files.createFile(path, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
        } catch (_: UnsupportedOperationException) {
            Files.createFile(path) // Windows: the per-user data dir is already private
        }
        val attr = url.replace("&", "&amp;").replace("\"", "&quot;").replace("<", "&lt;").replace(">", "&gt;").replace("'", "&#39;")
        Files.writeString(
            path,
            """
            <!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">
            <meta http-equiv="refresh" content="0;url=$attr"><title>Flutter Intercept</title>
            <script>location.replace(${jsGson.toJson(url)});</script></head>
            <body><a href="$attr">Open Flutter Intercept</a></body></html>
            """.trimIndent(),
        )
        return path.toFile()
    }

    /** Deletes redirect files older than [LIFETIME_MS] (leftovers of a crash). */
    fun cleanup(dir: File, now: Long = System.currentTimeMillis()) {
        dir.listFiles { f -> f.name.startsWith(PREFIX) && f.name.endsWith(".html") }?.forEach { f ->
            if (now - f.lastModified() >= LIFETIME_MS) f.delete()
        }
    }

    /** Opens [url] in the system browser through a redirect file; [browse] gets only the file. */
    fun open(url: String, dataDir: File, browse: (File) -> Unit = { BrowserUtil.browse(it) }) {
        val dir = redirectDir(dataDir)
        cleanup(dir)
        val file = writeRedirect(url, dir)
        browse(file)
        AppExecutorUtil.getAppScheduledExecutorService().schedule({ file.delete() }, LIFETIME_MS, TimeUnit.MILLISECONDS)
    }
}
