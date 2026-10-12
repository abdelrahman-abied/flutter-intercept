/**
 * Agent tools: export (QUALITY-1 Q5: split out of api.ts). Each handler gets the shared AgentViews and its parsed input.
 */
import * as path from 'path';
import type { ExportResult } from '../../export/types';
import type { Screenshot } from '../../screenshot/types';
import { writeExportFile } from '../har';
import { ToolInput } from '../schema';
import { AgentToolError, TOOL_IMAGES, ToolImage, ToolResult } from '../types';
import { SCREENSHOT_RECENT_MS, SCREENSHOT_RECENT_MAX, MAX_SCREENSHOT_BYTES } from '../shared';
import type { AgentViews } from '../views';
import type { ToolHandlers } from './types';

/** The document title / file name base: the given title, else the app's pubspec name, else the folder name. */
export function projectTitle(ag: AgentViews, root: string): string {
  return ag.deps.appPackageName?.() || path.basename(root) || 'Flutter app';
}


/** export_openapi / export_postman: redacted per setting, written under .dart_tool/flutter_intercept/exports/. */
export async function exportSpec(ag: AgentViews, format: 'openapi' | 'postman', i: ToolInput<'export_openapi'>): Promise<ToolResult> {
  const build = format === 'openapi' ? ag.deps.exporters?.openapi : ag.deps.exporters?.postman;
  if (!build) throw new AgentToolError(`${format === 'openapi' ? 'OpenAPI' : 'Postman'} export is not available in this build of Flutter Intercept`, 'state');
  const root = ag.deps.projectRoot();
  if (!root) throw new AgentToolError('no workspace folder is open to export into', 'state');
  const keep = ag.filter({ url: i.url, method: i.method, sinceMs: i.sinceMs, includeBrowserInternal: i.includeBrowserInternal });
  const list = ag.deps.host.getExchanges().filter(keep);
  let r: ExportResult;
  try {
    r = build(list, { title: i.title ?? projectTitle(ag, root), redact: ag.redact });
  } catch (e) {
    throw new AgentToolError(`the ${format} export failed: ${(e as Error)?.message ?? String(e)}`, 'internal');
  }
  if (!r.exchanges) {
    throw new AgentToolError(`no finished HTTP request${i.url ? ` matches ${i.url}` : ' is recorded'}${i.sinceMs !== undefined ? ' since sinceMs' : ''}; make the app call the API first (WebSocket, SSE and browser-internal traffic is not exported)`, 'not_found');
  }
  const file = await writeExportFile(root, r.text, format === 'openapi' ? '.openapi.json' : '.postman_collection.json', new Date(ag.now()));
  return { path: file, exchanges: r.exchanges, routes: r.routes, notes: r.notes.slice(0, 50).map((n) => ag.text(String(n))), redacted: ag.redact };
}

// ------------------------------------------------------------------ v0.10.0 (CONTRACTS §16.4)


/**
 * take_screenshot (CONTRACTS §13.8): allowed under read-only access (the front doors confirm every call), refused
 * when `flutterIntercept.agent.screenshots` is off. The PNG travels as an image part (TOOL_IMAGES), the JSON
 * names the file and the requests that started in the SCREENSHOT_RECENT_MS before it (redacted summaries).
 */
export async function takeScreenshot(ag: AgentViews, i: ToolInput<'take_screenshot'>): Promise<ToolResult> {
  if (ag.deps.getSettings().screenshots === false) {
    throw new AgentToolError('screenshots are turned off for agents (setting flutterIntercept.agent.screenshots)', 'access');
  }
  if (!ag.deps.takeScreenshot) throw new AgentToolError('screenshots are not available in this build of Flutter Intercept', 'state');
  const sessions = ag.deps.launcher.sessions();
  let session: (typeof sessions)[number] | undefined;
  if (i.sessionId !== undefined) {
    session = sessions.find((s) => s.id === i.sessionId);
    if (!session) throw new AgentToolError(`no intercepted debug session "${i.sessionId}" (get_status lists them)`, 'not_found');
  } else if (sessions.length === 1) {
    session = sessions[0];
  } else if (!sessions.length) {
    throw new AgentToolError('no app is running: start it with launch_app first', 'state');
  } else {
    throw new AgentToolError(`${sessions.length} apps are running; pass sessionId (one of ${sessions.map((s) => s.id).slice(0, 10).join(', ')})`, 'invalid');
  }
  const root = ag.deps.projectRoot();
  if (!root) throw new AgentToolError('no workspace folder is open to save the screenshot into', 'state');
  let shot: Screenshot;
  try {
    shot = await ag.deps.takeScreenshot({ sessionId: session.id, ...(session.deviceId ? { deviceId: session.deviceId } : {}), projectRoot: root });
  } catch (e) {
    throw new AgentToolError(`take_screenshot: ${ag.text((e as Error)?.message ?? String(e))}`, 'state');
  }
  const at = Number.isFinite(shot.takenAt) ? shot.takenAt : ag.now();
  const recent = ag.deps.host
    .getExchanges()
    .filter((e) => !e.browserInternal && e.startedAt >= at - SCREENSHOT_RECENT_MS && e.startedAt <= at)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, SCREENSHOT_RECENT_MAX)
    .map((e) => ag.summary(e));
  const bytes = shot.png?.length ?? 0;
  const inline = bytes > 0 && bytes <= MAX_SCREENSHOT_BYTES;
  const result: ToolResult = {
    path: shot.path,
    ...(shot.width !== undefined ? { width: shot.width } : {}),
    ...(shot.height !== undefined ? { height: shot.height } : {}),
    takenAt: at,
    method: shot.method,
    bytes,
    sessionId: session.id,
    ...(session.deviceId ? { deviceId: session.deviceId } : {}),
    recentRequests: recent,
    ...(inline ? {} : { note: bytes ? 'the image is too large to send inline; open the file at path' : 'the screenshot is empty' }),
  };
  if (inline) {
    const images: ToolImage[] = [{ data: shot.png.toString('base64'), mimeType: 'image/png' }];
    Object.defineProperty(result, TOOL_IMAGES, { value: images, enumerable: false });
  }
  return result;
}

export const exportTools: ToolHandlers = {
  export_openapi: (ag, i) => exportSpec(ag, 'openapi', i),
  export_postman: (ag, i) => exportSpec(ag, 'postman', i),
  take_screenshot: (ag, i) => takeScreenshot(ag, i),
};
