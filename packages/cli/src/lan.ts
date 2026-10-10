/**
 * Physical iPhones in CI (CONTRACTS §7, §14.1). An iPhone can't reach this machine's loopback, so for the length of
 * one `test` run the proxy also listens on the default-route IPv4 (RFC 1918 only), gated by a per-run token the
 * app sends as `Proxy-Authorization` (the define is `flutter-intercept:<token>@<ip>:<port>`), pinned to the first
 * peer that authenticates, and SSRF-guarded by the proxy. The token is never printed: printed commands show
 * `flutter-intercept:***@…` (command.ts), and request headers carrying it are dropped before any output is written.
 */
import * as crypto from 'crypto';
import type { Exchange } from '@flutter-intercept/proxy';
import { lanAddressForIphone, type LanAddress } from '../../extension/src/lanAddress';
import { lanProxyAddress } from '../../extension/src/debug/rewrite';

export { lanAddressForIphone, lanProxyAddress };
export type { LanAddress };

/** 32 random bytes, base64url (CONTRACTS §7): new for every run. */
export function newRunToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** Printed once per run that uses the LAN listener. */
export const LAN_NOTES = [
  'physical iPhone: the app reaches the proxy over Wi-Fi/LAN on this machine\'s address, only for this run, with a one-run token.',
  '  - macOS: if the application firewall is on, allow incoming connections for node (System Settings > Network > Firewall), or the iPhone cannot connect.',
  '  - iOS asks the app for Local Network access on its first run. Nobody can answer that prompt in CI: run the app once by hand on the device and allow it, or the app\'s requests fail.',
  '  - The iPhone and this machine must be on the same network. Use a trusted one: on shared Wi-Fi others may observe the token (it stops working when the run ends).',
];

/** The LAN IPv4 to listen on, or an Error saying why there is none (the run is refused then). */
export async function resolveLanHost(lookup: () => Promise<LanAddress> = () => lanAddressForIphone()): Promise<string> {
  let r: LanAddress;
  try {
    r = await lookup();
  } catch (e) {
    throw new Error(`physical iPhone: could not find this machine's LAN address: ${(e as Error).message}`);
  }
  if (!r) {
    throw new Error(
      'physical iPhone: this machine has no LAN address (no IPv4 on the default-route interface), so the iPhone cannot reach the proxy. Connect this machine to the same Wi-Fi/LAN as the iPhone, or use an iOS simulator.',
    );
  }
  if ('problem' in r) throw new Error(`physical iPhone: ${r.problem}. Use a private Wi-Fi/LAN, or an iOS simulator.`);
  return r.address;
}

/**
 * Exchanges without `Proxy-Authorization` request headers (they carry the run's token on plain-HTTP requests from
 * the iPhone). Copies; the input is not changed.
 */
export function withoutProxyAuthorization(exchanges: Exchange[]): Exchange[] {
  return exchanges.map((e) => {
    const names = Object.keys(e.requestHeaders ?? {});
    if (!names.some((n) => n.toLowerCase() === 'proxy-authorization')) return e;
    const requestHeaders: Exchange['requestHeaders'] = {};
    for (const n of names) if (n.toLowerCase() !== 'proxy-authorization') requestHeaders[n] = e.requestHeaders[n];
    return { ...e, requestHeaders };
  });
}

/** flutter's verbose output includes dart-define values (the build passes them to Xcode / Gradle). */
export function isVerboseFlutter(args: string[]): boolean {
  return args.some((a) => a === '-v' || a === '--verbose' || a === '-vv');
}
