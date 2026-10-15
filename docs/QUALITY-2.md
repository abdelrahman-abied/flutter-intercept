# QUALITY-2 — maintainability pass for 0.14.0 (apps with their own certificate)

Scope: `git diff aee0cad..HEAD` on `feature/0.14.0` (up to 90b3311, after REVIEW-14 and PERF-2): the learned passthrough
in the proxy (`learned.ts`, `learn-flow.ts`, `connect-flow.ts`, `http-taps.ts`, `grpc-relay.ts`, `intercept-proxy.ts`,
`tunnel.ts`, `upstream-proxy.ts`), the host (`ui/clientCertUi.ts`, `ui/clientCerts.ts`, `ui/handlers.ts`,
`ui/controller.ts`, `proxyHost.ts`, `extension.ts`, `agent/*`), the webview (`certificates.ts`,
`components/Certificates.tsx`, `state/*`), the sidecar (`clientCerts.ts`, `host.ts`) and the plugin
(`ClientCertificates.kt`, `UiRequestHandler.kt`, `InterceptConfigurable.kt`). Maintainability only; security is
REVIEW-14, performance PERF-2.

Unlike QUALITY-1 (a review with a plan), this pass made the fixes. All of them are behaviour-preserving refactors: no
feature change, every user-visible text and every agent output is unchanged, and nothing in the REVIEW-14 rules
(per-client pins, key on the CONNECT target, strike rules, caps, passphrase rollback, host-side Remove confirmation,
one chooser at a time) was touched. Line numbers below are from before the change.

How it was checked:
- `tsc --noEmit --noUnusedLocals --noUnusedParameters` in proxy, extension and sidecar (the webview has both flags on).
- Reading the diff for repeated rules and texts across packages, and grep for the repeated shapes (`[v6]` bracketing,
  `client|host:port` keys, `'pfx' | 'cert' | 'key'`, the 300 / 1000 / 200 caps, the learned-entry type).
- A comparison of the two `protocol.ts` copies (the drift test and a plain diff of the exported names).
- `package.json` `languageModelTools` against `agent/schema.ts` (the existing equality test, not skipped).
- Function lengths with a brace counter; the bundle size from `node build.mjs`.

## Summary

The 0.14 code is in good shape: no TODOs, no `any`, no `@ts-ignore`, no unused locals in the new code, and both
`protocol.ts` copies and the LM tool descriptions match. The debt is the same kind QUALITY-1 found, at a smaller scale:
parallel owners wrote the same small rules on each side.

1. **The learned key had three writers.** The proxy formatted and parsed `host:port` / `[v6]:port` in `learned.ts`, the
   host had its own `learnedKeyOf` (the REVIEW-14 #5 fix), and the per-client key `client|host:port` was built by hand
   in four places and parsed by `indexOf('|')` in a fifth. Now one module, `@flutter-intercept/proxy/learned-meta`.
2. **The "which server is this" rule (REVIEW-14 #1) was written twice** (HTTP taps and the gRPC relay), each with its
   own URL parsing and its own cast of mockttp's `destination`.
3. **Three long functions** grew in 0.14: `ConnectFlow.pinVerdict` (67 lines), `ClientCertUi.add` (88) and the
   webview's `CertDialogBody` (120), and `activate()` gained 78 lines of VS Code client-certificate code.
4. **Small constants and shapes were repeated** across host, sidecar and agents: the three file roles, the 300-character
   host limit, the 200 / 1000 learned caps, the learned-entry type (four inline copies), the "non-empty passphrase"
   check (five copies).
5. **Comments that no longer matched**: the webview still said the proxy sends no event when a pin expires (fixed by
   REVIEW-14 #6), two docs disagreed on which cap bounds the `accepted` map, and `PROBE_NEGATIVE_MS` still described
   negative answers only (PERF-2 #2 reuses both).
6. **A QUALITY-1 Q4 regression**: `ProxyLike` again had optional members "so the host compiles against a proxy build
   without them", with a branch and an error text for a proxy that can't exist.

## Changes

### 1. One module for the learned key (proxy, extension)

`packages/proxy/src/learned-meta.ts` (new, 55 lines; exported as `@flutter-intercept/proxy/learned-meta`). It imports
only Node's `net` and `./hosts`, so activation can load it without the proxy or mockttp (PERF-1 #1; a test checks the
import list). Contents:
- `bracketHost(host)`: the one `[v6]` bracketing rule.
- `learnedKey`, `hostLabel`, `parseLearnedKey`: moved from `learned.ts` (which re-exports them, so the proxy's imports
  and tests are unchanged).
- `learnedKeyOf(host, port?)`: moved from `extension/src/ui/handlers.ts`. The writer and the parser of the key are now
  side by side, and the round-trip test no longer `require`s `proxy/dist/learned.js` by path (and no longer passes
  silently when that file is missing).
- `pinKey(client, host, port)` / `pinKeyTarget(key)`: the per-client key of pins, strikes and accepted marks. It
  replaces four template literals (`learned.ts` ×2, `connect-flow.ts` ×2) and the `s.slice(s.indexOf('|') + 1)` in
  `InterceptProxy.forgetLearnedPassthrough`.
- `LEARNED_MAX`, `LEARNED_PER_CLIENT` (moved) and `LEARNED_SHOWN_MAX` (200, new). The host's caps now refer to them:
  `MAX_LEARNED_PASSTHROUGH = LEARNED_MAX`, `STATUS_MAX_LEARNED = AGENT_MAX_LEARNED = LEARNED_SHOWN_MAX` (the names stay,
  because the tests import them).

`upstream-proxy.ts` and `grpc-upstream.ts` each had a private `const bracket`. Both use `bracketHost` now, as do
`pinVerdict`'s record URL and the gRPC relay's error label.

| File | Lines before → after |
|---|---|
| proxy/src/learned.ts | 411 → 394 |
| proxy/src/learned-meta.ts | new, 55 |
| extension/src/ui/handlers.ts | 385 → 387 (the key code went; the cert constants' import got longer) |

### 2. One "which server is this" rule (proxy)

`learn-flow.ts` gained three small exported helpers:
- `connectTargetOf(req)`: the normalised CONNECT target, from the typed `requestInternals`.
- `httpsServerOf(url)`: the server an `https:` URL names, port 443 by default.
- `isSameServer(named, dest)`.

`HttpTaps.refusal`, `GrpcRelay.grpcRefusal` and `InterceptProxy.decide` use them. Removed with them:
- the cast `(req as { destination?: … }).destination` in `decide`;
- the cast `requestInternals(…).destination as {…}` in the relay (the field is already typed in
  `mockttp-internals.ts`);
- two copies of the URL parsing;
- the extra `normalizeHostname` imports (`grpc-relay.ts`, `http-taps.ts`, `intercept-proxy.ts`).

Also in `learn-flow.ts`:
- The nginx text is `NGINX_NO_CERT_TEXT` everywhere. Two literals of the same sentence remained in `verdict`.
- The three "This server needs the app's own client certificate (…)." openings share one `needs` string.
- The probe-answer cap is `PROBED_MAX`, not a bare `1000`.
- `CERT_ALERTS[a] ?? undefined` is now plain `CERT_ALERTS[a]`.

| File | Lines before → after |
|---|---|
| proxy/src/learn-flow.ts | 238 → 275 (helpers and their docs moved in) |
| proxy/src/http-taps.ts | 351 → 343 |
| proxy/src/grpc-relay.ts | 903 → 896 |
| proxy/src/intercept-proxy.ts | 2188 → 2187 |

### 3. `ConnectFlow.pinVerdict` split (proxy)

`pinVerdict` was 67 lines. Its parts:
- strike counting, with the REVIEW-14 #2 sweep: `strike(key)`, 11 lines;
- learning the pin and its two texts: `learnPin(target, client)`, 13 lines;
- the verdict itself, which picks one `PinOutcome {error, learned?}` and builds the record: 48 lines.

The record's error texts, their order of checks and the strike / accepted rules are unchanged. The pin lifetime is read
once, not twice.

Also in `connect-flow.ts`:
- The watched-handshake shape is one exported interface, `WatchedHandshake`. It was written out in full in three places:
  the `decrypting` map, `pinVerdict`'s parameter and `ProxyTestInternals.decrypting`.
- The client `address:port` key is `peerKey(…)`, once instead of three times.
- **Stale or contradictory docs**:
  - `WATCH_MAX` said it also bounded the `accepted` marks, and so did `STRIKES_MAX`. `accepted` now uses
    `STRIKES_MAX`, which matches its doc and its key. Both caps are 1000, so nothing changes.
  - `PIN_STRIKE_WINDOW_MS` now says strikes are per client and that a client which completed a decrypted request
    gets none.
  - `pinVerdict`'s doc now says what `undefined` means (the generic record).

| | Before → after |
|---|---|
| proxy/src/connect-flow.ts | 676 → 721 lines (two interfaces, `peerKey` and two methods with their docs) |
| `pinVerdict` | 67 → 48 lines (+ `strike` 11, `learnPin` 13) |

### 4. `ClientCertUi.add` split (extension; used by VS Code and the sidecar)

`add` was 88 lines. It is now 31 and calls:
- `readChosen(req, host)`, 18 lines: the token lookup and the second read of the files, returning the certificate, the
  entry and the tokens used;
- `store(host, passphrase, entries)`, 38 lines: the REVIEW-14 #4 order. A new passphrase goes first and is put back
  when the write fails; an empty one is deleted only after the write succeeded.

Each step runs in the same order, with the same problems and the same log lines as before. The `lookup(…) as Chosen` and
`req.pfx as string` casts are gone: `chosen(token, role)` takes a token that is known to be there. The request has a
named type (`ClientCertAddRequest`). Ten `e instanceof Error ? e.message : String(e)` became `errText(e)`.

Shared constants, used by the controller's handlers, `ClientCertUi` and the sidecar:
- `CERT_FILE_ROLES` replaces three role lists (`handlers.ts` `CERT_ROLES`, `clientCertUi.ts` `ROLES`, sidecar `ROLES`).
- `MAX_CERT_HOST_CHARS` (300) replaces four literal `300`s (handlers ×2, `remove`, sidecar `deletableHost`). The
  plugin's `MAX_LEGACY_HOST` mirrors it; its doc already says so.
- `nonEmptyString(v)` in `clientCerts.ts` is the "a passphrase is a non-empty string" rule. It replaces five copies:
  the loader, `ClientCertUi` ×2 and the sidecar ×2.

| File | Lines before → after |
|---|---|
| extension/src/ui/clientCertUi.ts | 319 → 345 (`add` 88 → 31; `readChosen` 18, `store` 38) |
| extension/src/ui/clientCerts.ts | 268 → 272 |

### 5. VS Code client-certificate code out of `activate()` (extension)

The VS Code `ClientCertPlatform` and the **Add Client Certificate…** command moved from `activate()` to the new
`src/ui/clientCertVscode.ts` (100 lines): `createVscodeClientCertUi(context, userSetting, log)` and
`registerAddClientCertificateCommand(ui)`. The picker filters and titles, the prompts, the modal Remove question and
the messages are unchanged. The activation import guard still passes; the new module only imports `vscode` and the two
vscode-free modules.

| | Before → after |
|---|---|
| extension/src/extension.ts | 1093 → 1021 lines |
| `activate()` | 908 → 836 lines (0.13: 830) |

### 6. Learned-entry types and `ProxyLike` (extension)

- **One type for a learned entry.** The `{host, port, reason: 'client-certificate' | 'pinned', until?}` shape was
  written out four times. Now:
  - `LearnedPassthroughView = Omit<LearnedPassthrough, 'grpc'>` (`proxyHost.ts`);
  - `AgentApiDeps.host.learnedPassthrough` uses the proxy type the same way;
  - `AgentViews.tlsView` reads it through `AgentApiDeps`, not a looser local type with `reason: string`;
  - both `protocol.ts` copies use `LearnedPassthroughReason` from the proxy's types (type-only, nothing bundled).
- **`ProxyLike` has no optional members again** (QUALITY-1 Q4). `learnedPassthrough` and `forgetLearnedPassthrough` are
  part of the `Pick`. The dead branch for "a proxy build without the API" went with them; its text, "This proxy build
  cannot forget learned hosts.", could never be shown, because the proxy is always bundled.
  - The shared `fakeProxy()` gained the two members.
  - The test that asserted the dead branch now asserts that a proxy with nothing learned lists nothing, that forget
    is a no-op, and that no event is sent.
- **One doc block for `certTokens`.** `InterceptController.certTokens` had two stacked JSDoc blocks (the orphaned-doc
  pattern QUALITY-1 §3 found); they are now one.

| File | Lines before → after |
|---|---|
| extension/src/proxyHost.ts | 1470 → 1462 |

### 7. Sidecar

`sidecar/src/clientCerts.ts` (173 → 174 lines):
- `SidecarClientCertEntry` is now an alias of the extension's `ClientCertEntry`. It was an identical copy.
- The "same stored entry" key is one `entryKey()`; it was two `JSON.stringify` copies.
- `entriesForPlugin` keeps `optPath`'s result instead of re-reading the raw field with `as string` (3 casts gone).
  The checks run in the same order with the same messages.
- It uses `CERT_FILE_ROLES`, `MAX_CERT_HOST_CHARS` and `nonEmptyString` (item 4).

### 8. Webview

- `CertDialogBody` was 120 lines, with a `fileRow` closure inside it. The closure is now a `CertFileRow` component
  (25 lines; the first button's ref is passed as `buttonRef`), and `CertDialogBody` is 104 lines. The markup,
  labels, ARIA attributes and focus order are unchanged. `Certificates.tsx` went from 357 to 369 lines.
- **Stale REVIEW-14 #6 comments** (three places) said the proxy sends no event when a pin expires. Since REVIEW-14 #6
  it does, on a timer. The comments now say why the panel still filters: the Status it holds may list a pin until the
  next broadcast arrives.
- `LEARNED_REASON` is re-exported from `certificates.ts` with an `export … from`, not a bare `export { }` in the middle
  of the file. `learnedKey`'s doc says it is the panel's display name. The proxy's key is written by the host
  (`learnedKeyOf`).

### 9. Plugin (Kotlin)

`UiRequestHandler.kt` (396 → 401 lines):
- `secrets.clientCertPassphrase` and `secrets.setClientCertPassphrase` were inline blocks in `handle()`'s `when`. They
  are now `clientCertPassphrase(p)` and `setClientCertPassphrase(p)`, like the other three §20.3 requests.
- The "bring the project window to the front" step was repeated in the chooser and the Remove confirmation. It is now
  `focusActiveProject()`.

The requests, refusal codes and messages are unchanged.

### 10. Guards and tests added

| What | Where |
|---|---|
| `learned-meta.ts` imports only `net` and `./hosts`; `learned.ts` re-exports the same definitions | proxy `test/learned-meta.test.ts` (new) |
| `bracketHost`, `learnedKey`, `hostLabel` (had no direct test), `pinKey` / `pinKeyTarget`, `learnedKeyOf` ↔ `parseLearnedKey` round trip | same |
| `httpsServerOf`, `connectTargetOf`, `isSameServer` (REVIEW-14 #1 cases) | same |
| `protocol.ts` drift test now runs both ways (a type added only to the host copy fails too) | extension `test/unit/protocol.drift.test.ts` |
| The round-trip test imports the shared parser; it no longer `require`s a dist path and no longer passes silently when the file is missing | extension `test/unit/controller.v0140.test.ts` |
| Webview `learnedKey`, `learnedBannerText`, `LEARNED_REASON` (had no direct test) | webview `test/components-v14.test.tsx` |
| Plugin `legacyHostProblem` (had no direct test) | `ClientCertificateRequestsTest.legacyHostsOnlyNameAPassphrase` |

## Results

| Package | Tests before → after | Other checks |
|---|---|---|
| proxy | 576 → 583 passed | `tsc --noUnusedLocals --noUnusedParameters` clean |
| webview | 566 → 567 passed | `tsc` clean |
| extension | 2146 → 2146 passed (one test rewritten, §6) | `tsc` clean; LM tools = `schema.ts`; activation import guard passes |
| sidecar | 50 → 50 passed | `tsc` clean |
| plugin | 105 → 106 passed | `buildPlugin` and `verifyPlugin`: Compatible |
| extension bundle | 2,509,960 → 2,511,963 B (+2.0 KB, budget 2,550,000) | `test:bundle` ok: 42 MCP tools, tunnels, mock + 502 |

The 2 KB are the new modules' wrappers and the shared helpers (`connectTargetOf`, `learnedKeyOf` in the proxy's half,
`readChosen` / `store`). Nothing new was pulled in.

## Not changed (owner's call, or would change behaviour)

- **IPv6 prefill.** The webview's `certHostFor` (the popup's host prefill) and `learnedKey` (the panel's label) don't
  bracket IPv6. A learned `2001:db8::1` on port 8443 is prefilled as `2001:db8::1:8443`, which `parseHostPattern`
  reads as a bare IPv6 address, not `[2001:db8::1]:8443`. That is a bug fix, not a refactor. It needs `[v6]` in the
  webview, and the webview can't import `learned-meta` (it uses `net`); a node-free `isIPv6` in `grpc-meta.ts` would
  do.
- **`ControllerHost.learnedPassthrough?` / `forgetLearnedPassthrough?` stay optional.** That follows the convention of
  that interface ("optional on older hosts", like §16.4). Its error text, "Forgetting learned hosts isn't available
  here.", is reachable with a host that leaves them out, and a test covers it.
- **`writeEntries(next as ClientCertEntry[])`.** The other entries in the list are written back exactly as read from
  user settings, which are `unknown`. Typing `writeEntries` as `readonly unknown[]` would change the platform interface
  in three places for no runtime gain.
- **Cross-language duplicates** that can't share code: the chooser-busy text and the 260 / 300 / 4096 limits exist in
  the sidecar (TS) and the plugin (Kotlin); each side documents the other's value.
- **QUALITY-1 leftovers outside the 0.14 diff:**
  - 2 unused imports (`codegen/fixtures.ts` `Exchange`, `contract.service.test.ts` `fs`);
  - 2 unused parameters (`contract/api.ts:256`, `grpc/codec.ts:388`);
  - sidecar `state.ts` `dir`;
  - the `errorMessage` helper (Q10);
  - `noUnusedLocals` in the base configs (Q0). With it on, `ui/handlers.ts` needs `_`-prefixed `msg` / `reply`
    parameters.
- PERF-2 #5 (`ruleNamingHost` per CONNECT to a learned host) is a known cost, not a quality item.
