// CONTRACTS §15.1 actions: Toggle Interception, Open Traffic, Clear, Connect AI Agent, Export OpenAPI / Postman,
// Save CA Certificate (+ Set Client Certificate Passphrase, Restart Sidecar).
package dev.flutterintercept.actions

import com.google.gson.JsonObject
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.popup.JBPopupFactory
import dev.flutterintercept.core.Notifications
import dev.flutterintercept.settings.ClientCertificateEntry
import dev.flutterintercept.settings.ClientCertificates
import dev.flutterintercept.settings.InterceptSettings
import dev.flutterintercept.sidecar.SidecarProcess
import dev.flutterintercept.sidecar.bool
import dev.flutterintercept.sidecar.str
import dev.flutterintercept.toolwindow.InterceptToolWindow
import java.awt.datatransfer.StringSelection
import java.util.concurrent.CompletionException

abstract class InterceptAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
}

/** Runs a sidecar `command` (it may ask for a file, so no short timeout) and reports failures. */
internal fun runCommand(project: Project?, name: String) {
    SidecarProcess.getInstance().request("command", mapOf("name" to name), 10 * 60_000L).whenComplete { _, e ->
        if (e != null) {
            val cause = (e as? CompletionException)?.cause ?: e
            Notifications.notify(project, NotificationType.ERROR, cause.message ?: "Flutter Intercept: $name failed")
        }
    }
}

class ToggleInterceptionAction : InterceptAction() {
    override fun actionPerformed(e: AnActionEvent) = toggle(e.project)

    override fun update(e: AnActionEvent) {
        val on = SidecarProcess.getInstance().status?.enabled ?: InterceptSettings.getInstance().state.enabled
        e.presentation.text = if (on) "Turn Interception Off" else "Turn Interception On"
    }

    companion object {
        /** The sidecar owns the runtime switch (the panel has one too); its `status` event updates the setting. */
        fun toggle(project: Project?) {
            val sidecar = SidecarProcess.getInstance()
            if (sidecar.current != null) {
                sidecar.request("command", mapOf("name" to "toggle"), 30_000).whenComplete { result, e ->
                    if (e != null) {
                        val cause = (e as? CompletionException)?.cause ?: e
                        Notifications.notify(project, NotificationType.ERROR, cause.message ?: "Flutter Intercept couldn't toggle interception")
                    } else {
                        (result as? JsonObject)?.bool("enabled")?.let { InterceptSettings.getInstance().recordFromSidecar(it, null) }
                    }
                }
            } else {
                val settings = InterceptSettings.getInstance()
                settings.update(settings.snapshot().also { it.enabled = !it.enabled })
            }
        }
    }
}

class OpenTrafficAction : InterceptAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        InterceptToolWindow.show(project, focus = true)
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null
    }
}

class ClearTrafficAction : InterceptAction() {
    override fun actionPerformed(e: AnActionEvent) {
        if (SidecarProcess.getInstance().current != null) runCommand(e.project, "clear")
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = SidecarProcess.getInstance().current != null
    }
}

class ExportOpenApiAction : InterceptAction() {
    override fun actionPerformed(e: AnActionEvent) = runCommand(e.project, "exportOpenApi")
}

class ExportPostmanAction : InterceptAction() {
    override fun actionPerformed(e: AnActionEvent) = runCommand(e.project, "exportPostman")
}

class SaveCaCertificateAction : InterceptAction() {
    override fun actionPerformed(e: AnActionEvent) = runCommand(e.project, "saveCaCertificate")
}

class RestartSidecarAction : InterceptAction() {
    override fun actionPerformed(e: AnActionEvent) = SidecarProcess.getInstance().restart()
}

class ConnectAgentAction : InterceptAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project
        val popup = JBPopupFactory.getInstance().createPopupChooserBuilder(CLIENTS.map { it.second })
            .setTitle("Connect AI Agent")
            .setItemChosenCallback { label ->
                val client = CLIENTS.first { it.second == label }.first
                connect(project, client, label)
            }
            .createPopup()
        if (project != null) popup.showCenteredInCurrentWindow(project) else popup.showInFocusCenter()
    }

    private fun connect(project: Project?, client: String, label: String) {
        SidecarProcess.getInstance().request("connectAgent", mapOf("client" to client), 30_000).whenComplete { result, e ->
            val text = (result as? JsonObject)?.str("text")
            ApplicationManager.getApplication().invokeLater {
                if (e != null || text == null) {
                    val cause = (e as? CompletionException)?.cause ?: e
                    Notifications.notify(project, NotificationType.ERROR, cause?.message ?: "Flutter Intercept couldn't prepare the agent setup.")
                } else {
                    // The text holds the MCP token: clipboard only, never logged or shown in a balloon.
                    CopyPasteManager.getInstance().setContents(StringSelection(text))
                    Notifications.notify(project, NotificationType.INFORMATION, "Copied the Flutter Intercept setup for $label. Paste it where the agent's MCP servers are configured.")
                }
            }
        }
    }

    companion object {
        val CLIENTS = listOf(
            "claude" to "Claude Code",
            "cursor" to "Cursor",
            "windsurf" to "Windsurf",
            "gemini" to "Gemini CLI",
            "other" to "Other MCP client",
        )
    }
}

class SetPassphraseAction : InterceptAction() {
    override fun actionPerformed(e: AnActionEvent) = run(e.project, InterceptSettings.getInstance().state.clientCertificates)

    companion object {
        /** Asks which certificate, then its passphrase (empty clears it); stores it in the password safe. EDT. */
        fun run(project: Project?, certificates: List<ClientCertificateEntry>) {
            val hosts = certificates.map { it.host.trim() }.filter { it.isNotEmpty() }.distinct()
            if (hosts.isEmpty()) {
                Messages.showInfoMessage(project, "Add a client certificate in Settings → Tools → Flutter Intercept first.", "Flutter Intercept")
                return
            }
            fun ask(host: String) {
                val pass = Messages.showPasswordDialog(project, "Passphrase for the client certificate of $host (empty clears it):", "Flutter Intercept", null) ?: return
                ApplicationManager.getApplication().executeOnPooledThread {
                    ClientCertificates.setPassphrase(host, pass)
                    // The sidecar reloads the certificates (and asks for passphrases again) with the settings.
                    SidecarProcess.getInstance().pushSettings()
                }
            }
            if (hosts.size == 1) ask(hosts[0])
            else {
                val popup = JBPopupFactory.getInstance().createPopupChooserBuilder(hosts)
                    .setTitle("Client Certificate")
                    .setItemChosenCallback { ApplicationManager.getApplication().invokeLater { ask(it) } }
                    .createPopup()
                if (project != null) popup.showCenteredInCurrentWindow(project) else popup.showInFocusCenter()
            }
        }
    }
}
