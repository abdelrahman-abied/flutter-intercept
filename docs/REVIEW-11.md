# Review 11: v0.11.0 security (independent, `feature/0.11.0` at f6e4525) — findings and fix plan

Scope: gRPC parity (`git diff main..HEAD`, main = 0.10.0 + a test fix). That covers:
- the proxy: the message transform (`grpc.ts` `GrpcMessageTransform`, `GrpcFrameRecorder` flags), breakpoints / holds /
  edits / abort (`intercept-proxy.ts` `grpcHook`, `grpcPauseMessage`, `grpcStatusBreakpoint`, `grpcAbort`, `resume`),
  mutate through the injected codec (`grpcMutate`, `setGrpcCodec`), gRPC replay (`grpcReplay`, `grpcAnswer`,
  `replay.ts` `lookupGrpc` / `validGrpcEntry`), `rules.ts` `grpcEditProblem`;
- the host codec (`extension/src/grpc/service.ts` `grpcProxyCodec`) and its wiring (`proxyHost.ts`, `extension.ts`,
  sidecar `host.ts`);
- the `.proto` source (`grpc/proto.ts`, `schema.ts` linking, `discovery.ts`);
- recordings v3 (`recordings/grpc.ts`, `validate.ts`, `frames.ts`, `store.ts`, `replay.ts`, `diff.ts`, CLI use);
- agents (`api.ts` `grpcPauseView` / `decodeHeld` / `restoreRedactedGrpc` / `resume`, `schema.ts`, `lmTools.ts`);
- the controller (`validateGrpcEdit`, `resolveGrpcEdit`, `pausedView`) and the webview pause editor (`GrpcViews.tsx`).

Spec: CONTRACTS §17 (esp. §17.7), §16 incl. §16.8, §7, §8; docs/spikes/grpc.md "As built — proxy (0.11.0)";
guarantees from REVIEW-10.

I read the code and ran throwaway probes in the session scratchpad (outside the repo, Node 26, esbuild bundles of the
real sources):
- `parseProtoFile` / `loadGrpcSchema` on crafted `.proto` files (timing, hangs);
- `grpcProxyCodec` (real codec + a schema from a `.proto`) on 4 MB worst-case messages;
- the real `InterceptProxy` with the repo's test helpers (`startProxy`, `h2cSession`, `grpcCall`) against a small
  `node:http2` server: stale pauses, memory held by hooked streams, cross-origin replay;
- `recordGrpc` + `toFileEntry` with `redact: true` (request hash).

I did not run the unit, integration, device or CLI suites, start an IDE or touch devices.

Threat model as in REVIEW-1 to REVIEW-10: a malicious cloned repo (trusted workspace); a malicious or prompt-injected
agent that only has our tools; a malicious app under debug; hostile servers and web pages; other local users. New in
0.11.0: `.proto` files are parsed from the workspace, the proxy buffers and rewrites whole gRPC messages, recordings
hold gRPC messages and are replayed.

| # | Sev | Finding | Owner |
|---|---|---|---|
| 1 | LOW-MED | **A one-line `.proto` hangs the extension host forever; duplicate names make it quadratic.** `assignDartNames` loops forever on a message or enum named only with underscores (`message _ {}`), and probes collision suffixes linearly. Both run after the parser, outside the 200 ms budget. **Probe:** a 46-byte file never returns; 32 000 `message X{}` (384 KB) → 35 s. | S |
| 2 | LOW-MED | **Redacted recordings keep the sha256 of the unredacted first request message (`requestHash`).** Low-entropy secrets in that message (PIN, OTP, short password) can be brute-forced offline from a file that is meant to be shared and may be committed. **Probe:** the 4-digit PIN of a redacted `Login` call is recovered in < 10 000 hashes. | R |
| 3 | LOW | **`.proto` linking is O(fields × scope-name length), outside the budget.** `resolveProto` builds a candidate string for each enclosing scope for every field. **Probe:** a 2 MB file with a 64 KB message name and ~200 000 fields → 12.8 s; with a 1 MB name > 30 s (stopped). Problem texts repeat the whole name. | S |
| 4 | LOW | **Hooked streams buffer outside the 64 MB cap.** With a breakpoint or mutate rule, each direction assembles a whole message (≤ 4 MB) before anything is counted. Messages queued behind another pause aren't counted either. The number of streams has no limit. **Probe:** 32 streams, each sending 4 MB − 1 byte → ~150–186 MB retained, `grpcHeld` = 0. | P |
| 5 | LOW | **Pauses outlive their call.** (a) When the server resets or ends while a message is held, the exchange finishes but the pause stays registered (with `grpcPause` and its held bytes) until `breakpointTimeoutMs` (5 min). (b) A held trailers-only status ignores the app's cancel and later records `completed`. **Probe:** both reproduced. | P |
| 6 | LOW | **Codec work on 4 MB messages blocks the event loop for up to ~0.75 s each.** Mutate decodes every response message (≤ 4 MB) synchronously. A held message is decoded again for every `list_paused` / `get_request` and webview `decodeGrpc`. **Probe:** unknown nested fields ≈ 230 ms/MB; a 4 MB message that finally fails the budget costs 754 ms. | P + A + C |
| 7 | LOW | **gRPC replay answers across origins, and answers LAN clients before the LAN deny rule.** `lookupGrpc` uses entries from any origin when the request's origin has none. HTTP replay keys include the origin. **Probe:** an entry recorded for `https://api.a.example/t.S/Login` answers a call to `http://127.0.0.1:<port>/t.S/Login`. | P |
| 8 | INFO | Smaller items: recorded status 17–999 is accepted by the file validator but silently not replayed (the call then follows `fallback`); the status pause editor always sends `status`, so trailer-only edits fail when the server's code is > 16; redacted recordings re-encode unknown (`#n`) fields, which are redacted by value only; `.proto` problem texts have no length cap; `.proto` files share the 5000-file cap with generated Dart. | various |

## Details

### 1 (LOW-MED) A one-line `.proto` hangs the extension host forever; duplicate names make it quadratic

`proto.ts:715–726`, `assignDartNames`, which runs after the parser in `parseProtoFile`, outside the deadline:

```ts
let base = parent ? `${parent}_${name}` : name;
while (base.startsWith('_')) base = `${base.slice(1)}_`;     // '_' → '' + '_' = '_' … forever
...
for (let i = 0; used.has(chosen); i++) chosen = `${base}_${i}`; // k-th duplicate probes k names
```

- A top-level `message _ {}` or `enum __ { A = 0; }` keeps `base` all underscores, so the loop never ends. A name
  like `_A` ends (`A_`). Nested names are fine (`Parent__`).
- Duplicate names: the k-th duplicate of a base name probes `X_0 … X_k`, so n duplicates cost O(n²) set lookups.
  Nothing rejects a duplicate fully-qualified name.

Probe (`parseProtoFile`; `loadGrpcSchema` gives the same results):

| Input | Bytes | Time |
|---|---|---|
| `syntax = "proto3"; message _ { int32 a = 1; }` | 46 | never returns (killed after 5 s) |
| 2 000 × `message X{}` | 24 KB | 111 ms |
| 8 000 × `message X{}` | 96 KB | 1.9 s |
| 32 000 × `message X{}` | 384 KB | 35.8 s |

- The tokenizer and the parser stay within 200 ms in every case. The time is spent in `assignDartNames`.
- The extension activates on `workspaceContains:pubspec.yaml`, and `grpc.ready()` loads the schema on the
  extension-host thread. The watcher now also reloads on every `*.proto` change.
- So a cloned repo with one tiny `.proto` anywhere in the workspace (outside the skipped directories) hangs the
  extension host, and every extension in it, each time it is opened. The sidecar (IntelliJ) runs the same code.
- Denial of service only, and it needs a trusted workspace (as REVIEW-10 #2). I rate it higher than that finding
  because the trigger is one line and the hang never ends.

**Fix (S):**
- Strip leading underscores once: `const lead = /^_+/.exec(base)?.[0] ?? ''; base = base.slice(lead.length) + lead;`.
  A name that is only underscores becomes a problem ("unsupported name"), or `x_`.
- Collisions: keep a per-base counter (`Map<string, number>`) instead of probing from 0. Report duplicate
  fully-qualified names as a problem and skip them.
- Run `assignDartNames` under the same deadline: check `Date.now()` every 1024 names → "too complex to read".
- Tests: the 46-byte file loads with a problem in < 10 ms; 170 000 duplicates (2 MB) in < 300 ms.

### 2 (LOW-MED) Redacted recordings keep the sha256 of the unredacted first request message

`recordings/grpc.ts:127`, `:142` (`recordGrpc`):

```ts
const hash = e.grpcRequestHash ?? firstRequestHash(e.frames);   // over the ORIGINAL frame bytes
...
if (hash) out.grpcRequestHash = hash;                            // kept whatever `redact` says
```

- Saving with `redact: true` (the agent default) or exporting redacted keeps this hash. Exporting redacted from an
  unredacted recording keeps the stored `grpcRequestHash` too.
- The frames themselves are redacted. With a schema they are re-encoded with `"[redacted]"`, so the rest of the message
  (user name, structure) stays readable. Without a schema they become zero bytes of the same length.
- An unsalted sha256 over a known structure turns any low-entropy secret in the first request message into an offline
  guess. This message is typically `Login {user, password}`, `VerifyOtp {code}` or `SetPin {pin}`.
- Redacted recordings are the ones the store lets you write inside a git-tracked folder, so they are meant to be
  committed or shared. The CLI writes them too (`outputs.ts`).
- HTTP doesn't have this problem: `requestBodyHash` is computed from the (redacted) body at replay time.
- §17.7: "recordings never write unredacted messages when `redact` is set". A hash of the message is derived from it.

Probe (`recordGrpc(e, e, true)` then `toFileEntry`, no schema, request `{user: "alice", pin: "4821"}`):
```
redacted frame AAAAAAAAAAAAAAAAAA==  requestHash 1428d400…c0f7
PIN recovered from the redacted file: 4821      (≤ 10 000 sha256 calls)
```

**Fix (R):**
- When redacting, drop `requestHash`. Replay then matches by order for that path (the documented fallback).
- Or keep it only when redaction left the first request message unchanged: with a schema, if
  `redactJsonValue(json)` deep-equals `json`. That condition also holds when nothing in the message is secret-named,
  so value-only secrets would still leak through the hash. Dropping it is safer.
- Apply the same in `export(…, {redact: true})` (`recordedExchange(e, true)` on a stored entry).
- Test: a redacted save / export of a call whose first message has a secret-named field has no `requestHash`.

### 3 (LOW) `.proto` linking is O(fields × scope-name length), outside the budget

`schema.ts:454–480` (`resolveProto`) runs for every field, map value and rpc type. For an unqualified name it builds
`${scope}.${name}` for each enclosing scope, then hashes it in `kindOf`. Unresolved names report a problem once per key,
but resolution itself still runs for every field. Identifiers have no length limit in the tokenizer.

Probe (one message with a long name, filled to 2 MB with fields `Y a=N;`, `Y` unresolved):

| Name length | Fields | `parseProtoFile` | `loadGrpcSchema` |
|---|---|---|---|
| 64 KB | ~200 000 | 74 ms | 12.8 s |
| 1 MB | ~100 000 | 51 ms | > 30 s (killed) |

- Nesting (up to 64 levels) multiplies the number of candidates.
- The problem text ("… uses Y, which isn't among the loaded files") embeds the message name. The 64 KB name went
  through unchanged to the schema problems that `get_status` / `get_grpc_schema` return.
- Same trigger and impact as #1 (cloned repo, activation and reload), without the infinite loop.

**Fix (S):**
- Cap identifier length in the tokenizer (e.g. 512 characters → problem, file skipped).
- Memoize `resolveProto` per `(scope, name)`.
- Count linking work against the per-file / per-load budget.
- Cap each problem text (e.g. 300 characters).
- Test: the 64 KB-name file loads in < 300 ms.

### 4 (LOW) Hooked streams buffer outside the 64 MB cap

`grpc.ts:537` (`GrpcMessageTransform.work`): with a hook, a message ≤ 4 MB is collected in `parts` until it is
complete. `_transform` calls back after each chunk, so the sender is never held back while a message is being
collected. `grpcHeld` (`intercept-proxy.ts:3862`) counts a message only once its pause starts.

- **Assembly:** each hooked direction of each stream can hold up to 4 MB. In 0.10 the observer kept at most 64 KB per
  message.
- **Queued:** with `phase: both`, a message of the other direction that arrives while a pause is open waits in
  `pauseChain` with its `plain` copy (≤ 4 MB) and, if compressed, its wire payload (≤ 4 MB). Neither is counted.
- **Pause copies:** `grpcPause.base64` (≈ 5.3 MB) is an extra copy, and it is posted to the webview with every
  `emitChange`.
- The number of streams is not limited: Node's default `maxConcurrentStreams` is 2³² − 1, and several connections
  can be opened.

Probe (breakpoint `phase: request` on `/t.S/Sink`; each stream sends a header announcing 4 MB − 64 and then one byte
less, so no message completes and nothing pauses):
```
client still buffering 0.0 MB   streams 32   held (counted) 0   paused 0   heap+external growth ≈ 150–186 MB
```

- Who can do it: a malicious app (or a LAN client with the token, or another local user on loopback) while a
  breakpoint or mutate rule matches. With a mutate rule, a hostile server can do the same on every response stream the
  app opens.
- Scaled up, this exhausts the extension host's memory. Mockttp's HTTP body buffering already gives local clients
  similar reach, so I rate it LOW.

**Fix (P):**
- Reserve bytes in one global budget when a message header is read. Release them when the message is forwarded,
  replaced, dropped or the stream dies. Count assembly, queued and held messages in it, e.g. 64 MB in total.
- When a message doesn't fit the budget, handle it like an oversized one: stream it through unchanged, record it with
  the 0.10 parser, and add a note ("not paused / not mutated: too much gRPC data held").
- Optionally limit the hooked streams per session (e.g. 32 at once; the others take the observer path).
- Test: 64 streams of 4 MB − 1 byte with a breakpoint keep the retained bytes ≤ the budget.

### 5 (LOW) Pauses outlive their call

(a) The server ends or resets while a message is held:
- `onGrpcUpstreamClosed` → `grpcStatusOnly` / `grpcReset` + `fail`, or a normal end → `sendGrpcTrailers` → `finish`.
- `onGrpcClosed` then returns early on `call.localReset` (`intercept-proxy.ts:3494`), and `finish()` doesn't touch
  `this.paused`.
- So the pause stays registered until its timer fires: its `settle`, `grpcPause` with the full base64 on a finished
  exchange, and its bytes in `grpcHeld`.

(b) A trailers-only answer held as status:
- The relay sets `call.localReset = true` before `grpcStatusBreakpoint` (`:4095`).
- So the app's RST_STREAM CANCEL is ignored (same early return). The exchange stays `paused-response` until
  `breakpointTimeoutMs`. Then `respond` throws (caught) and the call is recorded as `completed`, not `aborted`.

Probe output (breakpoint `both`, `breakpointTimeoutMs` 60 s):
```
A request held, server resets: app got 14 …
  after: {"paused":1,"held":1048576,"ex":[{"state":"error","grpcPause":"message", …}]}
B (trailers-only status held), app cancels:
  after: {"paused":1,"ex":[{"state":"paused-response","grpcPause":"status"}]}
```

Effects:
- Stale held bytes stay counted for 5 minutes by default. 16 calls whose server resets after the request headers
  (4 MB each) fill the 64 MB cap, and every gRPC breakpoint is then skipped for 5 minutes.
- The panel and agents see a pause on a finished exchange, or a call reported as paused after the app gave up.
- The final state is wrong in (b).
- No unbounded leak: the timer is the bound.

**Fix (P):**
- In `finish()` (or a gRPC wrapper around it), settle `this.paused.get(ex.id)` with `{kind: 'gone'}` and delete
  `ex.grpcPause` before emitting.
- In the trailers-only path, set `localReset` only after the status pause resolves, or make `onGrpcClosed` settle a
  pause before its `localReset` check.
- Tests: (a) and (b) above leave `paused` empty and `grpcHeld` at 0 within one tick; (b) ends `aborted`.

### 6 (LOW) Codec work on 4 MB messages blocks the event loop for up to ~0.75 s each

- `grpcMutate` calls `codec.decode` synchronously on every response message of a mutated call. A message can now be
  4 MB, against 64 KB frames in 0.10.
- The codec's bounds (`MAX_FIELDS` 100 000, depth 32, `WORK_LIMIT` 4 M) cap the work per call, but at a level tuned for
  64 KB inputs.

Probe (`grpcProxyCodec`, real codec, schema from a `.proto`):

| Input (response message) | Bytes | decode | Result |
|---|---|---|---|
| one 4 MB `string` | 4.0 MB | 1.4 ms | decoded |
| one 4 MB `bytes` | 4.0 MB | 74 ms (+ 24 ms encode) | decoded |
| 100 k small sub-messages | 4.0 MB | 32 ms | stops at the field cap |
| unknown field 15 × ~4 000 nested 1 KB blobs | 0.26 / 1 / 2 MB | 60 / 266 / 486 ms | decoded |
| same, 4 MB | 4.0 MB | 754 ms | fails (budget), forwarded |

- Unknown fields are decoded with the `decode_raw` guesser, which tries a nested message for every length-delimited
  value.
- A hostile server (or the app, for request messages) that sends such messages to a call with a mutate rule costs
  about 0.25–0.75 s of extension-host time per message. Every other extension stalls with it.
- Breakpoints add repeated cost. `decodeHeld` (agents: each `list_paused` / `get_request` on every paused call) and
  `pausedView` (each webview `decodeGrpc`) decode the full held message again. With 16 held 4 MB messages, one
  `list_paused` can block for ~12 s.

**Fix (P + A + C):**
- Give the proxy codec a smaller budget than the panel decoder: e.g. a work limit proportional to 64 KB of guessing,
  and decode unknown fields as opaque bytes (base64) for mutate. Unknown fields only need to survive the round trip,
  not be shown.
- Cache the decoded held message per pause (`grpcPauseKey`) in the host, so agents and the webview don't decode again.
- Test: a 4 MB adversarial message costs < 50 ms in `codec.decode`; repeated `list_paused` reuses the decode.

### 7 (LOW) gRPC replay answers across origins, and answers LAN clients before the LAN deny rule

`replay.ts:171`:

```ts
const same = all.filter((e) => normalizeUrl(e.url)?.origin === u.origin);
const group = same.length ? same : all;   // any origin with the same path
```

Probe: `setReplay([{kind: 'grpc', url: 'https://api.a.example/t.S/Login', frames: [receive "tokA!"], grpc: {code: 0}}],
{fallback: 'passthrough'})`, then a call to `http://127.0.0.1:<port>/t.S/Login` → `0 ['tokA!']`.

- HTTP replay keys (exact and template) include the origin. gRPC paths often repeat across origins: the same service
  on several tenants, `grpc.health.v1.Health/Check`, a white-label app.
- A credential recorded from origin A can be served to the app's call to origin B. The app then sends it to the real
  B on the next unmatched call (`passthrough`).
- The gRPC route sits before the LAN deny rule (it answers refusals in gRPC terms). So a LAN client's call to a local
  target (`127.0.0.1`, a LAN address) gets the replayed (or mocked) answer instead of the HTTP behaviour (403).
  Nothing is contacted, so this isn't SSRF, but it differs from §7 for HTTP. The client needs the LAN token.

**Fix (P):**
- Match the origin like HTTP: same scheme + host + port. Possibly treat `localhost` / `127.0.0.1` / `10.0.2.2` as
  one, since emulator aliases rewrite the host.
- Without an entry for the origin, return `undefined`, so `fallback` applies.
- Optionally run `lanTargetDenial` for LAN gates in `decideGrpc` before mocks and replay, so gRPC and HTTP agree.
- Test: the probe above falls back (passthrough or `14`) instead of answering.

### 8 (INFO) Smaller items

- **Status range mismatch in recordings.** `validate.ts` accepts `grpc.code` 0–999 (`MAX_RECORDED_GRPC_CODE`), but
  the proxy's `validGrpcEntry` refuses codes above 16. Such entries are silently skipped, and those calls follow
  `fallback`: with `passthrough` they reach the real server during what the user thinks is a replay. Either let the
  proxy replay any integer code, or count them as not replayable with a reason in `RecordingSummary`.
- **Status pause editor (webview):** `edit()` always sends `status`. If the server sent a code above 16, a trailers-only
  change is refused ("code must be … 0–16"). Send `status` only when it changed.
- **Unknown fields in redacted recordings.** With a schema, a message is decoded, redacted and re-encoded. Unknown
  fields (`"#n"`, e.g. a field newer than the app's generated code) are redacted by value only and re-encoded. A short
  token or a token stored as bytes survives "redaction". It is the same as what agents see, but the file is meant to
  be shared. Consider dropping unknown fields when redacting, and say so in `save_recording`.
- **Problem texts unbounded:** `.proto` problems echo identifiers and `json_name` values in full (see #3). Cap each one.
- **Shared cap:** `.proto` files count toward the same 5000-file / 50 MB caps as generated Dart. A vendored
  `third_party/googleapis` can push the app's `*.pb.dart` out ("the rest were skipped"). Count them separately, or
  read Dart first.

## Checked, fine

- **Fast path (§17.1):**
  - Without a breakpoint or mutate rule for a direction, the 0.10 `Observer` + `GrpcMessageParser` link is used, with no
    per-message copies.
  - Trailers-only and `sendGrpcTrailers` stay synchronous when no status pause applies: the async wrapper has no
    `await` on that path.
  - `grpcTransformStats.created` covers it in tests.
- **Holding and backpressure:**
  - A held message is the one `_transform` call whose callback isn't run. `req.pipe` / `up.pipe` then stop reading,
    and HTTP/2 flow control pushes back on the sender.
  - The other direction has its own transform and keeps flowing unless it is also waiting on `pauseChain`
    (documented).
  - Oversized messages (> 4 MB on the wire) stream through and are recorded by the 0.10 parser, with a note. A bad
    flag byte switches to raw passthrough.
- **Compressed messages:**
  - Pauses decompress with `decompressPrefix` (async zlib, output capped at 4 MB). Anything incomplete is forwarded
    unchanged with a note.
  - An unedited resume forwards the original wire bytes. Edits and mutations are sent uncompressed (flag 0).
- **Edit validation, host and proxy:**
  - Host `validateGrpcEdit`:
    - exactly one of `message`, `messageJson` or `drop`;
    - base64 checked by regex, ≤ 4 MB; `messageJson` a JSON value ≤ 4 MB as text;
    - `status.code` an integer 0–16, `message` ≤ 4 KB;
    - trailers via `checkHeaders`: token names, no CR / LF / NUL, ≤ 100, no pseudo, `content-type`, `grpc-*` status
      names or connection headers.
  - Proxy: `grpcEditProblem` (the same rules, shared with the host), the exact decoded 4 MB check, and trailers through
    `grpcMockProblem`. `grpc-message` is percent-encoded.
  - The pause kind is checked again in the proxy, so a message edit can't land on a status pause or the other way
    round.
- **Abort / cancel / stop:**
  - `grpcAbort` resets both ways (RST_STREAM CANCEL), and queued pauses then resolve as `drop` / `undefined`.
  - `onGrpcClosed` settles a message pause as `gone`, and `stop()` settles every pause.
  - Pause timers are cleared on settle (see #5 for the two paths that wait for the timer).
- **Mutate:**
  - Codec errors and an unknown method forward the original with a note.
  - `applyOps` uses `MUTATE_MAX_TARGETS`, and `encode` refuses more than 4 MB.
  - `decode` never throws (wrapped). The codec looks up the current schema per call and honours `grpc.enabled`.
- **Relay hardening:** `decideGrpc` now also applies the REVIEW-8 client-certificate refusal to breakpoint and mutate
  flows (they reach the network). Replay flows skip it (no connection).
- **Replay entries:**
  - The proxy's `validGrpcEntry` refuses `incomplete` entries, truncated or `sizeUnknown` response frames, and codes
    outside 0–16.
  - Headers and trailers are cleaned: lower-case token names only, no pseudo headers, no CR / LF / NUL, and protocol,
    hop-by-hop, `grpc-encoding`, `te` and `proxy-authorization` dropped.
  - Gaps are capped at 5 s, and entries never serve HTTP lookups.
  - Hash matching waits for the first request message only when it can decide something.
- **Recording files (v3):**
  - `validEntry` checks gRPC entries strictly:
    - POST, no bodies, `grpc` keys whitelisted (so a JSON `__proto__` own key is refused as an unknown field);
    - `requestHash` 64 hex characters; status message ≤ 4 KB;
    - frames of kind `message` only, base64 valid and ≤ 64 KB, counts derived, never trusted;
    - `compressed` / `sizeUnknown` / `edited` must be `true` on message frames.
  - `customMetadata` and `grpcReplayEntry` build objects with `defineProperty`.
  - Old extensions refuse version 3 by number.
- **Redacted recordings (apart from #2):**
  - Messages are never written as captured: either decoded, redacted and re-encoded with the schema, or zero bytes of
    the recorded length. Truncated or `sizeUnknown` frames and anything that doesn't decode go to zero bytes.
  - Metadata goes through `redactGrpcMetadata`, the status message through `redactText`, the URL through `redactUrl`.
  - Dropped messages are left out. The CLI (no schema) uses the zero-bytes path.
- **Diff:**
  - Values are never shown: gRPC routes report status, counts, timing and the redacted JSON shape of the first
    response.
  - `diffText` (user only, not agents) summarises message frames as size + a 48-bit hash.
- **Agents:**
  - `resume_request` is a write tool: refused under `readOnly`, confirmed in VS Code. The confirmation shows only
    validated values through `code()`.
  - `grpcPause` for agents never contains bytes. A held message is shown decoded and redacted (raw decodes by value).
    JSON over 64 KB is omitted, and errors are scrubbed. A status pause shows redacted trailers and message.
  - `restoreRedactedGrpc`:
    - puts originals back only at the same key path of the same held message (own properties only, depth ≤ 64);
    - the result only goes where the held message was going;
    - edited frames are shown redacted afterwards.
    - I found no way to move a secret into a field the agent can read, or to another destination.
  - Validation and `resume` run synchronously in-process, and the proxy re-checks the pause kind (no TOCTOU).
- **Webview:**
  - No new `innerHTML` / `dangerouslySetInnerHTML` / `href` sinks. Decoded JSON, raw fields, trailers and status
    texts are Preact text and textarea values.
  - Edits go through the host's validation like agent edits.
- **`.proto` tokenizer / parser (apart from #1, #3):**
  - The 200 ms / 2 M-token budget is checked in every parser loop, and nesting is capped at 64.
  - `Map` / `Set` only, so no prototype pollution.
  - Problems use the display label, never an absolute path.
  - Nothing is evaluated.
  - Imports resolve among loaded files only, and `google/protobuf/*` uses the built-in types.
  - Generated Dart wins over a `.proto` for the same name or method.
- **Discovery:**
  - `.proto` files come only from the workspace folders, through the same walk: no symlinks, real paths inside the
    root, `SKIP_DIRS` incl. `node_modules`, `build`, `.dart_tool`, `Pods`, `.git`, and shared caps.
  - Labels are root-relative.
