# Review 16: v0.16.0 — stateful mocks, fake backend from traffic, light sign-in, new sources, rule index

Independent security review of the uncommitted 0.16.0 working tree on `main`, on top of ef92c5c (0.15.0). It covers
CONTRACTS §22, §23 and §24, including every "as built" subsection (§22.14–§22.17, §23.8–§23.9, §24.6–§24.11) and the
§22.13 / §23.7 review lists.

Scope:
- proxy: `handler-flow.ts`, `http-edits.ts` (`localAnswer`), `rules.ts` (`isSafeRegexSource`, `compileRules`,
  `findRule`, `handlerProblem`), `rule-index.ts`, and the routing in `intercept-proxy.ts` / `connect-flow.ts`;
- model: `src/mocks/{resources,store,snapshot,fromTraffic,drift,splice,auth,bodyMatch,dynamic,swagger2,insomnia,bruno,viaPostman}.ts`,
  plus the changed `link.ts`, `limit.ts`, `toRules.ts`, `sanitise.ts`, `openapi.ts`, `postman.ts`, `detect.ts`;
- host: the store, snapshot, auth, pipeline, traffic, drift, Update example and Bruno-walk sections of `mocks/core.ts`,
  `mocks/service.ts`, `rules/{core,file,service}.ts` (`stores`, `saveStore`), `proxyHost.ts` (`setHandler`),
  `ui/validate.ts`, `ui/controller.ts`, `ui/handlers.ts`;
- agents: `agent/tools/store.ts`, `tools/collections.ts` (`mock_from_traffic`, `update_collection_example`),
  `views.ts`, `shared.ts` (`restoreRedactedJson`), `schema.ts`, `lmTools.ts`, `mcp/server.ts`, `api.ts`.

Not covered: `packages/cli/**` and `packages/sidecar/**` were being changed by other agents during the review. They
were read only to check that every path to the proxy's rule list validates (finding-free, see "Checked, fine"). The
webview was not reviewed beyond what reaches it. `fromTraffic.ts` was getting a small number-kind fix while it was
reviewed; none of the findings depend on that code.

I read the code and ran throwaway probes in a scratch folder outside the repo (`review16/`)
(`A/` proxy, `B/` store and snapshots, `C/` traffic and Update example, `D/` sign-in, dynamic values and readers).
They import the real sources (vite-node, vitest with a probe config, or esbuild bundles), some drive the real
`InterceptProxy` over a socket, and the path probes use the real `MockCollectionsCore` + `SharedRulesCore` on a real
temp folder (macOS, case-insensitive APFS). Each finding names its probe and command. Highlights:
- `A/index-fuzz.ts`: an independent differential fuzzer for the rule index and path trie (its own grammar, not the
  repo's property test), about 161 million rule × request checks over 7 seeds and three index configurations;
- `A/handler-probe.ts`: 21 hostile handler answers, hung handlers and departing clients through the real proxy;
- `A/redos*.ts`: the regex-safety guard;
- `B/paths.ts`, `B/envpath.ts`, `B/redact.ts`, `B/scopes*.ts`, `B/ids.ts`: snapshot paths, redaction, caps;
- `C/fallback.ts`, `C/leak.ts`, `C/regex*.ts`, `C/splice.ts`, `C/caps*.ts`: what survives into a written collection;
- `D/insdos*.ts`, `D/loginstore.probe.ts`, `D/envpath.probe.ts`, `D/dynamic.probe.ts`, `D/readersdos.probe.ts`.

I also ran `npx vitest run test/unit/mocks. test/unit/agent` in `packages/extension` (48 files, 966 tests) and
`npx vitest run test/handler.test.ts test/rule-index.test.ts` in `packages/proxy` (31 tests); all pass. I did not run
the integration, device, agent or webview suites, start an IDE, or touch devices.

Threat model as in REVIEW-1 to REVIEW-15:
- a malicious cloned repo in a trusted workspace (the committed `.vscode/flutter-intercept.json`, linked collection
  files, Bruno folders, snapshot files);
- a malicious or prompt-injected agent that only has our tools, at the §8 access levels;
- hostile servers (their answers now feed "Make a fake backend", drift and Update example);
- other local users and processes;
- the paired LAN device.

New in 0.16.0: the proxy answers through host code (`handler`); host memory holds data the app writes (store) and
sign-in sessions; snapshot files and recorded-traffic collections are **written into the repo for the team to
commit**, so redaction on write is now a confidentiality boundary; three new parsers read committed files on
workspace open.

| # | Sev | Finding | Where |
|---|---|---|---|
| 1 | MED | **The regex freeze guard is bypassed by `[]` / `[^]`** (pre-existing since 0.4.0, not a 0.16 change). `isSafeRegexSource` reads a `]` right after `[` / `[^` as a literal (PCRE), but JavaScript reads `[]` as an empty class and `[^]` as any character, so `/[]?(\w+)+]/` passes `validateRule`. A `block` rule in a hostile shared file needs no approval: one `findRule` on a 25-character word run takes **3.3 s**, doubling per character, in the extension host. Bypasses REVIEW-4 #2. Agents can't (`schema.ts` refuses `/regex/`). | `proxy/src/rules.ts:95-104` (`:92` `\u{`) |
| 2 | MED | **A small committed Insomnia file freezes the extension host.** `normaliseTemplate` re-runs `indexOf('{%')` / `indexOf('{{')` from `pos` every loop: O(n²) when one marker is absent. Environment values have no length cap and the base environment is always read. A 200 KB export blocks the real `core.reload()` for **11.4 s** (0 heartbeats of a 100 ms timer); 400 KB 45 s; the 20 MB cap is about a day. Same class as REVIEW-15 #2. | `mocks/viaPostman.ts:199-227, 245-247`; `mocks/insomnia.ts:121-137` |
| 3 | MED | **A JSON body the strict rewriter can't read loses all name-based redaction in the written collection.** A BOM, an XSSI prefix (`)]}',`), NDJSON, JSONP, depth > 256 or `NaN` → treated as free text, so `password`, `refresh_token`, `sessionId` are written verbatim into `.vscode/flutter-intercept/collections/<name>.json` (and by Update example "add"), under a dialog saying "Credentials removed". The agent view of the same body blanks them. | `mocks/fromTraffic.ts:276-284, 424-450`; `core.ts:2815, 2852` |
| 4 | LOW-MED | **A login that is also a store `create` stores the password.** `POST /sessions` + `DELETE /sessions/:id` makes `sessions` a resource. With sign-in simulation off (default), or on without a 2xx login example, the login body is merged into a record: the password is echoed in the 201 and every list, shown in the panel's Data table, and kept in a snapshot under `pass`. Contradicts §24.1 "no password is read, stored". | `mocks/core.ts:1849-1928`; `resources.ts`; `snapshot.ts:21-29` |
| 5 | LOW-MED | **Snapshot redaction on save is narrower than agent redaction.** The committed file keeps `passWord`, `newpassword`, `userpassword`, `passwordhash`, `passCode`, `pass`, `passphrase`, `accesstoken`, `authtoken`, `refreshtoken`, `idtoken`, `secretkey`, `clientsecret`, `sessiontoken` (all hidden by `get_store`), and URL credentials (`user:pass@`, presigned S3, `?token=`). An agent with file access can save a snapshot and read past its own redaction. | `mocks/snapshot.ts:21-55, 162-185` |
| 6 | LOW-MED | **The traffic sanitiser misses common credential shapes** the agent redaction or the §21.6 copy catches: plural / variant names (`passwords`, `tokens`, `secrets`, `apiKeys`, `passphrase`, `sid`, `verificationCode`), XML / text / HTML bodies, response headers `X-Access-Key` / `X-Request-Sig` / `X-Csrf`, JSON inside a string, relative signed URLs, `hmac=`, `Token <key>`, `otp=` in forms. Merge mode copies them into the team file too. | `mocks/fromTraffic.ts:88-95, 204-270, 438, 908-925` |
| 7 | LOW-MED | **Quadratic JWT regex: a hostile server freezes the extension host.** `\beyJ[…-]{4,}\.…` on `eyJa-eyJa-…`: 64 KB 0.9 s, 256 KB 15 s (28 s in a JSON string), ~4–7 min at the 1 MB example size. Triggered by "Make a fake backend", Update example, or an agent's `mock_from_traffic` **dry run, allowed read-only**. Same regex pre-exists in `agent/redact.ts`. | `mocks/fromTraffic.ts:88`; `agent/redact.ts:44` |
| 8 | LOW-MED | **Environment values reach store resource names and paths**, and from there a committed snapshot file (as a key), every exchange note, the panel, `get_store` and `stores[].resources` keys. REVIEW-15 #5 masked them in `endpoints()` only. Probe: a Telegram bot token in a path becomes the resource name and the note `bot123456:AAHdq…: read 1`. | `core.ts:2012-2013`; `resources.ts:265`; `store.ts:513`; `agent/tools/store.ts:137` |
| 9 | LOW-MED | **Environment values in paths aren't masked for Insomnia and Bruno** (regression of REVIEW-15 #5): `ParseResult.envValues` is an empty map for both, so a sub-environment / `environments/<name>.bru` token in a path shows in full in `endpoints()` (panel, `get_collection`). `redactUrl` misses Telegram and Slack-webhook shapes. | `core.ts:615, 735, 1201` |
| 10 | LOW | **Empty `{scope, records: []}` entries in a snapshot bypass the record and byte caps.** A committed 29.6 MB snapshot, loaded automatically through `stores[].snapshot`, costs +943 MB heap and ~1.1 s per load; 12 such collections run a 4 GB heap out of memory. | `snapshot.ts:92-123`; `store.ts:405-430, 470-475` |
| 11 | LOW | **Personal-data replacement misses common shapes**: percent-encoded e-mails in form bodies (OAuth password grant), e-mail / phone JSON keys, phone numbers and short tokens as literal path segments or kept path-variable values. `removed` (names only, returned to read-only agents by the dry run) can echo an e-mail / phone key. | `fromTraffic.ts:120, 147-151, 438, 461-471, 936` |
| 12 | LOW | **A larger session is written as an empty collection, with counts that say otherwise.** `sanitisePostman`'s 200 000-node walk budget is hit at ~900 endpoints × 2 with 10 headers: the file holds only `info`, the result reports 1 800 endpoints, and the link is added. Fails closed (nothing unsanitised). | `fromTraffic.ts:1143`; `types.ts:255` |
| 13 | LOW | **One client id ≥ 2^53 (or a snapshot `next` near it) freezes the integer id counter**: every later create gets a string id `users-<Date.now()>` (breaks Dart `as int`) after a 1 000 000-iteration loop. Correctness, not confidentiality. | `store.ts:758-766, 806, 980` |
| 14 | LOW | **Store answers use the example's raw headers** (no `cleanHeaders`): one invalid header turns every store answer of that resource into a 502. No injection reaches the wire. Header values outside Latin-1 (also 0.15 mocks) give a hidden mockttp `500` while the exchange is recorded as a `mocked` 200. | `mocks/store.ts:843-860`; `proxy/src/script.ts:490-504`; `proxy/src/http-edits.ts:78-88` |
| 15 | INFO | Smaller items: made-up answers accept 1xx statuses and hop-by-hop headers (15a); proxy note flattening only strips CR/LF (15b); a `__proto__` resource vanishes from counts / snapshots, store answers re-serialise numbers, `.VSCODE` refused with the wrong reason, snapshot `scope` values unredacted, nested `[redacted]` restore crosses parents (15c); `collapseSiblings` O(n²), a fake backend named "Bruno", internal hosts kept, agent `replacePersonalData: false`, Update example through an in-workspace symlink (15d); session tokens from `Math.random` / sequential in seeded mode (15e); JWT `sub` = unsalted hash of the e-mail (15f); Bruno walk check-then-read gap (15g). | various |

**Common root of #4, #5, #6:** three different "is this field secret" predicates (`snapshot.ts` `SECRET_WORDS`,
`fromTraffic.ts`' use of it, `agent/redact.ts` `FIELD` / `isSensitiveField`, `sanitise.ts` `SECRET_KEY`) disagree,
and the files written for the team use the narrowest one. One shared predicate for everything written to disk, at
least as wide as the agent's, with the small allow-list (`author`, `sessionCount`, `pinned`, `tokenizer`) the word
rule was built for, fixes most of #4–#6 at once. **#8 and #9** share a fix too: give every format a host-only
`envValues` map (#9), then apply the mask to resource names and paths once, where the core builds resources (#8).

**What 0.16 got right** (details under "Checked, fine"): nobody but the host can author a `handler` rule; the
in-flight cap never leaks; the proxy owns framing (`content-length` / `transfer-encoding`) and refuses CR/LF; the rule
index and path trie never missed a rule in ~161 M differential checks; store records are null-prototype with caps on
every write path; snapshot paths refuse every symlink and traversal case tried; agents can't write the team's
collection file through `update_collection_example`, and `set_store` / `store_snapshot` are write tools; the
password is never read by the auth path itself; dynamic values escape correctly and never see environment-file values;
the Bruno walk refuses symlinks and never reads `.env`, `vars:secret` or auth values.

## Details

### 1 (MED) The ReDoS guard misreads `[]` / `[^]`

`isSafeRegexSource`, at `rules.ts:95-104`:
```ts
if (c === '[') {
  let j = i + 1;
  const negated = src[j] === '^';
  if (negated) j++;
  if (src[j] === ']') j++;            // PCRE rule: a leading ] is a literal
  while (j < src.length && src[j] !== ']') j += src[j] === '\\' ? 2 : 1;
```
JavaScript closes the class at that `]`, so `[]` is an empty class and `[^]` matches any character. The guard instead
reads `[]?(\w+)+]` as one class atom and never sees the nested quantifier `(\w+)+`. `rule-index.ts` `skipClass`
already uses the JavaScript rule, as its comment says.

Reproduction (`redos.ts`, `redos2.ts`, `redos3.ts`):
```
$ cd packages/extension && npx vite-node …/review16/A/redos2.ts
validateRule accepted: true
token of 24 chars: 57 ms
token of 26 chars: 233 ms
token of 27 chars: 480 ms
$ cd packages/proxy && npx vite-node …/review16/A/redos3.ts
"[]?(\\w+)+]" isSafe true 3280 ms on 25 chars
"[^](\\w+)+]" isSafe true 3290 ms on 25 chars
"(a+)+$" safe= false            # (redos.ts) the same nested quantifier without the class is refused
```
The rule used is `{match: {url: '/^https:\/\/api\.example\.com\/[]?(\w+)+]/'}, action: {kind: 'block', mode: 'reset'}}`.
An unanchored `/[^](\w+)+]/` is a wildcard rule, so it is tested on every request. Any URL with a run of 30 or more word characters
(a hash, a token in a query, a UUID without dashes) then blocks for seconds, and 35 or more for minutes.

Impact: the proxy runs inside the extension host (and inside the sidecar / CLI). A hostile `.vscode/flutter-intercept.json`
in a cloned repo can carry such a `block` rule, and a `block` rule needs no approval (`rules/policy.ts`
`actionApprovalReasons` has no case for it). The extension host then freezes, with every other extension in it, as
soon as the app sends a matching URL. The webview's rule module runs the same matcher. Agents are not a vector:
`agent/schema.ts:16` refuses `/regex/` patterns. This bypasses the REVIEW-4 #2 guarantee, and it was already there
before this release.

A second, practically unreachable gap: without the `u` flag, `\u{…}` is skipped up to the next `}` as one atom
(`rules.ts:92`). JavaScript instead reads `\u` as `u`, then a literal `{`, then whatever the skipped text holds.
`/\u{(\w+)+}/` is "safe", but it needs a literal `u{` in the URL, and Dart sends `{` as `%7B`.

Fix: in `isSafeRegexSource`, close a class with JavaScript's rule. Drop the `if (src[j] === ']') j++;` line, or reuse
`rule-index.ts` `skipClass`. Even simpler, refuse `[]` and `[^]`, since they are never useful in a URL rule. Treat
`\u{` as an atom only when the flags contain `u` (or `v`). Otherwise refuse it, or step over just `\u` so the `{` is
read next. Add `[]?(a+)+]`, `[^](a+)+]` and `\u{(a+)+}` to the REVIEW-4 regression tests.

### 2 (MED) A small Insomnia file freezes the extension host

**Where.** In `viaPostman.ts:199-227`, `normaliseTemplate(input, insomnia=true)` calls `input.indexOf('{{', pos)` and
`input.indexOf('{%', pos)` again on every loop iteration. When one of the two markers doesn't occur later in the
string, each call scans to the end, so the cost is O(n²). URLs and route paths are capped at `urlChars` (8 KB) before
they reach it. Environment values are not: `insomnia.ts` `readEnvironment` / `flatten` keep any scalar string, and
`buildVars` → `expandValues(raw, true)` (`viaPostman.ts:247`) normalises every value. The base environment is
always read, even when no environment is chosen. The walk budget (`touchNode`) counts nodes, not string length. Bruno
is not affected because it calls the function with `insomnia=false`. Its 5 MB env value took 188 ms.

**Reproduction.**
- `D/insdos.probe.ts`: `parseInsomnia` on a v4 export whose base environment has
  `big: "{{a}}" × n`.
  - 100 KB: 2 771 ms
  - 200 KB: 10 941 ms
  - 400 KB: 45 463 ms (quadratic)
- `D/brunoenv.probe.ts`: the `{%`-only variant. 200 KB of `{%a%}` takes 5 663 ms (the `{{` search is now the one
  that scans).
- `D/insdoscore.probe.ts`: the same 200 KB file linked from `.vscode/flutter-intercept.json`, run through the real
  `MockCollectionsCore.reload()`:
  `reload ms 11374 heartbeats (100 ms timer) 0 endpoints 1`.

**Impact.** This is the REVIEW-15 #2 class. A hostile, or simply odd, Insomnia export linked from the committed shared
file is parsed on the extension host when the workspace opens, and again on every file change. A file well under the
20 MB cap blocks the host from minutes to hours. That takes down every extension in the window, not only ours.

**Fix.**
1. Make `normaliseTemplate` linear: keep the last positions found for `{{` and `{%`, and search again only once `pos`
   has passed them, as `renderDynamic` does with `nextClose`.
2. Drop environment values longer than `COLLECTION_LIMITS.urlChars` in `readEnvironment` / `flatten` (Insomnia) and
   in `readEnvFile` / collection vars (Bruno). They can't end up in a URL anyway, and the walk budget doesn't count
   their size.
3. Add a test: 5 MB of `{{a}}` and of `{%a%}` as a base-environment value parse in under 200 ms.

### 3 (MED) Unreadable JSON skips all name-based redaction

**Where.** `TrafficSanitiser.jsonText` (`fromTraffic.ts:276-284`) returns `undefined` on any deviation from strict
JSON. That covers a leading U+FEFF, an XSSI guard such as `)]}',\n`, NDJSON (two values), JSONP, depth > 256
(`MAX_JSON_DEPTH`) and `NaN`. `responseBody` (`:424-434`) and `requestBody` (`:436-451`) then fall back to
`this.text(text)`, which only handles JWTs, `Bearer` / `Basic`, URLs and e-mails. `sanitisePostman` doesn't look at
response bodies, and its raw request-body pass doesn't catch the BOM case either. Update example uses the same
call: `core.ts:2815` `new TrafficSanitiser(true).responseBody(sample, true)`. Drift qualifies such an answer
(`isJsonAnswer` only looks at the content type), so `driftLatest` points at it and **add** mode
(`core.ts:2852`) writes it into the team file.

**Reproduction.** `C/fallback.ts`: `./build.sh fallback.ts && node fallback.js`. Body
`{"password":"hunter2pass","refresh_token":"rt-short-123","sessionId":"sess9"}` with various wrappers:
```
plain   collection file keeps: []                                       agent view keeps: []
bom     collection file keeps: ["hunter2pass","rt-short-123","sess9"]   agent view keeps: []
xssi    collection file keeps: ["hunter2pass","rt-short-123","sess9"]   agent view keeps: []
ndjson  collection file keeps: ["hunter2pass","rt-short-123","sess9"]   agent view keeps: []
jsonp   collection file keeps: ["hunter2pass","rt-short-123","sess9"]   agent view keeps: []
deep    collection file keeps: ["hunter2pass","rt-short-123"]           agent view keeps: []
nan     collection file keeps: ["hunter2pass","rt-short-123"]           agent view keeps: []
request body with BOM keeps password: true
```
`C/splice.ts` (part 3): the Update example add-mode body for a BOM answer is
`"﻿{\"refresh_token\":\"rt-1\",\"password\":\"hunter2pass\"}"`, inserted as the Postman example's `body`.

**Impact.** For a backend that does any of these consistently (an ASP.NET / IIS BOM, a Google-style or Angular XSSI
guard, streaming NDJSON), every recorded answer carries its passwords, refresh tokens and session ids into
`.vscode/flutter-intercept/collections/<name>.json`. That file is linked in the committed
`.vscode/flutter-intercept.json`, and the dialog says "Credentials removed". The agent view of the same body
(`redactBodyText`, which has a regex fallback) redacts all of them, so the file written for the team is redacted
*less* than an agent's tool output. A recording export into the repo would need full §8 redaction
(`notIgnored`).

**Fix.**
- Before rewriting, strip a BOM and a known XSSI prefix (`)]}'`, `)]}',`, `while(1);`, `for(;;);`) and keep it
  verbatim in the output. Rewrite NDJSON line by line.
- When the rewrite still fails for a body that is JSON by type or by its first character, don't fall back to
  `text()` alone. Either apply a name-based regex pass (`"<name>"\s*:\s*"<value>"` / `<name>=<value>` /
  `<tag>value</tag>` with `isSecretFieldName ∪ isSensitiveField`, as `redactBodyText` does), or drop the body
  (`""`) and add a `skipped` line ("1 answer that wasn't plain JSON left out").
- Use the same rule in `exampleUpdate` (it already refuses non-JSON for `merge`; `add` should refuse or blank too).
- Add test cases for BOM, XSSI, NDJSON, depth and `NaN` on both the request and the response side.

### 4 (LOW-MED) A login request that is also a store `create` stores the password

**Where.** `detectAuth` (`auth.ts:74`) and `detectResources` (`resources.ts`) are independent. A `POST /api/sessions`
login, plus any item route on `/api/sessions/:id` (`DELETE` for logout is typical), makes `sessions` a resource
(§22.3 rule 1), so the login POST becomes the store's `create`. In `core.ts handle()`:
- The auth branch (`:1850-1883`) runs only when sign-in simulation is on. It returns early only when there is a 2xx
  login example.
- Otherwise the request reaches step 4, the store (`:1903-1928`). §22.5 builds the record from the example ⊕ the
  **request body** ⊕ the id.

From then on:
- the password is in host memory;
- it is echoed back in the 201 answer and in every `GET /sessions`;
- `storeItems` (the panel's Data table) shows it as is;
- `snapshotText` blanks it only when the field name matches the narrow snapshot list. `SECRET_WORDS` has `password`,
  `passwd`, `pwd`, `passcode`, but not `pass`, `pass_word`, `userPass` or `passphrase`. The agent redaction
  (`agent/redact.ts:34`, `/pass(word)?|…/`) is wider.

**Reproduction.** `D/loginstore.probe.ts`, two cases. The login body is
`{"user":"sara@example.com","pass":PW,"password":PW}`.

```
auth off (default):
login answer 201 {"id":1,"token":"abc","userId":5,"user":"sara@example.com","pass":"Hunter2-planted-PW!","password":"Hunter2-planted-PW!"} sessions: created 1
panel storeItems {"total":1,"items":[{… "pass":"Hunter2-planted-PW!","password":"Hunter2-planted-PW!"}]}
agent view (redaction on) [{… "pass":"[redacted]","password":"[redacted]"}]
snapshot … "pass": "Hunter2-planted-PW!", "password": ""   blanked [ 'sessions.password', 'sessions.token' ]
auth on, login with no 2xx example: same (store answers 201, password stored)
```

**Impact.**
- It contradicts §24.1, "no password is read, stored or compared". The host itself detected the request as a login
  (`StoreStatus.auth.login` names it).
- The real password of a dev or test account lives in the store, in the panel, and in the app's own later answers.
- One "Save snapshot" puts it in a file the panel tells the team to commit (§22.8), whenever the field is called
  `pass`, `userPass`, `pass_word` and so on.
- With agent redaction off, agents get it from `get_store`.

**Fix.**
1. Never let a request `detectAuth` names (login / refresh / logout) be a store write op. Leave it out of the resource's
   `ops`, or treat it as static in `toRules`' `stateful` option; it answers by its examples as in 0.15.
2. Independently, for defence in depth: on `create` / `replace` / `patch`, drop request-body fields with secret-like
   names before storing, using the agent's `isSensitiveField` or the snapshot list, whichever is wider.
3. Align `SECRET_WORDS` with `isSensitiveField` (`pass`, `passphrase`, `pass_word` → `pass` + `word`).
4. Test: `POST /sessions` + `DELETE /sessions/:id` keeps no password, with auth both off and on.

### 5 (LOW-MED) Snapshot redaction keeps secrets that agents never see

**Where.** `snapshot.ts:21-55`: `isSecretFieldName` splits a name into camelCase / snake words and matches whole
words or pairs. Lower-case run-together names (`accesstoken`, `newpassword`), split words (`passWord` → pass, word)
and `pass` / `passphrase` / `passwordhash` match nothing. `snapshot.ts:162-185` `redactValue` only blanks values that
`isOpaqueToken` / JWT / `Bearer` / `Basic` catch. It doesn't use `TrafficSanitiser`'s URL-in-text redaction
(userinfo, `X-Amz-Signature`, `sig=`, `token=`) or the known token prefixes (`sk_live_`, `xox?-`, `AKIA`). The agent
redaction (`redact.ts:34` `FIELD`, a substring match on `pass|token|secret|…`) does catch the names.

**Reproduction.** `B/redact.ts` runs one record through `snapshotText` and through the agent's `redactRecord`.
```
npx vite-node …/review16/B/redact.ts
passWord       snapshot:KEPT     agent:redacted
newpassword    snapshot:KEPT     agent:redacted
userpassword   snapshot:KEPT     agent:redacted
passwordhash   snapshot:KEPT     agent:redacted
passCode       snapshot:KEPT     agent:redacted
pass / passphrase / accesstoken / authtoken / refreshtoken / secretkey / clientsecret / sessiontoken / idtoken
               snapshot:KEPT     agent:redacted
databaseUrl (postgres://admin:S3cretPass@db…), avatarUrl (X-Amz-Credential/X-Amz-Signature), link (?token=…),
basicUrl (https://deploy:p4ssw0rd@…), dsn, stripe sk_live_…(24 chars), slack xoxb-…, AKIA… key id
               snapshot:KEPT     agent:KEPT
```

**Impact.** The store holds what the app writes, such as a sign-up `{email, newpassword}` or a profile `PATCH`. "Save
snapshot" says "Secret-looking fields are blanked" and that the file is for the team to commit. Those values go into
the repo. Agents can also get around their own redaction this way. `get_store` hides `newpassword`, but an agent
with workspace file access (Claude Code, Copilot agent mode) can call `store_snapshot {action:'save'}` and read the
file. It needs a write tool that Copilot confirms, and the data is usually test data the developer typed. That is why
this is LOW-MED and not higher.

**Fix.** Blank a field when either rule calls it secret: `isSecretFieldName` **or** the agent's `isSensitiveField`.
Keep a short allow-list for the false positives the word rule was meant to avoid (`author`, `sessionCount`,
`pinned`), or also match secret words as suffixes or prefixes of a lower-case run (`…password`, `…token`, `pass…`).
Run `TrafficSanitiser`'s URL-in-text and token-prefix value redaction on string values, and redact `scope` values the
same way. Add the probe's names as test cases.

### 6 (LOW-MED) The traffic sanitiser misses common credential shapes

**Where.**
- Response JSON field names are judged only by `isSecretFieldName` (`fromTraffic.ts:206, 248, 263`; word list
  `snapshot.ts:21-30`). That list has `password`, `token` and `secret`, but not `passwords`, `tokens`, `secrets`,
  `api keys`, `passphrase`, `sid`, `code`, `verificationCode`, `nonce`, `hmac` or `bearer`. The agent redaction
  (`FIELD`, a substring rule) and the §21.6 copy (`SECRET_KEY`, which has `passphrase` and `private`) catch most of
  these.
- Response headers are dropped only on `isSensitiveHeader` or a credential-looking value (`:908-925`). On the
  request side, `sanitisePostman`'s `SENSITIVE_HEADER_EXTRA` also blanks `X-…-Key`, `X-…-Sig`, `Ocp-Apim-…` and
  `X-Signature`, but for responses it is only called with the cookie predicate.
- Non-JSON bodies (XML, `text/plain`, HTML) get only `text()`.
- `cleanUrl` blanks only `SIGNED_QUERY` / `isSensitiveField` names (`:95`), and only in absolute URLs
  (`URL_IN_TEXT` needs `://`).
- A form body goes through `redactQueryString`, so `FIELD` without `otp` / `pin` / `code` applies (`:438`).
- `Token <key>` / `Digest` / `ApiKey` schemes inside values aren't recognised (`AUTH_SCHEME` is Bearer / Basic only).

**Reproduction.** `C/leak.ts`: `./build.sh leak.ts && node leak.js` (add `dump` for the file). Values that survive
into the collection text (excerpt of the example body and headers):
```
"verificationCode": "482913", "code": "482913", "sid": "s%3AQx9aZ1", "passphrase": "correct horse battery",
"tokens": {"fcm": "fcm_abc_ZZZ_short1"}, "secrets": {"db": "db-pass-1234"}, "apiKeys": ["ak_live_9988"],
"passwords": ["hunter2pass"], "payload": "{\"access_token\":\"tok_plain_v4lue\"}",
"downloadUrl": "/files/1?sig=relsig0value&se=2030", "avatar": "https://cdn.example/a.png?X-Amz-Signature=&hmac=hmacvalue1234",
"list": [<JWT placeholder>, "Token sk_live_51HxPlanted01"]
response header: X-Access-Key: xaccesskeyvalue1, X-Request-Sig: xsigvalue55, X-Csrf: csrfval66
(the request's X-Access-Key / X-Signature were blanked)
form request body:  username=jane.doe%40corp-mail.sa&pin=&passphrase=&otp=482913
text request body:  user=user1@example.com pass=hunter2pass
XML answer:         <r><token>xmlTOKENvalue99</token><session>PlainTextTokenValue123</session></r>
text answer:        token: PlainTextTokenValue123\nsecret=db-pass-1234
```
`C/splice.ts` (part 2): merge mode with `added` findings writes `"passwords": ["hunter2pass"]` and
`"verificationCode": "482913"` into the team's example. `refresh_token` is blanked correctly.

**Impact.** Credentials held under ordinary but unlisted names, in non-JSON bodies, or in relative signed links end
up in a committed file whose dialog says "Credentials removed". Long opaque tokens, JWTs, `Bearer`, `Cookie` /
`Set-Cookie`, `Authorization` and query values are handled, so what leaks is mostly short tokens, one-time codes
and secrets inside bodies. This is the same class as REVIEW-15 #6.

**Fix.**
- For traffic, the name rule should be `isSecretFieldName(k) || isSensitiveField(k) || SECRET_KEY(k)`, together
  with a plural-aware word split (strip a trailing `s` before the lookup). Add `sid`, `otp`, `code` when it is a
  sibling of auth words, `nonce`, `hmac`, `passphrase`, `bearer`. The snapshot rule can stay narrow; traffic is
  less trusted than store data.
- Apply `isSanitiseSensitiveHeader` to response headers in the traffic builder.
- Run `cleanUrl`'s query rule on relative URLs (`/…?…`) too, and add `hmac`, `code`, `policy`, `key-pair-id`,
  `se` / `sp`-style SAS parts only when `sig` is present.
- Add `Token|Digest|ApiKey|Apikey` to `AUTH_SCHEME` in `credentialsIn`.
- For XML / text bodies, add a `<name>value</name>` / `name[:=]\s*value` pass with the same name rule.
- Try `jsonText` on string values that start with `{` / `[` (JSON in a string), with a depth / size budget.

### 7 (LOW-MED) Quadratic JWT regex: a hostile server freezes the extension host

**Where.** `JWT_ANY = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g` (`fromTraffic.ts:88`) and the
identical `JWT` in `agent/redact.ts:44`, used by `looksLikeCredential`, `credentialsIn` and `redactSecretValues`.
`-` isn't a word character, so `\b` holds before every `eyJ` in `eyJa-eyJa-…`. Each start scans the whole
`[A-Za-z0-9_-]` run, looks for the `.`, and fails, which is O(n²).

**Reproduction.** `C/regex.ts` and `C/regex2.ts`: `./build.sh regex.ts && node regex.js`, and
`./build.sh regex2.ts && node regex2.js`:
```
eyJa- repeated (text)          64 KB   895 ms     256 KB 14 884 ms
eyJa- repeated (JSON string)   64 KB 1 848 ms     256 KB 28 430 ms   (looksLikeCredential + credentialsIn: two passes)
agent redactBodyText          256 KB 15 727 ms    bare JWT regex 256 KB 15 819 ms
(e-mail, URL, Bearer regexes on the same sizes: ≤ 3 ms)
```
Scaled quadratically, a 1 MB answer (`DEFAULT_MAX_EXAMPLE_BYTES`) takes about 4 minutes as text and 7.5 minutes as a
JSON string.

**Impact.** A server the app talks to (hostile servers are in the threat model) returns such a body once. The
extension host then blocks when the user makes a fake backend from the session, when they open Update example on
that endpoint, or when an agent calls `mock_from_traffic {dryRun: true}`, which is allowed at **read-only** access
(`api.ts:67-69`). Every other extension in the window stops responding as well. The same input already slows agent
views of exchanges (`redactBodyText`), so the root cause predates 0.16. 0.16 adds a read-only agent trigger and two
more entry points.

**Fix.** Make the match start only at the beginning of a token run:
`/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g` (linear: one attempt per run), or
tokenise once with `/[A-Za-z0-9_.-]+/g` and test each token with an anchored regex. Fix it in both files, and add
a 1 MB timing test (≤ 50 ms). The lookbehind no longer matches a JWT glued to a preceding `-` (`x-eyJ…`), which
`\b` did; such a value sits inside a longer base64url run and is caught by the opaque-token rule, but say so in the
test. `policy.ts` `JWT` (`/\beyJ…\./`, no trailing `*`, used on short shared-file values) is the same shape and can
take the same change.

### 8 (LOW-MED) Environment values reach resource names, paths, notes and committed snapshots

**Where.** `resources.ts:265` `resourceName()` builds the name from the literal segments of the endpoint path.
Environment values are already substituted into those segments, the same values REVIEW-15 #5 found in `url`.
`core.ts:2012-2013` puts `name` and `path: displayPath(...)` into `StoreStatus` unmasked. `endpoints()`
(`core.ts:1200-1202`) masks the same values as `{{name}}`. `store.ts:513` uses `res.name` as the label of every
store note (`"<name>: read 1"`). `dump()` and `snapshotText` use it as the resource key of the snapshot file.
`agent/tools/store.ts:137` passes `resources` to agents with no `endpointKeyView` or redaction. Only `problem` goes
through `ag.text`. `set_store {resource, remembers:false, scope:'team'}` also writes the name as a key of
`stores[].resources` in `.vscode/flutter-intercept.json`.

**Reproduction.** `B/envpath.ts`. It uses a Postman collection with `GET/POST {{baseUrl}}/{{tenantKey}}/todos`,
`GET …/todos/:id`, `GET {{baseUrl}}/{{botToken}}` and `GET …/{{botToken}}/:id`, linked with an environment file
where `tenantKey = sk_live_51HxQz` and `botToken = bot123456:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw`.
```
cd packages/extension && npx vite-node …/review16/B/envpath.ts
[ { "name": "todos", "path": "/sk_live_51HxQz/todos/:id" },
  { "name": "bot123456:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", "path": "/bot123456:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/:id" } ]
panel/agent endpoint urls (masked): [ 'https://api.todo.test/{{tenantKey}}/todos', … '{{botToken}}/:id' ]
saved {"path":".vscode/flutter-intercept/snapshots/todo/demo.json","resources":2,"records":2}
  "resources": { "bot123456:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw": [ { "records": [ { "id": 1 } ] } ], …
note on the exchange: bot123456:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw: read 1
```
Neither value is caught by the value heuristics: the Telegram token has a `:`, and the Stripe key is shorter than
32 characters.

**Impact.** Environment files hold secrets and are usually gitignored. §21.6 says environment values never reach the
panel or agents. §22.8 says "a snapshot never contains … environment values". Here a value goes into a file the panel
tells the team to commit. It also goes to agents through `get_store`, `set_store` counts, exchange notes and
`collection.store.resource`. It needs an environment value in a path segment: anywhere in it for `path`, and as the
last literal or the literal before a parameter for `name`. That is the same precondition as REVIEW-15 #5, so the
severity is the same.

**Fix.** Build resource names and `listPath` from the unresolved template, with variables kept as `{{name}}`. Or,
like `endpoints()`, apply the `envValues` mask to `name` and `path` once in `detectResources`' caller. Then the store,
the notes, the snapshots and the `stores[].resources` keys all see the masked name. Add a test that saves a snapshot
of such a collection and greps for the value.

### 9 (LOW-MED) Environment values in paths aren't masked for Insomnia and Bruno

**Where.** REVIEW-15 #5 is fixed in `endpoints()` (`core.ts:1201-1202`) by replacing every `envValues` value of 3 or
more characters with `{{name}}`. For the two new formats that map is empty:
- `readBruno` returns `envValues: new Map()` (`core.ts:735`);
- the Insomnia branch of `loadFile` never sets it, because `link.environment` is a name there and not a file
  (`core.ts:571-585`, `:615`).

`parseInsomniaDoc` / `parseBruno` resolve the chosen sub-environment / `environments/<name>.bru` into the URL
(`insomnia.ts:121-137`, `bruno.ts:600-611`).

**Reproduction.**
- `D/envpath.probe.ts`, on a real temp workspace:
  - a Bruno collection with `environments/prod.bru` holding `botToken: 123456789:AAHk9plantedBotTokenValueXYZ`;
  - an Insomnia v4 export with a `prod` sub-environment holding the same value;
  - in both, the URL is `{{baseUrl}}/bot{{botToken}}/getMe`.

  For both formats:
  ```
  endpoints() [["GET {{baseUrl}}/bot{{botToken}}/getMe","https://api.telegram.org/bot123456789:AAHk9plantedBotTokenValueXYZ/getMe"]]
  ```
- `D/redacturl.probe.ts`: the agent's `redactUrl` keeps it, and keeps a Slack webhook path too. Only an `sk_live_…`
  segment is caught:
  ```
  https://api.telegram.org/bot123456789:AAHk9plantedBotTokenValueXYZ/getMe => (unchanged)
  https://hooks.slack.com/services/T0000/B0000/plantedXXXXXXXXXXXXXXXXXX => (unchanged)
  ```

**Impact.** It is the same as REVIEW-15 #5, which was rated LOW-MED and fixed for Postman. Environment values (§21.6:
"never in `state()`, `endpoints()`, problems") reach the panel and agents through `get_collection` for Insomnia and
Bruno collections. Insomnia's private sub-environments are skipped, and Bruno `vars:secret` is never read, so the
exposure is limited to values the team put in a plain environment.

**Fix.**
1. Have `SourceParsed` carry the chosen environment's expanded values: a host-only `envValues` map, the same `env` map
   that `buildVars` / `parse` already build. Strip it out of what is exposed.
2. Set `ParseResult.envValues` from it in both `loadFile` (Insomnia) and `readBruno`.
3. Add the REVIEW-15 #5 test for both formats.

### 10 (LOW) Empty scopes in a snapshot get past the record and byte caps

**Where.** `snapshot.ts:92-123` caps records per resource (5 000), bytes of records (32 MB) and resource names (100).
It doesn't cap the number of `{scope, records}` entries. `store.ts:405-430` (`load`) checks `count` (records) and
`bytes` (records) only, and `store.ts:470-475` makes one `Scope` (object, `records` array, `Map` index) per entry. With
`asStart` it also keeps a copy in `st.start`. `prepareStore` (`core.ts:1691-1694`) loads `stores[].snapshot` on every
(re)parse of a linked collection, with no user action.

**Reproduction.** `B/scopes.ts` and `B/scopes4.ts`, on a nested resource (`/users/:userId/orders/:id`).
```
npx vite-node …/review16/B/scopes.ts 690000
snapshot bytes 29.6 MB
parse [] 388 ms
load [] 1089 ms heap + 943 MB
reset 335 ms
maximum resident set size 1 760 165 888
NODE_OPTIONS=--max-old-space-size=4096 npx vite-node …/review16/B/scopes4.ts      # 20 collections, one file each
collection 10: loaded in 2874 ms, heap 3.91 GB
collection 11: loaded in 7531 ms, heap 4.24 GB
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
```

**Impact.** In a malicious cloned repo, the hostile teammate commits `stores: [{collection, snapshot: "x"}]`, the
snapshot and a collection with a nested resource. Every reload then blocks the extension host for 1 to 3 s and holds
300 MB to 1 GB. About 12 such collections (≈ 360 MB of committed JSON) crash it. The files are large, which is why
this is only LOW. App traffic can also leave empty scopes: create in a new parent, then delete. That is bounded by the
5 000-record cap only while the seed is non-empty.

**Fix.** In `validateSnapshot`, count each entry against `recordsPerResource`, for example `entries + records ≤ 5
000`, and refuse a repeated scope there. In `load`, skip entries with no records. A parent with no records reads the
same as one that was never stored, except for a seeded nested resource. Keep that exception explicit, as one entry
per parent the user emptied, under the same count.

### 11 (LOW) Personal data replacement misses common shapes

**Where.**
- `emailsIn` (`:147-151`) runs on percent-encoded form bodies (`:438`), so `%40` is never matched.
- JSON object **keys** are always copied verbatim (`rewrite` → `out.push(k.raw)`).
- `pathSegment` (`:461-471`) replaces only e-mails in literal segments.
- `url()` keeps any `^-?\d{1,19}$` param value as the Postman path-variable value (`:936`), a phone number or an
  OTP included.
- Literal segments shorter than `isIdSegment`'s 16-char opaque rule stay literal.
- `note(key)` (`:120`) records the key of any value under a secret-named parent, and that key can be data.

**Reproduction.**
- `C/leak.ts`:
  - `username=jane.doe%40corp-mail.sa` in the form body;
  - `"contacts": {"jane.doe@corp-mail.sa": …}` and `"byPhone": {"+966501234567": true}` in the answer;
  - `"name": "GET /v1/profile/+966501234567"` with the same literal in `raw` / `path`;
  - `GET /v1/users/:userId/balance` with `"variable":[{"key":"userId","value":"966501234567"}]`;
  - `"name": "GET /v1/magic/Xk9pQ2mZrT"`;
  - `/v1/reset/482913` with the variable value `482913`.
- `C/splice.ts` (part 4): `removed: ["+966501234567","auth","jane.doe@corp-mail.sa"]` for
  `{"auth":{"jane.doe@corp-mail.sa":"x","+966501234567":"y"}}`.

**Impact.** With "Replace e-mails, phone numbers and addresses" on (the default), a user's real e-mail (form logins
are common) and MSISDNs can still end up in the committed file. MSISDN-keyed APIs are common in telecom apps. A
value can also appear in `removed`, which the panel and agents get, including through the read-only dry run.
Everything else in example bodies is real data by design, and the dialog says so.

**Fix.**
- Run `emailsIn` on the decoded value of each form field and re-encode.
- Pass object keys through the e-mail / phone rules when they look like one (`EMAIL_WHOLE`, `^\+?\d{8,15}$`).
- In `pathSegment`, also replace `^\+?\d{8,15}$` segments, or make them params with an empty value.
- Blank numeric path-variable values longer than ~7 digits (ids are still kept for short numbers), or keep them only
  when they also appear as an id field in that endpoint's answer.
- In `note`, record the key only when it is the secret-named one, never keys inside a secret subtree (use the
  parent's name).

### 12 (LOW) A larger session becomes an empty collection, with wrong counts

**Where.** `collectionFromTraffic` builds the whole document, then runs `sanitisePostman(result.doc)`
(`fromTraffic.ts:1143`). Its walk stops at `COLLECTION_LIMITS.walkNodes = 200 000` (`types.ts:255`) and drops the rest
(`TOO_LARGE_NOTICE`). All of one host's endpoints sit in one folder, so the whole `item` array goes. `endpoints` /
`examples` are computed before the sanitiser runs. `mockFromTraffic` then writes and links the empty collection,
and `copyIn` sanitises again.

**Reproduction.** `C/caps.ts` (variants `caps_<N>.ts`, `capsh_<H>.ts`): `./build.sh caps_900.ts && node caps_900.js`:
```
N=700 x2  keys [info,item,variable] endpoints 1400 … items in file 1400
N=900 x2  keys [ 'info' ] endpoints 1800 examples 1800 removed [ 'the rest of the collection was not copied (too large)' ]
          reported endpoints 1800 items in file 0 bytes 276
headers=3, 2000 endpoints → items in file 2000 (fits)
```
With several statuses per endpoint, the limit is hit at a few hundred endpoints.

**Impact.** It fails closed, so nothing unsanitised is written. But the user or agent is told "1 800 endpoints"
and an empty collection is linked for the team. With `unmatched: 'fail'` the app then fails every request to those
origins.

**Fix.** Give the trusted builder's own output a budget sized to its limits (2 000 endpoints × 20 examples). Or run
`sanitisePostman` per endpoint item and count what survives. In either case, if it is exceeded, throw (or drop
whole endpoints with a `skipped` line) instead of returning a truncated document, and compute `endpoints` /
`examples` from the final text.

### 13 (LOW) A huge client id freezes the integer id counter

**Where.** `store.ts:806` (put) and `:980` (create) set `st.next = Math.max(st.next, raw + 1)` for any integer
`raw`. At 2^53 and above, `n++` no longer changes `st.next`. `newId` (`store.ts:758-766`) then finds its one candidate
taken, loops 1 000 000 times and returns `` `${idBase}-${Date.now()}` ``, a **string** in an `integer` resource. Two
creates in the same millisecond would get the same id, and the second would replace the first in the index while
both stay in `records`. A snapshot's `next` (safe integers are accepted up to 2^53 − 1) has the same effect.

**Reproduction.** `B/ids.ts`.
```
create 1e300 → 201 {"id":1e+300,"name":"big"}
next create → 201 {"id":"users-1795171211536","name":"next"} 7 ms
after 2^53+1 create: 201 {"id":"items-1795171211552"}
create after MAX_SAFE put {"id":9007199254740992} {"id":"q-1795171211566"} 7 ms
```

**Impact.** This is correctness, not a security bug. One POST with a big id, from the app, a test or an agent's
`put`, makes later ids strings (Dart `as int` throws), and each create costs about 7 ms of busy loop until Reset.

**Fix.** Accept an integer id only when `Number.isSafeInteger(raw)` and `raw < 2^53 − 1` for the counter. Treat a
larger one as a client id that doesn't move `next`. When the counter can't advance, answer `507`/`409` with a
problem line instead of a string id. Cap `next` in `validateSnapshot` the same way.

### 14 (LOW) Store answers carry headers the static rule drops; non-Latin-1 values become a hidden 500

`ResourceStore.headersFrom` (`store.ts:843-860`) copies every string header of the operation's example. It skips
only framing headers and `__proto__`. It doesn't check names or values. `core.ts` `handle` passes them on as they are
(`core.ts` store branch, `return {status: a.status, headers, …}`), while `toRules` `cleanHeaders` and `core.ts`
`render` drop invalid ones. The proxy is the backstop: `scriptHeaders` refuses the whole answer.

```
$ cd packages/extension && npx vite-node …/review16/A/store-headers.ts
store answer headers: {"content-type":"application/json","x bad name":"1","x-crlf":"a\r\nset-cookie: s=1","x-total-count":"1"}
static rule (toRules cleanHeaders) keeps: {"content-type":"application/json"}
proxy refuses the answer → 502: answer.headers has an invalid header name: "x bad name"
```
No header injection happens (CR/LF never reaches the wire). The outcome is that one bad header in a collection turns
every list / create / read of that resource into a 502, with an error the user can't easily connect to the header.

Values outside Latin-1 (e.g. `x-message: مرحبا`, or `Ā`, `\x01`) pass `scriptHeaders` and `cleanHeaders`
(both only check `\r \n \0`). Node then refuses them inside mockttp (`handler-probe.ts`):
```
== ctl-x01 / unicode
HTTP/1.1 500 Server error
TypeError [ERR_INVALID_CHAR]: Invalid character in header content ["x-a"]
EX http://h.test/ctl-x01 mocked 200  []
```
The app gets a 500 carrying Node's error text, but the exchange is recorded as a successful 200 mock. That is wrong
evidence for the panel, for agents (`assert`-style tools) and for the user. The same is true of plain mock rules in 0.15.

Fix: in `headersFrom`, use the same filter as `toRules` `cleanHeaders` (`TOKEN` name, no CR/LF/NUL). Have the proxy's
`scriptHeaders` and `mockProblem` (and `checkHeaderValue` in `validate.ts`) refuse what Node refuses: anything outside
`\t\x20-\x7e\x80-\xff`, or `http.validateHeaderValue` in a try. Alternatively, have `localAnswer` validate the headers
and fail with `localFailure`, so the record matches the wire.

### 15 (INFO) Smaller items

#### 15a. 1xx statuses and hop-by-hop headers in made-up answers

From `handler-probe.ts`:
```
== status-101           HTTP/1.1 101 Switching Protocols / connection: upgrade / content-length: 1 → [timeout] (socket held)
== status-100           HTTP/1.1 100 Continue / content-length: 1      (sent as the final answer)
== status-204-body      HTTP/1.1 204 No Content / content-length: 18
== conn-upgrade (200)   connection: upgrade / upgrade: websocket / keep-alive: timeout=1 → [timeout]
```
This hurts only the app's own request, and it was the same for 0.15 mocks (collections accept 100–599). Fix: limit
made-up answers to 200–599 (or let 1xx collection examples fall back to 501). Drop `connection`, `keep-alive`,
`upgrade`, `trailer`, `te` and `proxy-*` from made-up answer headers, as rewrites already do.
For 204 / 304 / HEAD, frame with no body.

#### 15b. Note flattening

`handler-flow.ts` `oneLine` replaces only `\s*[\r\n]+\s*`. It does not strip other control or bidi characters, which
`limit.ts` `cleanLine` and `store.ts` `oneLine` do. Every current host note is already clean, so nothing leaks today.
Using the same character class in the proxy would make the guarantee hold for any future handler, and for the sidecar
and CLI hosts.

#### 15c. Store and snapshots

- **`__proto__` resource name** (`B/protoname.ts`): a collection path `/__proto__/:id` is a resource. `counts()` and
  `dump()` assign `out['__proto__'] = …` on plain objects (`store.ts:362, 375`), so the resource disappears from
  counts and snapshots, and `dump().resources` gets an array as its prototype. There is no global pollution
  (`({}).polluted` stays undefined). Use null-prototype objects or `setKey`.
- **Number precision** (`B/precision.ts`): example `{"tweetId":1234567890123456789,"price":10.50}` → store answer
  `{"tweetId":1234567890123456800,"price":10.5}`. §22.14 documents this for the panel editor only, but it also changes
  the **app's** answers compared with the 0.15 static mock. Document it, or keep the raw example text for records
  never written.
- **Case-folding false refusal** (`B/paths.ts`): `.VSCODE/` on macOS → "goes through a symbolic link", because
  `realpathSync.native` returns the on-disk case and the check compares it with `.vscode`. It is safe but the message
  is wrong. Compare with `path.relative`-style case-insensitive equality on darwin / win32, or say "differs in case".
- Snapshot `scope` values (parent ids from URLs) and the `blanked` paths (which can hold map-like keys such as
  e-mails) are written or returned unredacted.
- `restoreRecords` (`agent/tools/store.ts`) keys stored records by id across **all** parents. For a nested resource,
  `[redacted]` in a `put` takes the value of the last parent's record with that id, not the parent the agent meant.
  The agent never sees the value, so this mixes data and doesn't leak it. Restore from the record's own scope.
- `core.ts:1912-1925` takes path parameters from `new URL(req.url).pathname`, which applies dot segments (`%2e%2e`),
  while the rule matched the raw URL. `POST /users/%2e%2e/orders` creates in the `''` parent scope. The effect is on
  data only.
- A nested resource with a seeded record materialises the seed into every parent written to. After `5000 / seed size`
  parents, every write answers `507 store_full`. That is by design, never silent, but worth a line in the docs.

#### 15d. Traffic and Update example

- `collapseSiblings` rebuilds `prefix(s, i)` for each segment index, which is O(segments²) per URL.
  `C/caps.ts` (original version): 5 URLs of 2 000 / 4 000 / 8 000 segments take 102 / 383 / 1 507 ms. URLs come
  from the user's own app (and Node caps the request line near 16 KB), so this is not practical as an attack.
  Precompute prefixes once per sample.
- `copyIn(r.text, \`${name}.json\`, …)` (`core.ts:1521`): a fake backend named "Bruno" (or "x/bruno") becomes
  `bruno.json`, and `isBrunoLinkFile` refuses it with "A Bruno collection is a folder…". Check `isBrunoLinkFile` on the
  real link path only, or pass the slug.
- Internal host names stay as `baseUrl` values (with the port; userinfo is dropped by `URL.origin`), and so do
  response headers such as `X-Backend-Server: db-internal-01.corp.local`, `Server` and `X-Powered-By`. This is
  accepted in §23.7. Consider dropping `server`, `x-powered-by`, `x-backend-*` and `x-upstream*` with the noise
  headers.
- `mock_from_traffic` with `replacePersonalData: false` (an agent with read-write access) writes real personal data
  into a collection linked for the team. Copilot shows a confirmation; for MCP clients only the client's own tool
  prompt stands. This follows REVIEW-15 #4 (agents write the committed file). Consider forcing `true` for agents, or
  stating it in the confirmation.
- Update example with a link file that is a symlink inside the workspace: `collectionText` resolves `rel` from the
  realpath, so the write replaces the target file, while the modal and diff title name the link. It stays inside
  the same workspace folder (another root gives `rel` undefined, which is copy-only). Show the real path in the
  modal when it differs.

#### 15e. Token randomness

`AuthSessions` uses `opts.random ?? Math.random` (`auth.ts:234`, `:313`). `Math.random` is V8's xorshift128+, so the
next value can be predicted from a few outputs. Seeded / fixed mode gives `fi.1`, `fi.2`, … (the CLI default). These
tokens only open the local fake backend, which is reached through the proxy that already sees the traffic, so this is
not a boundary today. Using `crypto.randomBytes(24).toString('base64url')` in random mode costs nothing and stops the
pattern from being copied somewhere it matters.

#### 15f. The JWT `sub` is a hash of the e-mail

`subjectOf` is `u_` + the first 16 hex characters of `sha256(identifier)` (`auth.ts:195-198`). It has no salt, so
common or known e-mails can be reversed with a dictionary. It goes into every JWT the app receives. The panel already
shows the login request body, and agents get JWT-looking values redacted when redaction is on, so it reveals little
new. Use an HMAC with a per-process random key, or a per-session random `sub`, if the stable subject isn't needed
across restarts.

#### 15g. Bruno walk: a gap between check and use

`walkBruno` realpath-checks each entry (`core.ts:666-671`). `readBruno` reads `f.real` later with `fs.readFile`,
which follows links (`core.ts:715`). A file replaced by a symlink between the two steps is read, so its text could end
up as a request URL or example. This needs another local process writing into the workspace while it reloads, which is
outside the cloned-repo threat model. Fix: `lstat` again (or open with `O_NOFOLLOW`) at read time, and compare
`ino` / `dev` with what the walk saw.

## Checked, fine

### Proxy `handler` action, rule index and path trie (areas 1, 2)

- **Nobody else can author a `handler` rule.** `validate.ts:321-323` refuses it (also as a sequence step, through
  `validateAction(…, inStep)`, and the proxy's `NOT_A_STEP` has `handler`). Every path to the proxy's rule list
  validates first: panel `applyRules` → `validateRules` (`controller.ts:846`); agents → `insertRule` → `validateRule`
  (`agent/context.ts:122`); the shared file → `rules/file.ts:181`; saved workspaceState → `validateRules`
  (`extension.ts:206`); the sidecar (`sidecar/src/host.ts:453`, `sharedRules.ts` with `validateRule`); CLI rule files
  (`cli/src/rules.ts:167`). `handlers.ts:422` "copy as rule" validates `toRule`'s mock. Collection rules travel
  separately (`setCollectionRules`) and are not in `getRules()`, so a round trip through the panel can't revive or
  change one. Handler ids are `collection:<linkId>` and are registered only by the host.
- **The in-flight cap never leaks.** `inFlight.delete` runs in `finally` for value, throw, sync throw, reject,
  timeout and abort. Probe: 10 handlers that never settle and ignore the signal (cap 5, timeout 300 ms), then one good
  call → `200 OK`. 10 clients that leave after 50 ms, then a good call → `200 OK`. `stop()` aborts every waiting
  call and clears the map. A handler that ignores its signal is dropped after `timeoutMs` (default 10 s, at most 60 s).
- **Invalid answers become a one-line 502 with state `error`.** Probe: a non-string body, a string status, `{fallback:
  true}` with no fallback, a 100 000-character multi-line throw (clipped to 300 characters on one line), and a
  hanging handler ("timed out after 300 ms"). A non-text note is refused and a long note is flattened and clipped.
- **No header injection.** CR / LF / NUL in values and invalid names are refused by `scriptHeaders` (`HTTP_TOKEN`). A
  `__proto__` header name is harmless (`Object.entries` of a JSON-parsed key).
- **Framing is the proxy's.** `frameBody` deletes `transfer-encoding` and sets `content-length` from the encoded body.
  Probe: `transfer-encoding: chunked` + `content-length: 999` → `content-length: 5`. `Content-Length` and
  `content-length` together, or an array value → one correct `content-length: 3`. `content-encoding: gzip` really
  gzips. An unknown encoding is dropped and the body is sent plain.
- **Caps hold.** Body ≤ 5 MB (`scriptBodyText`, UTF-8 bytes). Status is an integer 100–599 (see #15a for 1xx).
  `delayMs` is 0–60 000, finite and rounded. The fallback is checked as a mock at `setRules` (`handlerProblem` →
  `mockProblem`), and an invalid one makes the rule refused, never matched. The request body handed to the handler is
  the bounded decoded body (`truncated` past 5 MB). It is a copy, as are the headers.
- **Routing.** `handler` is answered locally (`forwards()` excludes it, `intercept-proxy.ts:2200`), on the buffered h1
  route. It is not in `GRPC_ACTIONS` / `WEBSOCKET_ACTIONS`. A CORS preflight is answered locally without calling the
  handler (`intercept-proxy.ts:1771`). A client gone during the call or the delay → `close`, and the result is dropped.
- **Rule index: no missed rule found.** `index-fuzz.ts` has its own grammar: schemes in any case, `ftp`, authorities
  with `:443` / `:0443` / `:` / userinfo / `[::1]` / trailing `.` / `%2e` / Kelvin `K` / long `ſ`, and path segments
  `%2F` `%2f` `.` `..` `é` `e%CC%81` `ß` `İ` `K` `ſ` `;` `*` `\` `//`. Tails are `?` `#` `/?` `//x` `/./` `/../`.
  Globs have random `*` insertions. Regexes are random pieces (`\/` vs `/`, `\/?`, `\/+`, `\/*`, `[\/?#]`, `[/?#]`,
  `(?:[\/?#]|$)`, `(?:\/|\?|#|$)`, lookaheads, `\x2f`, `/`, `[]`, `[^]`, `\b`, `(?::443)?`, named groups,
  backrefs, `{0}`, top-level `|`, `.*^`) and regexes derived from real URLs. Flags are drawn from `igysdmu`, and
  methods include lower case, `*` and none. For every request it checks that **each rule whose `baseMatches` is
  true is among `ruleCandidates`** and that candidates are strictly ordered. Three configurations: full index, a
  starved trie (3 nodes), no trie. 7 seeds (1–4 and 11–13): about 161 million rule × request checks and
  1.69 million matching pairs, **0 misses, 0 unordered**. For seeds 11–13, about 64 000 of the matches were on
  indexed rules, about 21 600 on deep trie keys and about 16 900 on `exact` keys. The other inputs agree with this: CONNECT matching (`connect-flow.ts:419-426`) and the gRPC relay pass
  the same string to the index and the matcher, so a URL form (origin-form rebuilt by mockttp, authority-form, plain
  tunnels) can't differ between them.
- **The index's reasoning holds for these points.** Without `u`/`v`, `i` folds only ASCII letters (non-ASCII → ASCII is
  excluded by Canonicalize), and `m`/`u`/`v` go to the wildcard list. Classes are skipped by JavaScript's rule.
  Every `(?:…|…)` alternative must start with a terminator, an empty alternative fails, and `{` after a terminator
  fails. Ranges such as `[#-?]` fail because `-` is not a terminator. Past the 20 000-node cap or at depth 16, a rule
  sits open at the deepest node reached (a superset). Nodes have unique ids, so the merge-cache key
  (node id × ended × method) names exactly the lists that were pushed. `compileRules` uses the same trimmed and
  simplified source for the key and for the `RegExp`.
- **`compileRules` / lookup cost is bounded** (`compile-cost.ts`). 2 500 regexes with 16 segments each followed by
  8-deep nested groups: compile 23 ms. 2 500 regexes with 1 500-way alternations (4.5 KB source; unsafe, so they never
  match, but they are keyed): 152 ms. 2 500 chains of 500 optional groups: 28 ms. 50 000 unique 17-segment globs: compile
  74 ms, with the trie capped at 20 000 nodes (the rest sit open at the root), and a lookup at 0.35 ms. `terminatorAt` recursion is
  capped at depth 8, and the merge cache at 4 096 lists / 262 144 positions.

### Store, snapshots, agent store tools, shared-file `stores` (areas 3, 4, 10, 11)

- **Prototype safety of records:** `cleanJson` drops `__proto__` and builds null-prototype objects, and `setKey` uses
  `defineProperty`. A create body `{"id":"__proto__","__proto__":{"polluted":1},"constructor":{"prototype":{"x":1}}}`
  is stored as `{"id":"__proto__","constructor":{…}}`. `GET /p/__proto__` reads it back (the index is a `Map`), and
  `({}).polluted` / `({}).x` stay `undefined` (`B/ids.ts`).
- **Caps enforced on every write path:** `create`, `change`, `putOne` (put / replace), `generate`, `load` and
  `writeScope` (materialising a parent) all call `fits` or check count and bytes before inserting. `generate` and
  `replace` are capped at 5 000 by both the schema and the host. Depth is 32 via `cleanJson`. `items()` caps 1 000 per
  page and 5 MB.
- **Query cost:** the host passes at most 100 query pairs (`core.ts:1927`). At 5 000 records / 30 MB, sorting by a
  6 KB object field takes 37 ms, 3 000 repeated filter values 15 ms, the full list cut to 5 MB 4 ms, and the panel
  filter scan 20 ms (`B/cost.ts`). `posInt` caps page numbers at 9 digits. Ids over 100 characters → `idText`
  undefined → 404 / 400. Scope values over 100 characters → 404.
- **Snapshot paths on a real file system** (`B/paths.ts`, `fs.realpathSync.native`): `.vscode/flutter-intercept` as
  a symlink out of the project is refused. A dangling `snapshots` symlink is refused (`mkdir` EEXIST/ENOENT, nothing
  written outside). A symlink to a directory inside the project is refused. A dangling symlink at the file is replaced
  by the atomic `rename`, and the outside target is not created. A hard link to an outside file is read on load (not a
  traversal; git doesn't keep hard links), and on save the rename breaks the link: the outside file keeps
  `ORIGINAL`. `linkId` and names are `^[a-z0-9-]{1,40}$` everywhere, from the shared file (`parseStoreLinks`), agents
  (schema) and the host (`snapshotRel` re-checks), so no `..`, `/`, Unicode or case tricks. The 32 MB cap is checked
  by `stat` before reading and on the bytes. The 50 cap is checked on save. A listing past 50 is cut.
- **Load validation:** the whole file is checked before anything changes (`version`, shapes, `__proto__` names, scope
  keys, sizes, duplicates, ids). A broken snapshot changes nothing, and `startsFrom` must name an existing snapshot.
- **Agent access:** `set_store` and `store_snapshot` are in `WRITE_TOOLS` (blocked read-only) and `DESTRUCTIVE_TOOLS`
  (MCP). `get_store` doesn't materialise scopes or write. The `set_store` Copilot confirmation says "Saved in
  `.vscode/flutter-intercept.json`" for `scope: 'team'` and "In memory only" for data. Data patches with `scope` are
  refused. Agents can write only the `stores` entry (enabled, snapshot name, idField / off, auth settings, dynamic)
  and snapshot files under `.vscode/flutter-intercept/snapshots/<id>/`. They can't write outside the workspace.
- **`[redacted]` round trip:** `restoreRedactedJson` restores only at the same key path from the stored record with
  the same id, and the value stays under the same key, which the same rule redacts again. A filter under redaction is
  matched against the redacted view (no oracle). There is no sort parameter in `get_store`. `fields` projects after
  redaction, and `shape` is built from redacted records. `collection.store.itemId` in exchange views goes through
  `redactSecretValues`.
- **Shared-file `stores`** (`link.ts:260-313`): at most 20 entries and 100 resources each. `collection` and `snapshot`
  are checked by regex, `idField` refuses `__proto__` and control characters, and `auth` keys are allow-listed (no
  password or token field). `ttlSeconds` is 60–86 400, and `dynamic` and `protect` are enums. Resource maps are
  null-prototype. Unknown entries are kept as written and never applied. All a hostile file can do with settings is
  choose a snapshot of the same collection (see #10), switch sign-in simulation on (a visible team setting), or point
  `idField` / `off` at resources. `withStoreEntry` writes keys with `defineProperty`.

### Fake backend from traffic, Update example (areas 5, 6)

- **Headers that carry credentials.** `Authorization` (Bearer, Basic, other schemes) becomes Postman `auth` with empty
  `{{variables}}`. Request headers `Cookie`, `Proxy-Authorization`, `X-Api-Key`, `X-Session`, `X-Device-Token`,
  `Ocp-Apim-Subscription-Key` (32 lowercase hex, caught by `sanitisePostman`) and `X-Signature` are blanked.
  Response headers `Set-Cookie`, `WWW-Authenticate`, CORS, CSP, HSTS, dates and trace ids are dropped. JWT-valued
  custom headers are dropped (`leak.ts`).
- **URLs.** Query values are always blanked (names kept), in the item URL and in `originalRequest`. Userinfo in the
  request URL is removed by `URL.origin` (`baseUrl2` = `https://internal.api.shop.example:8443`), and in body URLs by
  `cleanUrl`. `X-Amz-Signature`, `X-Goog-Signature`, `sig` and `token` in absolute URLs inside bodies are blanked.
- **JWTs.** A JWT anywhere in a JSON value, an array element or text becomes `JWT_PLACEHOLDER`. A JWT as a path
  segment becomes a param with an empty value. A base64 blob of a token JSON (≥ 32 mixed characters) is blanked as
  opaque.
- **Request bodies.** Multipart and binary request bodies are left out (`binaryRequest`). Request JSON bodies use
  the broader `isSensitiveField` rule as well. Request bodies over 64 KB are left out. Answers over 1 MB are left out
  rather than cut.
- **File location, never overwrite.** `slugId` limits the stem to `[a-z0-9-]{1,34}`, so `..`, `/`, Unicode and
  reserved names can't escape. `freeCollectionPath` never reuses a taken name, including a dangling symlink
  (REVIEW-15 #8). `writeWorkspaceFile` checks the target with `within` and `ensureDirInside`, and `atomicWrite`
  renames over the target. The dry run computes the same `file` without writing.
- **Origins.** Agent-chosen `origins` must have answered in the traffic (refused with the list, `cleanLine`d). The
  link limit is checked before writing. A `url` glob is ≤ 8 192 characters and compiled with the proxy matcher.
  `recording` ids are validated by `fileOf` before any fs access.
- **Odd exchanges.** `collectionFromTraffic` never throws on them (non-string method / url, missing bodies, own-key
  header reads). The 20 MB cap drops the largest examples first (`caps.ts`: 40 × 1 MB → 20 examples, 20 030 717
  bytes, one `skipped` line). The 2 000-endpoint cap gives a `skipped` line.
- **Agent outputs.** The dry run returns counts, file name, resource names, `skipped` and `removed` only (#11 aside).
  `update_collection_example` returns only the diff of the old and new example bodies through `redactBodyText` when
  redaction is on. It never returns the file or `edit`. Errors go through `ag.scrub`. `applyExampleUpdate` is
  reachable only from the IDE's modal (`service.ts:503-527`). The `ExampleUpdate` object, including `edit.rel` /
  `edit.after`, never comes from the webview or an agent.
- **Splice.** `splice.ts` (`C/splice.ts`, `C/bytes.ts`):
  - a duplicated `item` / `response` key and an escaped key (`"body"`) are resolved like `JSON.parse` (the
    last one), and `JSON.parse` of the result reads the new value;
  - the BOM is kept, and the prefix and suffix bytes are identical (CRLF, tabs, `é` escapes, `1.0`);
  - the new value is escaped (` ` written as an escape, quotes escaped);
  - comments and trailing commas are refused (copy-only), never corrupted;
  - depth ≤ 512;
  - the merge values come from a sanitised sample, and new key names go through `stringLiteral`.
- **TOCTOU.** `applyExampleUpdate` re-reads the file under the core's serial queue, compares the SHA-256 of the
  text (BOM included) with the preview's, and checks that the link's folder and file are unchanged. The write goes
  to the `rel` computed at preview time. A change between the hash check and the rename would need a write within
  the same tick. OpenAPI YAML, generated and `$ref`'d examples are copy-only. A realpath outside the folder gives
  `rel` undefined, which is copy-only.
- **Diff documents.** They are served from memory (`flutter-intercept-example:` scheme, capped), with no temp file
  in the project. The clipboard copy-only path copies only `newBody` (sanitised).

### Light sign-in, body examples, dynamic values, new readers (areas 7, 8, 9)

**Sign-in**
- `loginIdentifier` reads only allow-listed names (`email`, `username`, `login`, `phone`, …, `user`), at the top
  level or in a `user` object, and keeps only a hash. A `__proto__` key gives `undefined` (`D/proto.probe.ts`). The
  auth path itself never reads `password`. The one designed exception is §24.2: a body example that discriminates on a
  password value compares it with the file's own value.
- `StoreStatus.auth` holds settings plus a session count (`core.ts:2039-2053`). The agent `get_store` / `set_store`
  return the same, with keys through `endpointKeyView` and problems through `ag.text`.
- A settings patch with unknown `auth` fields is refused ("a password or token is never set here",
  `core.ts:2155`). The overlay holds `enabled` / `ttlSeconds` / `protect` only. No log line includes a body.
- **JWT**: `alg: none`. The example's claims are copied without `sub` / `iat` / `exp` / `nbf` / `jti` / `__proto__`,
  into a null-prototype object. Over 4 KB, the token falls back to the fixed claims. `jwtClaims` refuses tokens over
  4 KB. A `{"__proto__":{"admin":true}}` example claim doesn't pollute (`D/proto.probe.ts`).
- **Sessions**: at most 1 000, oldest dropped with one note. A refresh spends the old refresh token. An access token
  given as the refresh token is refused (only `byRefresh` is looked up). `expireAll` keeps refresh tokens, by design.
  Logout drops both.
- The Bearer regexes (`auth.ts:378`, `core.ts:1869`) are anchored and linear.

**Body examples**
- Bodies stay in the host. Nothing outside `core.ts:839` reads `MockExample.request` / `requestBody` (grep across
  `agent/`, `ui/`, `service.ts`).
- `byBody` exposes field names only, through `cleanLine(…, 100)`, at most `MAX_BODY_FIELDS` (`core.ts:1209`).
- Matching is bounded: depth 8, 32 leaves, `jsonEqual` depth 64, request ≤ 1 MB. `parseFormBody` builds
  null-prototype objects (`__proto__` / `constructor` stay ordinary keys).

**Dynamic values** (`D/dynamic.probe.ts`)
- Inside JSON strings, values containing `"`, `\`, a newline, NUL, U+2028 and `</script>` all render to valid JSON.
  So do placeholders after `\"` and `\\`, inside keys, and next to stray `{` / `}`.
- Outside a string the value goes in raw, as documented in §24.3. The approval hash covers every link variable
  (`core.ts:961-964`), so changing a variable limits answers again: no way around the approval.
- Rendering is linear:
  - 5 MB of `{{` takes 0 ms;
  - 5 MB of unknown `{{a}}` takes 21 ms;
  - 4.5 MB of `{{$guid}}` takes 31 ms (capped at 1 000);
  - 1 000 × 100 KB of variables goes over the cap and is returned unchanged with a problem line.
- Rendered header values with CR / LF / NUL, or over 8 KB, are dropped. Limited headers (Location, Set-Cookie,
  Content-Type, …) are never rendered (`core.ts:1778-1783`). Example headers with CR / LF from Bruno (a lone `\r` in
  a line) or Insomnia are removed by `cleanHeaders` / `toRules` (`D/brunocr.probe.ts`).
- Environment-file values never reach `{{var}}`: `dynVars` is Postman's own `variable[]` plus link variables
  (`core.ts:393-398`). For OpenAPI, Swagger, Insomnia and Bruno it is link variables only. The test fixture's
  `{{token}}` from the environment is not rendered.

**Swagger 2.0** (`D/readersdos.probe.ts`, `D/swhost.probe.ts`)
- A 4 MB example aliased by 2 000 operations: 84 ms, 167 MB RSS.
- An alias DAG 12 levels deep: 103 ms.
- A `$ref` cycle is detected with a problem line. `__proto__` definitions are safe.
- A `host` with userinfo is cut to the origin. Hosts with CR / LF, `/`, `#` are refused. `*.test` is not mocked.

**Bruno** (`D/readersdos.probe.ts`, `D/brunoenv.probe.ts`, `D/brunowalk.probe.ts`)
- An 8 MB hostile `.bru` (unclosed nested blocks and `'''`) parses in 48 ms. 4 MB of unclosed headers takes 37 ms,
  and a 5 MB env value 188 ms.
- On a real temp folder:
  - a symlinked `.bru` and a symlinked dir are skipped, each with a line;
  - a symlinked parent of `bruno.json` is refused;
  - `.hidden/`, `.env` and a FIFO named `fifo.bru` are not read.
- `vars:secret`, `auth:*`, scripts and tests are never read.
- Folder watchers are capped at `MAX_WATCHED_DIRS` (`service.ts:180-181`).
- `__proto__` as a folder, an env name, keys or headers is safe.

**Insomnia**
- Private sub-environments are skipped (v4 `isPrivate`, v5 `subEnvironments[].isPrivate`).
- Nunjucks `{% … %}` and filters become `{{$tag}}`, never evaluated. `{% response … %}` is not followed.
- `__proto__` used as `_id`, parent, env keys, parameter / form / header names is safe; no prototype pollution
  (`D/proto.probe.ts`).

## Verification of the MED findings, and suggested order

I re-ran the reproductions of #1 (`A/redos3.ts`: 3 283 ms / 3 304 ms on 25 characters, both `isSafe true`), #2
(`verify-d1.ts`, `normaliseTemplate` alone: 50 KB 663 ms, 100 KB 2 695 ms, 200 KB 10 882 ms), #4
(`D/loginstore.probe.ts`, both cases) and #7 (inline: 32 / 64 / 128 KB → 249 / 912 / 3 848 ms; with the lookbehind
`(?<![A-Za-z0-9_-])eyJ…` 0 / 1 / 1 ms) myself, and read the code for #3 (`jsonText` → `undefined` → `text()`).

Suggested order: #1 and #2 (a cloned repo freezes the host on open or on first matching request), #3 and the shared
secret predicate (#4–#6, the files the panel tells the team to commit), #7, #8 + #9, then the LOW items. Each fix
should come with the probe's case as a unit test (the probes name the exact inputs).

## Fixes (all findings fixed, 2026-11-20)

Each fix was checked with the reviewer's own probes (before / after numbers in the fix rounds' reports) and has a
regression test. Fix rounds: F1 (proxy), F2 (one secret check, traffic, snapshots, sign-in vs store), F3 (readers,
environment masking, store limits, headers), plus the lead for the agent URL half of #9.

| # | Fix | Where | Tests |
|---|---|---|---|
| 1 | Character classes read as JavaScript reads them (`[]` empty, `[^]` any); one scanner shared with the rule index; `[\s\S]` / `[^]` are wide atoms. The reviewer's regexes are refused and run in 0 ms | `proxy/src/rules.ts`, `rule-index.ts` `scanClass` | `regex-class.test.ts` (incl. a differential test against `RegExp` over 50 000+ checks) |
| 2 | `normaliseTemplate` linear; Insomnia / Bruno variable values over 8 KB dropped. 200 / 400 KB exports: 11.4 s / 45.7 s → 1 ms | `mocks/viaPostman.ts`, `insomnia.ts`, `bruno.ts` | `mocks.review16f3.test.ts` |
| 3 | Recorded bodies read past a BOM / XSSI prefix, NDJSON line by line; an unparsable JSON-ish body holding a secret-named field is left out; Update example refuses what isn't plain JSON | `mocks/fromTraffic.ts`, `core.ts` | `mocks.review16f2.test.ts` |
| 4 | A login / refresh `POST` is never a store operation; secret-named fields are stripped from every stored record | `mocks/core.ts` `handle()` | `mocks.review16f2.test.ts` |
| 5 | One shared secret check (`mocks/secrets.ts`) at least as wide as the agent redaction, used for snapshots, traffic, copies and agents | `mocks/secrets.ts`, `snapshot.ts`, `sanitise.ts`, `agent/redact.ts` | `mocks.review16f2.test.ts`, `mocks.snapshot.test.ts` |
| 6 | The traffic sanitiser uses the shared check (plurals, `sid`, codes, headers, schemes, key prefixes, PEM, URLs in text, JSON in strings) | `mocks/fromTraffic.ts` | `mocks.review16f2.test.ts` |
| 7 | Linear JWT regex (lookbehind) in both places; 1 MB hostile body ≤ 50 ms (was 15–28 s at 256 KB) | `mocks/secrets.ts`, `agent/redact.ts` | `mocks.review16f2.test.ts` |
| 8 | Environment values masked once at resource detection: names, store keys, notes, snapshot keys, paths | `mocks/resources.ts`, `core.ts`, `store.ts` | `mocks.review16f3.test.ts` |
| 9 | Insomnia / Bruno return the chosen environment's values to the host for masking; agent URLs hide Telegram bot tokens and Slack / Discord webhook paths | `insomnia.ts`, `bruno.ts`, `viaPostman.ts`, `core.ts`, `agent/redact.ts` | `mocks.review16f3.test.ts`, `agent/redact.test.ts` |
| 10 | Empty snapshot scope entries count as records, scope text counts against the byte limit; 29.6 MB snapshot refused at parse (was +942 MB heap) | `mocks/snapshot.ts`, `store.ts` | `mocks.review16f3.test.ts` |
| 11 | `%40` e-mails, e-mail / phone keys, phone numbers and short tokens in paths replaced; `removed` shows kinds, never the value | `mocks/fromTraffic.ts` | `mocks.review16f2.test.ts` |
| 12 | The copy sizes its node budget to plain trees; a budget overrun refuses instead of writing an empty file (1 800 endpoints written whole) | `mocks/fromTraffic.ts`, `sanitise.ts` | `mocks.review16f2.test.ts` |
| 13 | An id past 2^53 → `400`; only safe integers advance the counter; counter used up → `507` | `mocks/store.ts` | `mocks.review16f3.test.ts` |
| 14 | Made-up answers: invalid / non-Latin-1 headers → clear `502` recorded as sent (RFC 8187 for `content-disposition` / `link`); store answers drop such example headers; the rule editor refuses them | `proxy/src/answer-headers.ts`, `http-edits.ts`, `mocks/store.ts`, `ui/validate.ts` | `made-up-answers.test.ts`, `mocks.review16f3.test.ts` |
| 15 | 1xx refused and hop-by-hop headers left out of made-up answers; notes flattened for every control and bidi character; `__proto__` resources work; number text kept from seed and app; Bruno files read through the checked descriptor; session tokens from `crypto`; keyed JWT `sub`; snapshot scope values redacted; `collapseSiblings` linear; agents can't turn personal-data replacement off | proxy, `mocks/*`, `agent/*` | `made-up-answers.test.ts`, `mocks.review16f2.test.ts`, `mocks.review16f3.test.ts` |

Known limits kept: number text is not kept inside saved snapshot files, panel / agent views or the list wrapper's own
numbers; `fromTraffic` and the agent redaction treat `session` / `pass` as secret whatever the value (they blank more,
never less); personal data beyond e-mails, phones and addresses (names, national ids, IBANs) is left to the review
note in the dialog.
