/**
 * Real Claude Code client suite (FI_SUITE=claude, opt-in: FI_CLAUDE=1). Runs ONE headless `claude -p`
 * against the MCP server of the extension under test (VS Code or Cursor host), on samples/demo_app on
 * the macOS desktop device, and asserts from the EXTENSION side that the agent really drove the app.
 *
 * Isolation: temp MCP config (--mcp-config + --strict-mcp-config), no built-in tools (--tools ""),
 * only `mcp__flutter-intercept` allowed, --permission-mode dontAsk (never prompts), no session
 * persistence, cwd = a temp dir. The user's Claude config is never written.
 * Evidence (stream-json + summary) goes to FI_CLAUDE_EVIDENCE (a scratch dir).
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { activateBoth, freePort, registerOutputTracker, RunOutcome, sleep, waitFor } from './helpers';

const SECRETS = ['demo-secret-123', 'demo-key-456'];
const REQUIRED = ['get_status', 'launch_app', 'wait_for_request', 'add_mock', 'hot_restart', 'remove_rule', 'stop_app'];
const USERS1 = 'https://jsonplaceholder.typicode.com/users/1';

const TASK =
  'Use only the flutter-intercept tools. Check the status, then launch the app on device "macos". ' +
  `Wait for the GET request to ${USERS1} and note its status. Then make that endpoint return HTTP 500 with ` +
  'body {"error":"boom"} (mock it), hot restart the app, and wait for the app\'s next GET request to that URL ' +
  '(only requests after the restart) and confirm it got 500. Finally remove the rule you added and stop the app. ' +
  'Reply with only a short JSON summary: {"firstStatus":..., "afterMockStatus":..., "ruleRemoved":..., "stopped":...}.';

function runClaude(args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      // Never let the IDE host / a parent Claude Code session leak into the child.
      if (/^(VSCODE_|ELECTRON_|CLAUDE|CURSOR_|FI_)/.test(k)) continue;
      env[k] = v;
    }
    const t0 = Date.now();
    const p = spawn(process.env.FI_CLAUDE_BIN || '/opt/homebrew/bin/claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => p.kill('SIGTERM'), timeoutMs);
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - t0 });
    });
  });
}

export async function runClaudeSuite(): Promise<RunOutcome[]> {
  const host = `${vscode.env.appName} ${vscode.version}`;
  const out: RunOutcome = { name: `CLAUDE CODE drives Flutter Intercept over MCP in ${host}`, output: '', proxyHits: [], failures: [], ms: 0 };
  const f = out.failures;
  const t0 = Date.now();
  registerOutputTracker();
  const { api } = await activateBoth();
  const cfg = vscode.workspace.getConfiguration('flutterIntercept');
  await cfg.update('port', await freePort(), vscode.ConfigurationTarget.Global);
  await cfg.update('enabled', true, vscode.ConfigurationTarget.Global);
  const mcp = (api as any).mcp as
    | { url?: string; token(): Thenable<string | undefined>; calls: { tool: string; at: number; ok: boolean }[]; logs: string[] }
    | undefined;
  if (!mcp) return [{ ...out, failures: ['api.mcp missing (FI_TEST_EXPOSE_MCP_TOKEN not applied)'] }];
  await waitFor(() => mcp.url || undefined, 30_000, 200).catch(() => undefined);
  if (!mcp.url) return [{ ...out, failures: ['MCP server not running'] }];
  await sleep(8_000); // Flutter daemon device discovery (macos)
  // Cursor: the extension registers its MCP server with Cursor itself (vscode.cursor.mcp.registerServer).
  const isCursor = typeof (vscode as any).cursor?.mcp?.registerServer === 'function';
  const cursorLine = mcp.logs.find((l) => /MCP: (registered with Cursor|Cursor registration failed)/.test(l));
  if (isCursor && !/registered with Cursor/.test(cursorLine ?? '')) f.push(`Cursor MCP registration not confirmed: ${cursorLine ?? 'no log line'}`);

  const evidence = process.env.FI_CLAUDE_EVIDENCE || fs.mkdtempSync(path.join(os.tmpdir(), 'fi-claude-ev-'));
  fs.mkdirSync(evidence, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-claude-cwd-'));
  const mcpConfig = path.join(work, 'mcp.json');
  // Same shape `claude mcp add-json` uses for an HTTP server.
  fs.writeFileSync(
    mcpConfig,
    JSON.stringify({ mcpServers: { 'flutter-intercept': { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${await mcp.token()}` } } } }),
    { mode: 0o600 },
  );
  const callsBefore = mcp.calls.length;
  const since = Date.now();
  const args = [
    '-p',
    TASK,
    '--mcp-config',
    mcpConfig,
    '--strict-mcp-config',
    '--tools',
    '',
    '--allowedTools',
    'mcp__flutter-intercept',
    '--permission-mode',
    'dontAsk',
    '--no-session-persistence',
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-budget-usd',
    process.env.FI_CLAUDE_BUDGET || '1.50',
  ];
  console.log(`[suite] claude: running headless Claude Code against ${mcp.url} (cwd ${work})`);
  const r = await runClaude(args, work, Number(process.env.FI_CLAUDE_TIMEOUT_MS || 600_000));
  fs.rmSync(mcpConfig, { force: true }); // contains the token
  const tag = (vscode.env.appName || 'host').replace(/\W+/g, '_');
  fs.writeFileSync(path.join(evidence, `claude-${tag}.stream.jsonl`), r.stdout);
  if (r.stderr) fs.writeFileSync(path.join(evidence, `claude-${tag}.stderr.txt`), r.stderr);

  // ---- what Claude did, from Claude's side (evidence only) ----
  const events = r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
  const final = events.filter((e: any) => e.type === 'result').pop();
  const toolUses = events
    .filter((e: any) => e.type === 'assistant')
    .flatMap((e: any) => (e.message?.content ?? []).filter((c: any) => c.type === 'tool_use').map((c: any) => String(c.name)));
  fs.writeFileSync(
    path.join(evidence, `claude-${tag}.summary.json`),
    JSON.stringify({ host, exit: r.code, ms: r.ms, toolUses, result: final?.result, cost: final?.total_cost_usd, turns: final?.num_turns, isError: final?.is_error }, null, 2),
  );
  if (r.code !== 0) f.push(`claude exited ${r.code}: ${r.stderr.slice(0, 300)}`);
  if (!final) f.push('no result event from claude');
  else if (final.is_error) f.push(`claude result is_error: ${String(final.result).slice(0, 300)}`);

  // ---- assertions from the EXTENSION side ----
  const calls = mcp.calls.slice(callsBefore);
  const okTools = new Set(calls.filter((c) => c.ok).map((c) => c.tool));
  const missing = REQUIRED.filter((t) => !okTools.has(t));
  if (missing.length) f.push(`tools not called successfully: ${missing.join(', ')} (seen: ${calls.map((c) => `${c.tool}${c.ok ? '' : '!'}`).join(' ')})`);
  const ex = api.getExchanges().filter((e) => e.startedAt >= since && e.url === USERS1);
  const mocked500 = ex.filter((e) => e.state === 'mocked' && e.status === 500);
  const real200 = ex.filter((e) => e.state === 'completed' && e.status === 200);
  if (!mocked500.length) f.push(`no mocked 500 exchange for users/1 (states: ${ex.map((e) => `${e.state}/${e.status}`).join(', ')})`);
  if (mocked500.length && !String(mocked500[0].responseBody?.text ?? '').includes('boom')) f.push(`mocked body: ${mocked500[0].responseBody?.text}`);
  if (!real200.length) f.push('no real 200 exchange for users/1 before the mock');
  const leftover = api.getRules().filter((rule) => (rule.name ?? '').startsWith('[agent] '));
  if (leftover.length) f.push(`agent rules left: ${JSON.stringify(leftover)}`);
  await sleep(3000);
  const live = vscode.debug.activeDebugSession;
  if (live && live.configuration?.flutterInterceptOriginalProgram) f.push(`debug session still running: ${live.name}`);
  const token = (await mcp.token()) ?? '<none>';
  const leaked = [...SECRETS, token].filter((s) => r.stdout.includes(s) || r.stderr.includes(s) || mcp.logs.some((l) => l.includes(s)));
  if (leaked.length) f.push(`secret values in Claude's input/output or the extension log: ${leaked.map((s) => (s === token ? '<MCP token>' : s)).join(', ')}`);

  out.ms = Date.now() - t0;
  out.mode =
    `claude ${Math.round(r.ms / 1000)} s, ${final?.num_turns ?? '?'} turns, $${final?.total_cost_usd ?? '?'}; ` +
    `extension saw ${calls.length} calls [${[...new Set(calls.map((c) => c.tool))].join(', ')}]; users/1: ${real200.length}x real 200, ${mocked500.length}x mocked 500; ` +
    `agent rules left ${leftover.length}; secrets/token in claude stream or extension log: ${leaked.length ? leaked.length : 'none'}` +
    (isCursor ? `; Cursor: ${cursorLine}` : '');
  out.output = String(final?.result ?? '').slice(0, 600);
  console.log(`[suite] ${f.length ? 'FAIL' : 'ok  '} ${out.name} (${out.ms} ms) ${out.mode}${f.length ? '\n         ' + f.join('\n         ') : ''}\n[suite] claude said: ${out.output}`);
  return [out];
}
