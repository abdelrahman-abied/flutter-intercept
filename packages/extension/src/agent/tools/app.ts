/**
 * Agent tools: the app's debug sessions and the rule list (QUALITY-1 Q5: split out of api.ts).
 */
import type { ToolHandlers } from './types';

export const appTools: ToolHandlers = {
  list_rules: (c) => ({ rules: c.deps.host.getRules().map((r) => c.ruleView(r)) }),
  launch_app: (c, i) => c.triggered(() => c.deps.launcher.launch({ deviceId: i.deviceId, program: i.program, flutterMode: i.flutterMode })),
  stop_app: (c, i) => c.deps.launcher.stop(i.sessionId),
  hot_restart: (c, i) => c.triggered(() => c.deps.launcher.hotRestart(i.sessionId)),
};
