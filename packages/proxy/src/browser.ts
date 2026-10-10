// Browser-internal traffic (CONTRACTS §11.3): the Chrome that flutter_tools starts for `flutter run -d chrome`
// makes its own requests (component updates, GCM, optimization hints, autofill, Safe Browsing, sync sign-in)
// through the same proxy. They are tagged `Exchange.browserInternal` (the panel hides them by default) while a
// web session is running. Pure and dependency-free.

type HeaderBag = Record<string, string | string[] | undefined>;

/**
 * Google browser-service hosts Chrome talks to on its own (exact host, or any subdomain of an entry starting
 * with "."). Kept small on purpose: only services a page never calls with neither Origin nor Referer.
 */
export const BROWSER_SERVICE_HOSTS: readonly string[] = [
  'update.googleapis.com', // component updater
  'clients2.google.com', // extension / component updates, CRX downloads
  'clientservices.googleapis.com', // variations (field trials)
  'optimizationguide-pa.googleapis.com', // optimization hints
  'content-autofill.googleapis.com', // autofill server predictions
  'safebrowsing.googleapis.com', // Safe Browsing lists
  'accounts.google.com', // sync / sign-in checks
  'android.clients.google.com', // GCM registration
  '.gvt1.com', // component / CRX download mirrors (edgedl.me.gvt1.com, redirector.gvt1.com)
];

function header(h: HeaderBag | undefined, name: string): string | undefined {
  if (!h) return undefined;
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === name && v !== undefined) return Array.isArray(v) ? v.join(', ') : v;
  }
  return undefined;
}

export function isBrowserServiceHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return BROWSER_SERVICE_HOSTS.some((e) => (e.startsWith('.') ? h.endsWith(e) || h === e.slice(1) : h === e));
}

/**
 * A request the browser made for itself: always to a BROWSER_SERVICE_HOSTS host (REVIEW-5 #6: any proxy client
 * can send `Sec-Fetch-Site: none`, so it never hides traffic on its own), never with `Origin` (the app's requests
 * carry it), and either `Sec-Fetch-Site: none` (browser-initiated) or no Referer. The proxy also never tags
 * LAN clients or requests that carried `x-fi-id` (the generated Dart entry's).
 */
export function isBrowserInternal(url: string, headers: HeaderBag | undefined): boolean {
  if (header(headers, 'origin')) return false;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (!isBrowserServiceHost(host)) return false;
  return header(headers, 'sec-fetch-site')?.trim().toLowerCase() === 'none' || !header(headers, 'referer');
}
