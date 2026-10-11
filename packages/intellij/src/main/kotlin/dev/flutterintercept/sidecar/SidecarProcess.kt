// CONTRACTS §15.1: one sidecar per IDE process (application service), started lazily with the user's Node,
// restarted on crash (backoff, ≤ 3 times / 5 min), killed on exit. Tokens never reach the log (§15.2).
package dev.flutterintercept.sidecar

import com.google.gson.JsonElement
import com.intellij.ide.ui.LafManager
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationInfo
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.ui.JBColor
import com.intellij.util.EnvironmentUtil
import com.intellij.util.concurrency.AppExecutorUtil
import com.intellij.util.net.ProxyConfiguration
import com.intellij.util.net.ProxySettings
import dev.flutterintercept.core.Notifications
import dev.flutterintercept.core.ProjectRoots
import dev.flutterintercept.settings.IdeHttpProxy
import dev.flutterintercept.settings.InterceptSettings
import dev.flutterintercept.settings.InterceptSettingsListener
import dev.flutterintercept.settings.InterceptSettingsState
import dev.flutterintercept.ui.UiRequestHandler
import java.io.File
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions
import java.util.ArrayDeque
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

const val PLUGIN_ID = "dev.flutterintercept"

/** The plugin's folder name in the plugins directory (= the distribution zip's top folder, rootProject.name). */
const val PLUGIN_FOLDER = "flutter-intercept-intellij"

/** System property naming a sidecar.js to use instead of the bundled one (development: `./gradlew runIde`). */
const val SIDECAR_PATH_PROPERTY = "flutter.intercept.sidecar"

@Service(Service.Level.APP)
class SidecarProcess : Disposable {
    /** One running sidecar. */
    class Connection(val process: Process, val rpc: JsonLineRpc) {
        @Volatile var init: InitResult? = null
        val alive: Boolean get() = process.isAlive && !rpc.isClosed
    }

    private val lock = Any()
    @Volatile private var connection: Connection? = null
    @Volatile private var starting: CompletableFuture<Connection>? = null
    @Volatile private var disposing = false
    @Volatile private var lastStatus: SidecarStatus? = null
    @Volatile private var lastWorkspace: List<String> = emptyList()

    /** Why the sidecar can't run (no Node, missing bundle), cached briefly so launches don't retry every time. */
    @Volatile private var problem: String? = null
    @Volatile private var problemAt = 0L
    private var notifiedProblem: String? = null

    /** Crash times within the restart window. */
    private val crashes = ArrayDeque<Long>()
    @Volatile private var gaveUp = false

    private val stderrTail = ArrayDeque<String>()

    init {
        val bus = ApplicationManager.getApplication().messageBus.connect(this)
        bus.subscribe(InterceptSettings.TOPIC, InterceptSettingsListener { state ->
            problem = null
            pushSettings(state)
        })
        Runtime.getRuntime().addShutdownHook(Thread({ connection?.process?.let(::kill) }, "Flutter Intercept sidecar cleanup"))
    }

    val current: Connection? get() = connection?.takeIf { it.alive && it.init != null }
    val init: InitResult? get() = current?.init
    val status: SidecarStatus? get() = lastStatus
    val startProblem: String? get() = if (gaveUp) RESTART_LIMIT_MESSAGE else problem?.takeIf { System.currentTimeMillis() - problemAt < PROBLEM_TTL_MS }

    /** True when a start could succeed (no known problem). Cheap; safe on the EDT. */
    val isUsable: Boolean get() = startProblem == null

    /** Starts the sidecar (once; concurrent callers share the attempt). Never blocks. */
    fun startAsync(): CompletableFuture<Connection> {
        current?.let { return CompletableFuture.completedFuture(it) }
        synchronized(lock) {
            current?.let { return CompletableFuture.completedFuture(it) }
            starting?.let { if (!it.isDone) return it }
            if (disposing) return CompletableFuture.failedFuture(IllegalStateException("The IDE is closing"))
            startProblem?.let { return CompletableFuture.failedFuture(IllegalStateException(it)) }
            val f = CompletableFuture.supplyAsync({ startNow() }, AppExecutorUtil.getAppExecutorService())
            starting = f
            return f
        }
    }

    /** The running sidecar, starting it if needed and waiting at most [timeoutMs]; null with [startProblem] set otherwise. */
    fun ensureStarted(timeoutMs: Long): Connection? {
        current?.let { return it }
        return try {
            startAsync().get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (_: TimeoutException) {
            null
        } catch (e: ExecutionException) {
            null
        } catch (e: Exception) {
            null
        }
    }

    /** Sends a request to the running sidecar (starting it, bounded by [timeoutMs]). */
    fun request(method: String, params: Any?, timeoutMs: Long): CompletableFuture<JsonElement?> =
        startAsync().thenCompose { it.rpc.request(method, params, timeoutMs) }

    /**
     * A fresh one-time traffic-UI URL (types.ts `uiUrl` → {url}, CONTRACTS §15.4) for each JCEF load and each
     * "Open Traffic in Browser". Never logged. Starts the sidecar if needed.
     */
    fun freshUiUrl(): CompletableFuture<String> = request("uiUrl", null, 15_000).thenApply { r ->
        (r as? com.google.gson.JsonObject)?.str("url")?.takeIf { it.startsWith("http://127.0.0.1:") || it.startsWith("http://localhost:") }
            ?: throw RpcException("The sidecar gave no UI URL")
    }

    /** Fire-and-forget request to the sidecar if it runs (never starts it). */
    fun notifyIfRunning(method: String, params: Any?) {
        val c = current ?: return
        c.rpc.request(method, params, 10_000).whenComplete { _, e ->
            if (e != null) LOG.info("Sidecar $method failed: ${e.javaClass.simpleName}: ${e.message?.let(::redactSecrets)}")
        }
    }

    /** User asked to restart after the sidecar kept crashing (or after fixing Node). */
    fun restart() {
        synchronized(crashes) { crashes.clear() }
        gaveUp = false
        problem = null
        notifiedProblem = null
        // Stopping waits for the process (seconds): never on the EDT.
        AppExecutorUtil.getAppExecutorService().execute {
            connection?.let { stop(it) }
            startAsync()
        }
    }

    fun pushSettings(state: InterceptSettingsState = InterceptSettings.getInstance().state) {
        val c = current ?: return
        c.rpc.request("settings", mapOf("settings" to state.toSidecarSettings(ideHttpProxy())), 15_000).whenComplete { _, e ->
            if (e != null) LOG.warn("Sending settings to the sidecar failed: ${e.message?.let(::redactSecrets)}")
        }
    }

    /** The IDE theme changed: tell the sidecar, then the tool windows reload the page (it has no live theme message). */
    fun pushTheme() {
        val c = current ?: return
        c.rpc.request("theme", mapOf("theme" to currentTheme()), 10_000).whenComplete { _, e ->
            if (e == null) publish { it.themeChanged() }
        }
    }

    /** Project windows opened or closed after `init` (types.ts `workspaceFolders`). */
    fun workspaceChanged() {
        val c = current ?: return
        val folders = ProjectRoots.allWorkspaceFolders()
        if (folders == lastWorkspace) return
        lastWorkspace = folders
        c.rpc.request("workspaceFolders", mapOf("workspaceFolders" to folders), 10_000).whenComplete { _, e ->
            if (e != null) LOG.info("Sending workspace folders failed: ${e.message?.let(::redactSecrets)}")
        }
    }

    /** Whether a Flutter Intercept tool window is on screen (types.ts `uiVisible`: no failure balloons then). */
    @Volatile private var uiVisible = false
    @Volatile private var sentUiVisible: Boolean? = null

    fun setUiVisible(visible: Boolean) {
        uiVisible = visible
        val c = current ?: return
        if (sentUiVisible == visible) return
        sentUiVisible = visible
        c.rpc.request("uiVisible", mapOf("visible" to visible), 10_000).whenComplete { _, _ -> }
    }

    /** A script file was saved in the IDE (types.ts `fileSaved` → {approved}); like VS Code's onDidSaveTextDocument. */
    fun fileSaved(path: String) = notifyIfRunning("fileSaved", mapOf("path" to path))

    // ── start / stop ─────────────────────────────────────────────────────────────────────────────────────────────

    private fun startNow(): Connection {
        try {
            return doStart()
        } catch (e: Exception) {
            val message = e.message ?: e.javaClass.simpleName
            if (e !is StartProblem) LOG.warn("Flutter Intercept sidecar failed to start: ${redactSecrets(message)}")
            problem = message
            problemAt = System.currentTimeMillis()
            notifyProblemOnce(message, e is StartProblem && e.openSettings)
            publish { it.stopped(message) }
            throw e
        } finally {
            synchronized(lock) { starting = null }
        }
    }

    private class StartProblem(message: String, val openSettings: Boolean) : RuntimeException(message)

    private fun doStart(): Connection {
        val settings = InterceptSettings.getInstance().state
        val node = when (val r = NodeLocator().locate(settings.nodePath, listOf(shellPath(), System.getenv("PATH")))) {
            is NodeLookup.Found -> r
            is NodeLookup.Problem -> throw StartProblem(r.message, openSettings = true)
        }
        val script = sidecarScript() ?: throw StartProblem(
            "The Flutter Intercept sidecar is missing from the plugin. Reinstall the plugin.", openSettings = false,
        )
        val dataDir = dataDir()
        val pb = ProcessBuilder(node.path, script.absolutePath).directory(script.parentFile)
        val env = pb.environment()
        // A Dock-launched IDE has a minimal PATH; the sidecar runs adb / flutter / xcrun, so give it the shell's.
        try { env.putAll(EnvironmentUtil.getEnvironmentMap()) } catch (_: Exception) {}
        val nodeDir = File(node.path).parent
        env["PATH"] = listOfNotNull(nodeDir, env["PATH"]).joinToString(File.pathSeparator)
        env.remove("NODE_OPTIONS") // a user's --inspect / --require must not reach the sidecar
        val process = pb.start()
        LOG.info("Started the Flutter Intercept sidecar (Node ${node.version})")
        startStderrReader(process)

        lateinit var conn: Connection
        val rpc = JsonLineRpc(
            input = process.inputStream,
            output = process.outputStream,
            handler = { method, params -> UiRequestHandler.handle(method, params) },
            onEvent = { event, data -> onEvent(conn, event, data) },
            onClose = { onClosed(conn) },
            executor = AppExecutorUtil.getAppExecutorService(),
            scheduler = AppExecutorUtil.getAppScheduledExecutorService(),
            log = { LOG.info(it) },
        )
        conn = Connection(process, rpc)
        connection = conn
        rpc.start()

        val folders = ProjectRoots.allWorkspaceFolders()
        lastWorkspace = folders
        val params = mapOf(
            "dataDir" to dataDir.absolutePath,
            "workspaceFolders" to folders,
            "settings" to settings.toSidecarSettings(ideHttpProxy()),
            "theme" to currentTheme(),
            "ide" to ideInfo(),
        )
        val result = try {
            InitResult.parse(rpc.call("init", params, INIT_TIMEOUT_MS)) ?: throw IllegalStateException("The sidecar's init answer had no uiUrl")
        } catch (e: Exception) {
            stop(conn)
            throw IllegalStateException("The Flutter Intercept sidecar didn't start: ${e.message}${stderrHint()}", e)
        }
        conn.init = result
        problem = null
        notifiedProblem = null
        sentUiVisible = null
        if (uiVisible) setUiVisible(true)
        LOG.info("Flutter Intercept sidecar ready (version ${result.version})")
        publish { it.ready(result) }
        return conn
    }

    private fun onEvent(conn: Connection, event: String, data: JsonElement?) {
        when (event) {
            "ready" -> {
                val r = InitResult.parse(data) ?: return
                if (conn.init != r) {
                    conn.init = r
                    publish { it.ready(r) }
                }
            }
            "status" -> {
                val s = SidecarStatus.parse(data) ?: return
                lastStatus = s
                publish { it.status(s) }
            }
            "settingsChanged" -> {
                // The UI toggled interception or a balloon's "Turn off" muted notifications: persist, don't echo.
                val o = data as? com.google.gson.JsonObject ?: return
                InterceptSettings.getInstance().recordFromSidecar(o.bool("enabled"), o.str("notifications"))
                publish { listener -> lastStatus?.let { listener.status(it) } }
            }
            "log" -> (data as? com.google.gson.JsonObject)?.str("line")?.let { LOG.info("[sidecar] ${redactSecrets(it)}") }
        }
    }

    private fun onClosed(conn: Connection) {
        val wasCurrent = synchronized(lock) {
            if (connection === conn) {
                connection = null
                true
            } else false
        }
        kill(conn.process)
        if (!wasCurrent || disposing) return
        lastStatus = null
        val exit = try { conn.process.exitValue() } catch (_: Exception) { null }
        val tail = synchronized(stderrTail) { stderrTail.joinToString("\n") }
        LOG.warn("The Flutter Intercept sidecar stopped (exit ${exit ?: "?"})" + if (tail.isNotEmpty()) ". Last output:\n$tail" else "")
        publish { it.stopped(null) }
        if (conn.init == null) return // failed during init: startNow reports it
        val now = System.currentTimeMillis()
        val attempt = synchronized(crashes) {
            while (crashes.isNotEmpty() && now - crashes.first() > RESTART_WINDOW_MS) crashes.removeFirst()
            crashes.addLast(now)
            crashes.size
        }
        if (attempt > MAX_RESTARTS) {
            gaveUp = true
            Notifications.notify(
                null, NotificationType.ERROR, RESTART_LIMIT_MESSAGE,
                NotificationAction.createSimpleExpiring("Restart") { restart() },
            )
            return
        }
        val delay = RESTART_DELAYS_MS[(attempt - 1).coerceIn(0, RESTART_DELAYS_MS.size - 1)]
        AppExecutorUtil.getAppScheduledExecutorService().schedule({ if (!disposing) startAsync() }, delay, TimeUnit.MILLISECONDS)
    }

    private fun stop(conn: Connection) {
        try {
            if (conn.alive) conn.rpc.request("shutdown", null, 1_000).get(1_500, TimeUnit.MILLISECONDS)
        } catch (_: Exception) {
        }
        synchronized(lock) { if (connection === conn) connection = null }
        conn.rpc.close() // closes stdin: the sidecar exits when stdin closes
        if (!conn.process.waitFor(2, TimeUnit.SECONDS)) kill(conn.process)
    }

    override fun dispose() {
        disposing = true
        connection?.let(::stop)
    }

    // ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────

    private fun startStderrReader(process: Process) {
        Thread({
            try {
                process.errorStream.bufferedReader().useLines { lines ->
                    lines.forEach { raw ->
                        // The same lines arrive as `log` events (logged there); stderr is kept for crash diagnostics.
                        val line = redactSecrets(raw).take(2_000)
                        synchronized(stderrTail) {
                            stderrTail.addLast(line)
                            while (stderrTail.size > 20) stderrTail.removeFirst()
                        }
                    }
                }
            } catch (_: Exception) {
            }
        }, "Flutter Intercept sidecar stderr").apply { isDaemon = true }.start()
    }

    private fun stderrHint(): String {
        val last = synchronized(stderrTail) { stderrTail.lastOrNull() } ?: return ""
        return " — $last"
    }

    private fun notifyProblemOnce(message: String, openSettings: Boolean) {
        if (notifiedProblem == message) return
        notifiedProblem = message
        val actions = buildList {
            if (openSettings) add(NotificationAction.createSimpleExpiring("Open Settings") {
                ShowSettingsUtil.getInstance().showSettingsDialog(null, "Flutter Intercept")
            })
            add(NotificationAction.createSimpleExpiring("Retry") { restart() })
        }
        Notifications.notify(null, NotificationType.ERROR, message, *actions.toTypedArray())
    }

    private fun <T> publish(block: (SidecarListener) -> T) {
        val app = ApplicationManager.getApplication() ?: return
        if (app.isDisposed) return
        block(app.messageBus.syncPublisher(SidecarListener.TOPIC))
    }

    companion object {
        private val LOG = Logger.getInstance(SidecarProcess::class.java)
        const val INIT_TIMEOUT_MS = 30_000L
        const val MAX_RESTARTS = 3
        const val RESTART_WINDOW_MS = 5 * 60_000L
        private val RESTART_DELAYS_MS = longArrayOf(1_000, 4_000, 10_000)
        private const val PROBLEM_TTL_MS = 30_000L
        const val RESTART_LIMIT_MESSAGE = "The Flutter Intercept sidecar stopped 3 times in 5 minutes and wasn't restarted again. See idea.log for details."

        fun getInstance(): SidecarProcess = ApplicationManager.getApplication().getService(SidecarProcess::class.java)

        /** The bundled `<plugin>/sidecar/sidecar.js`, or the development override (system property) when it exists. */
        fun sidecarScript(): File? {
            System.getProperty(SIDECAR_PATH_PROPERTY)?.takeIf { it.isNotBlank() }?.let { File(it) }?.takeIf { it.isFile }?.let { return it }
            val candidates = sidecarCandidates(pluginJar(), PathManager.getPluginsDir().toFile())
            candidates.firstOrNull { it.isFile }?.let { return it }
            LOG.warn("Flutter Intercept sidecar not found; looked at ${candidates.joinToString()}")
            return null
        }

        /**
         * Where `sidecar/sidecar.js` can be: next to `lib/` of the jar this class came from (`<plugin>/lib/x.jar`), then
         * the plugin's folder in the IDE's plugins directory (installed from disk or the Marketplace).
         */
        fun sidecarCandidates(jar: File?, pluginsDir: File?): List<File> = buildList {
            jar?.takeIf { it.isFile }?.parentFile?.parentFile?.let { add(File(it, "sidecar/sidecar.js")) }
            pluginsDir?.let { add(File(it, "$PLUGIN_FOLDER/sidecar/sidecar.js")) }
        }.distinct()

        /** The jar holding this class (public PathManager API; protectionDomain is unreliable under plugin class loaders). */
        fun pluginJar(): File? {
            try {
                PathManager.getJarPathForClass(SidecarProcess::class.java)?.let(::File)?.takeIf { it.isFile }?.let { return it }
            } catch (_: Throwable) {
            }
            return try {
                File(SidecarProcess::class.java.protectionDomain.codeSource.location.toURI()).takeIf { it.isFile }
            } catch (_: Throwable) {
                null
            }
        }

        /** The version patched into our plugin.xml, read from our own jar. */
        val pluginVersion: String by lazy {
            try {
                pluginJar()?.let { jar ->
                    java.util.zip.ZipFile(jar).use { zip ->
                        zip.getEntry("META-INF/plugin.xml")?.let { e -> zip.getInputStream(e).bufferedReader().readText() }
                    }
                }?.let { Regex("<version>([^<]+)</version>").find(it)?.groupValues?.get(1)?.trim() } ?: "dev"
            } catch (_: Exception) {
                "dev"
            }
        }

        /** `<system>/flutter-intercept`, private to the user (holds the CA key). */
        fun dataDir(): File {
            val dir = File(PathManager.getSystemPath(), "flutter-intercept")
            dir.mkdirs()
            try {
                Files.setPosixFilePermissions(dir.toPath(), PosixFilePermissions.fromString("rwx------"))
            } catch (_: Exception) {
                // not POSIX (Windows): the system dir is already per-user
            }
            return dir
        }

        private fun shellPath(): String? = try { EnvironmentUtil.getValue("PATH") } catch (_: Exception) { null }

        fun currentTheme(): String {
            try {
                val laf = LafManager.getInstance().currentUIThemeLookAndFeel
                if (laf != null) {
                    if (laf.id.contains("contrast", ignoreCase = true) || laf.name.contains("contrast", ignoreCase = true)) return "high-contrast"
                    return if (laf.isDark) "dark" else "light"
                }
            } catch (_: Throwable) {
            }
            return if (JBColor.isBright()) "light" else "dark"
        }

        fun ideInfo(): Map<String, String> {
            val info = ApplicationInfo.getInstance()
            return mapOf(
                "name" to com.intellij.openapi.application.ApplicationNamesInfo.getInstance().fullProductName,
                "version" to info.fullVersion,
                "pluginVersion" to pluginVersion,
            )
        }

        /** The IDE's HTTP proxy (Settings → HTTP Proxy → manual HTTP), without credentials. */
        fun ideHttpProxy(): IdeHttpProxy? = try {
            val cfg = ProxySettings.getInstance().getProxyConfiguration()
            if (cfg is ProxyConfiguration.StaticProxyConfiguration && cfg.protocol == ProxyConfiguration.ProxyProtocol.HTTP && cfg.host.isNotBlank()) {
                IdeHttpProxy("http://${cfg.host}:${cfg.port}", cfg.exceptions.split(',', ';').map { it.trim() }.filter { it.isNotEmpty() })
            } else null
        } catch (_: Throwable) {
            null
        }

        internal fun kill(process: Process) {
            if (!process.isAlive) return
            try {
                process.descendants().forEach { it.destroyForcibly() }
            } catch (_: Exception) {
            }
            process.destroy()
            try {
                if (!process.waitFor(1, TimeUnit.SECONDS)) process.destroyForcibly()
            } catch (_: Exception) {
                process.destroyForcibly()
            }
        }
    }
}
