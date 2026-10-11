// CONTRACTS §15.1 "Run integration": prepares one Flutter launch through the sidecar and runs a patched copy of
// the run configuration. The user's saved configuration is never modified (docs/spikes/intellij-run.md).
package dev.flutterintercept.run

import com.intellij.execution.ExecutionException
import com.intellij.execution.ExecutionListener
import com.intellij.execution.ExecutionManager
import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessHandler
import com.intellij.execution.process.ProcessListener
import com.intellij.execution.process.ProcessOutputTypes
import com.intellij.execution.runners.ExecutionEnvironment
import com.intellij.execution.runners.ExecutionEnvironmentBuilder
import com.intellij.execution.runners.ExecutionUtil
import com.intellij.execution.runners.ProgramRunner
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Key
import com.intellij.util.concurrency.AppExecutorUtil
import dev.flutterintercept.api.InterceptSidecar
import dev.flutterintercept.api.LaunchPlan
import dev.flutterintercept.api.LaunchRequest
import io.flutter.run.FlutterDevice
import io.flutter.run.FlutterLaunchMode
import io.flutter.run.SdkAttachConfig
import io.flutter.run.SdkFields
import io.flutter.run.SdkRunConfig
import io.flutter.run.common.RunMode
import io.flutter.run.daemon.DeviceService
import io.flutter.run.daemon.FlutterApp
import java.lang.ref.WeakReference
import java.nio.file.Files
import java.nio.file.Path
import java.util.Collections
import java.util.UUID
import java.util.WeakHashMap
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean

/** A launch we patched: carried on the patched [ExecutionEnvironment] so the process can be tied to the sidecar. */
data class PreparedLaunch(val launchId: String, val deviceId: String?, val configName: String)

/** What [InterceptLaunchService.describe] decided before asking the sidecar. */
sealed class LaunchInput {
    data class Ready(val request: LaunchRequest, val appDir: Path, val original: SdkRunConfig) : LaunchInput()
    data class Unchanged(val reason: String) : LaunchInput()
}

@Service(Service.Level.PROJECT)
class InterceptLaunchService(private val project: Project) : Disposable {
    /** original → our long-lived copy (one per configuration, so Flutter's "same config again → hot restart" still works). */
    private val clones = Collections.synchronizedMap(WeakHashMap<SdkRunConfig, SdkRunConfig>())
    private val preparing = ConcurrentHashMap.newKeySet<Any>()
    private val lastReason = ConcurrentHashMap<String, String>()

    init {
        project.messageBus.connect(this).subscribe(ExecutionManager.EXECUTION_TOPIC, object : ExecutionListener {
            override fun processStarted(executorId: String, env: ExecutionEnvironment, handler: ProcessHandler) {
                val prepared = env.getUserData(PREPARED) ?: return
                try {
                    SessionWatcher(project, prepared, handler).attach()
                } catch (e: Throwable) {
                    if (e is ProcessCanceledException) throw e
                    LOG.warn("Flutter Intercept: could not watch the session of ${prepared.configName}: ${e.javaClass.simpleName}")
                }
            }
        })
    }

    /** The copy we launch for [config], if any (for `canRun` so the Flutter runner sees the running app). */
    fun cloneFor(config: SdkRunConfig): SdkRunConfig? = clones[config]

    /** The user's configuration behind [env]: our copy maps back to its original. */
    fun originalOf(env: ExecutionEnvironment): SdkRunConfig? = (env.runProfile as? SdkRunConfig)?.let(::originalOf)

    /** [config] itself, or the user's configuration when [config] is our copy. */
    fun originalOf(config: SdkRunConfig): SdkRunConfig = config.getUserData(ORIGINAL)?.get() ?: config

    /**
     * Entry point (EDT): decide, prepare in the background (bounded), then run the patched copy — or the configuration
     * unchanged when anything says no or goes wrong (one log line says why).
     */
    fun launch(env: ExecutionEnvironment, delegate: ProgramRunner<*>) {
        env.putUserData(PREPARED, null) // a rerun copies user data: never reuse an old launch id
        val input = try {
            describe(env, DeviceService.getInstance(project).selectedDevice)
        } catch (e: Throwable) {
            if (e is ProcessCanceledException) throw e
            LaunchInput.Unchanged("could not read the run configuration (${e.javaClass.simpleName}: ${e.message})")
        }
        if (input !is LaunchInput.Ready) {
            runUnchanged(env, delegate, (input as LaunchInput.Unchanged).reason)
            return
        }
        val key: Any = env.runnerAndConfigurationSettings ?: input.original
        if (!preparing.add(key)) {
            LOG.info("Flutter Intercept: a launch of ${input.original.name} is already being prepared; ignoring the repeated start")
            return
        }
        object : Task.Backgroundable(project, "Flutter Intercept: preparing launch", true) {
            @Volatile private var plan: LaunchPlan = LaunchPlan.Skip("not prepared")
            override fun run(indicator: ProgressIndicator) { plan = prepare(input.request, indicator) }
            override fun onSuccess() { preparing.remove(key); applyAndRun(env, delegate, input, plan) }
            override fun onCancel() { preparing.remove(key); runUnchanged(env, delegate, "launch preparation was cancelled") }
            override fun onThrowable(error: Throwable) {
                preparing.remove(key)
                runUnchanged(env, delegate, "preparing the launch failed (${error.javaClass.simpleName}: ${error.message})")
            }
        }.queue()
    }

    /**
     * Everything we can decide on the EDT without the sidecar (cheap: no I/O beyond a pubspec lookup). [device] is the
     * Flutter plugin's selected device, which `LaunchState.launch` launches on.
     */
    fun describe(env: ExecutionEnvironment, device: FlutterDevice?): LaunchInput {
        val original = originalOf(env) ?: return LaunchInput.Unchanged("not a Flutter run configuration")
        if (original is SdkAttachConfig) return LaunchInput.Unchanged("attach configuration")
        val fields = original.fields
        val userArgs = RunArgs.parse(fields.additionalArgs)
        val profiling = try { RunMode.fromEnv(env).isProfiling } catch (_: ExecutionException) { false }
        val mode = RunArgs.flutterMode(FlutterLaunchMode.fromEnv(env).name, profiling, userArgs)
        if (mode == "release") return LaunchInput.Unchanged("release build: never intercepted")
        val filePath = fields.filePath?.takeIf { it.isNotBlank() } ?: return LaunchInput.Unchanged("no Dart entrypoint set (Flutter will report it)")
        val entry = Path.of(filePath)
        val appDir = RunArgs.findPubspecRoot(entry) ?: return LaunchInput.Unchanged("the entrypoint is not inside a pub package")
        val program = RunArgs.targetOf(userArgs)?.let { appDir.resolve(it).normalize() } ?: entry.toAbsolutePath().normalize()
        if (device == null) return LaunchInput.Unchanged("no Flutter device selected (Flutter will report it)")
        val kind = RunArgs.deviceKind(device.deviceId(), device.platform(), device.platformType(), device.emulator())
        val request = LaunchRequest(
            launchId = UUID.randomUUID().toString(),
            projectRoot = appDir.toString(),
            program = program.toString(),
            deviceId = device.deviceId(),
            deviceKind = kind,
            flutterMode = mode,
            additionalArgs = userArgs,
        )
        return LaunchInput.Ready(request, appDir, original)
    }

    /** Background: the sidecar's plan within [PREPARE_BUDGET_MS], else Skip. Never throws. */
    fun prepare(request: LaunchRequest, indicator: ProgressIndicator?): LaunchPlan {
        val future: Future<LaunchPlan> = AppExecutorUtil.getAppExecutorService().submit<LaunchPlan> {
            // prepareLaunch checks the on/off setting and starts the sidecar itself, all within its own ≤ 10 s.
            InterceptSidecar.getInstance(project).prepareLaunch(request)
        }
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(PREPARE_BUDGET_MS)
        while (true) {
            if (indicator?.isCanceled == true) { future.cancel(true); return LaunchPlan.Skip("launch preparation was cancelled") }
            val left = deadline - System.nanoTime()
            if (left <= 0) { future.cancel(true); return LaunchPlan.Skip("the sidecar did not answer within ${PREPARE_BUDGET_MS / 1000} s") }
            try {
                return future.get(minOf(left, TimeUnit.MILLISECONDS.toNanos(100)), TimeUnit.NANOSECONDS)
            } catch (_: TimeoutException) {
                // poll again (cancellation / deadline)
            } catch (e: java.util.concurrent.ExecutionException) {
                val cause = e.cause ?: e
                return LaunchPlan.Skip("prepareLaunch failed (${cause.javaClass.simpleName}: ${cause.message})")
            } catch (e: InterruptedException) {
                future.cancel(true)
                Thread.currentThread().interrupt()
                return LaunchPlan.Skip("launch preparation was interrupted")
            }
        }
    }

    /** EDT: run the patched copy for a Rewrite plan; Skip or any failure runs the configuration unchanged. */
    fun applyAndRun(env: ExecutionEnvironment, delegate: ProgramRunner<*>, input: LaunchInput.Ready, plan: LaunchPlan) {
        if (project.isDisposed) return
        val rewrite = when (plan) {
            is LaunchPlan.Skip -> { runUnchanged(env, delegate, plan.reason); return }
            is LaunchPlan.Rewrite -> plan
        }
        val patchedEnv = try {
            patchedEnvironment(env, input, rewrite)
        } catch (e: Throwable) {
            if (e is ProcessCanceledException) throw e
            runUnchanged(env, delegate, "could not patch the launch (${e.javaClass.simpleName}: ${e.message})")
            return
        }
        try {
            delegate.execute(patchedEnv)
            lastReason.remove(input.original.name)
            // Never log the args: on physical iPhones the proxy define carries the LAN token.
            LOG.info(
                "Flutter Intercept: ${input.original.name} on ${input.request.deviceId ?: "?"} (${input.request.deviceKind.wire}, " +
                    "${input.request.flutterMode}) runs ${rewrite.program}" + (rewrite.note?.let { " — $it" } ?: ""),
            )
        } catch (e: Throwable) {
            if (e is ProcessCanceledException) throw e
            runUnchanged(env, delegate, "the patched launch failed to start (${e.javaClass.simpleName}: ${e.message})")
        }
    }

    /** The environment for the patched copy: same settings, executor, target and runner (ours, so a rerun prepares again). */
    fun patchedEnvironment(env: ExecutionEnvironment, input: LaunchInput.Ready, rewrite: LaunchPlan.Rewrite): ExecutionEnvironment {
        val program = Path.of(rewrite.program)
        if (!Files.isRegularFile(program)) error("the generated entry does not exist: $program")
        val args = RunArgs.patchedArgs(rewrite.additionalArgs, program, Path.of(input.request.program), input.appDir)
        val clone = patchedClone(input.original, args)
        val patched = ExecutionEnvironmentBuilder(env)
            .runProfile(clone)
            .executionId(env.executionId)
            .apply { env.dataContext?.let { dataContext(it) } }
            .build(env.callback) // public `build(Callback)`: keeps a caller's callback (`setCallback` is internal API)
        patched.putUserData(PREPARED, PreparedLaunch(input.request.launchId, input.request.deviceId, input.original.name))
        return patched
    }

    /** Our copy of [original] with [args] as its additional args. [original] itself is only read. */
    fun patchedClone(original: SdkRunConfig, args: List<String>): SdkRunConfig {
        val clone = synchronized(clones) {
            clones.getOrPut(original) {
                (original.clone() as SdkRunConfig).also { it.putUserData(ORIGINAL, WeakReference(original)) }
            }
        }
        clone.name = original.name
        clone.fields = copyFields(original.fields).also { it.additionalArgs = RunArgs.join(args) }
        return clone
    }

    /** EDT: the user's configuration exactly as saved (never our copy), with the reason logged once per change. */
    fun runUnchanged(env: ExecutionEnvironment, delegate: ProgramRunner<*>, reason: String) {
        if (project.isDisposed) return
        val original = originalOf(env)
        val name = original?.name ?: env.runProfile.name
        if (lastReason.put(name, reason) != reason) LOG.info("Flutter Intercept: not intercepting $name: $reason")
        else LOG.debug("Flutter Intercept: not intercepting $name: $reason")
        val target = if (original != null && original !== env.runProfile) {
            ExecutionEnvironmentBuilder(env).runProfile(original).executionId(env.executionId)
                .apply { env.dataContext?.let { dataContext(it) } }.build(env.callback)
        } else env
        target.putUserData(PREPARED, null)
        try {
            delegate.execute(target)
        } catch (e: ExecutionException) {
            ExecutionUtil.handleExecutionError(target, e)
        }
    }

    override fun dispose() {
        clones.clear()
    }

    companion object {
        private val LOG = Logger.getInstance(InterceptLaunchService::class.java)
        const val PREPARE_BUDGET_MS = 12_000L
        val PREPARED: Key<PreparedLaunch> = Key.create("flutterIntercept.preparedLaunch")
        val ORIGINAL: Key<WeakReference<SdkRunConfig>> = Key.create("flutterIntercept.originalConfiguration")

        fun getInstance(project: Project): InterceptLaunchService = project.getService(InterceptLaunchService::class.java)

        fun copyFields(source: SdkFields): SdkFields = SdkFields().also {
            it.filePath = source.filePath
            it.buildFlavor = source.buildFlavor
            it.additionalArgs = source.additionalArgs
            it.attachArgs = source.attachArgs
            it.envs = LinkedHashMap(source.envs)
        }
    }
}

/** Ties a patched launch's process to the sidecar: `sessionStarted` when the app runs, `sessionEnded` when it ends. */
class SessionWatcher(
    private val project: Project,
    private val prepared: PreparedLaunch,
    private val handler: ProcessHandler,
) : ProcessListener {
    private val events = DaemonEvents()
    private val sessionId = UUID.randomUUID().toString()
    private val started = AtomicBoolean(false)
    private val ended = AtomicBoolean(false)

    fun attach() {
        handler.addProcessListener(this)
        // Second trigger in case stdout is not seen: the Flutter plugin's own app state.
        FlutterApp.fromProcess(handler)?.let { app ->
            app.addStateListener(object : FlutterApp.FlutterAppListener {
                override fun stateChanged(newState: FlutterApp.State?) {
                    if (newState == FlutterApp.State.STARTED) start(app)
                }
            })
            if (app.isStarted) start(app)
        }
        if (handler.isProcessTerminated) end()
    }

    override fun onTextAvailable(event: ProcessEvent, outputType: Key<*>) {
        if (outputType != ProcessOutputTypes.STDOUT) return
        if (events.feed(event.text ?: return)) start(FlutterApp.fromProcess(handler))
    }

    override fun processTerminated(event: ProcessEvent) = end()

    private fun start(app: FlutterApp?) {
        if (!started.compareAndSet(false, true)) return
        val uri = events.vmServiceUri ?: try { app?.connector?.webSocketUrl } catch (_: Throwable) { null }
        val web = events.webLaunchUrl
        call { it.sessionStarted(prepared.launchId, sessionId, prepared.deviceId, uri, web) }
    }

    private fun end() {
        if (!started.get() || !ended.compareAndSet(false, true)) return
        call { it.sessionEnded(sessionId) }
    }

    /** Off the process reader thread; failures are logged without URIs or tokens. */
    private fun call(block: (InterceptSidecar) -> Unit) {
        AppExecutorUtil.getAppExecutorService().execute {
            if (project.isDisposed) return@execute
            try {
                block(InterceptSidecar.getInstance(project))
            } catch (e: Throwable) {
                if (e is ProcessCanceledException) return@execute
                Logger.getInstance(SessionWatcher::class.java)
                    .info("Flutter Intercept: session update for ${prepared.configName} failed (${e.javaClass.simpleName})")
            }
        }
    }
}
