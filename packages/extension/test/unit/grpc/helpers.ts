import * as fs from 'fs';
import * as path from 'path';
import { GrpcSchema, GrpcSourceFile, isGrpcGeneratedFile, ProtoEnum } from '../../../src/grpc';

export const FIX = path.join(__dirname, '..', '..', 'fixtures', 'grpc');
export const VERSIONS = ['v21', 'v22', 'v23', 'v24', 'v25'] as const;

/** Every generated file under a fixture directory, as the host would pass them. */
export function readGenerated(dir: string): GrpcSourceFile[] {
  const out: GrpcSourceFile[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (isGrpcGeneratedFile(p)) out.push({ path: p, text: fs.readFileSync(p, 'utf8') });
    }
  };
  walk(dir);
  return out;
}

export interface Vector {
  name: string;
  type: string;
  base64: string;
  /** Canonical proto3 JSON (python protobuf json_format) of the bytes. */
  json: unknown;
  /** The Dart runtime's toProto3Json() of the same bytes, when it could produce one. */
  dartJson?: unknown;
}

export const vectors: Vector[] = JSON.parse(fs.readFileSync(path.join(FIX, 'vectors.json'), 'utf8'));
export const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

/** Every `.proto` file under a directory (recursive). */
export function readProtos(dir: string): GrpcSourceFile[] {
  const out: GrpcSourceFile[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.proto')) out.push({ path: p, text: fs.readFileSync(p, 'utf8') });
    }
  };
  walk(dir);
  return out;
}

/** A schema without where it came from (file, line, source), for comparing Dart- and .proto-built schemas. */
export function schemaShape(s: GrpcSchema & { enums?: readonly ProtoEnum[] }) {
  const messages = [...s.messages]
    .map((m) => ({ name: m.name, dartClass: m.dartClass, fields: m.fields }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const methods = [...s.methods]
    .map(({ path: p, requestType, responseType, clientStreaming, serverStreaming }) => ({ p, requestType, responseType, clientStreaming, serverStreaming }))
    .sort((a, b) => a.p.localeCompare(b.p));
  const enums = [...(s.enums ?? [])].map((e) => ({ name: e.name, dartClass: e.dartClass, values: e.values })).sort((a, b) => a.name.localeCompare(b.name));
  return { messages, methods, enums };
}
