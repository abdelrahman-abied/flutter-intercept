/**
 * Format detection for mock collections (CONTRACTS §21.1). Pure: no vscode, no fs, no network.
 */
import { redactUrl } from '../agent/redact';
import { isInsomniaDoc } from './insomnia';
import type { DetectFormat } from './types';

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
function quoteFileText(raw: string, max = 80): string {
  const cleaned = raw
    .replace(URL_IN_TEXT, (u) => redactUrl(u))
    .replace(BIDI_CONTROLS, '')
    .replace(/[\x00-\x1F\x7F]+/g, ' ')
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function formatProblem(msg: string): string {
  const cleaned = msg
    .replace(URL_IN_TEXT, (u) => redactUrl(u))
    .replace(BIDI_CONTROLS, '')
    .replace(/[\x00-\x1F\x7F]+/g, ' ')
    .trim();
  return cleaned.length > MAX_PROBLEM_CHARS ? `${cleaned.slice(0, MAX_PROBLEM_CHARS - 1)}…` : cleaned;
}

function isPostmanV2Schema(schema: string): boolean {
  const s = schema.trim();
  return /collection\/v2\.[01](?:\.\d+)*(?:\/|$)/i.test(s) || /^v?2\.[01](?:\.\d+)*$/i.test(s);
}

function isPostmanV1Schema(schema: string): boolean {
  const s = schema.trim();
  return /collection\/v1(?:\.\d+)*(?:\/|$)/i.test(s) || /^v?1(?:\.\d+)*$/i.test(s);
}

/** CONTRACTS §24.4: the `bruno.json` of a Bruno collection (the host reads the folder next to it). */
export function isBrunoJson(doc: unknown): boolean {
  return isObj(doc) && own(doc, 'type') === 'collection' && typeof own(doc, 'name') === 'string' && own(doc, 'item') === undefined && own(doc, 'info') === undefined;
}

/**
 * CONTRACTS §21.1 / §24.4: returns `postman`, `openapi`, `swagger` (2.0) or `insomnia` (v4 JSON export, v5 YAML), or
 * a readable one-line `problem` (Postman v1, environment files, unrecognised inputs). A Bruno collection is a folder:
 * the host knows it by its `bruno.json` (`isBrunoLinkFile`), never from here. Never throws.
 */
export const detectFormat: DetectFormat = (doc) => {
  if (!isObj(doc)) {
    return { problem: formatProblem('Collection file must be a JSON or YAML object.') };
  }

  const openapi = own(doc, 'openapi');
  if (openapi !== undefined) {
    if (typeof openapi !== 'string') {
      return { problem: formatProblem('OpenAPI "openapi" field must be a version string such as "3.0.3" or "3.1.0".') };
    }
    if (openapi.startsWith('3.')) {
      return { format: 'openapi' };
    }
    return { problem: formatProblem(`Unsupported OpenAPI version "${quoteFileText(openapi, 40)}" (expected 3.x).`) };
  }

  const swagger = own(doc, 'swagger');
  if (swagger !== undefined) {
    // CONTRACTS §24.4: Swagger 2.0
    if (typeof swagger === 'string' && swagger.startsWith('2.')) {
      return { format: 'swagger' };
    }
    if (swagger === 2) {
      return { format: 'swagger' }; // `swagger: 2.0` unquoted in YAML reads as the number 2
    }
    return { problem: formatProblem('Unsupported Swagger version (expected "2.0"): convert it to OpenAPI 3.') };
  }

  // CONTRACTS §24.4: an Insomnia v4 export (`_type: "export"`) or v5 file (`type: collection.insomnia.rest/5.0`)
  if (isInsomniaDoc(doc)) {
    return { format: 'insomnia' };
  }

  const info = own(doc, 'info');
  const item = own(doc, 'item');
  if (isObj(info)) {
    const schema = own(info, 'schema');
    if (typeof schema === 'string' && schema.trim() !== '') {
      if (isPostmanV2Schema(schema)) {
        return { format: 'postman' };
      }
      if (isPostmanV1Schema(schema)) {
        return { problem: formatProblem("Postman v1 collections aren't supported yet: export as Collection v2.1.") };
      }
      return { problem: formatProblem(`Unsupported collection schema "${quoteFileText(schema, 80)}".`) };
    }
    if (Array.isArray(item)) {
      return { format: 'postman' };
    }
  }

  const requests = own(doc, 'requests');
  if (Array.isArray(requests) && (typeof own(doc, 'name') === 'string' || typeof own(doc, 'id') === 'string' || Array.isArray(own(doc, 'order')))) {
    return { problem: formatProblem("Postman v1 collections aren't supported yet: export as Collection v2.1.") };
  }

  if (own(doc, '_postman_variable_scope') === 'environment' || Array.isArray(own(doc, 'values'))) {
    return { problem: formatProblem('This looks like a Postman environment file, not a collection.') };
  }

  if (isBrunoJson(doc)) {
    return { problem: formatProblem('This is the bruno.json of a Bruno collection: link the file named bruno.json itself (its folder is read).') };
  }

  return { problem: formatProblem('Unrecognised file format: expected a Postman Collection (v2.0/v2.1), an OpenAPI 3 or Swagger 2.0 document, an Insomnia export or a Bruno collection (bruno.json).') };
};
