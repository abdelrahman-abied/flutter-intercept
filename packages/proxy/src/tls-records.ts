/*
 * Where the app's first request starts inside an undecrypted TLS tunnel (CONTRACTS §14.2, block / fault rules on a
 * passthrough host). Failing the CONNECT or the TLS handshake would make dart:io fall back to DIRECT
 * (docs/spikes/faults.md: everything in `_ConnectionTarget.connect` falls through), i.e. skip the proxy; so the
 * handshake with the real server is allowed to finish and the connection is cut where the app's first
 * application-data record begins — the app then fails at the request, like the other faults.
 *
 * Only TLS record headers (5 plaintext bytes: type, version, length) of the app → server direction are read:
 * - TLS 1.2: ClientHello (22) … ChangeCipherSpec (20), the encrypted Finished (still type 22); the first
 *   application_data record (23) is the request.
 * - TLS 1.3: ClientHello (22), [ChangeCipherSpec (20), middlebox compatibility], then everything is type 23:
 *   the first 23 is the client's Finished, the second one the request. (After a HelloRetryRequest the second
 *   ClientHello follows the CCS and reads like 1.2; the cut then falls on the client's Finished, which in 1.3 the
 *   client sends after its handshake already completed, so the app still fails at the request.)
 * Anything that doesn't start with a handshake record isn't TLS: cut at once.
 * TLS 1.3 0-RTT (REVIEW-8 #5): when the ClientHello offers `early_data` (extension 42), the type-23 records right after
 * it are early data — the app's first request — so the cut goes at the first type-23 record. The ClientHello is read
 * from the first record only (≤ 18 KB); one that doesn't fit there, or can't be parsed, counts as offering early data
 * (cutting at the first type-23 record is always after the client's handshake flight began, so it is safe too).
 */

const HEADER = 5;
const MAX_RECORD = 18 * 1024 + 2048; // 2^14 + expansion: anything bigger is not TLS

export class AppDataFinder {
  private header = Buffer.alloc(0);
  private remaining = 0;
  private records = 0;
  private afterCcs = false;
  private tls12 = false;
  private finishedSeen = false;
  private found = false;
  /** The first record's body (the ClientHello), while it is being read. */
  private hello?: Buffer[];
  private helloLeft = 0;
  private earlyData = false;

  /** Feed the next app → server chunk: the offset in it where application data starts, or -1. */
  push(chunk: Buffer): number {
    if (this.found) return 0;
    let i = 0;
    while (i < chunk.length) {
      if (this.remaining > 0) {
        const n = Math.min(this.remaining, chunk.length - i);
        if (this.hello) {
          this.hello.push(Buffer.from(chunk.subarray(i, i + n)));
          this.helloLeft -= n;
          if (this.helloLeft <= 0) {
            this.earlyData = offersEarlyData(Buffer.concat(this.hello));
            this.hello = undefined;
          }
        }
        this.remaining -= n;
        i += n;
        continue;
      }
      const start = i - this.header.length; // may be negative: the header began in an earlier chunk
      const need = HEADER - this.header.length;
      const take = chunk.subarray(i, i + need);
      this.header = this.header.length ? Buffer.concat([this.header, take]) : Buffer.from(take);
      i += take.length;
      if (this.header.length < HEADER) break;
      const type = this.header[0];
      const length = this.header.readUInt16BE(3);
      this.header = Buffer.alloc(0);
      if (this.isAppData(type, length)) {
        this.found = true;
        return Math.max(0, start);
      }
      this.remaining = length;
      if (this.records === 1) {
        this.hello = [];
        this.helloLeft = length;
        if (length === 0) {
          this.earlyData = true;
          this.hello = undefined;
        }
      }
    }
    return -1;
  }

  private isAppData(type: number, length: number): boolean {
    const first = this.records++ === 0;
    if (first && type !== 22) return true; // not TLS
    if (length > MAX_RECORD || type < 20 || type > 24) return true; // lost sync: not TLS (any more)
    if (type === 20) this.afterCcs = true;
    else if (type === 22 && this.afterCcs) this.tls12 = true;
    else if (type === 23) {
      if (this.tls12 || this.finishedSeen || this.earlyData) return true;
      this.finishedSeen = true;
    }
    return false;
  }
}

/** Does this ClientHello handshake message offer TLS 1.3 early data? Unparseable / cut short → true (be safe). */
export function offersEarlyData(body: Buffer): boolean {
  try {
    if (body.length < 4 || body[0] !== 1) return true;
    const len = body.readUIntBE(1, 3);
    const end = 4 + len;
    if (end > body.length) return true; // fragmented over several records
    let i = 4 + 2 + 32; // legacy_version, random
    i += 1 + body[i]; // session id
    i += 2 + body.readUInt16BE(i); // cipher suites
    i += 1 + body[i]; // compression methods
    if (i === end) return false; // no extensions
    const extEnd = i + 2 + body.readUInt16BE(i);
    i += 2;
    if (extEnd > end) return true;
    while (i + 4 <= extEnd) {
      const type = body.readUInt16BE(i);
      const n = body.readUInt16BE(i + 2);
      if (type === 42) return true;
      i += 4 + n;
    }
    return i > extEnd;
  } catch {
    return true;
  }
}
