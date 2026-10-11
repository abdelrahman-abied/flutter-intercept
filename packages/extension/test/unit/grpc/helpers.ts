import * as fs from 'fs';
import * as path from 'path';
import { GrpcSourceFile, isGrpcGeneratedFile } from '../../../src/grpc';

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
