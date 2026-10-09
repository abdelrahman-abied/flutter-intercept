/** Ready-to-paste client configurations for `flutterIntercept.connectAgent` (pure, unit-tested). */

export type AgentClient = 'claude' | 'cursor' | 'other';

export interface ConnectSnippet {
  client: AgentClient;
  label: string;
  /** What goes to the clipboard. Contains the token: treat as a secret. */
  text: string;
}

export const MCP_SERVER_NAME = 'flutter-intercept';

/** Shell-safe for the token alphabet (base64url) and our URL; refuse anything else rather than quote it. */
function assertSafe(url: string, token: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('unexpected token format');
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/mcp$/.test(url)) throw new Error('unexpected MCP URL');
}

export function connectSnippet(client: AgentClient, url: string, token: string): ConnectSnippet {
  assertSafe(url, token);
  const header = `Authorization: Bearer ${token}`;
  switch (client) {
    case 'claude':
      // Verified against `claude mcp add --help` (Claude Code CLI): --transport http <name> <url> --header "<k: v>"
      return {
        client,
        label: 'Claude Code',
        text: `claude mcp add --transport http ${MCP_SERVER_NAME} ${url} --header "${header}"`,
      };
    case 'cursor':
      return {
        client,
        label: 'Cursor',
        text: JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
      };
    default:
      return { client: 'other', label: 'Other MCP client', text: `URL: ${url}\nHeader: ${header}\nTransport: Streamable HTTP` };
  }
}
