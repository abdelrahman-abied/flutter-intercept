/**
 * Record → Mock (CONTRACTS §23.1): a Postman v2.1 collection built from recorded traffic. Pure: no vscode, no fs.
 *
 * - Taken: `completed` exchanges with a status and no `matchedRuleId` (a rule `isThrottleOnlyRule` accepts is fine).
 *   Everything else is skipped and counted in `skipped` (mocked / replayed, 1xx / 3xx / 304, OPTIONS, GraphQL, gRPC,
 *   WebSocket, SSE, tunnels, browser-internal, truncated, binary, unfinished / failed, answered by a rule, other
 *   origins). No endpoint is invented: only what was recorded.
 * - Templating: `isParamSegment` (export/common: `isIdSegment` or a credential) plus a sibling collapse — ≥ 3 distinct
 *   literals at one position under the same method and parent become a param, when none of them is a collection name
 *   (an id follows it somewhere) and at least two of their JSON answers exist and all are alike (record keys — a
 *   list's items, an envelope's `data[]` — overlap ≥ 80 % and Jaccard ≥ 0.5), so `/api/users`, `/api/orders`
 *   and `/health`, `/version` stay apart while `/products/shoes`, `/products/hats` … collapse. Params are named `<singular of the previous literal>Id`, else `id`, `id2`, …
 * - Examples: the newest answer per status per endpoint (≤ 20 statuses), whose body fits `maxExampleBytes` (an older
 *   one of the same status that fits is taken instead; never cut). An endpoint left with no example is not written (it
 *   passes through, or fails offline, instead of answering 501). The file stays ≤ 20 MB (largest examples dropped
 *   first) and ≤ 2 000 endpoints.
 * - Sanitising, always on (`TrafficSanitiser`): request headers / auth / bodies like `toPostman`'s redaction (secret
 *   header values become empty `{{variables}}`, one credential becomes Postman `auth`), query values blanked (names
 *   kept), request bodies ≤ 64 KB; response bodies through the §22.16 value rules — a secret-named field is blanked
 *   (strings `""`, numbers `0` / `0.0` by the literal's kind, containers keep their structure with every string inside blanked), a JWT anywhere
 *   becomes the fixed unsigned placeholder `JWT_PLACEHOLDER`, other credential-looking values `""`; URLs inside
 *   string values lose signature / token / key query values; response headers lose cookies, CORS, CSP, HSTS, dates,
 *   request / trace ids, `alt-svc`, `report-to`, `nel`, secret-named and credential-valued ones. Finally
 *   `sanitisePostman` (on the parsed text; a cut copy is refused with an error, never written — REVIEW-16 #12).
 *   Personal data (default on): e-mail addresses (also percent-encoded in forms and as object keys), phone-named and
 *   address-named fields, phone numbers as keys replaced, the same value always getting the same replacement within
 *   one run.
 * - REVIEW-16: names are judged by the shared check (`secrets.ts`; request bodies also by the agent's substring rule),
 *   headers by the copy's header rule too. A JSON-ish body is read past a BOM / XSSI guard, NDJSON line by line, JSONP
 *   by its argument; anything else gets the text rules plus name patterns (`"name": v`, `name=v`, `<name>v</name>`)
 *   and is left out when a secret-named object or list is still in it. JSON inside a string value is rewritten too.
 *   Short tokens, phone numbers and one-time codes in paths become params with empty values; numeric values over 7
 *   digits are not kept as variable values. `removed` shows a kind for a key that is itself personal data.
 * - JSON bodies keep their literals (`1.0`, big integers) and are re-indented with 2 spaces.
 */
import type { Body, Exchange } from '@flutter-intercept/proxy';
import { prettyJson } from '../codegen/json';
import { isSensitiveField, isSensitiveHeader, redactSecretValues } from '../agent/redact';
import { isParamSegment, isJsonMediaType, plural, reasonPhrase } from '../export/common';
import { POSTMAN_SCHEMA } from '../export/postman';
import { credentialsOf, type Credential } from '../export/security';
import { singular, utf8Length } from './resources';
import { SANITISE_TOO_LARGE, sanitisePostman } from './sanitise';
import {
  fieldWords,
  hasSecretContainer,
  isCredentialValue,
  isSecretHeaderName,
  isSecretName,
  memoName,
  JWT_WHOLE,
  safeNameLabel,
  scrubNamedText,
  scrubSecretText,
} from './secrets';
import { COLLECTION_LIMITS } from './types';

// ------------------------------------------------------------------ public types

export interface FromTrafficOptions {
  name: string;
  /** Only these origins (`https://api.example.com`); all when absent. */
  origins?: string[];
  /** For the link the host writes (`addLink`); not part of the collection text. */
  unmatched?: 'passthrough' | 'fail';
  /** Default 1 MB, at most `COLLECTION_LIMITS.exampleBodyBytes`. */
  maxExampleBytes?: number;
  /** Default true. */
  replacePersonalData?: boolean;
  /**
   * The host knows rule kinds, the exchange only the rule id: true when the rule that matched only throttled the
   * request (it still reached the real server). Absent → any `matchedRuleId` skips the exchange.
   */
  isThrottleOnlyRule?: (ruleId: string) => boolean;
}

export interface FromTrafficResult {
  /** Postman Collection v2.1 JSON text (already through `sanitisePostman`). */
  text: string;
  endpoints: number;
  examples: number;
  origins: string[];
  /** Short plain lines: "12 GraphQL requests", … */
  skipped: string[];
  /** Field and header names (and kinds of personal data), never values. */
  removed: string[];
}

/** `{"alg":"none"}` . `{"sub":"fi","exp":4102444800}` . (no signature): apps that decode `exp` keep working. */
export const JWT_PLACEHOLDER = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJmaSIsImV4cCI6NDEwMjQ0NDgwMH0.';

export const DEFAULT_MAX_EXAMPLE_BYTES = 1024 * 1024;
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
export const MAX_STATUSES_PER_ENDPOINT = COLLECTION_LIMITS.examplesPerEndpoint;
const MAX_REMOVED = 50;
const MAX_QUERY_NAMES = 20;
const SHAPE_SNIFF_BYTES = 256 * 1024;
const MAX_JSON_DEPTH = 256;
/** Sibling answers this alike (record keys: overlap and Jaccard) are values of one resource. */
const SIBLING_OVERLAP = 0.8;
const SIBLING_JACCARD = 0.5;
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

// ------------------------------------------------------------------ sanitising

const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}\b/g;
const EMAIL_WHOLE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}$/;
const EXAMPLE_DOMAIN = /@example\.(?:com|org|net)$/i;
/** REVIEW-16 #3: a BOM and / or an XSSI guard before a JSON answer (kept verbatim in front of the rewritten JSON). */
const JSON_PREFIX = /^(?:﻿)?(?:\)\]\}'[ \t]*,?[ \t]*(?:\r?\n)?|while[ \t]*\([ \t]*1[ \t]*\)[ \t]*;|for[ \t]*\([ \t]*;[ \t]*;[ \t]*\)[ \t]*;)?/;
/** `callback({...});` (JSONP). */
const JSONP = /^(\s*[A-Za-z_$][\w$.]{0,127}\s*\()([\s\S]*)(\)\s*;?\s*)$/;
/** JSON inside a JSON string value is rewritten up to this size, two levels deep. */
const MAX_JSON_IN_STRING = 64 * 1024;
/** A phone number used as a JSON key (REVIEW-16 #11). */
const PHONE_KEY = /^\+\d{8,15}$/;

const PHONE_WORDS = new Set(['phone', 'mobile', 'msisdn', 'telephone', 'tel', 'cellphone', 'phonenumber']);
const ADDRESS_WORDS = new Set(['address', 'addr', 'street', 'lat', 'lng', 'lon', 'latitude', 'longitude']);

type Mode = 'normal' | 'secret' | 'address' | 'phone';

function hasWord(name: string, words: ReadonlySet<string>): boolean {
  for (const w of fieldWords(name)) if (words.has(w)) return true;
  return false;
}

/** PERF-5 #1: keys repeat across answers; the word checks keep their answers (`memoName`, bounded). */
const isAddressName = memoName((name) => hasWord(name, ADDRESS_WORDS));
const isPhoneName = memoName((name) => hasWord(name, PHONE_WORDS));

class JsonRewriteError extends Error {}

/** How a JSON-ish body was read (REVIEW-16 #3). */
export interface ReadBody {
  /** `json`: one JSON value (after an optional BOM / XSSI prefix); `ndjson` / `jsonp`: rewritten per value; `text`:
   * the text and name patterns only; `dropped`: left out (`""`), a secret-named container couldn't be blanked. */
  kind: 'json' | 'ndjson' | 'jsonp' | 'text' | 'dropped';
  /** The body as written in the collection. */
  text: string;
  /** `json` only: the rewritten JSON without the prefix (re-indented like `text`). */
  json?: string;
}

/**
 * The §23.1 sanitising chain for one run. `removed` collects names (never values; a key that is itself personal data
 * shows as a kind). Replacements of personal data are consistent for the life of the instance. Names are judged by
 * the shared check (`secrets.ts`), plus the agent's substring rule for request bodies.
 */
export class TrafficSanitiser {
  readonly removed = new Set<string>();
  /** Bodies left out because they weren't plain JSON and held a secret-named object or list (REVIEW-16 #3). */
  bodiesDropped = 0;
  private readonly emails = new Map<string, string>();
  private readonly phones = new Map<string, string>();
  private nesting = 0;

  constructor(readonly replacePersonalData = true) {}

  private note(name: string): void {
    const n = safeNameLabel(name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 80));
    if (n) this.removed.add(n);
  }

  private readonly noteFn = (label: string): void => this.note(label);

  /** Secret by name: the shared check; request bodies also the agent's substring rule (`toPostman`'s names). */
  private secretName(key: string, request: boolean): boolean {
    return isSecretName(key) || (request && isSensitiveField(key));
  }

  private email(address: string): string {
    if (EXAMPLE_DOMAIN.test(address)) return address;
    let r = this.emails.get(address.toLowerCase());
    if (!r) {
      r = `user${this.emails.size + 1}@example.com`;
      this.emails.set(address.toLowerCase(), r);
      this.note('e-mail addresses');
    }
    return r;
  }

  private phone(value: string): string {
    let r = this.phones.get(value);
    if (!r) {
      r = `+10000000${this.phones.size + 1}`;
      this.phones.set(value, r);
      this.note('phone numbers');
    }
    return r;
  }

  /** E-mail addresses inside any text. */
  private emailsIn(s: string): string {
    if (!this.replacePersonalData || !s.includes('@')) return s;
    return s.replace(EMAIL, (m) => this.email(m));
  }

  /** Credentials in text (`secrets.ts`): JWTs → the placeholder, scheme credentials and prefixed keys cut, URLs cleaned. */
  private scrub(s: string): string {
    return scrubSecretText(s, { jwt: JWT_PLACEHOLDER, note: this.noteFn, query: isSensitiveField });
  }

  /** URLs inside text: userinfo removed, signature / credential query (and fragment) values blanked. */
  urlsIn(s: string): string {
    return this.scrub(s);
  }

  /** Free text (a header value): credentials, URLs, e-mail addresses. */
  text(s: string): string {
    return this.emailsIn(this.scrub(s));
  }

  /** A non-JSON body (XML, HTML, plain text, not-quite-JSON): `text` plus secret-named values by pattern. */
  bodyText(s: string, request = false): string {
    return scrubNamedText(this.text(s), (n) => this.secretName(n, request), this.noteFn);
  }

  /** One JSON string value under `key` (undefined for array items / the root) in `mode`. */
  private stringValue(v: string, key: string | undefined, mode: Mode, request: boolean): string {
    if (v === '') return v;
    if (key !== undefined && this.secretName(key, request)) {
      this.note(key);
      return JWT_WHOLE.test(v) ? JWT_PLACEHOLDER : '';
    }
    // inside a secret-named object or list: its own keys are not named (they can be data, REVIEW-16 #11)
    if (mode === 'secret') return JWT_WHOLE.test(v) ? JWT_PLACEHOLDER : '';
    if (JWT_WHOLE.test(v)) {
      this.note('JWTs (a fixed unsigned placeholder)');
      return JWT_PLACEHOLDER;
    }
    // REVIEW-16 #6: JSON inside a string (`"payload": "{\"access_token\":…}"`)
    const t = v.trimStart();
    if ((t.startsWith('{') || t.startsWith('[')) && v.length <= MAX_JSON_IN_STRING && this.nesting < 2) {
      this.nesting++;
      try {
        const inner = this.jsonText(v, request);
        if (inner !== undefined) return inner;
      } finally {
        this.nesting--;
      }
    }
    if (isCredentialValue(v)) {
      // JWTs inside longer text become the placeholder and scheme credentials are cut; a value that is still a
      // credential after that (a whole opaque or prefixed token) is blanked
      const inner = this.scrub(v);
      if (inner !== v && !isCredentialValue(inner.split(JWT_PLACEHOLDER).join(''))) return this.rest(inner, key, mode);
      this.note(key ?? 'credential-looking values');
      return '';
    }
    return this.rest(this.scrub(v), key, mode);
  }

  /** Personal data in a string value (credentials and URLs already handled). */
  private rest(v: string, key: string | undefined, mode: Mode): string {
    let out = v;
    if (!this.replacePersonalData) return out;
    if (EMAIL_WHOLE.test(out)) return this.email(out);
    if (mode === 'address' || (key !== undefined && isAddressName(key))) {
      this.note('addresses and locations');
      return '';
    }
    if ((mode === 'phone' || (key !== undefined && isPhoneName(key))) && /\d/.test(out)) return this.phone(out);
    out = this.emailsIn(out);
    return out;
  }

  /**
   * One JSON number literal under `key` in `mode`. A replacement keeps the literal's kind (Dart: `double` when written
   * with a fraction or an exponent — `4.0` too), so a redacted `"lat": 24.7136` is `0.0`, never `0`: an int would
   * make every later answer with decimals look like drift (§23.3 int → double).
   */
  private numberValue(raw: string, key: string | undefined, mode: Mode, request: boolean): string {
    const keep = (n: string): string => (/[.eE]/.test(raw) ? `${n}.0` : n);
    if (key !== undefined && this.secretName(key, request)) {
      this.note(key);
      return keep('0');
    }
    if (!this.replacePersonalData) return raw;
    if (mode === 'address' || (key !== undefined && isAddressName(key))) {
      this.note('addresses and locations');
      return keep('0');
    }
    if (mode === 'phone' || (key !== undefined && isPhoneName(key))) return keep(this.phone(raw).slice(1));
    return raw;
  }

  private childMode(mode: Mode, key: string, request: boolean): Mode {
    if (mode !== 'normal') return mode;
    if (this.secretName(key, request)) {
      this.note(key);
      return 'secret';
    }
    if (this.replacePersonalData && isAddressName(key)) return 'address';
    if (this.replacePersonalData && isPhoneName(key)) return 'phone';
    return 'normal';
  }

  /** REVIEW-16 #11: an object key that is an e-mail address or a phone number gets the same replacement as a value. */
  private personalKey(k: string, mode: Mode): string {
    if (!this.replacePersonalData) return k;
    if (EMAIL_WHOLE.test(k)) return this.email(k);
    if (PHONE_KEY.test(k) || (mode === 'phone' && /^\+?\d{8,15}$/.test(k))) {
      const r = this.phone(k);
      return k.startsWith('+') ? r : r.slice(1);
    }
    return k;
  }

  /**
   * JSON text with every value through the rules above; literals and formatting of untouched values copied verbatim.
   * Undefined when `text` isn't one JSON value.
   */
  jsonText(text: string, request = false): string | undefined {
    try {
      return this.rewrite(text, request);
    } catch (e) {
      if (e instanceof JsonRewriteError || e instanceof SyntaxError || e instanceof RangeError) return undefined;
      throw e;
    }
  }

  private rewrite(text: string, request: boolean): string {
    const t = text;
    const n = t.length;
    let i = 0;
    const out: string[] = [];
    const fail = (): never => {
      throw new JsonRewriteError('not JSON');
    };
    const ws = (): void => {
      const s = i;
      while (i < n) {
        const c = t.charCodeAt(i);
        if (c === 32 || c === 9 || c === 10 || c === 13) i++;
        else break;
      }
      if (i > s) out.push(t.slice(s, i));
    };
    const str = (): { raw: string; value: string } => {
      if (t.charCodeAt(i) !== 34) fail();
      const s = i;
      let j = i + 1;
      for (;;) {
        const q = t.indexOf('"', j);
        if (q < 0) fail();
        let b = q - 1;
        while (b > s && t.charCodeAt(b) === 92) b--;
        const backslashes = q - 1 - b;
        if (backslashes % 2 === 0) {
          j = q;
          break;
        }
        j = q + 1;
      }
      i = j + 1;
      const raw = t.slice(s, i);
      let value: string;
      if (raw.includes('\\')) value = JSON.parse(raw) as string;
      else {
        value = raw.slice(1, -1);
        for (let k = 0; k < value.length; k++) if (value.charCodeAt(k) < 0x20) fail();
      }
      return { raw, value };
    };
    const value = (key: string | undefined, mode: Mode, depth: number): void => {
      if (depth > MAX_JSON_DEPTH) fail();
      const c = t.charCodeAt(i);
      if (c === 123 /* { */) {
        out.push('{');
        i++;
        ws();
        if (t.charCodeAt(i) === 125) {
          out.push('}');
          i++;
          return;
        }
        for (;;) {
          const k = str();
          const nk = this.personalKey(k.value, mode);
          out.push(nk === k.value ? k.raw : JSON.stringify(nk));
          ws();
          if (t.charCodeAt(i) !== 58) fail();
          out.push(':');
          i++;
          ws();
          value(k.value, this.childMode(mode, k.value, request), depth + 1);
          ws();
          const d = t.charCodeAt(i);
          if (d === 44) {
            out.push(',');
            i++;
            ws();
            continue;
          }
          if (d === 125) {
            out.push('}');
            i++;
            return;
          }
          fail();
        }
      }
      if (c === 91 /* [ */) {
        out.push('[');
        i++;
        ws();
        if (t.charCodeAt(i) === 93) {
          out.push(']');
          i++;
          return;
        }
        for (;;) {
          value(key, mode, depth + 1);
          ws();
          const d = t.charCodeAt(i);
          if (d === 44) {
            out.push(',');
            i++;
            ws();
            continue;
          }
          if (d === 93) {
            out.push(']');
            i++;
            return;
          }
          fail();
        }
      }
      if (c === 34) {
        const s = str();
        const next = this.stringValue(s.value, key, mode, request);
        out.push(next === s.value ? s.raw : JSON.stringify(next));
        return;
      }
      NUMBER.lastIndex = i;
      if (NUMBER.test(t) && NUMBER.lastIndex > i) {
        const raw = t.slice(i, NUMBER.lastIndex);
        i = NUMBER.lastIndex;
        out.push(this.numberValue(raw, key, mode, request));
        return;
      }
      for (const lit of ['true', 'false', 'null']) {
        if (t.startsWith(lit, i)) {
          i += lit.length;
          out.push(lit);
          return;
        }
      }
      fail();
    };
    ws();
    value(undefined, 'normal', 0);
    ws();
    if (i !== n) fail();
    return out.join('');
  }

  private pretty(j: string): string {
    try {
      return prettyJson(j);
    } catch {
      return j;
    }
  }

  /** NDJSON: every non-empty line one JSON value (at least two), each rewritten; line ends kept. */
  private ndjson(text: string, request: boolean): string | undefined {
    const parts = text.split(/(\r?\n)/);
    let values = 0;
    for (let i = 0; i < parts.length; i += 2) {
      const line = parts[i];
      if (line.trim() === '') continue;
      const t = line.trimStart();
      if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
      const j = this.jsonText(line, request);
      if (j === undefined) return undefined;
      parts[i] = j;
      values++;
    }
    return values >= 2 ? parts.join('') : undefined;
  }

  /**
   * REVIEW-16 #3: a body that is (or may be) JSON. One JSON value after an optional BOM / XSSI guard (`)]}'`,
   * `while(1);`, `for(;;);`, kept in front); NDJSON line by line; JSONP's argument. Anything else is text with the
   * name patterns; when it still holds a secret-named object or list it is dropped (`""`, counted in `bodiesDropped`).
   */
  readBody(text: string, request: boolean, jsonHint: boolean): ReadBody {
    const prefix = JSON_PREFIX.exec(text)?.[0] ?? '';
    const rest = text.slice(prefix.length);
    const t = rest.trimStart();
    const looks = jsonHint || prefix !== '' || t.startsWith('{') || t.startsWith('[');
    if (looks) {
      const j = this.jsonText(rest, request);
      if (j !== undefined) {
        const pretty = this.pretty(j);
        return { kind: 'json', text: `${prefix}${pretty}`, json: pretty };
      }
      if (rest.includes('\n')) {
        const nd = this.ndjson(rest, request);
        if (nd !== undefined) return { kind: 'ndjson', text: `${prefix}${nd}` };
      }
    }
    let jsonp = false;
    if (/^[A-Za-z_$]/.test(t) && /\)\s*;?\s*$/.test(rest)) {
      const m = JSONP.exec(rest);
      if (m) {
        jsonp = true;
        const inner = this.jsonText(m[2], request);
        if (inner !== undefined) return { kind: 'jsonp', text: `${prefix}${m[1]}${inner}${m[3]}` };
      }
    }
    const out = this.bodyText(text, request);
    if ((looks || jsonp) && hasSecretContainer(out, (n) => this.secretName(n, request))) {
      this.bodiesDropped++;
      return { kind: 'dropped', text: '' };
    }
    return { kind: 'text', text: out };
  }

  /** A response body as written in the collection: JSON re-indented (literals kept), else text (`readBody`). */
  responseBody(text: string, json: boolean): string {
    return this.readBody(text, false, json).text;
  }

  /** A request body: JSON like a response (plus `toPostman`'s field names), forms field by field, else text. */
  requestBody(text: string, mediaType: string): string {
    if (mediaType.includes('x-www-form-urlencoded')) return this.formBody(text);
    return this.readBody(text, true, isJsonMediaType(mediaType)).text;
  }

  /**
   * REVIEW-16 #6 / #11: an urlencoded form, field by field: a secret-named field is blanked, other values decoded,
   * through the value rules (credentials, e-mail addresses — `jane%40corp.sa` too —, phone- and address-named fields)
   * and encoded again.
   */
  private formBody(text: string): string {
    return text
      .split('&')
      .map((part) => {
        const eq = part.indexOf('=');
        if (eq <= 0) return part;
        const rawKey = part.slice(0, eq);
        const rawVal = part.slice(eq + 1);
        if (rawVal === '') return part;
        const key = safeFormDecode(rawKey);
        if (this.secretName(key, true)) {
          this.note('form fields');
          return `${rawKey}=`;
        }
        const val = safeFormDecode(rawVal);
        const next = this.stringValue(val, key, 'normal', true);
        return next === val ? part : `${rawKey}=${encodeURIComponent(next)}`;
      })
      .join('&');
  }

  /** A path segment kept as a literal: e-mail addresses replaced (raw, percent-encoded form). */
  pathSegment(raw: string): string {
    if (!this.replacePersonalData) return raw;
    let dec = raw;
    try {
      dec = decodeURIComponent(raw);
    } catch {
      return raw;
    }
    const next = this.emailsIn(dec);
    return next === dec ? raw : encodeURIComponent(next);
  }

  noteName(name: string): void {
    this.note(name);
  }
}

function safeFormDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

// ------------------------------------------------------------------ headers

/** Connection-level request headers Postman sets itself. */
const DROP_REQUEST_HEADERS = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'proxy-connection', 'te', 'upgrade', 'accept-encoding']);

/** Response headers that frame the answer (the proxy sets them) or change on every answer (§23.1). */
const DROP_RESPONSE_HEADERS = new Set([
  'content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'upgrade',
  'date', 'age', 'alt-svc', 'report-to', 'reporting-endpoints', 'nel', 'strict-transport-security', 'expect-ct',
  'content-security-policy', 'content-security-policy-report-only', 'x-content-security-policy', 'x-webkit-csp',
  'x-request-id', 'request-id', 'x-correlation-id', 'correlation-id', 'x-trace-id', 'x-span-id', 'traceparent', 'tracestate',
  'sentry-trace', 'baggage', 'x-cloud-trace-context', 'x-amzn-requestid', 'x-amzn-trace-id', 'x-amz-cf-id', 'x-amz-cf-pop',
  'x-amz-request-id', 'x-amz-id-2', 'x-amz-apigw-id', 'apigw-requestid', 'cf-ray', 'x-github-request-id', 'x-ms-request-id',
  'x-envoy-upstream-service-time', 'server-timing', 'x-runtime', 'x-response-time', 'x-served-by', 'x-timer', 'x-cache',
  'x-cache-hits', 'via',
]);
const DROP_RESPONSE_PREFIX = /^(?:access-control-|x-b3-|x-datadog-|x-ratelimit-|ratelimit-)/;

type Json = Record<string, unknown>;
type HeaderMap = Record<string, string | string[]>;

function ownEntries(h: HeaderMap | undefined): [string, string[]][] {
  const out: [string, string[]][] = [];
  if (!h || typeof h !== 'object') return out;
  for (const k of Object.keys(h)) {
    const v = Object.getOwnPropertyDescriptor(h, k)?.value as unknown;
    if (typeof v === 'string') out.push([k, [v]]);
    else if (Array.isArray(v)) out.push([k, v.filter((x): x is string => typeof x === 'string')]);
  }
  return out;
}

function headerOf(h: HeaderMap | undefined, name: string): string | undefined {
  for (const [k, v] of ownEntries(h)) if (k.toLowerCase() === name) return v[0];
  return undefined;
}

function mediaTypeOfHeaders(h: HeaderMap | undefined): string {
  return (headerOf(h, 'content-type') ?? '').split(';')[0].trim().toLowerCase();
}

/** Bodies that aren't text even when recorded as UTF-8. */
function isBinaryMediaType(mt: string): boolean {
  return /^(?:image|audio|video|font)\//.test(mt) || /^application\/(?:octet-stream|pdf|zip|gzip|x-protobuf|protobuf|vnd\.google\.protobuf|x-tar|wasm|msgpack|x-msgpack|cbor)$/.test(mt) || mt.startsWith('application/grpc');
}

function looksJson(b: Body, mt: string): boolean {
  if (isJsonMediaType(mt)) return true;
  if (mt && mt !== 'text/plain') return false;
  const t = b.text.trimStart();
  return t.startsWith('{') || t.startsWith('[');
}

/** Postman's raw-body language from a media type. */
function rawLanguage(mt: string, json: boolean): string {
  if (json) return 'json';
  if (mt.includes('xml')) return 'xml';
  if (mt.includes('html')) return 'html';
  if (mt.includes('javascript')) return 'javascript';
  return 'text';
}

// ------------------------------------------------------------------ selection

interface Taken {
  e: Exchange;
  /** Order in the sorted session (oldest first). */
  order: number;
  method: string;
  origin: string;
  /** Raw (percent-encoded) non-empty path segments. */
  segs: string[];
  /** Raw query parameter names, in order, unique. */
  query: string[];
  /** Per segment: a param. */
  params: boolean[];
}

class Skips {
  readonly n = new Map<string, number>();
  add(kind: string, by = 1): void {
    this.n.set(kind, (this.n.get(kind) ?? 0) + by);
  }
}

const SKIP_LINES: [string, (n: number, o: { maxBytes: number }) => string][] = [
  ['mocked', (n) => `${plural(n, 'mocked or replayed answer')}`],
  ['rule', (n) => `${plural(n, 'answer')} changed by a rule`],
  ['redirect', (n) => `${plural(n, 'redirect or 1xx / 304 answer')}`],
  ['options', (n) => `${plural(n, 'OPTIONS request')}`],
  ['graphql', (n) => `${plural(n, 'GraphQL request')}`],
  ['grpc', (n) => `${plural(n, 'gRPC call')}`],
  ['websocket', (n) => `${plural(n, 'WebSocket')}`],
  ['sse', (n) => `${plural(n, 'SSE stream')}`],
  ['tunnel', (n) => `${plural(n, 'undecrypted TLS connection')}`],
  ['browser', (n) => `${plural(n, 'browser-internal request')}`],
  ['unfinished', (n) => `${plural(n, 'unfinished or failed exchange')}`],
  ['truncated', (n) => `${plural(n, 'exchange')} with a truncated body`],
  ['binary', (n) => `${plural(n, 'binary answer')}`],
  ['badUrl', (n) => `${plural(n, 'exchange')} with a non-HTTP URL`],
  ['origin', (n) => `${plural(n, 'request')} to other origins`],
  ['tooBig', (n, o) => `${plural(n, 'answer')} over ${sizeLabel(o.maxBytes)} left out (never cut)`],
  ['noExample', (n, o) => `${plural(n, 'endpoint')} left out: every answer was over ${sizeLabel(o.maxBytes)}`],
  ['statuses', (n) => `${plural(n, 'status', 'statuses')} over ${MAX_STATUSES_PER_ENDPOINT} per endpoint left out`],
  ['endpoints', (n) => `${plural(n, 'endpoint')} over the ${COLLECTION_LIMITS.endpoints.toLocaleString('en-US')} limit left out`],
  ['fileSize', (n) => `${plural(n, 'example')} left out to keep the file under ${sizeLabel(COLLECTION_LIMITS.fileBytes)}`],
  ['requestBody', (n) => `${plural(n, 'request body', 'request bodies')} over ${sizeLabel(MAX_REQUEST_BODY_BYTES)} left out`],
  ['binaryRequest', (n) => `${plural(n, 'binary request body', 'binary request bodies')} left out`],
  ['unreadable', (n) => `${plural(n, "body that wasn't", "bodies that weren't")} plain JSON left out (secret-named values in it)`],
];

function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function normalOrigin(o: string): string | undefined {
  try {
    const u = new URL(o);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

function rawQueryNames(url: string): string[] {
  const q = url.indexOf('?');
  if (q < 0) return [];
  const hash = url.indexOf('#', q);
  const search = url.slice(q + 1, hash < 0 ? undefined : hash);
  const names: string[] = [];
  for (const part of search.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const name = eq < 0 ? part : part.slice(0, eq);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function select(exchanges: readonly Exchange[], o: FromTrafficOptions, skips: Skips): Taken[] {
  const allowed = o.origins ? new Set(o.origins.map((x) => normalOrigin(x)).filter((x): x is string => !!x)) : undefined;
  const sorted = exchanges
    .filter((e) => !!e && typeof e === 'object')
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (finite(a.e.startedAt) - finite(b.e.startedAt)) || a.i - b.i)
    .map((x) => x.e);
  const out: Taken[] = [];
  for (const e of sorted) {
    if (!e || typeof e !== 'object') continue;
    const reqMt = mediaTypeOfHeaders(e.requestHeaders);
    const resMt = mediaTypeOfHeaders(e.responseHeaders);
    if (e.kind === 'websocket') skips.add('websocket');
    else if (e.kind === 'sse' || resMt === 'text/event-stream') skips.add('sse');
    else if (e.kind === 'grpc' || reqMt.startsWith('application/grpc') || resMt.startsWith('application/grpc')) skips.add('grpc');
    else if (e.kind === 'tunnel') skips.add('tunnel');
    else if (e.browserInternal) skips.add('browser');
    else if (e.state === 'mocked') skips.add('mocked');
    else if (e.state !== 'completed' || typeof e.status !== 'number' || !Number.isInteger(e.status)) skips.add('unfinished');
    else if (e.matchedRuleId && !(o.isThrottleOnlyRule?.(e.matchedRuleId) ?? false)) skips.add('rule');
    else if (e.graphql) skips.add('graphql');
    else if (typeof e.method !== 'string' || e.method.toUpperCase() === 'OPTIONS') skips.add('options');
    else if (e.status < 200 || (e.status >= 300 && e.status <= 399) || e.status > 599) skips.add('redirect');
    else {
      let u: URL;
      try {
        u = new URL(e.url);
      } catch {
        skips.add('badUrl');
        continue;
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        skips.add('badUrl');
        continue;
      }
      if (allowed && !allowed.has(u.origin)) {
        skips.add('origin');
        continue;
      }
      if (e.responseBody?.truncated || e.requestBody?.truncated) {
        skips.add('truncated');
        continue;
      }
      if ((e.responseBody && e.responseBody.encoding !== 'utf8' && e.responseBody.text.length > 0) || (isBinaryMediaType(resMt) && !!e.responseBody?.text)) {
        skips.add('binary');
        continue;
      }
      const segs = u.pathname.split('/').filter((s) => s !== '');
      out.push({
        e,
        order: out.length,
        method: e.method.toUpperCase(),
        origin: u.origin,
        segs,
        query: rawQueryNames(e.url).slice(0, MAX_QUERY_NAMES),
        params: segs.map((seg, i) => isParamSegment(seg) || isHiddenSegment(seg, i > 0 ? segs[i - 1] : undefined, o.replacePersonalData !== false)),
      });
    }
  }
  return out;
}

/** Path words after which a segment is a one-time code or a link token (`/reset/482913`, `/magic/Xk9pQ2mZrT`). */
const SECRET_ROUTE_WORD = /^(?:reset|verify|verification|confirm|confirmation|activate|activation|otp|code|codes|magic|invite|invitation|token|tokens|unsubscribe|password|passwords|share|shared)$/i;

/**
 * REVIEW-16 #11: a literal path segment that must not be written as a literal: a short token (8+ characters mixing
 * upper case, lower case and digits), a value with a digit after a `SECRET_ROUTE_WORD`, and (personal data on) a phone
 * number (`+966…`, 8–15 digits). It becomes a param, its value left empty.
 */
function isHiddenSegment(raw: string, prevRaw: string | undefined, personal: boolean): boolean {
  const d = safeDecode(raw);
  if (/^[A-Za-z0-9_-]{8,64}$/.test(d) && /[A-Z]/.test(d) && /[a-z]/.test(d) && /\d/.test(d)) return true;
  if (prevRaw !== undefined && SECRET_ROUTE_WORD.test(safeDecode(prevRaw)) && /\d/.test(d) && d.length >= 4) return true;
  return personal && /^\+?\d{8,15}$/.test(d);
}

function finite(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// ------------------------------------------------------------------ templating

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The record keys of a JSON answer (a list's first object, an envelope's first list of objects, else the object). */
interface TopShape {
  kind: 'object' | 'array' | 'other';
  keys: Set<string>;
}

function firstObject(list: unknown[]): Record<string, unknown> | undefined {
  return list.find((x) => !!x && typeof x === 'object' && !Array.isArray(x)) as Record<string, unknown> | undefined;
}

function topShape(t: Taken): TopShape | undefined {
  const b = t.e.responseBody;
  if (!b || b.encoding !== 'utf8' || b.text.length > SHAPE_SNIFF_BYTES || (t.e.status ?? 0) >= 300) return undefined;
  const s = b.text.trim();
  if (!s.startsWith('{') && !s.startsWith('[')) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    return undefined;
  }
  if (Array.isArray(v)) return { kind: 'array', keys: new Set(Object.keys(firstObject(v) ?? {})) };
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      const m = o[k];
      const rec = Array.isArray(m) ? firstObject(m) : undefined;
      if (rec) return { kind: 'object', keys: new Set([`${k}[]`, ...Object.keys(rec)]) };
    }
    return { kind: 'object', keys: new Set(Object.keys(o)) };
  }
  return { kind: 'other', keys: new Set() };
}

/** Values of one resource: the same kind, and record keys that mostly overlap (optional fields allowed). */
function similar(a: TopShape, b: TopShape): boolean {
  if (a.kind !== b.kind) return false;
  if (!a.keys.size || !b.keys.size) return a.keys.size === b.keys.size;
  let common = 0;
  for (const k of a.keys) if (b.keys.has(k)) common++;
  return common / Math.min(a.keys.size, b.keys.size) >= SIBLING_OVERLAP && common / (a.keys.size + b.keys.size - common) >= SIBLING_JACCARD;
}

/**
 * Sibling collapse (§23.1): ≥ 3 distinct literals at one position, same origin, method and parent → a param.
 * REVIEW-16 #15d: the parent path of each sample is an interned id, extended by one segment per position, so the work
 * is linear in the segments (it rebuilt the prefix text per position: quadratic).
 */
function collapseSiblings(samples: Taken[]): void {
  const maxLen = samples.reduce((m, s) => Math.max(m, s.segs.length), 0);
  const ids = new Map<string, number>([['', 0]]);
  const intern = (k: string): number => {
    let v = ids.get(k);
    if (v === undefined) ids.set(k, (v = ids.size));
    return v;
  };
  /** Per sample: the id of its path up to (not including) position i, as templated so far. */
  const pre = samples.map(() => 0);
  for (let i = 0; i < maxLen; i++) {
    if (i > 0) {
      samples.forEach((s, x) => {
        if (s.segs.length >= i) pre[x] = intern(`${pre[x]}/${s.params[i - 1] ? '{}' : s.segs[i - 1]}`);
      });
    }
    // literals followed by a param somewhere are collection names (`/users` of `/users/42`), never values
    const collections = new Set<string>();
    samples.forEach((s, x) => {
      if (s.segs.length > i + 1 && !s.params[i] && s.params[i + 1]) collections.add(`${s.origin}\0${pre[x]}\0${s.segs[i]}`);
    });
    const groups = new Map<string, { parent: number; list: Taken[] }>();
    samples.forEach((s, x) => {
      if (s.segs.length <= i || s.params[i]) return;
      const key = `${s.origin}\0${s.method}\0${pre[x]}`;
      const g = groups.get(key);
      if (g) g.list.push(s);
      else groups.set(key, { parent: pre[x], list: [s] });
    });
    for (const { parent, list: g } of groups.values()) {
      const byLiteral = new Map<string, Taken[]>();
      for (const s of g) {
        const lit = s.segs[i];
        const l = byLiteral.get(lit);
        if (l) l.push(s);
        else byLiteral.set(lit, [s]);
      }
      if (byLiteral.size < 3) continue;
      const first = g[0];
      if ([...byLiteral.keys()].some((lit) => collections.has(`${first.origin}\0${parent}\0${lit}`))) continue;
      const shapes: TopShape[] = [];
      for (const list of byLiteral.values()) {
        for (let k = list.length - 1; k >= 0; k--) {
          const sh = topShape(list[k]);
          if (sh) {
            shapes.push(sh);
            break;
          }
        }
      }
      // at least two JSON answers to compare, all alike (text-only siblings stay apart)
      if (shapes.length < 2 || shapes.some((sh) => !similar(shapes[0], sh))) continue;
      for (const s of g) s.params[i] = true;
    }
  }
}

function camel(word: string): string {
  const parts = word.split(/[-_.]+/).filter(Boolean);
  return parts.map((p, i) => (i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1))).join('');
}

/** Param names for a path: `<singular of the previous literal>Id`, else `id`, `id2`, … (unique in the path). */
function paramNames(segs: readonly string[], params: readonly boolean[]): (string | undefined)[] {
  const used = new Set<string>();
  let plain = 0;
  return segs.map((_seg, i) => {
    if (!params[i]) return undefined;
    const prev = i > 0 && !params[i - 1] ? safeDecode(segs[i - 1]) : undefined;
    if (prev && /^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(prev)) {
      const name = `${camel(singular(prev))}Id`;
      if (/^[A-Za-z][A-Za-z0-9]*$/.test(name) && !used.has(name)) {
        used.add(name);
        return name;
      }
    }
    for (;;) {
      plain++;
      const name = plain === 1 ? 'id' : `id${plain}`;
      if (!used.has(name)) {
        used.add(name);
        return name;
      }
    }
  });
}

// ------------------------------------------------------------------ building

interface Endpoint {
  origin: string;
  method: string;
  /** Literal raw segments (personal data replaced) or param names. */
  path: (string | { param: string })[];
  samples: Taken[];
}

interface BuiltExample {
  json: Json;
  bytes: number;
  dropped: boolean;
}

interface BuiltEndpoint {
  host: string;
  origin: string;
  postmanPath: string;
  method: string;
  item: Json;
  examples: BuiltExample[];
}

class Builder {
  readonly vars = new Map<string, string>();
  private readonly requests = new Map<Taken, Json>();

  constructor(
    private readonly s: TrafficSanitiser,
    private readonly baseVar: (origin: string) => string,
    private readonly skips: Skips,
  ) {}

  private variable(name: string): string {
    if (!this.vars.has(name)) this.vars.set(name, '');
    return `{{${name}}}`;
  }

  private auth(c: Credential): Json {
    this.s.noteName(c.kind === 'query' ? `${c.name} (query)` : c.name);
    switch (c.kind) {
      case 'bearer':
        return { type: 'bearer', bearer: [{ key: 'token', value: this.variable('bearerToken'), type: 'string' }] };
      case 'basic':
        return {
          type: 'basic',
          basic: [
            { key: 'username', value: this.variable('basicUsername'), type: 'string' },
            { key: 'password', value: this.variable('basicPassword'), type: 'string' },
          ],
        };
      default: {
        const v = (c.kind === 'query' ? c.name : c.name.toLowerCase()).replace(/[^A-Za-z0-9_.-]+/g, '_');
        return {
          type: 'apikey',
          apikey: [
            { key: 'key', value: c.name, type: 'string' },
            { key: 'value', value: this.variable(v), type: 'string' },
            { key: 'in', value: c.kind === 'query' ? 'query' : 'header', type: 'string' },
          ],
        };
      }
    }
  }

  private requestHeaders(h: HeaderMap | undefined, skip: string | undefined): Json[] {
    const out: Json[] = [];
    for (const [name, values] of ownEntries(h)) {
      const lower = name.toLowerCase();
      if (DROP_REQUEST_HEADERS.has(lower) || name.startsWith(':') || lower === skip) continue;
      if (isSensitiveHeader(name) || isSecretHeaderName(name)) {
        this.s.noteName(lower);
        const v = this.variable(lower.replace(/[^a-z0-9_.-]+/g, '_'));
        out.push({ key: name, value: v });
        continue;
      }
      for (const value of values) {
        const clean = this.s.text(value);
        if (redactSecretValues(clean, true) !== clean || isCredentialValue(clean)) {
          this.s.noteName(lower);
          continue;
        }
        out.push({ key: name, value: clean });
      }
    }
    return out;
  }

  responseHeaders(h: HeaderMap | undefined): Json[] {
    const out: Json[] = [];
    for (const [name, values] of ownEntries(h)) {
      const lower = name.toLowerCase();
      if (name.startsWith(':') || DROP_RESPONSE_HEADERS.has(lower) || DROP_RESPONSE_PREFIX.test(lower)) continue;
      // REVIEW-16 #6: the copy's header rule too (`X-Access-Key`, `X-Request-Sig`, `X-Csrf`)
      if (lower === 'set-cookie' || isSensitiveHeader(name) || isSecretHeaderName(name)) {
        this.s.noteName(lower);
        continue;
      }
      for (const value of values) {
        if (isCredentialValue(value)) {
          this.s.noteName(lower);
          continue;
        }
        out.push({ key: name, value: this.s.text(value) });
      }
    }
    return out;
  }

  url(ep: Endpoint, t: Taken, skipQuery: string | undefined): Json {
    const base = `{{${this.baseVar(ep.origin)}}}`;
    const path = ep.path.map((p) => (typeof p === 'string' ? p : `:${p.param}`));
    const query = t.query.filter((q) => safeDecode(q) !== skipQuery);
    const variable: Json[] = [];
    ep.path.forEach((p, i) => {
      if (typeof p === 'string') return;
      const dec = safeDecode(t.segs[i] ?? '');
      const prev = i > 0 ? ep.path[i - 1] : undefined;
      // REVIEW-16 #11: short ids are kept; longer numbers (a phone number) and values after a reset / verify / magic
      // link word (one-time codes) are not
      const sensitiveRoute = typeof prev === 'string' && SECRET_ROUTE_WORD.test(safeDecode(prev));
      const keep = !sensitiveRoute && (/^-?\d{1,7}$/.test(dec) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dec));
      variable.push({ key: p.param, value: keep && !isCredentialValue(dec) ? dec : '' });
    });
    return {
      raw: `${base}/${path.join('/')}${query.length ? `?${query.map((q) => `${q}=`).join('&')}` : ''}`,
      host: [base],
      path,
      ...(query.length ? { query: query.map((key) => ({ key: safeDecode(key), value: '' })) } : {}),
      ...(variable.length ? { variable } : {}),
    };
  }

  /** A sample's request (built once: the item and an example can share a sample). */
  request(ep: Endpoint, t: Taken): Json {
    let req = this.requests.get(t);
    if (!req) this.requests.set(t, (req = this.buildRequest(ep, t)));
    return { ...req };
  }

  private buildRequest(ep: Endpoint, t: Taken): Json {
    const cred = credentialsOf(t.e)[0];
    const skipHeader = cred && cred.kind !== 'query' ? cred.name.toLowerCase() : undefined;
    const skipQuery = cred?.kind === 'query' ? cred.name : undefined;
    const req: Json = { method: ep.method, header: this.requestHeaders(t.e.requestHeaders, skipHeader), url: this.url(ep, t, skipQuery) };
    if (cred) req.auth = this.auth(cred);
    const b = t.e.requestBody;
    if (b && b.text.length > 0) {
      const mt = mediaTypeOfHeaders(t.e.requestHeaders);
      if (b.encoding !== 'utf8' || isBinaryMediaType(mt) || mt.startsWith('multipart/')) this.skips.add('binaryRequest');
      else if (utf8Length(b.text) > MAX_REQUEST_BODY_BYTES) this.skips.add('requestBody');
      else {
        const text = this.s.requestBody(b.text, mt);
        const json = isJsonMediaType(mt) || /^\s*[[{]/.test(text);
        req.body = { mode: 'raw', raw: text, options: { raw: { language: rawLanguage(mt, json) } } };
      }
    }
    return req;
  }

  example(ep: Endpoint, t: Taken, maxBytes: number): BuiltExample | undefined {
    const code = t.e.status!;
    const b = t.e.responseBody;
    const mt = mediaTypeOfHeaders(t.e.responseHeaders);
    let body = '';
    let json = false;
    if (b && b.text.length > 0) {
      if (b.text.length > maxBytes) return undefined; // ≥ its UTF-8 size: over before any work
      json = looksJson(b, mt);
      body = this.s.responseBody(b.text, json);
      if (utf8Length(body) > maxBytes) return undefined;
    }
    const status = reasonPhrase(code);
    const jsonObj: Json = {
      name: `${code}${status ? ` ${status}` : ''}`,
      originalRequest: this.request(ep, t),
      status,
      code,
      _postman_previewlanguage: body ? rawLanguage(mt, json) : 'text',
      header: this.responseHeaders(t.e.responseHeaders),
      cookie: [],
      body,
    };
    return { json: jsonObj, bytes: utf8Length(body), dropped: false };
  }
}

/** The collection from recorded traffic (§23.1). Never throws on odd exchanges. */
export function collectionFromTraffic(exchanges: readonly Exchange[], o: FromTrafficOptions): FromTrafficResult {
  const maxBytes = Math.max(1, Math.min(o.maxExampleBytes ?? DEFAULT_MAX_EXAMPLE_BYTES, COLLECTION_LIMITS.exampleBodyBytes));
  const sanitiser = new TrafficSanitiser(o.replacePersonalData !== false);
  const skips = new Skips();
  const taken = select(Array.isArray(exchanges) ? exchanges : [], o, skips);
  collapseSiblings(taken);

  // endpoints, first-seen order
  const endpoints = new Map<string, Endpoint>();
  for (const t of taken) {
    const names = paramNames(t.segs, t.params);
    const tpl = t.segs.map((seg, i) => (t.params[i] ? '{}' : seg)).join('/');
    const key = `${t.origin}\0${t.method}\0${tpl}`;
    let ep = endpoints.get(key);
    if (!ep) {
      ep = {
        origin: t.origin,
        method: t.method,
        path: t.segs.map((seg, i) => (t.params[i] ? { param: names[i]! } : sanitiser.pathSegment(seg))),
        samples: [],
      };
      endpoints.set(key, ep);
    }
    ep.samples.push(t);
  }
  let list = [...endpoints.values()];
  if (list.length > COLLECTION_LIMITS.endpoints) {
    skips.add('endpoints', list.length - COLLECTION_LIMITS.endpoints);
    list = list.slice(0, COLLECTION_LIMITS.endpoints);
  }

  const origins: string[] = [];
  for (const ep of list) if (!origins.includes(ep.origin)) origins.push(ep.origin);
  const baseVars = new Map(origins.map((x, i) => [x, i === 0 ? 'baseUrl' : `baseUrl${i + 1}`]));
  const b = new Builder(sanitiser, (x) => baseVars.get(x)!, skips);

  const built: BuiltEndpoint[] = [];
  for (const ep of list) {
    // newest per status that fits; statuses ascending, ≤ 20
    const byStatus = new Map<number, Taken[]>();
    for (const t of ep.samples) {
      const l = byStatus.get(t.e.status!);
      if (l) l.push(t);
      else byStatus.set(t.e.status!, [t]);
    }
    let statuses = [...byStatus.keys()].sort((x, y) => x - y);
    if (statuses.length > MAX_STATUSES_PER_ENDPOINT) {
      skips.add('statuses', statuses.length - MAX_STATUSES_PER_ENDPOINT);
      statuses = statuses.slice(0, MAX_STATUSES_PER_ENDPOINT);
    }
    const examples: BuiltExample[] = [];
    for (const st of statuses) {
      const l = byStatus.get(st)!;
      for (let k = l.length - 1; k >= 0; k--) {
        const ex = b.example(ep, l[k], maxBytes);
        if (ex) {
          examples.push(ex);
          break;
        }
        skips.add('tooBig');
      }
    }
    if (!examples.length) {
      skips.add('noExample');
      continue;
    }
    const newest = ep.samples[ep.samples.length - 1];
    const postmanPath = `/${ep.path.map((p) => (typeof p === 'string' ? p : `:${p.param}`)).join('/')}`;
    built.push({
      host: new URL(ep.origin).host,
      origin: ep.origin,
      postmanPath,
      method: ep.method,
      item: {
        name: `${ep.method} ${postmanPath}`,
        request: { ...b.request(ep, newest), description: `Recorded ${plural(ep.samples.length, 'time')}.` },
      },
      examples,
    });
  }

  const assemble = (): { doc: Json; examples: number; endpoints: BuiltEndpoint[] } => {
    const kept = built.filter((x) => x.examples.some((e) => !e.dropped));
    const folders = new Map<string, BuiltEndpoint[]>();
    for (const x of kept) {
      const f = folders.get(x.host);
      if (f) f.push(x);
      else folders.set(x.host, [x]);
    }
    let count = 0;
    const item: Json[] = [];
    for (const [host, eps] of folders) {
      eps.sort((x, y) => (x.postmanPath < y.postmanPath ? -1 : x.postmanPath > y.postmanPath ? 1 : x.method < y.method ? -1 : x.method > y.method ? 1 : 0));
      const hostOrigins = origins.filter((x) => new URL(x).host === host);
      item.push({
        name: host,
        description: hostOrigins.map((x) => `{{${baseVars.get(x)}}}`).join('\n'),
        item: eps.map((x) => {
          const response = x.examples.filter((e) => !e.dropped).map((e) => e.json);
          count += response.length;
          return { ...x.item, response };
        }),
      });
    }
    const used = new Set(kept.map((x) => x.origin));
    const variable: Json[] = [
      ...origins.filter((x) => used.has(x)).map((x) => ({ key: baseVars.get(x)!, value: x, type: 'string' })),
      ...[...b.vars].map(([key, value]) => ({ key, value, type: 'string' })),
    ];
    const doc: Json = {
      info: {
        name: o.name || 'Recorded API',
        description:
          `Recorded by Flutter Intercept from ${plural(taken.length, 'request')}. Credentials are removed; example bodies ` +
          'are real data: review before committing.',
        schema: POSTMAN_SCHEMA,
      },
      item,
      variable,
    };
    return { doc, examples: count, endpoints: kept };
  };

  let result = assemble();
  let text = JSON.stringify(result.doc, null, 2);
  // ≤ 20 MB: drop the largest examples first until the file fits
  while (utf8Length(text) > COLLECTION_LIMITS.fileBytes) {
    let excess = utf8Length(text) - COLLECTION_LIMITS.fileBytes;
    const live = built.flatMap((x) => x.examples.filter((e) => !e.dropped)).sort((x, y) => y.bytes - x.bytes);
    if (!live.length) break;
    for (const e of live) {
      e.dropped = true;
      skips.add('fileSize');
      excess -= Math.max(e.bytes, 1);
      if (excess <= 0) break;
    }
    result = assemble();
    text = JSON.stringify(result.doc, null, 2);
  }

  // the parsed text, not the built document: a plain tree (the built one shares request parts between the item and its
  // examples), so the copy's walk budget is sized to it (REVIEW-16 #12)
  const clean = sanitisePostman(JSON.parse(text) as unknown);
  // REVIEW-16 #12: never a cut (empty) collection with counts that say otherwise
  if (clean.removed.includes(SANITISE_TOO_LARGE)) {
    throw new Error(
      `The recorded traffic is too large to write as one collection (${plural(result.endpoints.length, 'endpoint')}, ${plural(result.examples, 'example')}): choose fewer servers or a shorter part of the session.`,
    );
  }
  text = JSON.stringify(clean.doc, null, 2);
  if (sanitiser.bodiesDropped) skips.add('unreadable', sanitiser.bodiesDropped);
  const removed = new Set<string>(sanitiser.removed);
  for (const r of clean.removed) removed.add(safeNameLabel(r));

  const skipped: string[] = [];
  for (const [kind, line] of SKIP_LINES) {
    const n = skips.n.get(kind);
    if (n) skipped.push(line(n, { maxBytes }));
  }
  const usedOrigins = origins.filter((x) => result.endpoints.some((e) => e.origin === x));
  return {
    text,
    endpoints: result.endpoints.length,
    examples: result.examples,
    origins: usedOrigins,
    skipped,
    removed: [...removed].sort().slice(0, MAX_REMOVED),
  };
}
