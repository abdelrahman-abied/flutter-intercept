/**
 * Postman environment parser and variable merge order (CONTRACTS §21.1, §21.2). Pure: no vscode, no fs, no network.
 */
import { redactUrl } from '../agent/redact';
import type { CollectionVars, ParsePostmanEnvironment, VariableSource } from './types';

type Obj = Record<string, unknown>;

const MAX_PROBLEM_CHARS = 300;
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;
const URL_IN_TEXT = /[a-z][a-z0-9+.-]{0,30}:\/\/[^\s"'<>`]+/gi;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function own(obj: Obj, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key)
    ? Object.getOwnPropertyDescriptor(obj, key)?.value
    : undefined;
}

/** Sanitises file text quoted inside a problem line (REVIEW-15 #7): no URL credentials, no bidi/control chars, bounded length. */
function quoteFileText(raw: string, max = 60): string {
  const cleaned = raw
    .replace(URL_IN_TEXT, (u) => redactUrl(u))
    .replace(BIDI_CONTROLS, '')
    .replace(/[\x00-\x1F\x7F]+/g, ' ')
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function pushProblem(problems: string[], msg: string): void {
  const cleaned = msg
    .replace(URL_IN_TEXT, (u) => redactUrl(u))
    .replace(BIDI_CONTROLS, '')
    .replace(/[\x00-\x1F\x7F]+/g, ' ')
    .trim();
  problems.push(cleaned.length > MAX_PROBLEM_CHARS ? `${cleaned.slice(0, MAX_PROBLEM_CHARS - 1)}…` : cleaned);
}

/**
 * CONTRACTS §21.1, §21.2: reads a Postman environment's `values[]` with `enabled !== false` and non-empty values.
 * Never throws; invalid entries produce readable one-line problems.
 */
export const parsePostmanEnvironment: ParsePostmanEnvironment = (doc) => {
  const values = new Map<string, string>();
  const problems: string[] = [];

  if (!isObj(doc)) {
    pushProblem(problems, 'Postman environment must be a JSON object.');
    return { values, problems };
  }

  const rawValues = own(doc, 'values');
  if (!Array.isArray(rawValues)) {
    pushProblem(problems, 'Postman environment has no "values" array.');
    return { values, problems };
  }

  for (let i = 0; i < rawValues.length; i++) {
    const entry = rawValues[i];
    if (!isObj(entry)) {
      pushProblem(problems, `Environment entry ${i + 1} is not an object (skipped).`);
      continue;
    }
    if (own(entry, 'enabled') === false) {
      continue;
    }

    const key = own(entry, 'key');
    if (typeof key !== 'string' || key.length === 0) {
      pushProblem(problems, `Environment entry ${i + 1} has a missing or invalid "key" (skipped).`);
      continue;
    }

    const rawVal = own(entry, 'value');
    if (rawVal === undefined || rawVal === null) {
      continue;
    }

    let strVal: string;
    if (typeof rawVal === 'string') {
      strVal = rawVal;
    } else if ((typeof rawVal === 'number' && Number.isFinite(rawVal)) || typeof rawVal === 'boolean') {
      strVal = String(rawVal);
    } else {
      pushProblem(problems, `Environment variable "${quoteFileText(key)}" has a non-text value (skipped).`);
      continue;
    }

    if (strVal !== '') {
      values.set(key, strVal);
    }
  }

  return { values, problems };
};

/**
 * CONTRACTS §21.1: merges URL variables in priority order `link` → `environment` → `collection`.
 * The first non-empty value wins; `sources` records where each value came from.
 */
export function mergeCollectionVars(
  link: Readonly<Record<string, string>>,
  environment: ReadonlyMap<string, string>,
  collection: ReadonlyMap<string, string>,
): CollectionVars {
  const values = new Map<string, string>();
  const sources = new Map<string, VariableSource>();

  if (link && typeof link === 'object') {
    for (const k of Object.keys(link)) {
      const v = Object.getOwnPropertyDescriptor(link, k)?.value as unknown;
      if (typeof v === 'string' && v !== '') {
        values.set(k, v);
        sources.set(k, 'link');
      }
    }
  }

  for (const [k, v] of environment) {
    if (!values.has(k) && typeof v === 'string' && v !== '') {
      values.set(k, v);
      sources.set(k, 'environment');
    }
  }

  for (const [k, v] of collection) {
    if (!values.has(k) && typeof v === 'string' && v !== '') {
      values.set(k, v);
      sources.set(k, 'collection');
    }
  }

  return { values, sources };
}
