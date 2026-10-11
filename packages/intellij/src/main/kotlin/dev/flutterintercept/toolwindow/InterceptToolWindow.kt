// CONTRACTS §15.1: tool window "Flutter Intercept" (bottom) showing the sidecar's traffic UI in JCEF, reloaded when
// the sidecar restarts. Without JCEF (Android Studio 2026.2 ships none) it offers the UI in the system browser.
package dev.flutterintercept.toolwindow

import com.intellij.ide.BrowserUtil
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.components.JBLabel
import com.intellij.ui.content.ContentFactory
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import com.intellij.notification.NotificationType
import dev.flutterintercept.core.Notifications
import dev.flutterintercept.sidecar.InitResult
import dev.flutterintercept.sidecar.SidecarListener
import dev.flutterintercept.sidecar.SidecarProcess
import dev.flutterintercept.sidecar.SidecarStatus
import java.awt.BorderLayout
import java.awt.FlowLayout
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.SwingConstants

class InterceptToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = InterceptToolWindowPanel(project)
        val content = ContentFactory.getInstance().createContent(panel, "", false)
        content.setDisposer(panel)
        content.isCloseable = false
        toolWindow.contentManager.addContent(content)
    }
}

object InterceptToolWindow {
    const val ID = "Flutter Intercept"

    /** Shows (and with [focus], activates) the tool window. EDT. */
    fun show(project: Project, focus: Boolean) {
        val tw = ToolWindowManager.getInstance(project).getToolWindow(ID) ?: return
        if (focus) tw.activate(null, true) else tw.show(null)
    }
}

class InterceptToolWindowPanel(private val project: Project) : JPanel(BorderLayout()), Disposable {
    private val sidecar = SidecarProcess.getInstance()
    private var browser: JcefBridge.Browser? = null
    private var browserDisposable: Disposable? = null
    private val jcef = JcefBridge.isSupported()

    init {
        background = UIUtil.getPanelBackground()
        ApplicationManager.getApplication().messageBus.connect(this).subscribe(SidecarListener.TOPIC, object : SidecarListener {
            override fun ready(init: InitResult) = onEdt { showUi(init) }
            override fun stopped(problem: String?) = onEdt { if (sidecar.current == null) showMessage(problem ?: "The Flutter Intercept sidecar stopped. Restarting…", problem != null) }
            override fun status(status: SidecarStatus) {}
            override fun themeChanged() = onEdt { if (browser != null) loadFresh() }
        })
        val init = sidecar.init
        if (init != null) showUi(init) else {
            showMessage("Starting Flutter Intercept…", false)
            sidecar.startAsync().whenComplete { c, _ ->
                onEdt {
                    val i = c?.init
                    if (i != null) showUi(i) else showMessage(sidecar.startProblem ?: "Flutter Intercept couldn't start.", true)
                }
            }
        }
    }

    private fun onEdt(block: () -> Unit) {
        ApplicationManager.getApplication().invokeLater({ if (!project.isDisposed) block() }, ModalityState.any())
    }

    private fun showUi(init: InitResult) {
        if (!jcef) {
            showExternal(init)
            return
        }
        val existing = browser
        if (existing != null) {
            if (componentCount == 0 || getComponent(0) !== existing.component) setContent(existing.component)
            loadFresh()
            return
        }
        val parent = Disposer.newDisposable(this, "Flutter Intercept JCEF")
        val created = JcefBridge.create("about:blank", init.uiOrigin, parent)
        if (created == null) {
            Disposer.dispose(parent)
            showExternal(init)
            return
        }
        browser = created
        browserDisposable = parent
        setContent(created.component)
        loadFresh()
    }

    /** Every load uses a fresh one-time URL from the sidecar (CONTRACTS §15.4); URLs are never logged. */
    private fun loadFresh() {
        sidecar.freshUiUrl().whenComplete { url, e ->
            onEdt {
                if (url != null) browser?.load(url)
                else showMessage("Flutter Intercept couldn't open the traffic view: ${e?.cause?.message ?: e?.message}", true)
            }
        }
    }

    private fun showExternal(init: InitResult) {
        val box = centered()
        val text = JBLabel(
            "<html><div style='text-align:center'>This IDE has no embedded browser (JCEF), so the traffic view opens " +
                "in your web browser.<br>It stays private to this computer and works only while the IDE runs.</div></html>",
            SwingConstants.CENTER,
        )
        val open = JButton("Open Traffic in Browser").apply {
            addActionListener {
                // A fresh one-time URL each time: a used one in the browser history is worthless (CONTRACTS §15.4).
                sidecar.freshUiUrl().whenComplete { url, e ->
                    onEdt {
                        if (url != null) BrowserUtil.browse(url)
                        else Notifications.notify(project, NotificationType.ERROR, "Flutter Intercept couldn't open the traffic view: ${e?.cause?.message ?: e?.message}")
                    }
                }
            }
        }
        box.add(text, row(0))
        box.add(JPanel(FlowLayout()).apply { isOpaque = false; add(open) }, row(1))
        setContent(box)
    }

    private fun showMessage(message: String, problem: Boolean) {
        val box = centered()
        box.add(JBLabel("<html><div style='text-align:center'>${escape(message)}</div></html>", SwingConstants.CENTER), row(0))
        if (problem) {
            box.add(JPanel(FlowLayout()).apply {
                isOpaque = false
                add(JButton("Retry").apply { addActionListener { showMessage("Starting Flutter Intercept…", false); sidecar.restart() } })
                add(JButton("Settings").apply { addActionListener { ShowSettingsUtil.getInstance().showSettingsDialog(project, "Flutter Intercept") } })
            }, row(1))
        }
        setContent(box)
    }

    private fun centered() = JPanel(GridBagLayout()).apply { border = JBUI.Borders.empty(16); isOpaque = false }
    private fun row(y: Int) = GridBagConstraints().apply { gridx = 0; gridy = y; insets = JBUI.insets(4) }

    private fun setContent(c: java.awt.Component) {
        removeAll()
        add(c, BorderLayout.CENTER)
        revalidate()
        repaint()
    }

    private fun escape(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\n", "<br>")

    override fun dispose() {
        browser = null
        browserDisposable = null
    }
}
