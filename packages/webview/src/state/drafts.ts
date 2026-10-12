/** Paused-exchange drafts: headers rows, edits, validation. Split out of ../state.ts (QUALITY-1 Q6). */
import type { Exchange, RequestEdit, ResponseEdit } from '../protocol';
import { type Headers, type JsonCheck, headerValue, isAbsoluteUrl, isJsonContentType, validateJson } from '../util';
import type { Draft, HeaderRow, RequestDraft, ResponseDraft, State } from './core';

// ---------------------------------------------------------------- paused-exchange drafts

export function draftKindFor(ex: Exchange): Draft['kind'] | undefined {
  return ex.state === 'paused-request' ? 'request' : ex.state === 'paused-response' ? 'response' : undefined;
}

export function headersToRows(h: Headers | undefined): HeaderRow[] {
  const rows: HeaderRow[] = [];
  for (const [name, v] of Object.entries(h ?? {})) {
    if (Array.isArray(v)) for (const x of v) rows.push({ name, value: x });
    else rows.push({ name, value: v });
  }
  return rows;
}

/**
 * Rows → edit headers (the full replacement set). Empty names are dropped; a name that
 * appears on several rows (case-insensitively) becomes a string[] in row order — never joined,
 * so Set-Cookie and friends survive.
 */
export function rowsToRecord(rows: HeaderRow[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const canonical = new Map<string, string>();
  for (const r of rows) {
    const name = r.name.trim();
    if (!name) continue;
    const key = canonical.get(name.toLowerCase());
    if (key === undefined) {
      canonical.set(name.toLowerCase(), name);
      out[name] = r.value;
    } else {
      const prev = out[key];
      out[key] = Array.isArray(prev) ? [...prev, r.value] : [prev, r.value];
    }
  }
  return out;
}

/** Mock rule headers are Record<string, string> in the contract: repeated names are joined. */
export function rowsToFlatRecord(rows: HeaderRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rowsToRecord(rows))) out[k] = Array.isArray(v) ? v.join(', ') : v;
  return out;
}

/** One line per (lower-cased name, value); value order within a name is kept. */
function normalizedHeaders(h: Record<string, string | string[]>): string {
  return Object.entries(h)
    .map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v : [v]] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([k, vs]) => vs.map((v) => `${k}:${v}`))
    .join('\n');
}

export function headersChanged(original: Headers | undefined, rows: HeaderRow[]): boolean {
  return normalizedHeaders(original ?? {}) !== normalizedHeaders(rowsToRecord(rows));
}

/** Body editing is only safe for complete UTF-8 bodies (or no body at all). */
export function isBodyEditable(body: Exchange['requestBody']): boolean {
  return !body || (body.encoding === 'utf8' && !body.truncated);
}

export function draftFromExchange(ex: Exchange): Draft | undefined {
  if (ex.state === 'paused-request') {
    return {
      kind: 'request',
      method: ex.method,
      url: ex.url,
      headers: headersToRows(ex.requestHeaders),
      body: ex.requestBody?.encoding === 'utf8' ? ex.requestBody.text : '',
    };
  }
  if (ex.state === 'paused-response') {
    return {
      kind: 'response',
      status: ex.status !== undefined ? String(ex.status) : '',
      headers: headersToRows(ex.responseHeaders),
      body: ex.responseBody?.encoding === 'utf8' ? ex.responseBody.text : '',
    };
  }
  return undefined;
}

/** The draft the editor shows: the user's draft if it matches the paused phase, else a fresh one. */
export function currentDraft(state: Pick<State, 'drafts'>, ex: Exchange): Draft | undefined {
  const d = state.drafts[ex.id];
  return d && d.kind === draftKindFor(ex) ? d : draftFromExchange(ex);
}

/** Only the fields that differ from the paused request; undefined when nothing changed. */
export function computeRequestEdit(ex: Exchange, d: RequestDraft): RequestEdit | undefined {
  const edit: RequestEdit = {};
  const method = d.method.trim().toUpperCase();
  if (method && method !== ex.method.toUpperCase()) edit.method = method;
  const url = d.url.trim();
  if (url && url !== ex.url) edit.url = url;
  if (headersChanged(ex.requestHeaders, d.headers)) edit.headers = rowsToRecord(d.headers);
  if (isBodyEditable(ex.requestBody) && d.body !== (ex.requestBody?.text ?? '')) edit.body = d.body;
  return Object.keys(edit).length ? edit : undefined;
}

export function computeResponseEdit(ex: Exchange, d: ResponseDraft): ResponseEdit | undefined {
  const edit: ResponseEdit = {};
  const status = Number(d.status.trim());
  if (d.status.trim() && Number.isInteger(status) && status !== ex.status) edit.status = status;
  if (headersChanged(ex.responseHeaders, d.headers)) edit.headers = rowsToRecord(d.headers);
  if (isBodyEditable(ex.responseBody) && d.body !== (ex.responseBody?.text ?? '')) edit.body = d.body;
  return Object.keys(edit).length ? edit : undefined;
}

export function computeEdit(ex: Exchange, d: Draft): RequestEdit | ResponseEdit | undefined {
  return d.kind === 'request' ? computeRequestEdit(ex, d) : computeResponseEdit(ex, d);
}

export interface DraftValidation {
  errors: string[];       // hard errors: block "Resume with edits"
  json?: JsonCheck;       // set when the body is declared JSON; invalid → needs confirmation
}

export function validateDraft(d: Draft): DraftValidation {
  const errors: string[] = [];
  if (d.kind === 'request') {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(d.method.trim())) errors.push('Method must be a single HTTP token, e.g. GET');
    if (!isAbsoluteUrl(d.url.trim())) errors.push('URL must be absolute (http:// or https://)');
  } else {
    const s = Number(d.status.trim());
    if (!Number.isInteger(s) || s < 100 || s > 599) errors.push('Status must be an integer 100–599');
  }
  for (const r of d.headers) {
    if (r.name.trim() && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(r.name.trim())) errors.push(`Invalid header name “${r.name}”`);
  }
  const ct = headerValue(rowsToRecord(d.headers), 'content-type');
  const json = isJsonContentType(ct) && d.body.trim() ? validateJson(d.body) : undefined;
  return { errors, json };
}
