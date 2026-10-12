# Spike: trust the Flutter Intercept CA on an iOS simulator (TLS gRPC, docs/spikes/grpc.md "Open decision" 2)

Date: 2026-10-12. Flutter 3.47.7, grpc-dart 5.1.0, Xcode 27.0, an iPhone 17 simulator on iOS 26.5 (only that
one was touched). Harness (scratch, not committed): a throwaway Flutter app that every 3 s runs, with **no
`onBadCertificate` and no custom roots**, (1) a unary call on a new `ClientChannel` with
`ChannelCredentials.secure()`, (2) `HttpClient()` GET, (3) `SecureSocket.connect` (all three to server A), and (4) the
same gRPC call to server B. Servers A and B: a small Node `http2.createSecureServer` (`allowHTTP1`), gRPC echo on h2
and JSON on HTTP/1.1, each with a `localhost` leaf (SAN DNS:localhost + IP:127.0.0.1, EKU serverAuth, 30 days)
signed by CA A (generated with mockttp's `generateCACertificate`, as `src/ca.ts` does: RSA 2048, 10 years) and CA B
(openssl, standing in for "another certificate the user added"). The app's output was read with
`xcrun simctl spawn <udid> log stream --predicate 'eventMessage contains "SPIKE r="'` (debug-build `print`s go to
the unified log, not to `simctl launch --console-pty`).

## Verdict

| Question | Answer |
|---|---|
| 1. `add-root-cert` makes grpc-dart's default `ChannelCredentials.secure()` accept a leaf from our CA | ✅ (also `HttpClient()` and `SecureSocket.connect` with the default context) |
| 2. Remove exactly one certificate | ✅ not with simctl (no remove action); deleting its row from the simulator's `TrustStore.sqlite3` works, live or shut down, and survives reboots; other rows untouched |
| 3. Read-only detection | ✅ `SELECT … FROM tsettings WHERE sha256 = x'<sha256 of the CA DER>'` on the host file |
| 4. Timing | add ≈ 0.2 s, delete ≈ 0.02 s; effective from the **next TLS handshake**: no reboot, no app restart. Simulator must be **booted** to add |
| 5. Full interception with the real proxy | ✅ `InterceptProxy` + `grpcDecryptHosts: ['localhost']` + the v6 entry: TLS gRPC decrypted (service, method, messages, status) |

## 1. Trust (measured)

Before any add (store empty): all four checks failed with
`HandshakeException: … CERTIFICATE_VERIFY_FAILED: application verification failure(handshake.cc:320)` (grpc-dart
wraps it in `UNAVAILABLE: Error connecting`). That error text is dart:io's for a SecTrust rejection, which confirms the
0.10 spike's reading of the SDK: on iOS `withTrustedRoots: true` / the default context ask the OS.

`xcrun simctl keychain <udid> add-root-cert caA.pem` **while the app ran**: the round that started in the same
~100 ms still failed, the next one (3 s later) gave `grpcA=OK`, `httpA=OK 200`, `sockA=OK`, `grpcB` still failing.
Adding CA B: `grpcB=OK` as well. No app restart, no simulator reboot.

## 2. Storage and removal

- `simctl keychain` actions: `add-root-cert` (trusted root store), `add-cert` (keychain item, not trusted; not used),
  `reset` (wipes the whole keychain and trust store — never used here). No remove / list action.
- `add-root-cert` only writes `<dataPath>/private/var/protected/trustd/private/TrustStore.sqlite3`
  (`<dataPath>` = `dataPath` of the device in `xcrun simctl list devices -j`, i.e.
  `~/Library/Developer/CoreSimulator/Devices/<udid>/data`). The keychain db (`data/Library/Keychains/
  keychain-2-debug.db`, table `cert`) stays empty. Journal mode `delete` (no WAL), `user_version` 0.
- Schema: `tsettings(sha256 BLOB, subj BLOB, tset BLOB, data BLOB, uuid BLOB, UNIQUE(sha256,uuid))`, index on `subj`.
  The row for our CA: `sha256` = SHA-256 of the certificate DER (same as `openssl x509 -fingerprint -sha256`),
  `data` = the DER byte for byte, `subj` = the normalized (upper-cased) subject, `tset` = an empty plist array
  (trusted as root for every policy), `uuid` = `FFFFEEEEDDDDCCCCBBBBAAAA` + the Mac user's uid in hex.
- Adding the same CA again does not add a row (still one per sha256).
- `DELETE FROM tsettings WHERE sha256 = x'<hex>'` with `/usr/bin/sqlite3` (`PRAGMA busy_timeout=5000`):
  - **live** (simulator booted, app running): the next handshake failed again (A), B stayed `OK`. Re-adding A
    afterwards worked at once (no negative cache), a second delete failed it again;
  - **offline** (simulator shut down): after boot A failed, B `OK`;
  - after a further shutdown + boot: unchanged (A failed, B `OK`). trustd does not re-create the row.
- Writing the file adds a `com.apple.provenance` xattr to it (macOS); the simulator didn't mind.
- TLS connections already open keep working after removal (trust is evaluated at the handshake only).

At the end of the spike both test rows were deleted; the store was back to the 0 rows it had at the start.

## 3. Detection

Read-only, simulator booted or not: `sqlite3 "file:<path>?mode=ro" "SELECT 1 FROM tsettings WHERE sha256 = x'<hex>'"`.
Gives "already trusted" (status, skip the add) and "someone else added it" (row present before we added it: then
it is not ours to remove). The CA's sha256 is computed from the PEM (`crypto.X509Certificate#fingerprint256`).
Runtime check from the proxy side: with decryption on and no trust, the proxy records
`TLS handshake with the app failed (reset). The app probably rejects the proxy's certificate …` per tunnel.

## 4. Timing (iPhone 17 / iOS 26.5, Apple silicon)

| Step | Time |
|---|---|
| `simctl keychain add-root-cert` (booted) | 0.20 s |
| same, simulator shut down | fails at once: `Unable to lookup in current state: Shutdown` (code 405) |
| `sqlite3 DELETE` of one row | 0.02 s |
| simulator boot (`boot` + `bootstatus -b`) / shutdown | 4–9 s / 3–4 s |
| effect | next handshake (new connection); no reboot, no app restart, nothing to restart in trustd |

## 5. End to end with the real proxy (measured)

`InterceptProxy({ ca: CA A, grpcDecryptHosts: ['localhost'], ignoreUpstreamCertErrors: ['localhost'] })` on a fixed
port, the app built with the v6 entry (`scripts/e2e/gen_entry.sh`, `FI_CA_CERT=caA.pem`,
`--dart-define=FLUTTER_INTERCEPT_PROXY=localhost:<port>`), installed with `simctl install`:
- CA A **not** in the simulator store: `httpA` / `sockA` OK (the entry trusts the CA in `SecurityContext.defaultContext`
  and HttpClient goes through the proxy), but **both gRPC calls fail** (`CERTIFICATE_VERIFY_FAILED`) — the proxy
  terminates TLS for every `localhost` gRPC tunnel, server B's included — and the proxy records `CONNECT
  https://localhost/` errors "TLS handshake with the app failed". So `decryptHosts` without OS trust breaks the app.
- `add-root-cert caA.pem` while running: from the next round all four `OK`; the proxy recorded
  `POST https://localhost:48443/spike.Echo/Say` and `…:48444/…` with
  `grpc={"service":"spike.Echo","method":"Say","messagesSent":1,"messagesReceived":1,"deadlineMs":6000,"statusCode":0}`;
  the servers saw the calls arrive from the proxy. mockttp's per-host leaves pass iOS's SecTrust rules.
- Deleting the row live: gRPC failing again from the next round; re-add: OK again.

## Recommended design (0.13 candidate; needs the security review the owner asked for)

- **Setting** `flutterIntercept.grpc.trustOnSimulator` (boolean, default **false**), plus commands
  "Trust the Flutter Intercept CA on this iOS simulator" / "Remove …" and a status line in the gRPC panel
  ("CA trusted on iPhone 17 (added by Flutter Intercept / by you)").
- **When**: at debug-session start, after the device is known and **only** if the device id is in
  `xcrun simctl list devices -j` with state `Booted` (physical iOS devices never appear there; macOS desktop, Android,
  web: never). Before `flutter run` builds, so the first call already works.
- **Add**: compute the CA sha256; read-only check the row. Present → mark `preExisting`, add nothing. Absent →
  verify the store file and `tsettings(sha256)` exist at `dataPath` (else refuse: we could not remove it); **write
  the record first** (globalState: `udid`, `dataPath`, `sha256`, `owner`, `pid`, `heartbeat`, as `AndroidGlobalProxy`),
  then `simctl keychain <udid> add-root-cert <tmp PEM — certificate only, never the key>`, then confirm the row.
- **Decrypt**: while trust is confirmed for the session, the session's TLS gRPC tunnels may be decrypted (owner
  call: all hosts, or keep `decryptHosts`); a host whose handshake still fails (the app pins / uses its own roots)
  falls back to passthrough for the session.
- **Remove exactly that row** (`DELETE … WHERE sha256 = x'<hex>'`, `/usr/bin/sqlite3`, argument arrays, hex
  validated `^[0-9A-F]{64}$`, busy timeout) on session end (when no other live session/window holds the same
  simulator — reference count + owner heartbeat as REVIEW-8 #7), on proxy stop, in `deactivate()`, and in
  `recover()` at activation for stale records (works booted or shut down; a deleted simulator → drop the record).
  Never when `preExisting`. Never `simctl keychain reset`, never `erase`.
- **CA rotation**: the record holds the sha256 that was added, so an old CA is removed even after `src/ca.ts`
  regenerated the CA.

## Risks

- **Undocumented storage**: the TrustStore path/schema is Apple-private; seen on iOS 26.x (this spike, and the 0.8
  spike's iPhone 17 Pro). Other runtimes (iOS 26.2/26.4/27.0 are installed here) were not tested. Mitigation:
  refuse to add when the file/schema doesn't look as expected, confirm the row after the add.
- **Simulator-wide trust**: every app and Safari on that simulator trusts our CA while it is added (key stays on the
  Mac, mode 0600). A crash leaves it trusted until the next activation's `recover()`.
- **Concurrent writers**: trustd holds the db; `busy_timeout` and one tiny statement keep the window small.
  Another tool (Proxyman, Charles, mitmproxy scripts) adding its own CA is unaffected (different sha256).
- **Behaviour change for pinned apps**: decryption breaks gRPC for apps that pin or bring their own roots — the
  passthrough fallback above is required before turning decryption on automatically.
- Established connections survive removal (a long-lived `ClientChannel` keeps its decrypted connection until it
  reconnects); harmless once the session is over.
