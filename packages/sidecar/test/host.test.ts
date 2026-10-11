import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SidecarHost, usableFolder, type PluginLink } from '../src/host';
import { RpcFailure } from '../src/rpc';
import type { DeviceKind, InitResult, PrepareLaunchResult } from '../src/types';

interface FakeLink extends PluginLink {
  requests: { method: string; params: unknown }[];
  events: { event: string; data: unknown }[];
  answers: Record<string, (params: any) => unknown>;
}

function fakeLink(): FakeLink {
  const link: FakeLink = {
    requests: [],
    events: [],
    answers: {},
    async request<T>(method: string, params?: unknown): Promise<T> {
      link.requests.push({ method, params });
      const a = link.answers[method];
      if (!a) throw new RpcFailure(`unknown method ${method}`, 'unknown_method');
      return (await a(params)) as T;
    },
    event(event, data) {
      link.events.push({ event, data });
    },
  };
  return link;
}

const settings = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  port: 0,
  captureSource: true,
  webEnabled: true,
  nativeClients: 'profile',
  backgroundIsolates: 'intercept',
  notifications: 'errors',
  contractCheck: true,
  rewriteLocalhost: true,
  upstreamProxyIgnoreCertErrors: false,
  tlsPassthrough: [],
  clientCertificates: [],
  agent: { access: 'readWrite', redactSecrets: true, screenshots: true, mcpPort: 0 },
  ...over,
});

describe('SidecarHost', () => {
  let tmp: string;
  let project: string;
  let link: FakeLink;
  let host: SidecarHost;
  let init: InitResult;
  const logs: string[] = [];

  beforeAll(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fi-sidecar-')));
    project = path.join(tmp, 'demo_app');
    fs.mkdirSync(path.join(project, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(project, 'pubspec.yaml'), 'name: demo_app\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\n');
    fs.writeFileSync(path.join(project, 'lib', 'main.dart'), "import 'package:flutter/widgets.dart';\nvoid main() => runApp(const SizedBox());\n");
    link = fakeLink();
    host = new SidecarHost({
      link,
      log: (l) => logs.push(l),
      version: '0.9.0-test',
      webviewDir: path.join(__dirname, '..', '..', 'webview', 'dist'),
      adbPath: null,
      lanAddress: async () => ({ address: '192.168.77.7', iface: 'en0' }),
      webSocket: null,
    });
    init = (await host.handle('init', {
      dataDir: path.join(tmp, 'data'),
      workspaceFolders: [project],
      settings: settings(),
      theme: 'light',
      ide: { name: 'Android Studio', version: '2026.2', pluginVersion: '0.9.0' },
    })) as InitResult;
  }, 60_000);

  afterAll(async () => {
    await host.handle('shutdown', undefined);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('init returns the UI and MCP URLs, emits ready + status, never logs the tokens', async () => {
    expect(init.uiUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]{43}$/);
    expect(init.mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(init.version).toBe('0.9.0-test');
    expect(link.events.find((e) => e.event === 'ready')?.data).toEqual(init);
    expect(link.events.find((e) => e.event === 'status')?.data).toEqual({ proxyRunning: false, enabled: true, sessions: 0, paused: 0 });
    const oneTime = new URL(init.uiUrl).searchParams.get('t')!;
    expect(logs.join('\n')).not.toContain(oneTime);
    const wsToken = (host as unknown as { ui: { token: string } }).ui.token;
    host.log(`leak? ${wsToken}`);
    expect(logs.join('\n')).not.toContain(wsToken);
    const mcpToken = fs.readFileSync(path.join(tmp, 'data', 'mcp-token'), 'utf8');
    expect(mcpToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(tmp, 'data', 'mcp-token')).mode & 0o777).toBe(0o600);
    expect(logs.join('\n')).not.toContain(mcpToken);
    await expect(host.handle('init', {})).rejects.toThrow('already initialized');
    await expect(host.handle('nope', {})).rejects.toMatchObject({ code: 'unknown_method' });
  });

  it('connectAgent returns the client snippet with the persisted token', async () => {
    const r = (await host.handle('connectAgent', { client: 'claude' })) as { text: string };
    const token = fs.readFileSync(path.join(tmp, 'data', 'mcp-token'), 'utf8');
    expect(r.text).toBe(`claude mcp add --transport http flutter-intercept ${init.mcpUrl} --header "Authorization: Bearer ${token}"`);
    await expect(host.handle('connectAgent', { client: 'x' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('commands round-trip ui.* requests (save CA certificate → ui.save, ui.notify)', async () => {
    const target = path.join(tmp, 'ca.pem');
    link.answers['ui.save'] = () => target;
    link.answers['ui.notify'] = () => null;
    const r = (await host.handle('command', { name: 'saveCaCertificate' })) as { path: string };
    expect(r.path).toBe(target);
    expect(fs.readFileSync(target, 'utf8')).toMatch(/^-----BEGIN CERTIFICATE-----/);
    const save = link.requests.find((q) => q.method === 'ui.save')!;
    expect(save.params).toEqual({ defaultPath: path.join(project, 'flutter_intercept_ca.pem'), filters: { 'PEM certificate': ['pem', 'crt'] } });
    await new Promise((res) => setTimeout(res, 10));
    expect(link.requests.some((q) => q.method === 'ui.notify' && String((q.params as { message: string }).message).includes('saved the CA certificate'))).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(tmp, 'data', 'flutter-intercept-ca.json')).mode & 0o777).toBe(0o600);
    // cancelled dialog
    link.answers['ui.save'] = () => null;
    expect(await host.handle('command', { name: 'saveCaCertificate' })).toEqual({ path: null });
  }, 30_000);

  it('toggle flips enabled, reports it as settingsChanged + status', async () => {
    link.events.length = 0;
    expect(await host.handle('command', { name: 'toggle' })).toEqual({ enabled: false });
    expect(link.events).toContainEqual({ event: 'settingsChanged', data: { enabled: false } });
    expect(link.events.filter((e) => e.event === 'status').at(-1)?.data).toMatchObject({ enabled: false });
    const r = (await host.handle('prepareLaunch', launch('android-emulator', 'emulator-5554'))) as PrepareLaunchResult;
    expect(r).toEqual({ kind: 'skip', reason: 'Flutter Intercept is turned off' });
    await host.handle('command', { name: 'toggle' });
  });

  it('applies settings to the proxy host (upstream proxy, IDE proxy, TLS passthrough)', async () => {
    const ctl = (host as unknown as { controller: { status(): Record<string, unknown> } }).controller;
    await host.handle('settings', { settings: settings({ upstreamProxy: 'http://corp-proxy.test:3128', tlsPassthrough: ['*.bank.test'] }) });
    expect(ctl.status()).toMatchObject({ upstreamProxy: 'corp-proxy.test:3128', upstreamProxySource: 'flutterIntercept', tlsPassthrough: ['*.bank.test'] });
    await host.handle('settings', { settings: settings({ ideHttpProxy: { url: 'http://ide-proxy.test:8080', noProxy: ['localhost'] } }) });
    expect(ctl.status()).toMatchObject({ upstreamProxy: 'ide-proxy.test:8080', upstreamProxySource: 'http.proxy' });
    expect(ctl.status().tlsPassthrough).toBeUndefined();
    await host.handle('settings', { settings: settings() });
    expect(ctl.status().upstreamProxy).toBeUndefined();
  });

  const launch = (deviceKind: DeviceKind, deviceId?: string, flutterMode: 'debug' | 'profile' | 'release' = 'debug', args: string[] = ['--flavor', 'dev']) => ({
    launchId: `l-${deviceKind}-${deviceId ?? 'none'}`,
    projectRoot: project,
    program: path.join(project, 'lib', 'main.dart'),
    ...(deviceId ? { deviceId } : {}),
    deviceKind,
    flutterMode,
    additionalArgs: args,
  });

  /** Stable snapshot: project path, ports, hashes, tokens and pins replaced. */
  const normalize = (r: PrepareLaunchResult) =>
    JSON.parse(
      JSON.stringify(r)
        .split(project)
        .join('<project>')
        .replace(/ENTRY_SHA=[0-9a-f]+/g, 'ENTRY_SHA=<sha>')
        .replace(/flutter-intercept:[A-Za-z0-9_-]{43}@/g, 'flutter-intercept:<token>@')
        .replace(/spki-list=[A-Za-z0-9+/]{43}=/g, 'spki-list=<pin>')
        .replace(/(127\.0\.0\.1|localhost|10\.0\.2\.2):\d+/g, '$1:<port>')
        .replace(/flutter-intercept-\d+\.pac/g, 'flutter-intercept-<port>.pac'),
    );

  it('prepareLaunch rewrites per device kind like the VS Code provider', async () => {
    // LAN mode needs a real LAN interface; stand in for the listener (the define composition is what's checked here).
    const ph = (host as unknown as { proxyHost: { openLan(h: string): Promise<unknown> } }).proxyHost;
    const realOpenLan = ph.openLan;
    ph.openLan = async (h: string) => ({ host: h, port: 50123, token: 'T'.repeat(43) });
    const cases: [DeviceKind, string | undefined][] = [
      ['android-emulator', 'emulator-5554'],
      ['android-emulator', 'Pixel_9_API_36'],
      ['android-device', 'R5CT1234567'],
      ['ios-simulator', 'A1B2C3D4-0000-1111-2222-333344445555'],
      ['ios-device', '00008110-001234567890801E'],
      ['macos', 'macos'],
      ['linux', 'linux'],
      ['windows', 'windows'],
      ['web', 'chrome'],
      ['other', undefined],
    ];
    const out: Record<string, unknown> = {};
    for (const [kind, id] of cases) out[`${kind} ${id ?? '-'}`] = normalize((await host.handle('prepareLaunch', launch(kind, id))) as PrepareLaunchResult);
    ph.openLan = realOpenLan;
    expect(out).toMatchSnapshot();
    const entry = (out['macos macos'] as { program: string }).program.replace('<project>', project);
    expect(fs.readFileSync(entry, 'utf8')).toContain('-----BEGIN CERTIFICATE-----');
  }, 60_000);

  it('prepareLaunch skips release, web-server, tests, and strips our old defines', async () => {
    expect(await host.handle('prepareLaunch', launch('android-emulator', 'emulator-5554', 'release'))).toEqual({ kind: 'skip', reason: 'release build: never intercepted' });
    const ws = (await host.handle('prepareLaunch', launch('web', 'web-server'))) as PrepareLaunchResult;
    expect(ws.kind).toBe('skip');
    fs.mkdirSync(path.join(project, 'test'), { recursive: true });
    fs.writeFileSync(path.join(project, 'test', 'a_test.dart'), 'void main() {}\n');
    expect(await host.handle('prepareLaunch', { ...launch('macos', 'macos'), program: path.join(project, 'test', 'a_test.dart') })).toEqual({ kind: 'skip', reason: 'test entry point' });
    const again = (await host.handle('prepareLaunch', launch('macos', 'macos', 'profile', ['--dart-define=FLUTTER_INTERCEPT_PROXY=1.2.3.4:1', '--dart-define', 'FLUTTER_INTERCEPT_ENTRY_SHA=x', '--dart-define=OTHER=1']))) as { additionalArgs: string[] };
    expect(again.additionalArgs.filter((a) => a.includes('FLUTTER_INTERCEPT_PROXY'))).toHaveLength(1);
    expect(again.additionalArgs).not.toContain('FLUTTER_INTERCEPT_ENTRY_SHA=x');
    expect(again.additionalArgs).toContain('--dart-define=OTHER=1');
  });

  it('tracks sessions from prepared launches (status, agent sessions) and ends them', async () => {
    await host.handle('prepareLaunch', launch('macos', 'macos'));
    link.answers['ui.reveal'] = () => null;
    expect(await host.handle('sessionStarted', { launchId: 'l-macos-macos', sessionId: 's1', deviceId: 'macos' })).toEqual({ intercepted: true });
    expect(await host.handle('sessionStarted', { launchId: 'unknown', sessionId: 's2' })).toEqual({ intercepted: false });
    expect(link.events.filter((e) => e.event === 'status').at(-1)?.data).toMatchObject({ proxyRunning: true, sessions: 1 });
    expect(link.requests.some((q) => q.method === 'ui.reveal')).toBe(true);
    await host.handle('sessionEnded', { sessionId: 's1' });
    expect(link.events.filter((e) => e.event === 'status').at(-1)?.data).toMatchObject({ sessions: 0 });
  });

  it('uiUrl issues fresh one-time UI URLs', async () => {
    const a = (await host.handle('uiUrl', undefined)) as { url: string };
    const b = (await host.handle('uiUrl', undefined)) as { url: string };
    expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]{43}$/);
    expect(a.url).not.toBe(b.url);
    expect(new URL(a.url).origin).toBe(new URL(init.uiUrl).origin);
  });

  it('ignores root, missing (virtual) and relative workspace folders', async () => {
    expect(usableFolder('/')).toBe(false);
    expect(usableFolder(path.parse(project).root)).toBe(false);
    expect(usableFolder('/src-does-not-exist-fi')).toBe(false);
    expect(usableFolder('relative')).toBe(false);
    expect(usableFolder(project)).toBe(true);
    await host.handle('workspaceFolders', { workspaceFolders: ['/', '/src-does-not-exist-fi', project] });
    expect((host as unknown as { folders: string[] }).folders).toEqual([project]);
  });

  it('accepts the optional additions (workspaceFolders, uiVisible, fileSaved)', async () => {
    await host.handle('workspaceFolders', { workspaceFolders: [project, 'relative/ignored'] });
    await host.handle('uiVisible', { visible: true });
    expect(await host.handle('fileSaved', { path: path.join(project, 'x.js') })).toEqual({ approved: false });
    await expect(host.handle('fileSaved', { path: 'rel.js' })).rejects.toMatchObject({ code: 'invalid' });
  });
});
