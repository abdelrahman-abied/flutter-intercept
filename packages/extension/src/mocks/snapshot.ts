/**
 * Stateful mocks: the snapshot file format (CONTRACTS §22.8). Pure: no vscode, no fs, no network.
 *
 * - `parseSnapshot(text)` / `validateSnapshot(value)`: shape and limits only (version 1, `collection`, `savedAt`,
 *   `resources` → `[{scope?, records}]`, `next`). `__proto__` as a scope key → broken; as a resource name it is kept
 *   like any other (REVIEW-16 #15c); inside records it is dropped (records come back as null-prototype objects). An
 *   entry with no records counts as one record, and every scope's text against the byte cap (REVIEW-16 #10). Which resources exist is the store's business
 *   (`ResourceStore.load`).
 * - `snapshotText(dump)`: a field whose name is secret-like (`isSecretFieldName` = the shared `secrets.ts` check, as
 *   wide as the agent redaction; `author`, `sessionCount`, `pinned`, `tokenizer` stay) gets `""` for any non-empty,
 *   non-boolean value; a string value that is a credential (a JWT, `Bearer` / `Basic` / `Token …`, a long opaque or
 *   prefixed token, a PEM key) becomes `""` whatever its name; other strings lose URL userinfo, signature / token
 *   query values and embedded credentials, and JSON inside a string its secret-named values (REVIEW-16 #5). Scope
 *   values get the same value rules (#15c). `blanked` lists `<resource>.<field path>` once each (sorted, at most 50;
 *   a key that is an e-mail, a number or a credential shows as a kind). Key order: version, collection, savedAt,
 *   resources (names sorted), next (names sorted); scope keys sorted; record keys as stored. 2-space JSON + newline.
 *   The optional `endpoints` argument is accepted for the contract's signature and not needed.
 */
import { cleanJson, isRecord, nullObject, parseJsonText, setKey, utf8Length, type JsonRecord } from './resources';
import { fieldWords, isCredentialValue, isSecretField, isSecretName, safeNameLabel, scrubNamedText, scrubSecretText } from './secrets';
import { COLLECTION_LIMITS, STORE_LIMITS, type MockEndpoint, type StoreSnapshot } from './types';

export { fieldWords };

const MAX_BLANKED = 50;
const MAX_PROBLEMS = 20;
const MAX_NAME = 200;
const MAX_SCOPE_KEYS = 16;
/** What one `{scope, records}` entry costs on top of its scope text (REVIEW-16 #10). */
const ENTRY_BYTES = 32;
/** JSON inside a string value is checked by name up to this size. */
const MAX_JSON_IN_STRING = 64 * 1024;

/**
 * §22.8 snapshot redaction by name — REVIEW-16 #5: the shared check (`secrets.ts` `isSecretName`), as wide as the
 * agent redaction but without its `author` / `sessionCount` / `tokenizer` false positives.
 */
export function isSecretFieldName(name: string): boolean {
  return isSecretName(name);
}

/** A string value that looks like a credential whatever its field name (JWT, Bearer / Basic / Token, opaque or prefixed token, PEM key). */
export function looksLikeCredential(v: string): boolean {
  return isCredentialValue(v);
}

/**
 * A string value as written to a snapshot: `""` when it is or holds a credential (`isCredentialValue`: JWT, scheme
 * credential, opaque / prefixed token, PEM key); else URLs without userinfo or signature / token query values,
 * prefixed keys cut out of longer text, and (JSON inside a string) secret-named entries blanked.
 */
export function redactSnapshotString(v: string): string {
  if (v === '' || isCredentialValue(v)) return '';
  let out = scrubSecretText(v);
  if (out.trim() === '' || isCredentialValue(out)) return '';
  const t = out.trimStart();
  if ((t.startsWith('{') || t.startsWith('[')) && out.length <= MAX_JSON_IN_STRING) out = scrubNamedText(out);
  return out;
}

function short(s: string): string {
  const t = s.replace(/[\u0000-\u001f\u007f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
}

/** Shape and limits of a snapshot object (§22.8). A cleaned copy, or the problems (then nothing may change). */
export function validateSnapshot(value: unknown): { snapshot?: StoreSnapshot; problems: string[] } {
  const problems: string[] = [];
  const fail = (line: string): { problems: string[] } => {
    problems.push(line);
    return { problems: problems.slice(0, MAX_PROBLEMS) };
  };
  if (!isRecord(value)) return fail('The snapshot is not a JSON object');
  if (value['version'] !== 1) return fail('The snapshot version must be 1');
  const collection = value['collection'];
  if (typeof collection !== 'string' || collection.length > 40) return fail('The snapshot has no valid "collection"');
  const savedAt = value['savedAt'];
  if (savedAt !== undefined && (typeof savedAt !== 'string' || savedAt.length > 64)) return fail('The snapshot "savedAt" must be a date text');
  const resources = value['resources'];
  if (!isRecord(resources)) return fail('The snapshot has no "resources" object');

  const outResources = nullObject() as StoreSnapshot['resources'];
  let totalBytes = 0;
  const names = Object.keys(resources);
  if (names.length > STORE_LIMITS.resourcesPerCollection) return fail(`The snapshot names more than ${STORE_LIMITS.resourcesPerCollection} resources`);
  for (const name of names) {
    // REVIEW-16 #15c: `__proto__` is a resource name like any other (kept with setKey on a null-prototype object)
    if (name.length === 0 || name.length > MAX_NAME) return fail(`The snapshot has an invalid resource name "${short(name)}"`);
    const entries = resources[name];
    const label = short(name);
    if (!Array.isArray(entries)) return fail(`${label}: must be a list of {scope?, records}`);
    const outEntries: { scope?: Record<string, string>; records: unknown[] }[] = [];
    let count = 0;
    for (const entry of entries) {
      if (!isRecord(entry)) return fail(`${label}: each entry must be an object`);
      let scope: Record<string, string> | undefined;
      if (entry['scope'] !== undefined) {
        const sc = entry['scope'];
        if (!isRecord(sc)) return fail(`${label}: "scope" must be an object of texts`);
        const keys = Object.keys(sc);
        if (keys.length > MAX_SCOPE_KEYS) return fail(`${label}: "scope" has too many keys`);
        scope = nullObject() as Record<string, string>;
        for (const k of keys) {
          const v = sc[k];
          if (k === '__proto__' || typeof v !== 'string' || v.length > COLLECTION_LIMITS.paramChars) {
            return fail(`${label}: "scope" must map names to texts of at most ${COLLECTION_LIMITS.paramChars} characters`);
          }
          setKey(scope, k, v);
        }
      }
      const records = entry['records'];
      if (!Array.isArray(records)) return fail(`${label}: each entry needs a "records" list`);
      // REVIEW-16 #10: an entry with no records (a parent the user emptied) counts as one record, and its scope
      // against the byte cap, so empty entries can't get past either cap
      if (records.length === 0 && ++count > STORE_LIMITS.recordsPerResource) return fail(`${label}: more than ${STORE_LIMITS.recordsPerResource} records`);
      if (scope) {
        totalBytes += utf8Length(JSON.stringify(scope)) + ENTRY_BYTES;
        if (totalBytes > STORE_LIMITS.snapshotBytes) return fail(`The snapshot is over ${Math.round(STORE_LIMITS.snapshotBytes / 1048576)} MB`);
      }
      const outRecords: unknown[] = [];
      for (const r of records) {
        if (!isRecord(r)) return fail(`${label}: every record must be a JSON object`);
        const c = cleanJson(r);
        if (!c.ok) return fail(`${label}: a record can't be loaded (${c.reason})`);
        const size = utf8Length(JSON.stringify(c.value));
        if (size > STORE_LIMITS.recordBytes) return fail(`${label}: a record is over ${Math.round(STORE_LIMITS.recordBytes / 1048576)} MB`);
        totalBytes += size;
        if (totalBytes > STORE_LIMITS.snapshotBytes) return fail(`The snapshot is over ${Math.round(STORE_LIMITS.snapshotBytes / 1048576)} MB`);
        if (++count > STORE_LIMITS.recordsPerResource) return fail(`${label}: more than ${STORE_LIMITS.recordsPerResource} records`);
        outRecords.push(c.value);
      }
      outEntries.push(scope ? { scope, records: outRecords } : { records: outRecords });
    }
    setKey(outResources as JsonRecord, name, outEntries);
  }

  let next: Record<string, number> | undefined;
  if (value['next'] !== undefined) {
    const n = value['next'];
    if (!isRecord(n)) return fail('The snapshot "next" must map resource names to numbers');
    next = nullObject() as Record<string, number>;
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
        return fail('The snapshot "next" must map resource names to whole numbers');
      }
      setKey(next as JsonRecord, k, v);
    }
  }
  const snapshot: StoreSnapshot = {
    version: 1,
    collection,
    savedAt: typeof savedAt === 'string' ? savedAt : '',
    resources: outResources,
    ...(next ? { next } : {}),
  };
  return { snapshot, problems };
}

/** `parseSnapshot(text)`: JSON + `validateSnapshot` (§22.8). Never throws. */
export function parseSnapshot(text: string): { snapshot?: StoreSnapshot; problems: string[] } {
  if (typeof text !== 'string') return { problems: ['The snapshot is not text'] };
  if (utf8Length(text) > STORE_LIMITS.snapshotBytes) {
    return { problems: [`The snapshot is over ${Math.round(STORE_LIMITS.snapshotBytes / 1048576)} MB`] };
  }
  const parsed = parseJsonText(text.replace(/^﻿/, ''));
  if (!parsed.ok) return { problems: ["The snapshot isn't valid JSON"] };
  return validateSnapshot(parsed.value);
}

/** A field path segment for `blanked`: a key that is itself personal data or a credential shows as a kind (REVIEW-16 #11). */
function pathKey(k: string): string {
  const label = safeNameLabel(k);
  return label === k ? k : `(${label})`;
}

function redactValue(v: unknown, path: string, blanked: Set<string>, depth: number): unknown {
  if (typeof v === 'string') {
    const next = redactSnapshotString(v);
    if (next !== v) blanked.add(path);
    return next;
  }
  if (v === null || typeof v !== 'object' || depth > STORE_LIMITS.recordDepth + 2) return v;
  if (Array.isArray(v)) return v.map((x) => redactValue(x, path, blanked, depth + 1));
  const out = nullObject();
  for (const k of Object.keys(v)) {
    if (k === '__proto__') continue;
    const child = (v as JsonRecord)[k];
    const childPath = `${path}.${pathKey(k)}`;
    // the value decides for the bare names `session` / `sessions` / `pass` (`isSecretField`): only text is a secret
    if (isSecretField(k, child) && child !== '' && child !== null && child !== undefined && typeof child !== 'boolean') {
      blanked.add(childPath);
      setKey(out, k, '');
    } else {
      setKey(out, k, redactValue(child, childPath, blanked, depth + 1));
    }
  }
  return out;
}

function sortedObject<T>(o: Record<string, T>, map: (v: T, k: string) => unknown): JsonRecord {
  const out = nullObject();
  for (const k of Object.keys(o).sort()) setKey(out, k, map(o[k], k));
  return out;
}

/** §22.8 save: redacted, stable, 2-space JSON text and the fields blanked (`<resource>.<field>`). */
export function snapshotText(dump: StoreSnapshot, endpoints?: MockEndpoint[]): { text: string; blanked: string[] } {
  void endpoints;
  const blanked = new Set<string>();
  const resources = sortedObject(isRecord(dump.resources) ? dump.resources : {}, (entries, name) =>
    (Array.isArray(entries) ? entries : []).map((e) => {
      const out = nullObject();
      // REVIEW-16 #15c: scope values (parent ids from URLs) go through the value redaction too
      if (e && isRecord(e.scope)) {
        setKey(
          out,
          'scope',
          sortedObject(e.scope, (v, k) => {
            if (typeof v !== 'string') return v;
            const next = redactSnapshotString(v);
            if (next !== v) blanked.add(`${name}.scope.${pathKey(k)}`);
            return next;
          }),
        );
      }
      setKey(out, 'records', (Array.isArray(e?.records) ? e.records : []).map((r) => redactValue(r, name, blanked, 1)));
      return out;
    }),
  );
  const doc = nullObject();
  setKey(doc, 'version', 1);
  setKey(doc, 'collection', typeof dump.collection === 'string' ? dump.collection : '');
  setKey(doc, 'savedAt', typeof dump.savedAt === 'string' ? dump.savedAt : '');
  setKey(doc, 'resources', resources);
  if (dump.next && isRecord(dump.next)) setKey(doc, 'next', sortedObject(dump.next, (v) => v));
  const list = [...blanked].sort();
  return { text: `${JSON.stringify(doc, null, 2)}\n`, blanked: list.slice(0, MAX_BLANKED) };
}

