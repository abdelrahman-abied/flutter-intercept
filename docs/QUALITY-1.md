# QUALITY-1 — maintainability review after the gRPC releases (0.10–0.13)

Scope: `git diff 3098a65..HEAD` (64 commits, 301 files, +54k lines) plus the working tree on `feature/0.13.0` as of
2026-10-12 07:30. Maintainability only; security is covered by docs/REVIEW-10…13. Line numbers are from that snapshot
(other agents were editing at the same time, so they will drift a little). Nothing in the code was changed.

How it was checked:
- `tsc -p . --noEmit --noUnusedLocals --noUnusedParameters --noFallthroughCasesInSwitch` in every TS package.
- An export-usage scan (a ts-prune-like script over `packages/*/{src,test,dev}`).
- A member-dependency scan of `InterceptProxy`: which `this.*` members each region of the class uses, and which of
  its methods are called from outside the region. It gives the interfaces for the splits in §1.
- A compile-time equality check of the two `protocol.ts` copies.
- `vitest --reporter=json` for proxy (532 passed), extension (2093 passed) and webview (535 passed), to get timings.
- Plain grep for duplicated constants, header-name sets, casts and TODOs.

## Summary

The code is in better shape than its growth rate suggests. There are no TODO/FIXME markers and no commented-out code.
Only one debug `console.debug` is left (the webview's no-host fallback, `webview/src/host.ts:49`, which is intended).
Unused locals are rare (§3), and every suite is green. The debt is structural. Most of it comes from parallel agents
working to a contract, where each agent re-implemented the shared rules on its own side.

1. **Four files carry the gRPC growth.** `intercept-proxy.ts` went from 4036 to 6351 lines, `controller.ts` from 1973
   to 2554, `agent/api.ts` from 1958 to 2584 and `proxyHost.ts` from 1120 to 1495. `InterceptProxy` alone is
   5196 lines. Its gRPC region (≈1300 lines) is called from outside through only **two** methods (`decideGrpc`,
   `onGrpc`), so it can be split off cleanly.
2. **The same rule is written 3–4 times with different answers.**
   - Reserved gRPC metadata: proxy `rules.ts`, host `controller.ts`, webview `grpc.ts`, plus `codegen/grpcurl.ts`.
   - Map Remote target validation: proxy, host and webview each accept a different set of URLs.
   - Sequence step limit: webview 20, host and agents 50.
   - Script templates: proxy, webview and host each have a different one.
   - gRPC status code names: 3 copies.
   - `isLoopback*`: 5 variants, 2 of them with the same name and different meanings inside the proxy.
   - About 20 header-name sets across the codebase.
3. **Copy-pasted host code has drifted, and some of it is security-relevant.** `openWorkspaceFile` exists in
   `extension.ts` and `sidecar/host.ts` with different path checks. `activate()` is 816 lines and mirrors
   `SidecarHost.compose()` (271 lines) service for service.
4. **Loose types are left over from parallel work.** Examples: `resume(id, edit?: unknown)`, event payloads typed
   `unknown`, ~15 `?.`-optional proxy methods "for older proxy builds" (the proxy is always bundled), and casts that are
   no longer needed because the protocol has since caught up. The proxy has 36 `as unknown as` casts, most of them
   reaching into mockttp internals.
5. **CI never type-checks the extension, sidecar or CLI.** Those packages build with esbuild and test with vitest, and
   neither checks types. `npm run typecheck` exists in each of them but no workflow runs it. There is also no linter:
   the 21 `eslint-disable` comments do nothing.
6. **The tests are thorough but fragile under load or refactoring.**
   - About 40 wall-clock assertions, some as tight as 50 ms.
   - 13 tests read private proxy fields, so any split breaks them.
   - Three different version-based naming schemes for test files.
   - `lan.test.ts` takes 49 s and `generator.test.ts` 30 s.

## Findings

### 1. Oversized files and functions

| File | Lines | Largest units |
|---|---|---|
| packages/proxy/src/intercept-proxy.ts | 6351 | class 536–5731 (5196); `start` 668 (272); `grpcRelay` 4730 (218); `onRequest` 2636 (150); `runTunnel` 5297 (145); `sendGrpc` 1490 (116) |
| packages/extension/src/agent/api.ts | 2584 | class `AgentApi` 308–2433 (2126); `dispatch` 358 (95, 37 `as ToolInput<…>` casts) |
| packages/extension/src/ui/controller.ts | 2554 | 488–1334 = rule / edit / send validation (≈850, not UI code); class 1335–2554; `handle` 1622 (264, 29 cases) |
| packages/webview/src/state.ts | 1776 | `applyHostMsg` 408 (188); `reducer` 208 (172); already has section markers at 206 / 679 / 717 / 854 / 1011 / 1116 |
| packages/extension/src/proxyHost.ts | 1495 | class 478–1495; `resolveBodies` 864 (79); `doStart` 565 (78) |
| packages/sidecar/src/host.ts | 1159 | `compose` 373 (271) |
| packages/extension/src/extension.ts | 1000 | `activate` 86–901 (**816 lines, one function**) |

**intercept-proxy.ts: regions and their coupling.** For each region, "outside members used" counts the members of the
rest of the class that the region touches. "Entry points" are the region's methods that the rest of the class calls.

| Region (lines) | ≈ lines | Outside members used | Entry points |
|---|---|---|---|
| Exchange store: `getExchanges` … `timingSink` (1613–1921) | 300 | — (used by everything) | many |
| HTTP/2 gRPC relay: `decideGrpc` … `onGrpcUpstreamClosed` (3738–5014), helpers and constants (5987–6045), `sendGrpc` (1490–1605) | 1450 | 33 (store ops, `matchRule`, `pause`, `latency`, `runScript`, `scriptError`, `certFor`, `certRefusal`, `targetsSelf`, `addressIsSelf`, `grpcCodec`, `grpcPool`, `grpcHeld`, `holds`, `reqMeta`, `replayStore`, `upstreamSpec`, `profile`, `hopNonce`, `opts`) | `decideGrpc`, `onGrpc` (+ `send` → `sendGrpc`) |
| gRPC-Web: `watchGrpcWeb` … `answerGrpcWeb` (3567–3733), `GrpcWebState`, `grpcWebExchangeFields` (5741–5785) | 215 | 9 | `watchGrpcWeb`, `syncGrpcWeb`, `answerGrpcWeb`, `addGrpcWebCors` |
| CONNECT / silent tunnels: `requestPlan` … `cutTunnel` (5063–5492) | 430 | 30 | `installConnectHook`, `requestPlan` |
| WebSocket: `decideWs` … `connectWsMapped` (3281–3557), `paceWebSocket` (6245–6332) | 370 | 17 | `decideWs`, `onWsLocal`, `onWsAccepted`, `onWsRefused` |
| Replay streams: `onReplayStream`, `onWsReplay`, `runWsReplay` (5501–5689) | 190 | 15 | `onReplayStream`, `onWsReplay` |
| Rewrite helpers (5969–6183), client certs (6188–6243 + `certFor` / `certOptions` / `certRefusal`) | 320 | none (pure) | — |
| Pure helpers: `snapshot`, `sanitizeRecord`, `validateEdit`, `validateProfile`, … (5736–5966) | 230 | none | — |

**controller.ts.**
- Lines 488–1334 are validation shared by the controller, `agent/api.ts`, `extension.ts`, the sidecar and **the CLI**.
  `cli/src/rules.ts:13` imports `validateRule` from `../../extension/src/ui/controller`, so the CLI pulls the whole
  controller module into its bundle to get one validator.
- Lines 294–487 are pure view helpers (`uiExchange`, `readOnlyReason`, `tunnelReason`, `recordingSummary`, …).

**agent/api.ts.** The 41 tools fall into nine areas:
- traffic: 929–1260, 1809–1875
- rules: 1036–1131, 1792–1898, 2028–2158
- network and resend: 1276–1470
- contract and codegen: 1471–1590
- assert: 1591–1791
- recordings: 1899–2027
- export: 1023, 2159–2186
- gRPC: 586–804, 2187–2380
- app and screenshots: 805–876, 2381–2432

The views (`summary`, `detail`, `ruleView`, the gRPC views) and the "restore redacted input" helpers (2436–2584) are
pure functions.

### 2. Duplication

The dependency rule allows sharing more than is shared today. The webview already imports *runtime* code from the
dependency-free proxy subpaths: `@flutter-intercept/proxy/rules` (`webview/src/state.ts:10`), `/network`
(`state.ts:11`) and `/source` (`util.ts:4`). The extension already imports `ruleProblem` / `grpcEditProblem` from
`/rules` (`controller.ts:54`). Any pure, node-free module in the proxy can therefore be shared by all three layers. The
one constraint is that it must not import `zlib` / `http2` / `net`, so `GRPC_CODE_NAMES` has to move out of
`proxy/src/grpc.ts`.

| What | Where | Problem |
|---|---|---|
| Reserved gRPC metadata | proxy/src/rules.ts:348 `MOCK_RESERVED`, :399 `GRPC_REWRITE_RESERVED`, :401 `GRPC_TRAILER_RESERVED`; extension/src/ui/controller.ts:781 `GRPC_MOCK_FORBIDDEN`, :1002 `GRPC_RESERVED_METADATA`, :1003 `GRPC_CALL_RESERVED`; webview/src/grpc.ts:317 `RESERVED_GRPC_METADATA` (adds `content-type`, `te`); extension/src/codegen/grpcurl.ts:30 `GRPCURL_DROPPED` | Same concept with 4 different shapes. Error texts differ per layer (`rules.ts:429` vs `controller.ts:1056` vs `grpc.ts:333`). The proxy already exports the sets; host and webview don't use them. |
| Header-name sets | ≈20 sets: proxy intercept-proxy.ts:424, 5969, 5985, 5998, 6032; rules.ts:348, 401, 503; controller.ts:667, 668, 781, 1003, 1176, 1246; recordings/replay.ts:10; grpcurl.ts:30; webview state.ts:871 | Most are "hop-by-hop + framing + something". There is no shared `HOP_BY_HOP` base. |
| Map Remote target | proxy rules.ts:709 `parseMapTarget` (allows ws/wss and `?query`); controller.ts:981 `checkMapTarget` (allows `?query`, refuses whitespace and `\`); webview scenarios.ts:95 `checkMapTarget` (refuses `?query`) | Three layers give three different answers for the same URL. |
| Limits | `MAX_SCRIPT_BYTES`: proxy rules.ts:757, controller.ts:964, webview scripts.ts:7. `MAX_SEQUENCE_STEPS` 50: controller.ts:655 and agent/schema.ts:57; **webview `MAX_STEPS = 20`** scenarios.ts:30. `MAX_MUTATE_OPS`: controller.ts:559 and schema.ts:52. `MAX_REWRITE_HEADERS` / `MAX_REWRITE_REPLACEMENTS`: controller.ts:657–658 and schema.ts:58–59, plus proxy `MAX_BODY_REPLACEMENTS` rules.ts:648. `MAX_BODY_FILE_BYTES`: controller.ts:978 and rules/bodyFile.ts:12. `MAX_REPLAY_GAP_MS`: proxy replay-stream.ts:6 and recordings/grpc.ts:36 | Copies within the *same package* (agent/schema vs controller) are pure duplication. The webview's 20-step cap contradicts the host's 50. |
| Script templates | proxy rules.ts:618 `SCRIPT_TEMPLATE` (HTTP only, used by `ruleFromExchange`); webview scripts.ts:14 (with gRPC hooks); extension rules/scriptFile.ts:73 `scriptTemplate()` (commented gRPC hooks) | A rule made from an exchange starts from a different template than one made in the editor. |
| gRPC code names | proxy grpc.ts:34 (exported from index); extension grpc/service.ts:22; webview grpc.ts:11 `GRPC_CODES` | 3 copies. The extension could import from the proxy today. |
| Loopback checks | proxy cors.ts:188 `isLoopbackOrigin` (exact origin) **and** intercept-proxy.ts:6335 `isLoopbackOrigin` (any path); upstream-proxy.ts:141 `isLoopbackHost` (IPv4-mapped, 0.0.0.0); webview scenarios.ts:85 `isLoopbackHost` (narrower); extension rules/policy.ts:51 `isLoopbackTarget` | Two functions with the same name and different meanings in one package. Five definitions of "loopback". |
| Small constants | `TRACE_HEADER` ×3 (proxy trace.ts:11, generator.ts:760, vm/profile.ts:51); `LM_TOOL_PREFIX` ×2 (agent/schema.ts:836, lmTools.ts:12); `DEFAULT_MCP_PORT` ×2 (mcp/server.ts:29, sidecar/settings.ts:8); `SHARED_FILE` ×2 (rules/file.ts:15, webview scenarios.ts:299); `AGENT_RULE_PREFIX` ×2 (agent/api.ts:49, webview state.ts:1286); `GRPC_DEFINE` ×2 (generator.ts:748, cli/run.ts:36); `HTTP_TOKEN` ×2 in the proxy (intercept-proxy.ts:438, script.ts:487); `BASE64` regex ×4 (two different patterns) | Low risk each, but they drift silently. |
| Protocol types | extension/src/ui/protocol.ts and webview/src/protocol.ts ("verbatim" copies) | A compile-time check found them equivalent except one drift: `Status.lan.peer?` is missing in the webview copy (webview protocol.ts:34). Nothing guards the copies today. |
| Workspace file creation | extension/src/extension.ts:465 and sidecar/src/host.ts:926 `openWorkspaceFile` | Copy-paste that has drifted. The sidecar checks `createPathDecision` on both the relative and the root-relative path, the extension only on `rel`. Declining the prompt returns `false` in the extension but throws in the sidecar. The extension's `realpathSync(root)` is unguarded. This is security-relevant code with two owners. |
| Composition and settings | extension.ts `activate` 86–901 vs sidecar host.ts `compose` 373–643 + `applySettings` 763–786 | The same ~20 services are wired in the same order (`CaStore`, `ReverseTracker`, `AndroidGlobalProxy`, `IosSimTrust`, `InterceptProxyHost`, `LanLifecycle`, `LanNetworkWatcher`, `PacServer`, contract / codegen / shared rules / gRPC schema / recordings services, `InterceptController`, VM watcher, `createAgentApi`). Each new setting has to be wired three times: `extension.ts:583–587`, `sidecar/host.ts:763–786`, CLI args. |
| Fault-timeout labels | intercept-proxy.ts:3074, 3509, 4136 | The same "hold until the app leaves" block and label, three times (HTTP, WebSocket, gRPC). |
| Error text from `unknown` | 143× `(e as Error).message`, 37× `e instanceof Error ? e.message : String(e)`, 3 local `errorText` helpers (adb.ts:168, iosSimTrust.ts:229, mcp/server.ts:121) | `(e as Error).message` prints `undefined` when a non-Error is thrown. There is no shared helper. |

### 3. Dead code, unused exports, leftovers

**Unused locals and parameters** (`--noUnusedLocals --noUnusedParameters`; the base configs don't set these):
- proxy/src/intercept-proxy.ts:45: `targetsProxy` imported, not used.
- intercept-proxy.ts:1918: private `timingSink()` is never called.
- intercept-proxy.ts:2899: `forwardChanges(..., body)` doesn't use `body`.
- intercept-proxy.ts:3931: `const a = flow.action` is unused (in `runGrpc`).
- extension/src/ui/controller.ts:56: `decodeJson` imported, not used.
- codegen/fixtures.ts:16: `Exchange` imported, not used.
- contract/api.ts:256: unused callback parameter `m`.
- grpc/codec.ts:388: unused parameter `ctx`.
- sidecar/src/state.ts:25: `dir` parameter property is never read.
- Tests: extension test/unit/contract.service.test.ts:1 (`fs`); webview dev/fake-host.ts:779 (`ex`).

**Exports that nothing uses** (not in src, tests or dev):
- extension/src/codegen/snippets.ts:19 `HTTP_SNIPPET_FORMATS`
- contract/dart.ts:783 `parseExprAt`, :794 `parseTypeAt`
- grpc/service.ts:41 `GrpcCodeName`
- rules/bodyFile.ts:108 `decodeBodyFile`
- rules/scriptFile.ts:40 `decodeScriptFile`
- rules/types.ts:7 `SharedRulesFile`
- ui/clientCerts.ts:33 `ClientCertEntry`
- proxy/src/lan.ts:105 `isSilentMarker`, :484 `isLanConnection`
- replay-stream.ts:43 `sseBody`
- timing.ts:31 `timedAgent`
- sidecar/src/types.ts:113 `SidecarEvent`

**Exports used only by tests:** `findRule` (proxy rules.ts:286), `winningRuleIndex`, `THEME_VARS`, `PALETTES`,
`clearHeldMessageCache` and 9 others. That is acceptable, but they should be marked `/** @internal test hook */`.

**Over-exported symbols:** 481 exports are never imported outside their own file (mostly types that appear in exported
signatures). This is not worth a manual pass; a `knip` report in CI would catch new ones.

**Back-compat code for proxy versions that can't exist:**
- `ProxyLike` (proxyHost.ts:56–106) declares ~15 methods as optional "for older proxy builds".
- 26 related branches and log texts ("this proxy build cannot …") remain, for example at proxyHost.ts:694, 805, 990,
  1022, 1099, 1143, 1204, 1266, 1306, 1319, 1380.
- Each has an `…UnsupportedLogged` flag.

The proxy is always bundled from the same commit, so all of this is dead.

**Orphaned doc comment:** controller.ts:997 `/** Validates one side of a rewrite; … */` sits directly above another
JSDoc. The `GRPC_RESERVED_METADATA` block was inserted between it and `checkRewriteSpec` (now at :1046), which has lost
its doc.

**Inert lint comments:** 21 `eslint-disable` comments, but no ESLint is installed or configured.

### 4. Consistency

- **Notes are written into `Exchange.error`.** Informational text ("forwarded unchanged", "mutate: no schema", the
  gRPC-Web notes, "pins its certificate") goes into `error`. That is contract-sanctioned (CONTRACTS §19.3), but the
  code does it three ways:
  - plain overwrites that drop earlier notes: intercept-proxy.ts:2937, 2941, 2989, 3145, 3155, 3175, 3180, 3722
  - appends with de-duplication: `grpcNote` 4276, gRPC-Web sync 3688
  - an append without de-duplication: 4036 (`${ex.error} (it was paused…)`)

  `simulated` labels are joined with `' · '` in 8 places (2332, 2343, 3154, 3323, 3822, 3832, …). Consumers cannot
  tell an error from a note.
- **Loose types left from "until X lands".**
  - controller.ts:77 adds `{ type: 'decodeGrpc' }` to `AnyViewMsg`, although `ViewMsg` now has it (protocol.ts:98).
  - controller.ts:1874 casts `answer as unknown as HostMsg`, although `GrpcDecodedMsg` is already an `Extract` of
    `HostMsg`.
  - `ControllerHost` (controller.ts:81–140) still has `send?`, `setNetworkProfile?` and `setReplay?` optional, and its
    events `replay`, `upstream`, `tlsPassthrough`, `grpc` carry `unknown`.
  - `ProxyLike.resume(id, edit?: unknown)` (proxyHost.ts:63, 1351).
  - `on('grpcBreaker', (info: unknown))` (proxyHost.ts:105, 1223), although the proxy exports `GrpcBreakerEvent`.
  - agent/api.ts:916 casts `unknown[] as unknown as string[]`; the elements are actually `string | {via, json}`.
  - intercept-proxy.ts:3581 builds `GrpcWebState` with `as unknown as` to skip the required `rec`.
- **mockttp internals are spread through the class.** About 20 casts read `socket`, `timingEvents`, `rawHeaders` and
  `httpVersion` from `OngoingRequest`, or the raw server (intercept-proxy.ts:724, 864, 877, 1012, 1927, 1951, 2227,
  2230, 2252, 2370, 2908, 3332, 3345, 3358, 3554, 3759, 3760, 3933, 4746, 5511, 5551, 5784). The `any` uses in
  upstream-proxy.ts, upstream-pool.ts and lan.ts are Node `Agent` overrides; those are acceptable but should be in
  one place.
- **Agent dispatch is a switch plus casts.** `AgentApi.dispatch` has 37 `input as ToolInput<'x'>` casts. A typed
  handler map (`{[T in ToolName]: (i: ToolInput<T>) => …}`) removes them and makes the split by area mechanical.
- **Test file naming uses three schemes, plus review numbers.**
  - proxy: `v3`, `v6`, `v7`, `v8`, `grpc-parity`, `grpc-tools`
  - webview: `components-v3` … `components-v13`, `state-v3` … `state-v10`
  - extension: `controller.v040` … `controller.v0100`, `proxyHost.v050` … `v0100`, `api.v040` … `api.v0110`,
    `grpc.v0110`, `grpc.v0120`
  - review numbers: `review6`, `review12`, `review13`, `agent/review5`, `grpc/review10`

  You have to know the release history to find the tests for a module.

### 5. Test quality

- **Wall-clock assertions (about 40).** The most fragile ones:
  - extension test/unit/grpc/proto.test.ts:245: `< 50 ms` wall time.
  - contract.limits.test.ts:140: max `setImmediate` gap `< 50 ms`. A GC pause or a busy CI runner fails it.
  - proxy grpc-web.test.ts:332 and :339: `activeMs < 100`. The ELU window includes the HTTP round trip and a 10 ms
    polling loop, and unlike grpc.test.ts:121 it is not best-of-N.
  - proxy v3.test.ts:366, 488 and proxy.test.ts:173: first chunk `< 300` / `< 400 ms`.
  - adb.test.ts:85: `< 500 ms`.
  - review10.test.ts:18, 38: `< 300` / `< 500 ms`.

  Prefer work counters (iterations, bytes decoded, a bounded loop count). Where time is the property under test, use
  best-of-3 ELU, as grpc.test.ts:121 does, with an `FI_TIME_SCALE` multiplier for CI.
- **Slow tests.**
  - proxy `lan.test.ts`: 49 s. One test waits a real 15 s (lan-hardening.suite.ts:401) even though
    `lanTesting.silentDeadlineMs` exists for exactly this.
  - `faults.test.ts`: 11 s (3 s timeout holds).
  - extension `generator.test.ts`: 30 s. It runs a real Dart VM, so it is an integration test and belongs in a
    separate `test:dart` project.
  - iosUsbTooling.test.ts:187: waits for a real 3 s bound; fake timers would do.
  - The proxy suite is serial (`fileParallelism: false`) because of these timing tests.
- **Tests that read private fields block refactoring.** Thirteen proxy tests cast the proxy to read `grpcPool`,
  `grpcWebCalls`, `grpcHeld`, `paused`, `lanGate` or `server` (grpc.test.ts:792, 1092; grpc-web.test.ts:321;
  grpc-parity.test.ts:330; lan-hardening.suite.ts:279, 478, 518; proxy.test.ts:35, 43, 54, …). Every split in §1
  breaks them. They need one supported `InterceptProxy[TEST_INTERNALS]()` accessor first.
- **Coverage gaps on recently added branches:**
  - gRPC-Web in the proxy: no test for HTTP breakpoints, throttle / fault / offline profile, record → replay, LAN
    refusal, a `sequence` with a `grpcMock` step, or the `gapMs` note (intercept-proxy.ts:3722). The contract (§19.1)
    promises these work "as for any HTTP request".
  - gRPC-Web in the host: the `grpc.web` field in HAR (agent/har.ts:167) and in agent views (api.ts:543, 728), and the
    resend refusal (api.ts:1342), are never asserted. Only grpcurl covers `web`.
  - No coverage tool is installed. Add `@vitest/coverage-v8` as a report, not a gate.

### 6. Types (summary)

`any`: 33 in the proxy (Node `Agent` overrides, plus `connectWsMapped(step: any)` intercept-proxy.ts:3544 and the
listener overload :1716), 4 in the extension (mcp/server.ts:136, 147), 1 in the webview. `as unknown as`: 63 in the
proxy (36 in intercept-proxy.ts), 11 in the extension, 3 in the sidecar. `@ts-ignore`: none. Section 4 lists the ones
that only exist because of parallel work.

## Refactor plan

Rules for every item: behaviour unchanged; `npm run build && npm test` green at the end. No CONTRACTS change unless the
item says so; those go through the lead. Moved code keeps a re-export from its old module until phase 3, so items don't
have to edit each other's import sites. Each item owns exactly the files listed; anything else goes back to the lead.

### Phase 0: guards (lead, ½ day, before anything else)

**Q0. CI and compiler guards.**
- Owns: `.github/workflows/ci.yml`, root `package.json`, every `packages/*/tsconfig.json`, and the 2 test files with
  unused imports.
- Steps:
  1. Add `npm run typecheck -ws --if-present` to CI.
  2. Turn on `noUnusedLocals` and `noUnusedParameters` in proxy, extension, sidecar and cli (the webview has the
     first already). Until the owning items land, list the 10 current hits in a one-time baseline.
  3. Add the protocol drift guard: a type-level test `extension/test/unit/protocol.sync.test.ts` that asserts deep key
     equality of the two `protocol.ts` copies (the check used for this review).
  4. Optional: add `knip` as a report.
- Done when: CI runs typecheck for 5 packages, the drift test fails on the current `lan.peer` drift (then fixed in
  Q6), and the build is green.

### Phase 1: parallel, disjoint ownership

**Q1. Split `intercept-proxy.ts` (agent P).**
- Owns: `packages/proxy/src/intercept-proxy.ts`, the new files below, and all `packages/proxy/test/**`. It does **not**
  own `rules.ts`, `index.ts` or `package.json` (those are Q2's).
- Steps, one commit each with the suite green between them:
  1. `[TEST_INTERNALS]()`: one symbol-keyed accessor returning `{ grpcPool, grpcWebCalls, grpcHeld, paused, lanGate,
     rawServer }`. Rewrite the 13 tests to use it.
  2. `flow-types.ts`: move `Flow`, `Live`, `Paused`, `Decision`, `MatchOptions`, `MatchResult`, `GrpcCall`,
     `StreamState` and `ReqMeta` (lines 201–410).
  3. `mockttp-internals.ts`: typed accessors `reqSocket`, `reqTimingEvents`, `reqRawHeaders`, `setReqRawHeaders`,
     `reqHttpVersion`, `rawServerOf` and `reqDecodedBody`. Replace the ~20 casts listed in §4.
  4. `exchange-store.ts`: `class ExchangeStore extends EventEmitter` with `record`, `update`, `clear`, `emitChange`,
     `touch`, `addFrame`, `trimLiveFrames`, `drop`, `evict`, `track`, `newExchange`, `setRequestBody`, `addTimings`,
     `addPhase`, `setRequestMs`, `finish`, `fail`, plus new `addNote(ex, text)` (append with de-duplication, cap) and
     `addSimulated(target, label)`. It owns `store`, `live`, `flows`, `sizes`, `storedBytes`, `frameBytes` and
     `records`.
  5. `proxy-context.ts`: the interface the flow modules get. Its members are exactly the outside members the scan
     found for the gRPC region:
     ```ts
     interface ProxyContext {
       readonly opts: InterceptProxyOptions; readonly book: ExchangeStore; readonly breakpointTimeoutMs: number;
       matchRule(method: string, url: string, o: MatchOptions): MatchResult;
       pause(ex: Exchange, phase: 'request' | 'response'): Promise<Decision>;
       latency(ex: Exchange, flow: Flow): Promise<boolean>;
       runScript(...): Promise<ScriptOutcome>; scriptError(ex: Exchange, flow: Flow, m: string): string;
       certFor(host: string, port: number): LoadedCert | undefined; certRefusal(url: string, h: HeaderBag): string | undefined;
       targetsSelf(host: string, port: number): boolean; addressIsSelf(ip: string, port: number): boolean;
       readonly profile: NetworkProfile; readonly replayStore?: ReplayStore; readonly upstreamSpec?: UpstreamProxySpec;
       readonly grpcCodec?: GrpcProxyCodec; readonly grpcPool?: GrpcSessionPool; readonly hopNonce: string;
       readonly holds: Map<string, (left: boolean) => void>; readonly reqMeta: Map<string, ReqMeta>;
     }
     ```
  6. `grpc-relay.ts`: `class GrpcRelay { constructor(ctx) ; decide(req): Flow ; handle(req, res): Promise<void> ;
     send(r, method, u, headers) }`. It takes 3738–5014, 1490–1605 and the gRPC constants at 5987–6045. If it ends up
     over 900 lines, split out `grpc-hooks.ts` (`grpcTransform` … `grpcStatusBreakpoint`, 4283–4697) and
     `grpc-local.ts` (`grpcStatusOnly` … `grpcAnswer`, 4072–4271).
  7. `grpc-web-flow.ts` (3567–3733, 5741–5785). `connect-flow.ts` (5063–5492). `ws-flow.ts` (3281–3557,
     6245–6332). `replay-flow.ts` (5501–5689). `rewrite-flow.ts` (5969–6183, pure). `client-certs.ts` (6188–6243
     plus the cert methods, pure). `proxy-util.ts` (5736–5966, pure).
  8. Fold the three fault-timeout blocks into one `holdUntilAppLeaves(ex)` helper. Use `book.addNote` for every write
     listed in §4 (keep the `Exchange.error` text identical; no contract change). Remove the 4 unused symbols in §3.
- Done when:
  - `intercept-proxy.ts` is under 2,500 lines (target 2,000).
  - No new file is over 900 lines.
  - Fewer than 5 `as unknown as` remain in `intercept-proxy.ts`.
  - No proxy test casts the proxy to a private shape.
  - The proxy suite is green with the same test count (532 + new).
  - `npx tsc --noUnusedLocals` is clean for the proxy.

**Q2. Shared pure gRPC / HTTP metadata module (agent R).**
- Owns: `packages/proxy/src/rules.ts`, `proxy/src/index.ts`, `proxy/package.json` (exports and typesVersions), the new
  `proxy/src/protocol-meta.ts`, and `proxy/src/grpc.ts` (for the `GRPC_CODE_NAMES` move only).
- Steps:
  1. Create `protocol-meta.ts` with no node imports, exported as `@flutter-intercept/proxy/protocol-meta`. Contents:
     - `GRPC_CODE_NAMES`, moved from grpc.ts (which re-exports it).
     - `HOP_BY_HOP_HEADERS` and `FRAMING_HEADERS`.
     - `GRPC_REWRITE_RESERVED`, `GRPC_TRAILER_RESERVED`, `GRPC_MOCK_RESERVED` and `GRPC_CALL_RESERVED`.
     - `reservedGrpcMetadataProblem(name, side): string | undefined`, giving the single wording.
     - `isBase64Metadata(v)`.
     - The limits: `MAX_SCRIPT_BYTES`, `MAX_SEQUENCE_STEPS`, `MAX_REWRITE_HEADERS`, `MAX_REWRITE_REPLACEMENTS`,
       `MAX_MUTATE_OPS`, `MAX_BODY_FILE_BYTES`, `MAX_REPLAY_GAP_MS`, `TRACE_HEADER`.
     - `mapTargetProblem(to, {allowWs})`: one rule set, which the owner must pick (proposal: `http(s)` only, with
       query allowed, for rules; `ws(s)` added inside the proxy).
     - `isLoopbackHostname(h)`, using the most complete variant (upstream-proxy.ts:141, but without `node:net`).
  2. `rules.ts` re-exports these, so the existing imports keep working.
  3. Move `SCRIPT_TEMPLATE` here as the one template, with the gRPC hooks. Owner decision: the webview text or the
     host `scriptTemplate()` text.
- Done when: `protocol-meta.ts` has no `import` from node built-ins (a test greps it), every listed constant has
  exactly one definition in `packages/proxy`, and the proxy tests are green. Consumers switch in Q3, Q5 and Q8.

**Q3. Controller split and validation module (agent H1).**
- Owns: `extension/src/ui/controller.ts`, the new `extension/src/rules/validate.ts`, the new `extension/src/ui/views.ts`,
  the new `extension/src/ui/handlers/*.ts`, `extension/src/ui/protocol.ts`, `cli/src/rules.ts` (import path only), and
  the controller tests.
- Steps:
  1. Move 488–1334 into `rules/validate.ts`, using Q2's sets and limits once Q2 has landed (before that, use the proxy's
     existing exports). Keep a re-export block in `controller.ts`.
  2. Move 294–487 into `ui/views.ts`.
  3. Replace `handle()`'s switch with `handlers: { [K in ViewMsg['type']]: (m: Extract<ViewMsg, {type: K}>, reply:
     Sink) => Promise<void> | void }`, grouped in `handlers/{rules,recordings,codegen,files,traffic,grpc}.ts`.
  4. Delete `AnyViewMsg` and the `as unknown as HostMsg` at :1874.
  5. Type `ControllerHost`: no optional `send` / `setNetworkProfile` / `setReplay`, and typed event payloads.
  6. Fix the orphaned JSDoc at :997 and the unused `decodeJson` import.
- Done when:
  - `controller.ts` is under 1,200 lines and `validate.ts` under 900.
  - `handle` is under 40 lines.
  - `cli/src/rules.ts` imports from `rules/validate` and the CLI bundle no longer contains `InterceptController`
    (check with `test:bundle`).
  - Extension tests are green.

**Q4. ProxyHost typing (agent H2).**
- Owns: `extension/src/proxyHost.ts` and `extension/test/unit/proxyHost*.test.ts`.
- Steps:
  1. Make `ProxyLike = Pick<InterceptProxy, …>` (type-only import), with no optional methods.
  2. Delete the 26 "older proxy build" branches and the `…UnsupportedLogged` flags.
  3. Type `resume` with `RequestEdit | ResponseEdit | GrpcEdit`.
  4. Type `grpcBreaker` with `GrpcBreakerEvent`, keeping the sanitising.
  5. Update the test fakes to implement the full interface: one shared `fakeProxy()` in `test/unit/proxy.fakes.ts`.
- Done when: `proxyHost.ts` is under 1,250 lines, there are no `?.(` calls on `proxy` methods, and the tests are green.

**Q5. Agent API split (agent A).**
- Owns: `extension/src/agent/api.ts`, `agent/schema.ts` (constants only), the new `agent/tools/*.ts`, the new
  `agent/views.ts` and `agent/redactedInput.ts`, and `extension/test/unit/agent/**`.
- Steps:
  1. Define `AgentContext` (the deps, the clock and `lastTriggerAt`).
  2. Write `tools/{traffic,rules,network,contract,assert,recordings,export,grpc,app}.ts`. Each exports
     `Partial<ToolHandlers>` with `ToolHandlers = { [T in ToolName]: (ctx, input: ToolInput<T>, signal?) =>
     Promise<ToolResult> | ToolResult }`.
  3. `AgentApi.call` keeps the access checks and listeners and looks the handler up in the merged map; there is no
     switch and there are no casts. A type test checks the map has every `ToolName`.
  4. Move the views (summary, detail, ruleView, gRPC views) to `views.ts` and 2436–2584 to `redactedInput.ts`.
  5. Import the limits from `rules/validate` / `protocol-meta` instead of redefining them (schema.ts:52–59).
  6. Fix the `as unknown as string[]` at :916 by giving the rule view's `messages` a real union type.
- Done when: `api.ts` is under 500 lines, no tool file is over 450, there are 0 `as ToolInput` casts, the
  `LM_TOOL_PREFIX` duplicate is gone, and the agent tests are green.

**Q6. Webview state split and shared rules (agent W).**
- Owns: `packages/webview/**`, including `src/protocol.ts`. This is a one-off ownership change approved by the lead.
- Steps:
  1. Split `state.ts` along its existing markers into `state/{reducer,hostMsg,drafts,composer,profile,ruleForm}.ts`.
     Keep `state.ts` as a barrel so tests don't move.
  2. Use `@flutter-intercept/proxy/protocol-meta` (after Q2) for the reserved metadata, the code names, the limits
     (fixing the 20-vs-50 steps decision with the owner), `mapTargetProblem` and `isLoopbackHostname`.
  3. Make `protocol.ts` re-export the host's types with `export type * from '../../extension/src/ui/protocol'`. The
     sidecar and CLI already import `../../extension/src`, and type-only imports add nothing to the bundle. If the
     owner prefers to keep two copies, Q0's drift test is the guard; fix `lan.peer` either way.
- Done when: no webview file is over 700 lines, `grpc.ts` has no reserved-name set or code-name list of its own, the
  webview runs `tsc` and its tests are green, and the bundle size is within ±2 %.

**Q7. Host composition and settings (agent L, after Q3 and Q4 merge, because it touches their import sites).**
- Owns: `extension/src/extension.ts`, `sidecar/src/host.ts`, `sidecar/src/settings.ts`, and the new
  `extension/src/host/{compose,settings,workspaceFile}.ts`.
- Steps:
  1. `workspaceFile.ts`: `createAndOpenWorkspaceFile(deps: { roots, confirm, open })`, taking the stricter sidecar
     checks (both `createPathDecision` calls, guarded `realpath`, explicit decline). Both hosts call it. The diff needs
     a security review, per CLAUDE.local.md.
  2. `settings.ts`: a `HostSettings` normalised type (the sidecar's `SidecarSettings` shape) and
     `applySettingsChange(core, prev, next)`, used by `onDidChangeConfiguration` and by `SidecarHost.applySettings`.
  3. `compose.ts`: `composeCore(platform: CorePlatform)` builds the ~20 shared services. `CorePlatform` supplies
     memento, secrets, roots, log, UI prompts, `openFile` and `exec`.
  4. `activate()` and `SidecarHost.compose()` keep only platform glue.
- Done when:
  - `activate` is under 250 lines and `SidecarHost.compose` under 120.
  - One definition of `openWorkspaceFile` exists.
  - A new setting needs one edit in `settings.ts` plus each host's reader.
  - Extension, sidecar and integration-default suites are green.

**Q8. Timing and slow tests (agent T).**
- Owns: `extension/test/unit/{contract.limits,adb,iosUsbTooling,analysis.auth}.test.ts`,
  `extension/test/unit/grpc/{proto,review10}.test.ts`, `extension/test/unit/agent/{shape,redact,redact.v080}.test.ts`,
  `extension/vitest.config.mts`, and a new `test/unit/timing.ts` helper. Proxy test timing is Q1's, because Q1 owns
  those files.
- Steps:
  1. `expectWithin(fn, budgetMs)`: best-of-3, scaled by `FI_TIME_SCALE`.
  2. Turn the < 50 ms wall checks into work-count checks or `expectWithin`.
  3. Use fake timers in iosUsbTooling and adb.
  4. Move `generator.test.ts`'s Dart-VM cases into a `test:dart` vitest project; CI runs it on one OS.
- Done when: no extension test asserts under 200 ms of wall time, `npm test -w flutter-intercept` drops by ≥ 25 s, and
  20 consecutive runs pass under `stress -c $(nproc)` (or `FI_TIME_SCALE=1` on a loaded machine).

### Phase 2: lead, after phase 1

- **Q9. Notes contract.** Add `Exchange.notes?: string[]` (CONTRACTS change). `book.addNote` writes it, and
  `error` keeps only real errors. Consumers: the webview detail pane, agent views, HAR comment and redaction.
  Done when: grep shows no informational text assigned to `ex.error` in the proxy.
- **Q10. Error helper.** Add `errorMessage(e: unknown)` in `proxy/src/util/errors.ts` and
  `extension/src/util/errors.ts`, and replace the 143 `(e as Error).message` sites file by file in each owner's next
  change. Done when: grep finds fewer than 10 left.
- **Q11. Dead exports and comments.** Remove the 14 dead exports in §3 that phase 1 didn't touch, and the inert
  `eslint-disable` comments (or add `typescript-eslint` with a minimal rule set, which is the owner's choice).

### Phase 3: test organisation (one agent, last, when nothing else is in flight)

**Q12. Rename test files by feature, not by release.** The pattern is `<module>.<area>.test.ts`, mirroring the new
module layout from Q1, Q3, Q5 and Q6. Examples: `controller.grpc.test.ts`, `proxy/test/grpc-relay.test.ts`,
`agent/tools.rules.test.ts`. Keep `reviewN` tests as `*.review.test.ts` only when they are regression packs. Done when:
no `vNNN` / `-vN` file names remain, the test counts are identical before and after, and git shows the renames
(`--find-renames`).

**Ordering and parallelism.** Q0 goes first. Q1–Q6 and Q8 run in parallel; their file sets are disjoint. Q3 and Q5
pick up Q2's module when it merges and use the proxy's existing exports until then. Q7 starts after Q3 and Q4 merge.
Q9–Q11 are lead work, and Q12 comes last.
