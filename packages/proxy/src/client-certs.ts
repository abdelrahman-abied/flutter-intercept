// Client certificates (CONTRACTS §14.3): loading, problems and the web-page refusal text. Pure.

import * as tls from 'tls';
import { parseHostPattern, type HostPattern } from './hosts';
import type { ClientCertificate } from './types';
import type { LoadedCert } from './flow-types';

/** Validate one configured certificate by building a TLS context from it. Problems never quote key material. */
export function loadClientCertificate(c: ClientCertificate): { host: string; cert?: LoadedCert; problem?: string } {
  const host = c && typeof c === 'object' && typeof c.host === 'string' ? c.host.trim() : '';
  if (!c || typeof c !== 'object') return { host, problem: 'Not a certificate entry.' };
  let pattern: HostPattern;
  try {
    pattern = parseHostPattern(c.host);
  } catch (e) {
    return { host, problem: `Invalid host: ${(e as Error).message}.` };
  }
  const hasPfx = c.pfx !== undefined && c.pfx !== null;
  const hasPem = c.cert !== undefined || c.key !== undefined;
  if (hasPfx && hasPem) return { host, problem: 'Give either a PKCS#12 file (pfx) or a PEM certificate and key, not both.' };
  if (!hasPfx && !hasPem) return { host, problem: 'No certificate: give a PKCS#12 file (pfx) or a PEM certificate and key.' };
  if (c.passphrase !== undefined && typeof c.passphrase !== 'string') return { host, problem: 'The passphrase must be text.' };
  const options: LoadedCert['options'] = {};
  if (hasPfx) {
    if (!(c.pfx instanceof Uint8Array) || !c.pfx.length) return { host, problem: 'The PKCS#12 file is empty or not binary data.' };
    options.pfx = Buffer.from(c.pfx);
  } else {
    if (typeof c.cert !== 'string' || !c.cert.trim()) return { host, problem: 'The PEM certificate is missing.' };
    if (typeof c.key !== 'string' || !c.key.trim()) return { host, problem: 'The PEM private key is missing.' };
    options.cert = c.cert;
    options.key = c.key;
  }
  if (c.passphrase) options.passphrase = c.passphrase;
  try {
    tls.createSecureContext(options);
  } catch (e) {
    return { host, problem: certProblem(e, hasPfx) };
  }
  return { host, cert: { pattern, host: pattern.pattern, options } };
}

/** OpenSSL's error, in words (codes stripped; it never contains the key or passphrase, but is cut short anyway). */
export function certProblem(e: unknown, pfx: boolean): string {
  const raw = String((e as Error)?.message ?? e);
  const what = pfx ? 'PKCS#12 file' : 'PEM certificate / key';
  if (/mac verify failure/i.test(raw)) return `Could not open the ${what}: wrong passphrase (or a damaged file).`;
  if (/bad decrypt|bad password|interrupted or cancelled/i.test(raw)) return `Could not decrypt the private key: wrong or missing passphrase.`;
  if (/key values mismatch/i.test(raw)) return 'The private key does not belong to the certificate.';
  if (/unsupported/i.test(raw) && pfx) {
    return 'Unsupported PKCS#12 encryption (a legacy algorithm such as RC2-40); export it again with AES (openssl pkcs12 -export -keypbe AES-256-CBC -certpbe AES-256-CBC).';
  }
  if (/no start line|PEM routines|bad base64|DECODER routines/i.test(raw)) return `Could not read the ${what}: not valid PEM.`;
  if (/not enough data|wrong tag|asn1|header too long/i.test(raw)) return `Could not read the ${what}: not a valid file.`;
  const clean = raw.replace(/error:[0-9A-Fa-f]+:[^:]*:[^:]*:/g, '').trim().slice(0, 200);
  return `Could not load the ${what}: ${clean || 'unknown error'}.`;
}

/** `http(s)://localhost | 127.0.0.1 | [::1]` with any port: the Flutter Web dev server's own origin. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]');
  } catch {
    return false;
  }
}

export const CERT_REFUSAL_MARKER = 'Refused: a client certificate is configured';

export function certRefusalText(host: string, origin: string): string {
  return (
    `${CERT_REFUSAL_MARKER} for ${host.replace(/^\[|\]$/g, '')}, and this request comes from a web page ` +
    `(Origin ${String(origin).slice(0, 200)}), not the app. Client certificates are only presented for the app's own requests.`
  );
}

