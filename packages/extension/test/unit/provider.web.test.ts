/**
 * prepareLaunch on Flutter Web (CONTRACTS §11.3) with a stubbed `vscode`: the provider loads the CA only
 * when a launch is intercepted, puts the browser flags in place (mutating the caller's object), never
 * writes an entry, and reports web-server launches for a one-time notice.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const settings: Record<string, unknown> = {};
let selectedDevice: string | undefined;
vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: (section: string) => ({
      get: (key: string, dflt?: unknown) => (`${section}.${key}` in settings ? settings[`${section}.${key}`] : dflt),
    }),
    get workspaceFolders() {
      return [{ uri: { fsPath: app, scheme: 'file' } }];
    },
  },
  window: { activeTextEditor: undefined },
  commands: { executeCommand: async () => selectedDevice },
}));

import { mockttpCaGenerator, spkiPin } from '../../src/ca';
import { InterceptEvent, prepareLaunch, PrepareDeps } from '../../src/debug/provider';
import { WEB_FLAGS_KEY } from '../../src/debug/rewrite';

let app: string;
let ca: string;
beforeAll(async () => {
  app = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-prov-'));
  fs.writeFileSync(path.join(app, 'pubspec.yaml'), 'name: web_app\ndependencies:\n  flutter:\n    sdk: flutter\n');
  fs.mkdirSync(path.join(app, 'lib'));
  fs.writeFileSync(path.join(app, 'lib', 'main.dart'), 'void main() {}');
  ca = (await mockttpCaGenerator('prov')).cert;
}, 60_000);
afterAll(() => fs.rmSync(app, { recursive: true, force: true }));
beforeEach(() => {
  for (const k of Object.keys(settings)) delete settings[k];
  selectedDevice = undefined;
});

function deps() {
  const calls = { start: 0, ca: 0, reverse: 0, webServer: [] as string[], profile: [] as string[] };
  const events: InterceptEvent[] = [];
  const d: PrepareDeps = {
    proxyHost: { start: async () => (calls.start++, 9123) } as unknown as PrepareDeps['proxyHost'],
    getCaCertPem: async () => (calls.ca++, ca),
    log: () => undefined,
    events,
    reverses: { reverse: async () => void calls.reverse++ } as unknown as PrepareDeps['reverses'],
    webServerSkipped: (m) => calls.webServer.push(m),
    webUserProfileSkipped: (m) => calls.profile.push(m),
  };
  return { d, calls, events };
}

const folder = () => ({ uri: { fsPath: app, scheme: 'file' }, name: 'web_app', index: 0 }) as any;
const resolved = (over: Record<string, unknown> = {}) => ({
  type: 'dart',
  request: 'launch',
  name: 'web',
  program: path.join(app, 'lib', 'main.dart'),
  cwd: app,
  debuggerType: 2,
  toolEnv: {},
  deviceId: 'chrome',
  ...over,
});

describe('prepareLaunch: Flutter Web', () => {
  it('chrome: proxy started, CA loaded, flags added in place, no entry written', async () => {
    const { d, calls, events } = deps();
    const config: any = resolved({ toolArgs: ['--web-port=5000'] });
    const out = await prepareLaunch(d, folder(), config, 'resolveDebugConfigurationWithSubstitutedVariables');
    expect(out).toBe(config);
    expect(config.program).toBe(path.join(app, 'lib', 'main.dart'));
    expect(config.toolArgs).toEqual([
      '--web-port=5000',
      '--web-browser-flag=--proxy-server=http://127.0.0.1:9123',
      `--web-browser-flag=--ignore-certificate-errors-spki-list=${spkiPin(ca)}`,
    ]);
    expect(config.flutterInterceptProxyHost).toBe('127.0.0.1');
    expect(config.flutterInterceptPort).toBe(9123);
    expect(calls).toMatchObject({ start: 1, ca: 1, reverse: 0 });
    expect(fs.existsSync(path.join(app, '.dart_tool', 'flutter_intercept'))).toBe(false);
    expect(events.at(-1)).toMatchObject({ result: 'rewrite', mode: 'web' });
  });

  it('device chosen in the status bar (no deviceId yet, before Dart-Code)', async () => {
    selectedDevice = 'chrome';
    const { d } = deps();
    const config: any = { type: 'dart', request: 'launch', name: 'web' };
    await prepareLaunch(d, folder(), config, 'resolveDebugConfigurationWithSubstitutedVariables');
    expect(config.program).toBeUndefined();
    expect(config[WEB_FLAGS_KEY]).toHaveLength(2);
    expect(config.toolArgs).toEqual(config[WEB_FLAGS_KEY]);
    expect(fs.existsSync(path.join(app, '.dart_tool', 'flutter_intercept'))).toBe(false);
  });

  it('flutterIntercept.web.enabled=false: untouched, nothing started', async () => {
    settings['flutterIntercept.web.enabled'] = false;
    const { d, calls } = deps();
    const config: any = resolved();
    await prepareLaunch(d, folder(), config, 'resolveDebugConfigurationWithSubstitutedVariables');
    expect(config).toEqual(resolved());
    expect(calls).toMatchObject({ start: 0, ca: 0 });
  });

  it('re-resolve after turning web off removes our flags', async () => {
    const { d } = deps();
    const config: any = resolved({ toolArgs: ['-v'] });
    await prepareLaunch(d, folder(), config, 'resolveDebugConfigurationWithSubstitutedVariables');
    settings['flutterIntercept.web.enabled'] = false;
    await prepareLaunch(d, folder(), config, 'resolveDebugConfigurationWithSubstitutedVariables');
    expect(config).toEqual(resolved({ toolArgs: ['-v'] }));
  });

  it('web-server: skipped, the host is told why', async () => {
    const { d, calls } = deps();
    const config: any = resolved({ deviceId: 'web-server' });
    await prepareLaunch(d, folder(), config, 'resolveDebugConfigurationWithSubstitutedVariables');
    expect(config).toEqual(resolved({ deviceId: 'web-server' }));
    expect(calls.start).toBe(0);
    expect(calls.webServer).toHaveLength(1);
    expect(calls.webServer[0]).toMatch(/web-server device: Flutter does not start the browser/);
  });

  it('REVIEW-5 #10: user --user-data-dir → untouched, nothing started, the host is told why', async () => {
    const { d, calls } = deps();
    const toolArgs = ['--web-browser-flag=--user-data-dir=/tmp/my-profile'];
    const config: any = resolved({ toolArgs });
    await prepareLaunch(d, folder(), config, 'resolveDebugConfigurationWithSubstitutedVariables');
    expect(config).toEqual(resolved({ toolArgs }));
    expect(calls).toMatchObject({ start: 0, ca: 0 });
    expect(calls.webServer).toEqual([]);
    expect(calls.profile).toHaveLength(1);
    expect(calls.profile[0]).toMatch(/your own profile/);
  });

  it('user --user-data-dir from dart.flutterRunAdditionalArgs is honoured too', async () => {
    settings['dart.flutterRunAdditionalArgs'] = ['--web-browser-flag=--user-data-dir=/tmp/p'];
    const { d, calls } = deps();
    const config: any = resolved();
    await prepareLaunch(d, folder(), config, 'resolveDebugConfigurationWithSubstitutedVariables');
    expect(config).toEqual(resolved());
    expect(calls.profile).toHaveLength(1);
  });
});
