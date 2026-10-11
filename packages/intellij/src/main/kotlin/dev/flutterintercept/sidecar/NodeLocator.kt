// CONTRACTS §15.1: the sidecar runs on the user's Node (setting `nodePath`, else `node` on PATH), Node ≥ 18.
// Node comes from the settings or the environment only, never from the project (§15.2).
package dev.flutterintercept.sidecar

import java.io.File
import java.util.concurrent.TimeUnit

const val MIN_NODE_MAJOR = 18

sealed class NodeLookup {
    data class Found(val path: String, val version: String) : NodeLookup()
    data class Problem(val message: String) : NodeLookup()
}

/** Pure, testable lookup; [runVersion] runs `<node> --version` and returns its stdout (or null). */
class NodeLocator(
    private val isWindows: Boolean = System.getProperty("os.name").orEmpty().startsWith("Windows", ignoreCase = true),
    private val home: String = System.getProperty("user.home").orEmpty(),
    private val isExecutable: (File) -> Boolean = { it.isFile && it.canExecute() },
    private val runVersion: (String) -> String? = ::nodeVersionOutput,
    private val listDir: (File) -> List<File> = { it.listFiles()?.toList().orEmpty() },
) {
    private val exe get() = if (isWindows) "node.exe" else "node"

    /**
     * Directories searched for `node` when no path is configured: the PATH entries (the IDE's shell environment
     * first, then the process's own), then the usual install places a Dock-launched IDE doesn't see on its PATH.
     */
    fun searchDirs(pathEnvs: List<String?>): List<String> {
        val sep = if (isWindows) ";" else ":"
        val dirs = LinkedHashSet<String>()
        for (env in pathEnvs) env?.split(sep)?.map { it.trim() }?.filter { it.isNotEmpty() }?.forEach { dirs += it }
        if (isWindows) {
            System.getenv("ProgramFiles")?.let { dirs += "$it\\nodejs" }
            System.getenv("LOCALAPPDATA")?.let { dirs += "$it\\Programs\\nodejs" }
        } else {
            dirs += listOf("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin")
            if (home.isNotEmpty()) {
                dirs += "$home/.volta/bin"
                dirs += "$home/.asdf/shims"
                dirs += "$home/.local/share/mise/shims"
                dirs += "$home/.local/bin"
                // nvm: newest installed version first.
                newestVersionDirs(File("$home/.nvm/versions/node")).forEach { dirs += "${it.path}/bin" }
                newestVersionDirs(File("$home/.local/share/fnm/node-versions")).forEach { dirs += "${it.path}/installation/bin" }
            }
        }
        return dirs.toList()
    }

    private fun newestVersionDirs(root: File): List<File> =
        listDir(root).filter { it.name.startsWith("v") }.sortedWith(compareByDescending<File> { parseMajor(it.name) ?: -1 }.thenByDescending { it.name })

    /** Candidate executables in search order. A configured path is the only candidate. */
    fun candidates(configuredPath: String?, pathEnvs: List<String?>): List<String> {
        val configured = configuredPath?.trim().orEmpty()
        if (configured.isNotEmpty()) return listOf(configured)
        return searchDirs(pathEnvs).map { File(it, exe).path }
    }

    fun locate(configuredPath: String?, pathEnvs: List<String?>): NodeLookup {
        val configured = configuredPath?.trim().orEmpty()
        if (configured.isNotEmpty()) {
            val f = File(configured)
            if (!f.isAbsolute) return NodeLookup.Problem("The Node.js path in Settings → Tools → Flutter Intercept must be absolute: $configured")
            if (!isExecutable(f)) return NodeLookup.Problem("Node.js wasn't found at $configured (Settings → Tools → Flutter Intercept).")
            return check(configured) ?: NodeLookup.Problem("$configured didn't report a Node.js version.")
        }
        var tooOld: NodeLookup.Problem? = null
        for (candidate in candidates(null, pathEnvs)) {
            if (!isExecutable(File(candidate))) continue
            when (val r = check(candidate)) {
                is NodeLookup.Found -> return r
                is NodeLookup.Problem -> if (tooOld == null) tooOld = r
                null -> {}
            }
        }
        return tooOld ?: NodeLookup.Problem(
            "Flutter Intercept needs Node.js $MIN_NODE_MAJOR or later and couldn't find it. Install it (nodejs.org) " +
                "or set its path in Settings → Tools → Flutter Intercept.",
        )
    }

    /** Found when the version is new enough, Problem when too old, null when it didn't run. */
    private fun check(path: String): NodeLookup? {
        val out = runVersion(path) ?: return null
        val major = parseMajor(out) ?: return null
        val version = out.trim()
        return if (major >= MIN_NODE_MAJOR) NodeLookup.Found(path, version)
        else NodeLookup.Problem("Flutter Intercept needs Node.js $MIN_NODE_MAJOR or later; $path is $version.")
    }

    companion object {
        private val VERSION = Regex("""^\s*v?(\d+)\.(\d+)(?:\.(\d+))?""")

        /** Major version of `v20.11.1` / `20.11.1`, or null. */
        fun parseMajor(output: String): Int? = VERSION.find(output)?.groupValues?.get(1)?.toIntOrNull()
    }
}

/** Runs `<node> --version` with a 5 s limit; stdout or null. */
fun nodeVersionOutput(node: String): String? = try {
    val p = ProcessBuilder(node, "--version").redirectErrorStream(true).start()
    p.outputStream.close()
    if (!p.waitFor(5, TimeUnit.SECONDS)) {
        p.destroyForcibly()
        null
    } else if (p.exitValue() != 0) null
    else p.inputStream.bufferedReader().readText().take(200)
} catch (_: Exception) {
    null
}
