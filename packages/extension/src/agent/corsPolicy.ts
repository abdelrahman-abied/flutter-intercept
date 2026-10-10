/**
 * REVIEW-5 #3: what a `cors` rule allows, stated in the agent's rule name and the user's confirmation, and the
 * host requirement for `add_cors_rule`. Matches the proxy's defaults (packages/proxy/src/cors.ts): without
 * `allowOrigin` only loopback origins (localhost, 127.0.0.1, [::1]) are echoed; credentials only when
 * `allowCredentials: true`; `null` is never allowed.
 */

/** One-line policy for a rule name: `origin loopback only, no credentials`. */
export function corsPolicyShort(allowOrigin: string | undefined, allowCredentials: boolean | undefined): string {
  const origin = allowOrigin === undefined ? 'loopback origins only' : allowOrigin === '*' ? 'ANY origin' : allowOrigin;
  return `${origin}, ${allowCredentials === true ? 'WITH credentials' : 'no credentials'}`;
}

/** The policy in words for the confirmation dialog (markdown-safe: the caller quotes `allowOrigin`). */
export function corsPolicyText(originCode: string | undefined, allowOrigin: string | undefined, allowCredentials: boolean | undefined): string {
  const creds = allowCredentials === true;
  if (allowOrigin === undefined) {
    return `Origins allowed: **only loopback pages** (http(s)://localhost, 127.0.0.1, [::1] — your Flutter Web dev server), echoed back. Credentials (cookies): **${creds ? 'allowed' : 'not allowed'}**.`;
  }
  if (allowOrigin === '*') {
    return '**Any website** open in the debug browser can read these responses (without cookies: credentials are never allowed with "*").';
  }
  return `Origin allowed: **only ${originCode ?? allowOrigin}**. Credentials (cookies): **${creds ? `allowed — pages of that origin can read these responses with the user's cookies` : 'not allowed'}**.`;
}

/**
 * True when a URL glob names a host: http(s):// or *:// followed by a host part with at least one letter or digit
 * (e.g. https://api.example.com/... or *://localhost:8080/...). A bare star, a star scheme with a star host, or a
 * pattern without a scheme don't.
 */
export function urlGlobHasHost(url: string): boolean {
  const m = /^(?:https?|\*):\/\/([^/?#]*)/i.exec(url.trim());
  if (!m) return false;
  const host = m[1].replace(/^[^@]*@/, '');
  return /[A-Za-z0-9]/.test(host.replace(/:\d+$/, '').replace(/\*/g, '')) && !host.startsWith('*:');
}
