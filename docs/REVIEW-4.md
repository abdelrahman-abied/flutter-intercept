# Review 4: v0.4.0 security (independent, `feature/0.4.0` working tree on fdfd939) — findings and fix plan

Scope: the `mutate` rule action (`mutate.ts`, `jsonpath.ts`, `json-text.ts`, the h2 hook), the contract service
(`src/contract/**`), the new agent tools / MCP resources / prompts, codegen (`src/codegen/**`), and the new
controller messages. I read the code and ran throwaway probes (esbuild bundles of the real modules in the session
scratchpad, outside the repo, deleted). `proxy/test/{mutate,jsonpath}.test.ts` pass (55). I did not run the
integration or device suites.

Threat model as in REVIEW-1/2/3. The extension declares no `untrustedWorkspaces` capability, so it is disabled
in Restricted Mode: the hostile-repo findings (#3, #5) need a workspace the user trusted. "Agent" means a
possibly prompt-injected agent that has only our tools. READ tools need no confirmation.

| # | Sev | Finding | Owner |
|---|---|---|---|
| 1 | MED | Agent URL filters (`list_requests`, `wait_for_request`, `export_har`, and new in 0.4.0 `assert_traffic` url + `order`, `check_contract`, `generate_model`, `generate_fixture_test`) match the **unredacted** URL. A `/regex/` (or glob) used as an oracle recovers redacted query secrets one character at a time, using read tools only. | H |
| 2 | LOW-MED | URL patterns compile to backtracking RegExps that run on the extension host. A `/regex/` is exponential and a plain glob is polynomial: one READ call can freeze VS Code. The same matcher runs on every proxied request for rules. | P (rules.ts) + H |
| 3 | LOW-MED | `part of '<anything>'` in a `*.g.dart` is followed anywhere: absolute paths, `..`, `/dev/zero` (extension host OOM-killed), FIFOs (hang), and on Windows UNC (SMB at index time, no click). Files outside the workspace are read, given diagnostics, and opened by `openViolation`, which skips the REVIEW-3 #3 guard. `*.g.dart` symlinks have the same problem. | C + lead |
| 4 | LOW-MED | `mutate` bounds the input (32 MB) but not the work or the output. `[*]` fan-out × value size crashes the extension host (OOM). 32 MB of small objects blocks the loop for 1.9 s and uses +3.1 GB. Synchronous brotli re-encoding at quality 11 takes 17 s for 18 MB. | P |
| 5 | LOW | Contract index: owner linking is quadratic (a 200 KB owner takes 3.8 s and scales n²; a realistic 2000-model file takes 0.76 s). The index build is synchronous and unbounded in total bytes. A recheck of every exchange runs as one microtask chain that never yields to the event loop. | C + H |
| 6 | LOW | Redaction gaps in contract output. `violationForAgent` blanks only double-quoted text, so numbers, bools and the enum error's backtick-quoted **full** raw value pass through. Diagnostics are never redacted, and agents can read them through the IDE (Claude Code `getDiagnostics`, Copilot `#problems`). | H + C |
| 7 | LOW | `assert_traffic` evaluates `exists` / `type` on the **real** body. Failure texts then list concrete keys, counts and types under redacted fields. `equals` on a path inside a redacted field silently passes. | H |
| 8 | LOW | `selectPath` copies the concrete path for every node (O(nodes × depth)), and `jsonFailures` has no per-exchange cap. A 0.4 MB nested body plus a 300-segment `[*]` path takes 4.3 s and 4.3 GB. | P + H |
| 9 | INFO | Fixtures are meant to be committed, but redaction is by key name only. JWTs and tokens under non-matching keys (`access`, `jwt`, `id_jwt`, …), and text or multipart bodies, land in `test/fixtures/`. | H + G |
| 10 | INFO | `dartString` leaves bidi and invisible format characters in generated literals unescaped (Trojan-source style keys from a hostile response). | lead (snippets.ts) |
| 11 | INFO | `matches()` recompiles the pattern for every exchange on every call. `assert_traffic`'s `ready()` does N × (1 + order) compiles on every exchange event. | H |

## Details

### 1 (MED) URL filters are an oracle for redacted query secrets
`packages/extension/src/agent/api.ts:104-106` (`exchangeMatches` → `matches({url}, e.method, e.url)` on the raw
URL). It is used by `listRequests` (:319), `waitForRequest` (:370), `exportHar`, `checkContract` (:755),
`generateModel` (:794), `generateFixtureTest` (:827), `assertTraffic` / `evaluateAssert` (:871), and
`orderFailure` (:929, `matches({url: glob}, …, e.url)`).

The agent sees `?access_token=[redacted]`, but it can ask "does any URL match `/[?&]access_token=a/`?" and get
the answer from `total`, `items.length`, `matched`, a timeout, or a pass/fail. Probe with the proxy's
`matches()` on `https://api.example.com/me?access_token=s3cr3tTOKEN&x=1`: a per-character loop recovered
`s3cr3tTOKEN` exactly. With character-class bisection (`=[a-m]`) a 40-character token takes about 240
`list_requests` calls. None of them needs confirmation, and each is one line in the agent log. This affects
query secrets (`api_key`, `access_token`, `session`, …) and also anything else the redactor hides in the URL.
It predates 0.4.0 (`list_requests` since 0.2.0), but 0.4.0 adds five more entry points, and `order` lets one
call test 20 patterns.

The rule-creating tools (`add_mock` / `add_block` / `add_breakpoint` / `add_mutation` / `simulate_network`)
have the same side channel through `matchedRuleId`. Each probe is a confirmed write that shows the pattern, so
that channel is loud.

**Fix:**
- For agent READ filters, match the pattern against `this.url(e.url)`, which is `redactUrl` when redaction is
  on. Agents only ever see redacted URLs, so the globs they build from results keep working. Apply the same to
  `order` and to the `generate_*` / `check_contract` URL filters.
- For agent-written rules, refuse a pattern (glob or regex) that names a sensitive query parameter and follows
  it with anything other than `*` or `[redacted]`. Or at least show that part of the pattern in the
  confirmation.
- Add a test: with redaction on, `list_requests({url: '/access_token=s/'})` matches nothing.

### 2 (LOW-MED) Backtracking URL patterns freeze the extension host
`packages/proxy/src/rules.ts:26-46` (`compileUrl`): `/re/flags` → `new RegExp(re)`; a glob → `^a[\s\S]*b[\s\S]*…$`.

| Pattern on a URL of n chars (no match) | Time |
|---|---|
| `/(.+)+Z/`, n = 20 / 22 / 24 | 90 / 40 / 154 ms (×4 per 2 chars, so about 3 h at n = 40) |
| glob `*a*a*a*a*b` (5 stars), n = 218 of `a` | **22.9 s** |
| glob with 7 stars, same URL | killed after 5 min |

Patterns come in through agent READ tools (no confirmation; `url` ≤ 8192 chars) and through rules: UI rules,
agent rules, and rules restored from settings. A rule pattern runs in the proxy for **every** request, so one
bad rule stalls all traffic, the MCP server and every extension. Real URLs repeat `/`, `e` and `a`, so even a
modest glob like `*/*/*/*/*x` degrades on long paths.

**Fix:**
- Globs: replace the RegExp with a linear wildcard matcher (the two-pointer `*` algorithm, O(n·m) worst case,
  no backtracking blow-up). It is also faster.
- Regex: accept `/re/` only from the user's UI, not from agents. If agents keep it, run it through a bounded
  engine or reject nested quantifiers (`(…+)+`, `(…*)*`, `(.*){n}`). There is no RegExp timeout in Node 20.
- Cap the stars per glob at about 16. Compile each pattern once per call (see #11).

### 3 (LOW-MED) `part of` targets and generated files are read and opened from anywhere
`packages/extension/src/contract/core.ts:161-168` (`owner = path.resolve(dirname(f), info.partOf)`, then
`fsx.read(owner)`). `nodeFs.read` (:31-36) is `readFileSync` with the 4 MB check only *after* the read
(:154/:168). `extension.ts:206-209` `openLocation` opens any `v.file` (`controller.ts:620-630`
`openViolation`), and `diagnostics.ts:108` publishes diagnostics on it.

Probe (ContractIndex with a recording fs):
- `part of '/dev/zero';` → `read('/dev/zero')`;
- `part of '../../../Users/victim/other/lib/user.dart';` → read, model `sourceFile` set to that file.

A real `readFileSync('/dev/zero')` in Node was OOM-**killed** (exit 137). In the extension host that kills
every extension. It happens on the first JSON response, with no click, because contract checking is on by
default. A FIFO path hangs the read forever. On Windows, `path.win32.resolve('C:\\proj\\lib',
'//evil.example/share/x.dart')` = `\\evil.example\share\x.dart`, so indexing alone makes an SMB connection
(NTLM) unless VS Code's UNC allow-list stops it (same caveat as REVIEW-3 #3). Git can store a `foo.g.dart`
symlink to `/dev/zero` or to a file outside the repo, and `findFiles` follows symlinks by default. This needs a
trusted workspace. Low effort for an attacker, and the fix is cheap.

**Fix:**
- C:
  - `stat` before every read: require `isFile()` and `size ≤ MAX_FILE_BYTES`, then read.
  - Resolve `part of` only for a relative `.dart` URI: no scheme, not absolute, no UNC or drive. Take the
    realpath of the generated file and of the owner, and require both to be inside a workspace folder or a
    package root.
  - Ignore generated files whose realpath leaves the workspace.
  - Limit `importUriFor`'s upward walk to the workspace folder.
- lead: route `openLocation` through `checkSourcePath(file, allowedRoots)` (src/source/resolve.ts, the
  REVIEW-3 #3 guard), and set diagnostics only on files that pass it.

### 4 (LOW-MED) `mutate`: bounded input, unbounded work and output
`packages/proxy/src/jsonpath.ts:241-286` (`applyOps`: `deepCopy(values[i])` per target),
`json-text.ts:162-198` (`stringifyJsonText`: one `parts` entry per token), `mutate.ts:96-112`,
`body.ts:82-101` (`encodeBody`: `gzipSync` / `brotliCompressSync` at the default quality 11),
`intercept-proxy.ts:1272-1287`.

| Probe | Result |
|---|---|
| 1 M-element array, `{path:'$[*]', op:'set', valueJson: 10 KB string}` | heap OOM, process aborted (8 GB heap) |
| 32 MB of `[{},{},…]`, one `null` op | mutated, **1.9 s** synchronous, **+3.1 GB** RSS |
| 18 MB realistic JSON, `brotliCompressSync` (what `encodeBody` does for `br`) | **17.1 s** blocking (gzip: 0.15 s) |
| 1 GB gzip bomb / 512 MB brotli bomb | skipped in 26 / 19 ms, +36 MB: bounded, fine |

The output is about targets × value size, with no cap. An agent rule like
`$.items[*].description → <1 KB string>` on a large list gives an output of hundreds of MB, which is built in
memory, re-encoded synchronously, and then sent to the app. The rule (user, or a confirmed agent call) and the
response size (the server) together decide this. Neither is hostile in the common case, but the result is the
extension host dying. Brotli is reached when the server answers `br`. Dart's `HttpClient` asks only for gzip,
but a hostile server, or an app that sets `Accept-Encoding: br`, gets there. The response-edit path shares
`encodeBody`, but it is human-paced; mutate does this to every matching response.

**Fix:**
- Before applying, count targets per op. Refuse (skip with a note) when `targets × JSON size of the value` or
  the estimated output exceeds `MUTATE_LIMIT_BYTES`.
- Make `stringifyJsonText` keep a running length and throw past the limit.
- Cap parsed nodes (about 2 M) in `parseJsonText`.
- Re-encode with async zlib, and brotli at quality 4-5. Simpler: after a mutation, send identity: drop
  `content-encoding` and set `content-length`. Every HTTP client accepts it, and it avoids recompression.
- Consider running the decode → parse → apply → stringify in a worker for bodies over a few MB.

### 5 (LOW) Contract index: quadratic linking, synchronous build, no yield
`packages/extension/src/contract/owner.ts:53-77` (`findRedirect`: for each `) = Name;` it walks back to the
matching `(`, and an unmatched one walks to the start of the file), `:27-50` (`findClass`: a full token scan
per model), `:153` (`findDecl` falls back to a whole-file scan per field). `service.ts:62-74` reads, tokenizes
and links up to 20 000 files × 4 MB synchronously on the first check. `controller.ts:746-785`
(`pumpContracts` → `runCheck` → `await check()` on a resolved promise → `finally` → `pumpContracts`) drains the
whole queue in microtasks. `recheckContracts` re-queues every exchange (up to 1000 exchanges / 256 MB of
bodies) on every model-file save.

| Owner file | Link time |
|---|---|
| `) = User;\n` × 5k / 10k / 20k (50 / 100 / 200 KB) | 0.23 / 0.96 / 3.8 s (n², so 4 MB takes about 25 min) |
| 400 models × 30 fields, 2 MB owner without the declarations | 21.4 s |
| realistic: 2000 json_serializable classes in one 1.3 MB file | 0.76 s (500: 65 ms, 1000: 208 ms) |

The tokenizer is fine (4 MB pathological input in ≤ 100 ms), and so are the `Parser` depth (200) and the JSON
limits.

**Fix:**
- C: tokenize each owner once. Build `class name → scope` and `declared identifier → first index` maps in one
  pass. Find redirects with a forward scan and a bracket stack. Cap the total bytes indexed (e.g. 64 MB) and
  yield (`setImmediate`) between files.
- H: `await new Promise(setImmediate)` between contract checks. On a models change, re-check only the
  exchanges whose result used a changed model, or the visible ones, lazily.

### 6 (LOW) Contract messages leak values past the agent redactor, and diagnostics are never redacted
`packages/extension/src/agent/samples.ts:218-222`: for a sensitive key/field/path, the code does
`actual.replace(QUOTED, …)` and `message.replace(QUOTED, …)`. The checker (`contract/check.ts`) writes values
in other forms:
- `phrase` / `actualText` (:65-83): `a number (98234123)`, `number 98234123`, `a bool (true)`, all unquoted;
- the non-lenient enum error (:318-323): ``Invalid argument(s): `${src}` is not one of …``. `src` is the
  **untruncated** raw string in backticks; only the double-quoted `phrase` is truncated to 40 chars.

So `{"session": 98234123}` checked against `String session`, or any sensitive-keyed enum field with an
unexpected value, reaches the agent in clear. Agents can also write a `*.g.dart` that decodes
`json['access_token']` as an enum, then call `check_contract {model}`. That needs file access, which
Claude-Code-class agents have. Separately, `ContractDiagnostics` publishes the unredacted message (full enum
value, numbers) to the Problems panel, which agents read through IDE diagnostics APIs.

**Fix:**
- H: build the agent view from structured fields, not by regex on the message. When the key, field or a path
  segment is sensitive, set `actual` to the type only (`number`, `string`, `unknown enum value`) and rebuild
  `message` without values.
- C: give the enum error the same 40-character truncation as the phrase. For sensitive keys, omit the value in
  diagnostics, which leave the agent boundary.

### 7 (LOW) `assert_traffic` reads the real body for `exists` / `type`
`packages/extension/src/agent/api.ts:997-1035`. `real = sel(d.value, a.path)` runs on the unredacted JSON:
- `type` failures print `s.path` from the real tree. `{"session": {"k_9f2a…": 1}}` with
  `{path: '$.session[*]', type: 'string'}` → "`$.session.k_9f2a… is integer, expected string`", which leaks
  keys under a redacted object.
- `exists` reveals the structure and counts under redacted fields.
- `equals` on `$.session.x` passes because `real` is non-empty and the redacted view selects nothing.

**Fix:** with redaction on, select on the redacted view for every assertion. When a path crosses a sensitive
key, fail with "`<path>` is inside a redacted field" instead of evaluating it.

### 8 (LOW) `selectPath` memory and failure fan-out
`packages/proxy/src/jsonpath.ts:178-200`: `track` copies `[...n.segs, s]` for every node at every step, then
`formatPath` runs for each. Probe: a 0.4 MB body `[[[…1,1,…]]]` (depth 300, 200 k leaves) with
`'$' + '[*]'×300` (a 901-char path, under the 1000 limit) took 4.3 s and 4.3 GB RSS. A 5 MB recorded body
OOMs. `jsonFailures` also pushes one string per selected value before the per-exchange
`MAX_ASSERT_FAILURES` check, so `$[*]` with `type` over 2.5 M elements builds 2.5 M strings. This needs a
hostile body and an agent-chosen path.

**Fix:**
- P: keep a parent pointer per node and build paths only for returned results. Cap selected nodes (e.g.
  10 000) and say so.
- H: stop collecting failures at `MAX_ASSERT_FAILURES` inside `jsonFailures`.

### 9 (INFO) Fixtures and key-name redaction
`generate_fixture_test` and the panel's Generate fixture always use `redactExchange` (good). Its scope is
§8's: sensitive *names* only. Login and refresh responses often use keys like `access`, `refresh`, `jwt`,
`id_jwt` or `bearer`, and the JWT lands in `test/fixtures/*.json`, which the tool tells the user to commit.
Text, multipart and GraphQL-string bodies are not redacted either.

**Fix:** for fixtures only, also blank values that look like credentials: `eyJ…\.…\.…` JWTs,
`Bearer\s+\S+`, and ≥ 32-character base64url or hex strings under non-id keys. Add a header note listing what
was blanked and asking for a review before committing.

### 10 (INFO) Bidi characters in generated Dart
`src/codegen/snippets.ts:138-152`: `dartString` escapes `\ ' $`, CR, LF, tab and C0/DEL, but leaves U+202A–202E,
U+2066–2069, U+200B–200F, U+2028/2029 and U+FEFF as they are. A response key like `"name\u202E…"` ends up
inside `@JsonKey(name: '…')` / `json['…']` in an untitled editor. The Dart analyzer warns
(`text_direction_code_point_in_literal`), so this is cosmetic. **Fix:** emit those as `\u{…}`.

### 11 (INFO) Pattern recompilation
`rules.ts:22-24` `matches()` compiles per call. `assertTraffic`'s `ready()` (api.ts:~890) calls `count()` and
`orderFailure()` on every finished exchange: 1000 exchanges × (1 + up to 20 globs) RegExp constructions per
event, while a `withinMs` assertion waits. **Fix:** compile each pattern once per tool call
(`compileMatcher`).

## Checked, fine
- **mutate**
  - **Decompression:** `decodeStrict` bounds every layer's output at 32 MB and fails on corrupt or truncated
    data (gzip / br bombs: 26 / 19 ms). zstd decodes only where Node has it, and is re-encoded or dropped to
    identity otherwise. Unknown encodings and `identity` are skipped with a note.
  - **Depth:**
    - `parseJsonText` and `stringifyJsonText` refuse depth > 1000 (depth 999 mutated, 1001 skipped).
    - A deep `valueJson` is refused.
    - A 200 k-deep `value` throws a RangeError that becomes "skipped".
    - The controller's `isJsonValue` caps a value at depth 200 and 1 MB.
    - The schema limits ops to 20 and paths to 1000 characters, with no control characters.
  - **Prototype pollution:**
    - `$.__proto__.polluted`, `$.constructor.prototype.x` and `$.a['__proto__']` with `set` leave
      `Object.prototype` untouched (probe).
    - Keys select own properties of plain objects only. `__proto__` is written with `defineProperty` in
      the parser, `setKey` and `deepCopy`.
    - Bodies with a `"__proto__"` key round-trip as an own key.
  - **Re-framing:**
    - `frameBody` re-encodes (or drops `content-encoding`), removes `transfer-encoding` and sets
      `content-length`.
    - `content-md5` / `digest` / `content-digest` / `repr-digest` are dropped.
    - HEAD, 204 and 304 (empty body) are skipped, so their original framing is kept.
    - More than 32 MB on the wire still gives the response-breakpoint 502.
    - A chunked or > 5 MB request body skips the rule.
    - Number literals are byte-exact (tests with a real `dart:io` client pass).
    - A BOM is kept, and non-UTF-8 bodies are skipped.
    - The app leaving mid-mutation → `'close'`.
  - **LAN:** a mutate rule on a LAN client still gets the SSRF 403 first (new `lan.test.ts` case). The h2
    route uses the same guarded agent as breakpoints. Under `offline`, a mutate rule behaves like any
    pass-through.
- **Controller / webview:**
  - `mutateField` goes through `validateRule` / `checkMutateOps` (path syntax, op, value ≤ 1 MB JSON-only
    with depth ≤ 200, `valueJson` must parse).
  - `openViolation` checks the index against cached results.
  - `generate*` and `pickModel` act only on known exchange ids.
  - The panel's model generation is unredacted (the user's own view, and models carry types only).
  - The panel's fixtures are always redacted.
  - The webview has no HTML sinks.
- **Agent tools / MCP:**
  - New READ tools are `readOnlyHint: true`. `add_mutation` is annotated like `add_mock` and its Copilot
    confirmation lists the ops: first 5, values ≤ 60 characters, backticks stripped, "Inserted as the first
    rule", plus the times/TTL.
  - Resources go through `tools.call`, so access level, redaction and errors apply. `{id}` is only a map
    lookup: no filesystem, no traversal.
  - The resource list uses the redacted `list_requests`.
  - Prompts are static text with one-line, length-capped arguments. No subscribe, Sampling or Roots. Under
    `off` the server is stopped.
  - `check_contract` keeps `file` project-relative (dropped outside the project), strips the project root from
    messages and redacts the URL. Agents can't pass `List<…>` / arbitrary model text (identifier regex).
  - `generate_model` uses `redactJsonValue` samples, and the models contain types only. `generate_fixture_test`
    always uses `redactExchange` (URL query, headers, JSON / urlencoded bodies). No absolute paths reach the
    output: imports are `package:` URIs and paths are snake_case suggestions.
  - `assert_traffic` `equals` uses the redacted view, `describeValue` never prints values, and the wait is
    bounded by a timer and cancellation.
- **Codegen injection:**
  - Identifiers are `[A-Za-z0-9]` with keyword and avoid lists.
  - Every key, URL, label and content type goes through `dartString` (escapes `$`, quotes, CR/LF, controls).
  - Request bodies use a raw `r'''…'''` only when that is lossless (no `'''`, no trailing `'`, no control
    characters).
  - Comment text is one-lined, method names are tokens, and `on<Method>` / `dio.<method>` only come from an
    allow-list.
  - Fixture JSON is re-indented without changing any literal.
- **Contract parsers:**
  - The tokenizer is linear on pathological 4 MB inputs.
  - Limits: expression depth 200, JSON depth 512, walker ≤ 200 k nodes / ≤ 50 violations / model depth 64,
    file ≤ 4 MB (but see #3: checked after the read), ≤ 20 000 files, tool / cache / symlink directories
    excluded.
  - The JSON parser builds null-prototype objects, and the codegen parser uses `defineProperty`.
  - Messages use the URL path without the query.

## Fix plan
- **H:**
  - #1: agent read filters (incl. `order`) match `this.url(e.url)`; refuse agent rule patterns that probe a
    sensitive query param.
  - #2: no `/regex/` from agents (or a bounded engine); glob-star cap.
  - #6: structured agent view of violations, with no values for sensitive keys.
  - #7: assertions on the redacted view; "inside a redacted field".
  - #8: failure cap inside `jsonFailures`.
  - #5: yield between contract checks; recheck only the affected exchanges.
  - #11: compile patterns once per call.
  - #9 (with G): value-pattern redaction for fixtures.
- **P:**
  - #2: linear glob matcher in `rules.ts` (shared with the webview).
  - #4: target × value budget, output cap in the stringifier, node cap in the parser, identity (or async /
    low-quality) re-encoding after a mutation.
  - #8: `selectPath` without per-node path copies, plus a node cap.
- **C:**
  - #3: stat + `isFile` + size before reading; `part of` only relative `.dart` and inside the workspace or a
    package root (realpath); skip generated files whose realpath leaves the workspace.
  - #5: single-pass owner linking, total-bytes cap, yield between files.
  - #6: truncate the enum value in error text; no values in diagnostics for sensitive keys.
- **lead:**
  - #3: `openLocation` through `checkSourcePath`, and diagnostics only on allowed files.
  - #10: escape bidi / invisible characters in `dartString`.
- **Before release, add tests:**
  - redacted-URL filtering (`/access_token=s/` matches nothing);
  - a glob `*a*a*a*a*b` on a 218-character URL finishes in under 10 ms;
  - `part of '/dev/zero'` / an absolute / `..`-outside owner is never read;
  - `openViolation` on an outside file is refused;
  - mutate `$[*]` with a large value over a large array is skipped with a note, and RSS stays low;
  - `assert_traffic` type/exists under a redacted field doesn't print keys;
  - `check_contract` on a sensitive enum or number field shows no value.

## Resolution (2026-10-10, before release)
| # | Status | Fix |
|---|---|---|
| 1 | fixed | Every agent URL filter (`list_requests`, `wait_for_request`, `export_har`, `assert_traffic` url + `order`, `check_contract`, `generate_model`, `generate_fixture_test`) matches the URL the agent sees (`redactUrl` when redaction is on). Agent rules whose pattern pins a sensitive query value are refused. Test: the char-by-char probe recovers nothing through any filter. |
| 2 | fixed | Globs are matched without RegExp (linear prefix/suffix/indexOf; `*a*a*a*a*b` on 218 chars < 5 ms, was 22.9 s). User `/regex/` rules must pass `isSafeRegexSource` (no nested/adjacent unbounded quantifiers, backreferences, > 256 chars) or never match and show as invalid. Agents may not use `/regex/` at all (globs, ≤ 16 `*`). Residual: narrow overlapping atoms on unusual URLs (~n³) — documented. |
| 3 | fixed | Index reads only regular files within a size cap (non-blocking open + fstat: no FIFOs, devices, UNC); `part of` followed only for relative `.dart` URIs whose realpath is inside the workspace; diagnostics only for workspace files; `openLocation` goes through `checkSourcePath`. |
| 4 | fixed | Parser stops at 2 M values / depth 1000; `applyOps` budget (1 M targets, 64 MB of targets × value size) checked before writing; output capped at 64 MB; mutate yields between parse/apply/write; re-encoding off the event loop (zlib async, brotli quality 4). 32 MB `[{},…]`: refused in 130 ms, worst stall 97 ms. |
| 5 | fixed | Owner linking is one forward pass (200 KB crafted owner 3.8 s → 22 ms); 1 MB per file / 64 MB total caps; indexing and bulk re-checks yield to the event loop (no block > 50 ms in tests). |
| 6 | fixed | Checker messages carry no value for sensitive fields; other values ≤ 40 chars, escaped. Agents get categories only (`null`, `string`, `unknown enum value`…) and rebuilt messages without values, URLs or paths. Diagnostics use the sanitised messages. |
| 7 | fixed | `assert_traffic` `exists`/`type`/`equals` evaluate the redacted view; paths below a sensitive key fail without evaluation and failure texts never describe what is inside. |
| 8 | fixed | `selectPath` keeps parent links (paths built only for results), throws past 10 000 results / 1 M places; ≤ 10 JSON failures per exchange. |
| 9 | fixed | Redaction by value: JWTs anywhere, Bearer/Basic credentials (≥ 16 chars with a digit), long opaque mixed-case tokens (≥ 32) — headers, query, path segments, JSON strings, fixtures, HAR. |
| 10 | fixed | Generated Dart escapes control/format/bidi characters as `\u{…}`; comments show `<U+202E>` placeholders; fixture JSON escapes them as `\uXXXX`. json_serializable's own `.g.dart` output may still contain them (analyzer warning, out of our control). |
| 11 | fixed | Compiled matchers memoised (≤ 1000 patterns); agent filters compiled once per call. |
