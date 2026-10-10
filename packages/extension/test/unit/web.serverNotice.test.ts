/**
 * web-server device (CONTRACTS §14.7): a one-time notice; the manual Chrome command is only prepared and copied
 * after a click, and always uses a fresh throwaway profile.
 */
import { describe, expect, it } from 'vitest';
import { mockttpCaGenerator, spkiPin } from '../../src/ca';
import { COPY_CHROME_COMMAND, createWebServerNotice, manualBrowserFlags, manualChromeCommand } from '../../src/debug/webServerNotice';

const PIN = 'M5zrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAqQxw=';

describe('manual flags', () => {
  it('fresh profile + proxy + SPKI pin, validated', () => {
    expect(manualBrowserFlags(9123, PIN, '/tmp/fi-x')).toEqual([
      '--user-data-dir=/tmp/fi-x',
      '--proxy-server=http://127.0.0.1:9123',
      `--ignore-certificate-errors-spki-list=${PIN}`,
      '--no-first-run',
      '--no-default-browser-check',
    ]);
    expect(() => manualBrowserFlags(0, PIN, '/tmp/x')).toThrow();
    expect(() => manualBrowserFlags(1, 'nope', '/tmp/x')).toThrow();
    expect(() => manualBrowserFlags(1, PIN, 'relative')).toThrow();
    expect(() => manualBrowserFlags(1, PIN, "/tmp/a'b")).toThrow();
    expect(() => manualBrowserFlags(1, PIN, '/tmp/$(rm)')).toThrow();
  });
  it('per-platform command lines, quoted', () => {
    const f = manualBrowserFlags(9123, PIN, '/tmp/with space');
    expect(manualChromeCommand(f, 'darwin')).toMatch(/^open -na "Google Chrome" --args '--user-data-dir=\/tmp\/with space' --proxy-server=http:\/\/127\.0\.0\.1:9123 /);
    expect(manualChromeCommand(f, 'linux')).toMatch(/^google-chrome '--user-data-dir=\/tmp\/with space' /);
    const w = manualChromeCommand(manualBrowserFlags(9123, PIN, 'C:\\Temp\\fi x'), 'win32');
    expect(w).toMatch(/^start "" chrome --user-data-dir="C:\\Temp\\fi x" --proxy-server=/);
  });
});

describe('createWebServerNotice', () => {
  const flush = () => new Promise((r) => setTimeout(r, 20));

  it('shows once; nothing is started or copied unless the button is clicked', async () => {
    const shown: string[][] = [];
    let proxyCalls = 0;
    const notice = createWebServerNotice({
      show: async (m, ...a) => (shown.push([m, ...a]), undefined),
      copy: async () => { throw new Error('no copy'); },
      proxy: async () => (proxyCalls++, { port: 1, caCertPem: '' }),
      log: () => undefined,
    });
    notice('Flutter Intercept: web-server device.');
    notice('Flutter Intercept: web-server device.');
    await flush();
    expect(shown).toHaveLength(1);
    expect(shown[0][0]).toMatch(/^Flutter Intercept: web-server device\. To intercept it anyway/);
    expect(shown[0][1]).toBe(COPY_CHROME_COMMAND);
    expect(proxyCalls).toBe(0);
  });

  it('click → proxy started, CA pinned, a fresh profile, command copied', async () => {
    const ca = (await mockttpCaGenerator('notice')).cert;
    const copied: string[] = [];
    const shown: string[] = [];
    const notice = createWebServerNotice({
      show: async (m, ...a) => (shown.push(m), a.includes(COPY_CHROME_COMMAND) ? COPY_CHROME_COMMAND : undefined),
      copy: async (t) => void copied.push(t),
      proxy: async () => ({ port: 9123, caCertPem: ca }),
      log: () => undefined,
      platform: 'linux',
      makeProfileDir: async () => '/tmp/flutter-intercept-chrome-abc',
    });
    notice('Flutter Intercept: web-server device.');
    await flush();
    expect(copied).toEqual([
      `google-chrome --user-data-dir=/tmp/flutter-intercept-chrome-abc --proxy-server=http://127.0.0.1:9123 --ignore-certificate-errors-spki-list=${spkiPin(ca)} --no-first-run --no-default-browser-check`,
    ]);
    expect(shown[1]).toMatch(/^Copied\./);
  }, 60_000);

  it('a failure is reported, never thrown', async () => {
    const shown: string[] = [];
    const notice = createWebServerNotice({
      show: async (m, ...a) => (shown.push(m), a.length ? COPY_CHROME_COMMAND : undefined),
      copy: async () => undefined,
      proxy: async () => Promise.reject(new Error('port in use')),
      log: () => undefined,
    });
    notice('x');
    await flush();
    expect(shown[1]).toMatch(/could not prepare the Chrome command: port in use/);
  });
});
