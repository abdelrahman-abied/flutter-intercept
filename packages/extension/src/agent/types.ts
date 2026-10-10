/**
 * Agent API surface shared by every front door (CONTRACTS §8). `AgentApi` (api.ts) implements
 * `AgentTools`; the MCP server (mcp/) and the VS Code language model tools (lmTools.ts) only translate.
 */

export const READ_TOOLS = [
  'get_status',
  'list_requests',
  'get_request',
  'wait_for_request',
  'list_paused',
  'list_rules',
  'export_har',
  // CONTRACTS §9.5
  'get_request_source',
  'get_body_shape',
  // CONTRACTS §10.6
  'check_contract',
  'generate_model',
  'generate_fixture_test',
  'assert_traffic',
  // CONTRACTS §11.5
  'get_frames',
] as const;

export const WRITE_TOOLS = [
  'add_mock',
  'add_block',
  'add_breakpoint',
  'remove_rule',
  'resume_request',
  'abort_request',
  'clear_requests',
  'launch_app',
  'stop_app',
  'hot_restart',
  // CONTRACTS §9.5
  'simulate_network',
  'resend_request',
  // CONTRACTS §10.6
  'add_mutation',
  // CONTRACTS §11.5
  'add_cors_rule',
] as const;

export type ReadToolName = (typeof READ_TOOLS)[number];
export type WriteToolName = (typeof WRITE_TOOLS)[number];
export type ToolName = ReadToolName | WriteToolName;

export type AgentAccess = 'readWrite' | 'readOnly' | 'off';

/** Every tool takes a plain JSON object and returns a plain JSON-serialisable object. */
export type ToolResult = Record<string, unknown>;

/** Thrown (and turned into a tool error by the front doors) for refused or invalid calls. */
export class AgentToolError extends Error {
  constructor(
    message: string,
    readonly code: 'access' | 'invalid' | 'not_found' | 'state' | 'timeout' | 'internal' = 'invalid',
  ) {
    super(message);
    this.name = 'AgentToolError';
  }
}

export interface AgentTools {
  readonly access: AgentAccess;
  /** Runs one tool by name with already-validated input. Rejects with AgentToolError. */
  call(tool: ToolName, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
  /** Fires on every tool call (for the UI's "agent connected / last call" indicator). */
  onDidCall(listener: (e: { tool: ToolName; at: number; ok: boolean }) => void): { dispose(): void };
}

/** Launch / stop / hot restart are implemented outside api.ts (launch.ts) and injected into it. */
export interface AppLauncher {
  launch(opts: { deviceId?: string; program?: string; flutterMode?: 'debug' | 'profile' }): Promise<{ sessionId: string }>;
  stop(sessionId?: string): Promise<{ stopped: number }>;
  hotRestart(sessionId?: string): Promise<{ restarted: number }>;
  sessions(): { id: string; deviceId?: string; program: string; mode: string; lan?: boolean }[];
}

export const isWriteTool = (t: ToolName): t is WriteToolName => (WRITE_TOOLS as readonly string[]).includes(t);
