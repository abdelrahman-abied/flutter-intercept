package dev.flutterintercept.run

import com.intellij.execution.executors.DefaultRunExecutor
import com.intellij.execution.process.NopProcessHandler
import com.intellij.execution.process.OSProcessHandler
import com.intellij.execution.process.ProcessOutputTypes
import com.intellij.execution.runners.ExecutionEnvironment
import com.intellij.execution.runners.ExecutionEnvironmentBuilder
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.testFramework.replaceService
import dev.flutterintercept.api.DeviceKind
import dev.flutterintercept.api.InterceptSidecar
import dev.flutterintercept.api.LaunchPlan
import dev.flutterintercept.api.LaunchRequest
import io.flutter.pub.PubRoot
import io.flutter.run.FlutterDevice
import io.flutter.run.FlutterLaunchMode
import io.flutter.run.FlutterRunConfigurationType
import io.flutter.run.SdkRunConfig
import io.flutter.run.common.RunMode
import io.flutter.sdk.FlutterSdk
import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.WebSocket
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/**
 * CONTRACTS §15.1 run integration against the real Flutter plugin classes (docs/spikes/intellij-run.md).
 *
 * The device test runs only with `FI_RUN_DEVICE=<flutter device id>` and `FI_RUN_APP=<pub-get'd Flutter app dir that
 * contains .dart_tool/flutter_intercept/entry_lib__main.dart>`; the Flutter SDK comes from `FLUTTER_ROOT` or PATH.
 */
class RunIntegrationTest : BasePlatformTestCase() {
    private lateinit var app: Path
    private val emulator = FlutterDevice("emulator-5554", "sdk gphone64 arm64", "android-arm64", true, "mobile", "android", true)

    override fun setUp() {
        super.setUp()
        app = Files.createTempDirectory("fi-run-app")
        Files.writeString(app.resolve("pubspec.yaml"), "name: fi_run_app\ndependencies:\n  flutter:\n    sdk: flutter\n")
        Files.writeString(Files.createDirectories(app.resolve("lib")).resolve("main.dart"), "void main() {}\n")
        Files.writeString(
            Files.createDirectories(app.resolve(".dart_tool/flutter_intercept")).resolve("entry_lib__main.dart"),
            "import 'package:fi_run_app/main.dart' as target;\nvoid main() => target.main();\n",
        )
    }

    override fun tearDown() {
        try { app.toFile().deleteRecursively() } finally { super.tearDown() }
    }

    private fun config(dir: Path = app, args: String? = "--dart-define=USER=1 \"--dart-define=SPACED=a b\""): SdkRunConfig {
        val config = FlutterRunConfigurationType.getInstance().factory.createTemplateConfiguration(project) as SdkRunConfig
        config.name = "main.dart"
        config.fields = InterceptLaunchService.copyFields(config.fields).also {
            it.filePath = dir.resolve("lib/main.dart").toString()
            it.additionalArgs = args
        }
        return config
    }

    private fun env(config: SdkRunConfig): ExecutionEnvironment =
        ExecutionEnvironmentBuilder(project, DefaultRunExecutor.getRunExecutorInstance())
            .runProfile(config).runner(InterceptFlutterRunner()).build()

    private fun service() = InterceptLaunchService.getInstance(project)

    fun testRunnerIsRegisteredBeforeFlutters() {
        val ids = com.intellij.execution.runners.ProgramRunner.PROGRAM_RUNNER_EP.extensionList.map { it.runnerId }
        assertTrue(ids.toString(), ids.indexOf(InterceptFlutterRunner.ID) in 0 until ids.indexOf(InterceptFlutterRunner.FLUTTER_RUNNER_ID))
        assertNotNull(InterceptFlutterRunner.flutterRunner())
        // ProgramRunner.getRunner takes the first runner whose canRun is true; ours mirrors Flutter's (which also needs a
        // configured Flutter SDK, absent in a light test project) for the executors it supports, and never takes attach.
        val config = config()
        val ours = InterceptFlutterRunner()
        val flutter = InterceptFlutterRunner.flutterRunner()!!
        for (executor in listOf(DefaultRunExecutor.EXECUTOR_ID, com.intellij.execution.executors.DefaultDebugExecutor.EXECUTOR_ID)) {
            assertEquals(flutter.canRun(executor, config), ours.canRun(executor, config))
        }
        assertFalse(ours.canRun("Coverage", config))
        assertFalse(ours.canRun(DefaultRunExecutor.EXECUTOR_ID, io.flutter.run.SdkAttachConfig(config)))
    }

    fun testDescribeBuildsTheLaunchRequest() {
        val input = service().describe(env(config()), emulator)
        input as LaunchInput.Ready
        assertEquals(app.resolve("lib/main.dart").toString(), input.request.program)
        assertEquals(app.toString(), input.request.projectRoot)
        assertEquals("emulator-5554", input.request.deviceId)
        assertEquals(DeviceKind.ANDROID_EMULATOR, input.request.deviceKind)
        assertEquals("debug", input.request.flutterMode)
        assertEquals(listOf("--dart-define=USER=1", "--dart-define=SPACED=a b"), input.request.additionalArgs)
    }

    fun testUserTargetIsTheProgram() {
        val input = service().describe(env(config(args = "-t lib/main_dev.dart")), emulator) as LaunchInput.Ready
        assertEquals(app.resolve("lib/main_dev.dart").toString(), input.request.program)
    }

    fun testReleaseAndMissingDeviceAreNeverIntercepted() {
        val release = env(config())
        FlutterLaunchMode.addToEnvironment(release, FlutterLaunchMode.RELEASE)
        assertEquals(LaunchInput.Unchanged("release build: never intercepted"), service().describe(release, emulator))
        assertEquals(LaunchInput.Unchanged("release build: never intercepted"), service().describe(env(config(args = "--release")), emulator))
        assertTrue(service().describe(env(config()), null) is LaunchInput.Unchanged)
    }

    fun testPatchedEnvironmentNeverTouchesTheSavedConfiguration() {
        val original = config()
        val before = original.fields.additionalArgs
        val env = env(original)
        val input = service().describe(env, emulator) as LaunchInput.Ready
        val entry = app.resolve(".dart_tool/flutter_intercept/entry_lib__main.dart").toString()
        val sidecarArgs = input.request.additionalArgs + "--dart-define=FLUTTER_INTERCEPT_PROXY=10.0.2.2:8899"
        val patched = service().patchedEnvironment(env, input, LaunchPlan.Rewrite(entry, sidecarArgs, null))

        val clone = patched.runProfile as SdkRunConfig
        assertNotSame(original, clone)
        assertEquals(before, original.fields.additionalArgs)
        assertEquals(app.resolve("lib/main.dart").toString(), clone.fields.filePath)
        assertEquals(sidecarArgs + "--target=.dart_tool/flutter_intercept/entry_lib__main.dart", RunArgs.parse(clone.fields.additionalArgs))
        assertSame(original, service().originalOf(patched))
        assertEquals(InterceptFlutterRunner.ID, patched.runner.runnerId)
        assertEquals(input.request.launchId, patched.getUserData(InterceptLaunchService.PREPARED)?.launchId)
        // One copy per configuration: Flutter's "run the same config again → hot restart" finds the running app.
        val again = service().patchedEnvironment(env(original), input, LaunchPlan.Rewrite(entry, sidecarArgs, null))
        assertSame(clone, again.runProfile)
        assertSame(clone, service().cloneFor(original))
        // A caller's ProgramRunner.Callback survives the swap.
        val callback = com.intellij.execution.runners.ProgramRunner.Callback { }
        val withCallback = ExecutionEnvironmentBuilder(project, DefaultRunExecutor.getRunExecutorInstance())
            .runProfile(original).runner(InterceptFlutterRunner()).build(callback)
        assertSame(callback, service().patchedEnvironment(withCallback, input, LaunchPlan.Rewrite(entry, sidecarArgs, null)).callback)
    }

    fun testFlutterPluginBuildsThePatchedCommandLine() {
        val sdk = flutterSdk() ?: return println("SKIP: no Flutter SDK (FLUTTER_ROOT / PATH)")
        val original = config()
        val env = env(original)
        val input = service().describe(env, emulator) as LaunchInput.Ready
        val entry = app.resolve(".dart_tool/flutter_intercept/entry_lib__main.dart").toString()
        val sidecarArgs = input.request.additionalArgs + "--dart-define=FLUTTER_INTERCEPT_PROXY=10.0.2.2:8899"
        val clone = service().patchedEnvironment(env, input, LaunchPlan.Rewrite(entry, sidecarArgs, null)).runProfile as SdkRunConfig

        val line = commandLine(sdk, app, clone, emulator)
        val params = line.parametersList.list
        println("flutter " + params.joinToString(" "))
        assertEquals(app.toFile().canonicalFile, line.workDirectory.canonicalFile)
        assertEquals(
            listOf(
                // --start-paused in Run mode too: the Flutter plugin resumes the isolate itself.
                "run", "--machine", "--track-widget-creation", "--device-id=emulator-5554", "--start-paused",
                "--dart-define=USER=1", "--dart-define=SPACED=a b", "--dart-define=FLUTTER_INTERCEPT_PROXY=10.0.2.2:8899",
                "--target=.dart_tool/flutter_intercept/entry_lib__main.dart", "lib/main.dart",
            ),
            params.dropWhile { it != "run" },
        )
    }

    fun testSessionWatcherReportsStartAndEnd() {
        val calls = CopyOnWriteArrayList<String>()
        project.replaceService(InterceptSidecar::class.java, recordingSidecar(calls), testRootDisposable)
        val handler = NopProcessHandler()
        SessionWatcher(project, PreparedLaunch("L1", "chrome", "main.dart"), handler).attach()
        handler.startNotify()
        handler.notifyTextAvailable("[{\"event\":\"app.webLaunchUrl\",\"params\":{\"url\":\"http://localhost:5/\",\"launched\":true}}]\n", ProcessOutputTypes.STDOUT)
        handler.notifyTextAvailable("[{\"event\":\"app.debugPort\",\"params\":{\"wsUri\":\"ws://127.0.0.1:9/t=/ws\"}}]\n", ProcessOutputTypes.STDOUT)
        handler.notifyTextAvailable("[{\"event\":\"app.started\",\"params\":{}}]\n", ProcessOutputTypes.STDOUT)
        handler.destroyProcess()
        waitFor { calls.size >= 2 }
        assertEquals("started L1 chrome ws://127.0.0.1:9/t=/ws http://localhost:5/", calls[0].replace(Regex(" [0-9a-f-]{36}"), ""))
        assertTrue(calls[1].startsWith("ended "))
        assertEquals(calls[0].split(" ")[2], calls[1].split(" ")[1]) // same session id
    }

    /** Real device: the Flutter plugin's own command line for the patched copy, run with flutter, root library checked. */
    fun testPatchedLaunchRunsTheEntryOnADevice() {
        val deviceId = System.getenv("FI_RUN_DEVICE") ?: return println("SKIP: set FI_RUN_DEVICE and FI_RUN_APP")
        val appDir = Path.of(System.getenv("FI_RUN_APP") ?: return println("SKIP: set FI_RUN_APP")).toAbsolutePath()
        val sdk = flutterSdk() ?: return println("SKIP: no Flutter SDK")
        com.intellij.openapi.vfs.newvfs.impl.VfsRootAccess.allowRootAccess(testRootDisposable, appDir.toString(), appDir.toRealPath().toString())
        val device = when {
            deviceId.startsWith("emulator-") -> emulator
            deviceId == "macos" -> FlutterDevice("macos", "macOS", "darwin", false, "desktop", "macos", false)
            else -> FlutterDevice(deviceId, deviceId, "android-arm64", false, "mobile", "android", true)
        }
        val calls = CopyOnWriteArrayList<String>()
        project.replaceService(InterceptSidecar::class.java, recordingSidecar(calls), testRootDisposable)

        val original = config(appDir, args = null)
        val env = env(original)
        val input = service().describe(env, device) as LaunchInput.Ready
        assertEquals(RunArgs.deviceKind(device.deviceId(), device.platform(), device.platformType(), device.emulator()), input.request.deviceKind)
        val entry = appDir.resolve(".dart_tool/flutter_intercept/entry_lib__main.dart")
        val host = if (input.request.deviceKind == DeviceKind.ANDROID_EMULATOR) "10.0.2.2" else "localhost"
        val clone = service().patchedEnvironment(
            env, input, LaunchPlan.Rewrite(entry.toString(), listOf("--dart-define=FLUTTER_INTERCEPT_PROXY=$host:9"), null),
        ).runProfile as SdkRunConfig

        val line = commandLine(sdk, appDir, clone, device)
        val handler = OSProcessHandler(line)
        val events = DaemonEvents()
        handler.addProcessListener(object : com.intellij.execution.process.ProcessListener {
            override fun onTextAvailable(event: com.intellij.execution.process.ProcessEvent, outputType: com.intellij.openapi.util.Key<*>) {
                if (outputType == ProcessOutputTypes.STDOUT) events.feed(event.text)
            }
        })
        SessionWatcher(project, PreparedLaunch(input.request.launchId, deviceId, original.name), handler).attach()
        handler.startNotify()
        try {
            // The plugin's command has --start-paused: the VM service comes first, the app starts once resumed.
            waitFor(TimeUnit.MINUTES.toMillis(10)) { events.vmServiceUri != null || handler.isProcessTerminated }
            assertNotNull("app.debugPort not seen", events.vmServiceUri)
            val rootLibs = vmService(events.vmServiceUri!!, resume = true)
            println("root libraries: " + rootLibs.joinToString { ".../" + it.substringAfterLast("/demo_app/") })
            assertTrue(rootLibs.toString(), rootLibs.any { it.endsWith(".dart_tool/flutter_intercept/entry_lib__main.dart") })
            waitFor(TimeUnit.MINUTES.toMillis(2)) { events.started || handler.isProcessTerminated }
            assertTrue("app.started not seen", events.started)
            waitFor { calls.isNotEmpty() }
            assertTrue(calls[0].startsWith("started ${input.request.launchId} ") && calls[0].contains(" ws://"))
        } finally {
            handler.processInput.let { it.write("[{\"id\":1,\"method\":\"app.stop\",\"params\":{}}]\n".toByteArray()); it.flush() }
            handler.destroyProcess()
            handler.waitFor(60_000)
        }
        waitFor { calls.size >= 2 }
        assertTrue(calls[1].startsWith("ended "))
    }

    // ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────

    private fun flutterSdk(): FlutterSdk? {
        val root = System.getenv("FLUTTER_ROOT")?.let(::File)
            ?: System.getenv("PATH").orEmpty().split(File.pathSeparator).map { File(it, "flutter") }
                .firstOrNull { it.canExecute() }?.canonicalFile?.parentFile?.parentFile
            ?: return null
        return FlutterSdk.forPath(root.path)
    }

    /** What `SdkFields.createFlutterSdkRunCommand` builds, minus its DevTools / analytics side effects. */
    private fun commandLine(sdk: FlutterSdk, dir: Path, config: SdkRunConfig, device: FlutterDevice) =
        com.intellij.openapi.application.ReadAction.compute<com.intellij.execution.configurations.GeneralCommandLine, Throwable> {
            val root = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(dir)!!
            val main = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(Path.of(config.fields.filePath))!!
            sdk.flutterRun(PubRoot.forDirectory(root)!!, main, device, RunMode.RUN, FlutterLaunchMode.DEBUG, project, *config.fields.additionalArgsParsed)
                .createGeneralCommandLine(project)
        }

    private fun recordingSidecar(calls: MutableList<String>) = object : InterceptSidecar {
        override fun isEnabled() = true
        override fun prepareLaunch(request: LaunchRequest): LaunchPlan = LaunchPlan.Skip("test")
        override fun sessionStarted(launchId: String, sessionId: String, deviceId: String?, vmServiceUri: String?, webLaunchUrl: String?) {
            calls.add("started $launchId $sessionId $deviceId $vmServiceUri $webLaunchUrl")
        }
        override fun sessionEnded(sessionId: String) { calls.add("ended $sessionId") }
    }

    private fun waitFor(timeoutMs: Long = 10_000, condition: () -> Boolean) {
        val end = System.currentTimeMillis() + timeoutMs
        while (!condition() && System.currentTimeMillis() < end) {
            com.intellij.util.ui.UIUtil.dispatchAllInvocationEvents()
            Thread.sleep(50)
        }
    }

    /** Root library URI of every isolate (Dart VM service JSON-RPC over java.net.http); [resume] resumes them after. */
    private fun vmService(wsUri: String, resume: Boolean): List<String> {
        val replies = java.util.concurrent.LinkedBlockingQueue<String>()
        val ws = HttpClient.newHttpClient().newWebSocketBuilder().buildAsync(URI(wsUri), object : WebSocket.Listener {
            private val buf = StringBuilder()
            override fun onText(webSocket: WebSocket, data: CharSequence, last: Boolean): CompletionStage<*>? {
                buf.append(data)
                if (last) { replies.add(buf.toString()); buf.setLength(0) }
                webSocket.request(1)
                return CompletableFuture.completedFuture(null)
            }
        }).get(15, TimeUnit.SECONDS)
        fun call(id: Int, method: String, params: String = "{}"): com.google.gson.JsonObject {
            ws.sendText("{\"jsonrpc\":\"2.0\",\"id\":\"$id\",\"method\":\"$method\",\"params\":$params}", true).get(5, TimeUnit.SECONDS)
            while (true) {
                val msg = com.google.gson.JsonParser.parseString(replies.poll(15, TimeUnit.SECONDS) ?: error("VM service timeout")).asJsonObject
                if (msg.get("id")?.asString == "$id") return msg.getAsJsonObject("result")
            }
        }
        val isolates = call(1, "getVM").getAsJsonArray("isolates")
        return isolates.mapIndexed { i, iso ->
            val id = iso.asJsonObject.get("id").asString
            var rootLib: String? = null
            for (attempt in 0 until 100) { // the root library is set once the kernel is loaded
                rootLib = call(100 * i + attempt + 10, "getIsolate", "{\"isolateId\":\"$id\"}").getAsJsonObject("rootLib")?.get("uri")?.asString
                if (rootLib != null) break
                Thread.sleep(100)
            }
            if (resume) runCatching { call(100 * i + 5, "resume", "{\"isolateId\":\"$id\"}") }
            rootLib ?: "?"
        }.also { ws.sendClose(WebSocket.NORMAL_CLOSURE, "") }
    }
}
