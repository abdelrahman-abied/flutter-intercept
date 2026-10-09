import { AsyncLocalStorage } from 'async_hooks';
import type * as net from 'net';

/*
 * mockttp 4's MockttpServer.start() calls `server.listen(port)` with no host, i.e. it binds to
 * every interface (`::`). A MITM proxy reachable from the LAN is a real exposure, and the contract
 * says we listen on 127.0.0.1 by default. mockttp has no host option, so we wrap its (CommonJS,
 * writable) `createComboServer` export and inject the host into that single `listen(port)` call.
 * The host travels via AsyncLocalStorage so concurrent starts with different hosts don't clash.
 * If the hook can't be installed (e.g. a future mockttp layout), InterceptProxy falls back to
 * close + re-listen on the right host right after start (see rebindIfNeeded).
 */

const hostStore = new AsyncLocalStorage<string>();

/** Test seam: simulate a mockttp layout where the hook and/or the fallback don't work. */
export const listenHostTesting = { disableHook: false, disableRebind: false };
let hookInstalled: boolean | undefined;

function installHook(): boolean {
  if (hookInstalled !== undefined) return hookInstalled;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('mockttp/dist/server/http-combo-server') as {
      createComboServer: (...args: unknown[]) => Promise<net.Server>;
    };
    const original = mod.createComboServer;
    if (typeof original !== 'function') return (hookInstalled = false);
    mod.createComboServer = async function patchedCreateComboServer(this: unknown, ...args: unknown[]) {
      const host = hostStore.getStore();
      const server = await original.apply(this, args);
      if (host && !listenHostTesting.disableHook) {
        const listen = server.listen as (...a: unknown[]) => net.Server;
        server.listen = function (this: net.Server, ...largs: unknown[]) {
          if (largs.length === 1 && typeof largs[0] === 'number') return listen.call(this, largs[0], host);
          return listen.apply(this, largs);
        } as typeof server.listen;
      }
      return server;
    };
    return (hookInstalled = true);
  } catch {
    return (hookInstalled = false);
  }
}

export function runWithListenHost<T>(host: string, fn: () => Promise<T>): Promise<T> {
  installHook();
  return hostStore.run(host, fn);
}

const WILDCARDS = new Set(['0.0.0.0', '::', '']);

/** Fallback: if the server ended up on a wildcard address but a specific host was asked for. */
export async function rebindIfNeeded(server: net.Server, host: string): Promise<void> {
  if (WILDCARDS.has(host) || listenHostTesting.disableRebind) return;
  const addr = server.address();
  if (!addr || typeof addr === 'string' || !WILDCARDS.has(addr.address)) return;
  const port = addr.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve, reject) => {
    const onError = (e: Error) => reject(e);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

/** Does the bound address satisfy the requested host? (fail-closed check after start) */
export function boundAddressMatches(addr: ReturnType<net.Server['address']>, host: string): boolean {
  if (!addr || typeof addr === 'string') return false;
  const a = addr.address.replace(/^::ffff:/, '');
  if (host === 'localhost') return a === '127.0.0.1' || a === '::1';
  if (host === '' ) return WILDCARDS.has(a);
  return a === host.replace(/^::ffff:/, '');
}
