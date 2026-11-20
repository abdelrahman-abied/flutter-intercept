# Review 15: v0.15.0 — mock from a collection

Independent security review of the uncommitted 0.15.0 working tree on `main`, on top of 32943ec (0.14.1). It covers
CONTRACTS §21, including the §21.12 list and the §21.13 / §21.14 notes. The sidecar, the IntelliJ plugin and the CLI
were being changed by another owner during the review. They are not covered.

Scope:
- model and parsers: `src/mocks/**`, which is `types`, `link`, `yaml`, `detect`, `postman`, `environment`,
  `sanitise`, `openapi`, `generate`, `ref`, `toRules`, `core`, `service` and `parsers`;
- shared file: `rules/core.ts` (`collectionLinks`, `saveCollections`, `writeWorkspaceFile`, `primaryFolderPath`),
  `rules/file.ts` (`serializeSharedFile`), `rules/service.ts`;
- host: `ui/controller.ts`, the six §21.8 handlers in `ui/handlers.ts`, `proxyHost.ts` (`setCollectionRules`), and
  the command wiring in `extension.ts`;
- agents: `tools/collections.ts`, `schema.ts`, `lmTools.ts` (texts and confirmations), `mcp/server.ts` (annotations),
  `instructions.ts`, `types.ts`, `context.ts`;
- webview: `collections.ts`, `CollectionsView.tsx`, the `DetailPane.tsx` banner, and the state changes;
- how collection rules reach the proxy: `packages/proxy/src/rules.ts` (`isSafeRegexSource`, `compileUrl`,
  `compileGlob`, `findRule`), which is unchanged.

Spec: CONTRACTS §21 and §8 (agent access and redaction). Earlier guarantees checked: §12.1 / §12.2 (shared file,
approval, body-file paths), REVIEW-4 #2 (regex safety), REVIEW-6 #4 and REVIEW-13 #2 (the approval reasons for shared
mocks, and the agent mock policy), and REVIEW-14 #6 (one file chooser at a time).

I read the code and ran throwaway probes in the session scratchpad, outside the repo. They are TypeScript files that
import the real sources, bundled with esbuild. One probe also used the built `@flutter-intercept/proxy` (`dist`):
- `e2e.js`: a Postman request `{method: "*", url: "https://*/%%%…"}` whose example is a 302 with `Location`,
  `Set-Cookie`, `Access-Control-Allow-Origin` and `text/html`. It runs through `parsePostman` → `toRules` → the real
  `InterceptProxy`, and `curl -x` sends `POST` to two made-up HTTPS hosts. The probe also runs `approvalReasons()` on
  the same rule;
- `glob.js`: the glob fallback on long percent / non-ASCII segments, with a `*` host and a `*` method, matched with
  the proxy's `findRule`;
- `fuzz.js`: 3000 random Postman / OpenAPI requests (unreserved, reserved, `%`, glob characters, `é`, `ج`, emoji,
  U+202E, NUL, `:id`, `{x}`, `{{v}}`, `{{$guid}}`). 5064 rules came out. Every regex was checked against
  `isSafeRegexSource` and `new RegExp`, and each rule was timed on five 4 KB hostile URLs;
- `yamldag.js`, `coredos.js`: a YAML Postman collection whose folders alias the level below 10 times (an alias DAG).
  It goes through the parsers and through the real `MockCollectionsCore` + `SharedRulesCore` on a real temp folder,
  with a 100 ms heartbeat timer. The second part is one 4 MB example body aliased by 2000 requests;
- `oaamp.js`, `oaref.js`: an OpenAPI document where every path's JSON example is the same 4 MB value, through a YAML
  alias or a plain-JSON `$ref` to `#/components/examples/big`;
- `deep.js`: JSON nested 2 000 000 deep (and 500 000 deep inside a raw request body), YAML nested 200 000 deep, and
  10 000 nested Postman folders;
- `paths.js`: real-fs symlink and path cases for `file` / `environment`, copy-in through a committed directory symlink,
  file and dangling symlinks at the copy target, and a symlinked shared file;
- `proto.js`: `__proto__` / `constructor` as collection variables, link variables, `selected` keys, header names,
  query names, folder names, OpenAPI server variables and schema property names;
- `agentleak.js`, `agentretarget.js`: `get_collection` / `import_collection` / `set_collection` (the real handlers) on
  collections holding credentials, and on a file shaped like an `export_postman` export;
- `sanit.js`: `sanitisePostman` on common credential shapes;
- `problems.js`: OpenAPI problem lines built from file text.

I also ran `npx vitest run test/unit/mocks.` (10 files, 141 tests, all pass). I did not run the integration, device,
agent or webview suites, start an IDE, or touch devices.

Threat model as in REVIEW-1 to REVIEW-14:
- a malicious cloned repo in a trusted workspace;
- a malicious or prompt-injected agent that only has our tools, at the §8 access levels;
- hostile servers;
- other local users and processes;
- the paired LAN device.

New in 0.15.0:
- a **hostile collection / environment / OpenAPI file**, linked from the committed `.vscode/flutter-intercept.json`.
  It is parsed on the extension host when the workspace opens, and it turns into proxy rules **without approval**
  (§21.6);
- agents can now write the committed shared file, through `import_collection` and `set_collection`.

| # | Sev | Finding | Owner |
|---|---|---|---|
| 1 | MED | **Collection mocks skip the approval gate that shared `mock` rules have.** A shared `mock` that redirects (3xx / `Location`), sets `Set-Cookie`, `Access-Control-*`, CSP, `Refresh` or `X-Forwarded-*`, or serves HTML / JS / SVG is held until the user approves it (REVIEW-6 #4, REVIEW-13 #2). The same answer from a committed collection's example goes to the proxy at once. It also doesn't appear in the Rules list. **Probe:** one example → `approvalReasons` gives 5 reasons for the shared-rule form. Through the real proxy, `POST https://accounts.victim.example/…` and `https://api.bank.example/…` both get `302 location: https://attacker.example/collect`, `set-cookie: session=attacker`, `access-control-allow-origin: https://evil.example` and `text/html`. | H (+ lead) |
| 2 | MED | **A small collection file can freeze or crash the extension host.** (a) The Postman walk and the sanitiser have no node budget. A YAML alias DAG of 681 bytes blocks the event loop for 5.5 s, and each extra 77-byte level multiplies that by 10 (about 9 min at 9 levels, days at 12). (b) An OpenAPI example shared by `$ref` (plain JSON) or a YAML alias is copied once per endpoint. A 4.2 MB file gives 1.2 GB for 300 paths, about 8 GB at 2000, which is more heap than the extension host has. (c) Alias-shared Postman bodies make every reload throw `Invalid string length` (+1 GB RSS). The file is linked from the committed file and loads with the workspace. | M1 + M2 + H |
| 3 | LOW-MED | **The glob fallback turns one request into a catch-all.** A segment the regex can't fit (`%`, non-ASCII, `$`, `;` …) becomes `*`, and the glob ends in `*`. `/<long segment>` → `https://host/**` (the whole host), and host `*` → `https://*/**` (every HTTPS URL). Method `*` is a token, so it is accepted and matches any method. Honest case: `/products/منتجات-جديدة-للبيع` → `https://api…/products/**`, which is sorted first and answers `/products/1`. It also keeps the host's other paths away from the real server, even in `passthrough`. | M3 (+ M1, M2) |
| 4 | LOW-MED | **Agents get around the agent mock policy and write the committed file.** `add_mock` refuses HTML / JS / SVG and off-origin redirects (REVIEW-6 #4), and `remove_rule` says "agents can't change that file". The read tool `export_postman` writes recorded responses to `.dart_tool/…/<ts>.postman_collection.json`. `import_collection` links that file, and `set_collection {variable: baseUrl}` retargets it to any origin. **Probe:** `accounts.google.com` gets the recorded `text/html` page and a 302 to `attacker.example`. `add_mock` refuses both. The link and the new origin are written to `.vscode/flutter-intercept.json`, pointing at a gitignored file. | H |
| 5 | LOW-MED | **`get_collection` gives agents credentials and environment values without redaction.** Only `url` goes through `redactUrl`. `key` keeps URL userinfo (`https://admin:Hunter2pass@{{host}}/…`), and `examples[].query` keeps example query values (`access_token: sk_live_…`). An environment value used in a path appears in `url` (a Telegram bot token from the environment file, not caught as opaque because of the `:`). The panel's endpoint list shows the same value. §21.6 says environment values never reach the panel or agents. | H |
| 6 | LOW-MED | **"Copy without credentials (recommended)" keeps common credentials.** It keeps URL userinfo (`https://deploy:pass@…` in a variable or `raw`), `key=` (Google API keys), `sig=` and `code=` query values, and `Ocp-Apim-Subscription-Key` and `X-Functions-Key` headers. It also keeps request `certificate.passphrase` and local certificate paths, which hold user names. The "holds credentials" notice misses the same items, so a file with only these gets no notice. | M1 |
| 7 | LOW | **Problem lines repeat file text, with no length limit and possibly several lines.** `externalValue`, external `$ref` and unknown response-code keys are quoted whole. **Probe:** a 300 KB response key gives a 300 KB problem, and 49 of them make a **14.7 MB `Status`** on every broadcast. `ci:ghp_…@raw.example` and an embedded newline reach the panel, and `list_collections` sends them to agents unredacted. | M2 + H |
| 8 | INFO | Smaller items: the import picker has no one-at-a-time guard (REVIEW-14 #6); "Copy without credentials" on an OpenAPI file copies it unchanged, but the modal says auth settings are removed; the Remove modal quotes the file's collection name with newlines and bidi characters kept; agent / panel variable values aren't checked as URLs (the IDE prompt checks them); pinned or learned passthrough hosts silently drop collection mocks (regexes don't "name the host"); copy-in replaces a dangling symlink at the target name (inside the workspace). | various |

## Details

### 1 (MED) Collection mocks skip the shared-mock approval gate

`rules/policy.ts:86-98, 133-140` (`responseHeaderReasons`, `actionApprovalReasons` `case 'mock'`) holds a shared mock
when it:
- answers 3xx;
- sets `Location`, `Refresh`, CSP, `Set-Cookie`, `Access-Control-*` or `X-Forwarded-*`;
- serves an active content type, or an untyped body that starts with `<`.

These are the REVIEW-6 #4 and REVIEW-13 #2 fixes. Collection rules never go through that check:
- `MockCollectionsCore.buildRules` (`mocks/core.ts:265-283`) → `rules()` (`:346`);
- → `controller.onCollectionsChanged` (`ui/controller.ts:574`);
- → `InterceptProxyHost.setCollectionRules` (`proxyHost.ts:758`), which appends them to what the proxy gets
  (`:848`, `:857`).

The example headers are copied as they are (`toRules.ts:130-137`). Only `content-length` and the other
framing headers are dropped (`postman.ts` `DROPPED_HEADERS`).

§21.6 says collections need no gate because they behave "the same as shared `mock` rules today". They don't: a shared
mock with these headers *is* gated.

Probe (`e2e.js`, real proxy):
```
approvalReasons(the same rule, shared) → answers with a redirect (status 302); sends the app on to
  "https://attacker.example/collect" (Location header); sets a cookie (Set-Cookie: "session=attacker"); changes which
  websites may read these responses (access-control-allow-origin: "https://evil.example"); serves an HTML page
collection rule {method: "*", url: "https://*/**"}   (see #3 for the URL)
curl -x proxy -X POST https://accounts.victim.example/o/oauth2/v2/auth?x=1
  HTTP/1.1 302 Found · location: https://attacker.example/collect · set-cookie: session=attacker; Domain=victim.example
  · access-control-allow-origin: https://evil.example · content-type: text/html
```

What a committed collection can do with no prompt and no entry in the Rules list:
- **Credential forwarding.** It can answer the app's API calls with a 3xx to the attacker. REVIEW-6 #4 found that
  dart:io follows the redirect and re-sends custom credential headers (`x-api-key`) and the query. I didn't re-run that
  on a device.
- **Flutter Web's debug Chrome** (it trusts our CA). It can serve HTML / JS for any HTTPS site, set cookies, and widen
  CORS. With #3, one example covers every host.
- **LAN mode.** The iPhone's system proxy and full CA trust extend this to Safari on the paired device.

**Does it need a §12.1-style gate?** Not for plain data mocks. A collection answering the app's token endpoint with
attacker JSON is exactly what a shared `mock` rule can already do without approval. The gate the project already chose
for *shared mocks* should apply, though:
- collection examples are usually saved from real responses, so `Set-Cookie`, `Location` and CORS headers are common
  even in honest files;
- collection rules are less visible than shared rules: they aren't in the Rules list, and there's no notice when a
  cloned repo starts mocking N hosts.

**Fix (H):**
- Smallest: in `buildRules`, run `approvalReasons()` on every built rule.
  - A collection with any reasons is held, its gated rules or all of them. It shows "needs approval" with the
    reasons, and an **Approve** in its row.
  - The approval is stored in workspaceState under a hash of the link plus the collection file's content (and the
    environment's). An edit or checkout revokes it, as for shared rules.
  - Interim alternative: strip the gated headers from collection answers, send 3xx examples without `Location`, and
    serve active types as `text/plain` until approved. Each with a problem line.
- Optionally, show a one-time notice when a link that this workspace hasn't seen yet starts mocking, naming its
  origins.
- **Tests:** a linked collection with each of the five reasons → no rule carries it before approval. Approve → it
  applies. A file edit → held again.

### 2 (MED) Hostile collection files exhaust the extension host

**(a) Postman: alias DAGs, exponential time.** §21.3 caps the OpenAPI walk at `walkNodes` "so a billion laughs
document stops". The Postman side has no such cap:
- `parsePostman` `walkItems` (`postman.ts:826-910`) only stops on a cycle (`activeFolders`), a depth over 32, or 2000
  endpoints. Empty folders count toward none of those;
- `sanitisePostman` `sanitiseItems` (`sanitise.ts:395-439`) is the same, and it runs on every load for the
  credentials notice (`core.ts:246`);
- a `.yaml` / `.yml` link is parsed as YAML whatever its format (`core.ts:220`), so a Postman collection can use
  aliases.

```
levels (×10 aliases each)  file   parsePostman  sanitisePostman
4                          450 B      3 ms          5 ms
5                          527 B     18 ms         47 ms
6                          604 B    150 ms        380 ms
7                          681 B  1 488 ms      4 502 ms
core.reload (real fs, level 7): 5 526 ms; 100 ms heartbeats that ran meanwhile: 0
```

At 9 levels (835 bytes) that is about 9 minutes; at 12, days. `reload()` is serialised (`core.ts:150`), so the
collections service, the panel's collection messages and agent tool calls all wait too. Every window that opens the
repo hangs again.

**(b) OpenAPI: one example, copied per endpoint.** `formatExplicit` (`openapi.ts:593-608`) writes the example's JSON
text for each endpoint. The walk budget counts one node for a string, so 2000 endpoints that share a 4 MB example (a
plain-JSON `$ref` to `#/components/examples/big`, or a YAML alias) stay far under `walkNodes`, but each one gets its
own 4 MB string:
```
oaref.js (JSON, $ref)   4.2 MB file, 300 paths → 1 258 291 800 chars of bodies, +1 222 MB RSS, 2.6 s
oaamp.js (YAML alias)   4.2 MB file, 300 paths → +1 226 MB RSS, 3.2 s
```
Memory grows linearly, about 4 MB per path. 2000 paths is about 8 GB, which is beyond the extension host's heap: an
out-of-memory crash, then the same again on every restart. I didn't run it to the crash.

**(c) Postman: aliased bodies.** One 4 MB body aliased by 2000 requests is cheap to parse: the string is shared. Then
`signature()` (`core.ts:286`) JSON-stringifies every rule's body (8 GB logically). Every `reload()` / `update()`
throws `Invalid string length` after about 4.5 s and +1 GB RSS. `rules()` still returns the 2000 rules, so the
collection can neither be updated nor reloaded cleanly.

Depth itself is handled (`deep.js`, see "Checked, fine").

**Fix (M1, M2, H):**
- Walk budget in `walkItems` and `sanitiseItems`, shared per document like `touchNode`. Better still, a visited set:
  JSON can't share objects, so an item seen twice is an alias. Skip it with "aliases aren't supported in Postman
  collections".
- Alternatively, read Postman collections as JSON only. §21.3 allows YAML for OpenAPI only.
- A per-collection budget on the **sum** of example body bytes, counted per endpoint and not per value: for example,
  the 20 MB file limit. Over the budget → the rest are skipped with a problem line.
- `signature()`: compare rule ids, matches and a per-entry parse key, not the bodies.
- **Tests:** the 681-byte DAG loads in under 100 ms with a problem line. 300 × `$ref` to a 4 MB example stays under
  the byte budget.

### 3 (LOW-MED) The glob fallback makes catch-alls

When the regex would be over 256 characters, `toRules` falls back to `globFor` (`toRules.ts:109-113, 243`):
- a param, and any literal with a character outside the unreserved set, becomes `*`;
- `*` is appended to the end.

The proxy's glob `*` crosses `/` (`rules.ts` `compileUrl`). In the regex form each such character costs
`(?:x|%XX)`, about 10 to 12 characters. So a short segment of `%`, `$`, `;` or non-ASCII characters overflows the
regex, and then matches anything:
```
glob.js
https://api.shop.example/%%%… (30)    → GET https://api.shop.example/**   matches /login, /anything/else?x=1
https://*/%%%… (30)                   → GET https://*/**                  matches every HTTPS URL
method "*" + the same                 → * https://*/**                    matches POST https://oauth2.googleapis.com/token
https://api…/products/منتجات-جديدة-للبيع → GET https://api…/products/**  matches /products/1, /products/a/b/c
```

Contributing causes:
- the host `*` is accepted: `postman.ts:511` only refuses whitespace and `/?#`, and `new URL('https://*')` has host `*`;
- `TOKEN` (`toRules.ts:34`) accepts `*` as a method, and the proxy treats `*` as any method;
- the problem line says "matched loosely (any path that starts the same)", which hides that the whole host (or every
  host) is covered.

In the honest case, the long segment is sorted first (more literal segments), so it answers its siblings
(`/products/:id`). It also answers paths the collection doesn't know, so they never reach the real server in
`passthrough` mode. A hostile file reaches every host this way, which makes #1 reach every host too.

**Fix (M3, M1, M2):**
- Never let a fallback glob be wider than its origin plus its literal prefix. Stop at the first `*` segment and don't
  append `*`: `https://host/products/*` only when the remaining segments are params. Otherwise leave the endpoint out,
  with a problem line.
- Refuse hosts that aren't hostnames or IP literals (`[A-Za-z0-9.-]` after IDNA, or `[v6]`), and methods that aren't
  letters (no `*`).
- **Tests:** `https://*/…`, `%`×30 and the Arabic segment → no rule wider than `origin/<literal prefix>/`.

### 4 (LOW-MED) Agents get around the agent mock policy and write the committed file

- `agentMockRefusal` (`agent/shared.ts:201-224`) refuses agent mocks with an HTML / JS / SVG type, an untyped HTML
  body, or a 3xx `Location` off the request's origin. `remove_rule` refuses shared rules: "agents can't change that
  file" (`tools/rules.ts:69-73`).
- `import_collection` and `set_collection` (`tools/collections.ts:61-91`) have neither check:
  - `import_collection` links any collection inside the workspace;
  - `set_collection {variable}` points its `{{baseUrl}}` at any origin. The value isn't checked as a URL;
    `core.ts:433` only requires one line of at most 2048 characters;
  - both write `.vscode/flutter-intercept.json`, which is committed for the team.
- The read tool `export_postman` (`types.ts:30`) writes a collection of the app's recorded responses, headers
  included (`export/postman.ts:167-175`), so an agent with only our tools can produce the file itself.

Probe (`agentretarget.js`, real handlers + core):
```
import_collection {file: ".dart_tool/flutter_intercept/exports/2026-11-19.postman_collection.json"}
set_collection {id: "recorded", variable: {name: "baseUrl", value: "https://accounts.google.com"}}
→ /^https:\/\/accounts\.google\.com(?::443)?\/login…/i 302 {"location":"https://attacker.example/phish"}
     add_mock would refuse: a 302 redirect to https://attacker.example is refused for agents …
→ /^https:\/\/accounts\.google\.com(?::443)?\/?…/i 200 {"content-type":"text/html; charset=utf-8"}
     add_mock would refuse: content-type "text/html; charset=utf-8" is refused for agents …
shared file: collections: [{ id: "recorded", file: ".dart_tool/…", variables: { baseUrl: "https://accounts.google.com" } }]
```

Both tools ask for confirmation, and the texts are good: they name the file, the value, and "shared with the team".
But `add_mock` also asks, and still refuses. The refusal is the REVIEW-6 #4 boundary, and these tools step around it.
The committed link also points at `.dart_tool/`, which Flutter's `.gitignore` excludes, so teammates get a broken
link.

**Fix (H):**
- For agents, check every rule the collection would produce with `agentMockRefusal` (use the rule's origin) after
  `import_collection` / `set_collection`. Refuse the call, or leave those examples out for agent-made changes.
- Check `variable.value` as an http(s) URL for agents and for the panel, as the IDE prompt does.
- Refuse `import_collection` of a file under `.dart_tool/` or one that git ignores. Alternatively, say in the
  confirmation that teammates won't have the file.
- Decide whether agents may write the shared file at all. The alternative is that their `selected` / `off` /
  `unmatched` / `variable` changes are personal (workspaceState), like `enabled`.
- **Tests:** the probe's two rules are refused. `set_collection` with a non-URL value is refused.

### 5 (LOW-MED) `get_collection` leaks credentials and environment values

`getCollection` (`tools/collections.ts:31-47`) redacts only `url`. Everything else in `CollectionEndpointView`
(`core.ts:362-380`) is passed through as it is:
- **`key`** is the URL template as written (`postman.ts` `keyTemplate`), so userinfo stays in it;
- **`examples[].query`** holds the literal query values of the example's `originalRequest`. These are often real
  tokens: Postman saves the request that produced the example;
- **`url`** is the origin plus the path *after* variables are resolved (`buildPath`). Environment values used in a
  path appear there. `redactUrl` only blanks path segments that look opaque, and a Telegram-style
  `123456789:AAH…` has a `:`.

Probe (`agentleak.js`, redaction on):
```
"key": "GET https://admin:Hunter2pass@{{host}}/v1/accounts"
"examples": [{ "name": "page 2", "query": { "access_token": "sk_live_51Habcdefghijklmnop", "page": "2" } }]
"url": "https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/getMe"   ← botToken from the environment file
```

§21.6 says environment values "are never sent to the panel, agents …; the panel and agents see variable names … and
resolved origins". Origins are fine by design, but resolved paths are not covered by that exception. The panel's
endpoint list (`collectionEndpoints`) shows the same path, and "Edit as a rule" puts it in a personal rule's regex
(workspaceState; agents read it with `list_rules`). `get_collection_example` is fine: it uses `redactHeaders` and the
same body view as `get_request`, which I checked by reading.

**Fix (H):**
- With redaction on, send `key` through `redactUrl`, and `query` values through the field / value rules
  (`isSensitiveField`, `redactSecretValues(v, true)`).
- Show a path segment that came from an **environment** value as `{{name}}` in `url` (panel and agents). Agents
  already pass `key` back, not `url`.
- **Test:** the probe's three values are absent from the tool result.

### 6 (LOW-MED) "Copy without credentials" keeps common credentials

`sanitisePostman` (`sanitise.ts`) follows the §21.6 list. Several common shapes are outside it. Probe (`sanit.js`):
```
KEPT  baseUrl = https://deploy:GhP4ssw0rdX@api.x.example      (userinfo in a variable / url.raw / url.host)
KEPT  ?key=AIzaKEY222  ?sig=SIG333  ?code=OAUTHCODE444          (SECRET_KEY has no key, sig, signature, code)
KEPT  Ocp-Apim-Subscription-Key, X-Functions-Key, X-Signature   (isSensitiveHeader misses them)
KEPT  request.certificate.passphrase = CERTPASS999, key/cert src = /Users/dev/certs/…   (Postman v2.1 schema field)
KEPT  raw body "grant_type=password&…&password=PLAINPW000"      (named "not checked (not JSON)", as specified)
KEPT  example Set-Cookie: sid=REALSESSION111, response cookie[]  (examples kept; the modal says so)
removed: X-Amz-Security-Token only
```

The copy is offered as "recommended", and its purpose is to be committed. The credentials notice (`core.ts:321-325`)
uses the same `removed` list, so a file with only these items is reported clean.

**Fix (M1):**
- Clear userinfo in every URL string (variables, `raw`, `host`).
- Add `key|sig(nature)?|code|subscription[-_]?key|functions[-_]?key|passphrase|pin` to the name pattern used here (not
  necessarily to agent redaction).
- Drop `request.certificate` and `request.proxy`.
- Treat an `x-www-form-urlencoded`-looking raw body like `urlencoded`.
- Blank `Set-Cookie` values and `cookie[]` in examples, or say so in the modal with the count.
- **Tests:** each item above.

### 7 (LOW) Problem lines repeat file text, with no length limit and possibly several lines

`openapi.ts:554` (response code), `:653` (`externalValue`) and `ref.ts:175` (external `$ref`) quote the file's value
whole. `capProblems` (`core.ts:105`) limits the count (50), not the length. JSON and YAML errors are careful to quote
nothing (`parseJsonText`, `parseYaml`), but these lines do.

Probe (`problems.js`):
```
49 response keys of 300 KB → 50 problems, longest 300 051 chars, JSON.stringify(state()) = 14 702 976 bytes
"GET /ext (200 · a): externalValue is not fetched (https://ci:ghp_S3cretTokenValue1234567890abcdef@raw.example/ex.json\nInjected second line) (skipped)"
"GET /ref (200): external $ref \"https://user:pw@schemas.example/r.yaml#/x\" is not followed (skipped)"
```

`Status` (with `collections[].problems`) is broadcast to every view on each status change, and `list_collections`
returns the problems unredacted. Contract: "readable, one line each".

**Fix (M2, H):**
- Cut every quoted value to 80–120 characters and replace control characters with a space, as `cleanLabel` in
  `postman.ts` does.
- Redact URLs with `redactUrl` (or drop userinfo and the query) before quoting.
- In `capProblems`, also cut each line to about 300 characters, as a backstop for every parser.

### 8 (INFO) Smaller items

- **Picker spam.** `importCollection` → `importInteractive` (`service.ts:155`) has no in-flight guard. A compromised
  panel can queue native open dialogs, then QuickPicks. REVIEW-14 #6 added "one chooser at a time" for certificates
  (`clientCertUi.ts:245`). `removeCollection` can likewise queue modals.
- **OpenAPI and "Copy without credentials".** The modal detail promises "auth settings, scripts and secret-looking
  headers and variables are removed". For an OpenAPI file the copy is the file unchanged (`core.ts:548`), as §21.6
  says. Say so in the modal, or offer only "Copy" for OpenAPI.
- **Remove modal text.** `removeWithConfirmation` (`service.ts:227`) quotes `s.name`, which is `info.name`
  (`postman.ts`) with only a length cut. Newlines and bidi controls from the file reach the modal (REVIEW-6 #6
  pattern). Clean it like `cleanLabel`.
- **Variable values.** Only the IDE input box checks `^https?://` (`service.ts:148`). Agent and panel values only
  need to be one line (`core.ts:433`). See #4.
- **Learned passthrough.** `patternNamesHost` ignores regexes (REVIEW-14), so for a host that is pinned or learned
  as `client-certificate`, collection mocks silently stop. Nothing names the collection. Consider letting the
  collection's origins count as "naming the host".
- **Dangling symlink at the copy target.** `exists()` uses `stat`, which follows links. A dangling symlink at
  `.vscode/flutter-intercept/collections/<slug>.json` counts as free, and the rename replaces the link itself. That
  stays inside the workspace and nothing outside is written (`paths.js`), but "never over a file" is not quite true.
  Use `lstat`.

## Checked, fine

- **Regex builder (no ReDoS):**
  - `fuzz.js`: 5064 rules from 3000 random requests (reserved, `%`, glob characters, non-ASCII, U+202E, NUL, `:id`,
    `{x}`, `{{v}}`, `{{$guid}}`, query examples). Every regex source passes `isSafeRegexSource` and compiles; 0
    unsafe, 0 invalid;
  - worst match 0.51 ms on 4 KB hostile URLs (`a/`×2000, `%41`×1300 + 1000 query pairs, 4000 `&`, `é`×2000);
  - file text reaches a regex only through `escapeRegex` / `flexibleLiteral`. Params are bounded (`{1,100}`), the
    alternation groups are never quantified, and the query lookaheads use a narrow class;
  - the unmatched-fail rule is a literal origin regex; `*` in a host stays a literal there.
- **Prototype keys** (`proto.js`): `__proto__` and `constructor` as collection variables, link variables, `selected`
  keys, header and query names, folder names, OpenAPI server variables and property names. `Object.prototype` is
  untouched. Headers stay data (`defineProperty`, null-prototype maps), and `toFileLink` writes `__proto__` back as a
  key.
- **Depth** (`deep.js`, 201 ms in all):
  - JSON nested 2 000 000 deep in a side field, and 500 000 deep inside a raw request body, loads. The sanitiser
    clones to depth 64 and drops deeper data rather than copying it unsanitised;
  - YAML nested 200 000 deep → js-yaml's "nesting exceeded maxDepth (100)" with a position only;
  - 10 000 nested folders → the depth-32 problem;
  - js-yaml uses `JSON_SCHEMA` and `json: true`: no custom tags, no functions.
- **Paths** (`paths.js`, real fs):
  - `file` / `environment` through a symlink out, a symlinked directory, `../`, an absolute path, `C:/` and `.\..\`
    are all refused with a problem. `relativePath` checks the shape; `checkWorkspaceFile` does realpath on both
    sides, regular file, size;
  - copy-in through a committed `.vscode/flutter-intercept/collections` symlink to outside → "points outside the
    workspace folder (symbolic link); not written";
  - a symlink to an outside file at the target name → `shop-2.json` is chosen and the outside file is untouched;
  - writes are temp + `rename`, which never follows the final component. A symlinked shared file is refused for
    writing;
  - the picker refuses non-`file` URIs. A pick inside the primary folder is linked by its real path; one outside is
    copied (never linked by absolute path).
- **Environment values:**
  - they resolve URL variables only, and are cached in the parse key by file metadata, not by value;
  - they are not in `state()` except as resolved origins (by design), not logged, and not in any problem: environment
    problems name keys only. #5 is the exception;
  - JSON errors give `line L, column C` from `rules/jsonc.ts`, and YAML errors give js-yaml's reason without a snippet.
- **Agents:**
  - the schemas are strict: id `[a-z0-9-]{1,40}`, keys ≤ 8224, files ≤ 1024, trimmed, workspace-relative only;
  - `import_collection` can't copy, open a picker, choose a folder or remove a collection, and `remove_collection`
    isn't offered;
  - confirmations name the file, the environment, the variable value, the example and "shared with the team";
    `set_collection` is destructive and idempotent in MCP. `readOnly` gets the three read tools only;
  - `get_collection_example` headers go through `redactHeaders`, and the body through the same view as `get_request`
    (by reading).
- **Proxy wiring:**
  - collection rules are never in `getRules()`, the `rules` message, the snapshot or agent `list_rules`
    (`proxyHost.ts:758, 848, 857`), and shared and personal rules come first;
  - only `http:` / `https:` origins become rules (`originParts`); every header name is a token and every value is
    free of CR / LF / NUL;
  - rule ids are `collection:<id>:<n>`, and the panel resolves names from `Status.collections` only.
- **Panel:**
  - every file-controlled string (names, keys, URLs, problems, origins, example bodies) is JSX text. There is no
    `innerHTML` in `packages/webview/src`, and names are cut at 200;
  - the 501 banner keys on a header that a server could also send, which is harmless: it only offers "Mock it with a
    rule";
  - the handlers check keys (`onlyKeys`), ids, lengths and every patch field (`core.update`). `collectionToRule` goes
    through `validateRule`. Remove asks in an IDE modal, and Cancel changes nothing.
- **Shared file:** `saveCollections` writes rules and other keys back exactly as they are, so approvals don't change.
  A broken file is refused, and pre-0.15 writers keep the `collections` key (`serializeSharedFile`).
- **Personal data:** there are no home paths, LAN IPs, UDIDs, emails, team IDs or provider-format tokens in the diff
  or the new files. The `/Users/sara/…` and `10.0.2.2` strings are made-up test values.

## Fixes (all findings fixed, 2026-11-19)

| # | Fix | Where | Tests |
|---|---|---|---|
| 1 | Not a hold but **limited answers until one approval per collection** (owner's UX direction, CONTRACTS §21.16): Location / Refresh, Set-Cookie, Access-Control-*, CSP, X-Forwarded-* removed, active content types served as `text/plain`, marked `x-flutter-intercept: limited; removed=…`. Approval = hash of folder, link id, collection + environment file contents and URL variables; only the IDE modal approves. Plain JSON answers never change | `mocks/limit.ts`, `mocks/core.ts` (`buildRules`, `approve`, `approvalSummary`), `mocks/service.ts` (`approveWithConfirmation`), `ui/handlers.ts` (`approveCollection`) | `mocks.limit.test.ts` (all five reasons + an untyped `<` body), `mocks.core.test.ts` (limited before / full after; file edit and `baseUrl` change limit again; selection doesn't), `controller.v0150.test.ts` |
| 2 | (a) The Postman walk and the sanitiser count every visited value (shared YAML aliases cost their expanded size) and stop at `walkNodes` with one problem / one `removed` entry; nothing past the budget is copied. (b) OpenAPI: each distinct example value is serialised once and reused; the total example text of a document is capped at 64 MB with one problem. (c) The same 64 MB total cap for Postman bodies: no `Invalid string length` | `mocks/postman.ts`, `mocks/sanitise.ts`, `mocks/openapi.ts`, `mocks/generate.ts`, `mocks/ref.ts` (M1, M2) | `mocks.postman.test.ts`, `mocks.sanitise.test.ts`, `mocks.openapi.test.ts`, `mocks.generate.test.ts`; reviewer's probes re-run by the lead: `yamldag` / `coredos` 24–31 ms (were 5.5 s at 681 bytes, ×10 per level), `oaref` / `oaamp` 22–61 ms and 19–30 MB RSS (were 1.2 GB at 300 paths) |
| 3 | Lead: whole-literal encodings (raw / `encodeURIComponent` / Dart's path or query form) instead of per-character alternatives, so Arabic paths fit; **no glob fallback** (too long → not mocked, with a problem); plain host names and methods only (`*`, userinfo refused) | `mocks/toRules.ts` | `mocks.toRules.test.ts` (Arabic segment exact, wildcard hosts / methods, too-long), reviewer's `glob.ts` probe: every case "no match" |
| 4 | An agent-imported collection is limited like any other until the **user** approves (agents have no approve path). Links into `.dart_tool/` / `build/` refused | `mocks/core.ts` `addLink` | `mocks.core.test.ts` |
| 5 | Agents: `get_collection` keys and URLs through `redactUrl`, example query values with credential-like names or opaque-token values redacted; a redacted key is accepted back. Panel and agents: an environment value inside a path is shown as `{{name}}` | `agent/tools/collections.ts`, `agent/views.ts` (`endpointKeyView`), `mocks/core.ts` `endpoints()` | `api.v0151.test.ts`, `mocks.core.test.ts` |
| 6 | "Copy without credentials" also clears URL credentials, `key` / `sig` / `signature` / `code` / `client_secret` query values, `Ocp-Apim-Subscription-Key`, `X-Functions-Key` and any `*-key` / `*-token` header, `certificate(s)` blocks (passphrase, paths), proxy settings and example `Set-Cookie` / `Cookie` values; `removed` names each, so the credentials notice does too. Example response *bodies* are still copied as written (they are what the mock answers; the dialog says so) | `mocks/sanitise.ts` (M1) | `mocks.sanitise.test.ts`; reviewer's `sanit.ts`: 15 of 16 planted values removed, the one kept is a token inside an example response body (by design) |
| 7 | Host side: every problem line the core exposes goes through `cleanLine` (≤ 300 characters, no control / bidi characters, `scheme://***@` for URL credentials), whatever the parser produced. Parser side (M1, M2): one quoting helper per parser with the same rules | `mocks/limit.ts`, `mocks/core.ts` `capProblems` | `mocks.limit.test.ts`, `mocks.core.test.ts`; reviewer's `problems.ts`: longest line 109 characters, no newline |
| 8 | One import flow at a time; the copy question for an OpenAPI file says it is copied as it is; Remove dialog text cleaned; server variables must be plain http(s) URLs or host names; a notice when a collection host is passed through without decryption; copy-in never replaces a name already in the folder (a dangling symlink included) | `mocks/service.ts`, `mocks/core.ts` | `mocks.core.test.ts`; reviewer's `paths.ts`: copy-in skipped the symlinked name |

Panel (W2, lead): the approval line, "changed for you" with Reset / Save for the team, the requests a collection lacks,
and a one-line note on a limited answer — screenshots of the real bundle in dark, light and high contrast were checked.
Verified: extension 2361 tests, webview 614, sidecar 60, CLI 122, plugin 111; bundle 2 678 420 bytes (budget raised on
purpose to 2 700 000, docs/PERF-3.md §6); bundle smoke incl. YAML. Not run yet: the integration agent suite step
(§21.15 #6) and the release's real Claude Code run.
