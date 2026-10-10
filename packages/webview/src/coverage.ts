/**
 * v0.5.0 coverage helpers (CONTRACTS §11): GraphQL labels, native (VM-profile) exchanges, CORS diagnosis and the
 * dev-only CORS rule. Pure: no DOM.
 */
import type { Exchange, Rule } from './protocol';
import { headerValue, newId } from './util';

// ---------------------------------------------------------------- native clients (captured: 'vm-profile')

export function isNative(ex: Pick<Exchange, 'captured'>): boolean {
  return ex.captured === 'vm-profile';
}

/** Tooltip / reason for every intercept action that a native exchange can't use. */
export const NATIVE_READ_ONLY =
  'Read-only: recorded from the app\'s HTTP profile (a native client such as cupertino_http or cronet_http that ' +
  'bypasses the proxy). It was not intercepted — rules never apply to it, and it can\'t be mocked, blocked, ' +
  'paused or resent.';

// ---------------------------------------------------------------- GraphQL

/** "GQL getUser" for the list badge; "GQL" when the operation is anonymous. */
export function gqlLabel(ex: Pick<Exchange, 'graphql'>): string | undefined {
  const g = ex.graphql;
  if (!g) return undefined;
  return g.operationName ? `GQL ${g.operationName}` : 'GQL';
}

/** "GraphQL query getUser (persisted query)". */
export function gqlTitle(ex: Pick<Exchange, 'graphql'>): string | undefined {
  const g = ex.graphql;
  if (!g) return undefined;
  const parts = ['GraphQL', g.operationType ?? 'operation', g.operationName ?? '(anonymous)'];
  return `${parts.join(' ')}${g.persisted ? ' (persisted query: hash only, no query text)' : ''}`;
}

// ---------------------------------------------------------------- CORS

export type CorsStatus = 'problem' | 'ok' | 'preflight' | 'patched';
export const CORS_STATUSES: readonly CorsStatus[] = ['problem', 'ok', 'preflight', 'patched'];

export function corsMatches(ex: Pick<Exchange, 'cors'>, s: CorsStatus): boolean {
  const c = ex.cors;
  if (!c) return false;
  switch (s) {
    case 'problem': return !!c.problem;
    case 'ok': return !c.problem;
    case 'preflight': return !!c.preflight;
    case 'patched': return !!c.patched;
  }
}

/** The request's Origin header (browser requests: Flutter Web). */
export function requestOrigin(ex: Pick<Exchange, 'requestHeaders'>): string | undefined {
  const o = headerValue(ex.requestHeaders, 'origin')?.trim();
  return o && o !== 'null' ? o : undefined;
}

/** origin + path + "*" of the exchange URL (like the proxy's ruleFromExchange, but any method: the preflight too). */
export function routeGlob(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}*`;
  } catch {
    return `${url.split(/[?#]/)[0]}*`;
  }
}

export const CORS_DEV_NOTE =
  'Development only: the proxy answers the browser\'s preflight and adds Access-Control-Allow-* headers to the ' +
  'responses. The real server\'s CORS policy is NOT fixed — a production build will still be blocked until the ' +
  'server allows this origin.';

/**
 * The dev-only `cors` rule for this exchange's route (any method, so the OPTIONS preflight matches too).
 * REVIEW-5 #3: allowOrigin is always the request's Origin, named explicitly (never reflected, never `*`), and
 * credentials are sent only when the user asked for them. undefined when the request has no usable Origin.
 */
export function corsRuleFor(
  ex: Pick<Exchange, 'url' | 'requestHeaders'>, opts: { credentials?: boolean } = {}, id = newId('rule'),
): Rule | undefined {
  const origin = requestOrigin(ex);
  if (!origin) return undefined;
  let path = '/';
  try { path = new URL(ex.url).pathname || '/'; } catch { /* keep / */ }
  return {
    id,
    enabled: true,
    name: `CORS (dev only) ${path} for ${origin}${opts.credentials ? ' + credentials' : ''}`,
    match: { url: routeGlob(ex.url) },
    action: opts.credentials ? { kind: 'cors', allowOrigin: origin, allowCredentials: true } : { kind: 'cors', allowOrigin: origin },
  };
}

/** The request carried cookies (a hint shown next to the credentials checkbox; it never ticks it). */
export function sentCookies(ex: Pick<Exchange, 'requestHeaders'>): boolean {
  return !!headerValue(ex.requestHeaders, 'cookie');
}

/** Why a `cors` action's fields can't be saved, if they can't. */
export function corsActionError(allowOrigin: string, allowCredentials: boolean): string | undefined {
  const o = allowOrigin.trim();
  if (o && o !== '*' && !/^https?:\/\/[^/\s?#]+$/i.test(o)) {
    return 'An origin is scheme://host[:port] with no path, e.g. http://localhost:5000 (empty = the request\'s Origin when it is localhost)';
  }
  if (o === '*' && allowCredentials) {
    return 'Browsers reject "*" with credentials — name the origin, e.g. http://localhost:5000';
  }
  return undefined;
}
