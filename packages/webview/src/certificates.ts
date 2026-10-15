/**
 * v0.14.0 (CONTRACTS §20): servers that need the app's own certificate (mutual TLS), hosts the proxy learned to pass
 * through, and the "Add client certificate" popup's texts. Pure: no DOM.
 */
import { hostGlobMatch } from './connection';
import type { ClientCertFileRole, Exchange, Status } from './protocol';
import { formatRemaining } from './util';

export { LEARNED_REASON } from './connection';

export type LearnedEntry = NonNullable<Status['learnedPassthrough']>[number];
export type LearnedRef = NonNullable<Exchange['learnedPassthrough']>;

/** The popup's two ways to give a certificate: one PKCS#12 file, or a PEM certificate + its private key. */
export type CertFormat = 'pfx' | 'pem';

/** "host:port" — how the panel names a learned host (display and React keys; the host formats the proxy's key). */
export function learnedKey(e: Pick<LearnedRef, 'host' | 'port'>): string {
  return `${e.host}:${e.port}`;
}

/** The popup's host prefill: the host, plus `:port` when it isn't 443. */
export function certHostFor(e: Pick<LearnedRef, 'host' | 'port'>): string {
  return e.port === 443 ? e.host : `${e.host}:${e.port}`;
}

/** The configured certificate pattern that covers this host:port, if any (display only; the host decides). */
export function certCovering(e: Pick<LearnedRef, 'host' | 'port'>, certs: Status['clientCertificates']): string | undefined {
  return certs?.find((c) => hostGlobMatch(c.host, e.host, String(e.port)))?.host;
}

/** Is this learned host still passed through? (An older host without `Status.learnedPassthrough` → assume yes.) */
export function isLearnedLive(e: Pick<LearnedRef, 'host' | 'port'>, live: readonly LearnedEntry[] | undefined): boolean {
  if (!live) return true;
  const key = learnedKey(e).toLowerCase();
  return live.some((l) => learnedKey(l).toLowerCase() === key);
}

/**
 * Entries still in force at `now`. The proxy announces an expired pin on a timer (REVIEW-14 #6), but the Status the
 * panel holds can still list it until that broadcast arrives (or from an older host): never show it, nor count it.
 * Returns `list` itself when nothing expired (cheap, keeps memoised identities).
 */
export function liveLearned<T extends Pick<LearnedEntry, 'until'>>(list: readonly T[] | undefined, now: number): readonly T[] | undefined {
  if (!list || !list.some((l) => l.until !== undefined && l.until <= now)) return list;
  return list.filter((l) => l.until === undefined || l.until > now);
}

/** The earliest `until` still ahead of `now` (one timer re-checks then), or undefined. */
export function nextLearnedExpiry(list: readonly Pick<LearnedEntry, 'until'>[] | undefined, now: number): number | undefined {
  let next: number | undefined;
  for (const l of list ?? []) if (l.until !== undefined && l.until > now && (next === undefined || l.until < next)) next = l.until;
  return next;
}

/** "until the proxy stops" / "for 8m 10s more". */
export function learnedUntilText(e: Pick<LearnedEntry, 'until'>, now: number): string {
  return e.until === undefined ? 'until the proxy stops' : `for ${formatRemaining(e.until - now)} more`;
}

/** The banner on a request / tunnel the proxy learned from (CONTRACTS §20.3). */
export function learnedBannerText(e: LearnedRef): { title: string; body: string } {
  if (e.reason === 'client-certificate') {
    return {
      title: 'This server needs the app\'s own certificate…',
      body: `${e.host} asks the app to prove who it is with a certificate (mutual TLS). Flutter Intercept doesn't have ` +
        'that certificate, so from now on it passes this server\'s connections straight through: the app keeps working, ' +
        'but these requests can\'t be shown. Add the certificate to see them.',
    };
  }
  return {
    title: `${e.host} doesn't accept the proxy's certificate…`,
    body: 'The app checks the server\'s certificate itself (certificate pinning) and refused the one Flutter Intercept ' +
      'shows, so for a few minutes this server\'s connections are passed straight through: the app keeps working, but ' +
      'these requests can\'t be shown. To see them, let the app trust the Flutter Intercept certificate in debug builds.',
  };
}

/** Popup text: why the certificate is needed (CONTRACTS §20.3, the owner's wording). */
export const CERT_WHY =
  'This server asks the app to prove who it is with a certificate (mutual TLS). Flutter Intercept sits between your app ' +
  'and the server, so to show you these requests it has to present the same certificate to the server. Without it, the ' +
  'requests still work but are passed through without decryption.';

/** Popup text: the certificate stays on this computer (CONTRACTS §20.3); `ide` = Android Studio / IntelliJ. */
export function certStaysText(ide: boolean): string {
  return 'The certificate stays where it is on this computer: Flutter Intercept only remembers its location and reads it ' +
    'when connecting. It is never uploaded or sent anywhere except to this server during the TLS handshake, exactly as ' +
    `your app does. The passphrase is kept in ${ide ? 'the IDE\'s password safe' : 'VS Code\'s secret storage'}.`;
}

export const FILE_ROLE_LABEL: Record<ClientCertFileRole, string> = {
  pfx: 'Certificate file (.p12 / .pfx)',
  cert: 'Certificate (.pem / .crt)',
  key: 'Private key (.pem / .key)',
};

/** The files each format needs, in order. */
export const FORMAT_ROLES: Record<CertFormat, ClientCertFileRole[]> = { pfx: ['pfx'], pem: ['cert', 'key'] };

/** Why Save can't be used yet (undefined = it can). */
export function certSaveBlocker(host: string, format: CertFormat, files: Partial<Record<ClientCertFileRole, unknown>>): string | undefined {
  if (!host.trim()) return 'Enter the server\'s host name.';
  const missing = FORMAT_ROLES[format].filter((r) => !files[r]);
  if (!missing.length) return undefined;
  if (format === 'pfx') return 'Choose the certificate file.';
  return missing.length === 2 ? 'Choose the certificate and its private key.'
    : missing[0] === 'cert' ? 'Choose the certificate.' : 'Choose the private key.';
}
