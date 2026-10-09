/**
 * The `flutterIntercept.connectAgent` flow, with the UI injected (unit-tested without VS Code).
 * Clipboard only; the one thing it runs — `claude mcp add` — needs the user's explicit click.
 */
import { addToClaudeCode, type AddResult } from './claude';
import { connectSnippet, type AgentClient } from './connect';

export interface ConnectUi {
  pick(items: Array<{ label: string; description: string; client: AgentClient }>): Promise<AgentClient | undefined>;
  copy(text: string): Promise<void>;
  /** Information message with optional buttons; resolves to the clicked one. */
  info(message: string, ...buttons: string[]): Promise<string | undefined>;
  error(message: string): Promise<void>;
}

export const ADD_TO_CLAUDE_NOW = 'Add to Claude Code now';
export const COPY_ALTERNATIVE = 'Copy settings.json snippet instead';

const SECRET_NOTE = "It contains your Flutter Intercept access token: treat it like a password — don't commit or share it.";

export async function runConnectAgent(
  ui: ConnectUi,
  opts: {
    url: string;
    token: string;
    /** Cursor zero-config registration is active (only inside Cursor). */
    cursorAutoRegistered?: boolean;
    addToClaude?: (url: string, token: string) => Promise<AddResult>;
  },
): Promise<void> {
  const client = await ui.pick([
    { label: 'Claude Code', description: 'copies a `claude mcp add …` command (or adds it for you)', client: 'claude' },
    {
      label: 'Cursor',
      description: opts.cursorAutoRegistered ? 'already registered automatically — copies an mcp.json snippet anyway' : 'copies an mcp.json snippet',
      client: 'cursor',
    },
    { label: 'Gemini CLI', description: 'copies a `gemini mcp add …` command (or a settings.json snippet)', client: 'gemini' },
    { label: 'Other MCP client', description: 'copies the URL and the Authorization header', client: 'other' },
  ]);
  if (!client) return;
  const snippet = connectSnippet(client, opts.url, opts.token);
  await ui.copy(snippet.text);

  if (client === 'claude') {
    const choice = await ui.info(`Copied the Claude Code command to the clipboard. ${SECRET_NOTE}`, ADD_TO_CLAUDE_NOW);
    if (choice !== ADD_TO_CLAUDE_NOW) return;
    const add = opts.addToClaude ?? ((url, token) => addToClaudeCode({ url, token }));
    const r = await add(opts.url, opts.token).catch((e) => ({ ok: false, replaced: false, message: `claude mcp add failed: ${e instanceof Error ? e.message : String(e)}` }));
    if (r.ok) await ui.info(r.message);
    else await ui.error(r.message);
    return;
  }
  if (client === 'gemini' && snippet.alternative) {
    const choice = await ui.info(`Copied the Gemini CLI command to the clipboard. ${SECRET_NOTE}`, COPY_ALTERNATIVE);
    if (choice === COPY_ALTERNATIVE) {
      await ui.copy(snippet.alternative.text);
      await ui.info(`Copied the ~/.gemini/settings.json entry instead. ${SECRET_NOTE}`);
    }
    return;
  }
  const cursorNote = client === 'cursor' && opts.cursorAutoRegistered ? ' (Cursor already has Flutter Intercept registered automatically; you only need this for another setup.)' : '';
  await ui.info(`Copied the ${snippet.label} configuration to the clipboard.${cursorNote} ${SECRET_NOTE} Nothing was written to any config file.`);
}
