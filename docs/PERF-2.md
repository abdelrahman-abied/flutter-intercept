# PERF-2 — 0.14.0 performance pass (2026-10-15)

The measured performance pass for 0.14.0 ("apps with their own certificate", CONTRACTS §20), compared with 0.13.0.
It covers what 0.14.0 adds to the hot paths:
- every HTTP CONNECT that mockttp answers now has its TLS handshake watched for a pin;
- every CONNECT looks up the learned map;
- 502 and 400 responses are checked for a refusal, and a TLS 1.2 refusal can start a probe;
- the extension bundle grew;
- the webview gained a banner, a status line item and a certificates / learned hosts list.

These are measurements, not estimates. Where a number is derived, the derivation is stated.

## 1. Environment

| | |
|---|---|
| Machine | Apple M4 Max (14 cores), 36 GB, macOS 27.0.1 |
| Node | v26.4.0 (the benches). VS Code's extension host runs its own Electron Node |
| mockttp / esbuild / MCP SDK / zod / happy-dom | 4.6.3 / 0.24.2 / 1.32.1 / 4.6.5 / 15.11.7 |
| Code measured | **0.13** = `aee0cad`, built in a scratch git worktree. **0.14** = `95fc8ab` as committed. **0.14 + fixes** = `95fc8ab` plus this pass's changes (§4). Each proxy `dist` was copied to a scratch dir before the runs |
| Load | Every bench ran under `nice -n 10`, with other agents working on the machine at the same time. 0.13 and 0.14 ran back to back, in alternating order, two or three rounds each, so compare pairs rather than absolute numbers with PERF-1 |

As in PERF-1, the proxy runs *in the extension host process*, so its event-loop delay is every extension's delay.

## 2. Method

These are the PERF-1 scripts (plain Node, three processes: proxy child, upstream child and client), kept in the session
scratchpad, outside the repo. The proxy child takes the `dist` to load from an environment variable. Additions:

- **New connection per request.** The HTTPS client can run without keep-alive. Each request is then a new CONNECT plus a
  full TLS handshake with the proxy's leaf certificate (no session resumption), which is the case the handshake watch
  affects.
- **mTLS upstreams** (own process). They use certificates made by `scripts/e2e/mtls_server.mjs`, and each counts the TCP
  connections it gets, which covers both the proxy's upstream attempts and its probes:
  - `tls12`: TLS 1.2, `requestCert` + `rejectUnauthorized`. It sends alert 40 when no certificate comes.
  - `tls13`: TLS 1.3. It sends alert 116.
  - `nginx`: it asks for a certificate, accepts none, and answers with nginx's 400 page.
  - `nocipher`: TLS 1.2 with only Camellia ciphers. It sends alert 40 *without* a CertificateRequest, so a probe must
    say no.
- **The app in the mTLS scenarios** presents its own client certificate on every connection, as Dio with a
  `SecurityContext` does. It fires 50 requests at once (50 keep-alive sockets), and repeats that until one succeeds,
  for at most 10 s. Then comes a 3 s closed loop with 50 workers. The proxy child wraps `probeTesting.probe` to count
  probes and time them.
- **The learned map** is filled through the test internals (`learn.hosts.learn`, or `pinnedHosts.set` on 0.13).
- **Activation:** `require()` of the bundle in plain Node with a permissive `vscode` stub, median of 7.
- **Webview:** `packages/webview/test/perf-certs.test.tsx` (happy-dom, new). It times the full `App` render through host
  messages, like `perf-list.test.tsx`.

## 3. Results

### 3.1 HTTPS MITM, no rules (16 workers small, 8 workers 1 MB; ranges over 3 rounds)

| body | connections | version | p50 / p99 ms | req/s | proxy CPU per req | ELD max ms |
|---|---|---|---|---|---|---|
| 17 B | keep-alive | 0.13 | 0.16–0.24 / 0.39–0.75 | 10 100–10 600 | 0.116–0.126 ms | 7.9–59.7 |
| 17 B | keep-alive | 0.14 + fixes | 0.16–0.18 / 0.46–0.61 | 10 200–10 600 | 0.115–0.125 ms | 6.3–26.5 |
| 17 B | new per request | 0.13 | 1.40–1.58 / 2.58–2.96 | 1 190–1 260 | 0.921–0.990 ms | 5.8–13.1 |
| 17 B | new per request | 0.14 + fixes | 1.44–1.73 / 2.72–4.41 | 1 180–1 240 | 0.933–0.970 ms | 6.2–6.8 |
| 1 MB | keep-alive | 0.13 | 1.44–1.58 / 2.50–3.40 | 800–830 | 3.39–3.49 ms | 3.2–11.1 |
| 1 MB | keep-alive | 0.14 + fixes | 1.41–1.57 / 2.42–3.21 | 780–830 | 3.35–3.49 ms | 2.8–4.3 |
| 1 MB | new per request | 0.13 | 3.05–4.00 / 4.16–13.9 | 340–470 | 5.51–6.67 ms | 3.5–85.4 |
| 1 MB | new per request | 0.14 + fixes | 2.92–3.59 / 5.18–7.12 | 450–470 | 5.57–5.69 ms | 3.2–19.7 |

- With the fixes, the handshake watch costs nothing measurable: within ±3% CPU per new connection, which is inside the
  noise.
- **0.14 as committed could not be measured here, because it stopped decrypting the bench's own host** (finding #1). In
  the first run:
  - after the small new-connection load, the watch map held 985–1000 entries (its cap);
  - during the 1 MB new-connection load, it learned the upstream as `pinned`;
  - every later "0.14" row then measured a passed-through tunnel: 48 900 req/s at 0.016 ms CPU, with nothing recorded.

### 3.2 CONNECT handling and the learned map (17 B HTTPS, new connection per request, 16 workers; 2 runs)

| case | proxy CPU per connection | req/s | p50 ms |
|---|---|---|---|
| 0.13, decrypted | 1.033 / 1.042 ms | 1 122 / 1 095 | 1.61 / 1.65 |
| 0.14 + fixes, decrypted, 0 learned | 1.013 / 1.095 ms | 1 168 / 1 033 | 1.55 / 1.65 |
| 0.14 + fixes, decrypted, 1000 learned | 1.074 / 1.045 ms | 1 096 / 1 110 | 1.54 / 1.64 |
| 0.13, a `tlsPassthrough` host (tunnel) | 0.198 / 0.201 ms | 1 774 / 1 780 | 1.32 / 1.29 |
| 0.14 + fixes, a learned `client-certificate` host (map full) | 0.194 / 0.205 ms | 1 785 / 1 781 | 1.34 / 1.42 |
| same, with 200 enabled rules that don't name the host | 0.226 / 0.248 ms | 1 780 / 1 818 | 1.48 / 1.41 |

- The map lookup is O(1). A full map changes nothing measurable.
- A learned tunnel costs the same as a configured `tlsPassthrough` tunnel.
- The only new per-CONNECT cost that scales with something is `ruleNamingHost`. It runs for a learned
  `client-certificate` host on every CONNECT (`forConnect` → `keepDecrypted`) and scans the enabled rules: about
  +0.03–0.05 ms per CONNECT with 200 rules (§4, #5).

### 3.3 A server that needs the app's own certificate, 50 concurrent requests

"Learn" is the window from the first request until a request succeeds (at most 10 s). "Steady" is the 3 s that follow.

| server | version | first wave | first success | probes | events | learn: proxy CPU, ELD max | steady: req/s, CPU per req, ELD max |
|---|---|---|---|---|---|---|---|
| TLS 1.2, alert 40 | 0.13 | 50 × 502 | never | 0 | – | 10.6 s, 172 ms | 172 (all 502), 5.77 ms, 91 ms |
| TLS 1.2, alert 40 | 0.14 | 42 × 502, 8 × 200 | 315 ms | 3 | 3 | 0.40 s, 93 ms | 48 400, 0.015 ms, 3.4 ms |
| TLS 1.2, alert 40 | 0.14 + fixes | 18 × 502, 32 × 200 | 208 ms | **1** | **1** | 0.18 s, 72 ms | 48 700, 0.015 ms, 2.1 ms |
| TLS 1.3, alert 116 | 0.13 | 50 × 502 | never | 0 | – | 10.5 s, 195 ms | 175 (all 502), 5.76 ms, 92 ms |
| TLS 1.3, alert 116 | 0.14 | 14 × 502, 36 × 200 | 146 ms | 0 | 14 | 0.15 s, 32 ms | 48 400, 0.015 ms, 2.2 ms |
| TLS 1.3, alert 116 | 0.14 + fixes | 21 × 502, 29 × 200 | 208 ms | 0 | **1** | 0.22 s, 63 ms | 49 600, 0.015 ms, 2.8 ms |
| nginx 400 | 0.13 | 50 × 400 | 368 ms ¹ | 0 | – | 0.46 s, 91 ms | 9 700 (75% 400), 0.139 ms, 19 ms |
| nginx 400 | 0.14 + fixes | 29 × 400, 21 × 200 | 240 ms | 0 | 1 | 0.29 s, 78 ms | 49 900, 0.015 ms, 1.5 ms |
| alert 40, no CertificateRequest | 0.13 | 50 × 502 | never | 0 | – | 10.6 s, 165 ms | 184 (all 502), 5.55 ms, 106 ms |
| alert 40, no CertificateRequest | 0.14 + fixes | 50 × 502 | never | **1** (20 ms) | 0 | 10.5 s, 205 ms | 175 (all 502), 5.68 ms, 83 ms |
| alert 40, **map full** (1000) | 0.14 | 50 × 502 | never | **139**, then **133** in 3 s | 1 | 10.7 s, 212 ms | 185, 5.54 ms, 112 ms; 733 upstream connections for 600 requests |
| alert 40, **map full** (1000) | 0.14 + fixes | 50 × 502 | never | **1** | 1 | 10.6 s, 180 ms | 179, 5.74 ms, 119 ms; 583 for 583 |

¹ 0.13 "succeeds" on nginx only because that server answers 200 to a request that does carry a certificate on a reused
connection. A quarter of the steady requests still got the 400.

- **No probe storm.** One probe per `host:port` at a time already held in 0.14. With the fixes, a burst costs exactly
  one probe, and a host that can't be learned (map full) is no longer probed again on every failure (#2).
- **Learning pays for itself at once.** 0.13 spends about 5.5–5.8 ms of proxy CPU on every failed request to an mTLS
  server. Each one is a fresh upstream TLS handshake that fails, plus mockttp's error logging. The event loop then
  stalls for 90–200 ms in bursts. After 0.14 learns the host, the same load runs through the tunnel at 0.015 ms per
  request.
- The requests already in flight when the host is learned fail once. That is 14–29 of 50 here, as CONTRACTS §20.1
  says, with `Connection: close`.

### 3.4 gRPC relay (h2c silent tunnel, 100 B messages; 2 runs each)

| version | variant | unary p50 / p99 ms | unary calls/s | CPU per message | stream 20 000 msg/s | allocated per unary call |
|---|---|---|---|---|---|---|
| 0.13 | none | 0.21–0.23 / 0.72–0.79 | 14 600–15 900 | 35–38 µs | 1.78–1.86 M | 79 KB |
| 0.14 + fixes | none | 0.23–0.25 / 0.69–0.79 | 14 500–15 700 | 35–38 µs | 1.73–1.84 M | 79 KB |
| 0.13 | bpNoMatch | 0.20–0.21 / 0.48–0.55 | 14 400–14 800 | 37–38 µs | 1.76–1.86 M | 79 KB |
| 0.14 + fixes | bpNoMatch | 0.21 / 0.52–0.73 | 15 200–15 400 | 36–37 µs | 1.54–1.73 M | 79 KB |

No regression: the differences are within run-to-run noise, and allocations are identical. PERF-1 budgets B1–B3 hold.

### 3.5 Extension bundle and activation

| build | `dist/extension.js` | `require()` (median of 7) | heap |
|---|---|---|---|
| 0.13 (`aee0cad`) | 2 554 853 B | 66.8 ms | 17.6 MB |
| 0.14 (`95fc8ab`) | 2 586 551 B (+31.7 KB) | 67.8 ms | 17.6 MB |
| 0.14 + fixes | **2 507 229 B** (−79.3 KB vs 0.14) | **65.4 ms** | 17.3 MB |

Growth 0.13 → 0.14 (esbuild metafiles):

| source | bytes |
|---|---|
| proxy: `learned.js` | +5.9 KB |
| proxy: `learn-flow.js` | +4.9 KB |
| proxy: `connect-flow.js`, `http-taps.js`, `intercept-proxy.js`, `grpc-relay.js` | +5.2 KB |
| extension: `ui/clientCertUi.ts` | +5.1 KB |
| extension: `ui/handlers.ts` | +3.4 KB |
| extension: `extension.ts` | +2.5 KB |
| extension: `agent/schema.ts`, `proxyHost.ts`, views, controller, HAR | +4.2 KB |
| `node_modules` | ±0 (no new dependency) |

All of the growth is the feature's own code; nothing new was pulled in. Activation still doesn't load the proxy or
mockttp: the lazy `require` and the `/hosts` / `/grpc-meta` subpaths from PERF-1 #1 hold, and
`activation.imports.test.ts` guards them.

The headroom came from somewhere else: the MCP SDK's Zod 3 compatibility code (#4).

### 3.6 Webview (happy-dom; `perf-certs.test.tsx`)

| case | time |
|---|---|
| one `exchange` update with 1000 rows listed, Status without lists | 1.71–1.79 ms (median of 15) |
| same, Status with 1000 learned hosts + 50 certificates | 1.71–1.81 ms |
| open the list: 20 learned + 5 certificates (25 rows) | 1.6–1.9 ms |
| open the list: 200 + 50 (250 rows) | 14.3–17.6 ms |
| open the list: 1000 + 50 (1050 rows) | 62–69 ms |
| a Status update while the list is open (also the cost of its once-a-second clock), 25 / 250 / 1050 rows | 1.4–1.6 / 2.5–7.9 / 5.5–10.2 ms |

- The lists cost nothing while the list is closed.
  - The status line items build one tooltip string (O(n)), which is invisible next to the traffic list.
  - The `status` reducer stores the Status as it is (O(1)).
- With the list open, rendering is linear in its rows.

## 4. Findings

| # | What | Measured | Status |
|---|---|---|---|
| 1 | **The HTTP handshake watch learns false pins under load, and switches itself off.** Every decrypted CONNECT went into `decrypting`. It left only 5 s after the socket closed, or after a 60 s timer. Three problems: (a) the 1000-entry cap filled at about 200 new connections/s, so a real pin went unnoticed during and after a burst; (b) a client that opens a spare TLS connection and drops it unused shows up in mockttp as a handshake `reset` / `closed`. Node's agent did this to about 19% of connections in the 1 MB new-connection bench; pooled and preconnecting clients do it too. Two such drops in a minute pinned the host for 10 minutes, so its traffic silently stopped being decrypted; (c) one 60 s timer per CONNECT | 0.14: watch map at its cap (985–1000) after 4 s of new connections; the bench's own host pinned during the 1 MB run, after 2 resets (0.13: 267 generic records, nothing learned); about 0.8 MB more heap kept per 9.5 k connections for 60 s | **Fixed.** `ConnectFlow.handshakeWorked` (called from `decide()` once per connection, WeakSet) takes a connection out of the watch at its first request. It also records that the app accepts the proxy's certificate for that `host:port` (`accepted`). Within `PIN_STRIKE_WINDOW_MS` of such a request, a close or reset in a handshake is not a pin strike: HTTP gets 0.13's generic record, gRPC gets "not a certificate rejection". An app that pins never completes a decrypted request. Alerts still pin at once. One timer per watched connection, only when it closes unused; full map → entries older than 60 s are swept. After: watch map 0 after every run, nothing learned, CPU per new connection within noise of 0.13 (§3.1), heap growth the same as 0.13. Tests: `learned.test.ts` "PERF-2 #1" (it fails on `95fc8ab`). |
| 2 | **Only a negative probe answer was cached.** In-flight failures that finish after a positive probe start new probes. With the learned map full, every alert 40 / 42 failure of an mTLS host probes again, one at a time (also REVIEW-14 #6) | alert 40 burst: 3 probes; map full: 139 probes in 10 s, then 133 in 3 s, +26% upstream connections | **Fixed.** `LearnFlow` keeps the last answer per `host:port` for `PROBE_NEGATIVE_MS`, both ways. After: 1 probe in both cases (§3.3). Test: "PERF-2 #2" (fails on `95fc8ab`: 4 probes for 4 failures). |
| 3 | **Every failure of a burst re-learned the host and emitted `learnedPassthrough`.** Each emit makes the host re-broadcast Status to the panel and the agents. Emits were coalesced per tick only | TLS 1.3 burst: 14–23 events for one host | **Fixed.** `LearnedHosts.learn` calls `changed()` only when the entry is new or its reason, `until` or `grpc` changes. After: 1 event (§3.3). Test in "the map: …". |
| 4 | **The extension bundle carried Zod 3 and `zod-to-json-schema`** (82 KB minified, evaluated at activation). The MCP SDK imports them only for schemas without Zod 4's `_zod` marker, and every schema here is Zod 4 (`agent/schema.ts`; the SDK's own types use `zod/v4`) | 2 586 551 B, 67.8 ms require | **Fixed.** `stubs/zod-v3.js` replaces both and throws if ever used, through the existing stub mechanism in `build.mjs`. Only the two SDK compat files may import them, otherwise the build fails. The build also fails if `zod/v3` or `zod-to-json-schema` comes back. `test:bundle` now drives the MCP server through the minified bundle: 42 tools listed with object schemas, a valid call answered, an invalid one refused. After: 2 507 229 B (below 0.13), 65.4 ms, −0.3 MB heap. |
| 5 | `forConnect` runs `keepDecrypted` → `ruleNamingHost` on every CONNECT to a learned `client-certificate` host: a linear scan of the enabled rules with `patternNamesHost` | +0.03–0.05 ms per CONNECT with 200 rules (§3.2) | Known cost. Cache it per rules generation if rule counts grow large. |
| 6 | A server that refuses and can't be learned costs about 5.5 ms of proxy CPU per failed request, with 90–200 ms event-loop stalls under a 50-request burst: a new upstream TLS handshake each time, plus mockttp's "Failed to handle request" logging. This covers 0.13 for every mTLS host, and 0.14 for a non-certificate alert 40, a full map, a rule naming the host, or replay | §3.3 | Known cost, the same as 0.13. A short-lived negative upstream cache per `host:port` would cut it; not done. |
| 7 | mockttp still reports spare connections dropped right after their handshake as "TLS handshake with the app failed (reset) … probably rejects the proxy's certificate". With the fix these are generic records again, as in 0.13, but they are noise in the list for pooled clients (about 19% of connections in the 1 MB new-connection bench) | §3.1 | Known (since 0.13). Consider hiding a `reset` / `closed` record for a host in `accepted`. |
| 8 | The open certificates list re-renders all rows every second while any pinned entry counts down | 5.5–10 ms per tick at 1050 rows (happy-dom), only while the list is open | Known, acceptable. Split the countdown into its own component if lists grow. |

REVIEW-14 #2 (pins from other clients, alerts, per-client pins) is a separate, wider change. #1 here addresses the
false-positive part that load testing exposed. It doesn't replace that review item. CONTRACTS §20.1 says a close or
reset in the handshake twice within `PIN_STRIKE_WINDOW_MS` pins. With #1 that holds unless the app completed a
decrypted request to that `host:port` within the window. The contract text should say so.

## 5. Budgets and tests added

| Budget | Kind | Where |
|---|---|---|
| A connection that carried a request is no longer watched (`decrypting.size` 0 while it is open); spare connections dropped after the app's requests worked don't pin | structural | `proxy/test/learned.test.ts` "PERF-2 #1" |
| One probe per `host:port` per `PROBE_NEGATIVE_MS`, positive or negative, map full or not | structural | `learned.test.ts` "PERF-2 #2", "handshake_failure without a CertificateRequest" |
| Re-learning an unchanged entry emits nothing | structural | `learned.test.ts` "the map: …" |
| A CONNECT costs the same with 1000 learned hosts as with none | ratio (already in 0.14) | `learned.test.ts` "performance" |
| An exchange update costs ≤ 2× with 1000 learned hosts + 50 certificates in Status; opening the list and a Status update while open are ≤ 15× for 10× the rows; 250 and 1050 rows rendered | ratio + structural | `webview/test/perf-certs.test.tsx` |
| No Zod 3 / `zod-to-json-schema` in the bundle; ≤ 2 600 000 B | build | `extension/build.mjs` |
| The MCP server works through the minified bundle with the Zod 3 stubs | smoke | `extension/test/bundle/smoke.ts` (`npm run test:bundle`) |

The bundle is now 2 507 229 B, so the 2.6 MB budget leaves 93 KB of headroom. Lowering it to 2 550 000 would keep it
tight, but that is the owner's call. PERF-1 B1–B11 still hold where they were measured again (§3.1, §3.4).

Not measured: real devices and dart:io clients, which pool and resume TLS sessions differently from Node; `activate()`
inside a real extension host; Electron's Node.
