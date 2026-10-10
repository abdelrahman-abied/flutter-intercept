// CORS diagnosis and header building (CONTRACTS §11.3). Pure and dependency-free (type-only imports):
// exported as `@flutter-intercept/proxy/cors` for the webview / host, and used by the proxy itself.
//
// What a browser checks (Fetch standard, "CORS check" and "CORS-preflight fetch"), applied to a recorded
// exchange. The request is a CORS request when it carries `Origin`, is cross-origin, and (when the browser
// says so) `Sec-Fetch-Mode: cors`. Whether a request carries credentials can't be known for sure from the
// wire; a `Cookie` header is taken as "credentials included".
import type { CorsInfo, Exchange } from './types';

type HeaderBag = Record<string, string | string[] | undefined>;

/**
 * How long a browser may cache a preflight the proxy answers. Short on purpose (REVIEW-5 #3): a cached answer
 * outlives the rule that produced it and would hide the real server's CORS problem while the user checks a fix.
 */
export const PREFLIGHT_MAX_AGE_S = 5;

/** Server / app-controlled values quoted into `CorsInfo.problem` are cut to this many characters (REVIEW-5 #13). */
const MAX_QUOTED = 200;

/** A header value as quoted text in a problem message: JSON-quoted (escapes controls), capped. */
function q(v: string): string {
  return JSON.stringify(v.length > MAX_QUOTED ? `${v.slice(0, MAX_QUOTED)}…` : v);
}

const SAFELISTED_METHODS = new Set(['GET', 'HEAD', 'POST']);
/** Response headers a page can always read (no Access-Control-Expose-Headers needed). */
const SAFELISTED_RESPONSE_HEADERS = new Set([
  'cache-control',
  'content-language',
  'content-length',
  'content-type',
  'expires',
  'last-modified',
  'pragma',
]);
/** Never listed in Access-Control-Expose-Headers by the proxy. */
const NOT_EXPOSED = new Set(['set-cookie', 'set-cookie2', 'connection', 'keep-alive', 'transfer-encoding', 'vary']);

function header(h: HeaderBag | undefined, name: string): string | undefined {
  if (!h) return undefined;
  const lname = name.toLowerCase();
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === lname && v !== undefined) return Array.isArray(v) ? v.join(', ') : v;
  }
  return undefined;
}

function headerCount(h: HeaderBag | undefined, name: string): number {
  if (!h) return 0;
  const lname = name.toLowerCase();
  let n = 0;
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === lname && v !== undefined) n += Array.isArray(v) ? v.length : 1;
  }
  return n;
}

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

/** The request's Origin, when it has a usable one (`null` origins included: sandboxed / file pages). */
export function requestOrigin(headers: HeaderBag | undefined): string | undefined {
  const o = header(headers, 'origin')?.trim();
  return o ? o : undefined;
}

/** An `OPTIONS` request with `Origin` and `Access-Control-Request-Method`: a CORS preflight. */
export function isPreflight(method: string, headers: HeaderBag | undefined): boolean {
  return (
    (method ?? '').toUpperCase() === 'OPTIONS' && !!requestOrigin(headers) && !!header(headers, 'access-control-request-method')?.trim()
  );
}

/** The method a preflight asks about (upper-cased), if it is one. */
export function preflightMethod(method: string, headers: HeaderBag | undefined): string | undefined {
  return isPreflight(method, headers) ? header(headers, 'access-control-request-method')!.trim().toUpperCase() : undefined;
}

function urlOrigin(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.origin === 'null' ? undefined : u.origin;
  } catch {
    return undefined;
  }
}

/** True when the browser applies CORS to this request (Origin present, cross-origin, `cors` mode if stated). */
export function isCorsRequest(method: string, url: string, headers: HeaderBag | undefined): boolean {
  const origin = requestOrigin(headers);
  if (!origin) return false;
  const mode = header(headers, 'sec-fetch-mode')?.trim().toLowerCase();
  if (mode && mode !== 'cors') return false;
  if (isPreflight(method, headers)) return true;
  return urlOrigin(url) !== origin;
}

const credentialed = (headers: HeaderBag | undefined) => !!header(headers, 'cookie');

/** Problems with Access-Control-Allow-Origin / -Credentials, or undefined when they pass. */
function originProblem(origin: string, res: HeaderBag | undefined, withCredentials: boolean): string | undefined {
  const acao = header(res, 'access-control-allow-origin')?.trim();
  if (acao === undefined || acao === '') return `No Access-Control-Allow-Origin header: the browser blocks the response for ${q(origin)}.`;
  if (headerCount(res, 'access-control-allow-origin') > 1 || acao.includes(',')) {
    return `Access-Control-Allow-Origin has several values (${q(acao)}); it must be exactly one origin or *.`;
  }
  if (acao === '*') {
    if (withCredentials) return 'Access-Control-Allow-Origin is * but the request carries credentials (cookies); it must name the origin.';
  } else if (acao !== origin) {
    return `Access-Control-Allow-Origin is ${q(acao)}, not the app's origin ${q(origin)}.`;
  }
  if (withCredentials && header(res, 'access-control-allow-credentials')?.trim() !== 'true') {
    return 'The request carries credentials (cookies) but Access-Control-Allow-Credentials is not true.';
  }
  return undefined;
}

type CorsExchange = Pick<Exchange, 'method' | 'url' | 'requestHeaders' | 'status' | 'responseHeaders'> &
  Partial<Pick<Exchange, 'kind' | 'captured' | 'cors'>>;

/**
 * Why a browser would block this exchange (CONTRACTS §11.3), for requests with `Origin`. undefined = not a
 * CORS request (no Origin, same-origin, a WebSocket, a `vm-profile` record). Until there is a response only
 * `preflight` is set. Checks: Access-Control-Allow-Origin (missing, several values, another origin, `*` with
 * credentials), Access-Control-Allow-Credentials for credentialed requests, and for preflights also the
 * status (2xx, never a redirect), Access-Control-Allow-Methods and Access-Control-Allow-Headers. `patched` is
 * carried over from `ex.cors`.
 */
export function diagnoseCors(ex: CorsExchange): CorsInfo | undefined {
  if (ex.kind === 'websocket' || ex.captured) return undefined;
  const req = ex.requestHeaders;
  if (!isCorsRequest(ex.method, ex.url, req)) return undefined;
  const origin = requestOrigin(req)!;
  const preflight = isPreflight(ex.method, req);
  const out: CorsInfo = {};
  if (preflight) out.preflight = true;
  if (ex.cors?.patched) out.patched = true;
  const status = ex.status;
  if (status === undefined || status === 0) return out;
  const res = ex.responseHeaders;
  let problem: string | undefined;
  if (preflight) {
    if (status >= 300 && status < 400) {
      problem = `The preflight was redirected (status ${status}); browsers never follow redirects for preflights.`;
    } else if (status < 200 || status >= 300) {
      problem = `The preflight got status ${status}; it must be 2xx.`;
    }
    problem ??= originProblem(origin, res, false);
    if (!problem) {
      const method = header(req, 'access-control-request-method')!.trim().toUpperCase();
      const allowed = list(header(res, 'access-control-allow-methods')).map((m) => m.toUpperCase());
      if (!SAFELISTED_METHODS.has(method) && !allowed.includes(method) && !allowed.includes('*')) {
        problem = `The preflight doesn't allow the method ${q(method)} (Access-Control-Allow-Methods: ${allowed.length ? q(allowed.join(', ')) : 'none'}).`;
      }
    }
    if (!problem) {
      const requested = list(header(req, 'access-control-request-headers')).map((h) => h.toLowerCase());
      const allowed = list(header(res, 'access-control-allow-headers')).map((h) => h.toLowerCase());
      const wildcard = allowed.includes('*');
      // `*` never covers Authorization.
      const missing = requested.filter((h) => !allowed.includes(h) && !(wildcard && h !== 'authorization'));
      if (missing.length) {
        problem = `The preflight doesn't allow the header${missing.length > 1 ? 's' : ''} ${q(missing.join(', '))} (Access-Control-Allow-Headers: ${allowed.length ? q(allowed.join(', ')) : 'none'}).`;
      }
    }
  } else {
    problem = originProblem(origin, res, credentialed(req));
  }
  if (problem) out.problem = problem;
  return out;
}

export interface CorsOptions {
  /** Access-Control-Allow-Origin to send. Default: the request's Origin, but only a loopback one (isLoopbackOrigin). */
  allowOrigin?: string;
  /** Send `Access-Control-Allow-Credentials: true`. Default: false; never with allowOrigin `*`. */
  allowCredentials?: boolean;
}

/**
 * The Flutter dev server's kind of origin: `http(s)://localhost|127.0.0.1|[::1][:port]`, nothing else (never
 * `null`, never a path). Automatic CORS only ever reflects these (REVIEW-5 #3).
 */
export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1' && u.hostname !== '[::1]') return false;
  return u.origin === origin;
}

/**
 * The Access-Control-Allow-Origin the proxy may send for this request: an explicit `allowOrigin` (a `cors`
 * rule's setting wins), else the request's Origin when it is a loopback origin; undefined = add nothing.
 */
export function allowedOrigin(requestHeaders: HeaderBag | undefined, o: CorsOptions = {}): string | undefined {
  const explicit = o.allowOrigin?.trim();
  if (explicit) return explicit;
  const origin = requestOrigin(requestHeaders);
  return isLoopbackOrigin(origin) ? origin : undefined;
}

function credentialsFor(acao: string, o: CorsOptions): boolean {
  return acao !== '*' && o.allowCredentials === true;
}

/**
 * Headers of a local answer to a preflight (status 204): allow-origin = allowedOrigin(), allow-methods /
 * allow-headers = what was requested, max-age 5 s, `Vary: Origin`; allow-credentials only when the options ask
 * for it; Chrome's private-network opt-in only for a loopback request Origin. undefined when no origin may be
 * allowed (the preflight should then go to the server).
 */
export function preflightResponseHeaders(requestHeaders: HeaderBag | undefined, o: CorsOptions = {}): Record<string, string> | undefined {
  const acao = allowedOrigin(requestHeaders, o);
  if (!acao) return undefined;
  const out: Record<string, string> = {
    'access-control-allow-origin': acao,
    'access-control-allow-methods':
      header(requestHeaders, 'access-control-request-method')?.trim().toUpperCase() || 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-max-age': String(PREFLIGHT_MAX_AGE_S),
  };
  const reqHeaders = header(requestHeaders, 'access-control-request-headers')?.trim();
  if (reqHeaders) out['access-control-allow-headers'] = reqHeaders;
  if (credentialsFor(acao, o)) out['access-control-allow-credentials'] = 'true';
  if (
    header(requestHeaders, 'access-control-request-private-network')?.trim() === 'true' &&
    isLoopbackOrigin(requestOrigin(requestHeaders))
  ) {
    out['access-control-allow-private-network'] = 'true';
  }
  if (acao !== '*') out.vary = 'Origin';
  out['content-length'] = '0';
  return out;
}

/**
 * Headers to put on an actual response so the browser lets the page read it: allow-origin, allow-credentials,
 * expose-headers (the response's own non-safelisted header names) and `Vary: Origin` (merged with an existing
 * Vary). `responseHeaderNames` are the response's header names. undefined when no origin may be allowed
 * (allowedOrigin): the response is then left as it is.
 */
export function corsResponseHeaders(
  requestHeaders: HeaderBag | undefined,
  responseHeaderNames: string[],
  existingVary: string | undefined,
  o: CorsOptions = {},
): Record<string, string> | undefined {
  const acao = allowedOrigin(requestHeaders, o);
  if (!acao) return undefined;
  const out: Record<string, string> = { 'access-control-allow-origin': acao };
  if (credentialsFor(acao, o)) out['access-control-allow-credentials'] = 'true';
  const expose = [
    ...new Set(
      responseHeaderNames
        .map((n) => n.toLowerCase())
        .filter((n) => !n.startsWith(':') && !n.startsWith('access-control-') && !SAFELISTED_RESPONSE_HEADERS.has(n) && !NOT_EXPOSED.has(n)),
    ),
  ];
  if (expose.length) out['access-control-expose-headers'] = expose.join(', ');
  if (acao !== '*') {
    const vary = list(existingVary);
    if (vary.includes('*')) out.vary = '*';
    else out.vary = vary.some((v) => v.toLowerCase() === 'origin') ? vary.join(', ') : [...vary, 'Origin'].join(', ');
  }
  return out;
}

/** Response headers the proxy replaces when it patches CORS onto a response. */
export const CORS_RESPONSE_HEADERS = [
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-expose-headers',
  'vary',
];

/** True when these response headers already carry Access-Control-Allow-Origin. */
export function hasAllowOrigin(headers: HeaderBag | undefined): boolean {
  return header(headers, 'access-control-allow-origin') !== undefined;
}
