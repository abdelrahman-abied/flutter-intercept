// CONTRACTS §19.4 / QUALITY-1 Q2: the shared module is node-free and the single source of the shared rules.
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  GRPC_CODE_NAMES,
  grpcCodeName,
  isLoopbackHostname,
  isThisMachine,
  mapTargetProblem,
  reservedGrpcMetadataProblem,
  SCRIPT_TEMPLATE,
  scriptTemplate,
  targetsProxy,
} from '../src/grpc-meta';
import { mentionsGrpcHooks } from '../src/script';
import { ruleProblem } from '../src/rules';

describe('grpc-meta (shared, node-free)', () => {
  it('imports nothing (the webview bundles it as is)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/grpc-meta.ts'), 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/require\(/);
  });

  it('every shared constant has one definition in the proxy', () => {
    const dir = path.join(__dirname, '../src');
    const names = ['GRPC_CODE_NAMES', 'GRPC_REWRITE_RESERVED', 'GRPC_TRAILER_RESERVED', 'MAX_SCRIPT_BYTES', 'MAX_SEQUENCE_STEPS', 'SCRIPT_TEMPLATE', 'GRPC_HOOK_CAP_BYTES', 'FRAME_PAYLOAD_CAP', 'MAX_REPLAY_GAP_MS', 'GRPC_SEND_MAX_MESSAGES'];
    for (const n of names) {
      const defs = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && new RegExp(`(export )?const ${n}\\b\\s*[:=]`).test(fs.readFileSync(path.join(dir, f), 'utf8')));
      expect([n, defs]).toEqual([n, ['grpc-meta.ts']]);
    }
  });

  it('code names, loopback, reserved metadata, map targets', () => {
    expect(GRPC_CODE_NAMES[14]).toBe('UNAVAILABLE');
    expect(grpcCodeName(16)).toBe('UNAUTHENTICATED');
    expect(grpcCodeName(42)).toBe('CODE 42');
    for (const h of ['localhost', 'a.localhost', '127.0.0.5', '[::1]', '::', '0.0.0.0', '::ffff:127.0.0.1', 'LOCALHOST.']) expect(isLoopbackHostname(h)).toBe(true);
    for (const h of ['example.com', '10.0.2.2', '128.0.0.1']) expect(isLoopbackHostname(h)).toBe(false);
    // IPv6 as the WHATWG URL parser writes it, full forms, IPv4-mapped / -compatible forms (H's gap)
    expect(new URL('http://[::ffff:127.0.0.1]/').hostname).toBe('[::ffff:7f00:1]');
    for (const h of ['[::ffff:7f00:1]', '::ffff:7f01:203', '0:0:0:0:0:ffff:7f00:1', '0000:0000:0000:0000:0000:0000:0000:0001', '[0:0:0:0:0:0:0:0]', '::ffff:0:0', '::ffff:0.0.0.0', '::127.0.0.1', '::7f00:1', '::1%lo0']) {
      expect([h, isLoopbackHostname(h)]).toEqual([h, true]);
    }
    for (const h of ['::ffff:a00:1', '::ffff:10.0.0.1', '2001:db8::1', 'fe80::1', '::2', '1::', ':::1', '::ffff:127.0.0.256']) {
      expect([h, isLoopbackHostname(h)]).toEqual([h, false]);
    }
    expect(targetsProxy('http://[::ffff:127.0.0.1]:8899/', [8899])).toBe(true);
    expect(targetsProxy('http://[0:0:0:0:0:0:0:1]:8899/', [8899])).toBe(true);
    expect(isThisMachine('[::ffff:7f00:1]')).toBe(true);
    expect(isThisMachine('10.0.2.2')).toBe(true);
    expect(reservedGrpcMetadataProblem('grpc-status', 'rewrite')).toMatch(/gRPC status/);
    expect(reservedGrpcMetadataProblem('grpc-status-details-bin', 'rewrite')).toBeDefined();
    expect(reservedGrpcMetadataProblem('content-type', 'rewrite')).toBeUndefined(); // HTTP rewrites may change it
    expect(reservedGrpcMetadataProblem('content-type', 'call')).toMatch(/belongs to the call/);
    expect(reservedGrpcMetadataProblem('te', 'trailers')).toBeDefined();
    expect(reservedGrpcMetadataProblem(':path', 'mock')).toMatch(/pseudo/);
    expect(reservedGrpcMetadataProblem('trailer', 'mock')).toMatch(/set by the proxy/);
    expect(reservedGrpcMetadataProblem('x-ok', 'mock')).toBeUndefined();
    expect(mapTargetProblem('https://staging.example.com/api')).toBeUndefined();
    for (const bad of ['ftp://x', 'https://u:p@x', 'https://x/#f', 'https://x/?q=1', 'https://x/a b', 'https://x\\y', '', 'nope']) expect(mapTargetProblem(bad)).toBeDefined();
    expect(mapTargetProblem('wss://x')).toMatch(/http/);
    expect(mapTargetProblem('wss://x', { allowWs: true })).toBeUndefined();
    expect(targetsProxy('http://10.0.2.2:8899', [8899])).toBe(true);
    expect(targetsProxy('http://example.com:8899', [8899])).toBe(false);
  });

  it('one script template: no-op until edited, gRPC hooks only in comments (no hook path)', () => {
    expect(SCRIPT_TEMPLATE).toBe(scriptTemplate());
    expect(scriptTemplate('Login */ x')).toMatch(/^\/\/ Flutter Intercept script for the rule "Login \* \/ x"\./);
    expect(mentionsGrpcHooks(SCRIPT_TEMPLATE)).toEqual({ message: false, status: false });
    expect(SCRIPT_TEMPLATE).toMatch(/onGrpcMessage/);
    expect(ruleProblem({ match: { url: '*' }, action: { kind: 'script', code: SCRIPT_TEMPLATE } })).toBeUndefined();
    expect(ruleProblem({ match: { url: '*' }, action: { kind: 'sequence', steps: Array.from({ length: 51 }, () => ({ action: { kind: 'passthrough' as const } })) } })).toMatch(/at most 50 steps/);
  });
});
