/**
 * Deterministic schema-to-body generator for OpenAPI 3.0 / 3.1 (CONTRACTS §21.4).
 * Pure: no vscode, no fs, no network.
 */
import { COLLECTION_LIMITS, type GenerateFromSchema } from './types';
import {
  addProblem,
  createWalkBudget,
  deref,
  dict,
  fitJsonString,
  hasOwn,
  indentStr,
  isObj,
  JsonWriter,
  setProp,
  sliceUtf8Bytes,
  touchNode,
  utf8Bytes,
  writeAnyJson,
  type Dict,
  type WalkBudget,
} from './ref';

const FORMAT_VALUES: Readonly<Record<string, string>> = {
  'date-time': '2026-01-01T00:00:00Z',
  date: '2026-01-01',
  time: '00:00:00Z',
  uuid: '00000000-0000-4000-8000-000000000000',
  email: 'user@example.com',
  uri: 'https://example.com',
  url: 'https://example.com',
  hostname: 'example.com',
  ipv4: '192.0.2.1',
  ipv6: '2001:db8::1',
  byte: 'AA==',
  binary: '',
};

interface GenCtx {
  root: unknown;
  budget: WalkBudget;
  problems: string[];
  visiting: Set<object>;
  writer: JsonWriter;
  rawStringAtRoot: boolean;
  reportedDepth: boolean;
  context?: string;
}

export interface GenerateInternalOptions {
  isJson?: boolean;
  budget?: WalkBudget;
  maxBytes?: number;
  context?: string;
}

/** Deterministic example body (JSON text) from an OpenAPI / JSON Schema (CONTRACTS §21.4). Never throws. */
export const generateFromSchema: GenerateFromSchema = (schema, root) => {
  const problems: string[] = [];
  const budget = createWalkBudget();
  const text = generateSchemaBody(schema, root, { isJson: true, budget, maxBytes: COLLECTION_LIMITS.generateBytes }, problems);
  return { text, problems };
};

/** Internal entry point shared with `openapi.ts` to share the document walk budget and non-JSON string rule (§21.3, §21.4). */
export function generateSchemaBody(
  schema: unknown,
  root: unknown,
  opts: GenerateInternalOptions,
  problems: string[],
): string {
  const isJson = opts.isJson ?? true;
  const budget = opts.budget ?? createWalkBudget();
  const maxBytes = opts.maxBytes ?? COLLECTION_LIMITS.generateBytes;
  const writer = new JsonWriter(maxBytes, budget, problems, opts.context);
  const ctx: GenCtx = {
    root,
    budget,
    problems,
    visiting: new Set(),
    writer,
    rawStringAtRoot: !isJson,
    reportedDepth: false,
    context: opts.context,
  };

  const ok = emitSchema(schema, 0, 0, false, false, ctx);
  if (!ok && writer.chunks.length === 0) {
    return isJson ? 'null' : '';
  }
  return writer.text();
}

function reportDepthExceeded(ctx: GenCtx): void {
  if (ctx.reportedDepth) return;
  ctx.reportedDepth = true;
  const prefix = ctx.context ? `${ctx.context}: ` : '';
  addProblem(ctx.problems, `${prefix}schema nesting exceeded depth limit (${COLLECTION_LIMITS.generateDepth})`);
}

function isSchemaNullable(s: unknown, root: unknown, seen: Set<object> = new Set(), depth = 0): boolean {
  if (depth > COLLECTION_LIMITS.generateDepth || !isObj(s) || seen.has(s)) return false;
  seen.add(s);
  if (s['nullable'] === true) return true;
  if (s['type'] === 'null') return true;
  if (Array.isArray(s['type']) && s['type'].includes('null')) return true;
  if (hasOwn(s, '$ref') && typeof s['$ref'] === 'string' && (s['$ref'] === '#' || s['$ref'].startsWith('#/'))) {
    const remaining = Math.max(0, COLLECTION_LIMITS.generateDepth - depth);
    const hit = deref(s, root, createWalkBudget(64), [], undefined, remaining);
    if (hit.ok && isObj(hit.value) && isSchemaNullable(hit.value, root, seen, depth + hit.hops)) return true;
  }
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const arr = s[key];
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (isSchemaNullable(item, root, seen, depth + 1)) return true;
      }
    }
  }
  return false;
}

function pickType(s: Dict): string | undefined {
  const t = s['type'];
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) {
    for (const entry of t) {
      if (typeof entry === 'string' && entry !== 'null') return entry;
    }
    if (t.includes('null')) return 'null';
    return undefined;
  }
  if (hasOwn(s, 'properties') && isObj(s['properties'])) return 'object';
  if (hasOwn(s, 'items') && s['items'] !== undefined) return 'array';
  return undefined;
}

function generateString(s: Dict): string {
  const fmt = typeof s['format'] === 'string' ? s['format'] : undefined;
  if (fmt && hasOwn(FORMAT_VALUES, fmt)) {
    return FORMAT_VALUES[fmt];
  }
  let out = 'string';
  const minRaw = s['minLength'];
  const maxRaw = s['maxLength'];
  const cap = COLLECTION_LIMITS.generateBytes + 1;
  const minLen = typeof minRaw === 'number' && Number.isFinite(minRaw) && minRaw >= 0 ? Math.floor(minRaw) : undefined;
  const maxLen = typeof maxRaw === 'number' && Number.isFinite(maxRaw) && maxRaw >= 0 ? Math.floor(maxRaw) : undefined;
  if (minLen !== undefined) {
    const target = Math.min(minLen, cap);
    if (out.length < target) {
      out = out.repeat(Math.ceil(target / out.length)).slice(0, target);
    }
  }
  if (maxLen !== undefined && out.length > maxLen) {
    out = out.slice(0, maxLen);
  }
  return out;
}

function generateNumber(s: Dict): number {
  const minRaw = s['minimum'];
  const exclMinRaw = s['exclusiveMinimum'];
  const maxRaw = s['maximum'];
  const exclMaxRaw = s['exclusiveMaximum'];

  let val = 0;
  if (typeof minRaw === 'number' && Number.isFinite(minRaw)) {
    val = exclMinRaw === true ? minRaw + 1 : minRaw;
    if (typeof exclMinRaw === 'number' && Number.isFinite(exclMinRaw)) {
      val = Math.max(val, exclMinRaw + 1);
    }
  } else if (typeof exclMinRaw === 'number' && Number.isFinite(exclMinRaw)) {
    val = exclMinRaw + 1;
  }

  if (typeof maxRaw === 'number' && Number.isFinite(maxRaw)) {
    const maxBound = exclMaxRaw === true ? maxRaw - 1 : maxRaw;
    if (val > maxBound) val = maxBound;
  }
  if (typeof exclMaxRaw === 'number' && Number.isFinite(exclMaxRaw) && val >= exclMaxRaw) {
    val = exclMaxRaw - 1;
  }

  return Object.is(val, -0) || !Number.isFinite(val) ? 0 : val;
}

function inferKind(s: unknown, root: unknown, seen: Set<object> = new Set(), depth = 0): string | undefined {
  if (depth > COLLECTION_LIMITS.generateDepth || !isObj(s) || seen.has(s)) return undefined;
  seen.add(s);
  if (hasOwn(s, '$ref') && typeof s['$ref'] === 'string' && (s['$ref'] === '#' || s['$ref'].startsWith('#/'))) {
    const remaining = Math.max(0, COLLECTION_LIMITS.generateDepth - depth);
    const hit = deref(s, root, createWalkBudget(64), [], undefined, remaining);
    if (hit.ok && isObj(hit.value)) return inferKind(hit.value, root, seen, depth + hit.hops);
  }
  const direct = pickType(s);
  if (direct) return direct;
  if (Array.isArray(s['allOf'])) {
    for (const m of s['allOf']) {
      const k = inferKind(m, root, seen, depth + 1);
      if (k === 'object' || k === 'array') return k;
    }
    for (const m of s['allOf']) {
      const k = inferKind(m, root, seen, depth + 1);
      if (k) return k;
    }
  }
  for (const key of ['oneOf', 'anyOf'] as const) {
    if (Array.isArray(s[key]) && s[key].length > 0) {
      return inferKind(s[key][0], root, seen, depth + 1);
    }
  }
  return undefined;
}

function emitRawOrJsonValue(val: unknown, jsonDepth: number, ctx: GenCtx): boolean {
  if (jsonDepth === 0 && ctx.rawStringAtRoot && typeof val === 'string') {
    const b = utf8Bytes(val);
    if (b > ctx.writer.maxBytes) {
      ctx.writer.markCut();
      ctx.writer.pushRaw(sliceUtf8Bytes(val, ctx.writer.maxBytes));
      return true;
    }
    ctx.writer.pushRaw(val);
    return true;
  }
  return writeAnyJson(val, jsonDepth, ctx.writer, new Set());
}

function emitLiteral(lit: string, ctx: GenCtx): boolean {
  const b = utf8Bytes(lit);
  if (!ctx.writer.canFit(b)) {
    ctx.writer.markCut();
    return false;
  }
  ctx.writer.pushRaw(lit);
  return true;
}

function emitStringScalar(str: string, jsonDepth: number, ctx: GenCtx): boolean {
  if (jsonDepth === 0 && ctx.rawStringAtRoot) {
    const b = utf8Bytes(str);
    if (b > ctx.writer.maxBytes) {
      ctx.writer.markCut();
      ctx.writer.pushRaw(sliceUtf8Bytes(str, ctx.writer.maxBytes));
      return true;
    }
    ctx.writer.pushRaw(str);
    return true;
  }
  const json = JSON.stringify(str);
  const b = utf8Bytes(json);
  if (!ctx.writer.canFit(b)) {
    if (jsonDepth === 0) {
      ctx.writer.markCut();
      ctx.writer.pushRaw(fitJsonString(str, ctx.writer.maxBytes));
      return true;
    }
    ctx.writer.markCut();
    return false;
  }
  ctx.writer.pushRaw(json);
  return true;
}

function emitCycleFallback(s: Dict, jsonDepth: number, isOptional: boolean, nullable: boolean, ctx: GenCtx): boolean {
  if (isOptional || nullable) {
    return emitLiteral('null', ctx);
  }
  const kind = inferKind(s, ctx.root);
  if (kind === 'object') return emitLiteral('{}', ctx);
  if (kind === 'array') return emitLiteral('[]', ctx);
  if (kind === 'string') return emitStringScalar(generateString(s), jsonDepth, ctx);
  if (kind === 'integer' || kind === 'number') return emitLiteral(String(generateNumber(s)), ctx);
  if (kind === 'boolean') return emitLiteral('true', ctx);
  return emitLiteral('null', ctx);
}

interface MergedAllOf {
  schema: Dict;
  tracked: object[];
  maxDepth: number;
}

function mergeAllOf(
  s: Dict,
  schemaDepth: number,
  ctx: GenCtx,
  seenMerge: Set<object>,
): MergedAllOf {
  const merged = dict();
  const mergedProps = dict();
  const requiredSet = new Set<string>();
  const tracked: object[] = [];
  let hasProps = false;
  let maxDepth = schemaDepth;

  const applyOne = (member: unknown, depth: number): void => {
    if (!touchNode(ctx.budget, ctx.problems, ctx.context)) return;
    if (depth > COLLECTION_LIMITS.generateDepth) {
      reportDepthExceeded(ctx);
      return;
    }
    if (depth > maxDepth) maxDepth = depth;
    const remainingHops = Math.max(0, COLLECTION_LIMITS.generateDepth - depth);
    const res = deref(member, ctx.root, ctx.budget, ctx.problems, ctx.context, remainingHops);
    if (!res.ok || !isObj(res.value)) return;
    const m = res.value;
    const nextDepth = depth + res.hops;
    if (nextDepth > maxDepth) maxDepth = nextDepth;

    const marker = res.targetObj ?? (isObj(member) ? member : undefined);
    if (marker) {
      if (ctx.visiting.has(marker) || seenMerge.has(marker)) return;
      seenMerge.add(marker);
      tracked.push(marker);
    }

    if (Array.isArray(m['allOf']) && m['allOf'].length > 0) {
      if (nextDepth >= COLLECTION_LIMITS.generateDepth) {
        reportDepthExceeded(ctx);
        return;
      }
      const sub = mergeAllOf(m, nextDepth, ctx, seenMerge);
      tracked.push(...sub.tracked);
      if (sub.maxDepth > maxDepth) maxDepth = sub.maxDepth;
      applyMergedFields(sub.schema);
      return;
    }

    if (Array.isArray(m['oneOf']) && m['oneOf'].length > 0 && !hasOwn(m, 'properties') && !hasOwn(m, 'type')) {
      applyOne(m['oneOf'][0], nextDepth + 1);
      return;
    }
    if (Array.isArray(m['anyOf']) && m['anyOf'].length > 0 && !hasOwn(m, 'properties') && !hasOwn(m, 'type')) {
      applyOne(m['anyOf'][0], nextDepth + 1);
      return;
    }

    applyMergedFields(m);
  };

  const applyMergedFields = (m: Dict): void => {
    if (isObj(m['properties'])) {
      hasProps = true;
      for (const k of Object.keys(m['properties'])) {
        setProp(mergedProps, k, m['properties'][k]);
      }
    }
    if (Array.isArray(m['required'])) {
      for (const r of m['required']) {
        if (typeof r === 'string') requiredSet.add(r);
      }
    }
    for (const k of Object.keys(m)) {
      if (k === 'allOf' || k === 'properties' || k === 'required' || k === '$ref') continue;
      setProp(merged, k, m[k]);
    }
  };

  const list = s['allOf'];
  if (Array.isArray(list)) {
    for (const member of list) {
      if (ctx.budget.exceeded) break;
      applyOne(member, schemaDepth + 1);
    }
  }
  applyMergedFields(s);

  if (hasProps) setProp(merged, 'properties', mergedProps);
  if (requiredSet.size > 0) setProp(merged, 'required', [...requiredSet]);
  return { schema: merged, tracked, maxDepth };
}

function getExplicitExample(s: Dict): { found: boolean; value: unknown } {
  if (hasOwn(s, 'example') && s['example'] !== undefined) return { found: true, value: s['example'] };
  if (Array.isArray(s['examples']) && s['examples'].length > 0 && s['examples'][0] !== undefined) {
    return { found: true, value: s['examples'][0] };
  }
  if (hasOwn(s, 'default') && s['default'] !== undefined) return { found: true, value: s['default'] };
  if (hasOwn(s, 'const') && s['const'] !== undefined) return { found: true, value: s['const'] };
  if (Array.isArray(s['enum']) && s['enum'].length > 0 && s['enum'][0] !== undefined) {
    return { found: true, value: s['enum'][0] };
  }
  return { found: false, value: undefined };
}

function isPropertyWriteOnly(rawProp: unknown, propDepth: number, ctx: GenCtx): boolean {
  if (isObj(rawProp) && rawProp['writeOnly'] === true) return true;
  if (isObj(rawProp) && hasOwn(rawProp, '$ref')) {
    const remaining = Math.max(0, COLLECTION_LIMITS.generateDepth - propDepth);
    const res = deref(rawProp, ctx.root, ctx.budget, ctx.problems, ctx.context, remaining);
    if (!res.ok) return true; // Broken, remote, or over-deep $ref: skip property after recording problem.
    if (isObj(res.value) && res.value['writeOnly'] === true) return true;
  }
  return false;
}

function emitSchema(
  rawSchema: unknown,
  jsonDepth: number,
  schemaDepth: number,
  isOptional: boolean,
  parentNullable: boolean,
  ctx: GenCtx,
): boolean {
  if (ctx.writer.stopped) return false;
  if (!touchNode(ctx.budget, ctx.problems, ctx.context)) return false;

  if (schemaDepth > COLLECTION_LIMITS.generateDepth) {
    reportDepthExceeded(ctx);
    return emitLiteral('null', ctx);
  }

  if (typeof rawSchema === 'boolean') {
    return emitLiteral('null', ctx);
  }
  if (!isObj(rawSchema)) {
    const prefix = ctx.context ? `${ctx.context}: ` : '';
    addProblem(ctx.problems, `${prefix}schema must be an object (used null)`);
    return emitLiteral('null', ctx);
  }

  const remainingHops = Math.max(0, COLLECTION_LIMITS.generateDepth - schemaDepth);
  const d = deref(rawSchema, ctx.root, ctx.budget, ctx.problems, ctx.context, remainingHops);
  if (!d.ok) {
    return false;
  }
  const s = d.value;
  const curDepth = schemaDepth + d.hops;

  if (typeof s === 'boolean') return emitLiteral('null', ctx);
  if (!isObj(s)) {
    const prefix = ctx.context ? `${ctx.context}: ` : '';
    addProblem(ctx.problems, `${prefix}resolved schema must be an object (used null)`);
    return emitLiteral('null', ctx);
  }

  const nullable =
    parentNullable ||
    isSchemaNullable(rawSchema, ctx.root, new Set(), schemaDepth) ||
    isSchemaNullable(s, ctx.root, new Set(), curDepth);

  // Cycle check against active schema ancestors (§21.4).
  const cycleHit =
    ctx.visiting.has(rawSchema) ||
    ctx.visiting.has(s) ||
    (d.targetObj !== undefined && ctx.visiting.has(d.targetObj));
  if (cycleHit) {
    return emitCycleFallback(s, jsonDepth, isOptional, nullable, ctx);
  }

  // Rule priority: example -> default -> const -> first enum (§21.4).
  const explicit = getExplicitExample(s);
  if (explicit.found) {
    return emitRawOrJsonValue(explicit.value, jsonDepth, ctx);
  }

  const addedTracks: object[] = [rawSchema, s];
  if (d.targetObj) addedTracks.push(d.targetObj);
  for (const obj of addedTracks) ctx.visiting.add(obj);

  try {
    // Composition: allOf, oneOf, anyOf (§21.4). Every step down counts toward depth <= 12.
    let effective = s;
    let effectiveDepth = curDepth;
    if (Array.isArray(s['allOf']) && s['allOf'].length > 0) {
      if (curDepth >= COLLECTION_LIMITS.generateDepth) {
        reportDepthExceeded(ctx);
        return emitLiteral('null', ctx);
      }
      const merged = mergeAllOf(s, curDepth, ctx, new Set(addedTracks));
      for (const t of merged.tracked) {
        if (!ctx.visiting.has(t)) {
          ctx.visiting.add(t);
          addedTracks.push(t);
        }
      }
      effective = merged.schema;
      effectiveDepth = merged.maxDepth;
      const mergedExplicit = getExplicitExample(effective);
      if (mergedExplicit.found) {
        return emitRawOrJsonValue(mergedExplicit.value, jsonDepth, ctx);
      }
    }

    if (Array.isArray(effective['oneOf']) && effective['oneOf'].length > 0) {
      if (effectiveDepth >= COLLECTION_LIMITS.generateDepth) {
        reportDepthExceeded(ctx);
        return emitLiteral('null', ctx);
      }
      return emitSchema(effective['oneOf'][0], jsonDepth, effectiveDepth + 1, isOptional, nullable, ctx);
    }
    if (Array.isArray(effective['anyOf']) && effective['anyOf'].length > 0) {
      if (effectiveDepth >= COLLECTION_LIMITS.generateDepth) {
        reportDepthExceeded(ctx);
        return emitLiteral('null', ctx);
      }
      return emitSchema(effective['anyOf'][0], jsonDepth, effectiveDepth + 1, isOptional, nullable, ctx);
    }

    const kind = pickType(effective);

    if (kind === 'string') {
      return emitStringScalar(generateString(effective), jsonDepth, ctx);
    }
    if (kind === 'integer' || kind === 'number') {
      return emitLiteral(String(generateNumber(effective)), ctx);
    }
    if (kind === 'boolean') {
      return emitLiteral('true', ctx);
    }
    if (kind === 'null' || !kind) {
      return emitLiteral('null', ctx);
    }

    if (kind === 'array') {
      const items = effective['items'];
      if (items === undefined || items === null || items === false) {
        return emitLiteral('[]', ctx);
      }
      if (effectiveDepth >= COLLECTION_LIMITS.generateDepth) {
        reportDepthExceeded(ctx);
        if (isOptional || nullable) return emitLiteral('null', ctx);
        return emitLiteral('[]', ctx);
      }
      return emitSchemaArray(effective, jsonDepth, effectiveDepth, ctx);
    }

    if (kind === 'object') {
      const props = isObj(effective['properties']) ? effective['properties'] : undefined;
      const hasNamedProps = props !== undefined && Object.keys(props).length > 0;
      const hasMapAdditional = !hasNamedProps && isObj(effective['additionalProperties']);
      if (!hasNamedProps && !hasMapAdditional) {
        return emitLiteral('{}', ctx);
      }
      if (effectiveDepth >= COLLECTION_LIMITS.generateDepth) {
        reportDepthExceeded(ctx);
        if (isOptional || nullable) return emitLiteral('null', ctx);
        return emitLiteral('{}', ctx);
      }
      return emitSchemaObject(effective, jsonDepth, effectiveDepth, ctx);
    }

    return emitLiteral('null', ctx);
  } finally {
    for (const obj of addedTracks) ctx.visiting.delete(obj);
  }
}

function emitSchemaArray(s: Dict, jsonDepth: number, schemaDepth: number, ctx: GenCtx): boolean {
  if (!ctx.writer.canFit(2)) {
    ctx.writer.markCut();
    return false;
  }
  const items = s['items'];
  if (items === undefined || items === null || items === false) {
    ctx.writer.pushRaw('[]');
    return true;
  }
  if (items !== true && !isObj(items)) {
    const prefix = ctx.context ? `${ctx.context}: ` : '';
    addProblem(ctx.problems, `${prefix}array "items" must be a schema object`);
    ctx.writer.pushRaw('[]');
    return true;
  }

  // Verify item $ref before repeating it so an external/broken/over-deep $ref produces one problem and [].
  if (isObj(items) && hasOwn(items, '$ref')) {
    const remaining = Math.max(0, COLLECTION_LIMITS.generateDepth - (schemaDepth + 1));
    const probe = deref(items, ctx.root, ctx.budget, ctx.problems, ctx.context, remaining);
    if (!probe.ok) {
      ctx.writer.pushRaw('[]');
      return true;
    }
  }

  const rawMin = s['minItems'];
  const minItems = typeof rawMin === 'number' && Number.isFinite(rawMin) && rawMin >= 0 ? Math.floor(rawMin) : 0;
  const count = Math.max(1, Math.min(minItems, 3));

  const outerCp = ctx.writer.checkpoint();
  ctx.writer.pushRaw('[');
  ctx.writer.reservedClosing += 1;
  let added = 0;

  for (let i = 0; i < count; i++) {
    const cp = ctx.writer.checkpoint();
    const prefix = added === 0 ? `\n${indentStr(jsonDepth + 1)}` : `,\n${indentStr(jsonDepth + 1)}`;
    const closingExtra = added === 0 ? 1 + jsonDepth * 2 : 0;
    ctx.writer.reservedClosing += closingExtra;
    const prefixBytes = utf8Bytes(prefix);
    if (!ctx.writer.canFit(prefixBytes)) {
      ctx.writer.rollback(cp);
      ctx.writer.markCut();
      break;
    }
    ctx.writer.pushRaw(prefix);
    const ok = emitSchema(items, jsonDepth + 1, schemaDepth + 1, false, false, ctx);
    if (!ok && ctx.writer.chunks.length === cp.len + 1) {
      ctx.writer.rollback(cp);
      break;
    }
    added += 1;
    if (ctx.writer.stopped) break;
  }

  if (added === 0) {
    ctx.writer.rollback(outerCp);
    if (!ctx.writer.canFit(2)) {
      ctx.writer.markCut();
      return false;
    }
    ctx.writer.pushRaw('[]');
    return true;
  }
  ctx.writer.reservedClosing -= 2 + jsonDepth * 2;
  ctx.writer.pushRaw(`\n${indentStr(jsonDepth)}]`);
  return true;
}

function emitSchemaObject(s: Dict, jsonDepth: number, schemaDepth: number, ctx: GenCtx): boolean {
  if (!ctx.writer.canFit(2)) {
    ctx.writer.markCut();
    return false;
  }

  const props = isObj(s['properties']) ? s['properties'] : undefined;
  const propKeys = props ? Object.keys(props) : [];
  const required = new Set<string>();
  if (Array.isArray(s['required'])) {
    for (const r of s['required']) {
      if (typeof r === 'string') required.add(r);
    }
  }

  const propEntries: [string, unknown, boolean][] = [];
  if (propKeys.length > 0 && props) {
    // Named properties present: ignore `additionalProperties` (§21.4).
    for (const key of propKeys) {
      if (ctx.budget.exceeded) break;
      const rawProp = props[key];
      if (isPropertyWriteOnly(rawProp, schemaDepth + 1, ctx)) continue;
      propEntries.push([key, rawProp, !required.has(key)]);
    }
  } else {
    // No named `properties` (a map): `additionalProperties` with a schema adds one entry `"key"` (§21.4).
    const addl = s['additionalProperties'];
    if (isObj(addl) && !isPropertyWriteOnly(addl, schemaDepth + 1, ctx)) {
      propEntries.push(['key', addl, false]);
    }
  }

  if (propEntries.length === 0) {
    ctx.writer.pushRaw('{}');
    return true;
  }

  const outerCp = ctx.writer.checkpoint();
  ctx.writer.pushRaw('{');
  ctx.writer.reservedClosing += 1;
  let added = 0;

  for (const [key, propSchema, isOpt] of propEntries) {
    const cp = ctx.writer.checkpoint();
    const keyPart = `${JSON.stringify(key)}: `;
    const prefix = added === 0 ? `\n${indentStr(jsonDepth + 1)}${keyPart}` : `,\n${indentStr(jsonDepth + 1)}${keyPart}`;
    const closingExtra = added === 0 ? 1 + jsonDepth * 2 : 0;
    ctx.writer.reservedClosing += closingExtra;
    const prefixBytes = utf8Bytes(prefix);
    if (!ctx.writer.canFit(prefixBytes)) {
      ctx.writer.rollback(cp);
      ctx.writer.markCut();
      break;
    }
    ctx.writer.pushRaw(prefix);
    const ok = emitSchema(propSchema, jsonDepth + 1, schemaDepth + 1, isOpt, false, ctx);
    if (!ok && ctx.writer.chunks.length === cp.len + 1) {
      ctx.writer.rollback(cp);
      break;
    }
    added += 1;
    if (ctx.writer.stopped) break;
  }

  if (added === 0) {
    ctx.writer.rollback(outerCp);
    if (!ctx.writer.canFit(2)) {
      ctx.writer.markCut();
      return false;
    }
    ctx.writer.pushRaw('{}');
    return true;
  }
  ctx.writer.reservedClosing -= 2 + jsonDepth * 2;
  ctx.writer.pushRaw(`\n${indentStr(jsonDepth)}}`);
  return true;
}
