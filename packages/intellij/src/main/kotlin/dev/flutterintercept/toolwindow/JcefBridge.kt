// JCEF through reflection: IntelliJ IDEA ships JCEF, but Android Studio 2026.2 doesn't (no com.intellij.ui.jcef
// classes and no CEF in its JBR), so the plugin can't link against it. Everything here degrades to "unsupported".
package dev.flutterintercept.toolwindow

import com.intellij.openapi.Disposable
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.util.Disposer
import java.lang.reflect.InvocationHandler
import java.lang.reflect.Method
import java.lang.reflect.Proxy
import javax.swing.JComponent

object JcefBridge {
    private val LOG = Logger.getInstance(JcefBridge::class.java)
    private val loader: ClassLoader get() = JcefBridge::class.java.classLoader

    private fun cls(name: String): Class<*>? = try {
        Class.forName(name, false, loader)
    } catch (_: Throwable) {
        null
    }

    /** `JBCefApp.isSupported()`, false when JCEF isn't there at all. */
    fun isSupported(): Boolean = try {
        cls("com.intellij.ui.jcef.JBCefApp")?.getMethod("isSupported")?.invoke(null) as? Boolean ?: false
    } catch (_: Throwable) {
        false
    }

    /**
     * A browser on [url] whose navigation [guard] decides (current UI origin only; other http(s) links open in the
     * system browser). Null when JCEF can't be used. Disposed with [parent].
     */
    fun create(url: String, guard: NavigationGuard, parent: Disposable): Browser? {
        if (!isSupported()) return null
        return try {
            val browserClass = cls("com.intellij.ui.jcef.JBCefBrowser") ?: return null
            val browser = browserClass.getConstructor(String::class.java).newInstance(url)
            (browser as? Disposable)?.let { Disposer.register(parent, it) }
            installNavigationGuard(browser, guard)
            Browser(browser, guard)
        } catch (e: Throwable) {
            LOG.warn("JCEF browser couldn't be created: ${e.javaClass.simpleName}")
            null
        }
    }

    class Browser internal constructor(private val impl: Any, private val guard: NavigationGuard) {
        val component: JComponent get() = impl.javaClass.getMethod("getComponent").invoke(impl) as JComponent

        /** Loads a fresh one-time URL (never the same one twice: it's spent once served). */
        fun load(url: String) {
            guard.expect(url)
            impl.javaClass.getMethod("loadURL", String::class.java).invoke(impl, url)
        }

        fun dispose() {
            (impl as? Disposable)?.let { Disposer.dispose(it) }
        }
    }

    private fun installNavigationGuard(browser: Any, guard: NavigationGuard) {
        try {
            val client = browser.javaClass.getMethod("getJBCefClient").invoke(browser)
            val cefBrowser = browser.javaClass.getMethod("getCefBrowser").invoke(browser)
            val cefBrowserClass = cls("org.cef.browser.CefBrowser") ?: return
            val requestHandlerClass = cls("org.cef.handler.CefRequestHandler")
            val lifeSpanHandlerClass = cls("org.cef.handler.CefLifeSpanHandler")
            if (requestHandlerClass != null) {
                val handler = proxy(requestHandlerClass) { method, args ->
                    if (method.name == "onBeforeBrowse" && args != null && args.size >= 3) {
                        val target = args[2]?.let { req -> req.javaClass.getMethod("getURL").invoke(req) as? String }.orEmpty()
                        guard.onBeforeBrowse(target)
                    } else null
                }
                client.javaClass.getMethod("addRequestHandler", requestHandlerClass, cefBrowserClass).invoke(client, handler, cefBrowser)
            }
            if (lifeSpanHandlerClass != null) {
                val handler = proxy(lifeSpanHandlerClass) { method, args ->
                    if (method.name == "onBeforePopup" && args != null && args.size >= 3) {
                        guard.onPopup(args[2] as? String)
                        true // never open a JCEF popup window
                    } else null
                }
                client.javaClass.getMethod("addLifeSpanHandler", lifeSpanHandlerClass, cefBrowserClass).invoke(client, handler, cefBrowser)
            }
        } catch (e: Throwable) {
            LOG.warn("JCEF navigation guard not installed: ${e.javaClass.simpleName}")
        }
    }


    /** An interface implementation whose unhandled methods return false / null (like the CEF adapters). */
    private fun proxy(iface: Class<*>, handle: (Method, Array<out Any?>?) -> Any?): Any =
        Proxy.newProxyInstance(loader, arrayOf(iface), InvocationHandler { self, method, args ->
            when (method.name) {
                "equals" -> return@InvocationHandler self === args?.getOrNull(0)
                "hashCode" -> return@InvocationHandler System.identityHashCode(self)
                "toString" -> return@InvocationHandler "FlutterIntercept${iface.simpleName}"
            }
            val r = try { handle(method, args) } catch (_: Throwable) { null }
            r ?: when (method.returnType) {
                java.lang.Boolean.TYPE -> false
                java.lang.Integer.TYPE -> 0
                java.lang.Long.TYPE -> 0L
                else -> null
            }
        })
}
