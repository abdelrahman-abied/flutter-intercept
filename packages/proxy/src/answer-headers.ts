// REVIEW-16 #14 / #15a: what a made-up answer (mock, script `respond`, stateful mock) may put on the wire. Node refuses
// some header values inside mockttp (a hidden 500 recorded as a mocked 200), and connection headers break the app's
// connection, so the proxy checks the answer before it is sent and records what it sends.

import type { HeaderBag } from './body';
import { HTTP_TOKEN } from './proxy-util';

/** What Node accepts in a header value (`http.validateHeaderValue`): tab, printable ASCII and Latin-1. */
const SENDABLE_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
/** Connection headers: the proxy manages the connection, a made-up answer can't (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
/** Headers whose parameters may carry UTF-8 text as an RFC 8187 ext-value (`name*=UTF-8''…`). */
const PARAMETERISED = new Set(['content-disposition', 'link']);
/** RFC 8187 attr-char: everything else in an ext-value is percent-encoded. */
const ATTR_CHAR = /^[A-Za-z0-9!#$&+.^_`|~-]$/;
const PARAM = /^\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*=\s*([\s\S]*?)\s*$/;

export const isHopByHop = (name: string): boolean => {
  const n = name.toLowerCase();
  return HOP_BY_HOP.has(n) || n.startsWith('proxy-');
};

/** A made-up answer's status must be final: 200–599 (a 1xx would be sent as if it were the answer). */
export function answerStatusProblem(status: number): string | undefined {
  if (Number.isInteger(status) && status >= 200 && status <= 599) return undefined;
  if (Number.isInteger(status) && status >= 100 && status <= 199) return `status ${status} is informational (1xx); a made-up answer must have a final status, 200–599`;
  return `status must be an integer 200–599, got ${JSON.stringify(status)}`;
}

/** UTF-8 percent-encoding of an ext-value's text (RFC 8187 §3.2.1). */
function percentEncode(text: string): string {
  let out = '';
  for (const ch of text) {
    if (ATTR_CHAR.test(ch)) out += ch;
    else for (const b of Buffer.from(ch, 'utf8')) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** A quoted-string's text (`"a\"b"` → `a"b`), or the token as it is. */
function unquote(v: string): string {
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).replace(/\\([\s\S])/g, '$1') : v;
}

/**
 * `value` of a parameterised header with its non-Latin-1 parameters written as RFC 8187 ext-values
 * (`filename="ملف.pdf"` → `filename*=UTF-8''%D9%85%D9%84%D9%81.pdf`; a `name*` already there wins and the plain
 * `name` is left out), or undefined when something else (the disposition type, a link target) can't be sent.
 */
export function encodeExtValues(value: string): string | undefined {
  // split on `;` and `,` outside quoted strings and `<…>`, keeping the separators
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quoted) {
      cur += c;
      if (c === '\\' && i + 1 < value.length) cur += value[++i];
      else if (c === '"') quoted = false;
    } else if (angle) {
      cur += c;
      if (c === '>') angle = false;
    } else if (c === ';' || c === ',') {
      parts.push(cur, c);
      cur = '';
    } else {
      if (c === '"') quoted = true;
      else if (c === '<') angle = true;
      cur += c;
    }
  }
  parts.push(cur);
  // the ext-value names present in each link-value (between `,`), so a plain `name` next to its `name*` is dropped
  const extNames: Set<string>[] = [];
  let group = new Set<string>();
  for (let k = 0; k < parts.length; k += 2) {
    const m = PARAM.exec(parts[k]);
    if (m && m[1].endsWith('*')) group.add(m[1].slice(0, -1).toLowerCase());
    extNames[k] = group;
    if (parts[k + 1] === ',') group = new Set();
  }
  for (let k = 0; k < parts.length; k += 2) {
    if (SENDABLE_VALUE.test(parts[k])) continue;
    const m = PARAM.exec(parts[k]);
    if (!m) return undefined;
    const [, name, raw] = m;
    const lead = /^\s*/.exec(parts[k])![0];
    if (name.endsWith('*')) {
      // an ext-value written with raw characters: percent-encode its text when it says UTF-8
      const ext = /^([A-Za-z0-9!#$%&+^_`{}~-]+)'([A-Za-z0-9-]*)'([\s\S]*)$/.exec(unquote(raw));
      if (!ext || ext[1].toLowerCase() !== 'utf-8') return undefined;
      parts[k] = `${lead}${name}=UTF-8'${ext[2]}'${ext[3].replace(/[^\x21-\x7e]+/g, (s) => percentEncode(s))}`;
    } else if (extNames[k].has(name.toLowerCase())) {
      parts[k] = ''; // `name*` says it already
      if (k > 0 && parts[k - 1] === ';') parts[k - 1] = '';
      else if (parts[k + 1] === ';') parts[k + 1] = '';
    } else {
      parts[k] = `${lead}${name}*=UTF-8''${percentEncode(unquote(raw))}`;
    }
  }
  const out = parts.join('');
  return SENDABLE_VALUE.test(out) ? out : undefined;
}

/** What `prepareAnswerHeaders` changed: hop-by-hop headers left out, headers RFC 8187-encoded. */
export interface AnswerHeaderChanges {
  dropped: string[];
  encoded: string[];
}

/**
 * Makes a made-up answer's headers sendable, in place: hop-by-hop headers are left out, a non-Latin-1 parameter of a
 * parameterised header (`content-disposition`, `link`) is RFC 8187-encoded. Throws a readable message naming the
 * header for anything else Node would refuse (an invalid name, a control character, text outside Latin-1).
 */
export function prepareAnswerHeaders(headers: HeaderBag): AnswerHeaderChanges {
  const dropped: string[] = [];
  const encoded: string[] = [];
  for (const name of Object.keys(headers)) {
    const v = headers[name];
    if (v === undefined) continue;
    const shown = JSON.stringify(name).slice(0, 100);
    if (!HTTP_TOKEN.test(name)) throw new Error(`header name ${shown} is not a valid HTTP header name`);
    if (isHopByHop(name)) {
      delete headers[name];
      dropped.push(name.toLowerCase());
      continue;
    }
    const values = Array.isArray(v) ? v : [v];
    let changed = false;
    const fixed = values.map((x) => {
      const s = String(x);
      if (SENDABLE_VALUE.test(s)) return s;
      const enc = PARAMETERISED.has(name.toLowerCase()) && !/[\r\n\0]/.test(s) ? encodeExtValues(s) : undefined;
      if (enc === undefined) {
        throw new Error(`header ${shown} has characters HTTP can't send (outside Latin-1, or control characters)`);
      }
      changed = true;
      return enc;
    });
    if (changed) {
      headers[name] = Array.isArray(v) ? fixed : fixed[0];
      encoded.push(name.toLowerCase());
    }
  }
  return { dropped, encoded };
}
