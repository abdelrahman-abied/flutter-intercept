package dev.flutterintercept

import dev.flutterintercept.sidecar.NodeLocator
import dev.flutterintercept.sidecar.NodeLookup
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class NodeLocatorTest {
    private fun locator(executables: Set<String>, versions: Map<String, String?>, dirs: Map<String, List<String>> = emptyMap(), windows: Boolean = false) =
        NodeLocator(
            isWindows = windows,
            home = "/Users/me",
            isExecutable = { it.path in executables },
            runVersion = { versions[it] },
            listDir = { d -> dirs[d.path].orEmpty().map { File(d, it) } },
        )

    @Test
    fun parsesVersions() {
        assertEquals(20, NodeLocator.parseMajor("v20.11.1\n"))
        assertEquals(18, NodeLocator.parseMajor("18.0.0"))
        assertEquals(26, NodeLocator.parseMajor("v26.4.0"))
        assertNull(NodeLocator.parseMajor("command not found"))
        assertNull(NodeLocator.parseMajor(""))
    }

    @Test
    fun configuredPathIsTheOnlyCandidate() {
        val l = locator(setOf("/custom/node", "/opt/homebrew/bin/node"), mapOf("/custom/node" to "v22.1.0", "/opt/homebrew/bin/node" to "v24.0.0"))
        assertEquals(listOf("/custom/node"), l.candidates("/custom/node", listOf("/usr/bin")))
        assertEquals(NodeLookup.Found("/custom/node", "v22.1.0"), l.locate(" /custom/node ", listOf("/opt/homebrew/bin")))
    }

    @Test
    fun configuredPathMustBeAbsoluteAndExist() {
        val l = locator(emptySet(), emptyMap())
        assertTrue((l.locate("node", emptyList()) as NodeLookup.Problem).message.contains("absolute"))
        assertTrue((l.locate("/nope/node", emptyList()) as NodeLookup.Problem).message.contains("wasn't found"))
    }

    @Test
    fun configuredPathTooOldIsReported() {
        val l = locator(setOf("/old/node"), mapOf("/old/node" to "v16.20.0"))
        val p = l.locate("/old/node", emptyList()) as NodeLookup.Problem
        assertTrue(p.message, p.message.contains("18 or later") && p.message.contains("v16.20.0"))
    }

    @Test
    fun searchesPathThenDockLaunchedLocations() {
        val dirs = locator(emptySet(), emptyMap()).searchDirs(listOf("/shell/bin:/usr/bin", "/usr/bin:/proc/bin"))
        assertEquals(listOf("/shell/bin", "/usr/bin", "/proc/bin"), dirs.take(3))
        assertTrue(dirs.indexOf("/opt/homebrew/bin") > 2)
        assertTrue(dirs.contains("/usr/local/bin"))
        assertTrue(dirs.contains("/Users/me/.volta/bin"))
    }

    @Test
    fun findsHomebrewNodeWhenPathIsMinimal() {
        val l = locator(setOf("/opt/homebrew/bin/node"), mapOf("/opt/homebrew/bin/node" to "v26.4.0"))
        assertEquals(NodeLookup.Found("/opt/homebrew/bin/node", "v26.4.0"), l.locate("", listOf("/usr/bin:/bin")))
    }

    @Test
    fun skipsTooOldNodeForANewerOne() {
        val l = locator(
            setOf("/usr/bin/node", "/usr/local/bin/node"),
            mapOf("/usr/bin/node" to "v14.0.0", "/usr/local/bin/node" to "v20.0.0"),
        )
        assertEquals(NodeLookup.Found("/usr/local/bin/node", "v20.0.0"), l.locate(null, listOf("/usr/bin:/usr/local/bin")))
    }

    @Test
    fun reportsTooOldWhenNothingNewer() {
        val l = locator(setOf("/usr/bin/node"), mapOf("/usr/bin/node" to "v16.0.0"))
        val p = l.locate(null, listOf("/usr/bin")) as NodeLookup.Problem
        assertTrue(p.message.contains("v16.0.0"))
    }

    @Test
    fun reportsMissingNode() {
        val p = locator(emptySet(), emptyMap()).locate(null, listOf("/usr/bin")) as NodeLookup.Problem
        assertTrue(p.message.contains("couldn't find"))
    }

    @Test
    fun prefersNewestNvmVersion() {
        val l = locator(
            setOf("/Users/me/.nvm/versions/node/v20.1.0/bin/node", "/Users/me/.nvm/versions/node/v9.0.0/bin/node"),
            mapOf("/Users/me/.nvm/versions/node/v20.1.0/bin/node" to "v20.1.0", "/Users/me/.nvm/versions/node/v9.0.0/bin/node" to "v9.0.0"),
            dirs = mapOf("/Users/me/.nvm/versions/node" to listOf("v9.0.0", "v20.1.0")),
        )
        assertEquals(NodeLookup.Found("/Users/me/.nvm/versions/node/v20.1.0/bin/node", "v20.1.0"), l.locate(null, emptyList()))
    }

    @Test
    fun windowsLooksForNodeExe() {
        val l = locator(emptySet(), emptyMap(), windows = true)
        assertTrue(l.candidates(null, listOf("C:\\a;C:\\b")).take(2).all { it.endsWith("node.exe") })
    }

    @Test
    fun theRealNodeOnThisMachineIsDetectedIfInstalled() {
        // Smoke test against the real environment; passes vacuously without Node.
        val r = NodeLocator().locate(null, listOf(System.getenv("PATH")))
        if (r is NodeLookup.Found) assertTrue(NodeLocator.parseMajor(r.version)!! >= 18)
    }
}
