/**
 * Cursor zero-config: register the MCP server with Cursor's extension API
 * (`vscode.cursor.mcp.registerServer({ name, server: { url, headers? } })` / `unregisterServer(name)`,
 * https://cursor.com/docs/extension-api). Pure (the API object is injected) so it is unit-tested.
 *
 * Measured in Cursor 3.23.23 (workbench source): the main-thread side keeps only `server.url` and DROPS
 * `headers`, and it logs the URL. So the Bearer header alone would give 401s. We register:
 * - `headers: { Authorization: 'Bearer <token>' }` (honoured by Cursor builds that forward headers), and
 * - a URL carrying a SEPARATE, revocable path credential (`/mcp/k/<ephemeral>`): a fresh one per
 *   registration (server start, port change, re-enable), revoked on unregister/stop. If it ends up in
 *   Cursor's log it is dead after the next restart, and it is never the long-lived token.
 */

export const CURSOR_SERVER_NAME = 'flutter-intercept';

/** The part of Cursor's API we use (typed shim; anything else is ignored). */
export interface CursorMcpApi {
  registerServer(config: { name: string; server: { url: string; headers?: Record<string, string> } }): unknown;
  unregisterServer(name: string): unknown;
}

/** `vscode.cursor.mcp` when it looks like Cursor's API, else undefined (VS Code, other forks). */
export function detectCursorMcp(vscodeModule: unknown): CursorMcpApi | undefined {
  try {
    const mcp = (vscodeModule as { cursor?: { mcp?: Partial<CursorMcpApi> } })?.cursor?.mcp;
    if (mcp && typeof mcp.registerServer === 'function' && typeof mcp.unregisterServer === 'function') return mcp as CursorMcpApi;
  } catch {
    /* a throwing getter: treat as absent */
  }
  return undefined;
}

export interface CursorTarget {
  /** Issues a fresh path credential on the running server and returns the URL that carries it. */
  issueUrl(): string;
  /** Revokes the path credential. */
  revoke(): void;
  token: string;
}

export class CursorRegistrar {
  private registered = false;
  private failed = false;

  constructor(
    private readonly api: CursorMcpApi | undefined,
    private readonly log: (m: string) => void,
  ) {}

  get available(): boolean {
    return this.api !== undefined && !this.failed;
  }

  get isRegistered(): boolean {
    return this.registered;
  }

  /**
   * Make Cursor's registration match the server: `target` = running server, `undefined` = stopped.
   * Always re-registers when a server is given (Cursor ignores a second register of the same name,
   * so a moved/restarted server needs unregister + register). Never throws.
   */
  async sync(target: CursorTarget | undefined): Promise<void> {
    if (!this.api || this.failed) return;
    await this.unregister();
    if (!target) return;
    try {
      const url = target.issueUrl();
      await this.api.registerServer({ name: CURSOR_SERVER_NAME, server: { url, headers: { Authorization: `Bearer ${target.token}` } } });
      this.registered = true;
      this.log('MCP: registered with Cursor (zero-config)');
    } catch (e) {
      target.revoke();
      this.failed = true; // the API shape differs: stop trying, the connect command still works
      this.log(`MCP: Cursor registration failed (${e instanceof Error ? e.message : String(e)}); use "Connect AI Agent" instead`);
    }
  }

  async unregister(): Promise<void> {
    if (!this.api || !this.registered) return;
    this.registered = false;
    try {
      await this.api.unregisterServer(CURSOR_SERVER_NAME);
      this.log('MCP: unregistered from Cursor');
    } catch (e) {
      this.log(`MCP: Cursor unregister failed (${e instanceof Error ? e.message : String(e)})`);
    }
  }
}
