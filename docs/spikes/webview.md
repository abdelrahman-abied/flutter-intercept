# Spike: webview UI (Agent D)

Status: **Phase 2 changes done (see "Phase 2 update").** The Phase 1 description below is kept for reference; where they differ, the Phase 2 section wins. `packages/webview` builds a Preact bundle (`dist/webview.js` + `dist/webview.css`)
that talks to the host only through the CONTRACTS §4 messages. `npm run build` and `npm test` pass. Checked against
a fake host in headless Chrome under the strict CSP below: no CSP violations, no console errors, and
resume/edit/abort/mock work end to end. **Not yet run inside a real VSCode webview.** That happens in Phase 2.

## Phase 2 update (contract v2)

These changes follow the updated CONTRACTS §3/§4. `npm run build` and `npm test` pass:
**87 tests (12 util, 53 state, 22 component)**.

1. **Matching comes from the proxy.** I deleted the webview's own matcher. `state.ts` imports `matches` and
   `compileMatcher` from `@flutter-intercept/proxy/rules`. `compileMatcher` is used once per rule for
   `ruleStats` and `countMatches` (1000 exchanges × N rules). `util.describeMatcherUrl` only explains a pattern
   in the form hint (any / glob / regex plus the compile error) and never decides a match. The protocol types
   now come from `@flutter-intercept/proxy/types` (type-only import), and §4 messages are defined in
   `src/protocol.ts`. The dependency entry is `"@flutter-intercept/proxy": "*"`. esbuild bundles only
   `../proxy/dist/rules.js` (1.8 kB in the output; mockttp is not bundled, confirmed with the esbuild metafile).
   This needs the proxy built first (`dist/rules.js`); the root `npm run build -ws` already builds proxy before
   webview.
2. **Countdown.** `pauseClock()` reads `pauseDeadline`, falling back to `pausedAt`. Paused rows show `4:32` in the
   Time column. The pause banner shows "auto-resumes in 4:32", then "auto-resuming unedited…". The last 30 s are
   highlighted. One 1 s interval runs per visible paused row or banner, only while paused.
3. **`removed` and `error`.** `removed` drops those ids together with their drafts, resolving flags, gave-up
   flags and the selection. `error` messages go into a non-blocking red banner (last 5 kept, dismissable) and
   unlock any "Sent — waiting…" editor. The draft is now kept until the exchange leaves its paused phase, so a
   rejected edit can be fixed. The webview's own 1000-row cap is gone.
4. **Edits.**
   - `body` is sent only when it was edited.
   - Binary and truncated bodies are read-only with an explanation (other fields stay editable).
   - `headers` is the full replacement set as `Record<string, string | string[]>`. Repeated names become arrays
     in row order and are never joined. Change detection compares per value.
   - Mock rule headers stay `Record<string,string>` per the contract, so repeated rows are joined there only.
5. **Client gave up.** An exchange is marked as gave up when it was seen paused and then turned `error`, or when
   its error says "closed the connection while … paused" (this covers reloads). It gets a "gave up" badge, and
   the detail pane shows a banner: the app closed the connection (its own timeout), the exchange can't be
   resumed or edited, late resumes are ignored. The editor and resume buttons disappear.
6. **`createRuleFromExchange`.** No change was needed. The host's `rules` reply has the new rule first, and the
   mock flow still opens the editor on it.
7. **Fake host** now has the same semantics:
   - Uses `ruleFromExchange` and `matches` from the proxy, and inserts the created rule first.
   - Sets `pausedAt`/`pauseDeadline` and auto-resumes at the deadline (`?bpTimeout=`).
   - The fake app gives up after `?clientTimeout=` (default 120 s) and becomes `error`; a late resume is a no-op.
   - An invalid edit produces an `error` message and the exchange stays paused.
   - Ring buffer `?max=` with `removed` messages.
   - `clear` keeps in-flight exchanges and is followed by a `snapshot`.
   - The dev bar has a "host error" button.

   Checked in headless Chrome through the DevTools protocol: countdowns, rule from exchange, error banner and
   gave-up banner all work, with no console errors.

Bundle after Phase 2: `webview.js` 68.1 kB (23.3 kB gzip), `webview.css` 21.1 kB (4.5 kB gzip). Of the
+5.4 kB, 1.8 kB is the proxy's rules module; the rest is the new UI.

## What it does

- **Toolbar:** Traffic/Rules switch, intercept on/off (`setInterceptEnabled`), clear (`clear`), URL filter
  (space-separated terms are AND-ed, `-term` excludes), method filter, status-class toggles (2xx/3xx/4xx/5xx/err),
  "paused only", and a pulsing **"N paused"** pill. Clicking the pill jumps to the next paused exchange and turns
  on "paused only" if the current filters hide it.
- **Traffic list:** virtualised with a fixed 22 px row height. Only the visible rows plus 8 above and below are in
  the DOM. Columns: method, status (colour by class), host, path, time, size (decoded body, `+` when truncated),
  state badge. Paused rows get a warning background and a left bar. Mocked, blocked, aborted and error rows each
  have their own badge. The list keeps following new traffic while scrolled to the bottom. Keys: ↑/↓, Home/End,
  PgUp/PgDn, Enter (focus details), Esc (close). ARIA: `listbox` with `aria-activedescendant`.
- **Detail pane:** a draggable splitter (also arrow keys) and a stacked layout under 720 px. The header shows
  method, status, URL, timing and the matched rule (click it to open that rule), plus Mock this / Block this /
  Break on this (`createRuleFromExchange`). It has Request and Response tabs, each with a headers table and a body:
  - JSON (by content-type or sniffing) shows as a collapsible tree. It opens 2 levels deep, children render only
    when expanded, and arrays/objects are paged 100 then +1000. It has Tree/Raw, Expand/Collapse all and Copy.
  - base64 shows `binary (N bytes)`. `image/*` also gets a `data:` preview.
  - Truncated bodies get a `truncated` badge. `content-encoding` shows as "decoded from gzip".
  - A body whose content-type says JSON but which doesn't parse shows the error with line and column.
- **Paused editor** (replaces the paused phase's tab and auto-selects it):
  - paused-request: method (datalist), URL, header rows, body. paused-response: status, header rows, body.
  - The body is a monospace textarea. When the draft's content-type is JSON it validates live with
    "line L, column C: message" and has "Go to error" and "Format".
  - Changed fields are marked "• edited", and a summary reads "Edited: status, body".
  - **Resume with edits** (Ctrl/Cmd+Enter) sends `resume` with an `edit` that holds only the changed fields.
    It is disabled when nothing changed or on hard errors (bad URL or method, status outside 100–599, bad header
    name). Invalid JSON asks for confirmation in the page ("Send anyway" / "Keep editing").
    `window.confirm` doesn't work in webviews.
  - **Resume unchanged** sends `resume` with no edit. **Abort** sends `abort`. After either, the buttons lock
    ("Sent — waiting for the proxy…") until the host reports the next state.
  - Binary or truncated bodies can't be edited and are forwarded unchanged.
  - Drafts live in the reducer and are saved with `vscode.setState` (debounced), so they survive the webview
    being hidden and reloaded.
- **Rules tab:**
  - Order numbers and a banner make it clear that the **first enabled rule that matches wins**.
  - Each row has an enable checkbox, ↑/↓ buttons, drag and drop (or Alt+↑/↓), edit, and delete with **Undo**.
  - Each row shows "matches N" against the current traffic, and **"K taken by an earlier rule"** when shadowed.
  - Edit form: name, enabled, method, URL. The URL is a glob or `/regex/flags`, with a validity hint and a live
    "matches N of M exchanges" preview.
  - Actions: mock (status, header rows, body with JSON validation and confirm, delayMs), block (reset, or status
    N), breakpoint (request, response, or both).
  - Every change sends the whole list with `setRules`, applied optimistically. The host's `rules` reply is
    authoritative.
  - After `createRuleFromExchange(mock)`, the next `rules` message that contains a new id opens that rule in the
    editor, so the user can edit the mock body at once. block and breakpoint only show a notice.
- **Empty state:** "Press F5 to run your Flutter app — traffic appears here." plus proxy, port and session status,
  and a warning when interception is off. The status line shows proxy :port, sessions, intercept on/off,
  exchange count (and how many are shown) and paused count.
- **Protocol:** posts `ready` on mount and handles snapshot, exchange, rules, status and cleared. Host messages are
  batched per task tick, so a burst of `exchange` updates renders once. Non-protocol `message` events are ignored.

## Component map

```
src/main.tsx            mount on #root (created if missing) — imports styles.css
src/host.ts             acquireVsCodeApi() once; post / getState / setState / onMessage(isHostMsg filter)
src/protocol.ts         CONTRACTS §3 types + §4 HostMsg/ViewMsg, copied verbatim (lead to dedupe)
src/state.ts            PURE reducer + selectors: host msgs, selection/nav, filters, drafts + edit diff,
                        draft validation, rules ops (move/toggle/delete/upsert, ruleStats), rule form ⇄ Rule
src/util.ts             formatting, URL split cache, status class, header helpers, byte sizes,
                        glob/regex matcher (client mirror of proxy matching), strict JSON validator w/ line/col
src/context.ts          AppContext {state, dispatch, post}
src/components/
  App.tsx               reducer + host wiring, batching, persistence; TrafficView (split), EmptyState,
                        StatusLine, NoticeBar
  Toolbar.tsx           view switch, intercept toggle, clear, filters, paused pill
  TrafficList.tsx       virtualised listbox + keyboard
  DetailPane.tsx        header/actions/pause banner, Request/Response tabs
  Editors.tsx           PauseEditor, HeadersEditor, BodyEditor (JSON validation, go-to-error, format)
  Viewers.tsx           HeadersTable, BodyView (binary/image/truncated), JsonTree (lazy, paged)
  RulesView.tsx         rules list (order, shadowing, DnD) + RuleEditor
  bits.tsx / Icon.tsx   StateBadge, StatusText, Button; inline-SVG icons (no icon font)
src/styles.css          only --vscode-* variables (aliases on body), container query for narrow list
dev/index.html          browser harness page (same CSP shape, fixed nonce)
dev/fake-host.ts        stubs acquireVsCodeApi + simulated proxy honouring rules; dev bar wiring
dev/themes.css          approximate Dark Modern / Light Modern / HC variable sets (dev only)
test/*.test.ts(x)       vitest: state, util, components (happy-dom)
build.mjs               esbuild → dist/webview.{js,css}; --watch; --dev (serve harness)
```

## Host integration (for Agent B / the lead)

**Files:** `packages/webview/dist/webview.js` and `dist/webview.css`. The extension build should copy them into
the extension, for example `packages/extension/dist/webview/`, so that `vsce package` includes them. Set
`localResourceRoots` to that folder.

**CSP the host must set.** It needs no `'unsafe-inline'` and no `'unsafe-eval'`:

```
default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};
```

| Directive | Why |
|---|---|
| `default-src 'none'` | No network access at all (`connect-src` falls back to none). The UI only uses postMessage. |
| `style-src ${cspSource}` | Loads `webview.css`. There are no `<style>` blocks and no `style=""` attributes. Dynamic values (list spacer height, `translateY`, the `--split` variable) go through **CSSOM** (`element.style.x` / `setProperty`). Preact writes style objects this way, and CSP doesn't apply to it. |
| `script-src 'nonce-${nonce}'` | The single `<script nonce>` that loads `webview.js`. The bundle has no `eval` or `new Function` (checked). |
| `img-src ${cspSource} data:` | `data:` is used only for the inline preview of base64 `image/*` response bodies. Drop `data:` to disable previews; nothing else breaks. |
| `font-src ${cspSource}` | Optional. No fonts are loaded: icons are inline SVG and text uses `--vscode-font-family` and `--vscode-editor-font-family`. |

The dev harness runs under exactly this shape (`'self'` in place of `cspSource`). Headless Chrome reported zero
CSP violations.

**HTML template:**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'; img-src ${cspSource} data:; font-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Flutter Intercept</title>
</head>
<body class="${inPanel ? 'fi-panel' : ''}">
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>
```

- **Nonce:** 32 random characters, new on every `getHtml`.
- **`fi-panel` / `fi-sidebar` class:** only changes the opaque background used by sticky bars, to
  `--vscode-panel-background` or `--vscode-sideBar-background`. Leave it off for an editor-tab `WebviewPanel`.
- **Options:** `enableScripts: true`. `retainContextWhenHidden` is not required: on reload the UI sends `ready` and
  rebuilds from `snapshot`, and filters, selection, the open rule editor and paused-exchange drafts come back from
  `setState`. Turning it on keeps scroll position and JSON-tree expansion as well.
- **Host behaviour the UI expects:**
  - Answer `ready` with `snapshot`, every time, including after a reload.
  - Echo `rules` after `setRules` and after `createRuleFromExchange`. The mock flow waits for that reply to open
    the editor.
  - Send `cleared` after `clear`. The UI doesn't clear on its own.
  - Send `status` after `setInterceptEnabled`. The toggle reflects only the host's status.

## Dev harness

```bash
cd packages/webview
npm run dev          # esbuild watch + serve → http://127.0.0.1:5178/dev/index.html  (PORT=… to change)
```

- **Startup:** about 40 preloaded exchanges, one paused request (cart POST hits a request breakpoint) and one
  paused response (`/me`). After that a new exchange arrives every 1.2 s.
- **Traffic kinds:** gzip JSON lists and details, a 60 kB nested feed, PNG (base64, previewed), a truncated
  binary PDF, 401 problem+json, 503 HTML, a 302 with multi-value `set-cookie`, a 204, a connection-refused error,
  an ad pixel blocked by a rule, and a mocked `/v1/flags`.
- **Simulated proxy:** honours the rules: mock with delay, block (reset or status), breakpoint
  (request / response / both, with resume edits applied), plus abort, clear and `createRuleFromExchange`
  (new rule inserted first).
- **Dev bar:** theme dark / light / high contrast, pause stream, +1000 exchanges, stop/start proxy, and the last
  message sent to the host.
- **URL params:** `?n=40`, `?rate=1200`, `?stream=0`, `?empty=1`, `?theme=vscode-light`, and
  `?ui={"view":"rules","editingRuleId":"rule_mock_flags"}` (initial persisted state; handy for screenshots).

## Bundle size (production, minified)

| File | Raw | gzip |
|---|---|---|
| `dist/webview.js` (Preact + hooks + app, IIFE) | 62.7 kB | 21.5 kB |
| `dist/webview.css` | 20.4 kB | 4.4 kB |

There are no runtime dependencies besides `preact`. The esbuild target is `chrome114` (VSCode 1.90 ships Chromium 122).

## Tests

`npm test` runs `tsc -p .` (strict, `noUnusedLocals`), then vitest: **76 tests in 3 files, all passing, about 0.6 s.**

- `test/state.test.ts` (48):
  - Each HostMsg: snapshot (replace, keep or drop the selection, auto-select paused, cap); exchange (append,
    in-place update, eviction that keeps paused and selected rows, auto-select a new paused exchange, switch tab
    on phase change, drop drafts and resolving flags); rules (replace, close the editor of a deleted rule, the
    createRuleFromExchange flow for mock and for block); status; cleared; batches.
  - Navigation over the filtered list, `showPaused` cycling, persistence round trip.
  - Filter logic: text with AND and `-exclude`, method, status classes including `error`, paused-only,
    combinations.
  - **Edit diff:** untouched → no edit; only the body; method compared case-insensitively; URL trimmed; headers
    sent as the full set when any header changed; header order, case and blank rows don't count as changes;
    binary or truncated bodies never sent; a body appears only when typed; response status as a number;
    multi-value headers; `patchDraft` composes edits; stale drafts from the other phase are ignored.
  - Draft validation.
  - **Rules:** `moveRule` reorders and ignores out-of-range moves; toggle, delete, upsert; first-match-wins and
    shadowing stats; undo notice; rule form round trip for every action kind, plus its validation.
- `test/util.test.ts` (11): the JSON validator accepts and rejects the same inputs as `JSON.parse`, with exact
  line and column (10 cases, and 50k objects validated in under 1 s); glob and regex matchers; formatting; byte
  sizes; status class; header helpers; `isHostMsg`.
- `test/components.test.tsx` (17, happy-dom):
  - Shell: `ready` on load and the empty state; snapshot, exchange, status and cleared rendering; toolbar posts;
    the paused pill.
  - List: **1000 rows render in about 11 ms with fewer than 100 rows in the DOM**, and the window moves on
    scroll; keyboard navigation; filters and clearing them.
  - Detail: JSON tree collapse, binary and truncated bodies, the three create-rule posts.
  - Editor: **the paused-response editor renders status, headers and body**; only changed fields are sent;
    buttons lock until the host replies; **invalid JSON blocks Resume with edits until "Send anyway"**;
    paused-request editing of method and headers (Cmd+Enter), URL validation, abort.
  - Rules: order, toggle, reorder, delete and undo through `setRules`; editor regex validation, live preview and
    saving a mock; restored state reopens the editor; a created mock opens in the editor.

Also checked by hand in headless Chrome through the DevTools protocol against the fake host: edited a paused
response with invalid JSON (confirm appeared, nothing sent), resumed a paused request with only
`{"method":"PUT"}`, and opened the editor from "Mock this". There were no console errors, and light, dark, high
contrast and narrow layouts all rendered.

## Open issues

- **Not yet run inside VSCode.** Theme variables, the CSP and keyboard focus need checking in a real webview
  during Phase 2. The dev themes are approximations.
- **Breakpoint timeout is invisible.** The proxy auto-resumes after 5 minutes (`breakpointTimeoutMs`), but
  `Exchange` carries no pause time, so the UI can't show a countdown (see the requested changes).
- **Ring-buffer drift.** The webview caps itself at 1000 exchanges (the proxy default) because the host doesn't
  report evictions. If `maxExchanges` is configured differently, the two lists drift.
- **Multi-value headers in edits.** `RequestEdit` and `ResponseEdit` headers are `Record<string,string>`, so an
  edited header set with repeated names (for example `set-cookie`) is joined with `", "`, which is wrong for
  Set-Cookie. Headers are sent only when they changed, so an untouched multi-value header is safe.
- **Matcher preview may disagree with the proxy.** "matches N" and shadowing use a client-side copy of the
  matcher: glob is anchored and case-sensitive, and regex is detected by `/^\/(.+)\/([a-z]*)$/`. If the proxy
  differs, the preview is off.
- **Large bodies.** The body editor is a plain textarea, with no syntax highlighting or search; Monaco would cost
  megabytes. A 5 MB body: JSON.parse runs on the main thread (tens of ms), the tree renders lazily, and Raw view
  in a `<pre>` can be sluggish.
- **Not built:** search inside bodies, HAR export, "copy as cURL", columns the user can resize or hide, sorting.
  The list is always in arrival order.
- **Drag and drop:** reordering rules uses HTML5 drag and drop, which works in webview iframes. Keyboard and
  button reordering are always available as well.
- **No new dependencies.** happy-dom, preact, esbuild, vitest and typescript were enough. `preact/test-utils`
  ships with preact.

## Requested contract changes

1. **`RequestEdit.headers` / `ResponseEdit.headers` semantics:** please state that they **replace the full header
   set**. The webview sends the complete new set whenever any header changed, because deletions can't be
   expressed with merge semantics. Please also allow `Record<string, string | string[]>` so that multi-value
   headers survive editing.
2. **Proxy fixes framing after a body edit or mock:** bodies are shown and edited decoded. When `body` is in an
   edit (or comes from a mock rule), the proxy must recompute `content-length` and drop or re-apply
   `content-encoding` and `transfer-encoding`. Otherwise an edited gzip response breaks the app. The UI doesn't
   touch these headers.
3. **`Exchange.pausedAt?: number`** (epoch ms), so the UI can show "auto-resumes in 4:12". Better still, add
   `resumeDeadline?: number`.
4. **Evictions:** add a `{ type: 'removed'; ids: string[] }` HostMsg when the ring buffer drops exchanges, or add
   `maxExchanges` to `Status` so the webview can use the same cap.
5. **`createRuleFromExchange`:** please specify what the host does:
   - Placement: insert the rule **first** so it wins, then reply with `rules`.
   - Matcher: `method` plus `origin + pathname + '*'` (ignores the query).
   - Mock action: status, content-type and body copied from the exchange's response, falling back to `200`,
     `application/json` and `{}`.
   - Breakpoint action: phase `both`.
   - Block action: mode `reset`.

   The fake host implements exactly this.
6. **Shared matcher:** export the URL matcher (glob vs `/regex/flags` parsing and matching) from
   `@flutter-intercept/proxy` as a pure function with no Node dependencies, so the webview preview and the proxy
   can't disagree. Please also state glob case sensitivity in CONTRACTS.
7. **Optional:** `{ type: 'error'; message: string; id?: string }` HostMsg, for example when `resume` arrives after
   an auto-resume or `setRules` fails. Today the UI simply waits for the next `exchange` update.

## Phase 3: README screenshots

The screenshots in `packages/extension/media/screenshots/` came from the dev harness with
`?stream=0&n=26&bare=1&seed=10` (add `&theme=vscode-light` for the light one). I drove them through headless
Chrome over the DevTools protocol: click a row, open a tab, or press "Mock this".

- Viewport: 1400×480 for the traffic shots, 1400×600 for the paused response, 1400×360 for rules, 1400×640 for
  "Mock this". Device pixel ratio 2.
- `?seed=N` makes the fake traffic deterministic.
- `?bare=1` hides the dev bar and adds the `fi-panel` body class, so the page looks like the real bottom-panel
  view.

## Fix: lossless JSON (REVIEW-1 #4)

The JSON tree and the editor's Format button used `JSON.parse`/`JSON.stringify`, which rounds integers above
2^53. `{"id":12345678901234567890}` was shown, and after Format sent, as `…567000`; Dart keeps 64-bit ints.

`src/json.ts` (no dependency) replaces that:
- `parseJsonLossless` builds a tree that keeps each scalar's raw token: numbers such as `12345678901234567890`,
  `-0`, `1e400` and `1.0`; strings with their escapes; duplicate keys.
- `validateJson` is the same parser without building a tree. Errors and line/column are unchanged.
- `formatJson` only re-indents. Strings, numbers and literals are copied byte for byte, and a trailing newline
  is kept.
- All three are iterative, so deep nesting has no recursion limit (tested at 20,000 levels).

**Audit.** No body goes through `JSON.parse`/`stringify` anywhere in `src/` now.
- The edit diff compares raw text and sends the textarea verbatim.
- Validation only reads the body.
- Mock rule bodies round-trip through the form unchanged.
- Copy copies the raw text.
- The host's `ruleFromExchange` uses the raw body text (proxy code).

**Speed** on a 4 MB body: `JSON.parse` 13 ms, validate 13 ms, lossless tree 37 ms, Format 109 ms.

**Tests:** +13, 100 in total. `test/json.test.ts` covers big ints, int64 min, -0, 1e400/1e-400, 1.0 vs 1, an
exponent, `\u` and surrogate escapes, raw UTF-8, duplicate keys, 20k-deep nesting, the format layout,
idempotence, the token-identity property, and that the edit diff and mock form don't rewrite bodies. Two
component tests check that the tree shows the raw tokens and that Format followed by Resume sends the exact
text. Bundle: 69.0 kB (23.8 kB gzip).
