// Client certificates (mTLS): the settings page edits them as lines; passphrases live in the IDE's password safe
// under the same key names as VS Code's secret storage (packages/extension/src/ui/clientCerts.ts).
package dev.flutterintercept.settings

import com.intellij.credentialStore.Credentials
import com.intellij.ide.passwordSafe.PasswordSafe
import dev.flutterintercept.ui.UiRequestHandler

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
}
