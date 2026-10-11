package dev.flutterintercept.core

import com.intellij.notification.Notification
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project

/** Balloons in the "Flutter Intercept" notification group (plugin.xml). */
object Notifications {
    const val GROUP_ID = "Flutter Intercept"

    fun create(type: NotificationType, content: String, vararg actions: NotificationAction): Notification {
        val n = NotificationGroupManager.getInstance().getNotificationGroup(GROUP_ID)
            .createNotification("Flutter Intercept", escape(content), type)
        actions.forEach { n.addAction(it) }
        return n
    }

    fun notify(project: Project?, type: NotificationType, content: String, vararg actions: NotificationAction): Notification =
        create(type, content, *actions).also { it.notify(project) }

    /** Notification content is HTML; sidecar messages are plain text. */
    fun escape(text: String): String = text
        .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace("\n", "<br>")
}
