package dev.flutterintercept

import com.intellij.openapi.application.PathManager
import dev.flutterintercept.sidecar.PLUGIN_FOLDER
import dev.flutterintercept.sidecar.SidecarProcess
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.zip.ZipFile

/**
 * The sidecar is found in an installed plugin without the development system property: the distribution zip
 * (`./gradlew buildPlugin`) unpacked into a plugins directory, as "Install Plugin from Disk" does.
 */
class InstalledPluginTest {
    private fun unpackedPlugin(): Pair<File, File>? {
        val zip = File("build/distributions").listFiles { f -> f.name.startsWith("$PLUGIN_FOLDER-") && f.name.endsWith(".zip") }?.maxByOrNull { it.lastModified() }
            ?: return null
        val pluginsDir = Files.createTempDirectory("fi-plugins").toFile()
        ZipFile(zip).use { z ->
            for (e in z.entries()) {
                val out = File(pluginsDir, e.name).canonicalFile
                check(out.path.startsWith(pluginsDir.canonicalPath))
                if (e.isDirectory) out.mkdirs() else { out.parentFile.mkdirs(); z.getInputStream(e).use { i -> out.outputStream().use { i.copyTo(it) } } }
            }
        }
        return pluginsDir to File(pluginsDir, PLUGIN_FOLDER)
    }

    @Test
    fun findsTheBundledSidecarFromThePluginJar() {
        val (pluginsDir, plugin) = unpackedPlugin() ?: return assumeTrue("run ./gradlew buildPlugin first", false)
        try {
            val jar = File(plugin, "lib").listFiles { f -> f.name.endsWith(".jar") }!!.single()
            val found = SidecarProcess.sidecarCandidates(jar, null).first()
            assertTrue(found.path, found.isFile)
            assertEquals(File(plugin, "sidecar/sidecar.js").canonicalPath, found.canonicalPath)
            assertTrue(File(plugin, "sidecar/webview").isDirectory)
            // The jar's plugin.xml carries the patched id and version (pluginVersion reads it).
            val xml = ZipFile(jar).use { z -> z.getInputStream(z.getEntry("META-INF/plugin.xml")).bufferedReader().readText() }
            assertTrue(xml.contains("<id>dev.flutterintercept</id>") && Regex("<version>\\d+\\.\\d+\\.\\d+</version>").containsMatchIn(xml))
            // Fallback: the plugins directory alone.
            assertTrue(SidecarProcess.sidecarCandidates(null, pluginsDir).single().isFile)
        } finally {
            pluginsDir.deleteRecursively()
        }
    }

    @Test
    fun jarPathForAClassLoadedFromAJar() {
        // The public API pluginJar() uses, on a class that comes from a jar (JUnit's).
        val path = PathManager.getJarPathForClass(org.junit.Assert::class.java)
        assertTrue("$path", path != null && path.endsWith(".jar") && File(path).isFile)
    }

    @Test
    fun missingLocationsGiveNoCandidates() {
        assertTrue(SidecarProcess.sidecarCandidates(File("/nope/lib/x.jar"), null).isEmpty())
    }
}
