// CONTRACTS §15.1: status bar widget — on/off and the paused count from `status` events; click toggles.
package dev.flutterintercept.status

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.util.Consumer
import dev.flutterintercept.actions.ToggleInterceptionAction
import dev.flutterintercept.core.ProjectRoots
import dev.flutterintercept.settings.InterceptSettings
import dev.flutterintercept.settings.InterceptSettingsListener
import dev.flutterintercept.sidecar.InitResult
import dev.flutterintercept.sidecar.SidecarListener
import dev.flutterintercept.sidecar.SidecarProcess
import dev.flutterintercept.sidecar.SidecarStatus
import java.awt.event.MouseEvent

class InterceptStatusBarWidgetFactory : StatusBarWidgetFactory {
    override fun getId() = InterceptStatusBarWidget.ID
    override fun getDisplayName() = "Flutter Intercept"
    override fun isAvailable(project: Project) = ProjectRoots.isFlutterProject(project)
    override fun createWidget(project: Project): StatusBarWidget = InterceptStatusBarWidget(project)
}

class InterceptStatusBarWidget(private val project: Project) : StatusBarWidget, StatusBarWidget.TextPresentation {
    private var statusBar: StatusBar? = null

    override fun ID() = ID

    override fun install(statusBar: StatusBar) {
        this.statusBar = statusBar
        val bus = ApplicationManager.getApplication().messageBus.connect(this)
        bus.subscribe(SidecarListener.TOPIC, object : SidecarListener {
            override fun ready(init: InitResult) = refresh()
            override fun status(status: SidecarStatus) = refresh()
            override fun stopped(problem: String?) = refresh()
        })
        bus.subscribe(InterceptSettings.TOPIC, InterceptSettingsListener { refresh() })
    }

    private fun refresh() {
        ApplicationManager.getApplication().invokeLater({ if (!project.isDisposed) statusBar?.updateWidget(ID) }, ModalityState.any())
    }

    override fun getPresentation(): StatusBarWidget.WidgetPresentation = this

    override fun getText(): String = text(SidecarProcess.getInstance().status, InterceptSettings.getInstance().state.enabled)

    override fun getAlignment(): Float = 0f

    override fun getTooltipText(): String {
        val s = SidecarProcess.getInstance().status
        val on = s?.enabled ?: InterceptSettings.getInstance().state.enabled
        val base = if (on) "Flutter Intercept routes Flutter debug runs through its proxy. Click to turn off." else "Flutter Intercept is off. Click to turn on."
        val proxy = if (s?.proxyRunning == true && s.port != null) " Proxy on 127.0.0.1:${s.port}${if (s.lan) " (+ LAN for an iPhone)" else ""}." else ""
        return base + proxy
    }

    override fun getClickConsumer(): Consumer<MouseEvent> = Consumer { ToggleInterceptionAction.toggle(project) }

    override fun dispose() {
        statusBar = null
    }

    companion object {
        const val ID = "FlutterInterceptStatus"

        fun text(status: SidecarStatus?, settingEnabled: Boolean): String {
            val on = status?.enabled ?: settingEnabled
            if (!on) return "Intercept: off"
            val paused = status?.paused ?: 0
            return if (paused > 0) "Intercept: on · $paused paused" else "Intercept: on"
        }
    }
}
