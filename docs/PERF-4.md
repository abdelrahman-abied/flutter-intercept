# PERF-4 — 0.16.0 performance pass (2026-11-20)

The measured performance pass for 0.16.0 (stateful mocks §22, from real traffic §23, sign-in / body examples / dynamic
values / more sources / big collections §24), compared with 0.15.0. It covers what 0.16.0 adds to the hot paths:
- **per request**: the proxy's rule index and path trie (§24.5, §24.8, §24.11); `handler` rules, one async in-process
  call per answer (§22.1); the answer pipeline (sign-in gate, body examples, store, dynamic values; §24.10);
- **drift**: every finished exchange on a collection's servers is compared with its example (§23.3);
- **readers**: Swagger 2.0, Insomnia v4 / v5, Bruno folders (§24.4, §24.7); resource detection and the store seed
  (§22.3, §22.4); `collectionFromTraffic` (§23.1);
- **bundle and activation**: everything above is in `dist/extension.js`;
- **webview**: the Data view, drift lists and the existing perf tests.

These are measurements, not estimates. Where a number is derived, the derivation is stated.

## 1. Environment

| | |
|---|---|
| Machine | Apple M4 Max, macOS 27 |
| Node | v26.4.0 (the benches). VS Code's extension host runs its own Electron Node |
| Code measured | **0.15.0** = the "Version 0.15.0" commit (`ef92c5c`), its proxy and extension rebuilt from that commit in a scratch folder against the same `node_modules` (the lock file is unchanged since). **0.16** = the working tree with every REVIEW-16 fix |
| Load | No other agent editing or building. Load average 2–6 from other desktop processes; proxy benches under `nice -n 10`. Compare rows within a table, not with PERF-3 |

## 2. Method

Scripts in a scratch folder outside the repo (`perf4/`):
- **Proxy per request** (`e2e/bench.js` + `e2e/child.ts`): PERF-3 §2's method. The proxy alone in a child process,
  bundled twice by esbuild — once from 0.15.0's sources, once from 0.16's — so both versions run in the same harness.
  Plain HTTP through the proxy (absolute URI), keep-alive, 16 concurrent, 300 warm-up requests, then 3 000 measured
  requests per case; proxy CPU = `process.cpuUsage()` in the child over the measured requests. Collection rules come
  from each version's own `toRules` on PERF-3's synthetic collection (`/api/res<i>/:id` and `/api/res<i>/:id/items/:item`,
  GET / POST, a query example on every fourth endpoint: rules = 1.25 × endpoints). The upstream answers `{"up":true}`
  and the mocks `{"ok":true}`; the first answer of every case is checked, so a "hit" that is really a miss fails the run.
  - **miss**: the collection is for another origin (every request of an app pays this while a collection is on);
  - **same-host miss**: the collection's own host, a path no rule matches (PERF-3's "hit-last" target, see §4 #2);
  - **hit-last**: `GET /api/res<n−1>/42`, the rule tried last (checked with `findRule`), answered by its mock.
  Three rounds; the order of rule counts and of the two versions alternates between rounds.
- **Fake backend end to end** (same harness, 0.16 only): the CLI's `loadCollections` (the host's
  `MockCollectionsCore`, run headless) on three OpenAPI files — a store resource seeded with **1 000 records** (135 KB
  list), a login + protected `/profile` (sign-in on, the request carries a token from the login), and a `/quote` with
  two examples chosen by body plus a `/random` with six dynamic placeholders. Every case is compared with a plain
  `mock` rule answering the same bytes. Each case gets a fresh child (so `create` doesn't grow the list measured next).
- **Handler alone** (`e2e/handler-micro.ts`): the same handlers called in process, as the proxy calls them; best of
  5 × 500–5 000 calls.
- **Rule matching alone**: the repo's `packages/proxy/test/perf/rule-match.ts`, indexed and with `FI_PROXY_LINEAR=1`.
- **Drift** (`drift/bench.ts`): the real `MockCollectionsCore` built as the unit tests build it (in-memory fs), an
  OpenAPI collection whose `GET /catalog` example is a 100 KB JSON list (1 or 2 000 endpoints in the file), and
  real-server answers of the same size with one added field per record. Per exchange: 12 batches of 50 through
  `observeExchange` + `flushDrift(50)`. Burst: 500 such exchanges fed over ~1.1 s with the real debounce (500 ms, 50
  per tick), a 5 ms heartbeat timer and `monitorEventLoopDelay` on the same event loop.
- **Readers** (`readers/gen.js`, `readers/bench.ts`): generated inputs (sizes in §3.3); the pure parsers (best of 5),
  then the headless core's whole load (read, parse, rules, resources, seed) through `loadCollections`.
- **Bundle and activation**: `dist/meta.json` of both builds compared per input; `require()` of `dist/extension.js`
  with a stub `vscode` (PERF-3's `req.js`), 7 runs each, 0.15.0 and 0.16 alternating.
- **Webview**: the existing `packages/webview/test/perf-*.tsx` (happy-dom).

## 3. Results

### 3.1 Proxy, per request

#### Collection rules, 0.15.0 vs 0.16 (3 rounds; ranges)

| endpoints | rules | case | version | req/s | p50 ms | p99 ms | proxy CPU per req (ms) | added vs 0 rules |
|---|---|---|---|---|---|---|---|---|
| 0 | 0 | miss | 0.15.0 | 10 220–10 258 | 1.35–1.36 | 3.19–3.43 | 0.1438–0.1467 | — |
| 0 | 0 | miss | 0.16 | 10 065–10 213 | 1.34–1.36 | 3.68–3.75 | 0.1451–0.1480 | — |
| 500 | 625 | miss | 0.15.0 | 8 044–8 140 | 1.71–1.74 | 3.87–3.97 | 0.1703–0.1711 | +0.025 |
| 500 | 625 | miss | 0.16 | 10 229–10 342 | 1.34 | 3.58–3.62 | 0.1449–0.1469 | **none measurable** (−0.002) |
| 500 | 625 | same-host miss | 0.15.0 | 7 977–8 197 | 1.71–1.76 | 3.84–3.95 | 0.1702–0.1726 | +0.026 |
| 500 | 625 | same-host miss | 0.16 | 10 196–10 282 | 1.33–1.36 | 3.47–3.72 | 0.1448–0.1478 | **none measurable** (−0.003) |
| 500 | 625 | hit-last | 0.15.0 | 13 061–13 668 | 1.02–1.08 | 2.57–2.71 | 0.0996–0.1034 | (no upstream) |
| 500 | 625 | hit-last | 0.16 | 19 287–19 675 | 0.67–0.69 | 2.11–2.47 | 0.0778–0.0797 | (no upstream) |
| 2 000 | 2 500 | miss | 0.15.0 | 4 748–4 784 | 2.97–3.01 | 6.00–6.02 | 0.2557–0.2578 | +0.111 |
| 2 000 | 2 500 | miss | 0.16 | 10 390–10 470 | 1.32–1.34 | 3.30–3.89 | 0.1381–0.1400 | **none measurable** (−0.009) |
| 2 000 | 2 500 | same-host miss | 0.15.0 | 4 636–4 836 | 2.96–3.09 | 5.67–6.03 | 0.2531–0.2652 | +0.109 |
| 2 000 | 2 500 | same-host miss | 0.16 | 10 321–10 413 | 1.33–1.35 | 3.47–3.57 | 0.1379–0.1402 | **none measurable** (−0.008) |
| 2 000 | 2 500 | hit-last | 0.15.0 | 6 180–6 480 | 2.17–2.32 | 5.10–5.40 | 0.1879–0.1951 | (no upstream) |
| 2 000 | 2 500 | hit-last | 0.16 | 19 536–19 827 | 0.68–0.69 | 2.09–2.21 | 0.0781–0.0790 | (no upstream) |

"Added" = the row's median CPU per request minus the same version's 0-rule median (0.15.0: 0.1460 ms; 0.16: 0.1478
ms). 0.16's negative values are inside the run-to-run spread of the 0-rule rows (0.1451–0.1480): the index leaves no
cost that this bench can see. A hit on the last of 2 500 rules costs 0.0788 ms in 0.16 vs 0.0778 ms at 625 rules.

**§24.5 target (a miss at 2 500 rules ≤ +0.01 ms): met.** 2 000-endpoint collections now run at the 0-rule throughput
(4 748–4 784 → 10 390–10 470 req/s, ×2.2); 0.15.0's +0.11 ms per request at 2 000 endpoints (PERF-3 #1's follow-up)
is gone.

Memory: the compiled rules of `InterceptProxy.setRules` (retained heap after GC, `node --expose-gc`) take
**2.23 MB at 2 500 rules in 0.16 vs 5.75 MB in 0.15.0** (0.93 vs 1.81 MB at 625).

#### Rule matching alone (`packages/proxy/test/perf/rule-match.ts`; best of 5 × 20 000 calls; ms per call)

| endpoints | rules | `compileRules` first / again | `matchRule` other host | same host, no match | known prefix, no match | last GET endpoint | the last rule |
|---|---|---|---|---|---|---|---|
| 500 | 625 | 2.6 / 1.5 ms | 0.00020 | 0.00025 | 0.00037 | 0.00035 | 0.00035 |
| 2 000 | 2 500 | 9.0 / 6.7 ms | 0.00019 | 0.00024 | 0.00038 | 0.00037 | 0.00037 |
| 2 000 | 2 500, `FI_PROXY_LINEAR=1` | 3.5 / 1.9 ms | 0.07584 | 0.09603 | 0.09516 | 0.09675 | 0.07713 |

The index makes matching independent of the rule count (0.2–0.4 µs from 125 to 2 500 rules); `compileRules` costs
5 ms more per reload at 2 500 rules (once per reload, on the extension host). Same shape as the agent's numbers in
§24.8 / §24.11.

#### Fake backend and the answer pipeline, end to end (0.16; 3 rounds; ranges)

| case | req/s | p50 ms | p99 ms | proxy CPU per req (ms), median | vs the plain mock |
|---|---|---|---|---|---|
| plain mock, list body (135 KB) | 8 384–9 441 | 1.34–1.53 | 4.64–5.62 | 0.1904 | — |
| **store list, 1 000 records (135 KB)** | 2 154–2 245 | 6.45–6.70 | 14.56–15.24 | 0.5154 | **+0.325** |
| plain mock, one record | 19 122–19 415 | 0.69–0.70 | 2.08–2.19 | 0.0799 | — |
| **store get** (of 1 000) | 16 139–16 796 | 0.78–0.82 | 2.28–2.98 | 0.0969 | **+0.017** |
| plain mock, create | 17 785–18 020 | 0.73–0.74 | 2.12–2.21 | 0.0846 | — |
| **store create** (list grows to 4 300) | 12 910–13 378 | 0.99–1.01 | 2.94–3.23 | 0.1113 | **+0.027** |
| plain mock, profile | 18 786–18 987 | 0.70–0.72 | 2.11–2.27 | 0.0811 | — |
| **sign-in on, profile with a token** | 16 924–17 295 | 0.77–0.79 | 2.23–2.40 | 0.0881 | **+0.007** |
| plain mock, quote | 17 751–18 510 | 0.71–0.75 | 2.22–2.44 | 0.0850 | — |
| **body example, quote** | 15 800–16 152 | 0.81–0.83 | 2.39–2.49 | 0.0930 | **+0.008** |
| plain mock, random | 19 231–19 705 | 0.68–0.69 | 1.91–2.11 | 0.0786 | — |
| **dynamic values, 6 placeholders** | 16 458–16 639 | 0.79–0.80 | 2.27–2.36 | 0.0920 | **+0.013** |
| collection `mock` rule (no pipeline needed) | 18 273–19 520 | 0.69–0.72 | 2.04–2.37 | 0.0796 | ±0 |

The handlers alone, in process (best of 5):

| handler call | ms | answer |
|---|---|---|
| store list, 1 000 records | 0.298 | 200, 135 046 bytes |
| store get | 0.0042 | 200, 134 bytes |
| store create | 0.0116 | 201 |
| sign-in gate, valid token | 0.0019 | `{fallback: true}`: the rule's own example answers |
| body example | 0.0032 | 200, `example: 200 · pro (by body)` |
| dynamic values | 0.0052 | 200, 188 bytes |

**§22.13 budget (a store hit ≤ 1 ms for 1 000 records, list + serialise): met** — 0.30 ms in the handler, +0.33 ms of
proxy CPU end to end. Everything except the list is ≤ 0.03 ms more than a plain mock. 97 % of the list's handler time
(CPU profile) is `JSON.stringify` of the records: they are null-prototype objects (prototype safety), and V8's fast
stringify path skips those — 135 KB stringifies in 0.094 ms as plain objects and in 0.29–0.30 ms as null-prototype
ones (§4 #3). After any JSON with a number JavaScript writes differently (`10.50`, `1.0`, a big integer) has been
parsed in the host, `stringifyJson` takes its replacer path for every answer: 0.56 ms for the same list (§4 #4).

### 3.2 Drift

| | 1 endpoint in the collection | 2 000 endpoints |
|---|---|---|
| a qualifying exchange, 100 KB JSON body (best / median of 12 batches) | **0.797 / 0.813 ms** | **0.778 / 0.794 ms** |
| reference: `JSON.parse` of that body alone | 0.270 ms | |
| `observeExchange` (queueing only, on the proxy's event) | 0.0018 ms | 0.0009 ms |
| an exchange to another host (dropped in `observeOne`) | 0.0009 ms | 0.0121 ms |

**§23.3 budget (≤ 2 ms per 100 KB body): met.** The finding (`added [].badge`) appeared after the third sample, one
`onDriftChange` event.

Burst — 500 qualifying 100 KB exchanges in ~1.1 s, real debounce (500 ms, ≤ 50 per tick):

| collection | fed in | queue drained after | CPU | longest gap between 5 ms heartbeats | loop delay p99 / max | heap after |
|---|---|---|---|---|---|---|
| 1 endpoint | 1 108 ms | 5 057 ms | 515 ms | **52.7 ms** | 1.3 / 48.9 ms | 22 MB |
| 2 000 endpoints | 1 119 ms | 5 059 ms | 529 ms | **70.5 ms** | 1.3 / 66.6 ms | 53 MB |

The extension host stays responsive between ticks (p99 delay 1.3 ms), but each tick of 50 exchanges blocks it for
about 50 × 0.8 = 40 ms (derived), 53–71 ms measured including the tick's bookkeeping, every 500 ms for 5 s (§4 #5).
500 answers of 100 KB in one second is far above what a Flutter app sends; at tens of qualifying answers per second
a tick takes a few milliseconds.

### 3.3 Readers, detection, seed, from traffic

Inputs (generated): **Swagger 2.0** 1 000 paths × GET / PUT with `$ref`'d definitions and 1 KB examples (2.3 MB) and
1 500 paths (3.4 MB); **Insomnia v4** JSON, 1 500 requests in 30 folders with bodies and headers, 500 mock routes with
1 KB bodies, base + 2 sub-environments (1.1 MB); **Insomnia v5** YAML, the same 1 500 requests as a tree (0.7 MB, no
routes); **Bruno**, `bruno.json` + `collection.bru` + an environment + 40 `folder.bru` + 1 957 requests with a 1 KB
example each = **2 000 files** (2.6 MB, the file limit); **OpenAPI CRUD**, 400 resources × 5 operations = 2 000
endpoints with 20-record list examples; a **recorded session** of 900 endpoints × 2 answers, 10 request + 10 response
headers, ~1 KB JSON bodies with e-mails, phone numbers and tokens, 3 hosts (the REVIEW-16 #12 shape).

| input | time, best of 5 (first run) | result |
|---|---|---|
| `parseSwagger2`, 1 000 paths × 2 (2.3 MB) | 40.9 ms (60.9) | 2 000 endpoints, 3 000 examples |
| `parseSwagger2`, 1 500 paths × 2 (3.4 MB) | 50.0 ms (54.7) | 2 000 endpoints kept (limit), one problem |
| `parseInsomnia`, v4 JSON (1.1 MB) | 15.1 ms (22.1) | 2 000 endpoints, 500 examples |
| `parseInsomnia`, v5 YAML (0.7 MB) | 16.6 ms (27.4) | 1 500 endpoints |
| `parseBruno`, 2 000 files (2.6 MB) | 24.9 ms (30.8) | 1 957 endpoints, 1 957 examples |
| `parseOpenApi`, CRUD 2 000 endpoints | 13.3 ms (23.9) | 2 000 endpoints |
| `detectResources`, those 2 000 endpoints | **2.1 ms** (4.6) | 100 resources (the limit; one problem line for the other 300) |
| `ResourceStore` seed | 5.0 ms (7.0) | 2 000 records |
| `toRules` with `stateful` | 4.5 ms (8.5) | 2 000 rules, 500 `handler` |
| `compileRules` (proxy index + trie) | 4.5 ms (10.2) | |
| `collectionFromTraffic`, 225 / 450 / **900** endpoints | 44.7 / 87.9 / **177.5 ms** | 900 endpoints, 900 examples, 5.98 MB written |

The headless core's whole load (`loadCollections`: read, detect the format, parse, rules, resources, seed):

| collection | best of 5 (first) |
|---|---|
| Swagger 2.0, 1 000 × 2 | 59.5 ms (79.4) |
| Insomnia v4 | 38.2 ms (54.6) |
| Insomnia v5 YAML | 40.2 ms (41.7) |
| OpenAPI CRUD 2 000, 100 remembered resources | 38.7 ms (45.7) |
| **Bruno, 2 000 files** | **287.2 ms** (314.3) |

- **§22.13 budget (detection ≤ 50 ms for 2 000 endpoints): met** (2.1 ms; with the seed 7.1 ms).
- The Bruno load is async: 290–347 ms wall over 6 runs, but a 5 ms heartbeat on the same loop kept firing (49–57
  beats per load) — the time is 2 000 files opened, `fstat`-checked, read and closed one after another (REVIEW-16
  #15g's checked descriptor), plus a `realpathSync` and a `stat` per entry while walking. The longest synchronous step
  is the parse (25 ms, measured alone). §4 #6.
- `collectionFromTraffic` is linear (×2 per ×2 endpoints) and synchronous: 177.5 ms for 900 endpoints. A third of it
  is the shared secret-name check (`isSecretName` on every key and header name), a quarter `sanitisePostman`. §4 #7.
- REVIEW-16's hostile-input fixes stay fixed (their tests in `mocks.review16f2/f3.test.ts` carry the budgets; the
  suites pass, §5).

### 3.4 Extension bundle and activation

| | 0.15.0 | 0.16 |
|---|---|---|
| `dist/extension.js` | 2 678 420 bytes (PERF-3 §6; rebuilt here from `ef92c5c`: 2 678 473) | **2 965 016 bytes** (+286 543 vs the rebuild) |
| `require()` with a stub `vscode`, median of 7 (range) | 67.2 ms (65.5–67.8) | **71.1 ms** (70.5–73.6), +3.9 ms |

Where the bytes went (esbuild metafile, `bytesInOutput` per input, 0.16 minus the 0.15.0 rebuild):

| group | bytes | largest inputs |
|---|---|---|
| new modules in `src/mocks/` | +143 237 | `store.ts` 24 079, `fromTraffic.ts` 22 520, `resources.ts` 11 755, `swagger2.ts` 11 058, `bruno.ts` 10 506, `insomnia.ts` 10 271, `splice.ts` 9 174, `secrets.ts` 7 914, `dynamic.ts` 7 863, `drift.ts` 7 819, `auth.ts` 7 173, `bodyMatch.ts` 4 831, `snapshot.ts` 4 813, `viaPostman.ts` 3 461 |
| existing collection modules | +80 604 | `core.ts` +56 168 (20 502 → 76 670), `service.ts` +8 078, `link.ts` +5 318, `openapi.ts` +4 822, `postman.ts` +2 040, `toRules.ts` +1 773 |
| agents | +32 608 | `tools/store.ts` 10 640 (new), `schema.ts` +12 321, `lmTools.ts` +4 714, `tools/collections.ts` +3 114 |
| proxy | +21 262 | `rule-index.js` 7 993, `handler-flow.js` 5 256, `rules.js` +3 683, `answer-headers.js` 2 809, `http-edits.js` +807 |
| panel / host wiring | +8 187 | `ui/handlers.ts` +3 148, `ui/controller.ts` +2 359, `extension.ts` +955 |
| dependencies | +828 | minifier renaming spread over `@peculiar/*`, `lodash`, `reflect-metadata`; no package added or removed |
| other first-party | −183 | |

Checked: no module is bundled twice (no `packages/proxy/src` next to `dist`, no `cli`, `sidecar` or test file), no new
dependency, js-yaml still loader-only. Nothing big is avoidable: the growth is the release's features, half of it the
new readers, store and traffic modules. Activation grows +3.9 ms for +287 KB (PERF-3: +2.9 ms for +136 KB), in line
with the extra bytes to parse and compile.

**Budget: 3 000 000 (temporary, set while 0.16.0 was built) → 2 990 000** (2 965 016 + 20 KB, rounded up as PERF-3
did).

### 3.5 Webview (happy-dom; `packages/webview/test/perf-*.tsx`)

| test | case | time |
|---|---|---|
| `perf-store` (§22.13) | Data view first render, 100 resources | 14.4 ms |
| | 5 000-record table (capped) | 14.9 ms |
| | filter keystroke / filtered answer | 0.4 ms / 7.9 ms |
| `perf-collections` (§21.9, §23.3) | filter 2 000 endpoints (5 shapes) | 0.00–0.34 ms |
| | first render, 2 000 endpoints (capped) / filter keystroke | 27.2 ms / 0.7 ms |
| | `driftedEndpoints`, 2 000 × 20 changes | 0.53 ms |
| | 2 000 out-of-date endpoints: capped render / opening "Out of date" | 21.5 ms / 10.9 ms |
| `perf-list` (PERF-1) | filter at 10 000 rows (6 shapes) | 0.12–1.42 ms |
| | snapshot render 1 k / 10 k (36 rows in the DOM) | 7.3 / 8.5 ms |
| | keystroke 1 k / 10 k | 1.6 / 4.9 ms |
| `perf-certs` (PERF-2) | exchange update, empty vs 1 000 hosts + 50 certificates | 2.15 / 2.06 ms |
| | open list 25 / 250 / 1 050 rows | 1.8 / 15.0 / 68.4 ms |

All within their tests' budgets (Data view < 30 ms, filters < 50 ms, drift list < 20 ms, opening < 50 ms).

## 4. Findings

| # | Finding | Status |
|---|---|---|
| 1 | The rule index removes the per-rule cost: a miss at 2 500 rules costs nothing measurable (0.15.0: +0.11 ms), 2 000-endpoint collections run at ×2.2 the throughput, and the compiled rules take 2.2 MB instead of 5.8 MB. `compileRules` +5 ms per reload at 2 500 rules | OK; §24.5 target met |
| 2 | **PERF-3 §3.1's "hit-last" rows at 500 and 2 000 endpoints were misses.** Their target, `/api/res<n−2>/42/items/7`, is a POST endpoint in that synthetic collection (`i % 3 === 0`) asked with GET: no rule matched (checked with `findRule`) and the real upstream answered. They measured a same-host miss — every rule tested — so PERF-3's conclusions stand; only the label was wrong. The 100-endpoint row was a real hit | Corrected here: those rows are "same-host miss" in §3.1, and the bench now checks the first answer of every case |
| 3 | A store list of 1 000 records: 0.30 ms in the handler, +0.33 ms of proxy CPU end to end; 97 % is `JSON.stringify` of null-prototype records, which V8 serialises ~3× slower than plain objects | Accepted: within §22.13 (≤ 1 ms); null-prototype records are a prototype-safety decision (REVIEW-16 #15c). Lists past a few thousand records would be the case to revisit |
| 4 | `resources.ts` remembers number texts with one process-wide flag: once any JSON with `10.50` / `1.0` / a big integer has been parsed by the host, every store answer stringifies through a replacer — 0.30 → 0.56 ms for the 1 000-record list | Accepted (within budget). Follow-up: a flag per store or per parsed value |
| 5 | Drift: 0.8 ms per 100 KB exchange (budget 2 ms). A burst of 500 such exchanges in 1 s blocks the extension host 53–71 ms every 500 ms for 5 s (ticks of 50) | Accepted: far above real app traffic, p99 loop delay 1.3 ms. Follow-up if users report hitches: yield inside a tick after ~10 ms (`flushDrift` stays synchronous for its callers; a contract amendment of §23.3's "≤ 50 per tick") |
| 6 | A Bruno folder at the 2 000-file limit loads in ~290 ms; the event loop stays free (sequential async reads through the checked descriptor) | Accepted. Follow-up: read a few files at a time (the REVIEW-16 #15g identity check per file stays) |
| 7 | `collectionFromTraffic` at 900 endpoints: 177.5 ms synchronous, linear; a third in `isSecretName`. It runs on "Make a fake backend", Update example and an agent's `mock_from_traffic` (whose dry run is allowed read-only, so an agent can repeat it) | Accepted: a one-off action, linear. Follow-up: memoise `isSecretName` per call (names repeat across answers in real sessions) |
| 8 | Bundle +286 543 bytes, all first-party (dependencies +828 bytes of minifier renaming); nothing bundled twice, no new dependency. Activation +3.9 ms | Budget 3 000 000 → **2 990 000** (measured + 20 KB) |
| 9 | The fake-backend pipeline (sign-in gate, body examples, dynamic values, store get / create) adds 0.007–0.027 ms of proxy CPU per answer over a plain mock; endpoints that need none of it stay `mock` rules (±0) | OK |

No product code was changed in this pass other than the budget in `packages/extension/build.mjs`: no finding needed a
fix before release, and the follow-ups in #4–#7 touch code under REVIEW-16's fixes or the §23.3 contract.

## 5. Budgets and tests

- `build.mjs`: `MAX_EXTENSION_BYTES = 2_990_000` (was the temporary 3 000 000); the comment says where the growth went.
- Regression budgets already in the suites and re-run here: `packages/proxy` rule-index property tests (indexed =
  linear) and `test/perf/rule-match.ts` (manual); `packages/webview/test/perf-store.test.tsx`,
  `perf-collections.test.tsx` (incl. the 2 000 out-of-date endpoints); the REVIEW-16 denial-of-service budgets in
  `packages/extension/test/unit/mocks.review16f2.test.ts` / `mocks.review16f3.test.ts` (Insomnia 200 / 400 KB exports,
  1 MB hostile JWT body, 29.6 MB snapshot).
- Checks after the change: `packages/extension` `npm run build && npm run test:bundle && npx vitest run`,
  `packages/proxy` and `packages/webview` `npx vitest run` — 2 827, 637 and 726 tests pass. (The first extension run,
  started right after a build, had 1 failing test out of 2 827 whose name wasn't captured; the next three runs passed
  whole. Treat as a timing flake to watch, not as caused by this pass: the only code change is the budget constant.)
