// v0.13.0 (CONTRACTS §19.3 "Decryption"): decrypt every TLS silent gRPC tunnel while a simulator trusts our CA, and
// learn hosts that pin their own certificate (passed through undecrypted from then on).
import { once } from 'events';
import * as tls from 'tls';
import { X509Certificate } from 'crypto';
import { generateCACertificate } from 'mockttp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Exchange, InterceptProxy } from '../src';
import { nextExchange, selfSignedCert, startProxy } from './helpers';
import { grpcCall, silentSocket, startGrpcServer, tlsSession, type GrpcServer } from './grpc-helpers';

function waitFor(proxy: InterceptProxy, pred: (e: Exchange) => boolean, timeoutMs = 10_000): Promise<Exchange> {
  const have = [...proxy.getExchanges()].reverse().find(pred);
  return have ? Promise.resolve(have) : nextExchange(proxy, pred, timeoutMs);
}

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

  it('a host whose app rejects our certificate is learned as pinned: one failed handshake, then passed through (noted)', async () => {
    const proxy = await startProxy({ ca });
    try {
      proxy.setGrpcDecryptAll(true);
      const target = `127.0.0.1:${up.port}`;
      // The app pins: it verifies against its own CA only (here: the server's), so our MITM certificate fails.
      const sock = await silentSocket(proxy.port, target);
      const pinnedClient = tls.connect({ socket: sock, servername: 'localhost', ALPNProtocols: ['grpc-exp', 'h2'], ca: upCert.cert });
      const err = await new Promise<Error>((resolve) => pinnedClient.once('error', resolve));
      expect(err.message).toMatch(/certificate|self.signed|unable to verify/i);
      const learned = await waitFor(proxy, (e) => e.kind === 'tunnel' && /pins its certificate/.test(e.error ?? ''));
      expect(learned.error).toMatch(/^127\.0\.0\.1 pins its certificate; passed through undecrypted from now on/);
      expect(proxy.grpcPinnedHosts).toEqual([target]);
      // The next connection is a passthrough tunnel: the pinned app sees the server's own certificate and works.
      const again = await silentSocket(proxy.port, target);
      const t = tls.connect({ socket: again, servername: 'localhost', ALPNProtocols: ['h2'], ca: upCert.cert });
      await once(t, 'secureConnect');
      t.destroy();
      const tunnel = await waitFor(proxy, (e) => e.kind === 'tunnel' && e.grpcTunnel === true && e.state !== 'pending' && e.method === 'CONNECT' && e.id !== learned.id);
      expect(tunnel.error).toMatch(/127\.0\.0\.1 pins its certificate; passed through undecrypted\./);
      expect(proxy.getExchanges().filter((e) => /pins its certificate; passed through undecrypted from now on/.test(e.error ?? '')).length).toBe(1);
    } finally {
      await proxy.stop();
    }
    expect(proxy.grpcPinnedHosts).toEqual([]); // forgotten when the proxy stops
  });
});
