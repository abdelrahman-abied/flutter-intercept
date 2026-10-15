// CONTRACTS §15.1 / §20.3 / types.ts `SidecarRequest`: the UI the sidecar can't do itself, with IDE APIs. Runs off
// the EDT; every UI call hops to the EDT. Answers follow types.ts (value | null); refusals are errors with readable
// messages.
package dev.flutterintercept.ui

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.generateServiceName
import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.ide.impl.ProjectUtil
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserFactory
import com.intellij.openapi.fileChooser.FileSaverDescriptor
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.fileTypes.PlainTextFileType
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.JBPopupListener
import com.intellij.openapi.ui.popup.LightweightWindowEvent
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.wm.IdeFocusManager
import com.intellij.testFramework.LightVirtualFile
import com.intellij.ui.ColoredListCellRenderer
import com.intellij.ui.SimpleTextAttributes
import com.intellij.util.concurrency.AppExecutorUtil
import dev.flutterintercept.core.Notifications
import dev.flutterintercept.core.PathGuard
import dev.flutterintercept.core.PathRefusedException
import dev.flutterintercept.core.ProjectRoots
import dev.flutterintercept.settings.ClientCertificates
import dev.flutterintercept.settings.InterceptSettings
import dev.flutterintercept.sidecar.RpcException
import dev.flutterintercept.toolwindow.InterceptToolWindow
import java.awt.datatransfer.StringSelection
import java.io.File
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import javax.swing.JList

object UiRequestHandler {
    fun handle(method: String, params: JsonElement?): CompletableFuture<Any?> {
        val p = params as? JsonObject ?: JsonObject()
        return when (method) {
            "ui.openFile" -> openFile(p)
            "ui.openUntitled" -> onEdt { openUntitled(p) }
            "ui.diff" -> onEdt { diff(p) }
            "ui.clipboard" -> onEdt(ModalityState.any()) {
                CopyPasteManager.getInstance().setContents(StringSelection(p.requireString("text")))
                null
            }
            "ui.pick" -> pick(p)
            "ui.input" -> onEdt { input(p) }
            "ui.save" -> onEdt { save(p) }
            "ui.confirm" -> confirm(p)
            "ui.notify" -> notify(p)
            "ui.reveal" -> onEdt(ModalityState.any()) {
                activeProject()?.let { InterceptToolWindow.show(it, focus = true) }
                null
            }
            // Never prompts: the passphrase stored with "Set Client Certificate Passphrase…", or null.
            "secrets.clientCertPassphrase" -> CompletableFuture.supplyAsync({
                ClientCertificates.getPassphrase(p.requireString("host"))?.takeIf { it.isNotEmpty() }
            }, AppExecutorUtil.getAppExecutorService())
            // CONTRACTS §20.3: "Add client certificate…" in the panel (the shared ClientCertUi's platform in the sidecar).
            "ui.chooseClientCertificateFile" -> chooseClientCertificateFile(p)
            "settings.writeClientCertificates" -> writeClientCertificates(p)
            "secrets.setClientCertPassphrase" -> try {
                val (host, passphrase) = ClientCertificates.passphraseRequest(p)
                CompletableFuture.supplyAsync({
                    ClientCertificates.setPassphrase(host, passphrase)
                    null
                }, AppExecutorUtil.getAppExecutorService())
            } catch (e: RpcException) {
                CompletableFuture.failedFuture(e)
            }
            // The sidecar's own secrets (e.g. `flutterIntercept.mcpToken`) in the IDE's password safe; values never logged.
            "secrets.get" -> CompletableFuture.supplyAsync({ secretGet(p.requireString("key")) }, AppExecutorUtil.getAppExecutorService())
            "secrets.set" -> CompletableFuture.supplyAsync({
                secretSet(p.requireString("key"), p.optString("value"))
                null
            }, AppExecutorUtil.getAppExecutorService())
            else -> CompletableFuture.failedFuture(RpcException("Unknown request ${method.take(60)}", "unknown_method"))
        }
    }

    // ── ui.openFile ──────────────────────────────────────────────────────────────────────────────────────────────

    /** Directories files may be opened from: every open project's folders plus their package roots. */
    fun allowedRoots(): List<String> {
        val folders = ProjectRoots.allWorkspaceFolders()
        return folders + PathGuard.packageRoots(ProjectRoots.pubspecRoots(folders))
    }

    private fun openFile(p: JsonObject): CompletableFuture<Any?> {
        val path = p.requireString("path")
        val real: Path = try {
            PathGuard.check(path, allowedRoots())
        } catch (e: PathRefusedException) {
            return CompletableFuture.failedFuture(RpcException(e.message ?: "Refused", "outside_workspace"))
        }
        val line = p.optInt("line")
        val column = p.optInt("column")
        return onEdt {
            val project = projectFor(real.toString()) ?: throw RpcException("No project window is open")
            val vf = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(real)
                ?: throw RpcException("File not found: ${real.fileName}")
            // 1-based line/column from Dart; the IDE's are 0-based.
            OpenFileDescriptor(project, vf, ((line ?: 1) - 1).coerceAtLeast(0), ((column ?: 1) - 1).coerceAtLeast(0)).navigate(true)
            null
        }
    }

    // ── ui.openUntitled / ui.diff ────────────────────────────────────────────────────────────────────────────────

    private val LANGUAGE_EXTENSIONS = mapOf(
        "json" to "json", "jsonc" to "json", "dart" to "dart", "yaml" to "yaml", "yml" to "yaml", "typescript" to "ts",
        "javascript" to "js", "kotlin" to "kt", "swift" to "swift", "shellscript" to "sh", "shell" to "sh", "bash" to "sh",
        "markdown" to "md", "html" to "html", "xml" to "xml", "http" to "http", "python" to "py", "go" to "go",
        "plaintext" to "txt", "text" to "txt",
    )

    /** A file name whose extension gives the IDE the right highlighting. */
    fun fileNameFor(name: String, language: String?): String {
        val clean = name.substringAfterLast('/').substringAfterLast('\\').ifBlank { "untitled" }
        if (clean.contains('.') || language == null) return clean
        val ext = LANGUAGE_EXTENSIONS[language.lowercase()] ?: return clean
        return "$clean.$ext"
    }

    private fun fileType(name: String) = FileTypeManager.getInstance().getFileTypeByFileName(name).takeUnless { it.isBinary } ?: PlainTextFileType.INSTANCE

    private fun openUntitled(p: JsonObject): Any? {
        val project = activeProject() ?: throw RpcException("No project window is open")
        val files = p.getAsJsonArray("files") ?: throw RpcException("files is required")
        for (el in files) {
            val f = el as? JsonObject ?: continue
            val name = fileNameFor(f.optString("name") ?: "untitled", f.optString("language"))
            val vf = LightVirtualFile(name, fileType(name), f.optString("content") ?: "")
            FileEditorManager.getInstance(project).openFile(vf, true)
        }
        return null
    }

    private fun diff(p: JsonObject): Any? {
        val project = activeProject()
        val left = p.getAsJsonObject("left") ?: throw RpcException("left is required")
        val right = p.getAsJsonObject("right") ?: throw RpcException("right is required")
        val factory = DiffContentFactory.getInstance()
        val leftName = left.optString("name") ?: "Left"
        val rightName = right.optString("name") ?: "Right"
        val request = SimpleDiffRequest(
            p.optString("title") ?: "Flutter Intercept",
            factory.create(project, left.optString("content") ?: "", fileType(leftName)),
            factory.create(project, right.optString("content") ?: "", fileType(rightName)),
            leftName, rightName,
        )
        DiffManager.getInstance().showDiff(project, request)
        return null
    }

    // ── ui.pick / ui.input / ui.save ─────────────────────────────────────────────────────────────────────────────

    data class PickItem(val label: String, val description: String?, val value: String)

    fun parsePickItems(items: JsonArray?): List<PickItem> = items?.mapNotNull { el ->
        val o = el as? JsonObject ?: return@mapNotNull null
        val label = o.optString("label") ?: return@mapNotNull null
        PickItem(label, o.optString("description"), o.optString("value") ?: label)
    }.orEmpty()

    private fun pick(p: JsonObject): CompletableFuture<Any?> {
        val items = parsePickItems(p.getAsJsonArray("items"))
        if (items.isEmpty()) return CompletableFuture.completedFuture(null)
        val result = CompletableFuture<Any?>()
        ApplicationManager.getApplication().invokeLater({
            try {
                var chosen: PickItem? = null
                val builder = JBPopupFactory.getInstance().createPopupChooserBuilder(items)
                    .setRenderer(object : ColoredListCellRenderer<PickItem>() {
                        override fun customizeCellRenderer(list: JList<out PickItem>, value: PickItem?, index: Int, selected: Boolean, hasFocus: Boolean) {
                            if (value == null) return
                            append(value.label)
                            value.description?.let { append("  $it", SimpleTextAttributes.GRAYED_ATTRIBUTES) }
                        }
                    })
                    .setNamerForFiltering { it.label }
                    .setItemChosenCallback { chosen = it }
                    .addListener(object : JBPopupListener {
                        override fun onClosed(event: LightweightWindowEvent) {
                            // The chosen callback runs before onClosed for an accepted item.
                            ApplicationManager.getApplication().invokeLater { result.complete(chosen?.value) }
                        }
                    })
                (p.optString("title") ?: p.optString("placeholder"))?.let { builder.setTitle(it) }
                if (p.optString("title") != null) p.optString("placeholder")?.let { builder.setAdText(it) }
                val popup = builder.createPopup()
                val project = activeProject()
                if (project != null) popup.showCenteredInCurrentWindow(project) else popup.showInFocusCenter()
            } catch (e: Throwable) {
                result.completeExceptionally(e)
            }
        }, ModalityState.defaultModalityState())
        return result
    }

    private fun input(p: JsonObject): Any? {
        val project = activeProject()
        val prompt = p.optString("prompt") ?: ""
        return if (p.optBoolean("password") == true) {
            Messages.showPasswordDialog(project, prompt, "Flutter Intercept", null)
        } else {
            Messages.showInputDialog(project, prompt, "Flutter Intercept", null, p.optString("value") ?: "", null)
        }
    }

    /** Extensions from types.ts `filters` ({label: [ext, …]}), without dots. */
    fun extensionsOf(filters: JsonObject?): List<String> = filters?.entrySet()?.flatMap { (_, v) ->
        (v as? JsonArray)?.mapNotNull { el -> el.takeIf { it.isJsonPrimitive }?.asString?.trim()?.removePrefix("*")?.removePrefix(".") }.orEmpty()
    }?.filter { it.isNotEmpty() && it != "*" }?.distinct().orEmpty()

    private fun save(p: JsonObject): Any? {
        val project = activeProject()
        val defaultPath = p.optString("defaultPath") ?: ""
        val exts = extensionsOf(p.getAsJsonObject("filters"))
        val base = FileSaverDescriptor("Flutter Intercept", "Choose where to save")
        val label = p.getAsJsonObject("filters")?.keySet()?.firstOrNull() ?: "Files"
        val descriptor = if (exts.isEmpty()) base else FileSaverDescriptor(base.withExtensionFilter(label, *exts.toTypedArray()))
        val default = if (defaultPath.isNotEmpty()) File(defaultPath) else null
        val dir = default?.parentFile?.takeIf { it.isDirectory }?.toPath()
            ?: project?.basePath?.let { File(it).toPath() }
        val wrapper = FileChooserFactory.getInstance().createSaveFileDialog(descriptor, project).save(dir, default?.name ?: "")
        return wrapper?.file?.absolutePath
    }

    // ── client certificates (CONTRACTS §20.3) ──────────────────────────────────────────────────────────────────

    /**
     * The IDE's file chooser for one certificate role → the absolute path, or null when cancelled. Brings the project
     * window to the front first: in Android Studio the panel usually runs in the system browser (§15.4).
     */
    private fun chooseClientCertificateFile(p: JsonObject): CompletableFuture<Any?> {
        val role = p.optString("role")?.takeIf { it in ClientCertificates.ROLES }
            ?: return CompletableFuture.failedFuture(RpcException("role must be pfx, cert or key", "invalid"))
        return onEdt {
            val project = activeProject()
            if (project != null) ProjectUtil.focusProjectWindow(project, true)
            val file = FileChooser.chooseFile(ClientCertificates.chooserDescriptor(role), project, null) ?: return@onEdt null
            if (!file.isInLocalFileSystem) throw RpcException("Choose a file on this computer.", "invalid")
            val path = file.toNioPath().toAbsolutePath().toString()
            ClientCertificates.pathProblem(path)?.let { throw RpcException(it, "invalid") }
            path
        }
    }

    /** Stores the user-level entries; [InterceptSettings.update] sends them back to the sidecar (`settings`). */
    private fun writeClientCertificates(p: JsonObject): CompletableFuture<Any?> = onEdt(ModalityState.any()) {
        val settings = InterceptSettings.getInstance()
        val next = settings.snapshot()
        next.clientCertificates = ClientCertificates.entriesFromSidecar(p.get("entries"), next.clientCertificates).toMutableList()
        settings.update(next)
        null
    }

    // ── ui.confirm / ui.notify ───────────────────────────────────────────────────────────────────────────────────

    private fun confirm(p: JsonObject): CompletableFuture<Any?> {
        val message = p.requireString("message")
        val detail = p.optString("detail")
        val buttons = p.getAsJsonArray("buttons")?.mapNotNull { el -> el.takeIf { it.isJsonPrimitive }?.asString }.orEmpty()
        if (buttons.isEmpty()) return CompletableFuture.failedFuture(RpcException("buttons is required"))
        if (p.optBoolean("modal") == false) {
            return notifyWithButtons(NotificationType.WARNING, listOfNotNull(message, detail).joinToString("\n"), buttons)
        }
        return onEdt { ConfirmDialog(activeProject(), message, detail, buttons).ask() }
    }

    private fun notify(p: JsonObject): CompletableFuture<Any?> {
        val type = when (p.optString("level")) {
            "error" -> NotificationType.ERROR
            "warning" -> NotificationType.WARNING
            else -> NotificationType.INFORMATION
        }
        val buttons = p.getAsJsonArray("buttons")?.mapNotNull { el -> el.takeIf { it.isJsonPrimitive }?.asString }.orEmpty()
        return notifyWithButtons(type, p.requireString("message"), buttons)
    }

    /** A balloon whose buttons answer the request; closing it without a choice answers null. */
    private fun notifyWithButtons(type: NotificationType, message: String, buttons: List<String>): CompletableFuture<Any?> {
        val result = CompletableFuture<Any?>()
        val actions = buttons.map { label ->
            NotificationAction.createSimpleExpiring(label) { result.complete(label) }
        }
        val n = Notifications.create(type, message, *actions.toTypedArray())
        n.whenExpired { result.complete(null) }
        ApplicationManager.getApplication().invokeLater({ n.notify(activeProject()) }, ModalityState.any())
        if (buttons.isEmpty()) result.complete(null)
        return result
    }

    // ── secrets ──────────────────────────────────────────────────────────────────────────────────────────────────

    fun secretAttributes(key: String) = CredentialAttributes(generateServiceName("Flutter Intercept", key))

    /** Keys the sidecar may read and write: its own namespace only. */
    fun checkSecretKey(key: String): String {
        if (!Regex("""flutterIntercept\.[A-Za-z0-9_.:*\-]{1,200}""").matches(key)) throw RpcException("Secret keys must start with flutterIntercept.", "invalid")
        return key
    }

    private fun secretGet(key: String): String? =
        com.intellij.ide.passwordSafe.PasswordSafe.instance.getPassword(secretAttributes(checkSecretKey(key)))?.takeIf { it.isNotEmpty() }

    /** Empty or absent value deletes the secret. */
    private fun secretSet(key: String, value: String?) {
        val k = checkSecretKey(key)
        com.intellij.ide.passwordSafe.PasswordSafe.instance.set(
            secretAttributes(k), if (value.isNullOrEmpty()) null else com.intellij.credentialStore.Credentials(k, value),
        )
    }

    // ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────

    /** The project of the focused window, else any open project. */
    fun activeProject(): Project? {
        IdeFocusManager.getGlobalInstance().lastFocusedFrame?.project?.takeIf { !it.isDisposed && !it.isDefault }?.let { return it }
        return ProjectManager.getInstance().openProjects.firstOrNull { !it.isDisposed && !it.isDefault }
    }

    /** The open project whose folders contain [path] (deepest root), else the active one. */
    private fun projectFor(path: String): Project? {
        val p = File(path).toPath()
        val best = ProjectManager.getInstance().openProjects.filter { !it.isDisposed && !it.isDefault }.flatMap { project ->
            ProjectRoots.workspaceFolders(project).mapNotNull { root ->
                val r = try { File(root).toPath().toRealPath() } catch (_: Exception) { null }
                if (r != null && p.startsWith(r)) project to r.nameCount else null
            }
        }.maxByOrNull { it.second }
        return best?.first ?: activeProject()
    }

    private fun onEdt(modality: ModalityState = ModalityState.defaultModalityState(), block: () -> Any?): CompletableFuture<Any?> {
        val f = CompletableFuture<Any?>()
        ApplicationManager.getApplication().invokeLater({
            try {
                f.complete(block())
            } catch (e: Throwable) {
                f.completeExceptionally(e)
            }
        }, modality)
        return f
    }

    private fun JsonObject.optString(key: String): String? = get(key)?.takeIf { it.isJsonPrimitive }?.asString
    private fun JsonObject.optBoolean(key: String): Boolean? = get(key)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isBoolean }?.asBoolean
    private fun JsonObject.optInt(key: String): Int? = get(key)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.asDouble?.toInt()
    private fun JsonObject.requireString(key: String): String = optString(key) ?: throw RpcException("$key is required", "invalid")
}
