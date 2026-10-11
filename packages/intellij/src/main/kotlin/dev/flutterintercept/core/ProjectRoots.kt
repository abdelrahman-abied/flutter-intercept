// Workspace roots for the sidecar (types.ts InitParams.workspaceFolders) and the roots `ui.openFile` may open from.
package dev.flutterintercept.core

import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.roots.ProjectRootManager
import java.io.File

object ProjectRoots {
    /** The project's content roots, those holding a pubspec.yaml first; the base path when there are none. */
    fun workspaceFolders(project: Project): List<String> {
        if (project.isDisposed) return emptyList()
        val roots = try {
            ReadAction.computeBlocking<List<String>, RuntimeException> {
                if (project.isDisposed) emptyList()
                else ProjectRootManager.getInstance(project).contentRoots.filter { it.isInLocalFileSystem }.map { File(it.path).absolutePath }
            }
        } catch (_: Exception) {
            emptyList()
        }
        val all = roots.ifEmpty { listOfNotNull(project.basePath?.let { File(it).absolutePath }) }.distinct()
        return orderPubspecFirst(all) { File(it, "pubspec.yaml").isFile }
    }

    fun orderPubspecFirst(roots: List<String>, hasPubspec: (String) -> Boolean): List<String> {
        val (flutter, other) = roots.partition(hasPubspec)
        return flutter + other
    }

    /** Workspace folders of every open project (one sidecar serves all project windows). */
    fun allWorkspaceFolders(): List<String> =
        ProjectManager.getInstance().openProjects.filter { !it.isDisposed && !it.isDefault }.flatMap(::workspaceFolders).distinct()

    /**
     * Directories holding a pubspec.yaml: each workspace folder and its direct children (a Flutter app in a sub-folder
     * of a monorepo). Their package configs name the package roots.
     */
    fun pubspecRoots(folders: List<String>): List<String> {
        val out = LinkedHashSet<String>()
        for (f in folders) {
            val dir = File(f)
            if (File(dir, "pubspec.yaml").isFile) out += dir.absolutePath
            dir.listFiles()?.filter { it.isDirectory && !it.name.startsWith(".") && File(it, "pubspec.yaml").isFile }?.forEach { out += it.absolutePath }
        }
        return out.toList()
    }

    /** True when the project looks like a Dart / Flutter project (status bar widget availability). */
    fun isFlutterProject(project: Project): Boolean = pubspecRoots(workspaceFolders(project)).isNotEmpty()
}
