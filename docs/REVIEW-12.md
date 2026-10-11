# Review 12: v0.12.0 security (independent, `feature/0.12.0` at 59e7c8d) — findings and fix plan

Scope: gRPC tools complete (`git diff main..HEAD`). That covers:
- the proxy: rewrite of gRPC metadata and trailers (`grpcRewriteMeta`, `rules.ts` `rewriteMetadataProblem`,
  `GRPC_REWRITE_RESERVED` / `GRPC_TRAILER_RESERVED`), script hooks (`grpcScriptMessage`, `grpcStatusScript`,
  `grpcDecodeBounded`, `script.ts` `mentionsGrpcHooks` and the hook dispatch), map remote for gRPC (`grpcFlowFor`,
  `grpcRelay` target / `:authority`, LAN and client-certificate checks), `send()` for gRPC (`sendGrpc`, `runSendGrpc`);
- the host: `validateRule` / `checkRewriteSpec` / `grpcRewriteProblem`, `validateSendDraft` / `checkSendGrpc`,
  `sanitizeGrpcSendHeaders`, `grpcResendMessages`, `resolveSendGrpc`, the controller's `send` case, the shared-rule policy
  (`approvalReasons`, `actionSecret`), the script template;
- agents (`resend_request` with `grpc`, `resendGrpc`, `restoreRedactedJson`, `add_rewrite` trailers, schema, tool docs,
  confirmations);
- the webview (rule templates from an exchange, rewrite trailers form, gRPC "Edit and resend" composer).

Spec: CONTRACTS §18 (esp. §18.5), §16–§17, §7, §8, §9.2, §12.1, §13.4; docs/spikes/grpc.md "As built — proxy
(0.12.0)"; guarantees from REVIEW-11.

I read the code and ran throwaway probes in the session scratchpad (outside the repo, vitest against the real sources and
the repo's test helpers `startProxy`, `h2cSession`, `grpcCall`, `startGrpcServer`, plus an esbuild bundle of
`agent/redact.ts`):
- `send({grpc})` with a block rule, the offline profile and strict replay in force;
- gRPC calls addressed to the proxy itself, with and without a Map Remote rule (HTTP for comparison);
- caller `grpc-timeout` values on `send`;
- script rules whose gRPC hooks are only in a comment; event-loop cost of the hook path on 200 × 1 MB messages;
- `redactLogLine` on script log lines that carry protobuf messages as base64.

I did not run the unit, integration, device or CLI suites, start an IDE or touch devices.

Threat model as in REVIEW-1 to REVIEW-11: a malicious cloned repo (trusted workspace); a malicious or prompt-injected
agent that only has our tools; a malicious app under debug; hostile servers and web pages; other local users. New in
0.12.0: rules change and redirect gRPC calls, scripts see every gRPC message, the proxy opens gRPC calls of its own.

| # | Sev | Finding | Owner |
|---|---|---|---|
| 1 | MED | **A gRPC call addressed to the proxy itself relays to itself without end.** No loop check on the gRPC path (mockttp catches the HTTP case). One h2c request to the proxy port → ~1 500 exchanges/s, +40 MB RSS/s, all `pending`, still pending after the client leaves. Reachable from any local process, the app under debug (`10.0.2.2:8899`), and new in 0.12 from a **shared Map Remote rule to `http://127.0.0.1:8899`** (loopback: no approval; 8899 is the default port) or an agent's `add_map_remote`. | P (+ H) |
| 2 | LOW-MED | **`send()` for gRPC ignores rules, the network profile and strict replay.** With a block rule, the offline profile and `fallback: 'fail'`, the app's call gets `14`, but `send({grpc})` (agent `resend_request` too) reaches the real server with the recorded credentials. HTTP `send` goes through the listener, and CONTRACTS §9.2 says the profile applies to `send`. The agent tool doc says "Rules and the network profile apply" (wrong for gRPC). Shared block rules, which agents can't remove, are bypassed; a Map Remote rule is skipped too, so the resend goes to the original server. | P + A |
| 3 | LOW | **Script log lines with gRPC messages as base64 reach agents unredacted.** `redactLogLine` can't see inside base64: `context.log(message.base64)` for `Login{user, password}` passes as is. 40 characters with no digit isn't an "opaque token". `get_request` shows the same message decoded, with `password` "[redacted]". | A |
| 4 | INFO | Smaller items: a caller `grpc-timeout` over ~596 h overflows `setTimeout` and cancels the send at once, and there is no upper bound below that; `messagesJson` "[redacted]" values are restored from the original method's messages even when `edit.url` names another method; `messagesJson` has no total size cap before encoding (100 × 4 MB of JSON encoded on the event loop); `onGrpcStatus` `message` has no length cap in the proxy; the webview's reserved list lacks `grpc-status-details-bin`; rules approved before 0.12 now also act on gRPC calls; the commented hooks in the default script template turn on the hook path (perf only, confirmed); an evicted `resentFrom` skips the LAN check (editor only). | various |

## Details

### 1 (MED) A gRPC call addressed to the proxy itself relays to itself without end

`intercept-proxy.ts` `grpcRelay` connects to `flow.map?.url ?? req.url` through `GrpcSessionPool` with nothing that
recognises the proxy's own listener. The relayed request arrives at the proxy as a new h2c call to the same authority,
matches the same rules and is relayed again. HTTP has mockttp's passthrough loop detection ("Passthrough loop
detected", 500 after one hop). `checkUpstreamLoop` covers the upstream proxy setting only. `send()` checks
`isTraceHost` but not the proxy's own address.

Probe (fresh proxy, no rules unless noted; the client keeps the call open):

| Trigger | Exchanges | Notes |
|---|---|---|
| HTTP, Map Remote `*/echo*` → `http://127.0.0.1:<proxy port>` | 2 | mockttp: 500 "Passthrough loop detected" |
| gRPC, Map Remote `*/t.Echo/*` → `http://127.0.0.1:<proxy port>` | 10 192 in 3 s | client never answered |
| gRPC through a CONNECT tunnel to `127.0.0.1:<proxy port>`, no rule | 11 044 in 2 s | |
| gRPC, direct h2c (prior knowledge) to the proxy port, no rule | 1 307 / 2 887 / 4 126 at 1 / 2 / 3 s | RSS +75 / +120 / +161 MB; 1 s after the client left: 4 127 `pending`, RSS +185 MB |

Who can trigger it:
- **A cloned repo:** a shared rule `{"match": {"url": "*"}, "action": {"kind": "mapRemote", "to": "http://127.0.0.1:8899"}}`.
  `isLoopbackTarget` lets loopback targets through without approval (`policy.ts:106`), and 8899 is the default
  `flutterIntercept.port`. The first gRPC call of the app then spins the extension host (every extension in it) until
  the app gives up, and the chain's exchanges are left `pending`.
- **An agent with write access:** `add_map_remote` to `http://localhost:<port>`. Agents may map to loopback, and
  `get_status` gives the port.
- **Any local process or local user:** one h2c request to the proxy port. **The app under debug:** a call to
  `10.0.2.2:8899` (aliased to loopback).
- Not LAN clients: `lanTargetDenial` refuses this machine.

The engine itself dates from 0.10 (relay). 0.12 makes it reachable from shared rules without approval and from
agents, so I rate it MED.

**Fix (P, H):**
- Mark relayed calls. On entry to the h2c gRPC handler, before `forwardableHeaders` strips `flutter-intercept-*`, refuse
  a request that carries this instance's random nonce (`flutter-intercept-hop: <nonce>`) with `14` ("the target is
  Flutter Intercept itself; that would loop"). Add the header in `grpcRelay` and `runSendGrpc` after stripping. This also
  catches `localhost`, `0.0.0.0`, this machine's LAN addresses and DNS names that resolve here.
- Cheap early check as well: in `grpcRelay` / `sendGrpc`, refuse a loopback or unspecified target whose port is
  `_port` or the LAN listener's port (like `checkUpstreamLoop`'s `ours`).
- Host: `checkMapTarget` / `isLoopbackTarget` treat a target on the proxy's own port as invalid (or at least as needing
  approval).
- Tests: one direct h2c call to the proxy port → one exchange, status 14; the shared-rule probe → one exchange.

### 2 (LOW-MED) `send()` for gRPC ignores rules, the network profile and strict replay

`sendGrpc` builds the exchange itself and calls `runSendGrpc`, which goes straight to `grpcPool.acquire`. Nothing runs
`grpcFlowFor`, the profile or the replay store. HTTP `send` posts to the proxy's own listener, so `decide()` applies
everything (`flow.send` only tags the exchange).

Probe (block rule `*/t.Echo/*`, `setNetworkProfile({kind: 'offline'})`, `setReplay([], {fallback: 'fail'})`):
```
app call:  grpc-status 14, server saw nothing
send({grpc}, initiator: 'agent'):  completed 0, matchedRuleId -, simulated -
  server saw: call /t.Echo/Unary, grpc-timeout 60S, authorization "Bearer secret"
```

- CONTRACTS §9.2 says the network profile applies to everything that would reach the network, `send` included. The
  `resend_request` tool doc tells agents "Rules and the network profile apply". Only the README's gRPC section says they
  don't.
- Effects:
  - With the offline profile or a strict replay (meant as "nothing reaches the real backend"), a Resend click or an
    agent's `resend_request` sends a real call with the recorded credentials.
  - A **shared** block rule, which agents can't remove (`removeRule`), doesn't stop an agent's gRPC resend.
  - A Map Remote rule for the method is skipped, so the resend goes to the original (e.g. production) server instead
    of the mapped one.
- Limits: `resend_request` is a confirmed write tool and the confirmation says "to the real server". An agent can change
  the profile (`simulate_network`) and remove non-shared rules, so for a malicious agent the gain is the shared rules
  and strict replay. For a careful agent, the doc leads it into the wrong expectation.

**Fix (P + A):**
- In `sendGrpc`, decide like the relay: `grpcFlowFor(url, match(…))` plus the profile and replay checks.
  - A local answer (block, fault, grpcMock, replay, offline, `fallback: fail`, `localError`): record that outcome
    without connecting, or refuse with the reason.
  - `mapRemote`: send to the mapped target (with the LAN and client-certificate checks of §18.3).
  - `rewrite`: apply the request metadata. `throttle`: apply or note.
  - At the least, refuse while offline or in a strict replay, and when a matching rule answers locally.
- Make the agent doc and the README agree with the behaviour.
- Test: the probe above records `blocked` / `error`, and the server sees nothing.

### 3 (LOW) Script log lines with gRPC messages as base64 reach agents unredacted

`onGrpcMessage` receives `base64` (and `json`). `scriptLog` goes to agents through `redactLogLine` (`api.ts:570`). That
function redacts JSON keys, `name=value` pairs and opaque tokens (≥ 32 characters with upper, lower and digit), but it
can't decode a protobuf.

Probe (`redactLogLine`):
```
message 0 of /auth.Auth/Login ChFhbGljZUBleGFtcGxlLmNvbRIHaHVudGVyMg==   → unchanged   (alice@example.com / hunter2)
send CgVhbGljZRIENDgyMQ==                                                → unchanged   (alice / 4821)
{"json":{"password":"hunter2"}}                                          → password "[redacted]"
```

- Logging the message bytes is a natural first debugging line. The template logs only index and path (good).
- Agents can't write scripts (`hasScript` → refused) or read their code. So this needs the user's own script to log
  bytes. Still, it gets past the protection `get_request` gives the same message.

**Fix (A):**
- In `redactLogLine`, redact any base64 word of ≥ 16 characters that decodes to a plausible protobuf (or simply any
  base64-looking word ≥ 16 characters when the exchange is `kind: 'grpc'`).
- Or, in the proxy, record per call which script log lines were produced from a gRPC hook and let the agent view drop
  base64 runs in them.
- Mention it in the template comment ("logs are shown to agents redacted; message bytes can't be redacted").

### 4 (INFO) Smaller items

- **Send deadline.** `parseGrpcTimeout` accepts up to `99999999H`.
  - `deadlineMs` > 2³¹ − 1 makes Node fire the timer after 1 ms. Probe: `597H` → `error`, "No answer within the
    deadline (2149200000 ms)" at once. `596H` works.
  - Nothing bounds the deadline below that, so a resent server-streaming call can stay open for ~24 days.
  - Clamp the send deadline, e.g. to 10 minutes, and say so.
- **`messagesJson` restore across methods.** `resendGrpc` restores "[redacted]" from the decoded messages of the
  original exchange (same index and key path) even when `edit.url` names another method. The secret then goes to that
  method's request field with the same JSON name.
  - HTTP header restoring also follows `edit.url`, and REVIEW-11's resume rule ("only where the held message was
    going") is stricter.
  - Restore only when the method path is unchanged, and otherwise refuse "[redacted]".
- **No total cap on `messagesJson`.** `checkSendGrpc` caps each JSON message at 4 MB, and the 16 MB total is checked
  only after `resolveSendGrpc` has encoded all of them on the event loop (up to 100 × 4 MB). Check the JSON total
  (e.g. 16 MB) before encoding.
- **`onGrpcStatus` message length.** `grpcEditProblem` checks the type only. Breakpoint edits get the host's 4 KB cap
  (`validateGrpcEdit`); script returns never pass the host. A long message is percent-encoded byte by byte
  (`encodeGrpcMessage`) on the event loop and then exceeds HTTP/2 header limits. Cap it at 4 KB in the proxy.
- **Reserved lists.** Proxy (`GRPC_REWRITE_RESERVED`) and host (`GRPC_RESERVED_METADATA`) agree, including
  `grpc-status-details-bin`. The webview's `RESERVED_GRPC_METADATA` lacks it, so the editor accepts what the host
  then refuses (usability only).
- **Earlier approvals now reach gRPC.** A shared rewrite, Map Remote or script approved under 0.11 keeps its approval
  (same content hash). A `*` glob now also redirects or rewrites gRPC calls with their credential metadata, and a
  script's `onGrpcMessage` (dead code under 0.11) starts running. The approval texts already say "every matching
  request". Optionally add "including gRPC calls" and re-ask once for rules whose glob can match a gRPC path.
- **`mentionsGrpcHooks`.** A hook name in a comment or string turns on the hook path, and the default template has
  both hooks commented out, so this is the common case. Effects:
  - Each message goes through the worker (`missing`) and, with a schema, through the codec (within the REVIEW-11 #6
    budget).
  - Probe: 200 × 1 MB response messages, no schema: event loop busy 811 ms (no rule), 888 ms (commented hooks),
    849 ms (empty hook). Messages and status are unchanged.
  - So it costs time but never changes behaviour. A hook defined dynamically (`globalThis['onGrpc' + 'Message']`)
    never runs, and the call passes through unchanged.
  - Optional: after the first `missing` on a call, forward the rest without the worker or the decode.
- **Evicted `resentFrom`.** `sendGrpc`'s LAN check reads `store.get(resentFrom)`. If the LAN record has left the store,
  a resend from the panel is treated as local (loopback path, emulator alias, no `lanTargetDenial`). The agent path
  refuses unknown ids, so this is editor only. Fail closed when `resentFrom` is given but unknown, or carry `viaLan` in
  the request from the host.

## Checked, fine

- **Rewrite validation (§18.1):**
  - Proxy `ruleProblem` refuses pseudo headers and `grpc-status / -message / -timeout / -encoding / -accept-encoding /
    -status-details-bin` in every side. Trailers also refuse `content-type`, `te`, `host` and hop-by-hop names.
    Values with CR / LF / NUL and non-base64 `-bin` values are refused.
  - The host adds token names, `content-type` / `te` for gRPC-method globs, and the same reserved set.
  - At apply time `grpcRewriteMeta` checks again (`HTTP_TOKEN`, both reserved sets, `validHeaderValue`, base64) and
    skips with a note. So `host`, `connection`, `te` or `content-type` can't be injected into the upstream call even by
    a rule that bypassed validation.
  - The recorded request headers are the rewritten ones.
- **Shared-rule policy:**
  - Request metadata set / remove needs approval (same reasons as HTTP).
  - Trailers go through `responseHeaderReasons`, and `actionSecret` checks `setTrailers` for credentials.
  - Every shared script needs approval, with the hash over the file. A non-loopback Map Remote needs approval
    (loopback: see #1).
- **Map Remote (§18.3):**
  - `mapRemoteUrl` result restricted to http(s) (else `14` with the rule error, before any connection).
  - The LAN deny check (`lanTargetDenial`) and `certRefusal` use the mapped URL.
  - The pool key includes the LAN gate, and gate sessions resolve and check the target at connect (no DNS-rebinding
    reuse of a local session).
  - `rejectUnauthorized` and client certificates are chosen for the mapped host.
  - The offline profile and `fallback: fail` still apply (`reachesNetwork` covers rewrite / script / mapRemote).
  - `:authority` is the new host unless `preserveHost`. `:path` comes from the parsed URL.
- **`send()` for gRPC (apart from #1, #2):**
  - Method POST and a method path without a query.
  - Base64 checked; ≤ 100 messages, ≤ 4 MB each, ≤ 16 MB total; `messagesJson` refused in the proxy.
  - Header names and values checked by `send()` (token, no CR / LF / NUL). Pseudo, hop-by-hop, `content-type`,
    `grpc-encoding`, `proxy-authorization` and internal headers dropped; `:authority` from the URL.
  - Messages are sent uncompressed. The default deadline cancels the stream.
  - A resend of a `viaLan` exchange needs LAN mode on, passes `lanTargetDenial` and uses the gate's guarded pool path
    (no emulator alias).
  - Upstream TLS is strict unless the user's `ignoreUpstreamCertErrors` names the host.
- **Agents:**
  - `resend_request` is a write tool (confirmed in VS Code).
  - Refused for `viaLan`, rule-handled, agent / editor-initiated, unfinished and `lan-` / `tls-` records.
  - `edit.url` must keep the origin and name a gRPC method; `edit.body` and non-POST methods are refused.
  - Headers go through `restoreRedactedHeaders` and `sanitizeGrpcSendHeaders`.
  - `restoreRedactedJson` (own properties, `defineProperty`, depth ≤ 64) restores only an exact "[redacted]" at the
    same index and key path. It needs a schema decode of an untruncated original. Otherwise "[redacted]" is refused.
  - Confirmations show counts, never message bytes or restored values.
  - `add_rewrite` trailers go through the response-header checks and the "[redacted]" refusal. Agents still can't add,
    change or read scripts.
- **Script hooks (§18.2, apart from #3):**
  - Same worker and vm sandbox as 0.7 (no new globals; dispatch on a host-chosen hook name). 200 ms per call, 1 s
    watchdog, 64 MB heap + external cap, queue ≤ 100 / 2 s.
  - Messages over 1 MB aren't passed. At most 1000 `onGrpcMessage` calls per call. Codec decode within the REVIEW-11
    budget.
  - Returns are validated (one key; base64 regex; encode errors and > 4 MB replacements fall back to the original).
  - `onGrpcStatus` returns go through `grpcEditProblem` (codes 0–16, trailer names / values).
  - A throw, a timeout, an engine stop or a full queue all forward the original. `scriptLog` stays ≤ 20 lines of
    ≤ 500 characters per exchange.
  - The trailers-only path doesn't set `localReset` while a status hook runs (REVIEW-11 #5 kept).
  - HTTP hooks never run for gRPC calls.
- **Host send path:**
  - `validateSendDraft` (`checkSendGrpc`): POST, gRPC method URL, no body, exactly one of `messages` /
    `messagesJson`, caps.
  - `grpcResendMessages` refuses truncated, `sizeUnknown` or dropped-from-record messages. `resolveSendGrpc` encodes
    with the method's request type, and errors name the index.
- **Webview:**
  - No new `innerHTML` / `dangerouslySetInnerHTML` / `href` / `eval` sinks. The composer's JSON and base64 messages,
    rule names from gRPC paths, and trailers are Preact text and textarea values.
  - Rule templates open unsaved in the editor; nothing reaches the proxy until the user saves. Edits go through the
    host's validation.
