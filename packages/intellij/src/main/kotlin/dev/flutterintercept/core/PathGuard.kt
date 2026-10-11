// `ui.openFile` guard, mirroring the VS Code host (packages/extension/src/source/resolve.ts checkSourcePath /
// packageRootsFor, REVIEW-3 #3): files open only from the workspace folders and the package roots named by their
// package configs (pub cache, path and git dependencies), both sides resolved through symlinks. Paths can come from
// the app (stack frames), so anything else, relative paths and UNC paths are refused.
package dev.flutterintercept.core

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.File
import java.net.URI
import java.nio.file.Path
import java.nio.file.Paths

class PathRefusedException(message: String) : RuntimeException(message)

object PathGuard {
    fun isUncPath(p: String): Boolean = p.startsWith("\\\\") || p.startsWith("//")

    /** Root directories of every package in `<root>/.dart_tool/package_config.json` of each project root. */
    fun packageRoots(projectRoots: List<String>): List<String> {
        val out = LinkedHashSet<String>()
        for (root in projectRoots) {
            val config = File(root, ".dart_tool/package_config.json")
            if (!config.isFile) continue
            val json = try {
                JsonParser.parseString(config.readText()) as? JsonObject
            } catch (_: Exception) {
                null
            } ?: continue
            val packages = json.getAsJsonArray("packages") ?: continue
            val base = config.toURI()
            for (entry in packages) {
                val rootUri = (entry as? JsonObject)?.get("rootUri")?.takeIf { it.isJsonPrimitive }?.asString ?: continue
                resolvePackageRoot(base, rootUri)?.let { out += it }
            }
        }
        return out.toList()
    }

    /** `rootUri` resolved against the package config's own URI; only local `file:` paths. */
    fun resolvePackageRoot(configUri: URI, rootUri: String): String? = try {
        val resolved = configUri.resolve(if (rootUri.endsWith("/")) rootUri else "$rootUri/")
        if (resolved.scheme != "file" || !resolved.authority.isNullOrEmpty()) null
        else Paths.get(resolved).normalize().toString().takeUnless(::isUncPath)
    } catch (_: Exception) {
        null
    }

    /**
     * The real path of [path] when it is a local file inside one of [allowedRoots] (symlinks resolved on both sides),
     * else throws [PathRefusedException] with a readable message that names only the file.
     */
    fun check(path: String, allowedRoots: List<String>, realpath: (Path) -> Path = { it.toRealPath() }): Path {
        val name = File(path).name
        val outside = "This file is outside the project: $name"
        if (path.isBlank() || isUncPath(path) || !File(path).isAbsolute) throw PathRefusedException(outside)
        val real = try {
            realpath(Paths.get(path))
        } catch (_: Exception) {
            throw PathRefusedException("File not found: $name")
        }
        if (isUncPath(real.toString())) throw PathRefusedException(outside)
        val roots = allowedRoots.mapNotNull { r ->
            try {
                realpath(Paths.get(r)).takeUnless { isUncPath(it.toString()) }
            } catch (_: Exception) {
                null // a root that doesn't exist allows nothing
            }
        }
        if (roots.none { real.startsWith(it) }) throw PathRefusedException(outside)
        return real
    }
}
