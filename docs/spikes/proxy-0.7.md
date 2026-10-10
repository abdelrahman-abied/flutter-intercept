# Proxy v0.7.0 — as built (timings, script rules)

Notes for CONTRACTS §13.2 / §13.4 (the lead folds them in). Code: `packages/proxy/src/{timing,script}.ts`,
`upstream-pool.ts` (timing hook), `intercept-proxy.ts` (wiring), `rules.ts` (validation). Tests: `test/v7.test.ts`.

## Timings (§13.2)

- **How upstream phases are observed.** mockttp calls `getAgent` (already wrapped by upstream-pool.ts) right before
  creating the upstream request, passing the downstream connection. The proxy remembers which request each downstream
  socket is serving (set in `decide` / `decideWs`), and the pool returns a per-request view of the chosen agent
  (`Object.create(agent)` with its own `addRequest`) that watches the `ClientRequest` and its socket. Pooling,
  keep-alive and the free list stay with the real agent (reuse is unchanged; covered by the existing pool test).
  This applies to every agent our rules get: the shared pool, LAN-guarded agents, upstream-proxy agents, and direct
  WebSocket upgrades (mockttp answers "no agent" for those; we hand a one-off agent, which is what Node does for
  `agent: false`).
- **Phase definitions** (integer ms ≥ 0, `performance.now()` based):
  - `requestMs`: mockttp's `timingEvents.startTimestamp` → the request's last body byte (tap `end` on the plain route,
    `bodyReceivedTimestamp` on hooked routes, the head for a WebSocket upgrade).
  - `dnsMs`: request handed to the agent → socket `lookup` (absent for an IP target — never guessed).
  - `connectMs`: first `connectionAttempt` (Node ≥ 20.12), else the lookup, else the hand-off → `connect`.
  - `tlsMs`: `connect` → `secureConnect`, only when both were seen. A TLS socket made over an upstream proxy's CONNECT
    tunnel emits no `connect`, so it has no `tlsMs` (and no `connectMs`).
  - `reused: true` when `req.reusedSocket`; then no dns / connect / tls.
  - `sendMs`: socket ready (connected / handshake done / taken from the pool) → request `finish` (clamped: never
    before ready). `waitMs`: → response head (WebSocket: the 101 `upgrade`). `receiveMs`: head → response `end`.
  - `pausedMs`: sum of breakpoint holds (request + response). `delayMs`: mock `delayMs`, throttle / network-profile
    latency (plain route: the route matcher's wait; hooked routes: before forwarding), and the drop fault's latency —
    each measured, not copied from the setting. kbps pacing is not a delay (it shows in `receiveMs` when the
    server is held back by it).
- **Events.** Phases are stored on the live exchange without an event of their own; the next state change carries
  them (the plain route's completion, a pause, the 101, …). A phase that lands after the exchange finished (rare:
  the truncate fault cuts the response before the server's last byte) emits once. `snapshot()` now copies `timings`
  and `scriptLog` too.
- **Mocked / blocked / replayed / script local answers** never reach an agent, so they carry only `requestMs` /
  `delayMs` / `pausedMs`.
- `record()` / `update()` (vm-profile captures): `timings` are sanitised (known phases only, integer ms ≥ 0,
  `reused` only when `true`); `scriptLog` capped like a script's.
- **VS Code's http / https patch (found by the integration suite).** VS Code's extension host (checked in 1.141,
  `extensionHostProcess.js`) patches Node's `http` / `https` module objects **in place** (`Object.assign`, originals
  kept as `module.__vscodeOriginal`) and returns a shallow per-extension copy of the patched module for
  `require('http' | 'https')`; `net` / `tls` are replaced with patched modules too. `node:http` / `node:https` are not
  intercepted but are the same (patched) objects. The patched `request()` replaces the caller's agent with its
  proxy-resolving agent (`http.proxySupport`, default "override"; only `localhost` / `127.0.0.1` / host-less targets
  keep it). mockttp (bundled into the extension) calls that `request`, so for every real target **all our agents were
  dropped**: no timings (only `requestMs`), no shared pool (a new upstream TLS connection per request), no LAN
  connect-time SSRF re-check (DNS-rebinding guard; the matcher-time check still ran), no `upstreamProxy`, no
  10.0.2.2 / 10.0.3.2 alias rewrite. Tests, the CLI and the bundle smoke test run in plain Node: nothing patched.
  Fix (`upstream-pool.ts` `bypassPatchedRequests`, installed with the getAgent hook): every agent the hook hands out for
  our rules is recorded (WeakSet); `request` on the `http` / `https` objects our bundle sees (the same copy mockttp
  uses) is wrapped so a request carrying one of OUR agents goes to Node's own `request`: `__vscodeOriginal.request`,
  else `node:http(s).request` if it differs, else (a `request` not named `request`) a `ClientRequest` built the way
  Node's does. Anything else still goes through the editor's patch. No-op in plain Node. Consequence: our upstream
  traffic no longer follows VS Code's own proxy settings (it didn't for loopback targets before either); chaining is
  `flutterIntercept.upstreamProxy` (§12.6). Direct WebSocket upgrades always get a one-off agent of ours. Tests:
  `v7.test.ts` patches the real modules in place the same way (with and without `__vscodeOriginal`): only
  `requestMs` before, full phases after, foreign requests still patched. Verified end to end: agent suite (macOS,
  VS Code 1.141 VSIX) 10/10, v0.7.0 timings `{"requestMs":1,"dnsMs":0,"connectMs":95,"tlsMs":89,"sendMs":0,
  "waitMs":201,"receiveMs":0}`. The "Failed to handle request: socket hang up" lines in suite logs are in-flight
  upstream requests destroyed when the app stops (same count without the fix).
  Worth a line in the security review: the LAN connect-time guard was effectively off in VS Code until this fix.
- Residual: requests pipelined on one downstream HTTP/1.1 connection (dart:io doesn't) could have their upstream
  phases attributed to the newer request.

## Script rules (§13.4)

- **Routing.** Like a request breakpoint (`h1`: the request body is held for `onRequest`); like a response breakpoint
  (`h2`, response buffered ≤ 32 MB) when the source text mentions `onResponse` — decided synchronously from the text
  (`mentionsOnResponse`), so a comment naming it also buffers. A request body that can't be held (streamed / over
  5 MB) skips the script with a note (`Script skipped: …, so it was passed through unchanged.`), as breakpoints do.
  The network profile applies (a script rule reaches the network): `offline` fails it before the script runs;
  throttle latency is added before forwarding (not before a local answer). GraphQL-scoped script rules work
  (`needsResponseHook` knows scripts).
- **Engine** (`ScriptRunner`, one per InterceptProxy): worker from source (`eval: true`), `resourceLimits`
  `maxOldGenerationSizeMb: 64`, `unref`'d; started on the first hook call, terminated by `setRules` when no
  **enabled** script rule is left (after the call in flight). Calls go to the worker one at a time (a FIFO on the
  main side), so the 1 s watchdog measures one call, never queueing. Each rule + code (sha1) is compiled once in its
  own context: `vm.createContext(Object.create(null), {codeGeneration: {strings: false, wasm: false}, microtaskMode:
  'afterEvaluate'})`; a null-prototype sandbox, so `this.constructor.constructor` is the context's own (blocked)
  `Function`. Inputs go in as a JSON string, results come out as a JSON string; nothing from the worker's realm is
  placed in the context. `import()` has no loader (rejects). Load and every call: 200 ms vm timeout; watchdog
  restart on 1 s; OOM / crash → the call fails, the next call starts a new worker. `InterceptProxy.scriptWorkerRunning`
  (getter) reports it.
- **REVIEW-7 #3 (limits).** Contexts have no `FinalizationRegistry` / `WeakRef` (their callbacks ran between calls,
  outside the timeout and the watchdog), `SharedArrayBuffer` / `Atomics` or `WebAssembly` (`WebAssembly.Memory` needs
  no code generation). Binary data lives outside the 64 MB heap limit, so after every load and call the worker compares
  `process.memoryUsage().external` (per worker isolate, checked in Node 24 / 26) with its value at start: more than
  64 MB → that call fails ("the script holds more than 64 MB of binary data …; the script engine was restarted") and
  the worker is terminated, which frees it (the review's probe: each call fails, RSS growth < 100 MB). A single
  allocation is only bounded by the 200 ms call (transient). Garbage not yet collected counts too, so a script churning
  through large buffers can be restarted early. Queue: at most 100 waiting calls (more → "too many requests waiting for
  the script engine (100)"), each waits at most 2 s ("waited more than 2 s for the script engine (busy)"); both reach
  the app as the usual 502 `Script <name>: …`. Promise reactions run only inside timed evaluations
  (`microtaskMode: 'afterEvaluate'`).
- **Hooks.** Top-level `function` or `let/const` declarations named `onRequest` / `onResponse`. A hook returning a
  Promise / thenable → error ("hooks must be synchronous"). `null` is treated like `undefined` (unchanged).
  `context = {ruleId, exchangeId, log}`; `log` joins its arguments with spaces (strings as is, other values as JSON,
  `undefined`, `[function]`, errors as `Name: message`). Lines logged before a timeout are kept.
- **Inputs.** `ScriptRequest` = the exchange's method / URL (as the app asked) / headers (incl. `host`) / decoded
  body. `onResponse(response, request)`: the upstream status / headers / decoded body, and the request as forwarded.
  Body: absent when empty; `bodyOmitted: true` when binary, cut at 5 MB, or over 1 MB (UTF-8 bytes).
- **Results** (validated; fields absent = unchanged, so `{...request, headers}` and partial objects both work):
  - request: `method` (token, not CONNECT), `url` (absolute http(s)), `headers` (token names; string / string[]
    values, finite numbers accepted as text; no CR / LF / NUL), `body` (string ≤ 5 MB) → applied with the same code
    as a request breakpoint edit (headers replace the set; body re-encoded per content-encoding, re-framed). To empty
    a body return `body: ''` (absent = unchanged, which is also what `bodyOmitted` inputs need).
  - `{response: {status?, headers?, body?}}` → answered locally like a mock (status default 200, CORS added for
    browser requests like a mock, state `mocked`).
  - response: `status` 100–599, `headers`, `body` → applied like a response breakpoint edit.
  - Unchanged headers (same entries, same order) are not treated as an edit.
- **Failures** (throw, timeout, invalid result, syntax error, worker loss): the app gets 502 `Flutter Intercept:
  Script <name>: <message>`; state `error`, `error` = `Script <name>: <message>` (≤ 1000 chars), the same text (≤ 500)
  as the last `scriptLog` line (≤ 20 lines in all). `<name>` = rule name, else id. Response-phase failures replace
  the response with that 502.
- **Validation** (`ruleProblem`, pure): non-empty `code`, ≤ 256 KB UTF-8 (`MAX_SCRIPT_BYTES`, counted without
  Buffer / TextEncoder); `ws://` / `wss://` rules → "Script rules do not apply to WebSocket connections"; script as
  a sequence step refused (`NOT_A_STEP`; `pickSequenceStep` passes it through with a note). At runtime a WebSocket
  upgrade passes through with the usual "does not apply" note.
- New exports: `MAX_SCRIPT_BYTES`, `SCRIPT_TEMPLATE` (both from `/rules` too). `ruleFromExchange(e, 'script')` returns
  `{kind: 'script', code: SCRIPT_TEMPLATE}` (both hooks, commented examples, changing nothing) instead of falling
  back to a breakpoint.
- Bundling: the worker and in-context runtime are string literals (not `fn.toString()`), so esbuild's `keepNames` /
  minify can't inject helpers into them; checked with a minified, `--keep-names` esbuild bundle.

## Contract notes / requests

- None blocking. Clarifications worth folding into §13.4: returned `body` absent = unchanged (empty = `''`); partial
  result objects are accepted; `null` = unchanged; offline profile wins over a script (it never runs); the
  `onResponse` text heuristic decides buffering.
