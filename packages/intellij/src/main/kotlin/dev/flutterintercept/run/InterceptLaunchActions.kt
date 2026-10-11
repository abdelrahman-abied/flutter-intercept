// CONTRACTS §15.1 "Run integration": the manual path. "Run / Debug with Flutter Intercept" launches the selected
// Flutter run configuration through our runner explicitly, so it works even if another plugin's runner wins the
// automatic selection. Interception still follows the user's on/off setting (the sidecar decides).
package dev.flutterintercept.run

import com.intellij.execution.ExecutorRegistry
import com.intellij.execution.ProgramRunnerUtil
import com.intellij.execution.RunManager
import com.intellij.execution.RunnerAndConfigurationSettings
import com.intellij.execution.executors.DefaultDebugExecutor
import com.intellij.execution.executors.DefaultRunExecutor
import com.intellij.execution.runners.ExecutionEnvironmentBuilder
import com.intellij.execution.runners.ProgramRunner
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import io.flutter.run.SdkAttachConfig
import io.flutter.run.SdkRunConfig

abstract class InterceptLaunchAction(private val executorId: String) : DumbAwareAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val project = e.project
        e.presentation.isEnabledAndVisible = project != null && selectedFlutterSettings(project) != null &&
            InterceptFlutterRunner.flutterRunner() != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val settings = selectedFlutterSettings(project) ?: return
        val executor = ExecutorRegistry.getInstance().getExecutorById(executorId) ?: return
        val runner = ProgramRunner.findRunnerById(InterceptFlutterRunner.ID) ?: InterceptFlutterRunner()
        try {
            val env = ExecutionEnvironmentBuilder(project, executor)
                .runnerAndSettings(runner, settings)
                .dataContext(e.dataContext)
                .build()
            // Before-run tasks, "stop the running instance?" and error reporting as for the toolbar's Run / Debug.
            ProgramRunnerUtil.executeConfiguration(env, true, true)
        } catch (t: Throwable) {
            if (t is com.intellij.openapi.progress.ProcessCanceledException) throw t
            Logger.getInstance(InterceptLaunchAction::class.java)
                .warn("Flutter Intercept: could not start ${settings.name} (${t.javaClass.simpleName}: ${t.message})")
        }
    }

    companion object {
        /** The selected run configuration when it is a Flutter app configuration (not attach). */
        fun selectedFlutterSettings(project: Project): RunnerAndConfigurationSettings? {
            val selected = RunManager.getInstance(project).selectedConfiguration ?: return null
            val config = selected.configuration
            return selected.takeIf { config is SdkRunConfig && config !is SdkAttachConfig }
        }
    }
}

class RunWithInterceptAction : InterceptLaunchAction(DefaultRunExecutor.EXECUTOR_ID)

class DebugWithInterceptAction : InterceptLaunchAction(DefaultDebugExecutor.EXECUTOR_ID)
