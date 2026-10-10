# Proxy v0.8.0 — as built (TLS passthrough, mTLS, upload / WebSocket / SSE throttling, stream replay, idle pool)

Notes for CONTRACTS §14.2–§14.6 (the lead folds them in). Code: `packages/proxy/src/` — `hosts.ts` (host patterns),
`tunnel.ts` + `tls-records.ts` (passthrough), `pace.ts` (link simulation), `upstream-request.ts` (per-request view:
timings, upload pacing, retry), `idle.ts`, `replay-stream.ts`, plus wiring in `intercept-proxy.ts`, `upstream-pool.ts`,
`upstream-proxy.ts` (noProxy), `lan.ts`, `shaper.ts`, `replay.ts`, `rules.ts`. Tests: `test/v8.test.ts` (32).

## API for the host

```ts
new InterceptProxy({ ..., tlsPassthrough?: string[], clientCertificates?: ClientCertificate[] });
setTlsPassthrough(hosts: string[] | undefined): void          // throws on an invalid pattern; nothing changes then
readonly tlsPassthrough: string[]                              // patterns in use
readonly tlsPassthroughAvailable: boolean                      // false only if mockttp's CONNECT hook failed
setClientCertificates(certs: ClientCertificate[] | undefined): { host: string; problem?: string }[]  // per entry, in order
readonly clientCertificates: { host: string; problem?: string }[] // = Status.clientCertificates
setUpstreamProxy({ url, ignoreCertErrors?, noProxy?: string[] })  // noProxy: host, *.suffix, *, IP ([v6]), optional :port
readonly upstreamProxy: { url; ignoreCertErrors; noProxy?: string[] } | undefined
setNetworkProfile({ kind: 'throttle', ..., uploadKbps })       // validated like kbps
```
New exports: `parseHostPattern`, `matchesHostPattern`, `HostPattern`, `loadClientCertificate`, `parseNoProxy`,
`MAX_REPLAY_GAP_MS`, `IDLE_SOCKET_TIMEOUT_MS`.

Host patterns (passthrough and certificates): hostname glob, case-insensitive, `*` = any characters including dots
(`*.bank.example` matches `a.b.bank.example`, not `bank.example`), optional `:port` (`[::1]:8443` for IPv6); a bare `*`
is refused ("list the hosts instead").

## TLS passthrough (§14.2)

- **Hook.** mockttp's combo server answers every CONNECT itself (`server.addListener('connect', …)` in
  `http-combo-server.js`: "200", then the socket is re-emitted as a connection and MITM'd). There is no option to
  take a CONNECT over per request (mockttp's own `tlsPassthrough` is fixed at start, matches on the ClientHello and
  connects with a bare `net.connect`: no LAN guard, no upstream proxy, no exchange). So after start, the proxy removes
  mockttp's `connect` listener(s) from the server and installs one that tunnels passthrough hosts and calls mockttp's
  listener for everything else. httpolyglot mirrors listeners onto its sub-servers (`newListener` / `removeListener`),
  so this changes them all; LAN sockets reach the same listener because the gate hands them to the same server. One
  hook, no change to mockttp's behaviour for other CONNECTs. Nested CONNECTs inside a TLS tunnel and HTTP/2 CONNECTs
  are left to mockttp.
- **Upstream connection** (`openTunnelUpstream`): LAN clients — `resolveCheckedTarget` (the §7 SSRF check on the
  resolved address), then a connection to exactly that IP, directly or as the CONNECT target through the upstream proxy
  (DNS rebinding can't reach a forbidden address; the gate's name check still runs first and still records its 403).
  A CONNECT on a closed gate's socket, or after plain requests on a LAN keep-alive connection, is destroyed
  (`lanConnectAllowed`). Loopback clients — emulator aliases 10.0.2.2 / 10.0.3.2 → 127.0.0.1; loopback, alias and
  noProxy targets go direct; everything else through the upstream proxy when one is set. 30 s connect timeout.
- **Exchange.** Created at the CONNECT: `kind: 'tunnel'`, `method: 'CONNECT'`, `url: https://host:port/` (always
  with the port; IPv6 bracketed), `requestHeaders` = the CONNECT's own headers minus `proxy-authorization` (the LAN
  token), `tunnelBytes {sent, received}` updated as data flows (coalesced 'exchange' events, ≤ 1 per 100 ms),
  `state: 'pending'` and **no `status`** while open; `completed` when both sides closed; `error` with a message when
  either side failed mid-stream. Timings: `dnsMs` (when a name was looked up), `connectMs` (to the server, or to the
  CONNECT answer through an upstream proxy), `delayMs` (profile latency). The app gets `200 Connection established`
  only after the upstream connection is up; failures answer the CONNECT: 403 (LAN guard; exchange `status: 403`,
  `error` = the SSRF text) or 502 (unreachable; `status: 502`).
- **Rules.** Matched as method `CONNECT` on the tunnel's own URL (a rule made from a tunnel, `https://host:port/*`,
  with no method, matches), and for port 443 also on `https://host/` (a rule written for the site). Only `block` and
  `fault` (not truncate) apply; others are skipped with a note in `error` ("… does not apply to TLS passthrough tunnels
  (not decrypted); passed through."). GraphQL-scoped rules never match.
- **Block / faults after the handshake (deviation from "on the CONNECT").** Failing the CONNECT or the TLS handshake
  makes dart:io fall back to DIRECT (docs/spikes/faults.md), i.e. skip the proxy. So the tunnel opens, the TLS
  handshake with the real server completes, and the connection is cut where the app's first application-data record
  begins (`tls-records.ts` reads only the 5-byte record headers of the app → server direction: TLS 1.2 = first type-23
  record; TLS 1.3 = second type-23 record, the first being the client's Finished; non-TLS = at once). `block` →
  reset (a status can't be sent inside an undecrypted tunnel; `mode: 'status'` adds a note), `fault reset` → RST,
  `dns` → FIN, `timeout` → held until the app gives up or `breakpointTimeoutMs`, then RST. The server sees the
  handshake but never the request. Exchange `blocked`. **Verified with a real dart:io client** (`PROXY …; DIRECT`,
  test "TLS passthrough with a real dart:io HttpClient"): passthrough → 200; blocked → fails in `request.close()`
  ("close" phase), the server is not reached (DIRECT would have reached it).
- **Profile.** `offline` → the `dns` cut; replay with fallback `fail` and no rule → the `dns` cut; `throttle` →
  latency before connecting, then per-direction pacing of the tunnel bytes (`kbps` server → app, `uploadKbps` app →
  server), `dropRate` → a reset cut; `simulated` = the profile label. Throttle rules don't apply (not decrypted).
- `stop()` destroys every tunnel (upstream sockets tracked; downstream sockets belong to mockttp's server).

## mTLS client certificates (§14.3)

- mockttp already passes a per-host map into the upstream TLS options of every passthrough request and WebSocket
  upgrade (`clientCertificateHostMap[host:port] || [host] || ['*']`, spread into the options). The proxy hands it a
  `Proxy` object answering `host:port` lookups from the current certificate list (first pattern that matches host +
  port); plain-host and `*` lookups answer nothing. So the certificate reaches whichever agent is used — the shared
  pool, LAN-guarded agents, the upstream-proxy TLS-in-tunnel agent — and `setClientCertificates` takes effect for new
  connections without restarting. Node's https.Agent puts `pfx` / `cert` / `key` / `passphrase` in the pool key, so
  each certificate gets its own keep-alive connections (and TLS session cache entries); the key material stays inside
  the agent (pool-key strings), never in events / exchanges / errors.
- Validation: `tls.createSecureContext` on each entry; problems in words — wrong passphrase (PKCS#12 MAC failure /
  bad decrypt), key not matching the certificate, not valid PEM / not a valid file, **legacy PKCS#12 encryption
  (RC2-40 / 3DES) unsupported by Node's OpenSSL 3** with the `openssl pkcs12 -export -keypbe AES-256-CBC -certpbe
  AES-256-CBC` hint, invalid host pattern, both or neither of pfx and cert + key. Bad entries are skipped; the setter
  never throws for one (only for a non-array).
- `Exchange.clientCertificate` = the matching pattern, set when the pool picks the agent for an `https:` / `wss:`
  upstream request (the request-plan hook, below) — i.e. only exchanges that reached the server; reused connections
  carry it too (the certificate was presented on that connection).

## Upload / WebSocket / SSE throttling (§14.4)

- `pace.ts` models one direction of a link: an item arriving at `t` starts at `max(t + latency, previous end)` and
  is delivered at the end of its transmission (`bytes × 8 / kbps` ms). Latency never accumulates (two events 10 ms
  apart arrive 10 ms apart, both late by `latency`); bandwidth queues like a link. Byte streams are cut into ~50 ms
  pieces.
- **Request bodies:** throttle rule `uploadKbps` or profile `uploadKbps` → the ClientRequest's `write` / `end` are
  paced (`shapeUpload`, applied by the pool's per-request view); writers are paused beyond 64 KB queued, the real
  `end()` follows the last byte, so `sendMs` shows the pacing. Applies to plain and hooked routes, HTTP and HTTPS.
- **WebSocket frames:** throttle rules now apply to `ws(s)://` (`WEBSOCKET_ACTIONS` gains `throttle`; `ruleProblem`
  allows it) and the throttle profile applies to upgrades. On mockttp's `ws-upgrade` (before its pipe attaches), the
  app-side socket's `send` / `ping` / `pong` / `close` are paced with `{latency, kbps}` and the server side's with
  `{latency, uploadKbps}` — in order, close included; anything due after a side closed is dropped. `dropRate` resets
  the upgrade (like a drop fault). `simulated` = the rule / profile label. Frames are recorded when the proxy
  receives them.
- **SSE:** on an event-stream response the shaper also delays each chunk by `latencyMs` (backpressure only beyond
  1 MB queued, so delays don't add up), on top of the latency added before forwarding the request (so an SSE's first
  event is `2 × latency` late, later ones `latency` late relative to the server). `kbps` pacing as before.
- **Labels:** custom profiles / rules with upload show it: "+250 ms, 2000 kbps, 500 kbps up", "64 kbps up".
  Preset labels are unchanged ("Slow 3G").

## WebSocket / SSE replay (§14.5)

Format as emitted by R's `toReplay` (handled): WebSocket `{kind:'websocket', method:'GET', url: ws(s)://…, status:101,
headers, frames}`, SSE `{kind:'sse', …, frames, requestBodyHash?}`; frames in recorded order with absolute `at`.
- `ReplayStore` accepts `ws:` / `wss:` URLs for `kind: 'websocket'` (status 101) only; other kinds keep 200–599.
- **SSE:** a hit on an SSE entry routes the request to a step of ours (`replay-stream`: own `handle` on a mockttp step,
  same trick as the WebSocket steps). Head = recorded status + headers (framing headers and `content-encoding` dropped;
  `content-type: text/event-stream` / `cache-control: no-cache` added if missing; CORS like a mock), then the events in
  wire format at their recorded gaps — first event at once, gaps ≤ `MAX_REPLAY_GAP_MS` (5 s), negative gaps clamped —
  then the end. Written through mockttp's tracked response, so the usual SSE recording produces the frames; state
  `mocked`, `simulated: "Replayed from <name>"`; the app closing early is still `mocked` ("The app closed the event
  stream."). **POST streams** (`requestBodyHash`): the step reads the body, hashes it and chooses then; a non-stream
  hit is written whole; a miss follows the fallback — `passthrough` hands the request to a mockttp passthrough step
  (recorded like any pass-through; the profile's kbps applies, its latency doesn't on this path), `fail` closes like
  offline.
- **WebSocket:** a rule-less upgrade with a WebSocket entry is accepted locally (`ws-replay` route; `ws.Server`
  noServer, no permessage-deflate, 16 MB message limit; the recorded subprotocol is chosen when the app offers it,
  else the app's first). Script (`wsScript`): server frames before the app's first message play after the upgrade;
  after the app's k-th text / binary message (by order, not content) the server frames that followed the k-th message
  in the recording play — the first one as long after the message as recorded, later ones with their gaps (≤ 5 s
  each); a recorded server close closes with its code / reason (1005 / 1006 → close without a code) and stops the
  script; frames after it are dropped. Extra app messages get no answer; the app's own pings / pongs / close are not
  keys. **Redacted binary frames** (no `base64`, `truncated`) are sent as zero bytes of the recorded size, at most
  64 KB; text frames send the kept text. Nothing is contacted (tested against `ws://127.0.0.1:1`). Exchange: status
  101, frames recorded both ways, state `mocked`. Fallback `fail` without an entry still closes the upgrade.
- Streams whose recording had `framesDropped` simply start at the first kept frame.

## Idle pool + retry (§14.6)

- `IDLE_SOCKET_TIMEOUT_MS = 30 000` via the agents' `timeout` option on every keep-alive agent of ours (pool, LAN gate
  agents, upstream-proxy agents). Node's `keepSocketAlive` applies it to free sockets (a shorter server
  `Keep-Alive: timeout=N` hint wins: N − 1 s); its agent destroys only *free* sockets on timeout, so in-use sockets
  (slow responses, long streams) are unaffected. Before this, idle sockets never timed out.
- **Retry** (`upstream-request.ts`): when a request on a *reused* socket errors with ECONNRESET / EPIPE before any
  response byte, for GET / HEAD / OPTIONS / TRACE / PUT / DELETE, once the whole request was written (body ≤ 1 MB,
  kept for the resend), and not because mockttp aborted it: the free sockets of that pool key are dropped, a new
  `ClientRequest` with the same options goes through the same agent view (fresh connection; timings and upload pacing
  again), and its `response` / `information` / `error` events are re-emitted on the original request, which is what
  mockttp holds; later errors of the dead original are swallowed. Timings restart (`reused` removed, connection phases
  of the new socket). POST / PATCH are never retried (502 as before).
- The per-request view replaces `timedAgent` (kept exported in `timing.ts`); every view is still recorded in the
  `ownAgents` WeakSet, so `bypassPatchedRequests` keeps routing our requests to Node's real `request` under VS Code
  (v7 test green). The replacement request is built with `new http.ClientRequest`, never through the patched module.
- Pool API: `setTimings` → `setRequestPlan((connection, {protocol, hostname, port}) => {timings?, uploadKbps?})`.

## noProxy (H's request, §14.6)

`UpstreamProxyConfig.noProxy` (parsed by `parseNoProxy`: `host`, `*.suffix` = subdomains only, `.suffix` likewise,
`*` = everything, IP literals, `[v6]`, optional `:port`; malformed entries throw from `setUpstreamProxy`). Matching
targets connect directly from the upstream-proxy agents (HTTP, HTTPS, WebSocket) and passthrough tunnels; for LAN
clients still through the guard, to the checked address (TLS verified against the name).

## Requests / notes for the lead

- `network.ts` (lead-owned): presets need upload values — **Slow 3G `uploadKbps: 400`, Fast 3G `uploadKbps: 750`** —
  and `NetworkPreset` needs `uploadKbps?: number`, and `presetProfile()` must copy it (the proxy reads `uploadKbps`
  from the profile; today `presetProfile` drops it). `describeProfile` could add "N kbps up" for custom profiles (the
  proxy's own labels already do).
- Contract wording to fold in: tunnel URLs always carry the port; open tunnels have no `status`; block / faults on
  passthrough hosts act after the TLS handshake (reset / FIN / hold), not on the CONNECT; rules match a tunnel as
  method CONNECT; throttle rules now apply to WebSocket URLs; SSE first-event latency is 2 × latency.
- Residual: a TLS 1.3 HelloRetryRequest flow reads like TLS 1.2 to the record finder, so the cut lands on the client's
  Finished — still after the client's handshake completed, so the app fails at the request. TLS 1.3 0-RTT early data
  (dart:io doesn't send it) would be cut at once.
