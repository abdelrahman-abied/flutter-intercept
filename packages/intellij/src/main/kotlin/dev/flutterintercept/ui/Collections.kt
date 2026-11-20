// CONTRACTS §21.6 / §21.11: "Mock from a collection…" IDE requests (sidecar → plugin).
// Pure validation, dialog copy and FileChooser descriptor so tests can cover them without an EDT.
package dev.flutterintercept.ui

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.openapi.fileChooser.FileChooserDescriptor
import dev.flutterintercept.sidecar.RpcException
import java.nio.file.InvalidPathException
import java.nio.file.Path

object Collections {
    const val MAX_PATH = 4096
    const val MAX_NAME = 200
    const val MAX_FILE = 500
    const val MAX_ORIGINS = 20
    const val MAX_ORIGIN_LEN = 500
    const val MAX_VAR_VALUE = 2048

    const val COPY_SANITISED_BUTTON = "Copy without credentials"
    const val COPY_AS_IS_BUTTON = "Copy as it is"
    const val REMOVE_BUTTON = "Remove"

    const val COPY_DETAIL =
        "Without credentials (recommended): auth settings, scripts and secret-looking headers and variables are " +
            "removed from the copy. Example responses are kept exactly as they are in the file, so check them for real data."

    private val VAR_NAME = Regex("""[A-Za-z0-9_.$-]{1,100}""")
    private val ORIGIN_SHAPE = Regex("""^https?://[^\s/?#<>]+$""", RegexOption.IGNORE_CASE)
    private val VAR_URL_SHAPE = Regex("""^https?://[^\s/?#]+""", RegexOption.IGNORE_CASE)

    /** File chooser for a Postman collection (.json) or an OpenAPI 3 document (.json, .yaml, .yml). */
    fun chooserDescriptor(): FileChooserDescriptor =
        FileChooserDescriptor(true, false, false, false, false, false)
            .withTitle("Mock from a Collection")
            .withDescription("Choose a Postman collection (.json) or an OpenAPI 3 document (.json, .yaml, .yml).")
            .withExtensionFilter("Postman collection or OpenAPI", "json", "yaml", "yml")

    /** Why a chosen collection file path is refused, or null. Never repeats the path. */
    fun pathProblem(path: String): String? = when {
        path.isEmpty() -> "The file path is empty."
        path.length > MAX_PATH -> "The file path is too long."
        path.any { it == '\u0000' || it == '\n' || it == '\r' } -> "The file path is not a valid path."
        !isAbsolute(path) -> "The file path must be absolute."
        else -> null
    }

    private fun isAbsolute(path: String): Boolean = try {
        Path.of(path).isAbsolute
    } catch (_: InvalidPathException) {
        false
    }

    /** Optional starting directory from `ui.chooseCollectionFile`. Ignored when invalid. */
    fun defaultDir(p: JsonObject): String? {
        val raw = p.optString("defaultDir") ?: return null
        return raw.takeIf { pathProblem(it) == null }
    }

    /** `ui.confirmCopyCollection`: basename only (no path separators or control chars). */
    fun copyRequest(p: JsonObject): String {
        val name = p.optString("fileName")?.trim().orEmpty()
        if (name.isEmpty()) throw RpcException("fileName is required", "invalid")
        if (name.length > MAX_NAME || name.any { it.isISOControl() } || '/' in name || '\\' in name) {
            throw RpcException("fileName must be a single file name", "invalid")
        }
        return name
    }

    /** Plain-text question for `ui.confirmCopyCollection` (rendered through ConfirmDialog, which escapes HTML). */
    fun copyMessage(fileName: String): String =
        "\"$fileName\" is outside the project. To share these mocks with the team, a copy goes into .vscode/flutter-intercept/collections/."

    /** Maps the clicked button of `ui.confirmCopyCollection` to the protocol answer (`sanitised` | `as-is` | null). */
    fun copyChoiceResult(button: String?): String? = when (button) {
        COPY_SANITISED_BUTTON -> "sanitised"
        COPY_AS_IS_BUTTON -> "as-is"
        else -> null
    }

    /** `ui.askCollectionVariable`: validated variable name and filtered, bounded origin choices. */
    fun variableRequest(p: JsonObject): Pair<String, List<String>> {
        val name = p.optString("name")?.trim().orEmpty()
        if (!VAR_NAME.matches(name)) throw RpcException("name must be a variable name such as baseUrl", "invalid")
        val rawOrigins = p.get("origins")
        if (rawOrigins != null && !rawOrigins.isJsonNull && !rawOrigins.isJsonArray) {
            throw RpcException("origins must be a list", "invalid")
        }
        val origins = (rawOrigins as? JsonArray)?.mapNotNull { el ->
            if (!el.isJsonPrimitive || !el.asJsonPrimitive.isString) return@mapNotNull null
            val o = el.asString.trim()
            o.takeIf { it.length <= MAX_ORIGIN_LEN && it.none { c -> c.isISOControl() } && ORIGIN_SHAPE.matches(it) }
        }?.distinct()?.take(MAX_ORIGINS).orEmpty()
        return name to origins
    }

    fun variableTitle(name: String): String = "Mock from a Collection: {{$name}}"

    /** Plain-text prompt (never starts with `<html>`, and `name` matches `[A-Za-z0-9_.$-]+`). */
    fun variablePrompt(name: String, hasOrigins: Boolean): String = if (hasOrigins) {
        "Which server does {{$name}} stand for? Choose an origin seen in traffic or type an http:// or https:// URL. Saved in .vscode/flutter-intercept.json for the team."
    } else {
        "The server the app calls for {{$name}}, e.g. https://api.example.com. Saved in .vscode/flutter-intercept.json for the team."
    }

    /** Same URL check as the VS Code input box (`src/mocks/service.ts`). */
    fun isValidVariableUrl(value: String?): Boolean {
        val v = value?.trim().orEmpty()
        return v.isNotEmpty() && v.length <= MAX_VAR_VALUE && v.none { it.isISOControl() } && VAR_URL_SHAPE.containsMatchIn(v)
    }

    /** `ui.confirmRemoveCollection`: collection display name and workspace-relative file label. */
    fun removeRequest(p: JsonObject): Pair<String, String> {
        val name = p.optString("name")?.trim().orEmpty()
        if (name.isEmpty() || name.length > MAX_NAME || name.any { it.isISOControl() }) {
            throw RpcException("name is required", "invalid")
        }
        val file = p.optString("file")?.trim().orEmpty()
        if (file.isEmpty() || file.length > MAX_FILE || file.any { it.isISOControl() }) {
            throw RpcException("file is required", "invalid")
        }
        return name to file
    }

    /** Plain-text question for `ui.confirmRemoveCollection` (rendered through ConfirmDialog). */
    fun removeMessage(name: String): String = "Stop mocking from \"$name\"?"

    fun removeDetail(file: String): String =
        "The link is removed from .vscode/flutter-intercept.json for everyone who uses it. $file itself is kept."

    private fun JsonObject.optString(key: String): String? =
        get(key)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString
}
