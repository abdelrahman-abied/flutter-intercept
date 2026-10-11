package dev.flutterintercept

import dev.flutterintercept.sidecar.SidecarProcess
import dev.flutterintercept.toolwindow.BrowserLauncher
import dev.flutterintercept.toolwindow.NavigationGuard
import dev.flutterintercept.toolwindow.NavigationGuard.Decision
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions

/** REVIEW-9 #3 (redirect file instead of a URL on a command line), #4 (JCEF guard), #7 (durable data dir). */
class BrowserLauncherTest {
    private lateinit var tmp: File
    private val posix = !System.getProperty("os.name").startsWith("Windows")

    @Before
    fun setUp() {
        tmp = Files.createTempDirectory("fi-browser").toFile()
    }

    @After
    fun tearDown() {
        tmp.deleteRecursively()
    }

    @Test
    fun theBrowserGetsAPrivateRedirectFileNotTheUrl() {
        val url = "http://127.0.0.1:51234/?t=ONE_TIME_TOKEN_abc"
        val handed = mutableListOf<File>()
        val dir = BrowserLauncher.redirectDir(tmp)
        val file = BrowserLauncher.writeRedirect(url, dir)
        handed += file
        assertFalse("the launcher argument carries no token", handed.single().path.contains("t=") || handed.single().path.contains("ONE_TIME"))
        val html = file.readText()
        assertTrue(html.contains("""content="0;url=http://127.0.0.1:51234/?t=ONE_TIME_TOKEN_abc""""))
        assertTrue(html.contains("location.replace("))
        assertTrue(html.contains("no-referrer"))
        assertTrue(file.name.matches(Regex("open-[0-9a-f]{32}\\.html")))
        if (posix) {
            assertEquals("rw-------", PosixFilePermissions.toString(Files.getPosixFilePermissions(file.toPath())))
            assertEquals("rwx------", PosixFilePermissions.toString(Files.getPosixFilePermissions(dir.toPath())))
        }
        assertFalse("random names", file.name == BrowserLauncher.writeRedirect(url, dir).name)
    }

    @Test
    fun urlCannotBreakOutOfTheHtml() {
        val html = BrowserLauncher.writeRedirect("http://127.0.0.1:1/?t=a\"><script>x</script>&b='c'", tmp).readText()
        assertFalse(html.contains("<script>x</script>"))
        assertFalse(html.contains("a\"><"))
        assertFalse(html.contains("'c'"))
    }

    @Test
    fun onlyLoopbackUrls() {
        try {
            BrowserLauncher.writeRedirect("https://evil.example/", tmp)
            org.junit.Assert.fail()
        } catch (_: IllegalArgumentException) {
        }
    }

    @Test
    fun oldRedirectFilesAreDeleted() {
        val f = BrowserLauncher.writeRedirect("http://127.0.0.1:1/?t=x", tmp)
        val fresh = BrowserLauncher.writeRedirect("http://127.0.0.1:1/?t=y", tmp)
        f.setLastModified(System.currentTimeMillis() - BrowserLauncher.LIFETIME_MS - 1_000)
        BrowserLauncher.cleanup(tmp)
        assertFalse(f.exists())
        assertTrue(fresh.exists())
    }

    @Test
    fun aRestartOnANewPortStaysInJcefAndNeverOpensTheBrowser() {
        var origin: String? = "http://127.0.0.1:50000"
        var external = 0
        var fresh = 0
        val guard = NavigationGuard({ origin }, { fresh++ }, { external++ })
        guard.expect("http://127.0.0.1:50000/?t=a")
        assertEquals(Decision.ALLOW, guard.decide("http://127.0.0.1:50000/?t=a"))
        // Sidecar restarted on another port; the tool window loads a fresh URL from it.
        origin = "http://127.0.0.1:60000"
        guard.expect("http://127.0.0.1:60000/?t=b")
        assertFalse(guard.onBeforeBrowse("http://127.0.0.1:60000/?t=b"))
        // Stale URLs of the old port, reloads of a spent token or of the scrubbed "/": fetch fresh, never external.
        assertTrue(guard.onBeforeBrowse("http://127.0.0.1:50000/?t=a"))
        assertTrue(guard.onBeforeBrowse("http://127.0.0.1:60000/?t=b"))
        assertTrue(guard.onBeforeBrowse("http://127.0.0.1:60000/"))
        guard.onPopup("http://127.0.0.1:60000/?t=b")
        assertEquals(0, external)
        assertEquals(3, fresh)
    }

    @Test
    fun externalLinksGoToTheSystemBrowser() {
        val opened = mutableListOf<String>()
        val guard = NavigationGuard({ "http://127.0.0.1:1" }, {}, { opened += it })
        assertTrue(guard.onBeforeBrowse("https://pub.dev/packages/http"))
        guard.onPopup("https://docs.flutter.dev")
        assertEquals(Decision.BLOCK, guard.decide("file:///etc/passwd"))
        assertEquals(Decision.BLOCK, guard.decide("javascript:alert(1)"))
        assertEquals(Decision.ALLOW, guard.decide("about:blank"))
        assertEquals(listOf("https://pub.dev/packages/http", "https://docs.flutter.dev"), opened)
    }

    @Test
    fun theOldDataFolderMovesOnce() {
        val old = File(tmp, "system/flutter-intercept").apply { mkdirs() }
        File(old, "flutter-intercept-ca.json").writeText("{}")
        val new = File(tmp, "config/flutter-intercept")
        assertTrue(SidecarProcess.migrateDataDir(old, new))
        assertTrue(File(new, "flutter-intercept-ca.json").isFile)
        assertFalse(old.exists())
        // Never overwrites a populated new folder.
        old.mkdirs()
        File(old, "flutter-intercept-ca.json").writeText("OLD")
        assertFalse(SidecarProcess.migrateDataDir(old, new))
        assertEquals("{}", File(new, "flutter-intercept-ca.json").readText())
    }
}
