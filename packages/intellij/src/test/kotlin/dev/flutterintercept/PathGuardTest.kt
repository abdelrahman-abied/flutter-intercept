package dev.flutterintercept

import dev.flutterintercept.core.PathGuard
import dev.flutterintercept.core.PathRefusedException
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** `ui.openFile` guard: the same rules as the VS Code host's checkSourcePath / packageRootsFor (REVIEW-3 #3). */
class PathGuardTest {
    private lateinit var tmp: File
    private lateinit var project: File
    private lateinit var pubCache: File
    private lateinit var outside: File

    @Before
    fun setUp() {
        tmp = Files.createTempDirectory("fi-guard").toFile().canonicalFile
        project = File(tmp, "app").apply { mkdirs() }
        File(project, "lib").mkdirs()
        File(project, "lib/main.dart").writeText("void main() {}")
        File(project, "pubspec.yaml").writeText("name: app")
        pubCache = File(tmp, "pub-cache/hosted/pub.dev/http-1.2.0").apply { mkdirs() }
        File(pubCache, "lib").mkdirs()
        File(pubCache, "lib/http.dart").writeText("library http;")
        outside = File(tmp, "secret").apply { mkdirs() }
        File(outside, "id_rsa").writeText("x")
        File(project, ".dart_tool").mkdirs()
        File(project, ".dart_tool/package_config.json").writeText(
            """
            {"configVersion": 2, "packages": [
              {"name": "app", "rootUri": "../", "packageUri": "lib/"},
              {"name": "http", "rootUri": "${pubCache.toURI()}", "packageUri": "lib/"},
              {"name": "remote", "rootUri": "https://example.com/pkg", "packageUri": "lib/"},
              {"name": "unc", "rootUri": "file://server/share/pkg", "packageUri": "lib/"},
              {"name": "broken"}
            ]}
            """.trimIndent(),
        )
    }

    @After
    fun tearDown() {
        tmp.deleteRecursively()
    }

    private fun refused(path: String, roots: List<String>): String {
        try {
            PathGuard.check(path, roots)
        } catch (e: PathRefusedException) {
            return e.message!!
        }
        fail("expected $path to be refused")
        throw AssertionError()
    }

    @Test
    fun packageRootsComeFromThePackageConfig() {
        val roots = PathGuard.packageRoots(listOf(project.path)).map { File(it).canonicalPath }
        assertEquals(listOf(project.canonicalPath, pubCache.canonicalPath), roots)
    }

    @Test
    fun missingPackageConfigGivesNoRoots() {
        assertTrue(PathGuard.packageRoots(listOf(outside.path)).isEmpty())
        File(outside, ".dart_tool").mkdirs()
        File(outside, ".dart_tool/package_config.json").writeText("{ not json")
        assertTrue(PathGuard.packageRoots(listOf(outside.path)).isEmpty())
    }

    @Test
    fun opensFilesInTheProjectAndPackages() {
        val roots = listOf(project.path) + PathGuard.packageRoots(listOf(project.path))
        assertEquals(File(project, "lib/main.dart").canonicalPath, PathGuard.check(File(project, "lib/main.dart").path, roots).toString())
        assertEquals(File(pubCache, "lib/http.dart").canonicalPath, PathGuard.check(File(pubCache, "lib/http.dart").path, roots).toString())
    }

    @Test
    fun refusesFilesOutsideTheRoots() {
        val roots = listOf(project.path) + PathGuard.packageRoots(listOf(project.path))
        assertEquals("This file is outside the project: id_rsa", refused(File(outside, "id_rsa").path, roots))
        assertEquals("This file is outside the project: id_rsa", refused(File(project, "../secret/id_rsa").path, roots))
    }

    @Test
    fun refusesSiblingWithTheSamePrefix() {
        val sibling = File(tmp, "app2").apply { mkdirs() }
        File(sibling, "x.dart").writeText("")
        refused(File(sibling, "x.dart").path, listOf(project.path))
    }

    @Test
    fun refusesSymlinkEscapes() {
        val link = File(project, "lib/escape.dart")
        try {
            Files.createSymbolicLink(link.toPath(), File(outside, "id_rsa").toPath())
        } catch (_: Exception) {
            return // no symlinks on this file system
        }
        refused(link.path, listOf(project.path))
        // A symlinked root still allows its real contents.
        val rootLink = File(tmp, "applink")
        Files.createSymbolicLink(rootLink.toPath(), project.toPath())
        assertEquals(File(project, "lib/main.dart").canonicalPath, PathGuard.check(File(project, "lib/main.dart").path, listOf(rootLink.path)).toString())
    }

    @Test
    fun refusesRelativeUncAndMissing() {
        val roots = listOf(project.path)
        refused("lib/main.dart", roots)
        refused("\\\\server\\share\\x.dart", roots)
        refused("//server/share/x.dart", roots)
        refused("", roots)
        assertEquals("File not found: nope.dart", refused(File(project, "lib/nope.dart").path, roots))
    }

    @Test
    fun rootsThatDoNotExistAllowNothing() {
        refused(File(project, "lib/main.dart").path, listOf(File(tmp, "missing").path))
    }

    @Test
    fun resolvesRelativeAndRejectsNonFileRootUris() {
        val base = File(project, ".dart_tool/package_config.json").toURI()
        assertEquals(project.canonicalPath, File(PathGuard.resolvePackageRoot(base, "../")!!).canonicalPath)
        assertNull(PathGuard.resolvePackageRoot(base, "https://example.com/x"))
        assertNull(PathGuard.resolvePackageRoot(base, "file://server/share"))
    }
}
