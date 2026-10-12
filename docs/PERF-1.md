# PERF-1 — proxy and extension performance baseline (2026-10-12)

First measured baseline for the proxy (HTTP/1.1, gRPC h2c relay, gRPC-Web reader, exchange store) and for the
extension bundle and its activation cost. These are measurements, not estimates. Where a number is derived, the
derivation is stated.

## 1. Environment

| | |
|---|---|
| Machine | Apple M4 Max (14 cores), 36 GB, macOS 27.0.1 |
| Node | v26.4.0 (the benches). VS Code's extension host runs its own Electron Node, so absolute numbers will differ there |
| mockttp / esbuild | 4.6.3 / 0.24.2 |
| Code measured | `packages/proxy/dist` built 07:20 from `ffdd419` plus the uncommitted REVIEW-13 working tree, copied to a scratch dir so later rebuilds could not change it mid-run. The extension bundle is `packages/extension/dist/extension.js` (built 07:14), plus scratch rebuilds of the working tree at about 07:28 for the A/B experiments in §3.6 |
| Load | Every bench ran under `nice -n 10`, with other agents working on the machine at the same time. Re-runs agreed within about 10%, except HTTPS 1 MB (see §3.1) |

**Important context for every event-loop number below:** `proxyHost` creates `InterceptProxy` *in the extension host
process* (`extension.ts:137`). Whatever blocks the proxy's event loop also blocks every other extension in that host,
and the other way round.

## 2. Method

The bench scripts are in the session scratchpad (`…/scratchpad/perf/*.cjs`). They are plain Node and import the
proxy dist. Three processes take part, so that client, proxy and upstream don't compete for one event loop:

- **proxy child** (`proxy-child.cjs`): an `InterceptProxy` with default options and `ignoreUpstreamCertErrors`. It is
  driven over IPC (set rules, set a fake codec, reset counters, read stats, take allocation samples).
  - It measures its own CPU (`process.cpuUsage`), its event-loop delay (`monitorEventLoopDelay`, 1 ms resolution, so
    the idle p50 is about 1.0 ms and that is the floor), GC count and time (`PerformanceObserver('gc')`), and heap.
  - Allocations are measured with the V8 sampling heap profiler, with `includeObjectsCollectedByMajor/MinorGC`. That
    gives the total bytes allocated, not just what is retained.
- **upstream child**: Node `http`, `https` (self-signed) and an `http2` h2c gRPC server.
  - `Unary` echoes the request.
  - `ServerStream` writes N messages as fast as backpressure allows, so the stream is not throttled by timers. This
    is unlike `test/grpc-helpers.ts`, which writes one message every 50 ms.
- **client**: the parent process.
  - HTTP uses keep-alive agents: an absolute URI for plain HTTP, and a CONNECT + TLS tunnelling keep-alive agent for
    HTTPS MITM.
  - gRPC uses one HTTP/2 session through a silent `CONNECT` (`Flutter-Intercept-Tunnel: silent`), as grpc-dart does.

Each scenario does a warm-up, then sequential latency (N = 2000 small, 200 × 1 MB, 2000 unary; median, p95 and p99),
then closed-loop throughput for 5 s (16 workers for small, 8 for 1 MB, 32 for gRPC unary). Stream throughput is the
median of 5 calls of 1000 messages, or 3 calls of 20 000 messages, 100 B each. The gRPC soak is 60 s per variant:
8 unary workers plus one stream loop, with the heap after GC at the start and end.

gRPC hook variants:
- `none`: no rules.
- `bpNoMatch`: a breakpoint rule on `*/t.Nope/*`, which never matches.
- `mutate`: `*/t.Echo/*`, set `$.n`, with a JSON fake codec injected through `setGrpcCodec`.
- `script`: `*/t.Echo/*`, with `function onGrpcMessage(m){ return undefined; }`.

Hot paths were profiled with `node --cpu-prof` on the proxy child (200 µs interval, 8 s of load). Activation was
measured by `require()`-ing the bundle in plain Node with a permissive `vscode` Proxy stub (5 runs, median), plus
`--cpu-prof`, mapped back through `extension.js.map`.

## 3. Results

### 3.1 HTTP/1.1 through mockttp, no rules (two runs; "a / b" = run 1 / run 2)

| scheme | body | direct p50 / p99 ms | proxy p50 / p99 ms | added p50 | direct req/s | proxy req/s | proxy CPU per req | ELD p99 / max (ms) |
|---|---|---|---|---|---|---|---|---|
| http | 17 B JSON | 0.06 / 0.15 | 0.17 / 0.38–0.54 | **+0.10 ms** | 62 000 | **10 300–10 900** | **0.12–0.13 ms** | 2.4–2.7 / 5.8–6.4 |
| http | 1 MB | 0.18–0.23 / 0.7–0.8 | 0.86–0.87 / 2.1–3.2 | **+0.65 ms** | 6 600–7 000 | 1 480–1 540 | **1.9–2.0 ms** | 4.6–4.8 / 8.7–11.9 |
| https (MITM) | 17 B JSON | 0.06 / 0.10–0.14 | 0.17–0.28 / 1.1–1.7 | +0.11–0.22 ms | 49 800 | 7 600–9 300 | 0.13–0.14 ms | 2.7–5.7 / **60–63** |
| https (MITM) | 1 MB | 0.61–0.67 / 1.1–5.8 | 1.59–1.63 / 3.3–4.6 | +0.95 ms | 2 190 | 355–728 (noisy) | 3.8–4.4 ms | 2.5–19.8 / 3.1–55 |

- The proxy's main thread saturates at about 10 k small requests/s. Process CPU reaches 110–300% because GC and
  helper threads count too.
- The 60 ms event-loop maxima on HTTPS come from the burst of new MITM handshakes at the start of each load phase,
  not from steady state (§3.4).

### 3.2 gRPC relay (h2c silent tunnel), 100 B messages

| variant | unary p50 / p95 / p99 ms | unary calls/s (32 conc) | proxy CPU per unary call | stream 1000-msg calls msg/s · CPU per msg | stream 20 000 msgs msg/s · CPU per msg | allocated per unary call / per streamed msg |
|---|---|---|---|---|---|---|
| direct (no proxy) | 0.08 / 0.13 / 0.20 | 60 500 | – | 2 650 000 · – | 4 360 000 · – | – |
| **none** (fast path) | **0.22 / 0.37–0.39 / 0.52–0.61** | **14 400** | **78 µs** (39 µs/msg) | 850–950 k · 2.4–2.5 µs | 1.45–1.72 M · **0.9–1.0 µs** | 93 KB / 1.35 KB |
| bpNoMatch | 0.21 / 0.38 / 0.57 * | 13 500–14 200 | 79–83 µs | 780–800 k · 2.2–2.3 µs | 1.70–1.83 M · 0.8–0.9 µs | 93 KB / 1.32–1.37 KB |
| mutate (fake JSON codec) | 0.21–0.22 / 0.36 / 0.54–0.56 | 13 200–14 000 | 82–87 µs | 260–265 k · 6.8–7.6 µs | 413 k · 3.4–3.5 µs | 101 KB / 7.9 KB |
| script (`onGrpcMessage`) | 0.60 / 0.85 / 1.16 | 3 800 | 420 µs | **9 600 · 122 µs** | 150 k · 7.9 µs † | 122 KB / 15.7 KB |

\* The first bpNoMatch run had p95/p99 of 1.1/3.2 ms because it overlapped a bundle build. The re-run is shown.
† Only the first 1000 messages of a call go to the script (`GRPC_SCRIPT_MAX_MESSAGES`). After that the call runs on
the fast path.

- **The fast path holds.** A breakpoint rule that never matches costs nothing measurable (bpNoMatch ≈ none). The fast
  path adds about 0.14 ms p50 per unary call and about 1 µs of proxy CPU per streamed message. Throughput is about
  4× lower than talking to the server directly, because every call goes through mockttp's request pipeline, and that
  is a fixed cost of about 78 µs per call.
- **Mutate** costs about 5 µs more per message: decode, then `applyOps`, then encode, with a cheap codec. A real
  protobuf codec will cost more.
- **Script** is 100× slower per message than the fast path. One worker round-trip of about 105 µs per message
  serializes every hooked message of every call.

60 s soak (8 unary workers plus one 1000-message stream loop):

| variant | msg/s | CPU per msg | proxy CPU | ELD p99 / max | GC | heap after GC: 0 s → 60 s (1000 exchanges kept) |
|---|---|---|---|---|---|---|
| none | 652 k | 1.7 µs | 114% | 1.77 / 8.8 ms | 4001 GCs, 3.3 s (5.5% of wall) | 19.7 → 31.4 MB |
| bpNoMatch | 666 k | 1.7 µs | 115% | 1.74 / 7.5 ms | 4090, 3.3 s | 19.7 → 31.4 MB |
| mutate | 293 k | 3.9 µs | 113% | 2.18 / 6.1 ms | 5297, 2.0 s | 20.0 → 31.3 MB |
| script | 7.3 k | 197 µs | 144% | 2.06 / **24.2 ms** | 1375, 1.2 s | 20.2 → 22.3 MB |

There is no leak. Heap after GC is flat once the ring buffer is full. The heap sampled without GC mid-soak reached
80–150 MB, which is garbage churn and not retained memory.

### 3.3 gRPC-Web passive reader

In-process `GrpcWebRecorder` (16 KB chunks, median of 10):

| body | CPU ms per MB on the wire |
|---|---|
| binary, 1 × 8 MB message | 0.02 |
| binary, 10 k × 1 KB | 0.21 |
| binary, 100 k × 100 B (stops at the 10 k frame cap) | 0.19 |
| text (base64), 1 × 8 MB | 0.74 |
| text, 10 k × 1 KB | 0.95 |
| binary + gzip, 10 k × 1 KB (9.8 MB decoded) | 0.44 per *decoded* MB |

End to end through the proxy, the same bytes served as `application/grpc-web+proto` versus
`application/octet-stream` cost 1.3–2.4 ms of proxy CPU per MB for both. The difference is within noise (≤ 0.4 ms
per MB). Event-loop max was ≤ 4.2 ms on 8–13 MB bodies. **The reader is not a cost driver.** The general body
recording path (§4, item 8) is.

### 3.4 Event-loop blocking (max per scenario)

| scenario | ELD max |
|---|---|
| idle floor | ≈ 1.0 ms (resolution) |
| gRPC fast path, mutate, gRPC-Web 8 MB | 3.5–8.8 ms |
| gRPC script soak | 24 ms |
| first HTTPS request to a new host (leaf certificate + handshake: 35 ms wall, 24 ms CPU) | 10.7 ms |
| 16 / 64 new MITM tunnels at once | 7.2 / **22.7 ms** (about 1.5 ms of main-thread CPU per handshake: RSA-2048 leaf + upstream TLS) |
| HTTPS small, under load, with 16 new tunnels | 60–63 ms |

Nothing blocks for more than 25 ms in steady state. The worst spikes are bursts of TLS handshakes.

### 3.5 Exchange store (10 k exchanges driven)

| case | kept | retained heap + external | per kept exchange | caps |
|---|---|---|---|---|
| HTTP 10 k small JSON, defaults | 1000 | +2 MB | ~2 KB | count cap holds |
| HTTP 10 k small JSON, `maxExchanges` 10 000 | 10 000 | +10 MB | ~1 KB (response headers dominate, then timings) | – |
| HTTP 10 k × 64 KB text, `maxExchanges` 10 000 | 4096 | +262 MB | 66 KB | 256 MB `maxStoredBodyBytes` holds |
| HTTP 2 k × 1 MB text, defaults | 256 | heap 21 MB + **external 304 MB**; RSS 895 MB | 1.2 MB | budget holds; RSS is about 3.5× the budget |
| gRPC 10 k unary, defaults | 1000 | +2 MB | ~1.7 KB (frames dominate) | holds |
| gRPC 1 k streams × 1000 × 100 B, defaults | 1000 × 500 frames | +134 MB | 137 KB | holds, but `frameCost` counts 84 KB per exchange (it under-counts small frames by 1.6×) |
| gRPC 60 streams × 600 × 16 KB, defaults | 32 | +262 MB | 8.4 MB | budget holds; RSS 728 MB |

What dominates: response bodies (as strings; large ones are external), then recorded frames (a 100 B gRPC message
costs about 274 B retained: 136 B of base64 plus about 140 B of object overhead), then headers.

### 3.6 Extension bundle and activation

- `dist/extension.js`: **2.77 MB** minified (793 KB gzipped).
- What dominates the bundle:

| package or area | size |
|---|---|
| zod | **520 KB** (of which **264 KB is `zod/v4/locales`**, all unused, and 55 KB is a zod v3 copy pulled in by the MCP SDK and zod-to-json-schema) |
| packages/proxy | 308 KB |
| src/agent | 206 KB |
| mockttp | 168 KB |
| ajv | 110 KB |
| lodash | 83 KB |
| MCP SDK | 82 KB |
| src/ui | 73 KB |
| src/grpc | 72 KB |
| @peculiar/x509 + asn1 | ~260 KB together |

- `require()` of the bundle (plain Node, vscode stubbed): **124 ms, 25.5 MB heap**. The profile breaks it down as:
  - 47 ms compiling the 2.7 MB script;
  - about 50 ms evaluating the proxy and mockttp tree (TLS secure context, asn1, reflect-metadata, undici);
  - about 10 ms evaluating zod.
- **The proxy is not lazy.** `extension.ts:137` lazily `require`s `@flutter-intercept/proxy` ("mockttp & co. … load on
  the first intercepted launch"). But `proxyHost.ts:40` and `ui/clientCerts.ts:21` import the *value*
  `parseHostPattern` from the package index, so esbuild evaluates the whole proxy and mockttp at activation.
  A/B tests with scratch builds:

| build | require ms | heap | bytes |
|---|---|---|---|
| current | 124 | 25.5 MB | 2.79 MB |
| `parseHostPattern` from `@flutter-intercept/proxy/hosts` | **72.7** | **17.6 MB** | 2.79 MB |
| zod locales → `en` only | 124 | 25.2 MB | **2.52 MB** |
| both | **68.5** | 17.3 MB | 2.52 MB |

- **gRPC, schema and codegen code load eagerly**, through static imports in `extension.ts:28-32`. Their top level is
  cheap (constant tables), so the cost is compile time only: about 170 KB ≈ 6% of the bundle ≈ 3 ms. The MCP SDK,
  ajv and hono also load eagerly (≈ 300 KB with zod v3).
- `activate()` itself was not measured; it needs a real extension host.

### 3.7 Hot paths (`--cpu-prof`, proxy process)

**gRPC unary fast path** (busy 6.3 s of 8.4 s; inclusive: `grpcRelay` 11.5%, mockttp `preprocessRequest` 7.9%,
`emitChange` 4.9%):

| function | self time |
|---|---|
| GC | 8.2% |
| node:events (add/remove listeners, per call) | 12% |
| node http2 internals | 10.6% |
| mockttp | 6.7% |
| js_stream_socket `ondata` | 3.3% |
| **`evict`** | **2.5%** |
| `recordedHeaders` + `forwardableHeaders` | 3.1% |
| **`Server.address`** (called through mockttp `preprocessRequest` → `this.port` → `getsockname`, once per request) | **1.7%** |
| **`findOnSocketChain`** (`lanGateOf` walks the socket chain about 6× per call) | **1.4%** |

**gRPC streaming fast path** (`GrpcMessageParser.push` 55% inclusive):

| function | self time |
|---|---|
| **`messageFrame`** (base64 of every message: `toString('base64')` 6.6% + subarray/FastBuffer) | **14.5% inclusive** |
| **`addFrame`** (`splice` + `shift` on a 500-element array, per message) | **7.9% self** |
| GC | 7.9% |
| `Buffer.from` copy in the parser | 3% |

**HTTP 1 MB:**

| function | share |
|---|---|
| socket writes and the Node HTTP client | ~30% |
| GC | 10.8% |
| our capture `Buffer.concat` (`taps.ts:148`) | 5% |
| `bufferToBody` `isUtf8` + `utf8Slice` (`body.ts:13`) | 6% |
| **mockttp's own full-body `Buffer.concat`** (`buffer-utils.js:112`; it buffers because a `'response'` listener exists) | **3%** |

**HTTPS small:**

| function | self time |
|---|---|
| Node `ClientRequest` + agent | ~14% |
| legacy `url.parse` inside mockttp | 4% |
| mockttp `getUpstreamTlsOptions` per request | 1.7% |
| `evict` | 1.2% |

**gRPC script:** 20% "(program)", which is native postMessage and structured clone. The proxy is mostly idle,
waiting on the worker.

Separately, `evict` scales with `maxExchanges`. Once the store is full, gRPC unary costs **71–75 µs per call at 1000
and 90–95 µs at 10 000** (+25%), because `evict` copies every key on every new exchange.

## 4. Improvement opportunities (ranked by impact ÷ effort)

| # | What | Where | Measured impact | Effort |
|---|---|---|---|---|
| 1 | **Import `parseHostPattern` from the `./hosts` subpath** (it is already exported) so that activation no longer evaluates the proxy and mockttp. Add a bundle test that mockttp isn't evaluated on `require`. | `extension/src/proxyHost.ts:40`, `extension/src/ui/clientCerts.ts:21` | Activation require 124 → 73 ms (−41%), −8 MB heap | XS |
| 2 | **`evict()` copies every store key on every new exchange** once full (`[...this.store.keys()]`). Iterate the Map directly (deleting during iteration is safe), or keep an oldest-first cursor. | `proxy/src/intercept-proxy.ts:1854-1860` (`evict`) | 2.5% of unary CPU at 1000; +25% CPU per call at `maxExchanges` 10 000; ~8–80 KB of garbage per exchange | XS |
| 3 | **Don't base64 every streamed gRPC message.** Keep only the newest `maxFrames`: store the raw `kept` Buffer and encode it lazily (at snapshot or emit), or skip encoding for frames that will be shifted out. Replace per-message `shift()` with batch trimming (let the array grow to 2×max, then `splice` half) or a ring buffer. | `proxy/src/grpc.ts:224` (`messageFrame`), `:284` (`GrpcFrameRecorder.push`); `intercept-proxy.ts:1794-1806` (`addFrame`) | ~22% of streaming CPU (14.5% + 7.9%) and a large share of streaming allocations | S–M |
| 4 | **Drop the duplicate response buffer.** The `'response'` listener, which exists only for refused WebSocket upgrades, makes mockttp `asBuffer()` every response up to `maxBodySize` (5 MB) in addition to our taps capture. Detect refused upgrades another way, then remove the listener (mockttp only buffers when `listenerCount('response') > 0`). | `intercept-proxy.ts:859`, `:688`; mockttp `mockttp-server.js:541-545` | 3% CPU on 1 MB bodies; up to 5 MB of transient memory per in-flight response | S–M |
| 5 | **Script hooks serialize all hooked messages through one in-flight worker call.** Pipeline or batch messages per `postMessage`; skip the per-message `base64` + decode for `onGrpcMessage` scripts that never read `m.base64`/`m.json` (cheap static check, like `mentionsGrpcHooks`). | `proxy/src/script.ts:270` (`ScriptRunner`), `intercept-proxy.ts:4473` (`grpcScriptMessage`), `:2825` (`runScript`) | Streams under a script: 9.6 k msg/s (vs 900 k); unary 3.8 k/s; 24 ms ELD max in the soak | M |
| 6 | **Per-call fixed costs on the gRPC relay:** cache the LAN gate per socket (WeakMap) instead of walking `findOnSocketChain` about 6 times per call; cache mockttp's port (patch `get port`/`address` after `listen`, the way `taps.ts` already patches mockttp, or upstream a fix); build `recordedHeaders`/`forwardableHeaders` once per call. | `proxy/src/lan.ts:456,480`; `intercept-proxy.ts` (`lanGateOf` call sites); mockttp `mockttp-server.js:164-179,478` | ~5–6% of unary CPU | S |
| 7 | **Stub `zod/v4/locales` to English only** (esbuild `onLoad`, same pattern as the existing `stubs`). Later, lazy-load the MCP SDK, ajv, hono and the zod v3 copy when the MCP server actually starts. | `extension/build.mjs`; `agent/mcp/*` | −264 KB (−9.5% bundle), ~−4 ms compile; MCP lazy-load is another ~300 KB | XS / M |
| 8 | **Body recording copies and decodes every body up to 5 MB on the event loop** (`Buffer.concat` + `isUtf8` + `toString`). The bodies are kept as strings, which become external memory, so RSS peaked at 895 MB under a 256 MB budget. Keep Buffers in the store and decode lazily when the UI or agent reads them; also decode only the prefix the UI shows. | `proxy/src/taps.ts:148`, `proxy/src/body.ts:13` | ~11% CPU on 1 MB responses; RSS headroom | L |
| 9 | **`frameCost` assumes 32 B of overhead per frame; the real overhead is about 140 B.** The byte budget under-counts small frames by 1.6× (worst case about 150 MB for 1000 × 500 tiny frames). Raise the constant to about 150. | `proxy/src/frames.ts:56` | Correctness of the memory cap | XS |
| 10 | **TLS handshakes:** mockttp signs with one shared RSA-2048 leaf key, about 1.5 ms of main-thread CPU per MITM handshake (64 at once = 23 ms of blocked loop). An ECDSA P-256 CA and leaf would cut this several-fold; session tickets already help when the app reconnects. | mockttp `util/certificates.js:246-267` | Event-loop spikes on connection bursts and at app start | M (mockttp) |

Minor: `grpcMutate` parses `new URL(call.ex.url)` per message (`intercept-proxy.ts:4393`), so the path could be
cached per call. `Base64Stream.push` runs a whole-chunk regex plus `replace` (`grpc-web.ts:42`), at 0.75–0.95 ms per
MB; this is fine.

## 5. Proposed regression budgets (candidate tests)

The budgets are about 2× the M4 Max numbers. On shared CI runners, prefer the **ratio** and **structural** checks,
which don't depend on the machine.

| # | Budget | Measured now | Kind |
|---|---|---|---|
| B1 | A breakpoint or mutate rule that does not match a call costs ≤ 10% CPU per call vs no rules (and `grpcTransformStats.created` stays unchanged, as the existing test checks) | ≈ 0% | ratio |
| B2 | The gRPC fast path adds **≤ 3 µs of proxy CPU per streamed message** (20 000 × 100 B) and **≤ 150 µs per unary call** | 0.9–1.0 µs / 75–80 µs | absolute |
| B3 | gRPC unary added latency p50 ≤ 0.5 ms; stream ≥ 500 k msg/s | +0.14 ms; 1.45–1.8 M | absolute |
| B4 | Per-call CPU at `maxExchanges` 10 000 is within 10% of 1000 (fails today, +25%; add with fix #2) | +25% | ratio |
| B5 | Mutate with a trivial codec ≤ 10 µs per message | 3.4–7.6 µs | absolute |
| B6 | Script `onGrpcMessage` ≥ 5 k msg/s on one stream (raise after #5) | 9.6 k | absolute |
| B7 | HTTP via proxy: ≤ 0.3 ms CPU per small request; ≤ 4 ms per 1 MB plain-HTTP request | 0.12–0.13 / 1.9–2.0 ms | absolute |
| B8 | Steady-state event-loop delay max ≤ 50 ms in every scenario above, excluding the first TLS burst | ≤ 24 ms | absolute |
| B9 | Store caps: after 10 k unary calls with defaults, 1000 exchanges are kept and heap growth is ≤ 10 MB. After 2 k × 1 MB, the sum of stored body sizes ≤ `maxStoredBodyBytes` and heap+external ≤ 1.3× the budget. Every exchange has ≤ 500 frames | +2 MB; 304 MB external for 256 MB | structural |
| B10 | Requiring `dist/extension.js` with a vscode stub does **not** evaluate mockttp (assert no mockttp module or `require_mockttp` side effect, e.g. no `tls.createSecureContext` call). Bundle size ≤ 2.8 MB (≤ 2.55 MB after #7) | evaluated; 2.77 MB | structural |
| B11 | gRPC-Web reader ≤ 0.5 ms per MB binary and ≤ 1.5 ms per MB text (in process) | 0.2 / 0.95 | absolute |

A `packages/proxy/bench/` folder holding the scratch scripts (with a `--quick` mode of about 20 s) would make B1–B9
runnable on demand. B1, B4, B9 and B10 fit as ordinary vitest tests.
