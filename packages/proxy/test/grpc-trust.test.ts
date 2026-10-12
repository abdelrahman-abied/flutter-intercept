// v0.13.0 (CONTRACTS §19.3 "Decryption"): decrypt every TLS silent gRPC tunnel while a simulator trusts our CA, and
// learn hosts that pin their own certificate (passed through undecrypted from then on).
import { once } from 'events';
import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as tls from 'tls';
import { X509Certificate } from 'crypto';
import { generateCACertificate } from 'mockttp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Exchange, InterceptProxy } from '../src';
import { nextExchange, selfSignedCert, sleep, startProxy } from './helpers';
import { grpcPinTesting } from '../src/intercept-proxy';
import { grpcCall, silentSocket, startGrpcServer, tlsSession, type GrpcServer } from './grpc-helpers';

function waitFor(proxy: InterceptProxy, pred: (e: Exchange) => boolean, timeoutMs = 10_000): Promise<Exchange> {
  const have = [...proxy.getExchanges()].reverse().find(pred);
  return have ? Promise.resolve(have) : nextExchange(proxy, pred, timeoutMs);
}

/** The Dart fixture, compiled once (skipped without a Dart SDK). */
const dartDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-dart-tls-'));
const dartClient = path.join(dartDir, process.platform === 'win32' ? 'client.exe' : 'client');
const haveDartClient = (() => {
  try {
    execFileSync('dart', ['compile', 'exe', path.join(__dirname, 'fixtures', 'tls_reject_client.dart'), '-o', dartClient], { stdio: 'ignore', timeout: 120_000 });
    return true;
  } catch {
    return false;
  }
})();

let up: GrpcServer;
let upCert: { key: string; cert: string };
let ca: { key: string; cert: string };
beforeAll(async () => {
  upCert = await selfSignedCert();
  up = await startGrpcServer({ tls: upCert });
  const c = await generateCACertificate();
  ca = { key: c.key, cert: c.cert };
});
afterAll(async () => {
  await up.close();
});

describe('grpcDecryptAll', () => {
  it('decrypts every TLS silent tunnel (the option and the setter), except tlsPassthrough hosts', async () => {
    const proxy = await startProxy({ ca, grpcDecryptAll: true });
    try {
      expect(proxy.grpcDecryptAll).toBe(true);
      const target = `127.0.0.1:${up.port}`;
      const { session } = await tlsSession(proxy.port, target, { ca: ca.cert });
      expect((await grpcCall(session, '/t.Echo/Unary', ['all'])).messages.map(String)).toEqual(['echo:all']);
      session.destroy();
      expect(await waitFor(proxy, (e) => e.kind === 'grpc' && e.state === 'completed')).toMatchObject({ url: `https://${target}/t.Echo/Unary` });
      proxy.setTlsPassthrough(['127.0.0.1']);
      const p = await tlsSession(proxy.port, target);
      expect(p.socket.getPeerCertificate().fingerprint256).toBe(new X509Certificate(upCert.cert).fingerprint256);
      p.session.destroy();
      proxy.setTlsPassthrough([]);
      proxy.setGrpcDecryptAll(false);
      const off = await tlsSession(proxy.port, target);
      expect(off.socket.getPeerCertificate().fingerprint256).toBe(new X509Certificate(upCert.cert).fingerprint256);
      off.session.destroy();
    } finally {
      await proxy.stop();
    }
  });

  /** A Dart client (dart:io / BoringSSL, like the app) that doesn't trust our CA: it rejects our certificate. */
  async function rejectingClient(proxyPort: number, target: string): Promise<void> {
    const out = await new Promise<string>((resolve) =>
      execFile(dartClient, [String(proxyPort), target], { timeout: 15_000 }, (_e, stdout) => resolve(String(stdout).trim())),
    );
    expect(out).toBe('rejected');
  }

  /** A client that just drops the connection mid-handshake. */
  async function droppingClient(proxyPort: number, target: string): Promise<void> {
    const sock = await silentSocket(proxyPort, target);
    const t = tls.connect({ socket: sock, servername: 'localhost', ALPNProtocols: ['grpc-exp', 'h2'], ca: upCert.cert });
    await new Promise<void>((resolve) => t.once('error', () => resolve()));
  }

  const pinnedNote = (e: Exchange) => /pins its certificate; passed through undecrypted from now on/.test(e.error ?? '');
  const notes = (proxy: InterceptProxy) => proxy.getExchanges().map((e) => e.error ?? '');

  it.skipIf(!haveDartClient)('dart:io rejecting our certificate (no alert, an early close) pins on the second time; then passthrough (noted)', async () => {
    const proxy = await startProxy({ ca });
    try {
      proxy.setGrpcDecryptAll(true);
      const target = `127.0.0.1:${up.port}`;
      await rejectingClient(proxy.port, target);
      await waitFor(proxy, (e) => /If it happens again within a minute/.test(e.error ?? ''));
      expect(proxy.grpcPinnedHosts).toEqual([]);
      await rejectingClient(proxy.port, target);
      const learned = await waitFor(proxy, (e) => e.kind === 'tunnel' && pinnedNote(e));
      expect(learned.error).toMatch(/^127\.0\.0\.1 pins its certificate/);
      expect(proxy.grpcPinnedHosts).toEqual([target]);
      const again = await silentSocket(proxy.port, target);
      const t = tls.connect({ socket: again, servername: 'localhost', ALPNProtocols: ['h2'], ca: upCert.cert });
      await once(t, 'secureConnect');
      t.destroy();
      const tunnel = await waitFor(proxy, (e) => e.kind === 'tunnel' && e.state !== 'pending' && /passed through undecrypted\.$/.test(e.error ?? ''));
      expect(tunnel.error).toMatch(/127\.0\.0\.1 pins its certificate; passed through undecrypted\./);
      // clearGrpcPinnedHosts, and decrypt-all turned on again, start over
      proxy.clearGrpcPinnedHosts();
      expect(proxy.grpcPinnedHosts).toEqual([]);
      (proxy as unknown as { pinnedHosts: Map<string, number> }).pinnedHosts.set(target, Date.now() + 60_000);
      proxy.setGrpcDecryptAll(false);
      proxy.setGrpcDecryptAll(true);
      expect(proxy.grpcPinnedHosts).toEqual([]);
    } finally {
      await proxy.stop();
    }
    expect(proxy.grpcPinnedHosts).toEqual([]); // forgotten when the proxy stops
  }, 60_000);

  it('one dropped / reset handshake never pins; a TLS alert (cert-rejected) pins at once', async () => {
    const proxy = await startProxy({ ca });
    try {
      proxy.setGrpcDecryptAll(true);
      const target = `127.0.0.1:${up.port}`;
      await droppingClient(proxy.port, target);
      await waitFor(proxy, (e) => e.kind === 'tunnel' && /If it happens again within a minute/.test(e.error ?? ''));
      expect(proxy.grpcPinnedHosts).toEqual([]);
      // A client that sends a TLS alert (OpenSSL / browsers): the failure event mockttp reports, for a tunnel in its handshake.
      const p = proxy as unknown as { decrypting: Map<string, { host: string; port: number }>; onTlsError(f: unknown): void };
      p.decrypting.set('127.0.0.1:40001', { host: 'api.example.test', port: 443 });
      p.onTlsError({ failureCause: 'cert-rejected', remoteIpAddress: '127.0.0.1', remotePort: 40001, timingEvents: {} });
      expect(proxy.grpcPinnedHosts).toEqual(['api.example.test:443']);
      // other failures (no shared cipher, a handshake timeout) are never pins
      p.decrypting.set('127.0.0.1:40002', { host: 'other.example.test', port: 443 });
      p.onTlsError({ failureCause: 'handshake-timeout', remoteIpAddress: '127.0.0.1', remotePort: 40002, timingEvents: {} });
      expect(proxy.grpcPinnedHosts).toEqual(['api.example.test:443']);
      expect(notes(proxy).some((n) => /other\.example\.test; not a certificate rejection/.test(n))).toBe(true);
    } finally {
      await proxy.stop();
    }
  });

  it.skipIf(!haveDartClient)('a grpcDecryptHosts host is never auto-pinned (noted); pins expire', async () => {
    const proxy = await startProxy({ ca });
    try {
      const target = `127.0.0.1:${up.port}`;
      proxy.setGrpcDecryptHosts(['127.0.0.1']);
      await rejectingClient(proxy.port, target);
      await rejectingClient(proxy.port, target);
      await waitFor(proxy, (e) => e.kind === 'tunnel' && /grpcDecryptHosts/.test(e.error ?? ''));
      expect(notes(proxy).filter((n) => /stays decrypted — remove it there if the app pins/.test(n)).length).toBe(2);
      expect(proxy.grpcPinnedHosts).toEqual([]);
      proxy.setGrpcDecryptHosts([]);
      proxy.setGrpcDecryptAll(true);
      grpcPinTesting.ttlMs = 300;
      await rejectingClient(proxy.port, target);
      await rejectingClient(proxy.port, target);
      await waitFor(proxy, pinnedNote);
      expect(proxy.grpcPinnedHosts).toEqual([target]);
      await sleep(400);
      expect(proxy.grpcPinnedHosts).toEqual([]); // expired: decrypted again
    } finally {
      delete grpcPinTesting.ttlMs;
      await proxy.stop();
    }
  }, 60_000);
});
