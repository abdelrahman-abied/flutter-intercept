// REVIEW-13 #2 / #3 (host + agents): shared grpcMock headers / trailers gated like a mock's; metadata with a
// `constructor` / `__proto__` entry (or non-string values a parser merged in) never breaks get_request, redacted HAR or
// recordings.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Exchange, Rule } from '@flutter-intercept/proxy';
import { createAgentApi, type AgentApiDeps } from '../../src/agent/api';
import { buildHar } from '../../src/agent/har';
import { redactGrpcMetadata, redactHeaders } from '../../src/agent/redact';
import type { AppLauncher } from '../../src/agent/types';
import { createRecordingService } from '../../src/recordings/store';
import { approvalReasons } from '../../src/rules/policy';
import { fakeGrpc, grpcCall } from './grpc.fakes';

describe('#2 shared grpcMock headers / trailers need approval like a mock', () => {
  it('Set-Cookie and Access-Control-* in headers or trailers (also in sequence steps)', () => {
    const rule = (action: Record<string, unknown>) => ({ id: 'g', enabled: true, match: { url: '*' }, action }) as unknown as Rule;
    const headers = { 'set-cookie': 'session=attacker; Path=/', 'access-control-allow-origin': 'https://evil.example', 'access-control-allow-credentials': 'true' };
    const mock = approvalReasons(rule({ kind: 'mock', status: 200, headers, body: '' }));
    const grpc = approvalReasons(rule({ kind: 'grpcMock', messages: ['CgJoaQ=='], headers }));
    expect(grpc).toEqual(mock);
    expect(grpc).toHaveLength(3);
    expect(approvalReasons(rule({ kind: 'grpcMock', code: 14, trailers: { 'set-cookie': 'a=1' } })).join(' ')).toMatch(/sets a cookie .* as a gRPC trailer/);
    expect(approvalReasons(rule({ kind: 'sequence', steps: [{ action: { kind: 'grpcMock', headers: { 'set-cookie': 'a=1' } } }] }))[0]).toMatch(/^step 1 sets a cookie/);
    expect(approvalReasons(rule({ kind: 'grpcMock', headers: { 'x-a': '1' } }))).toEqual([]);
  });
});

/** Trailers as a buggy parser produced them: an inherited `constructor` merged into an array, an own `__proto__`. */
function hostileTrailers(): Record<string, string | string[]> {
  const t: Record<string, unknown> = { 'grpc-status': '0', 'x-region': 'eu' };
  Object.defineProperty(t, 'constructor', { value: [Object, 'boom'], enumerable: true, writable: true, configurable: true });
  Object.defineProperty(t, '__proto__', { value: 'x', enumerable: true, writable: true, configurable: true });
  t['x-bad'] = 42;
  return t as Record<string, string | string[]>;
}

describe('#3 hostile metadata', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });

  it('redaction keeps own string values only and never throws', () => {
    const t = hostileTrailers();
    const r = redactGrpcMetadata(t)!;
    expect(Object.keys(r).sort()).toEqual(['__proto__', 'constructor', 'grpc-status', 'x-region']);
    expect(r.constructor).toEqual(['boom']);
    expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
    expect(redactHeaders({ ...t })).toBeDefined();
  });

  it('get_request, redacted HAR and a recording save + load work', async () => {
    const call = grpcCall({ id: 'g', responseTrailers: hostileTrailers() });
    const host = Object.assign(new EventEmitter(), {
      running: true,
      port: 1,
      getExchanges: () => [call] as Exchange[],
      getRules: () => [],
      resume() {},
      abort() {},
    });
    const api = createAgentApi({
      host: host as unknown as AgentApiDeps['host'],
      applyRules: () => undefined,
      clear: () => undefined,
      getSettings: () => ({ access: 'readWrite', redactSecrets: true, interceptEnabled: true }),
      launcher: { launch: vi.fn(), stop: vi.fn(), hotRestart: vi.fn(), sessions: () => [] } as unknown as AppLauncher,
      projectRoot: () => '/ws/app',
      grpc: fakeGrpc(),
    });
    const d = (await api.call('get_request', { id: 'g' })) as Record<string, any>;
    expect(d.responseTrailers['x-region']).toBe('eu');
    const har = buildHar([call], { redact: true }) as any;
    expect(har.log.entries[0]._grpc.trailers).toContainEqual({ name: 'x-region', value: 'eu' });
    expect(har.log.entries[0]._grpc.trailers.every((x: { value: unknown }) => typeof x.value === 'string')).toBe(true);
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fi-r13-')));
    roots.push(root);
    const store = createRecordingService({ root: () => root, grpc: fakeGrpc() });
    for (const redact of [false, true]) {
      const meta = await store.save(`r${redact}`, [call], { redact });
      expect(meta.exchanges).toBe(1);
      const rec = await store.load(meta.id);
      expect(rec.entries[0].responseTrailers).toMatchObject({ 'x-region': 'eu' });
    }
  });
});
