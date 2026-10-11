package dev.flutterintercept

import dev.flutterintercept.toolwindow.BrowserChoice
import dev.flutterintercept.toolwindow.FlutterEmbeddedBrowser
import dev.flutterintercept.toolwindow.FlutterEmbeddedBrowser.Plan
import dev.flutterintercept.toolwindow.chooseBrowser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Android Studio path (the Flutter plugin's JxBrowser) and its fallbacks. */
class FlutterEmbeddedBrowserTest {
    @Test
    fun browserOrder() {
        assertEquals(BrowserChoice.JCEF, chooseBrowser(jcefSupported = true, flutterEmbeddedPresent = true))
        assertEquals(BrowserChoice.FLUTTER, chooseBrowser(jcefSupported = false, flutterEmbeddedPresent = true))
        assertEquals(BrowserChoice.EXTERNAL, chooseBrowser(jcefSupported = false, flutterEmbeddedPresent = false))
    }

    @Test
    fun installationStatusPlans() {
        assertEquals(Plan.READY, FlutterEmbeddedBrowser.planFor("INSTALLED"))
        assertEquals(Plan.INSTALL, FlutterEmbeddedBrowser.planFor("NOT_INSTALLED"))
        assertEquals(Plan.WAIT, FlutterEmbeddedBrowser.planFor("INSTALLATION_IN_PROGRESS"))
        assertEquals(Plan.UNAVAILABLE, FlutterEmbeddedBrowser.planFor("INSTALLATION_FAILED"))
        assertEquals(Plan.UNAVAILABLE, FlutterEmbeddedBrowser.planFor("INSTALLATION_SKIPPED"))
        assertEquals(Plan.UNAVAILABLE, FlutterEmbeddedBrowser.planFor("SOMETHING_NEW"))
        assertEquals(Plan.UNAVAILABLE, FlutterEmbeddedBrowser.planFor(null))
    }

    @Test
    fun theFlutterPluginApiIsFoundOnTheBuildClasspath() {
        // Compiled against Flutter plugin 97: the classes and methods the adapter reflects on exist.
        assertTrue(FlutterEmbeddedBrowser().isPresent())
    }

    @Test
    fun aChangedFlutterPluginDegradesToUnavailable() {
        val renamed = FlutterEmbeddedBrowser(names = FlutterEmbeddedBrowser.ClassNames(embeddedBrowser = "io.flutter.jxbrowser.Gone"))
        assertFalse(renamed.isPresent())
        val noManager = FlutterEmbeddedBrowser(names = FlutterEmbeddedBrowser.ClassNames(manager = "io.flutter.Nope"))
        assertFalse(noManager.isPresent())
        // A class that exists but lacks the expected methods.
        val wrongShape = FlutterEmbeddedBrowser(names = FlutterEmbeddedBrowser.ClassNames(tab = "java.lang.Runnable"))
        assertFalse(wrongShape.isPresent())
    }

    @Test
    fun noFlutterPluginAtAll() {
        val isolated = FlutterEmbeddedBrowser(classLoader = ClassLoader.getPlatformClassLoader())
        assertFalse(isolated.isPresent())
    }
}
