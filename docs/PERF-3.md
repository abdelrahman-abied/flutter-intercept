# PERF-3 — 0.15.0 performance pass (2026-11-19)

The measured performance pass for 0.15.0 ("Mock from a collection", CONTRACTS §21), compared with 0.14.1. It covers
what 0.15.0 adds to the hot paths:
- every request is tested against the collection rules after the shared and personal rules (the proxy is unchanged:
  a collection becomes ordinary `mock` rules, §21.5);
- a collection is parsed and turned into rules on every reload (file edit, git checkout, a change from the panel);
- the extension bundle grew (the parsers, the generator, js-yaml);
- the webview gained a Collections section that can list 2 000 endpoints.

These are measurements, not estimates. Where a number is derived, the derivation is stated.

## 1. Environment

| | |
|---|---|
| Machine | Apple M4 Max, macOS 27 |
| Node | v26.4.0 (the benches). VS Code's extension host runs its own Electron Node |
| Code measured | **0.14.1** = `dist/extension.js` from the 0.14.1 VSIX (`32943ec`). **0.15** = the working tree after WP0, M1–M3, W and H |
| Load | Every proxy bench ran under `nice -n 10`, with other agents working on the machine at the same time (an implementation agent and the REVIEW-15 reviewer). Compare rows within a table, not with PERF-2 |

## 2. Method

Scripts in the session scratchpad, outside the repo (`perf3/`):
- **Proxy per request** (`bench.ts` + `proxyChild.ts`): three processes' worth of roles — the proxy alone in a child
  process (`InterceptProxy` from `packages/proxy/dist`), an upstream HTTP server and the client in the parent. Plain
  HTTP through the proxy (absolute URI), keep-alive, 16 concurrent, 300 warm-up requests, then 3 000 measured
  requests per case; proxy CPU is `process.cpuUsage()` in the child over the measured requests. Collection rules are
  built by the real `toRules` from a synthetic collection: endpoints `/api/res<i>/:id` and
  `/api/res<i>/:id/items/:item`, GET / POST, a query example on every fourth (so rules = 1.25 × endpoints).
  - **miss**: the collection is for another origin, so every collection rule is tested and the request goes to the
    real upstream — the cost every request of an app pays while a collection is on;
  - **hit-last**: the request matches the endpoint tried last, answered by its mock (no upstream).
  Three rounds, the order of rule counts alternating between rounds.
- **Rule matching alone** (`micro.ts`): `compileRules` + 20 000 × `findRule` on the same rule sets, a URL on another
  host and a URL on the collection's host that matches nothing.
- **Parsing** (hostile-input scripts used in the M1 / M2 reviews): `parsePostman`, `toRules`, `parseOpenApi`,
  `generateFromSchema` on large and hostile documents.
- **Bundle and activation** (`req.js`): `require()` of `dist/extension.js` with a stub `vscode`, 7 runs each,
  0.14.1 and 0.15 alternating.
- **Webview**: W's `perf-collections.test.tsx` (happy-dom).

## 3. Results

### 3.1 Proxy, per request (3 rounds; ranges)

| endpoints | rules | case | req/s | p50 ms | p99 ms | proxy CPU per req (ms) | added vs 0 rules |
|---|---|---|---|---|---|---|---|
| 0 | 0 | miss | 10 341–10 607 | 1.29–1.32 | 3.45–3.61 | 0.1445–0.1463 | — |
| 100 | 125 | miss | 9 597–9 818 | 1.38–1.44 | 3.60–3.77 | 0.1527–0.1553 | **+0.009** |
| 100 | 125 | hit-last | 19 479–19 610 | 0.68–0.70 | 2.12–2.25 | 0.0826–0.0835 | (no upstream) |
| 500 | 625 | miss | 7 630–7 894 | 1.78–1.84 | 4.17–4.38 | 0.1761–0.1811 | **+0.034** |
| 500 | 625 | hit-last | 7 808–7 878 | 1.76–1.83 | 4.17–4.70 | 0.1781–0.1785 | +0.033 |
| 2 000 | 2 500 | miss | 4 471–4 589 | 3.24–3.26 | 5.97–7.21 | 0.2661–0.2736 | **+0.125** |
| 2 000 | 2 500 | hit-last | 4 347–4 567 | 3.23–3.45 | 6.24–6.70 | 0.2681–0.2784 | +0.127 |

"Added" = the row's median CPU per request minus the 0-rule median (0.1451 ms).

**Budget (§21.12): ≤ 0.05 ms added per request at 500 rules — met: +0.034 ms at 625 rules.** No proxy-side index is
needed for 0.15.0.

At 2 000 endpoints the proxy spends 0.125 ms more per request, and under this synthetic load (16 clients in a loop)
throughput halves. A Flutter app makes tens of requests per second, not thousands: 0.125 ms × 50 req/s = 6 ms of CPU
per second on the extension host. The cost is linear in the number of rules (§3.2), so a 2 000-request collection is
fine for real use. It is the first thing to fix if users report large collections (§4, follow-up).

### 3.2 Rule matching alone

| endpoints | rules | `compileRules` | `findRule`, other host | `findRule`, same host, no match |
|---|---|---|---|---|
| 500 | 625 | 2.3 ms | 0.0276 ms | 0.0312 ms |
| 2 000 | 2 500 | 5.3 ms | 0.1153 ms | 0.1447 ms |

That is 44–58 ns per rule. Every collection regex starts with `^` and its origin, so a request to another host fails on
the first characters. What remains is the per-rule overhead of `findRule` / `compileBase`: a closure call, the
`enabled` check, and `method.toUpperCase()` on the request's method **once per rule**. §3.1's "added" numbers match
§3.2: 0.034 vs 0.028–0.031 ms, 0.125 vs 0.115–0.145 ms. `compileRules` runs once per reload.

### 3.3 Parsing and reloads

| input | time | result |
|---|---|---|
| Postman, 2 500 requests × 21 examples of 1 KB | 27 ms | 2 000 endpoints kept (limit), one problem per cut |
| `toRules` on those 2 000 endpoints | 8 ms | 2 000 + query rules, 0 problems |
| Postman, 100 000-deep folders / cyclic `item` / brace floods | ≤ 0.3 ms | problems, no exception |
| OpenAPI, 3 000 paths | 11 ms | 2 000 endpoints kept (limit) |
| OpenAPI from YAML, "billion laughs" (10⁹ expanded nodes via aliases) | 11 ms | one problem (walk cap) |
| `generateFromSchema`, 400 × 3 × 40 properties (output cap 256 KB) | 5 ms | cut, one problem |
| `generateFromSchema` / `parseOpenApi`, 50 000-deep `allOf` / `oneOf` / `anyOf`, 50 000-long `$ref` chain | < 1 ms | one problem (after the M2 fix; before it, a stack overflow) |

A reload of the largest allowed collection: about 27 ms of parsing, 8 ms to build the rules and 5 ms to compile them in
the proxy, on the extension host. Files are cached by size and mtime, so a reload caused by another file doesn't
parse them again.

### 3.4 Extension bundle and activation

| | 0.14.1 | 0.15 |
|---|---|---|
| `dist/extension.js` | 2 516 962 bytes | 2 652 908 bytes (+135 946) |
| `require()` with a stub `vscode`, median of 7 | 62.6 ms | 65.5 ms (+2.9 ms) |

- js-yaml is required on first use only (`src/mocks/yaml.ts`), so it adds bytes but not evaluation at activation.
- **Fixed in this pass:** js-yaml's package `exports` block deep imports, so its writer (`dumper.js`) was bundled
  although the importer only reads YAML. `build.mjs` now resolves `js-yaml` to a shim with the loader and the JSON
  schema only (`jsYamlLoaderOnlyPlugin`, used by every build). Saved 8 927 bytes (2 661 835 → 2 652 908). Vitest loads
  the full package; the behaviour is the same. `test/bundle/smoke.ts` now parses YAML through the bundled shim
  (aliases, response codes as keys) and checks that a `!!js/function` tag is refused, so a broken shim fails the build
  check.
- **Budget: 2 550 000 → 2 675 000 bytes** (measured + 20 KB, as PERF-2 did).

### 3.5 Webview (happy-dom; `perf-collections.test.tsx`)

| case | time |
|---|---|
| filter 2 000 endpoints (5 filter shapes) | 0.00–0.16 ms |
| first render of a 2 000-endpoint collection (capped, "Show more") | 21.7 ms |
| a filter keystroke in the panel | 0.6 ms |

## 4. Findings

| # | Finding | Status |
|---|---|---|
| 1 | Per-request cost within budget at 500 endpoints (+0.034 ms of 0.05). Linear: +0.125 ms at 2 000 | OK. Follow-up, not 0.15.0: hoist `method.toUpperCase()` out of the per-rule loop and group rules by method + origin in the proxy if large collections become common (a proxy change: contract amendment first, §21.12) |
| 2 | js-yaml's writer was bundled | Fixed (§3.4) |
| 3 | Bundle +136 KB, activation +2.9 ms | Accepted; budget lowered to the measured size + 20 KB |
| 4 | `js-yaml@4.3.2` as published contains `lib/index_vite_proxy.tmp.mjs` (434 bytes, an ES-module re-export of the package's own `index.js`, no other code). It is in the registry tarball, not a local change | Harmless (not bundled: the shim and the CommonJS entry don't reach it). Noted for the next dependency update |
| 5 | M2's generator and parser overflowed the stack on 50 000-deep combinator chains | Fixed by M2 before this pass; re-measured (§3.3) |

## 5. Budgets and tests added

- `build.mjs`: `MAX_EXTENSION_BYTES = 2_675_000`; `jsYamlLoaderOnlyPlugin` on every build.
- `test/bundle/smoke.ts`: YAML through the bundled shim, and a custom tag refused.
- From the work packages (kept as regression budgets): `mocks.toRules.test.ts` "hostile URLs against many rules:
  < 5 ms per request" (300 endpoints, `fail` mode); `perf-collections.test.tsx` (filter < 50 ms at 2 000 endpoints).

## 6. After the REVIEW-15 fixes (2026-11-19)

The fixes and the agent-friendly amendments (CONTRACTS §21.15, §21.16, §21.17) added 25 512 bytes:
2 652 908 → **2 678 420**. Where it went: the parsers' node and total-size budgets and the wider sanitiser (M1, M2),
the collections core's personal overlay, approval and traffic summary (`core.ts` 20.5 KB in total), the limited-answer
module (`limit.ts`, 1.7 KB), the agent tools (`tools/collections.ts`, 4.5 KB) and the VS Code service (6.7 KB). All of
it is security or agent-facing behaviour the release needs, so the budget is raised on purpose to **2 700 000**
(measured + 20 KB, same rule as §3.4). The REVIEW-15 denial-of-service probes now finish in 24–31 ms (were 5.5 s for
681 bytes) and 19–30 MB (were 1.2 GB); the per-request numbers of §3.1 are unchanged (the proxy and the rule shapes
didn't change).

