// `ui.confirm` with modal: the same content as the VS Code modal (e.g. shared-rule approval, §15.2): the message,
// a scrollable read-only detail, one button per choice and Cancel (→ null).
package dev.flutterintercept.ui

import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.event.ActionEvent
import javax.swing.AbstractAction
import javax.swing.Action
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JTextArea

class ConfirmDialog(
    project: Project?,
    private val message: String,
    private val detail: String?,
    private val buttons: List<String>,
) : DialogWrapper(project, true) {
    private var chosen: String? = null

    init {
        title = "Flutter Intercept"
        init()
    }

    override fun createCenterPanel(): JComponent {
        val panel = JPanel(BorderLayout(0, JBUI.scale(8)))
        val label = JBLabel("<html><body style='width: 420px'>${escape(message)}</body></html>")
        panel.add(label, BorderLayout.NORTH)
        if (!detail.isNullOrBlank()) {
            val area = JTextArea(detail).apply {
                isEditable = false
                lineWrap = true
                wrapStyleWord = true
                rows = detail.lines().size.coerceIn(3, 18)
                columns = 60
                caretPosition = 0
            }
            panel.add(JBScrollPane(area), BorderLayout.CENTER)
        }
        return panel
    }

    override fun createActions(): Array<Action> {
        // Cancel is the default button: Enter must never approve (e.g. a shared rule, REVIEW-9 #7).
        cancelAction.putValue(DEFAULT_ACTION, true)
        return (choiceActions(buttons) { label ->
            chosen = label
            close(OK_EXIT_CODE)
        } + cancelAction).toTypedArray()
    }

    companion object {
        /** One action per button; none of them is the default. */
        fun choiceActions(buttons: List<String>, onChoose: (String) -> Unit): List<Action> = buttons.map { label ->
            object : AbstractAction(label) {
                override fun actionPerformed(e: ActionEvent?) = onChoose(label)
            }
        }
    }

    /** Shows the dialog (EDT) and returns the chosen button, or null for Cancel / Escape. */
    fun ask(): String? {
        show()
        return chosen
    }

    private fun escape(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\n", "<br>")
}
