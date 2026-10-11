// Android Studio has no JCEF; the Flutter plugin embeds DevTools with JxBrowser (io.flutter.jxbrowser.*), installing
// its Chromium binaries on first use. This adapter shows the traffic UI in that same embedded browser, inside our tool
// window. It isn't a public API of the Flutter plugin, so everything goes through reflection and any mismatch
// degrades to "unavailable" (the tool window then offers Open Traffic in Browser) instead of breaking the plugin.
package dev.flutterintercept.toolwindow

import com.intellij.openapi.Disposable
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.content.ContentManager
import java.lang.reflect.InvocationHandler
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Proxy
import java.util.concurrent.TimeoutException
import javax.swing.JComponent

/** A browser view inside the tool window (JCEF or the Flutter plugin's JxBrowser). */
interface EmbeddedView {
    val component: JComponent
    /** Loads a fresh one-time URL (the guard allows it once). */
    fun load(url: String)
    fun dispose()
}

class FlutterEmbeddedBrowser(
    private val classLoader: ClassLoader = FlutterEmbeddedBrowser::class.java.classLoader,
    private val names: ClassNames = ClassNames(),
) {
    /** The Flutter plugin classes this adapter needs (overridable so tests can simulate a changed plugin). */
    data class ClassNames(
        val manager: String = "io.flutter.jxbrowser.JxBrowserManager",
        val embeddedBrowser: String = "io.flutter.jxbrowser.EmbeddedJxBrowser",
        val tab: String = "io.flutter.view.EmbeddedTab",
        val startNavigation: String = "com.teamdev.jxbrowser.navigation.callback.StartNavigationCallback",
        val createPopup: String = "com.teamdev.jxbrowser.browser.callback.CreatePopupCallback",
    )

    /** What to do for a `JxBrowserStatus` name. */
    enum class Plan { READY, INSTALL, WAIT, UNAVAILABLE }

    sealed class Result {
        class Ready(val view: EmbeddedView) : Result()
        data class Unavailable(val reason: String) : Result()
    }

    private fun cls(name: String): Class<*>? = try {
        Class.forName(name, false, classLoader)
    } catch (_: Throwable) {
        null
    }

    /** True when the Flutter plugin's embedded-browser API is present (cheap; EDT-safe). */
    fun isPresent(): Boolean = try {
        val manager = cls(names.manager) ?: return false
        val browser = cls(names.embeddedBrowser) ?: return false
        val tab = cls(names.tab) ?: return false
        manager.getMethod("getInstance"); manager.getMethod("getStatus"); manager.getMethod("setUp", String::class.java)
        manager.getMethod("waitForInstallation", Int::class.javaPrimitiveType)
        browser.getMethod("getInstance", Project::class.java)
        browser.getMethod("openEmbeddedTab", ContentManager::class.java)
        tab.getMethod("loadUrl", String::class.java); tab.getMethod("getTabComponent", ContentManager::class.java); tab.getMethod("close")
        true
    } catch (_: Throwable) {
        false
    }

    /**
     * Makes sure JxBrowser is installed (the Flutter plugin downloads it on first use; up to [installTimeoutSec]).
     * Blocking: call off the EDT. Returns null when ready, else why not.
     */
    fun ensureInstalled(project: Project, installTimeoutSec: Int = 600): String? {
        if (!isPresent()) return "the Flutter plugin's embedded browser API isn't available"
        return try {
            val managerClass = cls(names.manager)!!
            val manager = managerClass.getMethod("getInstance").invoke(null)
            var status = statusName(managerClass.getMethod("getStatus").invoke(manager))
            when (planFor(status)) {
                Plan.READY -> null
                Plan.UNAVAILABLE -> "the embedded browser is unavailable ($status)"
                Plan.INSTALL, Plan.WAIT -> {
                    if (planFor(status) == Plan.INSTALL) managerClass.getMethod("setUp", String::class.java).invoke(manager, project.name)
                    status = try {
                        statusName(managerClass.getMethod("waitForInstallation", Int::class.javaPrimitiveType).invoke(manager, installTimeoutSec))
                    } catch (e: InvocationTargetException) {
                        if (e.targetException is TimeoutException) return "installing the embedded browser timed out"
                        throw e
                    }
                    if (planFor(status) == Plan.READY) null else "the embedded browser couldn't be installed ($status)"
                }
            }
        } catch (e: Throwable) {
            LOG.warn("Flutter embedded browser check failed: ${(e as? InvocationTargetException)?.targetException?.javaClass?.simpleName ?: e.javaClass.simpleName}")
            "the Flutter plugin's embedded browser didn't respond as expected"
        }
    }

    /**
     * Opens a tab of the Flutter plugin's embedded browser and returns its view. EDT. [ensureInstalled] first.
     * The Flutter plugin writes status messages into the ContentManager it gets, so it gets a private, detached one.
     */
    fun open(project: Project, guard: NavigationGuard, parent: Disposable): Result {
        if (!isPresent()) return Result.Unavailable("the Flutter plugin's embedded browser API isn't available")
        return try {
            val detached = ContentFactory.getInstance().createContentManager(true, project)
            Disposer.register(parent, detached)
            val browser = cls(names.embeddedBrowser)!!.getMethod("getInstance", Project::class.java).invoke(null, project)
                ?: return Result.Unavailable("the Flutter plugin's embedded browser isn't registered")
            val tab = browser.javaClass.getMethod("openEmbeddedTab", ContentManager::class.java).invoke(browser, detached)
                ?: return Result.Unavailable("the embedded browser isn't ready yet")
            val tabIface = cls(names.tab)!!
            val component = tabIface.getMethod("getTabComponent", ContentManager::class.java).invoke(tab, detached) as JComponent
            try { tabIface.getMethod("matchIdeZoom").invoke(tab) } catch (_: Throwable) {}
            val guarded = installGuard(tab, guard)
            if (!guarded) LOG.info("Flutter embedded browser: navigation guard not installed; links stay in the panel")
            val view = object : EmbeddedView {
                override val component = component
                override fun load(url: String) {
                    guard.expect(url)
                    tabIface.getMethod("loadUrl", String::class.java).invoke(tab, url)
                }
                override fun dispose() {
                    try { tabIface.getMethod("close").invoke(tab) } catch (_: Throwable) {}
                }
            }
            Disposer.register(parent) { view.dispose() }
            Result.Ready(view)
        } catch (e: Throwable) {
            val cause = (e as? InvocationTargetException)?.targetException ?: e
            LOG.warn("Flutter embedded browser couldn't open: ${cause.javaClass.simpleName}")
            Result.Unavailable("the Flutter plugin's embedded browser couldn't open (${cause.javaClass.simpleName})")
        }
    }

    /**
     * Keeps the tab on the UI origin with JxBrowser callbacks on the tab's browser: StartNavigationCallback (main-frame
     * navigations through [NavigationGuard]) and CreatePopupCallback (popups suppressed; external links → system
     * browser). False when the JxBrowser API didn't match.
     */
    private fun installGuard(tab: Any, guard: NavigationGuard): Boolean = try {
        val browserField = generateSequence(tab.javaClass as Class<*>?) { it.superclass }
            .mapNotNull { c -> c.declaredFields.firstOrNull { it.name == "browser" } }.first()
        browserField.isAccessible = true
        val browser = browserField.get(tab)!!
        val loader = browser.javaClass.classLoader
        val startNav = Class.forName(names.startNavigation, false, loader)
        val startResponse = Class.forName("${names.startNavigation}\$Response", false, loader)
        val popup = Class.forName(names.createPopup, false, loader)
        val popupResponse = Class.forName("${names.createPopup}\$Response", false, loader)
        val startParams = Class.forName("${names.startNavigation}\$Params", false, loader)
        val popupParams = Class.forName("${names.createPopup}\$Params", false, loader)
        val browserIface = Class.forName("com.teamdev.jxbrowser.browser.Browser", false, loader)
        val advisable = Class.forName("com.teamdev.jxbrowser.callback.Advisable", false, loader)
        val start = startResponse.getMethod("start")
        val ignore = startResponse.getMethod("ignore")
        val suppress = popupResponse.getMethod("suppress")

        val navCallback = callback(startNav, loader) { params ->
            val url = params?.let { startParams.getMethod("url").invoke(it) as? String }.orEmpty()
            if (guard.onBeforeBrowse(url)) ignore.invoke(null) else start.invoke(null)
        }
        val popupCallback = callback(popup, loader) { params ->
            val url = params?.let { popupParams.getMethod("targetUrl").invoke(it) as? String }
            guard.onPopup(url)
            suppress.invoke(null)
        }
        val navigation = browserIface.getMethod("navigation").invoke(browser)
        val set = advisable.methods.first { it.name == "set" && it.parameterCount == 2 && it.parameterTypes[0] == Class::class.java }
        set.invoke(navigation, startNav, navCallback)
        set.invoke(browser, popup, popupCallback)
        true
    } catch (e: Throwable) {
        LOG.info("Flutter embedded browser guard: ${((e as? InvocationTargetException)?.targetException ?: e).javaClass.simpleName}")
        false
    }

    /** A JxBrowser sync callback (`R on(P params)`) as a dynamic proxy. */
    private fun callback(iface: Class<*>, loader: ClassLoader, on: (Any?) -> Any?): Any =
        Proxy.newProxyInstance(loader, arrayOf(iface), InvocationHandler { self, method, args ->
            when (method.name) {
                "equals" -> self === args?.getOrNull(0)
                "hashCode" -> System.identityHashCode(self)
                "toString" -> "FlutterIntercept${iface.simpleName}"
                "on" -> on(args?.getOrNull(0))
                else -> if (method.isDefault) InvocationHandler.invokeDefault(self, method, *(args ?: emptyArray())) else null
            }
        })

    companion object {
        private val LOG = Logger.getInstance(FlutterEmbeddedBrowser::class.java)

        fun statusName(status: Any?): String? = (status as? Enum<*>)?.name ?: status?.toString()

        fun planFor(status: String?): Plan = when (status) {
            "INSTALLED" -> Plan.READY
            "NOT_INSTALLED" -> Plan.INSTALL
            "INSTALLATION_IN_PROGRESS" -> Plan.WAIT
            else -> Plan.UNAVAILABLE // INSTALLATION_FAILED, INSTALLATION_SKIPPED, unknown
        }
    }
}

/** Which browser the tool window uses: JCEF (IntelliJ IDEA) → Flutter plugin's JxBrowser (Android Studio) → system browser. */
enum class BrowserChoice { JCEF, FLUTTER, EXTERNAL }

fun chooseBrowser(jcefSupported: Boolean, flutterEmbeddedPresent: Boolean): BrowserChoice = when {
    jcefSupported -> BrowserChoice.JCEF
    flutterEmbeddedPresent -> BrowserChoice.FLUTTER
    else -> BrowserChoice.EXTERNAL
}
