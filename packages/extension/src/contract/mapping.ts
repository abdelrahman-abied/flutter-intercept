/**
 * Request → model mapping helpers (CONTRACTS §10.3): the user-choice key (`METHOD /users/{id}`),
 * Retrofit/Chopper path-template matching, and the `Exchange.source` frame lookup. Pure.
 */
import type { StackFrame } from '@flutter-intercept/proxy';
import type { XEndpoint } from './api';

/** Splits an absolute URL into origin and path (no query / fragment). Undefined for a non-URL. */
export function splitUrl(url: string): { origin: string; path: string } | undefined {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)([^?#]*)/i.exec(url);
  if (!m) return undefined;
  let origin = m[1].toLowerCase();
  origin = origin.replace(/^https:\/\/([^/]+):443$/, 'https://$1').replace(/^http:\/\/([^/]+):80$/, 'http://$1');
  return { origin, path: m[2] || '/' };
}

const ID_SEGMENT = [
  /^\d+$/, // 42
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // uuid
  /^[0-9a-f]{16,}$/i, // long hex (object ids, hashes)
  /^(?=.*\d)[A-Za-z0-9_-]{20,}={0,2}$/, // base64-ish tokens with a digit
];

/** `/users/42/posts/7` → `/users/{id}/posts/{id2}` (the key of a remembered route). */
export function pathTemplate(path: string): string {
  let n = 0;
  return path
    .split('/')
    .map((seg) => {
      let s = seg;
      try {
        s = decodeURIComponent(seg);
      } catch {
        // keep it encoded
      }
      if (!s || !ID_SEGMENT.some((re) => re.test(s))) return seg;
      n++;
      return n === 1 ? '{id}' : `{id${n}}`;
    })
    .join('/');
}

/** `GET /users/{id}`: the key remembered in workspaceState for "this route → model". */
export function routeKey(method: string, url: string): string {
  const u = splitUrl(url);
  return `${method.toUpperCase()} ${pathTemplate(u ? u.path : url.replace(/[?#].*$/, ''))}`;
}

const segs = (p: string) => p.split('/').filter((s) => s.length > 0);

/** One template segment → matcher. `{id}` matches one segment; `user_{id}.json` a regex. */
function segmentMatches(tpl: string, seg: string): 'literal' | 'param' | false {
  if (!tpl.includes('{')) {
    let s = seg;
    try {
      s = decodeURIComponent(seg);
    } catch {
      // compare encoded
    }
    return tpl === seg || tpl === s ? 'literal' : false;
  }
  if (/^\{[^}]*\}$/.test(tpl)) return seg.length > 0 ? 'param' : false;
  const re = new RegExp(`^${tpl.split(/\{[^}]*\}/).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+')}$`);
  return re.test(seg) ? 'param' : false;
}

export interface EndpointMatch {
  endpoint: XEndpoint;
  score: number;
}

/**
 * Score of `ep` for `method url`, or undefined. With a known absolute base the URL must start with it
 * and the whole path must match; otherwise the template must match the END of the URL path (the base is
 * set at runtime). Literal segments weigh most; a matched origin breaks ties.
 */
export function matchEndpoint(ep: XEndpoint, method: string, url: string): number | undefined {
  if (ep.method.toUpperCase() !== method.toUpperCase()) return undefined;
  const u = splitUrl(url);
  if (!u) return undefined;
  const tpl = segs(ep.pathTemplate);
  const parts = segs(u.path);
  let originMatched = false;
  if (ep.baseUrl && /^[a-z][a-z0-9+.-]*:\/\//i.test(ep.baseUrl)) {
    const b = splitUrl(ep.baseUrl);
    if (b && b.origin === u.origin) originMatched = true;
  }
  let offset: number;
  if (originMatched) {
    if (tpl.length !== parts.length) return undefined;
    offset = 0;
  } else {
    if (tpl.length > parts.length) return undefined;
    offset = parts.length - tpl.length;
  }
  let literal = 0;
  let params = 0;
  for (let i = 0; i < tpl.length; i++) {
    const r = segmentMatches(tpl[i], parts[offset + i]);
    if (!r) return undefined;
    if (r === 'literal') literal++;
    else params++;
  }
  if (tpl.length === 0 && parts.length > 0 && !originMatched) return undefined;
  return (originMatched ? 1000 : 0) + literal * 10 + params + (offset === 0 ? 5 : 0);
}

/** The best endpoint for a request (highest score, then the first declared). */
export function bestEndpoint(endpoints: XEndpoint[], method: string, url: string): EndpointMatch | undefined {
  let best: EndpointMatch | undefined;
  for (const endpoint of endpoints) {
    const score = matchEndpoint(endpoint, method, url);
    if (score !== undefined && (!best || score > best.score)) best = { endpoint, score };
  }
  return best;
}

/** `_UsersApi.getUser.<anonymous closure>` → {cls: "_UsersApi", method: "getUser"}. */
export function frameMethod(fn: string): { cls: string; method: string } | undefined {
  const parts = fn.replace(/^new /, '').split('.').filter((p) => !p.startsWith('<'));
  if (parts.length < 2) return undefined;
  return { cls: parts[0], method: parts[1] };
}

const isGeneratedUri = (uri: string) => /\.(g|chopper)\.dart$/.test(uri.replace(/[?#].*$/, ''));

export interface GeneratedClassRef {
  generated: string;
  api: string;
  /** Absolute path of the generated file (its basename is compared with the frame's URI). */
  file: string;
}

/**
 * Endpoints named by frames inside generated Retrofit (`_XApi.method`) / Chopper (`_$XService.method`)
 * classes, in frame order (innermost first). The caller validates them against the request.
 */
export function endpointsFromFrames(frames: StackFrame[], classes: GeneratedClassRef[], endpoints: XEndpoint[]): XEndpoint[] {
  const out: XEndpoint[] = [];
  for (const f of frames) {
    if (!isGeneratedUri(f.uri)) continue;
    const fm = frameMethod(f.fn);
    if (!fm) continue;
    const base = f.uri.replace(/[?#].*$/, '').replace(/^.*\//, '');
    const refs = classes.filter((c) => c.generated === fm.cls);
    // prefer the class from the file the frame points at
    refs.sort((a, b) => Number(b.file.endsWith(`/${base}`) || b.file.endsWith(`\\${base}`)) - Number(a.file.endsWith(`/${base}`) || a.file.endsWith(`\\${base}`)));
    for (const ref of refs) {
      const stem = ref.file.replace(/\.(g|chopper)\.dart$/, '');
      const eps = endpoints.filter((e) => e.apiClass === ref.api && e.dartMethod === fm.method);
      eps.sort((a, b) => Number(b.file.startsWith(stem)) - Number(a.file.startsWith(stem)));
      for (const e of eps) if (!out.includes(e)) out.push(e);
    }
  }
  return out;
}
