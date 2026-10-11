// Settings → Tools → Flutter Intercept: the SidecarSettings (application level) plus the Node.js path.
package dev.flutterintercept.settings

import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.options.ConfigurationException
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.bindIntText
import com.intellij.ui.dsl.builder.bindItem
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.columns
import com.intellij.ui.dsl.builder.COLUMNS_LARGE
import com.intellij.ui.dsl.builder.panel
import com.intellij.ui.dsl.builder.rows
import com.intellij.ui.dsl.builder.toNullableProperty
import com.intellij.util.xmlb.XmlSerializerUtil
import dev.flutterintercept.actions.SetPassphraseAction

class InterceptConfigurable : BoundConfigurable("Flutter Intercept") {
    private val settings get() = InterceptSettings.getInstance()

    /** The edited copy; the UI binds to its properties, [apply] stores it. */
    private val working = InterceptSettingsState()
    private var tlsText = ""
    private var certText = ""

    private fun load() {
        val s = settings.snapshot()
        XmlSerializerUtil.copyBean(s, working)
        working.tlsPassthrough = s.tlsPassthrough.toMutableList()
        working.clientCertificates = s.clientCertificates.map(ClientCertificateEntry::copy).toMutableList()
        tlsText = s.tlsPassthrough.joinToString("\n")
        certText = ClientCertificates.format(s.clientCertificates)
    }

    override fun createPanel(): DialogPanel {
        load()
        return panel {
            group("Interception") {
                row { checkBox("Route the HTTP traffic of Flutter debug and profile runs through Flutter Intercept").bindSelected(working::enabled) }
                row("Proxy port:") {
                    intTextField(1..65535).bindIntText(working::port)
                    comment("If busy, the next free port up to 8999 is used.")
                }
                row { checkBox("Record which line of code made each request").bindSelected(working::captureSource) }
                row { checkBox("Intercept Flutter Web apps").bindSelected(working::webEnabled) }
                row { checkBox("Check JSON responses against json_serializable / freezed models").bindSelected(working::contractCheck) }
                row { checkBox("Send requests to 10.0.2.2 / 10.0.3.2 to this computer's localhost").bindSelected(working::rewriteLocalhost) }
                row("Native HTTP clients:") {
                    comboBox(InterceptSettingsState.NATIVE_CLIENTS).bindItem(working::nativeClients.toNullableProperty())
                    comment("profile: list read-only · proxy: also route on Android emulators · off")
                }
                row("Background isolates:") { comboBox(InterceptSettingsState.BACKGROUND_ISOLATES).bindItem(working::backgroundIsolates.toNullableProperty()) }
                row("Notifications:") {
                    comboBox(InterceptSettingsState.NOTIFICATIONS).bindItem(working::notifications.toNullableProperty())
                    comment("When requests fail while the tool window is hidden.")
                }
            }
            group("Routing") {
                row("Upstream proxy:") {
                    textField().bindText(working::upstreamProxy).columns(COLUMNS_LARGE)
                        .comment("e.g. http://127.0.0.1:8888 (Charles, Burp). Empty = connect directly.")
                }
                row { checkBox("Accept any certificate from servers reached through the upstream proxy").bindSelected(working::upstreamProxyIgnoreCertErrors) }
                row("TLS passthrough hosts:") {}
                row {
                    textArea().bindText(::tlsText).rows(3).align(AlignX.FILL)
                        .comment("One host or glob per line (e.g. *.bank.example): passed through without decryption.")
                }
                row("Client certificates:") {}
                row {
                    textArea().bindText(::certText).rows(3).align(AlignX.FILL)
                        .comment("One per line: host = /path/client.p12  or  host = /path/cert.pem, /path/key.pem")
                }
                row { button("Set Client Certificate Passphrase…") { SetPassphraseAction.run(null, ClientCertificates.parse(certText).first) } }
            }
            group("AI Agents") {
                row("Access:") { comboBox(InterceptSettingsState.AGENT_ACCESS).bindItem(working::agentAccess.toNullableProperty()) }
                row { checkBox("Show secrets to agents as [redacted]").bindSelected(working::agentRedactSecrets) }
                row { checkBox("Let agents take screenshots of the running app (each one asks you)").bindSelected(working::agentScreenshots) }
                row("MCP port:") { intTextField(1..65535).bindIntText(working::agentMcpPort) }
            }
            group("Node.js") {
                row("Node.js executable:") {
                    textFieldWithBrowseButton(FileChooserDescriptorFactory.createSingleFileNoJarsDescriptor().withTitle("Node.js Executable"))
                        .bindText(working::nodePath).columns(COLUMNS_LARGE)
                        .comment("Node.js 18 or later runs Flutter Intercept's proxy. Empty = found on PATH, Homebrew, nvm, Volta.")
                }
            }
        }
    }

    override fun apply() {
        super.apply()
        val (certs, bad) = ClientCertificates.parse(certText)
        if (bad.isNotEmpty()) throw ConfigurationException("Client certificates: line ${bad.joinToString(", ")} isn't “host = file” or “host = cert, key”.")
        working.tlsPassthrough = tlsText.lines().map { it.trim() }.filter { it.isNotEmpty() }.toMutableList()
        working.clientCertificates = certs.toMutableList()
        working.nodePath = working.nodePath.trim()
        settings.update(working)
    }

    override fun reset() {
        load()
        super.reset()
    }
}
