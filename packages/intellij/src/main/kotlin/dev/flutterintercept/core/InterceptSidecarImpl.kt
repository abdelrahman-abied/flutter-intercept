// CONTRACTS §15.1: the project service the run integration (run/**) uses. Never blocks a launch for long and never
// fails one: any problem becomes LaunchPlan.Skip with a reason.
package dev.flutterintercept.core

import com.google.gson.JsonObject
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import dev.flutterintercept.api.InterceptSidecar
import dev.flutterintercept.api.LaunchPlan
import dev.flutterintercept.api.LaunchRequest
import dev.flutterintercept.settings.InterceptSettings
import dev.flutterintercept.sidecar.RpcException
import dev.flutterintercept.sidecar.RpcTimeoutException
import dev.flutterintercept.sidecar.SidecarProcess
import dev.flutterintercept.sidecar.str
import java.io.File
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

class InterceptSidecarImpl(private val project: Project) : InterceptSidecar, Disposable {
    private val sidecar get() = SidecarProcess.getInstance()

    override fun isEnabled(): Boolean {
        if (!InterceptSettings.getInstance().state.enabled) return false
        val app = ApplicationManager.getApplication()
        if (app.isDispatchThread) {
            // Never block the EDT: start in the background and answer from what is known.
            sidecar.startAsync()
            return sidecar.isUsable
        }
        return sidecar.ensureStarted(PREPARE_BUDGET_MS) != null
    }

    override fun prepareLaunch(request: LaunchRequest): LaunchPlan {
        val deadline = System.currentTimeMillis() + PREPARE_BUDGET_MS
        fun remaining() = (deadline - System.currentTimeMillis()).coerceAtLeast(1)
        if (!InterceptSettings.getInstance().state.enabled) return LaunchPlan.Skip("Flutter Intercept is off")
        if (request.flutterMode == "release") return LaunchPlan.Skip("Release builds aren't intercepted")
        val conn = sidecar.ensureStarted(remaining())
            ?: return LaunchPlan.Skip(sidecar.startProblem ?: "The Flutter Intercept sidecar didn't start in time")
        sidecar.workspaceChanged()
        val params = linkedMapOf<String, Any>(
            "launchId" to request.launchId,
            "projectRoot" to File(request.projectRoot).absolutePath,
            "program" to File(request.program).absolutePath,
            "deviceKind" to request.deviceKind.wire,
            "flutterMode" to request.flutterMode,
            "additionalArgs" to request.additionalArgs,
        )
        request.deviceId?.let { params["deviceId"] = it }
        return try {
            val result = conn.rpc.request("prepareLaunch", params, remaining()).get(remaining() + 100, TimeUnit.MILLISECONDS)
            parsePlan(result as? JsonObject)
        } catch (e: TimeoutException) {
            LaunchPlan.Skip("Flutter Intercept didn't prepare the launch in time")
        } catch (e: ExecutionException) {
            when (val cause = e.cause) {
                is RpcTimeoutException -> LaunchPlan.Skip("Flutter Intercept didn't prepare the launch in time")
                is RpcException -> LaunchPlan.Skip(cause.message ?: "Flutter Intercept couldn't prepare the launch")
                else -> LaunchPlan.Skip("Flutter Intercept couldn't prepare the launch: ${cause?.message ?: e.message}")
            }
        } catch (e: Exception) {
            LOG.warn("prepareLaunch failed: ${e.javaClass.simpleName}")
            LaunchPlan.Skip("Flutter Intercept couldn't prepare the launch: ${e.message}")
        }
    }

    override fun sessionStarted(launchId: String, sessionId: String, deviceId: String?, vmServiceUri: String?, webLaunchUrl: String?) {
        // vmServiceUri is never logged (it grants debugger access).
        val params = linkedMapOf<String, Any>("launchId" to launchId, "sessionId" to sessionId)
        deviceId?.let { params["deviceId"] = it }
        vmServiceUri?.let { params["vmServiceUri"] = it }
        webLaunchUrl?.let { params["webLaunchUrl"] = it }
        sidecar.notifyIfRunning("sessionStarted", params)
    }

    override fun sessionEnded(sessionId: String) {
        sidecar.notifyIfRunning("sessionEnded", mapOf("sessionId" to sessionId))
    }

    override fun dispose() {
        // A closed project window changes the workspace folders the sidecar serves.
        ApplicationManager.getApplication().executeOnPooledThread { sidecar.workspaceChanged() }
    }

    companion object {
        private val LOG = Logger.getInstance(InterceptSidecarImpl::class.java)
        const val PREPARE_BUDGET_MS = 10_000L

        /** types.ts `PrepareLaunchResult` → [LaunchPlan]; anything unexpected is a Skip. */
        fun parsePlan(o: JsonObject?): LaunchPlan {
            if (o == null) return LaunchPlan.Skip("Flutter Intercept gave no launch plan")
            return when (o.str("kind")) {
                "rewrite" -> {
                    val program = o.str("program") ?: return LaunchPlan.Skip("Flutter Intercept gave no entry point")
                    val args = o.getAsJsonArray("additionalArgs")?.mapNotNull { el -> el.takeIf { it.isJsonPrimitive }?.asString }
                        ?: return LaunchPlan.Skip("Flutter Intercept gave no launch arguments")
                    LaunchPlan.Rewrite(program, args, o.str("note"))
                }
                "skip" -> LaunchPlan.Skip(o.str("reason") ?: "Flutter Intercept skipped this launch")
                else -> LaunchPlan.Skip("Flutter Intercept gave an unknown launch plan")
            }
        }
    }
}
