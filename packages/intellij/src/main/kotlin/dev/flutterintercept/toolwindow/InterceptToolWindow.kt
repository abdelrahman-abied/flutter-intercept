// CONTRACTS §15.1: tool window "Flutter Intercept" (bottom) showing the sidecar's traffic UI in JCEF, reloaded when
// the sidecar restarts. Browsers, in order: JCEF (IntelliJ IDEA) → the Flutter plugin's embedded JxBrowser (Android
// Studio, the one Flutter DevTools uses) → "Open Traffic in Browser" (system browser).
package dev.flutterintercept.toolwindow

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
    private companion object {
        val LOG = com.intellij.openapi.diagnostic.Logger.getInstance(InterceptToolWindowPanel::class.java)
    }
    private val sidecar = SidecarProcess.getInstance()
    private var browser: EmbeddedView? = null
    private var browserDisposable: Disposable? = null
    private val jcef = JcefBridge.isSupported()
    // Declared before `init`: it may call showUi() right away when the sidecar is already running.
    private val flutterBrowser = FlutterEmbeddedBrowser()
    private var embedding = false
    /** Why the embedded browser isn't used (shown on the fallback panel), once known. */
    private var embeddedProblem: String? = null
    /** Set when the panel is disposed (tool window closed / project closing): late callbacks then do nothing. */
    @Volatile private var disposed = false

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
        ApplicationManager.getApplication().invokeLater({ if (!disposed && !project.isDisposed) block() }, ModalityState.any())
    }

    private fun showUi(init: InitResult) {
        val existing = browser
        if (existing != null) {
            if (componentCount == 0 || getComponent(0) !== existing.component) setContent(existing.component)
            loadFresh()
            return
        }
        if (embedding) return
        // The guard reads the sidecar's current origin, so a restart on a new port stays inside (REVIEW-9 #4).
        val guard = NavigationGuard(currentOrigin = { sidecar.init?.uiOrigin }, loadFresh = { onEdt { loadFresh() } })
        when (if (embeddedProblem != null) BrowserChoice.EXTERNAL else chooseBrowser(jcef, flutterBrowser.isPresent())) {
            BrowserChoice.JCEF -> {
                val parent = Disposer.newDisposable(this, "Flutter Intercept JCEF")
                val created = JcefBridge.create("about:blank", guard, parent)
                if (created == null) {
                    Disposer.dispose(parent)
                    fallBack(init, "JCEF couldn't create a browser")
                    return
                }
                attach(created, parent)
            }
            BrowserChoice.FLUTTER -> openFlutterBrowser(init, guard)
            BrowserChoice.EXTERNAL -> {
                if (embeddedProblem == null) embeddedProblem = "neither JCEF nor the Flutter plugin's embedded browser is available"
                showExternal(init)
            }
        }
    }

    private fun attach(view: EmbeddedView, parent: Disposable) {
        browser = view
        browserDisposable = parent
        setContent(view.component)
        loadFresh()
    }

    /** Android Studio: the Flutter plugin's JxBrowser (installed on first use, like for DevTools). */
    private fun openFlutterBrowser(init: InitResult, guard: NavigationGuard) {
        embedding = true
        showMessage("Preparing the embedded browser… (the first time, the Flutter plugin downloads it, as for DevTools)", false)
        ApplicationManager.getApplication().executeOnPooledThread {
            val problem = flutterBrowser.ensureInstalled(project)
            onEdt {
                if (problem != null) {
                    embedding = false
                    fallBack(init, problem)
                    return@onEdt
                }
                openFlutterTab(init, guard, attempt = 0)
            }
        }
    }

    private fun openFlutterTab(init: InitResult, guard: NavigationGuard, attempt: Int) {
        val parent = Disposer.newDisposable(this, "Flutter Intercept JxBrowser")
        when (val r = flutterBrowser.open(project, guard, parent)) {
            is FlutterEmbeddedBrowser.Result.Ready -> {
                embedding = false
                LOG.info("Flutter Intercept: showing the traffic view in the Flutter plugin's embedded browser")
                attach(r.view, parent)
            }
            is FlutterEmbeddedBrowser.Result.Unavailable -> {
                Disposer.dispose(parent)
                // Right after installation the Flutter plugin sets its engine asynchronously: retry briefly.
                if (r.reason.contains("isn't ready yet") && attempt < 20) {
                    com.intellij.util.concurrency.AppExecutorUtil.getAppScheduledExecutorService().schedule(
                        { onEdt { openFlutterTab(init, guard, attempt + 1) } }, 500, java.util.concurrent.TimeUnit.MILLISECONDS,
                    )
                } else {
                    embedding = false
                    fallBack(init, r.reason)
                }
            }
        }
    }

    /** One clear log line, then the system-browser panel. */
    private fun fallBack(init: InitResult, reason: String) {
        embeddedProblem = reason
        LOG.info("Flutter Intercept: traffic view falls back to the system browser: $reason")
        showExternal(init)
    }

    @Volatile private var fetching = false

    /** Every load uses a fresh one-time URL from the sidecar (CONTRACTS §15.4); URLs are never logged. */
    private fun loadFresh() {
        if (fetching) return
        fetching = true
        sidecar.freshUiUrl().whenComplete { url, e ->
            onEdt {
                fetching = false
                if (url != null) browser?.load(url)
                else showMessage("Flutter Intercept couldn't open the traffic view: ${e?.cause?.message ?: e?.message}", true)
            }
        }
    }

    private fun showExternal(init: InitResult) {
        val box = centered()
        val text = JBLabel(
            "<html><div style='text-align:center'>The traffic view can't show inside the IDE here (" +
                escape(embeddedProblem ?: "no embedded browser") + "), so it opens in your web browser.<br>It stays private to this computer and works only while the IDE runs. Browser " +
                "extensions allowed to read local (127.0.0.1) pages can see it too.</div></html>",
            SwingConstants.CENTER,
        )
        val open = JButton("Open Traffic in Browser").apply {
            addActionListener {
                // A fresh one-time URL each time: a used one in the browser history is worthless (CONTRACTS §15.4).
                sidecar.freshUiUrl().whenComplete { url, e ->
                    onEdt {
                        // Through a private redirect file: the one-time URL never appears on a command line (REVIEW-9 #3).
                        if (url != null) BrowserLauncher.open(url, SidecarProcess.dataDir())
                        else Notifications.notify(project, NotificationType.ERROR, "Flutter Intercept couldn't open the traffic view: ${e?.cause?.message ?: e?.message}")
                    }
                }
            }
        }
        box.add(text, row(0))
        val retry = JButton("Show It Inside the IDE").apply {
            isVisible = embeddedProblem != null && (jcef || flutterBrowser.isPresent())
            addActionListener {
                embeddedProblem = null
                sidecar.init?.let { showUi(it) }
            }
        }
        box.add(JPanel(FlowLayout()).apply { isOpaque = false; add(open); add(retry) }, row(1))
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
        disposed = true
        browser = null
        browserDisposable = null
    }
}
