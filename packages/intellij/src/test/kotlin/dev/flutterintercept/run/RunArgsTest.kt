package dev.flutterintercept.run

import dev.flutterintercept.api.DeviceKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

class RunArgsTest {
    @Test
    fun parseJoinRoundTrip() {
        val args = listOf("--dart-define=A=1", "--dart-define=PATH=/tmp/with space", "--web-browser-flag=--x=\"q\"", "-v")
        assertEquals(args, RunArgs.parse(RunArgs.join(args)))
        assertEquals(emptyList<String>(), RunArgs.parse(null))
        assertEquals(emptyList<String>(), RunArgs.parse("   "))
        assertEquals(listOf("--flavor", "dev", "two words"), RunArgs.parse("--flavor dev \"two words\""))
    }

    @Test
    fun targetForms() {
        assertNull(RunArgs.targetOf(listOf("--track-widget-creation", "-v")))
        assertEquals("lib/a.dart", RunArgs.targetOf(listOf("-t", "lib/a.dart")))
        assertEquals("lib/a.dart", RunArgs.targetOf(listOf("-tlib/a.dart")))
        assertEquals("lib/a.dart", RunArgs.targetOf(listOf("--target", "lib/a.dart")))
        assertEquals("lib/b.dart", RunArgs.targetOf(listOf("--target=lib/a.dart", "-t", "lib/b.dart")))
        assertEquals(
            listOf("--dart-define=X=1", "--track-widget-creation"),
            RunArgs.stripTarget(listOf("-t", "a.dart", "--dart-define=X=1", "--target=b.dart", "-tc.dart", "--track-widget-creation", "--target", "d.dart")),
        )
        assertEquals(listOf("-v", "--target=.dart_tool/e.dart"), RunArgs.withTarget(listOf("-t", "lib/main_dev.dart", "-v"), ".dart_tool/e.dart"))
    }

    @Test
    fun targetArgIsRelativeInsideTheApp() {
        val app = Path.of("/work/app")
        assertEquals(".dart_tool/flutter_intercept/entry_lib__main.dart", RunArgs.targetArg(app.resolve(".dart_tool/flutter_intercept/entry_lib__main.dart"), app))
        assertEquals("/elsewhere/e.dart", RunArgs.targetArg(Path.of("/elsewhere/e.dart"), app))
    }

    @Test
    fun patchedArgsAddTheEntryOnlyWhenTheProgramChanges() {
        val app = Path.of("/work/app")
        val main = app.resolve("lib/main.dart")
        val entry = app.resolve(".dart_tool/flutter_intercept/entry_lib__main.dart")
        val sidecar = listOf("--flavor-arg", "--dart-define=FLUTTER_INTERCEPT_PROXY=10.0.2.2:8899")
        assertEquals(sidecar + "--target=.dart_tool/flutter_intercept/entry_lib__main.dart", RunArgs.patchedArgs(sidecar, entry, main, app))
        val web = listOf("--web-browser-flag=--proxy-server=http://127.0.0.1:8899")
        assertEquals(web, RunArgs.patchedArgs(web, main, main, app))
    }

    @Test
    fun modes() {
        assertEquals("debug", RunArgs.flutterMode("DEBUG", false, emptyList()))
        assertEquals("profile", RunArgs.flutterMode("PROFILE", false, emptyList()))
        assertEquals("profile", RunArgs.flutterMode("DEBUG", true, emptyList()))
        assertEquals("profile", RunArgs.flutterMode(null, false, listOf("--profile")))
        assertEquals("release", RunArgs.flutterMode("RELEASE", false, emptyList()))
        assertEquals("release", RunArgs.flutterMode("DEBUG", true, listOf("--release")))
    }

    @Test
    fun deviceKindsFromDaemonFields() {
        // Values measured from `flutter daemon` device.added events (docs/spikes/intellij-run.md).
        assertEquals(DeviceKind.ANDROID_EMULATOR, RunArgs.deviceKind("emulator-5554", "android-arm64", "android", true))
        assertEquals(DeviceKind.ANDROID_EMULATOR, RunArgs.deviceKind("emulator-5556", "android-x64", null, false))
        assertEquals(DeviceKind.ANDROID_DEVICE, RunArgs.deviceKind("R5CT1234", "android-arm64", "android", false))
        assertEquals(DeviceKind.IOS_SIMULATOR, RunArgs.deviceKind("1F2E-SIM", "ios", "ios", true))
        assertEquals(DeviceKind.IOS_DEVICE, RunArgs.deviceKind("00008110-X", "ios", "ios", false))
        assertEquals(DeviceKind.MACOS, RunArgs.deviceKind("macos", "darwin", "macos", false))
        assertEquals(DeviceKind.LINUX, RunArgs.deviceKind("linux", "linux-x64", "linux", false))
        assertEquals(DeviceKind.WINDOWS, RunArgs.deviceKind("windows", "windows-x64", "windows", false))
        assertEquals(DeviceKind.WEB, RunArgs.deviceKind("chrome", "web-javascript", "web", false))
        assertEquals(DeviceKind.WEB, RunArgs.deviceKind("web-server", "web-javascript", null, false))
        assertEquals(DeviceKind.OTHER, RunArgs.deviceKind("flutter-tester", "tester", null, false))
    }

    @Test
    fun pubspecRoot() {
        val dir = Files.createTempDirectory("fi-run")
        try {
            Files.writeString(dir.resolve("pubspec.yaml"), "name: app\n")
            val main = Files.createDirectories(dir.resolve("lib")).resolve("main.dart")
            Files.writeString(main, "void main() {}\n")
            assertEquals(dir.toRealPath(), RunArgs.findPubspecRoot(main)!!.toRealPath())
            assertNull(RunArgs.findPubspecRoot(Path.of("/")))
        } finally {
            dir.toFile().deleteRecursively()
        }
    }

    @Test
    fun daemonEvents() {
        val ev = DaemonEvents()
        assertFalse(ev.feed("Launching lib/main.dart on macOS in debug mode...\n"))
        assertFalse(ev.feed("[{\"event\":\"app.start\",\"params\":{\"appId\":\"a\"}}]\n[{\"event\":\"app.debugPort\",\"params\":{\"appId\":\"a\",\"port\":1,\"wsUri\":\"ws://127.0.0.1:1/x=/ws\"}}]"))
        assertNull(ev.vmServiceUri) // no newline yet
        assertFalse(ev.feed("\n[{\"event\":\"app.webLaunchUrl\",\"params\":{\"url\":\"http://localhost:5/\",\"launched\":true}}]\n"))
        assertEquals("ws://127.0.0.1:1/x=/ws", ev.vmServiceUri)
        assertEquals("http://localhost:5/", ev.webLaunchUrl)
        assertTrue(ev.feed("[{\"event\":\"app.started\",\"params\":{\"appId\":\"a\"}}]\n"))
        assertTrue(ev.started)
        assertFalse(ev.feed("[{\"event\":\"app.log\",\"params\":{\"log\":\"\\\"app.started\\\" in a log\"}}]\n[not json\n"))
        ev.feed("[{\"event\":\"app.stop\",\"params\":{\"appId\":\"a\"}}]\n")
        assertTrue(ev.stopped)
    }
}
