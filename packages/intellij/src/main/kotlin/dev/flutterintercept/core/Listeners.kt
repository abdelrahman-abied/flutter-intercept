package dev.flutterintercept.core

import com.intellij.ide.ui.LafManager
import com.intellij.ide.ui.LafManagerListener
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import dev.flutterintercept.sidecar.SidecarProcess

/** The IDE theme changed: the traffic UI follows (types.ts `theme`). */
class InterceptLafListener : LafManagerListener {
    override fun lookAndFeelChanged(source: LafManager) {
        SidecarProcess.getInstance().pushTheme()
    }
}

/** A project window opened: if the sidecar runs, it serves this project's folders too. Never starts it. */
class InterceptProjectActivity : ProjectActivity {
    override suspend fun execute(project: Project) {
        SidecarProcess.getInstance().workspaceChanged()
    }
}

/** Tells the sidecar whether any Flutter Intercept tool window is on screen (types.ts `uiVisible`). */
class InterceptToolWindowListener : com.intellij.openapi.wm.ex.ToolWindowManagerListener {
    override fun stateChanged(toolWindowManager: com.intellij.openapi.wm.ToolWindowManager) {
        val visible = com.intellij.openapi.project.ProjectManager.getInstance().openProjects.any { p ->
            !p.isDisposed && com.intellij.openapi.wm.ToolWindowManager.getInstance(p)
                .getToolWindow(dev.flutterintercept.toolwindow.InterceptToolWindow.ID)?.isVisible == true
        }
        SidecarProcess.getInstance().setUiVisible(visible)
    }
}

/** A script saved in the IDE is approved like in VS Code (types.ts `fileSaved`); only local `.js` files. */
class InterceptFileSavedListener : com.intellij.openapi.fileEditor.FileDocumentManagerListener {
    override fun afterDocumentSaved(document: com.intellij.openapi.editor.Document) {
        val file = com.intellij.openapi.fileEditor.FileDocumentManager.getInstance().getFile(document) ?: return
        if (!file.isInLocalFileSystem || !file.name.endsWith(".js", ignoreCase = true)) return
        val path = java.io.File(file.path).absolutePath
        SidecarProcess.getInstance().fileSaved(path)
    }
}
