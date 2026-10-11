/**
 * CONTRACTS §16.3 / §16.4: the gRPC schema service and the host-side helpers built on it. Pure Node (no vscode), so the
 * sidecar reuses it.
 *
 * - `createGrpcSchemaService`: discovers the app's generated Dart (src/grpc/discovery.ts), loads it with the codec's
 *   `loadGrpcSchema` (agent S, src/grpc/index.ts — injected, so this module never imports the parser), reloads
 *   debounced when a generated file or package_config.json changes (`fileChanged`, fed by the editor's file watcher,
 *   or the built-in recursive `fs.watch`), and exposes the current schema (`GrpcDeps`) to the controller and agents.
 *   Off (`enabled()` false) = no scan, no schema.
 * - `decodeGrpcMessages`: an exchange's `message` frames decoded with the schema (method from the URL path), else
 *   `protoc --decode_raw` style, else nothing; never throws.
 * - `grpcMockEncoder`: `grpcMock.messagesJson` → base64 `messages` for the proxy host (the rule's URL names the
 *   method; the response type encodes).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Exchange, GrpcProxyCodec } from '@flutter-intercept/proxy';
import { discoverGrpcFiles, isGrpcSchemaPath, nodeGrpcFs, type GrpcFs } from './discovery';
import type { GrpcCodec, GrpcMethod, GrpcSchema, RawField } from './types';

/** Canonical gRPC status code names (index = code). */
export const GRPC_CODE_NAMES = [
  'OK',
  'CANCELLED',
  'UNKNOWN',
  'INVALID_ARGUMENT',
  'DEADLINE_EXCEEDED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION',
  'ABORTED',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED',
  'INTERNAL',
  'UNAVAILABLE',
  'DATA_LOSS',
  'UNAUTHENTICATED',
] as const;
export type GrpcCodeName = (typeof GRPC_CODE_NAMES)[number];

/** `14` → `UNAVAILABLE`; other numbers → their decimal text. */
export function grpcCodeName(code: number | undefined): string | undefined {
  if (typeof code !== 'number' || !Number.isInteger(code)) return undefined;
  return GRPC_CODE_NAMES[code] ?? String(code);
}

/** What the controller, the agent API and the proxy host need of the gRPC schema. */
export interface GrpcDeps {
  readonly codec: GrpcCodec;
  /** Setting `flutterIntercept.grpc.enabled` (default true). */
  enabled(): boolean;
  /** The current schema (undefined: off, not loaded yet, or nothing found). */
  schema(): GrpcSchema | undefined;
  /** Counts and problems for `Status.grpc.schema` (undefined while off). */
  status(): GrpcSchemaStatus | undefined;
}

export interface GrpcSchemaStatus {
  methods: number;
  messages: number;
  /** Discovery + parse problems, ≤ 50. */
  problems: string[];
  files: number;
}

export interface GrpcSchemaService extends GrpcDeps {
  /** Scans now (coalesced with a scan in progress); resolves once the schema reflects the files. */
  load(): Promise<void>;
  /** The first load (started on demand). */
  ready(): Promise<void>;
  /** A file changed / was created / deleted: reloads (debounced) when it can affect the schema (or always, without a path). */
  fileChanged(path?: string): void;
  /** Workspace folders changed: re-watch and reload. */
  rootsChanged(): void;
  /** `flutterIntercept.grpc.enabled` changed: load or drop the schema. */
  enabledChanged(): void;
  /** Fires after every schema change (loaded, reloaded, dropped). */
  onDidChange(listener: () => void): { dispose(): void };
  dispose(): void;
}

/** Watches `roots` recursively and calls `onChange(absPath)`; returns its disposer. */
export type GrpcWatcher = (roots: string[], onChange: (path: string) => void) => { dispose(): void };

export interface GrpcSchemaServiceDeps {
  codec: GrpcCodec;
  /** Workspace folders / project roots (absolute). */
  roots(): string[];
  enabled?(): boolean;
  fs?: GrpcFs;
  /** File watching: default a recursive `fs.watch` per root (best effort); `false` = the caller feeds `fileChanged`. */
  watch?: GrpcWatcher | false;
  /** Debounce for reloads after changes (default 500 ms). */
  debounceMs?: number;
  log?(msg: string): void;
}

/** Best-effort recursive `fs.watch` (macOS, Windows, Linux on Node ≥ 20); failures are ignored. */
export const nodeGrpcWatcher: GrpcWatcher = (roots, onChange) => {
  const watchers: fs.FSWatcher[] = [];
  for (const root of roots) {
    try {
      const w = fs.watch(root, { recursive: true, persistent: false }, (_ev, file) => {
        if (typeof file === 'string' && file) onChange(path.join(root, file));
      });
      w.on('error', () => undefined);
      watchers.push(w);
    } catch {
      // not supported here: reloads happen on session start (load()) instead
    }
  }
  return {
    dispose: () => {
      for (const w of watchers.splice(0)) {
        try {
          w.close();
        } catch {
          // ignore
        }
      }
    },
  };
};

const MAX_STATUS_PROBLEMS = 50;

export function createGrpcSchemaService(deps: GrpcSchemaServiceDeps): GrpcSchemaService {
  const log = deps.log ?? (() => undefined);
  const enabled = () => {
    try {
      return deps.enabled?.() ?? true;
    } catch {
      return true;
    }
  };
  const gfs = deps.fs ?? nodeGrpcFs;
  const debounceMs = Math.max(0, deps.debounceMs ?? 500);
  const listeners = new Set<() => void>();
  let current: GrpcSchema | undefined;
  let status: GrpcSchemaStatus | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  let first: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: { dispose(): void } | undefined;
  let disposed = false;

  const fire = () => {
    for (const l of [...listeners]) {
      try {
        l();
      } catch (e) {
        log(`gRPC schema listener failed: ${(e as Error)?.message ?? String(e)}`);
      }
    }
  };

  const scanOnce = async (): Promise<void> => {
    if (!enabled()) {
      const had = current !== undefined || status !== undefined;
      current = undefined;
      status = undefined;
      if (had) fire();
      return;
    }
    const t0 = Date.now();
    const found = await discoverGrpcFiles(deps.roots(), gfs);
    if (disposed) return;
    let schema: GrpcSchema | undefined;
    const problems = [...found.problems];
    try {
      schema = found.files.length ? deps.codec.loadGrpcSchema(found.files) : undefined;
    } catch (e) {
      problems.push(`gRPC schema: the generated files could not be read (${(e as Error)?.message ?? String(e)})`.slice(0, 300));
    }
    if (!enabled()) return; // turned off meanwhile: the next pass drops it
    for (const p of schema?.problems ?? []) if (problems.length < MAX_STATUS_PROBLEMS) problems.push(String(p).slice(0, 300));
    current = schema && (schema.methods.length || schema.messages.length) ? schema : undefined;
    status = { methods: schema?.methods.length ?? 0, messages: schema?.messages.length ?? 0, problems: problems.slice(0, MAX_STATUS_PROBLEMS), files: found.files.length };
    log(`gRPC schema: ${status.methods} methods, ${status.messages} messages from ${status.files} generated files in ${Date.now() - t0} ms${problems.length ? ` (${problems.length} problems)` : ''}`);
    fire();
  };

  const load = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          try {
            await scanOnce();
          } catch (e) {
            log(`gRPC schema scan failed: ${(e as Error)?.message ?? String(e)}`);
          }
        } while (again && !disposed);
      } finally {
        running = undefined;
      }
    })();
    return running;
  };

  const schedule = () => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void load();
    }, debounceMs);
  };

  const rewatch = () => {
    watcher?.dispose();
    watcher = undefined;
    if (deps.watch === false || disposed || !enabled()) return;
    const w = deps.watch ?? nodeGrpcWatcher;
    try {
      watcher = w(deps.roots(), (p) => service.fileChanged(p));
    } catch (e) {
      log(`gRPC schema: watching for changes failed: ${(e as Error)?.message ?? String(e)}`);
    }
  };

  const service: GrpcSchemaService = {
    codec: deps.codec,
    enabled,
    schema: () => (enabled() ? current : undefined),
    status: () => (enabled() ? status : undefined),
    load,
    ready() {
      if (!first) {
        rewatch();
        first = load();
      }
      return first;
    },
    fileChanged(p?: string) {
      if (!enabled()) return;
      if (p !== undefined && !isGrpcSchemaPath(p)) return;
      schedule();
    },
    rootsChanged() {
      rewatch();
      schedule();
    },
    enabledChanged() {
      rewatch();
      void load();
    },
    onDidChange(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      watcher?.dispose();
      watcher = undefined;
      listeners.clear();
    },
  };
  return service;
}

/**
 * REVIEW-10 #4 backstop: every absolute path in `text` (POSIX `/…`, Windows `C:\…`, UNC `\\host\…`, `file://` URIs),
 * starting at the beginning or after whitespace / a quote / a bracket, replaced by `show(path)`.
 */
export function scrubAbsolutePaths(text: string, show: (absPath: string) => string, literals: readonly string[] = []): string {
  // A path to a .dart / .json file may contain spaces ("/Users/Ada Lovelace/app/x.pb.dart"): matched up to the
  // extension first; other paths end at whitespace or punctuation.
  const PATH = /(^|[\s"'`(\[{<=])(file:\/\/[^"'`()\]}<>\n]*?\.(?:dart|json)\b|file:\/\/[^\s"'`()\]}<>,;]+|\/[^"'`()\]}<>\n:]*?\.(?:dart|json)\b|\/[^\s"'`()\]}<>:,;]+|[A-Za-z]:[\\/][^"'`()\]}<>\n:]*?\.(?:dart|json)\b|[A-Za-z]:[\\/][^\s"'`()\]}<>:,;]+|\\\\[^\s"'`()\]}<>:,;]+)/g;
  let out = text.replace(PATH, (_m, pre: string, p: string) => {
    let abs = p;
    if (abs.startsWith('file://')) {
      try {
        abs = decodeURIComponent(new URL(abs).pathname);
      } catch {
        abs = abs.slice('file://'.length);
      }
    }
    return `${pre}${show(abs)}`;
  });
  // Last guard: known folders (project root, home) never survive, whatever text surrounds them.
  for (const lit of literals) if (lit && lit.length > 1) out = out.split(lit).join('…');
  return out;
}

// ------------------------------------------------------------------ methods and URLs

/** `/pkg.Service/Method` of a gRPC exchange URL (its path), or undefined. */
export function grpcMethodPath(url: string): string | undefined {
  let p: string;
  try {
    p = new URL(url).pathname;
  } catch {
    p = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').split(/[?#]/)[0];
  }
  const m = /^\/([A-Za-z_][A-Za-z0-9_.]*)\/([A-Za-z_][A-Za-z0-9_]*)$/.exec(p);
  return m ? `/${m[1]}/${m[2]}` : undefined;
}

/**
 * `/pkg.Service/Method` named by a rule URL glob (`https://host/pkg.Svc/Method`, `*\/pkg.Svc/Method`, optionally with a
 * trailing `*`), or undefined when the service or method part is a wildcard.
 */
export function grpcMethodFromGlob(glob: string): string | undefined {
  const g = glob.trim().replace(/\*+$/, '').split(/[?#]/)[0];
  const m = /\/([A-Za-z_][A-Za-z0-9_.]*)\/([A-Za-z_][A-Za-z0-9_]*)$/.exec(g);
  return m ? `/${m[1]}/${m[2]}` : undefined;
}

/** `pkg.Svc/Method`, `/pkg.Svc/Method` or `pkg.Svc.Method` → `/pkg.Svc/Method` (undefined when not a method name). */
export function normalizeMethodName(v: string): string | undefined {
  const s = v.trim();
  let m = /^\/?([A-Za-z_][A-Za-z0-9_.]*)\/([A-Za-z_][A-Za-z0-9_]*)$/.exec(s);
  if (m) return `/${m[1]}/${m[2]}`;
  m = /^([A-Za-z_][A-Za-z0-9_.]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(s);
  return m ? `/${m[1]}/${m[2]}` : undefined;
}

// ------------------------------------------------------------------ decoding an exchange's messages

/** Hex of the first `max` bytes. */
export function hexOf(bytes: Uint8Array, max = 4096): string {
  return Buffer.from(bytes.subarray(0, Math.min(bytes.length, max))).toString('hex');
}

/** A `decodeRaw` tree as JSON: `{ "1": "text", "2": { … }, "3": ["a", "b"] }` (repeated numbers become arrays). */
export function rawToJson(fields: readonly RawField[], depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const repeated = new Set<string>();
  for (const f of fields) {
    const key = String(f.number);
    const value: unknown = Array.isArray(f.value) ? (depth >= 32 ? '[…]' : rawToJson(f.value, depth + 1)) : f.value;
    if (repeated.has(key)) (out[key] as unknown[]).push(value);
    else if (Object.prototype.hasOwnProperty.call(out, key)) {
      out[key] = [out[key], value];
      repeated.add(key);
    } else out[key] = value;
  }
  return out;
}

export interface DecodedMessage {
  /** Index among the exchange's frames (all kinds). */
  frame: number;
  dir: 'send' | 'receive';
  at: number;
  /** Full decompressed size. */
  size: number;
  compressed?: true;
  /** Only the first 64 KB were recorded. */
  truncated?: true;
  /** Schema decode (proto3 JSON) or the raw field tree (`rawToJson`). */
  json?: unknown;
  via: 'schema' | 'raw' | 'none';
  /** The recorded bytes (absent when the frame had none). */
  bytes?: Uint8Array;
  error?: string;
}

export interface DecodedCall {
  path?: string;
  method?: GrpcMethod;
  messages: DecodedMessage[];
}

type Frame = NonNullable<Exchange['frames']>[number];

function frameBytes(f: Frame): Uint8Array | undefined {
  if (typeof f.base64 !== 'string') return undefined;
  try {
    return new Uint8Array(Buffer.from(f.base64, 'base64'));
  } catch {
    return undefined;
  }
}

/**
 * The `message` frames of a gRPC exchange (or of `frames` when given, e.g. the panel's trimmed list) decoded: with the
 * schema type of the call's method (request type for `send`, response type for `receive`), else raw, else nothing.
 * `filter` limits which frames are decoded (e.g. the first 20 each way); others are skipped. Never throws.
 */
export function decodeGrpcMessages(
  e: Pick<Exchange, 'url' | 'frames'>,
  grpc: Pick<GrpcDeps, 'codec' | 'schema'> | undefined,
  opts: { frames?: readonly Frame[]; filter?: (f: Frame, frameIndex: number) => boolean } = {},
): DecodedCall {
  const methodPath = grpcMethodPath(e.url);
  let schema: GrpcSchema | undefined;
  try {
    schema = grpc?.schema();
  } catch {
    schema = undefined;
  }
  let method: GrpcMethod | undefined;
  try {
    method = methodPath && schema ? schema.method(methodPath) : undefined;
  } catch {
    method = undefined;
  }
  const codec = grpc?.codec;
  const messages: DecodedMessage[] = [];
  const frames = opts.frames ?? e.frames ?? [];
  frames.forEach((f, i) => {
    if (f.kind !== 'message') return;
    if (opts.filter && !opts.filter(f, i)) return;
    const base: DecodedMessage = {
      frame: i,
      dir: f.dir,
      at: f.at,
      size: f.size,
      ...(f.compressed ? { compressed: true as const } : {}),
      ...(f.truncated ? { truncated: true as const } : {}),
      via: 'none',
    };
    const bytes = frameBytes(f);
    if (!bytes) {
      messages.push({ ...base, error: 'the message bytes were not recorded' });
      return;
    }
    base.bytes = bytes;
    if (!codec) {
      messages.push({ ...base, error: 'gRPC decoding is not available' });
      return;
    }
    const type = method ? (f.dir === 'send' ? method.requestType : method.responseType) : undefined;
    let schemaError: string | undefined;
    if (type && schema && !f.truncated) {
      try {
        const r = codec.decodeMessage(schema, type, bytes);
        if (r.error === undefined && r.json !== undefined) {
          messages.push({ ...base, via: 'schema', json: r.json });
          return;
        }
        schemaError = r.error ?? 'no result';
      } catch (err) {
        schemaError = (err as Error)?.message ?? String(err);
      }
    }
    try {
      const raw = codec.decodeRaw(bytes);
      if (raw.fields && raw.error === undefined) {
        messages.push({ ...base, via: 'raw', json: rawToJson(raw.fields), ...(schemaError ? { error: `as ${type}: ${schemaError}`.slice(0, 300) } : {}) });
        return;
      }
      messages.push({ ...base, error: (schemaError ? `as ${type}: ${schemaError}; raw: ${raw.error ?? 'no fields'}` : raw.error ?? 'not a protobuf message').slice(0, 300) });
    } catch (err) {
      messages.push({ ...base, error: String((err as Error)?.message ?? err).slice(0, 300) });
    }
  });
  return { ...(methodPath ? { path: methodPath } : {}), ...(method ? { method } : {}), messages };
}

// ------------------------------------------------------------------ CONTRACTS §17.3: the proxy's codec

/** The largest message the proxy's hooks hand to the codec (§17.1). */
export const MAX_CODEC_BYTES = 4 * 1024 * 1024;

/**
 * `InterceptProxy.setGrpcCodec`: decode / encode by method path and direction with the CURRENT schema (looked up on
 * every call, so schema reloads apply at once). `decode` never throws (undefined = unknown method, no schema, too
 * large, not decodable); `encode` throws an Error naming the JSON path.
 */
export function grpcProxyCodec(grpc: Pick<GrpcDeps, 'codec' | 'schema' | 'enabled'>): GrpcProxyCodec {
  const typeOf = (path: string, dir: 'send' | 'receive'): { schema: GrpcSchema; type: string } | undefined => {
    if (!grpc.enabled()) return undefined;
    const schema = grpc.schema();
    const m = schema?.method(path);
    return schema && m ? { schema, type: dir === 'send' ? m.requestType : m.responseType } : undefined;
  };
  return {
    decode(path, dir, bytes) {
      try {
        if (!(bytes instanceof Uint8Array) || bytes.length > MAX_CODEC_BYTES) return undefined;
        const t = typeOf(path, dir);
        if (!t) return undefined;
        const r = grpc.codec.decodeMessage(t.schema, t.type, bytes);
        return r.error === undefined ? r.json : undefined;
      } catch {
        return undefined;
      }
    },
    encode(path, dir, json) {
      const t = typeOf(path, dir);
      if (!t) throw new Error(`no schema for ${path}`);
      const bytes = grpc.codec.encodeMessage(t.schema, t.type, json);
      if (bytes.length > MAX_CODEC_BYTES) throw new Error('$: the encoded message is larger than 4 MB');
      return bytes;
    },
  };
}

// ------------------------------------------------------------------ grpcMock.messagesJson → messages

/** Encodes a `grpcMock.messagesJson` list for the rule whose match URL is `matchUrl`; throws a readable Error. */
export type GrpcMessageEncoder = (matchUrl: string, messagesJson: readonly unknown[]) => string[];

/**
 * The proxy host's encoder: the method comes from the rule's URL (`…/pkg.Service/Method`), each JSON message is encoded
 * as its response type with the current schema.
 */
export function grpcMockEncoder(grpc: Pick<GrpcDeps, 'codec' | 'schema' | 'enabled'>): GrpcMessageEncoder {
  return (matchUrl, list) => {
    if (!grpc.enabled()) throw new Error('gRPC support is off (setting flutterIntercept.grpc.enabled)');
    const methodPath = grpcMethodFromGlob(matchUrl);
    if (!methodPath) throw new Error(`its URL ${JSON.stringify(matchUrl.slice(0, 200))} doesn't name one gRPC method (…/package.Service/Method), so the message type is unknown`);
    const schema = grpc.schema();
    if (!schema) throw new Error("no protobuf schema was found in the app's generated *.pb.dart files");
    const method = schema.method(methodPath);
    if (!method) throw new Error(`the app's generated code has no method ${methodPath}`);
    return list.map((json, i) => {
      try {
        return Buffer.from(grpc.codec.encodeMessage(schema, method.responseType, json)).toString('base64');
      } catch (e) {
        throw new Error(`message ${i + 1} (${method.responseType}): ${(e as Error)?.message ?? String(e)}`);
      }
    });
  };
}
