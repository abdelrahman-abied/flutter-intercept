// Client certificates (mTLS): the settings page edits them as lines; passphrases live in the IDE's password safe
// under the same key names as VS Code's secret storage (packages/extension/src/ui/clientCerts.ts).
package dev.flutterintercept.settings

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.credentialStore.Credentials
import com.intellij.ide.passwordSafe.PasswordSafe
import com.intellij.openapi.fileChooser.FileChooserDescriptor
import dev.flutterintercept.sidecar.RpcException
import dev.flutterintercept.ui.UiRequestHandler
import java.nio.file.InvalidPathException
import java.nio.file.Path

object ClientCertificates {
    const val PASSPHRASE_PREFIX = "flutterIntercept.clientCertificatePassphrase:"

    fun passphraseKey(host: String) = PASSPHRASE_PREFIX + host.trim().lowercase()

    /** Off the EDT (the password safe may block). */
    fun getPassphrase(host: String): String? = PasswordSafe.instance.getPassword(UiRequestHandler.secretAttributes(passphraseKey(host)))

    /** Empty or null clears it. Off the EDT. */
    fun setPassphrase(host: String, passphrase: String?) {
        val key = passphraseKey(host)
        PasswordSafe.instance.set(UiRequestHandler.secretAttributes(key), if (passphrase.isNullOrEmpty()) null else Credentials(key, passphrase))
    }

    /**
     * Stores (or clears) a passphrase, then re-sends the settings so the sidecar reloads the certificates right away
     * (it asks for passphrases with `secrets.clientCertPassphrase` while loading them). Off the EDT.
     */
    fun applyPassphrase(
        host: String,
        passphrase: String?,
        store: (String, String?) -> Unit = ::setPassphrase,
        resend: () -> Unit = { dev.flutterintercept.sidecar.SidecarProcess.getInstance().pushSettings() },
    ) {
        store(host, passphrase)
        resend()
    }

    /**
     * One certificate per line: `host = /path/client.p12` (PKCS#12) or `host = /path/cert.pem, /path/key.pem`.
     * Blank lines and `#` comments are skipped; returns the entries and the 1-based numbers of invalid lines.
     */
    fun parse(text: String): Pair<List<ClientCertificateEntry>, List<Int>> {
        val entries = mutableListOf<ClientCertificateEntry>()
        val bad = mutableListOf<Int>()
        text.lines().forEachIndexed { i, raw ->
            val line = raw.trim()
            if (line.isEmpty() || line.startsWith("#")) return@forEachIndexed
            val eq = line.indexOf('=')
            if (eq <= 0) { bad += i + 1; return@forEachIndexed }
            val host = line.substring(0, eq).trim()
            val files = line.substring(eq + 1).split(',').map { it.trim() }.filter { it.isNotEmpty() }
            if (host.isEmpty() || host.contains(' ') || files.isEmpty() || files.size > 2) { bad += i + 1; return@forEachIndexed }
            entries += ClientCertificateEntry().also {
                it.host = host
                if (files.size == 1) it.pfx = files[0] else { it.cert = files[0]; it.key = files[1] }
            }
        }
        return entries to bad
    }

    fun format(entries: List<ClientCertificateEntry>): String = entries.joinToString("\n") { e ->
        val files = listOfNotNull(e.pfx?.takeIf { it.isNotBlank() }) .ifEmpty { listOfNotNull(e.cert, e.key).filter { it.isNotBlank() } }
        "${e.host} = ${files.joinToString(", ")}"
    }

    // ── CONTRACTS §20.3: the panel's "Add client certificate…" (sidecar → plugin requests, checked here too) ──────

    /** Same caps as the extension (clientCerts.ts `MAX_CLIENT_CERTS`, the sidecar's path limit). */
    const val MAX_ENTRIES = 50
    const val MAX_PATH = 4096
    const val MAX_HOST = 260
    /** A host that only names a passphrase to delete (the extension's `remove` accepts up to 300). */
    const val MAX_LEGACY_HOST = 300
    const val MAX_PASSPHRASE = 4096

    /** `ClientCertFileRole` of the protocol. */
    val ROLES = listOf("pfx", "cert", "key")

    /** Host name / `*.` pattern / IPv4 / [IPv6], each with an optional `:port`, or a bare IPv6 address. */
    private val HOST_SHAPE = Regex("""[A-Za-z0-9_*.\-]+(:[0-9]{1,5})?|\[[0-9A-Fa-f:.]+](:[0-9]{1,5})?|[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*""")

    /**
     * Why a host pattern from the sidecar is refused, or null. Shape only (the sidecar applies the proxy's full
     * pattern rules); it also keeps the settings page's `host = file` lines parseable (no spaces, `=`, `,`, `#`).
     */
    fun hostProblem(host: String?): String? {
        val h = host?.trim().orEmpty()
        return when {
            h.isEmpty() -> "The host is missing."
            h.length > MAX_HOST -> "The host is too long."
            !HOST_SHAPE.matches(h) -> "The host must be a host name pattern such as api.example.com or *.corp.example:8443."
            else -> null
        }
    }

    /**
     * Why a certificate file path is refused, or null: absolute, one line, and storable in the settings page's
     * `host = /a.pem, /b.key` lines (no comma, no surrounding spaces). The message never repeats the path.
     */
    fun pathProblem(path: String): String? = when {
        path.isEmpty() -> "The file path is empty."
        path.length > MAX_PATH -> "The file path is too long."
        path.any { it == '\u0000' || it == '\n' || it == '\r' } -> "The file path is not a valid path."
        path != path.trim() -> "Flutter Intercept can't store a file path that starts or ends with a space; rename the file or its folder."
        ',' in path -> "Flutter Intercept can't store a file path that contains a comma; rename the file or its folder."
        !isAbsolute(path) -> "The file path must be absolute."
        else -> null
    }

    private fun isAbsolute(path: String): Boolean = try {
        Path.of(path).isAbsolute
    } catch (_: InvalidPathException) {
        false
    }

    /** The file chooser for one role. Any file can be picked (the extensions are only named): the sidecar checks the content. */
    fun chooserDescriptor(role: String): FileChooserDescriptor {
        val (title, description) = when (role) {
            "pfx" -> "Choose the Client Certificate (PKCS#12)" to "The certificate and its private key in one file, usually .p12 or .pfx."
            "cert" -> "Choose the Client Certificate (PEM)" to "The certificate file, usually .pem, .crt or .cer."
            "key" -> "Choose the Private Key (PEM)" to "The certificate's private key, usually .pem or .key."
            else -> throw RpcException("role must be pfx, cert or key", "invalid")
        }
        return FileChooserDescriptor(true, false, false, false, false, false).withTitle(title).withDescription(description)
    }

    /**
     * The entries the sidecar asks to store (`settings.writeClientCertificates`), checked: at most [MAX_ENTRIES]; an
     * entry already stored (same host ignoring case, same files) is kept as it is; any other entry needs a valid host
     * and either `pfx` or `cert` + `key`, all absolute paths. Throws [RpcException] (`invalid`) naming the entry, never a path.
     */
    fun entriesFromSidecar(raw: JsonElement?, stored: List<ClientCertificateEntry>): List<ClientCertificateEntry> {
        val list = raw as? JsonArray ?: throw RpcException("entries must be a list", "invalid")
        if (list.size() > MAX_ENTRIES) throw RpcException("At most $MAX_ENTRIES client certificates can be stored.", "invalid")
        val known = stored.map(::trimmed)
        return list.mapIndexed { i, el ->
            val n = i + 1
            val o = el as? JsonObject ?: throw RpcException("Entry $n must be an object.", "invalid")
            fun field(name: String): String? {
                val v = o.get(name) ?: return null
                if (v.isJsonNull) return null
                if (!v.isJsonPrimitive || !v.asJsonPrimitive.isString) throw RpcException("Entry $n: $name must be a string.", "invalid")
                return v.asString.takeIf { it.isNotEmpty() }
            }
            val entry = ClientCertificateEntry().also {
                it.host = field("host").orEmpty()
                it.pfx = field("pfx")
                it.cert = field("cert")
                it.key = field("key")
            }
            if (known.any { k -> sameEntry(k, trimmed(entry)) }) return@mapIndexed entry
            hostProblem(entry.host)?.let { throw RpcException("Entry $n: $it", "invalid") }
            val pfx = entry.pfx
            val cert = entry.cert
            val key = entry.key
            val files = if (pfx != null && cert == null && key == null) listOf(pfx)
            else if (pfx == null && cert != null && key != null) listOf(cert, key)
            else throw RpcException("Entry $n: give either a PKCS#12 file or a certificate and a key.", "invalid")
            files.forEach { f -> pathProblem(f)?.let { throw RpcException("Entry $n: $it", "invalid") } }
            entry.host = entry.host.trim()
            entry
        }
    }

    /**
     * REVIEW-14 #3: what the settings page's Apply stores. [base] is the list the page loaded, [mine] what its text says
     * now, [current] what is stored now (the panel may have added or removed an entry while the dialog was open).
     * Unchanged since loading → exactly [mine]. Otherwise only the page's own edits are applied to [current]: entries
     * the user deleted or changed go, entries the user typed are added (replacing the same host), except for a host the
     * panel changed meanwhile, whose newer entry is kept.
     */
    fun mergeEdits(
        base: List<ClientCertificateEntry>,
        mine: List<ClientCertificateEntry>,
        current: List<ClientCertificateEntry>,
    ): List<ClientCertificateEntry> {
        val baseKeys = base.map(::trimmed)
        if (current.map(::trimmed) == baseKeys) return mine
        val mineKeys = mine.map(::trimmed)
        val removed = baseKeys.filter { it !in mineKeys }
        val added = mine.filter { trimmed(it) !in baseKeys }
        val changedElsewhere = current.filter { trimmed(it) !in baseKeys }.map { trimmed(it).host }.toSet()
        val out = current.filter { trimmed(it) !in removed }.toMutableList()
        for (e in added) {
            val host = trimmed(e).host
            if (host in changedElsewhere) continue
            val at = out.indexOfFirst { trimmed(it).host == host }
            if (at >= 0) out[at] = e else out += e
        }
        return out
    }

    private fun trimmed(e: ClientCertificateEntry) = ClientCertificateEntry().also {
        it.host = e.host.trim().lowercase()
        it.pfx = e.pfx?.trim()?.takeIf(String::isNotEmpty)
        it.cert = e.cert?.trim()?.takeIf(String::isNotEmpty)
        it.key = e.key?.trim()?.takeIf(String::isNotEmpty)
    }

    private fun sameEntry(a: ClientCertificateEntry, b: ClientCertificateEntry) = a.host.isNotEmpty() && a == b

    /**
     * `secrets.setClientCertPassphrase` params: the checked host and the passphrase (null = delete). Never echoes the
     * value. Storing needs a valid host pattern; deleting accepts any one-line host up to [MAX_LEGACY_HOST] characters,
     * so the passphrase of an entry typed on the settings page with a host the proxy refuses can still be removed
     * (REVIEW-14 #6). The key is always under [PASSPHRASE_PREFIX].
     */
    fun passphraseRequest(p: JsonObject): Pair<String, String?> {
        val hostEl = p.get("host")
        val host = if (hostEl != null && hostEl.isJsonPrimitive && hostEl.asJsonPrimitive.isString) hostEl.asString else null
        val v = p.get("passphrase")
        val passphrase = when {
            v == null || v.isJsonNull -> null
            v.isJsonPrimitive && v.asJsonPrimitive.isString -> v.asString.takeIf { it.isNotEmpty() }
            else -> throw RpcException("passphrase must be a string", "invalid")
        }
        if (passphrase != null && passphrase.length > MAX_PASSPHRASE) throw RpcException("The passphrase is too long.", "invalid")
        if (passphrase != null) hostProblem(host)?.let { throw RpcException(it, "invalid") }
        else legacyHostProblem(host)?.let { throw RpcException(it, "invalid") }
        return host!!.trim() to passphrase
    }

    const val REMOVE_BUTTON = "Remove"

    /** The same question as the VS Code host's modal (REVIEW-14 #4). */
    fun removeQuestion(host: String) = "Remove the client certificate for ${host.trim().lowercase()}? Its passphrase is deleted too."

    /** A host good enough to name a passphrase to delete: one line, not blank, at most [MAX_LEGACY_HOST] characters. */
    fun legacyHostProblem(host: String?): String? {
        val h = host?.trim().orEmpty()
        return when {
            h.isEmpty() -> "The host is missing."
            h.length > MAX_LEGACY_HOST -> "The host is too long."
            h.any { it.isISOControl() } -> "The host is not a host name pattern."
            else -> null
        }
    }
}
