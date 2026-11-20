// CONTRACTS §23.2 / §23.6: generic multi-choice modal dialog (`ui.pickMany`, sidecar → plugin) for picking one or more
// items with preselection (e.g. which servers a fake backend from traffic should answer for). Pure validation and item
// parsing live in the companion object so unit tests can cover them without an EDT.
package dev.flutterintercept.ui

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.JBUI
import dev.flutterintercept.sidecar.RpcException
import java.awt.BorderLayout
import java.awt.Dimension
import javax.swing.BoxLayout
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JTextArea

data class PickManyItem(
    val label: String,
    val description: String?,
    val value: String,
    val picked: Boolean,
)

data class PickManyRequest(
    val title: String,
    val placeholder: String?,
    val items: List<PickManyItem>,
    val okButton: String,
)

class PickManyDialog(
    project: Project?,
    private val request: PickManyRequest,
) : DialogWrapper(project, true) {
    private val boxes = mutableListOf<JBCheckBox>()

    init {
        title = request.title
        setOKButtonText(request.okButton)
        init()
        updateOkEnabled()
    }

    override fun createCenterPanel(): JComponent {
        val panel = JPanel(BorderLayout(0, JBUI.scale(8)))
        if (!request.placeholder.isNullOrBlank()) {
            // Plain JTextArea (never HTML) so untrusted text cannot trigger Swing HTML rendering.
            val prompt = JTextArea(request.placeholder).apply {
                isEditable = false
                isFocusable = false
                isOpaque = false
                lineWrap = true
                wrapStyleWord = true
                rows = request.placeholder.lines().size.coerceIn(1, 5)
                columns = 54
            }
            panel.add(prompt, BorderLayout.NORTH)
        }
        val listPanel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = JBUI.Borders.empty(4)
        }
        boxes.clear()
        for (item in request.items) {
            val cb = JBCheckBox(formatItemText(item), item.picked).apply {
                putClientProperty("html.disable", true)
                addItemListener { updateOkEnabled() }
            }
            boxes += cb
            listPanel.add(cb)
        }
        val scroll = JBScrollPane(listPanel).apply {
            preferredSize = Dimension(JBUI.scale(480), JBUI.scale((request.items.size * 28 + 16).coerceIn(90, 320)))
        }
        panel.add(scroll, BorderLayout.CENTER)
        return panel
    }

    private fun updateOkEnabled() {
        isOKActionEnabled = boxes.any { it.isSelected }
    }

    internal val checkBoxes: List<JBCheckBox> get() = boxes.toList()

    internal fun selectedValues(): List<String> =
        request.items.indices.filter { boxes[it].isSelected }.map { request.items[it].value }

    /** Shows the dialog (EDT) and returns the selected values, or null when cancelled. */
    fun ask(): List<String>? {
        if (!showAndGet()) return null
        return selectedValues()
    }

    companion object {
        const val MAX_ITEMS = 200
        const val MAX_TITLE = 200
        const val MAX_PLACEHOLDER = 500
        const val MAX_LABEL = 500
        const val MAX_VALUE = 1000
        const val MAX_BUTTON = 80
        const val DEFAULT_TITLE = "Flutter Intercept"
        const val DEFAULT_OK_BUTTON = "OK"

        fun formatItemText(item: PickManyItem): String =
            if (item.description.isNullOrBlank()) item.label else "${item.label} — ${item.description}"

        /** Validates and bounds `ui.pickMany` params from the sidecar. */
        fun parseRequest(p: JsonObject): PickManyRequest {
            val rawItems = p.get("items")
            if (rawItems == null || !rawItems.isJsonArray) {
                throw RpcException("items must be a non-empty list", "invalid")
            }
            val items = parseItems(rawItems.asJsonArray)
            if (items.isEmpty()) {
                throw RpcException("items must not be empty", "invalid")
            }
            val title = cleanOneLine(p.optString("title"), MAX_TITLE).ifEmpty { DEFAULT_TITLE }
            val placeholder = p.optString("placeholder")?.let { cleanMultiline(it, MAX_PLACEHOLDER) }?.ifEmpty { null }
            val okButton = cleanOneLine(p.optString("okButton"), MAX_BUTTON).ifEmpty { DEFAULT_OK_BUTTON }
            return PickManyRequest(title = title, placeholder = placeholder, items = items, okButton = okButton)
        }

        fun parseItems(arr: JsonArray): List<PickManyItem> = arr.asSequence().take(MAX_ITEMS).mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            val label = cleanOneLine(o.optString("label"), MAX_LABEL)
            if (label.isEmpty()) return@mapNotNull null
            val description = cleanOneLine(o.optString("description"), MAX_LABEL).ifEmpty { null }
            val rawValue = o.optString("value")
            val value = if (rawValue != null && rawValue.length <= MAX_VALUE && rawValue.none { it.isISOControl() }) rawValue else label
            val picked = o.get("picked")?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isBoolean }?.asBoolean == true
            PickManyItem(label = label, description = description, value = value, picked = picked)
        }.toList()

        private fun cleanOneLine(s: String?, max: Int): String =
            s?.replace(Regex("""[\u0000-\u001f\u007f]+"""), " ")?.trim()?.take(max).orEmpty()

        private fun cleanMultiline(s: String, max: Int): String =
            s.replace("\r\n", "\n").replace("\r", "\n").filter { it == '\n' || !it.isISOControl() }.trim().take(max)

        private fun JsonObject.optString(key: String): String? =
            get(key)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString
    }
}
