/**
 * The single implementation of the agent tools (CONTRACTS §8). The MCP server and the VS Code
 * language model tools only translate to `call(tool, input)`. No `vscode` import: everything it
 * needs comes in through `AgentApiDeps` (wired by extension.ts).
 *
 * QUALITY-1 Q5: the tools live in src/agent/tools/* (one module per area), the views in views.ts, the shared state and
 * helpers in context.ts / shared.ts. This class keeps the access checks, input parsing and the call listeners.
 */
import { parseToolInput } from './schema';
import { appTools } from './tools/app';
import { assertTools } from './tools/assert';
import { contractTools } from './tools/contract';
import { exportTools } from './tools/export';
import { grpcTools } from './tools/grpc';
import { networkTools } from './tools/network';
import { recordingsTools } from './tools/recordings';
import { rulesTools } from './tools/rules';
import { trafficTools } from './tools/traffic';
import type { ToolHandler } from './tools/types';
import { AgentAccess, AgentTools, AgentToolError, isWriteTool, ToolName, ToolResult } from './types';
import { AgentViews } from './views';
import type { AgentApiDeps } from './shared';

// Kept for importers of api.ts (the module was split; see the header).
export { AGENT_RULE_PREFIX, MAX_ASSERT_FAILURES, MAX_JSON_FAILURES_PER_EXCHANGE, MAX_FRAME_RESULT_CHARS, GRPC_MESSAGES_PER_DIR, MAX_GRPC_MESSAGES_JSON, OUTSIDE_PROJECT, SCREENSHOT_RECENT_MS, SCREENSHOT_RECENT_MAX, MAX_SCREENSHOT_BYTES, AGENT_REWRITE_FORBIDDEN, globOrigin, agentMockRefusal, sensitiveQueryProbe, protoTypeLabel, jsonEqual, restoreRedactedJson, restoreRedactedHeaders, restoreRedactedQuery } from './shared';
export type { AgentApiDeps, ResolvedFrame } from './shared';
export { FINAL_STATES } from './samples';

/** Every tool's handler: the type requires all of them. */
const HANDLERS: { [T in ToolName]: ToolHandler<T> } = {
  ...trafficTools,
  ...rulesTools,
  ...networkTools,
  ...contractTools,
  ...assertTools,
  ...recordingsTools,
  ...exportTools,
  ...grpcTools,
  ...appTools,
} as { [T in ToolName]: ToolHandler<T> };

export class AgentApi extends AgentViews implements AgentTools {
  private readonly listeners = new Set<(e: { tool: ToolName; at: number; ok: boolean }) => void>();

  constructor(deps: AgentApiDeps) {
    super(deps);
  }

  get access(): AgentAccess {
    return this.deps.getSettings().access;
  }

  onDidCall(listener: (e: { tool: ToolName; at: number; ok: boolean }) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  async call(tool: ToolName, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    let ok = false;
    try {
      const access = this.access;
      if (access === 'off') throw new AgentToolError('Flutter Intercept agent access is off (setting flutterIntercept.agent.access).', 'access');
      if (isWriteTool(tool) && access !== 'readWrite') {
        throw new AgentToolError(`"${tool}" changes app traffic or sessions, but agent access is read-only (setting flutterIntercept.agent.access).`, 'access');
      }
      let parsed: unknown;
      try {
        parsed = parseToolInput(tool, input);
      } catch (e) {
        throw new AgentToolError((e as Error).message, 'invalid');
      }
      const result = await this.dispatch(tool, parsed, signal);
      ok = true;
      return result;
    } catch (e) {
      if (e instanceof AgentToolError) throw e;
      throw new AgentToolError(`${tool} failed: ${(e as Error)?.message ?? String(e)}`, 'internal');
    } finally {
      const ev = { tool, at: this.now(), ok };
      for (const l of this.listeners) {
        try {
          l(ev);
        } catch {
          // a listener must never break a tool call
        }
      }
    }
  }

  // ------------------------------------------------------------------ dispatch

  private dispatch(tool: ToolName, input: unknown, signal?: AbortSignal): Promise<ToolResult> | ToolResult {
    if (!Object.prototype.hasOwnProperty.call(HANDLERS, tool)) throw new AgentToolError(`unknown tool ${String(tool)}`, 'invalid');
    return (HANDLERS[tool] as ToolHandler<ToolName>)(this, input as never, signal);
  }
}

export function createAgentApi(deps: AgentApiDeps): AgentApi {
  return new AgentApi(deps);
}
