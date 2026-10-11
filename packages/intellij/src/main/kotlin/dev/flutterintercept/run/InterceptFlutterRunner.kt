// CONTRACTS §15.1 "Run integration": the automatic hook. Registered before the Flutter plugin's own runner
// (`order="first"`), it takes Run / Debug / Android Profiler launches of Flutter run configurations, prepares them
// through the sidecar and hands a patched copy (or the configuration unchanged) to the Flutter runner.
package dev.flutterintercept.run

import com.intellij.execution.ExecutionException
import com.intellij.execution.configurations.RunProfile
import com.intellij.execution.configurations.RunnerSettings
import com.intellij.execution.executors.DefaultDebugExecutor
import com.intellij.execution.executors.DefaultRunExecutor
import com.intellij.execution.runners.ExecutionEnvironment
import com.intellij.execution.runners.ProgramRunner
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.progress.ProcessCanceledException
import io.flutter.run.SdkAttachConfig
import io.flutter.run.SdkRunConfig

class InterceptFlutterRunner : ProgramRunner<RunnerSettings> {
    override fun getRunnerId(): String = ID

    override fun canRun(executorId: String, profile: RunProfile): Boolean {
        if (executorId !in EXECUTORS) return false
        val config = profile as? SdkRunConfig ?: return false
        if (config is SdkAttachConfig) return false
        return try {
            val delegate = flutterRunner() ?: return false
            // The Flutter runner looks up the running app by configuration identity: show it the copy we launched.
            val seen = InterceptLaunchService.getInstance(config.project).let { svc ->
                svc.cloneFor(svc.originalOf(config)) ?: config
            }
            delegate.canRun(executorId, seen)
        } catch (e: Throwable) {
            if (e is ProcessCanceledException) throw e
            false
        }
    }

    override fun execute(environment: ExecutionEnvironment) {
        val delegate = flutterRunner() ?: throw ExecutionException("The Flutter plugin's runner is not available")
        try {
            InterceptLaunchService.getInstance(environment.project).launch(environment, delegate)
        } catch (e: Throwable) {
            if (e is ProcessCanceledException || e is ExecutionException) throw e
            // Fail open: whatever broke in our code, the app launches the way the Flutter plugin would launch it.
            LOG.warn("Flutter Intercept: launching unchanged after an internal error (${e.javaClass.simpleName}: ${e.message})")
            delegate.execute(environment)
        }
    }

    companion object {
        const val ID = "FlutterInterceptRunner"
        /** `io.flutter.run.FlutterRunner.getRunnerId()`. */
        const val FLUTTER_RUNNER_ID = "FlutterRunner"
        /** The executors the Flutter runner accepts (`LaunchState.Runner.canRun`). */
        val EXECUTORS = setOf(DefaultRunExecutor.EXECUTOR_ID, DefaultDebugExecutor.EXECUTOR_ID, "Android Profiler")
        private val LOG = Logger.getInstance(InterceptFlutterRunner::class.java)

        fun flutterRunner(): ProgramRunner<*>? = ProgramRunner.findRunnerById(FLUTTER_RUNNER_ID)
    }
}
