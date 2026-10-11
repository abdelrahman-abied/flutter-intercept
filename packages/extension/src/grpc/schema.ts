// CONTRACTS §16.3: links parsed protoc_plugin files into a GrpcSchema (Dart classes → fully-qualified proto
// names, import prefixes, package: URIs, well-known types). Pure; never throws; ≤ 50 plain-words problems.

import type {
  GrpcMethod,
  GrpcSchema,
  GrpcSourceFile,
  ProtoEnum,
  ProtoField,
  ProtoFieldType,
  ProtoMessage,
  ProtoScalar,
} from './types';
import { ParsedEnum, ParsedField, ParsedFile, ParsedMessage, parseGeneratedFile, TypeRef } from './parse';
import { isProtoFile, ParsedProto, parseProtoFile, ProtoTypeRef } from './proto';
import { builtinWellKnownTypes, WKT_FILES } from './wkt';

export { isProtoFile };

export const MAX_FILES = 5000;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_PROBLEMS = 50;

/** Files the schema reads: `*.pb.dart`, `*.pbenum.dart`, `*.pbgrpc.dart` (not `*.pbjson.dart` / `*.pbserver.dart`). */
export function isGrpcGeneratedFile(path: string): boolean {
  return /\.(pb|pbenum|pbgrpc)\.dart$/i.test(path);
}

const SCALAR_BY_SUFFIX: Record<string, ProtoScalar> = {
  B: 'bool',
  Y: 'bytes',
  S: 'string',
  D: 'double',
  F: 'float',
  '3': 'int32',
  '6': 'int64',
  S3: 'sint32',
  S6: 'sint64',
  U3: 'uint32',
  U6: 'uint64',
  F3: 'fixed32',
  F6: 'fixed64',
  SF3: 'sfixed32',
  SF6: 'sfixed64',
};

interface Code {
  label: 'O' | 'P' | 'K' | 'Q';
  kind: 'scalar' | 'enum' | 'message';
  scalar?: ProtoScalar;
}

/** `KU6` → packed repeated uint64; `OM` → optional message; `QE` → required enum; groups read as messages. */
function readCode(code: string): Code | undefined {
  const m = /^([OPKQ])(.+)$/.exec(code);
  if (!m) return undefined;
  const label = m[1] as Code['label'];
  const s = m[2];
  if (s === 'E') return { label, kind: 'enum' };
  if (s === 'M' || s === 'G') return { label, kind: 'message' };
  const scalar = Object.hasOwn(SCALAR_BY_SUFFIX, s) ? SCALAR_BY_SUFFIX[s] : undefined;
  return scalar ? { label, kind: 'scalar', scalar } : undefined;
}

const norm = (p: string) => p.replace(/\\/g, '/');

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

function joinPath(dir: string, rel: string): string {
  const parts = (dir ? `${dir}/${rel}` : rel).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '.' || (part === '' && out.length > 0)) continue;
    if (part === '..' && out.length && out[out.length - 1] !== '..' && out[out.length - 1] !== '') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** The host's display label, else the file name: problem texts never carry an absolute path (REVIEW-10 #4). */
const labelOf = (f: GrpcSourceFile, path: string) => (typeof f.label === 'string' && f.label ? f.label : basename(path));

/** An import URI as shown in a problem: relative / package: URIs as written, anything absolute by its file name. */
const showUri = (uri: string) => (/^(file:|\/|[A-Za-z]:[\\/])/.test(uri) ? basename(uri.replace(/\\/g, '/')) : uri);

const baseOf = (p: string) => p.replace(/\.(pb|pbenum|pbgrpc|pbjson|pbserver)\.dart$/i, '');

interface Decl {
  file: ParsedFile;
  kind: 'message' | 'enum';
  msg?: ParsedMessage;
  en?: ParsedEnum;
  fq: string;
}

class Schema implements GrpcSchema {
  readonly methods: GrpcMethod[] = [];
  readonly messages: ProtoMessage[] = [];
  readonly problems: string[] = [];
  readonly enums: ProtoEnum[] = [];
  private readonly methodByPath = new Map<string, GrpcMethod>();
  private readonly messageByName = new Map<string, ProtoMessage>();
  private readonly enumByName = new Map<string, ProtoEnum>();

  method(path: string): GrpcMethod | undefined {
    if (typeof path !== 'string') return undefined;
    let p = path.trim();
    const scheme = p.indexOf('://');
    if (scheme >= 0) {
      const slash = p.indexOf('/', scheme + 3);
      p = slash < 0 ? '/' : p.slice(slash);
    }
    p = p.replace(/[?#].*$/, '');
    if (!p.startsWith('/')) p = `/${p}`;
    return this.methodByPath.get(p);
  }

  message(name: string): ProtoMessage | undefined {
    return typeof name === 'string' ? this.messageByName.get(cleanName(name)) : undefined;
  }

  enumType(name: string): ProtoEnum | undefined {
    return typeof name === 'string' ? this.enumByName.get(cleanName(name)) : undefined;
  }

  addProblem(text: string): void {
    const p = capProblem(text);
    if (this.problems.length < MAX_PROBLEMS && !this.problems.includes(p)) this.problems.push(p);
  }

  addMessage(m: ProtoMessage): boolean {
    if (this.messageByName.has(m.name)) return false;
    this.messageByName.set(m.name, m);
    this.messages.push(m);
    return true;
  }

  addEnum(e: ProtoEnum): boolean {
    if (this.enumByName.has(e.name)) return false;
    this.enumByName.set(e.name, e);
    this.enums.push(e);
    return true;
  }

  addMethod(m: GrpcMethod): void {
    if (this.methodByPath.has(m.path)) return;
    this.methodByPath.set(m.path, m);
    this.methods.push(m);
  }
}

const MAX_PROBLEM_CHARS = 300;

/** Problem texts stay short (REVIEW-11): long names are elided in the middle, then the text is cut at 300 characters. */
export function capProblem(text: string): string {
  if (text.length <= MAX_PROBLEM_CHARS) return text;
  const elided = text.replace(/\S{61,}/g, (w) => `${w.slice(0, 28)}…${w.slice(-28)}`);
  return elided.length <= MAX_PROBLEM_CHARS ? elided : `${elided.slice(0, MAX_PROBLEM_CHARS - 1)}…`;
}

/** `.pkg.Msg` / `type.googleapis.com/pkg.Msg` → `pkg.Msg`. */
function cleanName(name: string): string {
  let n = name.trim();
  const slash = n.lastIndexOf('/');
  if (slash >= 0) n = n.slice(slash + 1);
  return n.startsWith('.') ? n.slice(1) : n;
}

/** Parses and links protoc_plugin output. Never throws. */
export function loadGrpcSchema(files: GrpcSourceFile[]): GrpcSchema {
  const schema = new Schema();
  try {
    link(schema, Array.isArray(files) ? files : []);
  } catch (e) {
    schema.addProblem(`couldn't build the gRPC schema (${(e as Error).message})`);
  }
  return schema;
}

function link(schema: Schema, input: GrpcSourceFile[]): void {
  // 1. parse, within the caps (generated Dart and .proto files share them)
  const parsed: ParsedFile[] = [];
  const protos: ParsedProto[] = [];
  let total = 0;
  let count = 0;
  for (const f of input) {
    if (!f || typeof f.path !== 'string' || typeof f.text !== 'string') continue;
    const isProto = isProtoFile(f.path);
    if (!isProto && !isGrpcGeneratedFile(f.path)) continue;
    if (++count > MAX_FILES) {
      schema.addProblem(`more than ${MAX_FILES} generated files; the rest were skipped`);
      break;
    }
    if (f.text.length > MAX_FILE_BYTES) {
      schema.addProblem(`${labelOf(f, norm(f.path))}: larger than 2 MB, skipped`);
      continue;
    }
    total += f.text.length;
    if (total > MAX_TOTAL_BYTES) {
      schema.addProblem('more than 50 MB of generated code; the rest was skipped');
      break;
    }
    const path = norm(f.path);
    if (isProto) {
      const pp = parseProtoFile(path, f.text, labelOf(f, path));
      pp.problems.forEach((x) => schema.addProblem(x));
      protos.push(pp);
      continue;
    }
    const p = parseGeneratedFile(path, f.text, labelOf(f, path));
    p.problems.forEach((x) => schema.addProblem(x));
    parsed.push(p);
  }

  // .proto declarations (first file wins for a name), by fully-qualified name and by Dart class.
  const protoKinds = new Map<string, 'message' | 'enum'>();
  const protoByDartClass = new Map<string, string | null>();
  for (const pp of protos) {
    for (const d of [...pp.messages, ...pp.enums]) {
      if (protoKinds.has(d.fq)) continue;
      protoKinds.set(d.fq, 'fields' in d ? 'message' : 'enum');
      protoByDartClass.set(d.dartClass, protoByDartClass.has(d.dartClass) ? null : d.fq);
    }
  }

  const byPath = new Map<string, ParsedFile>();
  for (const p of parsed) if (!byPath.has(p.path)) byPath.set(p.path, p);

  // 2. declarations: messages by their BuilderInfo name; enums named after their parent message.
  const declsByFile = new Map<ParsedFile, Map<string, Decl>>();
  const declsByClass = new Map<string, Decl[]>();
  const addDecl = (d: Decl) => {
    const cls = d.msg?.dartClass ?? d.en!.dartClass;
    let m = declsByFile.get(d.file);
    if (!m) declsByFile.set(d.file, (m = new Map()));
    if (!m.has(cls)) m.set(cls, d);
    const list = declsByClass.get(cls) ?? [];
    list.push(d);
    declsByClass.set(cls, list);
  };
  const messagesByBase = new Map<string, ParsedMessage[]>();
  for (const f of parsed) {
    for (const m of f.messages) {
      const fq = m.pkg ? `${m.pkg}.${m.relName}` : m.relName;
      addDecl({ file: f, kind: 'message', msg: m, fq });
      const b = baseOf(f.path);
      const list = messagesByBase.get(b);
      if (list) list.push(m);
      else messagesByBase.set(b, [m]);
    }
  }
  const packageByBase = (b: string): string | undefined => {
    const ms = messagesByBase.get(b);
    if (ms?.length) return ms[0].pkg;
    const grpc = byPath.get(`${b}.pbgrpc.dart`);
    const path = grpc?.serviceMethods[0]?.path ?? grpc?.clientMethods[0]?.path;
    if (path) {
      const svc = path.split('/')[1] ?? '';
      const dot = svc.lastIndexOf('.');
      return dot < 0 ? '' : svc.slice(0, dot);
    }
    return undefined;
  };
  // Sibling messages by Dart class, per base name (enum parents are found by prefix lookups, not a scan).
  const siblingClasses = new Map<string, Map<string, ParsedMessage>>();
  for (const [b, ms] of messagesByBase) {
    const m = new Map<string, ParsedMessage>();
    for (const x of ms) if (!m.has(x.dartClass)) m.set(x.dartClass, x);
    siblingClasses.set(b, m);
  }
  for (const f of parsed) {
    for (const en of f.enums) {
      const b = baseOf(f.path);
      const siblings = siblingClasses.get(b);
      let parent: ParsedMessage | undefined;
      // longest `Parent_` prefix of the enum's class that is a message of the same .proto
      for (let cut = en.dartClass.lastIndexOf('_'); siblings && cut > 0 && !parent; cut = en.dartClass.lastIndexOf('_', cut - 1)) {
        parent = siblings.get(en.dartClass.slice(0, cut));
      }
      let fq: string;
      if (parent) {
        const rest = en.dartClass.slice(parent.dartClass.length + 1).replace(/_+$/, '') || en.dartClass;
        fq = `${parent.pkg ? `${parent.pkg}.` : ''}${parent.relName}.${rest}`;
      } else {
        const pkg = packageByBase(b) ?? wktPackage(f.path);
        const bare = en.dartClass.replace(/_+$/, '') || en.dartClass;
        fq = pkg ? `${pkg}.${bare}` : bare;
      }
      addDecl({ file: f, kind: 'enum', en, fq });
    }
  }

  // 3. resolution of Dart references in a file's scope
  const packageUris = new Map<string, ParsedFile[]>();
  const resolveUri = (from: ParsedFile, uri: string): ParsedFile[] => {
    if (uri.startsWith('dart:')) return [];
    if (uri.startsWith('package:')) {
      const hit = packageUris.get(uri);
      if (hit) return hit;
      const found = resolvePackageUri(uri);
      packageUris.set(uri, found);
      return found;
    }
    const target = byPath.get(joinPath(dirname(from.path), uri));
    return target ? [target] : [];
  };
  /** `package:foo/x.pb.dart` → files ending in `/lib/x.pb.dart`, preferring a `foo` or `foo-1.2.3` root. */
  const resolvePackageUri = (uri: string): ParsedFile[] => {
    const rest = uri.slice('package:'.length);
    const slash = rest.indexOf('/');
    if (slash < 0) return [];
    const pkg = rest.slice(0, slash);
    const tail = `/lib/${rest.slice(slash + 1)}`;
    const hits = parsed.filter((p) => p.path.endsWith(tail) || p.path === tail.slice(1));
    const preferred = hits.filter((p) => {
      const seg = p.path.slice(0, p.path.length - tail.length).split('/').pop() ?? '';
      return seg === pkg || seg.startsWith(`${pkg}-`);
    });
    return preferred.length ? preferred : hits;
  };

  /** Classes visible through a file: its own plus what it exports (transitively, bounded). */
  const visible = (f: ParsedFile, cls: string, depth = 0): Decl | undefined => {
    const own = declsByFile.get(f)?.get(cls);
    if (own || depth > 4) return own;
    for (const e of f.exports) {
      for (const t of resolveUri(f, e)) {
        const d = visible(t, cls, depth + 1);
        if (d) return d;
      }
    }
    return undefined;
  };

  const unresolved = new Set<string>();
  const usedWkt = new Set<string>();
  const resolve = (from: ParsedFile, ref: TypeRef, where: string): { decl?: Decl; fq?: string } => {
    let uris: string[];
    if (ref.prefix) uris = from.imports.filter((i) => i.prefix === ref.prefix).map((i) => i.uri);
    else {
      const own = visible(from, ref.cls);
      if (own) return { decl: own };
      uris = from.imports.filter((i) => !i.prefix).map((i) => i.uri);
    }
    for (const uri of uris) {
      for (const t of resolveUri(from, uri)) {
        const d = visible(t, ref.cls);
        if (d) return { decl: d };
      }
    }
    // A well-known type whose generated file wasn't passed in: the built-in definition.
    for (const uri of uris) {
      const file = wktFileOf(uri) ?? '';
      if (Object.hasOwn(WKT_FILES, file) && WKT_FILES[file].includes(ref.cls)) {
        usedWkt.add(file);
        return { fq: `google.protobuf.${ref.cls}` };
      }
    }
    // Same class name declared once anywhere (a path we couldn't map, e.g. a renamed package root).
    const all = declsByClass.get(ref.cls) ?? [];
    if (all.length) {
      const sameDir = all.find((d) => dirname(d.file.path) === dirname(from.path));
      return { decl: sameDir ?? all[0] };
    }
    // A type only a .proto file defines (its generated Dart wasn't loaded).
    const fromProto = protoByDartClass.get(ref.cls);
    if (fromProto) return { fq: fromProto };
    const key = `${from.path}|${ref.prefix ?? ''}.${ref.cls}`;
    if (!unresolved.has(key)) {
      unresolved.add(key);
      const via = uris.length ? ` (from '${showUri(uris[0])}')` : '';
      schema.addProblem(`${from.label}: ${where} uses ${ref.cls}${via}, which isn't among the loaded generated files; its contents are shown raw`);
    }
    return { fq: ref.cls.replace(/_/g, '.') };
  };

  const typeOf = (from: ParsedFile, code: Code | undefined, ref: TypeRef | undefined, where: string): ProtoFieldType | undefined => {
    if (!code) return undefined;
    if (code.kind === 'scalar') return { kind: 'scalar', scalar: code.scalar! };
    if (!ref) {
      schema.addProblem(`${from.label}: ${where} has no ${code.kind} type`);
      return undefined;
    }
    const r = resolve(from, ref, where);
    const fq = r.decl?.fq ?? r.fq!;
    return code.kind === 'enum' ? { kind: 'enum', type: fq } : { kind: 'message', type: fq };
  };

  // 4. messages and enums
  for (const f of parsed) {
    for (const en of f.enums) {
      const d = declsByFile.get(f)?.get(en.dartClass);
      if (d) schema.addEnum({ name: d.fq, dartClass: en.dartClass, values: en.values, file: f.path });
    }
  }
  for (const f of parsed) {
    for (const m of f.messages) {
      const d = declsByFile.get(f)?.get(m.dartClass);
      if (!d || d.msg !== m) continue;
      const fields: ProtoField[] = [];
      for (const pf of m.fields) {
        const field = toField(f, m, pf, typeOf);
        if (field) fields.push(field);
        else schema.addProblem(`${f.label}: ${m.dartClass} field ${pf.number} (${pf.name}) has a type this version can't read`);
      }
      schema.addMessage({ name: d.fq, dartClass: m.dartClass, fields, file: f.path, line: m.line, source: 'pb.dart' });
    }
  }

  // 5. methods: the server base class knows streaming for sure; the client class fills in the rest.
  const methodFrom = (f: ParsedFile, m: { path: string; req?: TypeRef; res?: TypeRef; line: number }, cs: boolean, ss: boolean): GrpcMethod | undefined => {
    if (!m.req || !m.res) {
      schema.addProblem(`${f.label}: method ${m.path} has no request / response type`);
      return undefined;
    }
    const req = typeOf(f, { label: 'O', kind: 'message' }, m.req, `method ${m.path}`);
    const res = typeOf(f, { label: 'O', kind: 'message' }, m.res, `method ${m.path}`);
    if (req?.kind !== 'message' || res?.kind !== 'message') return undefined;
    return { path: m.path, requestType: req.type, responseType: res.type, clientStreaming: cs, serverStreaming: ss, file: f.path, line: m.line, source: 'pb.dart' };
  };
  const service = new Map<string, { f: ParsedFile; cs: boolean; ss: boolean }>();
  for (const f of parsed) for (const s of f.serviceMethods) if (!service.has(s.path)) service.set(s.path, { f, cs: s.clientStreaming, ss: s.serverStreaming });
  const fromClient = new Set<string>();
  for (const f of parsed) {
    for (const c of f.clientMethods) {
      const s = service.get(c.path);
      const m = methodFrom(f, c, s?.cs ?? c.clientStreaming ?? false, s?.ss ?? c.serverStreaming ?? false);
      if (m) {
        schema.addMethod(m);
        fromClient.add(c.path);
      }
    }
  }
  for (const f of parsed) {
    for (const s of f.serviceMethods) {
      if (fromClient.has(s.path)) continue;
      const m = methodFrom(f, s, s.clientStreaming, s.serverStreaming);
      if (m) schema.addMethod(m);
    }
  }

  // 6. .proto files: whatever the generated Dart didn't define (the Dart is what the app runs)
  const dartKinds = new Map<string, 'message' | 'enum'>();
  for (const m of declsByFile.values()) for (const d of m.values()) if (!dartKinds.has(d.fq)) dartKinds.set(d.fq, d.kind);
  const wktKinds = new Map<string, { kind: 'message' | 'enum'; file: string }>();
  for (const [file, classes] of Object.entries(WKT_FILES)) {
    for (const cls of classes) wktKinds.set(`google.protobuf.${cls}`, { kind: cls === 'NullValue' ? 'enum' : 'message', file });
  }
  const kindOf = (fq: string): 'message' | 'enum' | undefined => {
    const k = dartKinds.get(fq) ?? protoKinds.get(fq);
    if (k) return k;
    const w = wktKinds.get(fq);
    if (w) usedWkt.add(w.file);
    return w?.kind;
  };
  const unresolvedProto = new Set<string>();
  /** Linking shares each file's time budget with its parsing (REVIEW-11 #3). */
  class LinkBudget extends Error {}
  let linkDeadline = Infinity;
  let linkTicks = 0;
  const resolved = new Map<string, ProtoFieldType>();
  /** protoc's scoping: the innermost enclosing scope that has the name wins; `.a.B` is absolute. Memoized per (scope, name). */
  const resolveProto = (pp: ParsedProto, name: string, scope: string, where: string): ProtoFieldType => {
    if ((++linkTicks & 255) === 0 && Date.now() > linkDeadline) throw new LinkBudget();
    const memo = `${scope}\u0000${name}`;
    const hit = resolved.get(memo);
    if (hit) return hit;
    let found: ProtoFieldType | undefined;
    if (name.startsWith('.')) {
      const c = name.slice(1);
      const k = kindOf(c);
      if (k) found = k === 'enum' ? { kind: 'enum', type: c } : { kind: 'message', type: c };
    } else {
      for (let sc = scope; ; ) {
        const c = sc ? `${sc}.${name}` : name;
        const k = kindOf(c);
        if (k) {
          found = k === 'enum' ? { kind: 'enum', type: c } : { kind: 'message', type: c };
          break;
        }
        if (!sc) break;
        const dot = sc.lastIndexOf('.');
        sc = dot < 0 ? '' : sc.slice(0, dot);
      }
    }
    if (!found) {
      const bare = name.replace(/^\./, '');
      const key = `${pp.path}|${bare}`;
      if (!unresolvedProto.has(key)) {
        unresolvedProto.add(key);
        schema.addProblem(`${pp.label}: ${where} uses ${bare}, which isn't among the loaded files; its contents are shown raw`);
      }
      found = { kind: 'message', type: bare };
    }
    resolved.set(memo, found);
    return found;
  };
  const protoType = (pp: ParsedProto, t: ProtoTypeRef, scope: string, where: string): ProtoFieldType =>
    t.scalar ? { kind: 'scalar', scalar: t.scalar } : resolveProto(pp, t.name ?? '', scope, where);
  const packable = (t: ProtoFieldType) => t.kind === 'enum' || (t.kind === 'scalar' && t.scalar !== 'string' && t.scalar !== 'bytes');
  for (const pp of protos) {
    linkDeadline = pp.deadline ?? Infinity;
    const messages: ProtoMessage[] = [];
    const methods: GrpcMethod[] = [];
    try {
      for (const m of pp.messages) {
        if (dartKinds.has(m.fq) || schema.message(m.fq)) continue;
        const fields: ProtoField[] = [];
        const short = m.fq.slice(m.fq.lastIndexOf('.') + 1);
        for (const fd of m.fields) {
          const where = `${short}.${fd.name}`;
          let type: ProtoFieldType;
          if (fd.map) type = { kind: 'map', key: fd.map.key, value: protoType(pp, fd.map.value, m.fq, where) };
          else type = protoType(pp, fd.type, m.fq, where);
          const field: ProtoField = { number: fd.number, name: fd.name, type };
          if (fd.repeated) field.repeated = true;
          if (fd.repeated && packable(type) && (fd.packed ?? pp.packedByDefault)) field.packed = true;
          if (fd.oneof) field.oneof = fd.oneof;
          if (fd.required) field.required = true;
          fields.push(field);
        }
        messages.push({ name: m.fq, dartClass: m.dartClass, fields, file: pp.path, line: m.line, source: 'proto' });
      }
      for (const r of pp.methods) {
        if (schema.method(r.path)) continue;
        const where = `method ${r.path}`;
        const req = resolveProto(pp, r.req, pp.pkg, where);
        const res = resolveProto(pp, r.res, pp.pkg, where);
        if (req.kind !== 'message' || res.kind !== 'message') {
          schema.addProblem(`${pp.label}: ${where} uses an enum as its request or response`);
          continue;
        }
        methods.push({
          path: r.path,
          requestType: req.type,
          responseType: res.type,
          clientStreaming: r.clientStreaming,
          serverStreaming: r.serverStreaming,
          file: pp.path,
          line: r.line,
          source: 'proto',
        });
      }
    } catch (e) {
      if (!(e instanceof LinkBudget)) throw e;
      schema.addProblem(`${pp.label}: too complex to read`);
      continue;
    }
    for (const e of pp.enums) if (!dartKinds.has(e.fq)) schema.addEnum({ name: e.fq, dartClass: e.dartClass, values: e.values, file: pp.path });
    for (const m of messages) schema.addMessage(m);
    for (const m of methods) schema.addMethod(m);
  }

  // 7. well-known types referenced but not loaded
  // (an Any can carry any of them, so it brings them all)
  for (const wkt of builtinWellKnownTypes(usedWkt.has('any') ? undefined : usedWkt)) {
    if ('fields' in wkt) schema.addMessage(wkt);
    else schema.addEnum(wkt);
  }
}

function toField(
  f: ParsedFile,
  m: ParsedMessage,
  pf: ParsedField,
  typeOf: (from: ParsedFile, code: Code | undefined, ref: TypeRef | undefined, where: string) => ProtoFieldType | undefined,
): ProtoField | undefined {
  const where = `${m.dartClass}.${pf.name}`;
  if (pf.map) {
    const key = readCode(pf.map.keyCode);
    const value = typeOf(f, readCode(pf.map.valueCode), pf.map.valueRef, where);
    if (key?.kind !== 'scalar' || !value || value.kind === 'map') return undefined;
    return { number: pf.number, name: pf.name, type: { kind: 'map', key: key.scalar!, value } };
  }
  const code = readCode(pf.code ?? '');
  const type = typeOf(f, code, pf.ref, where);
  if (!code || !type) return undefined;
  const field: ProtoField = { number: pf.number, name: pf.name, type };
  if (code.label === 'P' || code.label === 'K') field.repeated = true;
  if (code.label === 'K') field.packed = true;
  if (code.label === 'Q') field.required = true;
  if (pf.oneof) field.oneof = pf.oneof;
  return field;
}

/** `package:protobuf/well_known_types/google/protobuf/timestamp.pb.dart` / `google/protobuf/timestamp.pb.dart` → `timestamp`. */
function wktFileOf(uri: string): string | undefined {
  const m = /(?:^|\/)google\/protobuf\/([a-z_]+)\.(?:pb|pbenum)\.dart$/.exec(uri);
  return m?.[1];
}

function wktPackage(path: string): string | undefined {
  return wktFileOf(path) ? 'google.protobuf' : undefined;
}
