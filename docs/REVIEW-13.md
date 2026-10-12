# Review 13: v0.13.0 part 1 — gRPC-Web and grpcurl

Independent security review of `feature/0.13.0` up to 375ab47 (part 1). The later simulator-trust commits are not covered
here; they don't touch the code below.

Scope (`git diff main..375ab47`):
- the proxy's passive gRPC-Web reader (`grpc-web.ts`: `grpcWebVariant`, `Base64Stream`, `GrpcWebFrameParser`,
  `parseGrpcWebTrailers`, `GrpcWebRecorder`) and its wiring (`taps.ts` `onRequestData` / `onHeadSeen`,
  `intercept-proxy.ts` `watchGrpcWeb`, `syncGrpcWeb`, the `emitChange` body drop);
- gRPC-Web answers: `answerGrpcWeb`, `grpcWebBody`, the gRPC-Web `block`, `addGrpcWebCors`, the local preflight for a
  matching `grpcMock`, the `mutate` fallback;
- the grpcurl snippet (`codegen/grpcurl.ts`, `snippetFor`, the agent `redactedSnippet`);
- agents and HAR (`grpc.web`, `resend_request` refusal, `get_request snippet: "grpcurl"`);
- the webview (gRPC-Web rows, badges, trailers, "Copy as grpcurl", the resend refusal).

Spec: CONTRACTS §19.1–19.2, §16, §11.3, §8, §9; docs/spikes/grpc.md "As built — proxy (0.13.0)"; guarantees from
REVIEW-12.

I read the code and ran throwaway probes in the session scratchpad, outside the repo. The probes used the built
`@flutter-intercept/proxy` and esbuild bundles of `agent/har.ts`, `agent/redact.ts`, `rules/policy.ts`,
`recordings/grpc.ts` and `codegen/snippets.ts`:
- a hostile upstream that answers a gRPC-Web call with small `content-encoding: br` bodies (zeros, tiny compressed
  messages, repeated trailer frames, padded base64 groups), one call and four in parallel;
- trailer frames with the names `constructor` and `__proto__`, and with CR, NUL and ESC in values, run through the
  proxy and then through `buildHar`, `redactGrpcMetadata` and `customMetadata`;
- a shared `grpcMock` with `Set-Cookie` and `Access-Control-*` headers: `approvalReasons` and the answer the browser gets;
- `shellQuote` fuzzed against `bash -c` and `zsh -c` (300 random strings of quotes, `$`, backticks, `!`, control
  characters, NUL and Unicode).

I did not run the unit, integration, device or CLI suites, start an IDE or touch devices.

Threat model as in REVIEW-1 to REVIEW-12: a malicious cloned repo (trusted workspace); a malicious or prompt-injected
agent that only has our tools; a malicious app under debug; hostile servers and web pages; other local users. New in
0.13.0:
- the proxy parses, and decompresses, every gRPC-Web body that passes through it. The server picks those bytes, and any
  web page in the proxied browser picks the server.
- `grpcMock` answers now reach a browser.

| # | Sev | Finding | Owner |
|---|---|---|---|
| 1 | MED | **The gRPC-Web reader turns a ~100-byte response into seconds of event-loop work and ~1 GB of heap; a few in parallel crash the extension host.** It decodes HTTP `br` / `gzip` bodies up to 64 MB per response, but that output is not what costs. The cost is the number of frames (13.4 M empty frames in 64 MB of zeros), trailer frames parsed over and over (quadratic for repeated names), and a frame queue that keeps growing after the call is forgotten. **Probe:** 106 B on the wire → ~3.5 s at 100 % loop and 940 MB heap; 4 parallel with a 2 GB heap → `JavaScript heap out of memory`. 34 B of repeated trailer frames → ~4 s at 100 % for 6.5 MB decoded (≈ 40 s at the 64 MB cap). | P |
| 2 | LOW-MED | **Shared `grpcMock` rules now set `Set-Cookie` and `Access-Control-*` in the browser without approval.** `actionApprovalReasons` has no `grpcMock` case. Before 0.13, a grpcMock only answered the Dart app's HTTP/2 calls. Now its `headers` (and its `trailers`, on a trailers-only answer) go to the Flutter Web browser. A shared HTTP `mock` with the same headers needs approval (3 reasons). **Probe:** grpcMock → 0 reasons; the browser gets `set-cookie: session=attacker…` and `access-control-allow-origin: https://evil.example` with `allow-credentials: true`. | H |
| 3 | LOW | **A trailer named `constructor` puts a function into `responseTrailers`. Every redacted export then throws.** `parseGrpcWebTrailers` writes into `{}`, so a repeated-name merge reads the inherited `Object.prototype.constructor`. The result is `constructor: [Function Object, "boom"]`. `redactGrpcMetadata` throws `text.includes is not a function`, so `get_request` for that call and **every redacted HAR export of the session** fail (agents' `export_har` included). A recording save stores `[null, …]`, and loading it back fails. Lone CR, NUL and ESC are also kept in values. `__proto__` only swaps the map's own prototype (no global pollution). | P (+ A) |
| 4 | INFO | Smaller items: `-insecure` for every `decryptHosts` host, on a command that carries real credentials; the grpcurl snippet ignores `maxBodyChars` and decodes every request frame; a locally answered preflight for a grpcMock is cached for 5 s, so a request that the mock doesn't answer can reach the real server; frames decoded after the call is forgotten are lost (wrong counts); `GrpcWebBody` in the webview never renders; the deferred (body-condition) match doesn't pass `grpcWeb`. | various |

## Details

### 1 (MED) gRPC-Web decompression and framing amplification (event loop, memory, crash)

`GrpcWebRecorder.responseHead` pipes `content-encoding: gzip / deflate / br` bodies through zlib and stops after
`GRPC_WEB_DECODE_CAP_BYTES` (64 MB) of output. The cap bounds bytes but not the work done for each frame:
- **Frames.** Every 5 decoded zero bytes are one empty message frame, so 64 MB is 13.4 M frames. Each one does
  `GrpcFrameRecorder.push` → `messageFrame` → `sink` → `st.queue.push` → `syncGrpcWeb`. Once the exchange has finished,
  each frame also goes through `addFrame(…, late)` → `emitChange` → `snapshot` (+ `evict`). That is one `exchange`
  event per frame (29 495 events in the probe).
- **No consumer after the call is forgotten.** `onResponseDone` deletes the `grpcWebCalls` entry once the frames
  pushed *so far* are idle (+ 50 ms). After that the zlib stream and the parser keep running, the sink keeps pushing
  into `st.queue`, and `syncGrpcWeb` returns early, so the queue only grows until the stream ends. The client already
  has its 106-byte answer by then, so the decode is all after the end.
- **Trailer frames.** Every `0x80` frame is parsed, not just the first. `parseGrpcWebTrailers` merges repeated names
  with `[...prev, v]`, which is quadratic: a 16 KB frame of `a:` lines takes 10.6 ms (0.3 ms with distinct names).
  64 MB holds ~4 000 such frames.
- **Compressed message flag.** `0x01` frames with `grpc-encoding: gzip` start one `decompressPrefix` (a zlib stream)
  each, eagerly in `push`. This path is the same as native gRPC, but here an HTTP `br` body multiplies it: 200 000
  one-byte compressed messages in 16 B → ~2.7 s at 100 %.

Probe (fresh proxy, no rules; a Node HTTP server answers `POST /t.S/M`; the client sends one empty frame):

| Response body (wire bytes) | Event loop | Heap / RSS | Recorded |
|---|---|---|---|
| br, 8 MB of zeros (14 B) | busy ~1.5 s | RSS +205 MB | 9 830 messages (of 1.68 M) |
| br, 64 MB of zeros (106 B) | 99 % for ~3.5 s, max delay 271 ms | heap 940 MB peak, RSS +1.1 GB | 9 830 messages (of 13.4 M) |
| same, 4 calls in parallel, `--max-old-space-size=2048` | 100 % for 7 s | **FATAL: JavaScript heap out of memory** | — |
| br, 400 trailer frames of 5 461 `a:` lines (34 B) | 100 % for ~4 s | RSS +150 MB | trailers parsed 400× |
| br, 200 000 compressed 1-byte messages (16 B) | 100 % for ~2.7 s | RSS +150 MB | 5 461 messages |
| br, 16 MB of `AA==` (-text, 29 B) | < 1 s | RSS +130 MB | linear (fine) |

Who can trigger it:
- **Any server a gRPC-Web call reaches**: a compromised or third-party backend, or one the attacker runs.
- **Any web page in the proxied browser.** A page picks the URL of its own `fetch`, and the server answers the CORS
  preflight itself. The `content-type: application/grpc-web` header alone marks the flow.
- **LAN devices in LAN mode** (a POST to a server of their own; `lanTargetDenial` only refuses this machine) and local
  processes.

What it hits: the proxy runs in the extension host, so every extension stalls, and with a few parallel responses the host
dies. HTTP bodies before 0.13 were decoded for display under `decodeForDisplay`'s caps. The new reader is the first
streaming decode with work per frame.

**Fix (P):**
- **Stop the reader when the call is forgotten.** On `onResponseDone`, once the queued frames are delivered (or after a
  short grace), destroy the zlib stream and make `feed` a no-op. `syncGrpcWeb` without a state should also drop the
  queue. Better: a hard deadline per call (e.g. 2 s of decode after the end), then a note.
- **Count frames, not just bytes.** Stop reading after e.g. 10 000 message frames per direction (the store keeps 500),
  with a note "… more messages were not read". Keep counting `messagesReceived` cheaply (header-only skip) if needed.
- **Trailers.** Parse only the first `0x80` frame; anything after it is a protocol error (stop, with a note). Merge
  repeated names with `push`, and cap lines (e.g. 200).
- **Coalesce.** Batch `syncGrpcWeb` per tick (microtask or `touch`) instead of per frame, and send late frames through
  `touch`, not `emitChange`.
- **Decode cap.** Lower it (16 MB is plenty for display), and count it across calls (a global budget of decoded bytes
  per second), like `GRPC_HELD_TOTAL_CAP_BYTES`.
- **Compressed messages.** Limit concurrent `decompressPrefix` work per call (e.g. the first 100 compressed messages;
  later ones `sizeUnknown` with no payload). This helps native gRPC too.
- **Tests:** 64 MB of br zeros → bounded time (< 300 ms busy) and heap (< 50 MB); 4 000 trailer frames → one parse and
  a note; heap is back to baseline 1 s after the call.

### 2 (LOW-MED) Shared `grpcMock` headers reach the browser without approval

`rules/policy.ts` `actionApprovalReasons` has cases for `mapRemote`, `rewrite`, `mock`, `script` and `cors`, and
`default: break` for the rest. A shared `grpcMock` therefore needs no approval, whatever its `headers` / `trailers`
say. `validateRule` (`GRPC_MOCK_FORBIDDEN`) and the proxy's `grpcMockProblem` reject framing and status names but allow
`set-cookie` and `access-control-*`.

New in 0.13:
- `answerGrpcWeb` sends `{...custom headers, content-type}` to the **browser**.
- On a trailers-only answer (code ≠ 0 and no messages), the trailers become HTTP headers too.
- `addCorsToLocalResponse` leaves an `Access-Control-Allow-Origin` that is already there alone.

Probe (rule `{"match": {"url": "*"}, "action": {"kind": "grpcMock", "messages": ["CgJoaQ=="], "headers": {…}}}`):
```
approvalReasons(shared mock with the same headers)  → 3 reasons (cookie, 2 × CORS)
approvalReasons(shared grpcMock)                    → 0
browser call (Origin http://localhost:5000) gets:
  set-cookie: session=attacker; Path=/; Secure; SameSite=None
  access-control-allow-origin: https://evil.example
  access-control-allow-credentials: true
```

Effects:
- **Cookie fixation for the real API's origin** in the Flutter Web debug browser. The mocked call is
  `https://api.real.example/pkg.S/M`, so the cookie belongs to that host and later (unmocked) requests carry it to the
  real server.
- **A foreign origin may read the mock with credentials.** What it reads is the rule's own content, so on its own this
  is low value.
- Agents can't do this: `add_grpc_mock` takes no headers or trailers. User-made rules are the user's choice.
- The trigger is a cloned repo's shared rules file. The rule applies with no prompt.

**Fix (H):**
- Add a `grpcMock` case: `responseHeaderReasons(a.headers)` and `responseHeaderReasons(a.trailers)` ("… as a gRPC
  trailer"), and the same inside `sequence` steps. The approval hash then re-asks once for existing shared grpcMocks
  with such headers.
- Optional (P): don't send `set-cookie` / `access-control-*` from a grpcMock's custom headers to gRPC-Web clients, and
  let the proxy's CORS (loopback origins only) decide.

### 3 (LOW) `constructor` in the trailer frame breaks redacted exports; control characters in trailer values

`parseGrpcWebTrailers` (`grpc-web.ts:152`):
```ts
const out: Record<string, string | string[]> = {};
…
const prev = out[k];
out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
```
- Names are lower-cased and checked against the token set, so `constructor` and `__proto__` both pass.
  - `constructor`: `prev` is the inherited `Object`, so the value becomes `[Function Object, 'boom']`. `syncGrpcWeb`'s
    spread copies it into `ex.responseTrailers`.
  - `__proto__`: the map's prototype becomes an array, and the spread drops it. This is local only; nothing global is
    polluted.
- Values are split on `\r?\n` and trimmed. A lone CR, NUL or ESC stays in the value.

Probe (server trailer frame `grpc-status: 0\r\nconstructor: boom\r\nx-ctl: a\rb\0c\x1b[2J\r\n`):
```
ex.responseTrailers = { 'grpc-status': '0', constructor: [ [Function: Object], 'boom' ], 'x-ctl': 'a\rb\x00c\x1b[2J' }
buildHar([ex], {redact: true})  → throws "text.includes is not a function"   (redact: false → ok)
redactGrpcMetadata(trailers)    → throws (get_request for this exchange fails)
customMetadata(trailers)        → {"constructor":[null,"boom"], …}  → validHeaders refuses it when the recording is loaded
```

Effects:
- One hostile response makes `get_request` fail for that call. It also makes every redacted HAR export (agents'
  `export_har`; the user's redacted export) fail until the exchange leaves the store.
- A saved recording that contains the exchange can't be loaded back. A recording saved with redaction fails while
  saving.
- No header injection: the proxy never writes recorded trailers to a socket.
  - "Mock from exchange" filters CR / LF / NUL.
  - The webview renders values as Preact text.
  - Agents get JSON-escaped strings.
  - ESC does pass into a template, and Node then refuses the resulting trailers-only header (robustness only).

**Fix (P, A):**
- Build the map with `Object.create(null)` (or a `Map`) and copy it into a plain object with `defineProperty`, as
  `customMetadata` does.
- Drop values with control characters other than tab, matching Node's `validateHeaderValue`, and note it.
- Make `redactHeaders` / `redactGrpcMetadata` / `headerList` skip non-string values instead of throwing (defence in
  depth for every header source).
- Test: the probe frame → `responseTrailers` without `constructor`'s function; `buildHar(redact)` succeeds.

### 4 (INFO) Smaller items

- **`-insecure` for `decryptHosts`.** `toGrpcurl` adds `-insecure` for any host in `flutterIntercept.grpc.decryptHosts`.
  - A host is listed there because the *app* trusts our CA (pinning to it or `onBadCertificate`). That says nothing about
    the real server's certificate, which is often publicly trusted.
  - The copied command carries the real `authorization` metadata (clipboard, unredacted), so running it on an untrusted
    network sends the token with no certificate check.
  - Suggest: plain TLS by default plus a comment "add -insecure if the server's certificate isn't publicly trusted".
    Or use `-insecure` only when the proxy actually needed `ignoreUpstreamCertErrors` for that host.
- **grpcurl size for agents.**
  - `redactedSnippet` ignores `maxBodyChars` for `grpcurl`.
  - `decodeGrpcMessages` decodes every recorded request frame (≤ 500, ≤ 8 MB) even when only the first is used.
  - A client-streaming call can return megabytes of `-d` JSON in one tool result, against `get_request`'s 20 messages /
    64 KB.
  - Decode only the frames used, and cap the snippet (truncate `-d` with a note).
- **Local preflight for a grpcMock.**
  - A preflight that asks for `x-grpc-web` is answered locally when a grpcMock matches:
    - only for loopback origins;
    - without `allow-credentials`;
    - with `allow-headers` reflected;
    - `max-age` 5 s.
  - For those 5 s the browser may send a request the grpcMock doesn't answer (not gRPC-Web content, a rule limited by
    `times` or switched off, a sequence step) straight to the real server. That server never approved it.
  - This works like the `mock` / `block` preflights (REVIEW-5 #3), and only for the developer's own loopback pages.
    Optional: `max-age: 0` for local preflights.
- **Lost frames.** Frames decoded after `grpcWebCalls.delete` never reach the exchange. The probe recorded 9 830 of
  1.68 M messages for a legitimately compressed stream, and `messagesReceived` is wrong. The fix for #1 should finish
  the decode (bounded) before forgetting the call, or note "not all messages were read".
- **Dead view.** `DetailPane` `GrpcWebBody` renders `ex.requestBody` / `responseBody`, but `emitChange` always deletes
  them for gRPC-Web, so the "HTTP body (gRPC-Web frames as sent)" section never shows. Remove it, or show it only for a
  paused request held by an HTTP breakpoint (then redact it for agents as gRPC).
- **Deferred matches.** When an earlier rule waits for the body (a GraphQL condition), `onRequest` resolves rules again
  with `matchRule(…, {count: true, body})`. That call has no `grpcWeb`, so a later grpcMock is skipped and the call
  passes through. The `mutate` → passthrough fallback isn't applied on this path either (functional). Pass `grpcWeb`
  and repeat the fallback there.

## Checked, fine

- **Raw bodies:** `watchGrpcWeb` sets `tap.req/res.skip`, and `emitChange` deletes `requestBody` / `responseBody` for
  `grpc.web`. Raw protobuf or base64 bodies never reach the store, agents, HAR or the webview. Messages appear only as
  frames, with the same schema / raw redaction as HTTP/2 gRPC (`redactJsonValue`, `redactFrameText`).
- **Frame parser bounds:**
  - Kept payload ≤ 64 KB (≤ 256 KB compressed for the §16.8 prefix); trailers ≤ 16 KB; sizes past the cap are counted,
    not buffered.
  - Unknown flags stop parsing with a note. A truncated frame is noted.
  - A declared 4 GB length allocates nothing.
- **`Base64Stream`:**
  - Whitespace stripped and invalid characters stop it.
  - `pending` ≤ 1 024 characters, and padded segments split correctly across chunks.
  - Linear: 16 MB of `AA==` groups in < 1 s.
- **Unknown `content-encoding`** (zstd, stacked) → a note, no decode. A zlib error → a note.
- **No global prototype pollution** (`__proto__` only replaces the local map's prototype). Trailer names are restricted
  to token characters, so no pseudo (`:`) names.
- **grpcMock gRPC-Web body:**
  - Trailer lines are built only from validated names and values: `grpcMockProblem` refuses CR / LF / NUL, pseudo and
    reserved names, in sequences too.
  - Messages are validated base64 under the host's caps.
  - The status message is percent-encoded.
- **CORS on local answers (grpcMock, block):**
  - `addCorsToLocalResponse` gives loopback origins only, never `*`, no `allow-credentials`, and `Vary: Origin`.
  - Exposed headers are the response's own names or `grpc-status, grpc-message, grpc-status-details-bin`.
  - The local preflight uses `allowedOrigin` (loopback only), as REVIEW-5 #3 requires.
- **grpcurl quoting:**
  - Fuzz: `shellQuote` round-trips 300 random strings in bash and zsh with 0 mismatches (quotes, `$`, backticks, `!`,
    newline / CR / ESC via `$'…'`, NUL dropped).
  - The method path must match `/pkg.Service/Method` (strict regex on the pathname, so no query).
  - Authority, header lines, `-d` JSON, `-proto` and `-import-path` are all quoted. Header names are inside the quoted
    `name: value`.
- **grpcurl paths:** `insideRel` emits only workspace-relative `.proto` paths (a path outside the workspace or on
  another drive → the reflection note). No absolute paths reach agents or the clipboard.
- **grpcurl redaction for agents:**
  - Metadata goes through `redactGrpcMetadata` (authorization, cookies, `-bin`), and `cookie` is dropped anyway.
  - `-d` only for schema-decoded, untruncated messages, through `redactJsonValue`, the same as `get_request`. Raw
    decodes never appear as `-d`.
  - The URL's query never appears.
  - `-plaintext` only for `http:`.
- **HTTP snippets** are refused for gRPC calls (they would replay base64 protobuf as a body).
- **Resend:**
  - gRPC-Web resends are refused in the panel (`GRPC_WEB_RESEND`, before any send) and for agents (`resendRefusal`,
    before the confirmation).
  - HAR adds only `grpc.web`. Headers of gRPC-Web entries use `redactGrpcMetadata`, so `set-cookie` and `cookie` are
    redacted.
- **Agents can't add headers or trailers to a grpcMock** (`add_grpc_mock` schema). `get_request` / `list_requests`
  only gain `web`.
- **Webview:**
  - No new `innerHTML` / `dangerouslySetInnerHTML` / `href` / `eval` sinks.
  - Trailers go through `HeadersTable` as Preact text. Badges and the gRPC-Web note are static strings.
  - "Copy as grpcurl" goes through the host (unredacted, the user's own clipboard, §9.3).

## Part 2 — iOS simulator trust

Independent security review of the opt-in iOS simulator CA trust and decrypt-all at 7718e7a (commits 80cce47,
4b8bb70, 189b3d5, ffdd419).

Scope:
- `packages/extension/src/iosSimTrust.ts`: `parseSimulators`, `validDataPath`, `caFingerprint`, `readTrustRow`, and
  `IosSimTrust` (`ensure`, `release`, `releaseSession`, `releaseAll`, `recover`, `tick`, records, heartbeat);
- the VS Code wiring in `extension.ts` (`simTrustOn`, `sessionDevices`, `publishSimTrust`, the Trust / Remove commands,
  session start and end, `onStop`, deactivate), `proxyHost.setSimulatorTrust`, and `get_status` for agents;
- the sidecar (`host.ts` `simTrust`, `sessionStarted` / `sessionEnded`, `applySettings`) and the IntelliJ setting's scope;
- the CLI (`--trust-simulator`, `jsonFileStore`, `recover` / `ensure` / `releaseAll` in `run.ts`);
- the proxy: `setGrpcDecryptAll`, `runSilent`, `watchDecryptHandshake`, `onTlsError` (learned pinned hosts).

Spec: CONTRACTS §19.3, §14.7 (the `AndroidGlobalProxy` precedent), §7, §16.1; docs/spikes/ios-sim-trust.md.

I read the code and ran throwaway probes in the session scratchpad, outside the repo. No simulator was touched: no
`simctl keychain` and no sqlite write against any simulator. The probes:
- esbuild bundles of `iosSimTrust.ts` driven by a fake `exec` / `fs`, with a copy of the CLI's `jsonFileStore` on real
  scratch files: planted records, a symlinked store file, and the extension's session-start ordering raced against a
  session end;
- the real `/usr/bin/sqlite3` (3.54.0) on databases planted in the scratchpad. One had a `BEFORE DELETE` trigger on
  `tsettings` that calls `writefile()`, and one had `tsettings` as a view calling `writefile()`. Each was run with the
  module's exact argument vectors (`-bail -cmd ".timeout 5000" <path> "DELETE …"` and the `-readonly` check).

Threat model as in part 1, plus: a process that can write the project's `.dart_tool`, and other Flutter Intercept
instances (windows, the sidecar, the CLI) sharing one simulator.

| # | Sev | Finding | Owner |
|---|---|---|---|
| 5 | MED | **The trust can outlive the session, and turning the setting off doesn't stop it.** (a) `onDidStartDebugSession` runs `simTrust.isSimulator()` outside the serial chain and only then queues `ensure`. A session that ends during that `simctl list` call (~0.1–0.5 s) queues `releaseSession` first, which does nothing, and then `ensure` adds the row under a holder that is already gone. **Probe:** the session ended 50 ms in, and afterwards state was `trusted`, the row was present and the record kept its heartbeat. The row stays until the proxy stops or the window closes, and it blocks other windows' `recover()`. (b) The **Trust** command calls `ensure` with holder `''`, and `releaseSession` never drops that holder. The command's own message says "until you remove it or the session ends". (c) The extension has no `onDidChangeConfiguration` handler for `grpc.trustOnSimulator` / `grpc.enabled`. Turning the setting off leaves the trust in place and leaves decrypt-all on until the next session event. The sidecar does `releaseAll` + `publishSimTrust` here. | H |
| 6 | LOW-MED | **Learned pins are too eager and too sticky.** `onTlsError` ignores `failureCause`. mockttp reports `closed` when the client **finished** the handshake and then closed without sending anything (ifTlsDropped), and `reset` when a process is killed mid-handshake. Both happen without any pinning: a channel shut down before its first call, an app stopped or restarted. A host is then passed through for the proxy's whole life, which in VS Code is the window's life, and nothing can reset it. This also covers explicit `grpcDecryptHosts` hosts while decrypt-all is off. Their `grpcMock` / `block` rules stop applying silently: the app reaches the real server, and the only sign is an exchange note. The **Remove** command deletes the row *before* `publishSimTrust` turns decrypt-all off, so tunnels opened in that gap are also learned as pinned. A local or LAN peer can only reduce decryption this way (the cap is 1000; keyed by `host:port`). | P (+ H) |
| 7 | LOW | **The CLI's record file is in the project and is trusted as is.** `jsonFileStore` writes `<project>/.dart_tool/flutter_intercept/sim-trust.json` with `writeFile` and follows symlinks. **Probe:** a symlink there made `ensure` overwrite an unrelated file in the scratchpad with the JSON records. The repo already guards this pattern in `entries.ts` and `lanPrepare.ts`. Planted records pass `isValidRecord`, because `dataPath` only has to end in `/<UDID>/data`. `recover()` then runs `DELETE … WHERE sha256 = x'<chosen>'` on whatever store is at that path. **Probe:** the DELETE went to `/Users/runner/work/repo/repo/x/<UDID>/data/…`. A record with pid 1 and a heartbeat in the future counts as live forever. The impact is bounded: the same run builds the repo, which runs its code anyway; deleting a row only removes trust; the CLI uses a new CA every run, so its sha256 can't be guessed; and the sqlite probe below showed no code execution. `flutter clean` (or a fresh clone) deletes the record, so a crashed run's row is never removed. | C |
| 8 | INFO | Smaller items: a row that a session found as `pre-existing` counts as trusted for decrypt-all even after someone removes it. The stores don't see each other (VS Code globalState, sidecar state, CLI file). The result is fail-safe (the second instance sees `pre-existing` and never deletes), but the first instance's removal can then break the other's session, whose fallback is the pins in #6. `recover()` treats a missing `dataPath` as "simulator deleted" and drops the record (an unmounted volume loses it). Problem texts embed `simctl` / `sqlite3` stderr with absolute paths: they are scrubbed for agents, but not in the panel / sidecar status. | H / C |

### 5 (MED) Trust outlives the session; setting off not honoured

- Run the `isSimulator` check inside `ensure`, which already re-checks `Booted`, and call `ensure` synchronously in
  `onDidStartDebugSession`, as the sidecar does. Alternatively, have `ensure` take a liveness callback
  (`() => sessionDevices.has(id)`) and check it again before the add.
- Make the command's trust session-scoped, or say "until you remove it or close the window". Either way, release the
  `''` holder when the last session on that simulator ends.
- Add `affectsConfiguration('flutterIntercept.grpc.trustOnSimulator') || …('grpc.enabled')` →
  `if (!simTrustOn()) await simTrust.releaseAll()`, then `publishSimTrust()`, matching `applySettings` in the sidecar.

### 6 (LOW-MED) Learned pins

- Learn only from `reset`, `cert-rejected` and `no-shared-cipher` during the handshake, never from `closed`. Better:
  require two failures within a minute.
- Learn only while decrypt-all decided the decryption, not for explicit `grpcDecryptHosts`. Clear `pinnedHosts` when
  decrypt-all switches off and when the last session ends.
- Show the learned hosts in `Status.grpc` and give a way to forget them.
- In `removeSimulatorCa`, call `setGrpcDecryptAll(false)` before `release`.

### 7 (LOW) CLI record file

- `lstat` and refuse a symlink (or open with `O_NOFOLLOW`), and write via a temp file + rename in a plain directory.
- Better: keep the CLI records outside the project (for example `~/Library/Caches/flutter-intercept/sim-trust.json`,
  0600), so `flutter clean` can't lose them and a repo can't plant them.
- In `recover()` and `drop`, delete only when `dataPath` equals the `dataPath` that `simctl list devices -j` reports
  for that udid, or the record is under `~/Library/Developer/{CoreSimulator,XCTestDevices}`. Reject heartbeats more
  than a minute in the future.

## Checked, fine (part 2)

- **Consent:**
  - VS Code reads `userSetting('grpc.trustOnSimulator')`, which is `inspect().globalValue`, and the setting is
    `scope: application`. Workspace, folder and launch.json values are ignored.
  - In IntelliJ, the setting lives in the `Service.Level.APP` settings (`flutter-intercept.xml`).
  - The CLI enables it only with the `--trust-simulator` flag (no config file or env), and refuses it together with
    `--no-grpc`.
  - Agents only read `simulatorTrust` through `get_status`. No agent tool, LM tool or webview message runs the
    commands or changes the setting.
  - A cloned repo can still reach the commands through `${command:…}` in a trusted workspace's launch.json. The command
    needs an intercepted session on a booted simulator, and it doesn't turn decrypt-all on while the setting is off.
- **Simulators only:**
  - `SIM_UDID` is strict (8-4-4-4-12 upper hex), so physical ids (`00008110-…`, 40 hex) fail it.
  - The udid must also be listed `Booted` under an `SimRuntime.iOS-*` runtime in `simctl list devices -j`. Android,
    macOS and web are never touched.
  - `dataPath` for an add comes from `simctl` and must be absolute, normalized, free of `..` and end in `/<UDID>/data`.
- **Commands and SQL:**
  - `execFile` with argument arrays and absolute `/usr/bin/xcrun` / `/usr/bin/sqlite3`; no shell.
  - The sha256 is checked against `^[0-9A-F]{64}$` before each SQL statement it goes into.
  - The read is `-readonly`, and never runs on a missing path (sqlite3 would create one).
  - **Probe:** planted triggers and views calling `writefile()` fail with "unsafe use of writefile()"
    (`trusted_schema` = 0), and `-bail` stops before the DELETE.
- **Only our row:**
  - The key is the sha256 of our CA's DER, and a row present before us with no record is `pre-existing` and never
    removed.
  - The record is written before the add, so a crash is repaired by `recover()`. A failed add drops it.
  - Two windows sharing a simulator get a reference count plus owner, pid and heartbeat, as `AndroidGlobalProxy` does;
    the last live owner deletes the row. A crashed owner's row is removed by another window's `drop` / `recover`.
  - A regenerated CA: the old hold is dropped (its row deleted) before the new add, and records keep the old sha256.
  - `simctl keychain reset` / `erase` appear nowhere.
- **Temp certificate:**
  - `X509Certificate#toString()` gives the certificate only, never the key, and `x.ca` is required.
  - The file goes in an `mkdtemp` directory (0700) with `wx` and mode 0600, and is removed in `finally`.
- **Decrypt-all gating:**
  - On only when every entry in `sessionDevices` is a trusted / pre-existing simulator. It goes off synchronously when
    a non-simulator session starts, and before release when a session ends.
  - LAN iPhone sessions are in `sessionDevices`, so it turns off.
  - Plain Dart sessions have no gRPC hook (no proxy define, §16.1), so leaving them out is harmless.
  - The sidecar counts every non-web session, and the CLI has one device.
  - Learned pins and decrypt-all apply only to silent tunnels from the entry's gRPC hook. Ordinary HTTPS interception
    is unchanged.
- **No paths to agents:** `get_status` problems go through `scrub` (project and home paths), `setSimulatorTrust` strips
  control characters and caps lengths, and the status shows udid, name and state only.
