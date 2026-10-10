/** Test doubles for the shared rules service (src/rules/**). */
import * as path from 'path';
import type { Rule } from '@flutter-intercept/proxy';
import type { RulesFs } from '../../src/rules/bodyFile';
import type { MementoLike } from '../../src/rules/core';

function enoent(p: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT' });
}

/** In-memory fs: files and directories by absolute path (parents created implicitly). */
export class FakeFs implements RulesFs {
  files = new Map<string, { data: Uint8Array; mtimeMs: number }>();
  dirs = new Set<string>(['/']);
  writes: string[] = [];
  renames: [string, string][] = [];
  private clock = 1;

  put(p: string, text: string | Uint8Array): void {
    this.mkdirp(path.dirname(p));
    this.files.set(p, { data: typeof text === 'string' ? new TextEncoder().encode(text) : text, mtimeMs: this.clock++ });
  }

  text(p: string): string | undefined {
    const f = this.files.get(p);
    return f ? new TextDecoder().decode(f.data) : undefined;
  }

  private mkdirp(dir: string): void {
    for (let d = dir; !this.dirs.has(d); d = path.dirname(d)) this.dirs.add(d);
  }

  async readFile(p: string): Promise<Uint8Array> {
    const f = this.files.get(p);
    if (!f) throw enoent(p);
    return f.data;
  }

  async writeFile(p: string, data: string): Promise<void> {
    if (!this.dirs.has(path.dirname(p))) throw enoent(p);
    this.writes.push(p);
    this.files.set(p, { data: new TextEncoder().encode(data), mtimeMs: this.clock++ });
  }

  async rename(from: string, to: string): Promise<void> {
    const f = this.files.get(from);
    if (!f) throw enoent(from);
    this.renames.push([from, to]);
    this.files.delete(from);
    this.files.set(to, f);
  }

  async unlink(p: string): Promise<void> {
    if (!this.files.delete(p)) throw enoent(p);
  }

  async mkdir(p: string): Promise<void> {
    this.mkdirp(p);
  }

  async stat(p: string) {
    const f = this.files.get(p);
    if (f) return { isFile: () => true, isDirectory: () => false, size: f.data.byteLength, mtimeMs: f.mtimeMs };
    if (this.dirs.has(p)) return { isFile: () => false, isDirectory: () => true, size: 0, mtimeMs: 0 };
    throw enoent(p);
  }

  async readdir(p: string) {
    if (!this.dirs.has(p)) throw enoent(p);
    const names = new Map<string, boolean>();
    for (const d of this.dirs) if (path.dirname(d) === p && d !== p) names.set(path.basename(d), true);
    for (const f of this.files.keys()) if (path.dirname(f) === p) names.set(path.basename(f), false);
    return [...names].map(([name, dir]) => ({ name, isDirectory: () => dir }));
  }

  realpathSync(p: string): string {
    if (this.files.has(p) || this.dirs.has(p)) return p;
    throw enoent(p);
  }
}

export class FakeMemento implements MementoLike {
  data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
}

const KINDS = new Set(['mock', 'block', 'breakpoint', 'throttle', 'fault', 'mutate', 'cors', 'sequence', 'mapRemote', 'rewrite', 'script']);

/** A small stand-in for the host's validateRule (same message shape: "<where>: <what>"). */
export function fakeValidateRule(raw: unknown, where = 'rule'): Rule {
  const fail = (what: string): never => {
    throw new Error(`${where}: ${what}`);
  };
  const r = raw as Record<string, any>;
  if (!r || typeof r !== 'object') fail('must be an object');
  for (const k of Object.keys(r)) if (!['id', 'enabled', 'name', 'match', 'action', 'times', 'expiresAt', 'used'].includes(k)) fail(`unknown field "${k}"`);
  if (typeof r.id !== 'string' || !r.id || r.id.length > 200) fail('id must be a non-empty string');
  if (typeof r.enabled !== 'boolean') fail('enabled must be a boolean');
  if (!r.match || typeof r.match.url !== 'string' || !r.match.url) fail('match is required (a rule without match would match everything)');
  if (!r.action || !KINDS.has(r.action.kind)) fail(`action: unknown kind ${JSON.stringify(r.action?.kind)}`);
  if (r.action.kind === 'mock' && (typeof r.action.status !== 'number' || typeof r.action.body !== 'string')) fail('action: status and body are required');
  if (r.action.kind === 'script' && typeof r.action.code !== 'string') fail('action: code is required');
  return r as Rule;
}

export const ROOT = '/ws/app';
export const FILE = `${ROOT}/.vscode/flutter-intercept.json`;

export function mock(id: string, extra: Partial<Rule> & { body?: string; bodyFile?: string; headers?: Record<string, string> } = {}): Rule {
  const { body = '{}', bodyFile, headers, ...rest } = extra;
  return {
    id,
    enabled: true,
    match: { url: `https://api.example.com/${id}` },
    action: { kind: 'mock', status: 200, body, ...(bodyFile ? { bodyFile } : {}), ...(headers ? { headers } : {}) },
    ...rest,
  } as Rule;
}

export function script(id: string, extra: Partial<Rule> & { code?: string; file?: string } = {}): Rule {
  const { code = '', file, ...rest } = extra;
  return {
    id,
    enabled: true,
    match: { url: `https://api.example.com/${id}` },
    action: { kind: 'script', code, ...(file ? { file } : {}) },
    ...rest,
  } as Rule;
}
