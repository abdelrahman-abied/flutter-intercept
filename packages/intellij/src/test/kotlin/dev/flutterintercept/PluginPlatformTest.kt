package dev.flutterintercept

import com.google.gson.JsonParser
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import dev.flutterintercept.api.DeviceKind
import dev.flutterintercept.api.InterceptSidecar
import dev.flutterintercept.api.LaunchPlan
import dev.flutterintercept.api.LaunchRequest
import dev.flutterintercept.core.InterceptSidecarImpl
import dev.flutterintercept.settings.InterceptSettings
import dev.flutterintercept.sidecar.RpcException
import dev.flutterintercept.sidecar.SIDECAR_PATH_PROPERTY
import dev.flutterintercept.sidecar.SidecarProcess
import dev.flutterintercept.ui.UiRequestHandler
import java.awt.datatransfer.DataFlavor
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException

/** The plugin inside the IDE test environment: services, `ui.*` handlers and the real sidecar through SidecarProcess. */
class PluginPlatformTest : BasePlatformTestCase() {
    private fun <T> await(f: CompletableFuture<T>): T {
        while (!f.isDone) PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        return f.get()
    }

    private fun handle(method: String, json: String) = await(UiRequestHandler.handle(method, JsonParser.parseString(json)))

    fun testServicesAreRegistered() {
        assertInstanceOf(InterceptSidecar.getInstance(project), InterceptSidecarImpl::class.java)
        assertNotNull(InterceptSettings.getInstance())
        assertNotNull(SidecarProcess.getInstance())
    }

    fun testClipboard() {
        handle("ui.clipboard", """{"text":"curl https://api.example"}""")
        assertEquals("curl https://api.example", CopyPasteManager.getInstance().getContents<String>(DataFlavor.stringFlavor))
    }

    fun testOpenUntitledOpensAnEditor() {
        handle("ui.openUntitled", """{"files":[{"name":"response","content":"{\"a\":1}","language":"json"}]}""")
        val open = FileEditorManager.getInstance(project).openFiles.map { it.name }
        assertTrue(open.toString(), "response.json" in open)
    }

    fun testOpenFileOutsideTheProjectIsRefused() {
        val outside = Files.createTempFile("fi-outside", ".dart").toFile()
        try {
            val e = try { handle("ui.openFile", """{"path":${JsonParser.parseString("\"${outside.path}\"")}}"""); null } catch (e: ExecutionException) { e.cause }
            assertTrue("$e", e is RpcException && e.message!!.startsWith("This file is outside the project"))
        } finally {
            outside.delete()
        }
    }

    fun testUnknownRequestIsAnError() {
        val e = try { handle("ui.nope", "{}"); null } catch (e: ExecutionException) { e.cause }
        assertTrue(e is RpcException)
        assertEquals("unknown_method", (e as RpcException).code)
    }

    fun testSidecarSecretsRoundTrip() {
        handle("secrets.set", """{"key":"flutterIntercept.testSecret","value":"s3cret"}""")
        assertEquals("s3cret", handle("secrets.get", """{"key":"flutterIntercept.testSecret"}"""))
        handle("secrets.set", """{"key":"flutterIntercept.testSecret"}""")
        assertNull(handle("secrets.get", """{"key":"flutterIntercept.testSecret"}"""))
        val e = try { handle("secrets.get", """{"key":"other.key"}"""); null } catch (e: ExecutionException) { e.cause }
        assertTrue(e is RpcException)
    }

    fun testChangedFlutterPluginApiFallsBackCleanly() {
        val renamed = dev.flutterintercept.toolwindow.FlutterEmbeddedBrowser(
            names = dev.flutterintercept.toolwindow.FlutterEmbeddedBrowser.ClassNames(embeddedBrowser = "io.flutter.jxbrowser.Gone"),
        )
        assertNotNull(renamed.ensureInstalled(project, 1))
        val guard = dev.flutterintercept.toolwindow.NavigationGuard({ null }, {}, {})
        val r = renamed.open(project, guard, testRootDisposable)
        assertTrue(r is dev.flutterintercept.toolwindow.FlutterEmbeddedBrowser.Result.Unavailable)
    }

    fun testDataDirIsDurableAndPrivate() {
        val dir = SidecarProcess.dataDir()
        assertTrue(dir.path, dir.path.startsWith(com.intellij.openapi.application.PathManager.getConfigPath()))
        if (!System.getProperty("os.name").startsWith("Windows")) {
            assertEquals("rwx------", java.nio.file.attribute.PosixFilePermissions.toString(Files.getPosixFilePermissions(dir.toPath())))
        }
    }

    fun testRealSidecarStartsAndPreparesALaunch() {
        val script = File("../sidecar/dist/sidecar.js").absoluteFile
        if (!script.isFile) return // bundle not built
        System.setProperty(SIDECAR_PATH_PROPERTY, script.path)
        System.setProperty("flutter.intercept.dev", "true") // the override needs it (and a sandbox)
        val settings = InterceptSettings.getInstance()
        val before = settings.snapshot()
        settings.update(settings.snapshot().apply { port = 18_899; agentAccess = "off"; agentMcpPort = 18_823 })
        val sidecar = SidecarProcess.getInstance()
        try {
            val conn = sidecar.ensureStarted(30_000)
            assertNotNull("sidecar didn't start: ${sidecar.startProblem}", conn)
            assertTrue(sidecar.init!!.uiUrl.startsWith("http://127.0.0.1:"))

            val app = Files.createTempDirectory("fi-app").toFile()
            File(app, "pubspec.yaml").writeText("name: app\ndependencies:\n  flutter:\n    sdk: flutter\n")
            File(app, "lib").mkdirs()
            File(app, "lib/main.dart").writeText("void main() {}\n")
            val service = InterceptSidecar.getInstance(project)
            val started = System.currentTimeMillis()
            val plan = service.prepareLaunch(LaunchRequest("l1", app.path, File(app, "lib/main.dart").path, "emulator-5554", DeviceKind.ANDROID_EMULATOR, "debug", emptyList()))
            assertTrue("bounded", System.currentTimeMillis() - started < 11_000)
            assertTrue("$plan", plan is LaunchPlan.Rewrite || plan is LaunchPlan.Skip)
            assertTrue(service.prepareLaunch(LaunchRequest("l2", app.path, File(app, "lib/main.dart").path, null, DeviceKind.ANDROID_EMULATOR, "release", emptyList())) is LaunchPlan.Skip)
            service.sessionStarted("l1", "s1", "emulator-5554", null, null)
            service.sessionEnded("s1")
            sidecar.pushTheme()
            sidecar.setUiVisible(true)
            // Regression (0.9.1): opening the tool window while the sidecar already runs called showUi() from
            // `init` before the panel's later properties existed (NPE, empty "Nothing to show" tool window).
            val panel = dev.flutterintercept.toolwindow.InterceptToolWindowPanel(project)
            com.intellij.openapi.util.Disposer.dispose(panel)
            app.deleteRecursively()
        } finally {
            sidecar.dispose()
            settings.update(before)
            System.clearProperty(SIDECAR_PATH_PROPERTY)
            System.clearProperty("flutter.intercept.dev")
        }
    }
}
