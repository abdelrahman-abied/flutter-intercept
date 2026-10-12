// QUALITY-1 Q5: a tool handler gets the shared AgentViews, its parsed input and the caller's abort signal.
import type { ToolInput } from '../schema';
import type { ToolName, ToolResult } from '../types';
import type { AgentViews } from '../views';

export type ToolHandler<T extends ToolName> = (c: AgentViews, input: ToolInput<T>, signal?: AbortSignal) => Promise<ToolResult> | ToolResult;
/** Some tools' handlers (one module's share); `api.ts` merges them into a complete map (type-checked). */
export type ToolHandlers = { [T in ToolName]?: ToolHandler<T> };
