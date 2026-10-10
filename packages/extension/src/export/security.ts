/**
 * Authentication schemes inferred from recorded requests (CONTRACTS §14.6), shared by the OpenAPI export
 * (`components.securitySchemes` + per-operation `security`) and the Postman export (`auth` per request). Pure.
 *
 * Inferred from header and query NAMES (and the `Authorization` scheme word), never from values:
 * - `Authorization: Bearer …` → HTTP bearer (`bearerFormat: JWT` when every token seen is a JWT);
 *   `Authorization: Basic …` → HTTP basic; any other `Authorization` value → an API key in the `Authorization` header.
 * - API-key headers: `x-api-key`, `api-key`, `apikey`, `x-api-token`, `x-auth-token`, `x-access-token`, `x-app-key`,
 *   `x-client-key`, `x-token`, `token`, and names ending in `-api-key` / `-subscription-key` (`x-goog-api-key`,
 *   `ocp-apim-subscription-key`).
 * - API-key query parameters: `api_key`, `apikey`, `api-key`, `key`, `token`, `access_token`, `auth_token`, `api_token`,
 *   `auth`.
 * Empty values are not credentials. The values themselves are only handed to the Postman export when the user chose
 * to keep values (it fills its variables with them); the OpenAPI document never contains them.
 */
import type { Exchange } from '@flutter-intercept/proxy';

type Json = Record<string, unknown>;

export type CredentialKind = 'bearer' | 'basic' | 'authorization' | 'header' | 'query';

export interface Credential {
  kind: CredentialKind;
  /** Security scheme name (`bearerAuth`, `basicAuth`, `apiKey_x-api-key`, `apiKeyQuery_api_key`, …). */
  scheme: string;
  /** Header or query parameter name as seen (`Authorization` for bearer / basic). */
  name: string;
  /** The credential: the bearer token, the basic base64 part, the header or query value. Never exported to OpenAPI. */
  value: string;
}

const HEADER_KEY =
  /^(?:x-)?(?:api[-_]?key|apikey|api[-_]?token|auth[-_]?token|access[-_]?token|app[-_]?key|client[-_]?key|token)$|[-_](?:api[-_]?key|apikey|subscription[-_]?key)$/i;
const QUERY_KEY = /^(?:api[-_]?key|apikey|key|token|access[-_]?token|auth[-_]?token|api[-_]?token|auth)$/i;
const JWT = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/** A header name that carries an API key. */
export function isApiKeyHeader(name: string): boolean {
  return HEADER_KEY.test(name);
}

/** A query parameter name that carries an API key. */
export function isApiKeyQuery(name: string): boolean {
  return QUERY_KEY.test(name);
}

/** A scheme name OpenAPI accepts (`^[A-Za-z0-9._-]+$`). */
function schemeSafe(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_');
}

/** The credentials one request carried, in priority order (bearer, basic, other Authorization, headers, query). */
export function credentialsOf(e: Pick<Exchange, 'url' | 'requestHeaders'>): Credential[] {
  const auth: Credential[] = [];
  const headers: Credential[] = [];
  for (const [name, raw] of Object.entries(e.requestHeaders ?? {})) {
    const lower = name.toLowerCase();
    for (const v of Array.isArray(raw) ? raw : [raw]) {
      if (typeof v !== 'string') continue;
      const value = v.trim();
      if (!value) continue;
      if (lower === 'authorization') {
        const m = /^(bearer|basic)\s+(\S.*)$/i.exec(value);
        if (m && m[1].toLowerCase() === 'bearer') auth.push({ kind: 'bearer', scheme: 'bearerAuth', name, value: m[2].trim() });
        else if (m) auth.push({ kind: 'basic', scheme: 'basicAuth', name, value: m[2].trim() });
        else auth.push({ kind: 'authorization', scheme: 'authorizationHeader', name, value });
      } else if (isApiKeyHeader(lower)) {
        headers.push({ kind: 'header', scheme: `apiKey_${schemeSafe(lower)}`, name, value });
      }
    }
  }
  const query: Credential[] = [];
  let params: URLSearchParams | undefined;
  try {
    params = new URL(e.url).searchParams;
  } catch {
    params = undefined;
  }
  params?.forEach((value, name) => {
    if (value && isApiKeyQuery(name) && !query.some((c) => c.name === name)) {
      query.push({ kind: 'query', scheme: `apiKeyQuery_${schemeSafe(name)}`, name, value });
    }
  });
  // one per scheme (a repeated header counts once)
  const seen = new Set<string>();
  return [...auth, ...headers, ...query].filter((c) => (seen.has(c.scheme) ? false : (seen.add(c.scheme), true)));
}

/**
 * Collects the schemes of the exported requests: `components.securitySchemes` (values never included) and each
 * operation's `security` requirements.
 */
export class SecuritySchemes {
  private readonly schemes = new Map<string, { kind: CredentialKind; name: string; jwt: boolean }>();

  /** Records the credentials of one request; returns them. */
  add(e: Pick<Exchange, 'url' | 'requestHeaders'>): Credential[] {
    const creds = credentialsOf(e);
    for (const c of creds) {
      const s = this.schemes.get(c.scheme);
      const jwt = c.kind === 'bearer' && JWT.test(c.value);
      if (!s) this.schemes.set(c.scheme, { kind: c.kind, name: c.name, jwt });
      else if (!jwt) s.jwt = false;
    }
    return creds;
  }

  get size(): number {
    return this.schemes.size;
  }

  /** `components.securitySchemes`, sorted by name. */
  components(): Json {
    const out: Json = {};
    for (const key of [...this.schemes.keys()].sort()) {
      const s = this.schemes.get(key)!;
      switch (s.kind) {
        case 'bearer':
          out[key] = { type: 'http', scheme: 'bearer', ...(s.jwt ? { bearerFormat: 'JWT' } : {}) };
          break;
        case 'basic':
          out[key] = { type: 'http', scheme: 'basic' };
          break;
        case 'authorization':
          out[key] = { type: 'apiKey', in: 'header', name: 'Authorization' };
          break;
        case 'header':
          out[key] = { type: 'apiKey', in: 'header', name: s.name };
          break;
        case 'query':
          out[key] = { type: 'apiKey', in: 'query', name: s.name };
          break;
      }
    }
    return out;
  }
}

/**
 * An operation's `security`: one requirement per distinct combination of schemes its requests used (all of a
 * request's schemes together), first seen first; `{}` last when some requests had none. Undefined when none had any.
 */
export function securityRequirements(perRequest: readonly Credential[][]): Json[] | undefined {
  const out: Json[] = [];
  const keys = new Set<string>();
  let anonymous = false;
  for (const creds of perRequest) {
    if (!creds.length) {
      anonymous = true;
      continue;
    }
    const names = [...new Set(creds.map((c) => c.scheme))].sort();
    const key = names.join('\u0000');
    if (keys.has(key)) continue;
    keys.add(key);
    out.push(Object.fromEntries(names.map((n) => [n, []])));
  }
  if (!out.length) return undefined;
  if (anonymous) out.push({});
  return out;
}
