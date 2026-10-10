/**
 * `web-server` device (CONTRACTS §14.7): Flutter does not start a browser, so nothing can be set up automatically. Once
 * per extension host we say so and offer a button that copies the exact command for a separate, throwaway Chrome that
 * goes through the proxy (fresh `--user-data-dir`, the install CA's SPKI pin) — never the user's own profile (REVIEW-5
 * #10), and never run by us: the user pastes it into a terminal if they want it.
 *
 * vscode-free; the host injects `show` (an information message with buttons), `copy` (the clipboard) and `proxy` (starts
 * the proxy if needed and loads the CA — only when the user clicks).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spkiPin } from '../ca';
import { WEB_PROXY_HOST } from './rewrite';

export const COPY_CHROME_COMMAND = 'Copy Chrome Command';

export interface WebServerNoticeDeps {
  /** Shows an information message with buttons; resolves with the clicked one. */
  show(message: string, ...actions: string[]): PromiseLike<string | undefined>;
  /** Writes text to the clipboard. */
  copy(text: string): PromiseLike<void>;
  /** Starts the proxy if needed; its port and this install's CA certificate (PEM). Called only after a click. */
  proxy(): Promise<{ port: number; caCertPem: string }>;
  log(msg: string): void;
  /** Test seams. */
  platform?: NodeJS.Platform;
  makeProfileDir?(): Promise<string>;
}

/** The browser flags a manually started Chrome needs: a fresh profile, our proxy, trust only for our CA. */
export function manualBrowserFlags(proxyPort: number, caPin: string, userDataDir: string): string[] {
  if (!Number.isInteger(proxyPort) || proxyPort <= 0 || proxyPort > 65535) throw new Error(`bad proxy port ${proxyPort}`);
  if (!/^[A-Za-z0-9+/]{43}=$/.test(caPin)) throw new Error('bad SPKI pin');
  if (!(path.posix.isAbsolute(userDataDir) || path.win32.isAbsolute(userDataDir)) || /["'\r\n%$`]/.test(userDataDir)) throw new Error('unusable profile directory');
  return [
    // Chrome only honours the SPKI pin with an explicit user-data-dir: a throwaway one, never the user's profile.
    `--user-data-dir=${userDataDir}`,
    `--proxy-server=http://${WEB_PROXY_HOST}:${proxyPort}`,
    `--ignore-certificate-errors-spki-list=${caPin}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
}

function quote(arg: string, platform: NodeJS.Platform): string {
  if (/^[A-Za-z0-9_./:=+@,-]+$/.test(arg)) return arg;
  if (platform === 'win32') {
    const eq = arg.indexOf('=');
    return eq > 0 ? `${arg.slice(0, eq + 1)}"${arg.slice(eq + 1)}"` : `"${arg}"`;
  }
  return `'${arg}'`;
}

/** A command line that starts Chrome with `flags` (macOS `open -na`, Windows `start`, Linux `google-chrome`). */
export function manualChromeCommand(flags: string[], platform: NodeJS.Platform = process.platform): string {
  const args = flags.map((f) => quote(f, platform)).join(' ');
  if (platform === 'darwin') return `open -na "Google Chrome" --args ${args}`;
  if (platform === 'win32') return `start "" chrome ${args}`;
  return `google-chrome ${args}`;
}

async function defaultProfileDir(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'flutter-intercept-chrome-'));
}

/**
 * The `PrepareDeps.webServerSkipped` handler: the first call shows `message` plus the copy button, later calls only log.
 */
export function createWebServerNotice(deps: WebServerNoticeDeps): (message: string) => void {
  let shown = false;
  return (message: string) => {
    deps.log(message);
    if (shown) return;
    shown = true;
    const text =
      `${message} To intercept it anyway, open the app in a separate Chrome started with Flutter Intercept's proxy flags ` +
      '(a fresh throwaway profile, never your own).';
    void Promise.resolve(deps.show(text, COPY_CHROME_COMMAND)).then(async (choice) => {
      if (choice !== COPY_CHROME_COMMAND) return;
      try {
        const { port, caCertPem } = await deps.proxy();
        const dir = await (deps.makeProfileDir ?? defaultProfileDir)();
        const platform = deps.platform ?? process.platform;
        const command = manualChromeCommand(manualBrowserFlags(port, spkiPin(caCertPem), dir), platform);
        await deps.copy(command);
        deps.log(`web-server: copied the manual Chrome command (proxy ${WEB_PROXY_HOST}:${port}, profile ${dir})`);
        void deps.show(
          'Copied. Paste it into a terminal, then open the URL `flutter run` prints for the web-server device in that Chrome window. ' +
            'Keep the extension running: that window has no network while the proxy is stopped.',
        );
      } catch (e) {
        deps.log(`web-server: could not prepare the manual Chrome command: ${(e as Error)?.message ?? e}`);
        void deps.show(`Flutter Intercept could not prepare the Chrome command: ${(e as Error)?.message ?? e}`);
      }
    }, () => undefined);
  };
}
