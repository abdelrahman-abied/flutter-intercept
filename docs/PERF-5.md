# PERF-5 — the PERF-4 follow-ups (2026-11-22)

PERF-4 (0.16.0) accepted four costs with a follow-up each (§4 #4–#7). This pass measures each one again, fixes three of
them, and compares the result with 0.16.0. No behaviour changes: every fix produces the same output as before, and
each case below was checked against a hash of that output.

These are measurements, not estimates. Where a number is derived, the derivation is stated.

## 1. Environment

| | |
|---|---|
| Machine | Apple M4 Max, macOS 27 |
| Node | v26.4.0 (the benches). VS Code's extension host runs its own Electron Node |
| Code measured | **0.16.0** = `109d553` (the extension sources are unchanged since the 0.16.0 release). **PERF-5** = the working tree with this pass's changes |
| Load | No other agent editing or building. Compare rows within a table, not with PERF-4 |

## 2. Method

Scripts in the session scratchpad, outside the repo (`perf5/`). Each one bundles the TypeScript sources with esbuild,
so both versions run in the same harness. Each "before" number comes from a build of the `109d553` sources, made by
swapping the one changed file back in before bundling.

- **From traffic** (`traffic.ts`): `collectionFromTraffic` on a generated recorded session in PERF-4's shape:
  - 450 paths × (GET + POST) = **900 endpoints**, 3 hosts;
  - 10 request and 10 response headers each (authorization, cookie, `x-api-key`, `set-cookie`, …);
  - JSON bodies with e-mails, phone numbers, tokens and endpoint-specific keys (so sibling collapse does not merge
    endpoints);
  - a password in every POST body.

  Five runs in one process (best, median and first are reported). The output is checked with a sha1 of the collection
  text plus the `removed` list.
- **Bruno** (`bruno.ts`): the CLI's `loadCollections` (the host's `MockCollectionsCore`, headless, real fs) on a
  generated folder with PERF-4's shape:
  - `bruno.json`, `collection.bru`, an environment, 40 `folder.bru`, 1 957 requests with a ~1 KB example each;
  - **1 999 files** in all.

  Six loads in one process. A 5 ms heartbeat timer runs on the same event loop. The output is checked with a sha1 of
  the rules, collections and problems.
- **Drift burst** (`drift.ts`): PERF-4 §2's method. The real `MockCollectionsCore` is built as the unit tests build it
  (`FakeFs`), on an OpenAPI collection whose `GET /catalog` example is a 100 KB JSON list (1 or 2 000 endpoints in the
  file).
  - 100 exchanges warm up.
  - Then **500 qualifying 100 KB exchanges**, one every ~2.2 ms (~1.2 s), go through `observeExchange` with the real
    debounce (500 ms, ≤ 50 per tick).
  - A 5 ms heartbeat and `monitorEventLoopDelay` run on the same loop.
  - The result is checked by the findings (one, `added [].badge`) and the number of `onDriftChange` events (one).

## 3. Results

### 3.1 Make a fake backend from traffic (PERF-4 #7)

| 900 endpoints, 900 examples, 5.75 MB written | best | median | first |
|---|---|---|---|
| 0.16.0 | 198.8 ms | 205.7 ms | 237.3 ms |
| PERF-5 (2 runs) | **109.1 / 113.2 ms** | 123.4 / 121.8 ms | 149.5 / 145.2 ms |

**−44 % (best).** The output is the same (`fea840bc7cc6` both). The CPU profile of 0.16.0 put 31 % of the time
(inclusive) in `isSecretName` and 7 % in `hasWord`, because every answer of an endpoint asks about the same keys and
headers again. After the change, `isSecretName` is below 1 %.

The largest remaining self time (18 %) is in `collectionFromTraffic` itself. That is the `JSON.stringify` → `JSON.parse`
→ `sanitisePostman` → `JSON.stringify` round trip on the 5.75 MB document. It is kept on purpose: REVIEW-16 #12 sizes
the sanitiser's walk budget to the parsed plain tree.

**Fix** (`secrets.ts`, `fromTraffic.ts`): `memoName`, a cache of the answers of a pure name check.
- It applies to `isSecretName` (every caller: snapshots, the store, the copy without credentials, agent redaction) and
  to the address and phone word checks of the traffic sanitiser.
- It is bounded. Only names of ≤ 200 characters are kept (longer names skip the cache), and the map starts over at
  4 096 names. Hostile input with endless distinct names therefore costs one check per name, as before. Each of the
  three maps holds a few MB at most (the review measured ~1.8 MB for 4 096 non-Latin names of 200 characters).

### 3.2 Number text in store answers (PERF-4 #4): not changed

There is one process-wide flag. Once any JSON holding `10.50`, `1.0` or a big integer has been parsed, every store
answer is stringified through a replacer: 0.30 → 0.56 ms for a 1 000-record list (PERF-4).

A flag per store or per value would rarely help in practice. Most real APIs have decimal prices, so the flag of any
store that holds them is on anyway. The cost is about 0.26 ms per 1 000 records (derived: ≈ 0.01 ms for a typical
20–50-record page). The fix would also reach into REVIEW-16 #15c's prototype-safety code (null-prototype records,
`cleanJson`, `copyKey`). **Accepted, as in PERF-4.** Revisit if lists of many thousands of records become common.

### 3.3 Bruno folder load (PERF-4 #6)

| 1 999 files, 1 957 endpoints | loads (ms) | best | median | longest heartbeat gap |
|---|---|---|---|---|
| 0.16.0 | 331 289 277 271 275 276 | 271.2 ms | 277.4 ms | 5.7 ms |
| 0.16.0 (again, against the same output hash) | 305 284 281 | 281.3 ms | 284.3 ms | 5.4 ms |
| PERF-5 | 155 117 113 104 106 107 | **104.4 ms** | 113.2 ms | 5.8 ms |
| PERF-5 (again) | 131 112 115 106 108 106 | 106.1 ms | 111.9 ms | 5.6 ms |

**×2.5 faster.** The output is the same (`a6bb996e292f` both). The event loop stays free as before: the heartbeat
never waits more than 5.8 ms.

**Fix** (`core.ts`): before, the walk `stat`-ed each request file one after the other, and the read opened, `fstat`-ed,
read and closed each file one after the other. Both now go through `inOrder`, a sliding window of at most 16 started
calls (`BRUNO_IO_WINDOW`) whose results are taken in input order. So everything that depends on order is unchanged:
- the 2 000-file, 20 MB and depth limits, and which file trips them;
- the problems and their order, and the content hash;
- REVIEW-16 #15g's checked descriptor for every file.

When a limit throws, at most 15 started calls are left. Their rejections are ignored and every descriptor closes in
`readWalked`'s `finally`. Reads that run side by side first take their `fstat` size from the shared 20 MB budget
(found in review, §5). A read past the budget is never made, so memory stays at the sequential code's bound even if
files grow between the walk and the read. Inside one folder, the depth check (made while listing) now comes before the file-count and
size checks (made after the `stat`s). A folder that breaks two limits at once can therefore name the other limit than
before; it is refused either way.

### 3.4 Drift during a burst (PERF-4 #5)

| 500 × 100 KB in ~1.2 s | drained after | CPU | longest heartbeat gap | loop delay p99 / max | findings / events |
|---|---|---|---|---|---|
| 0.16.0, 1 endpoint | 4 968 ms | 786 ms | **73.2 ms** | 1.3 / 69.7 ms | 1 / 1 |
| 0.16.0, 2 000 endpoints | 4 954 ms | 710 ms | **67.5 ms** | 1.3 / 67.5 ms | 1 / 1 |
| PERF-5, 1 endpoint (2 runs) | 4 974 / 4 969 ms | 736 / 749 ms | **26.9 / 25.9 ms** | 10.4 / 12.8, 10.5 / 21.9 ms | 1 / 1 |
| PERF-5, 2 000 endpoints (2 runs) | 4 949 / 4 952 ms | 732 / 718 ms | **26.4 / 25.2 ms** | 10.8 / 21.6, 10.8 / 13.0 ms | 1 / 1 |

The longest block falls from ~70 ms to 13–22 ms (max loop delay). CPU, drain time, findings and events are unchanged.
The p99 delay rises from 1.3 to ~10.5 ms because the same work is now spread over many short slices instead of ten
long ones (derived: ~40 ms × 10 ticks ≈ 70 slices of ~10 ms). The burst is far above what a Flutter app sends; at tens
of qualifying answers per second, a tick is still a single short slice.

**Fix** (`core.ts`, CONTRACTS §23.3 amended): the debounce timer calls `flushDrift(50, DRIFT_SLICE_MS = 10)`.
- A slice stops once 10 ms have gone, after at least one exchange.
- The rest of the batch goes back to the head of the queue and continues on the next turn of the event loop
  (`setImmediate`, unref'd), never past the tick's 50.
- The next debounce is still scheduled when a tick starts, as before. An earlier draft scheduled it when a tick ended
  and drained ~0.4 s later.
- Turning the setting off (`refreshDrift`) and disposing the collections service (`stopDrift`, new) cancel the
  debounce and a pending slice. Before this pass, dispose left the debounce timer running.
- A debounce tick that runs while a slice's rest is waiting takes that rest from the head of the queue first, so the
  waiting resume uses the newest count (§5).
- `onDriftChange` can now fire once per slice instead of once per tick (only when the findings changed).
- Batch leftovers go back to the head of the queue, so they are the first dropped when the queue overflows
  (`MAX_DRIFT_QUEUE` = 1 000). They were already marked as seen, so they are not checked later.
- `driftSliceMs` (core and service deps) sets the slice for tests with fake timers.
- `flushDrift(max)` without a slice (tests, agents) runs the whole batch at once, as before.

## 4. Findings

| # | Finding | Status |
|---|---|---|
| 1 | Make a fake backend: the same names were checked again in every answer (31 % + 7 % of the time) | **Fixed**: bounded `memoName`. 198.8 → 109.1 ms at 900 endpoints, same output |
| 2 | Number text: one process-wide flag (+0.26 ms per 1 000-record list) | Accepted: decimal prices are almost universal, so per-store flags would rarely be off. ≈ 0.01 ms for a typical page |
| 3 | Bruno load: 2 000 files `stat`-ed and read one at a time | **Fixed**: ordered window of 16. 271 → 104 ms, same output, loop still free |
| 4 | Drift: a burst blocks the host ~70 ms per tick | **Fixed**: 10 ms slices within the tick (CONTRACTS §23.3). Max block 13–22 ms, drain and CPU unchanged |

## 5. Independent review

A reviewer who was given the diff but not this report found no secret-leak bug in the name cache and no weakened
Bruno check (symbolic links, `O_NOFOLLOW` + device / inode, the 2 000 / 20 MB / depth 32 / 20 000-entry limits). It
reported six other items, each fixed below:

| # | Finding | Fix |
|---|---|---|
| 1 | Medium: under `vi.useFakeTimers`, `performance.now` stays real, so a slow first exchange could leave the rest of a tick waiting for an immediate the fake clock never runs. `mocks.service.v16p2` failed with a 0 ms slice | `driftSliceMs` dep; the fake-timer service tests use `Infinity`. The whole suite now passes with `DRIFT_SLICE_MS = 0` (checked) |
| 2 | Low: the "PERF-5 #3" test could not see the order, because the Bruno parser sorts requests by `seq` | The test adds 40 files that aren't UTF-8 (problems come in read order) and compares the content hash. A completion-order `inOrder` now fails it (checked) |
| 3 | Low: 16 reads side by side could hold 16 × 20 MB if files grew after the walk | Each read takes its size from the shared budget first (`OVER_BUDGET`); real-fs test in `mocks.review16f3` |
| 4 | Low: a debounce tick during a pending resume left it with an out-of-date count | The resume takes the newest count; a whole tick clears it. Test: 70 queued → 19 left |
| 5 | Low (the timer gap was there before): disposing the service didn't cancel drift work | `stopDrift()`, called by dispose and by the setting off |
| 6 | Nits: the memory note, events per slice, queue overflow order, the error text when a folder breaks two limits, the new drift test's pending debounce | Notes fixed (§3); the test clears the debounce |

After the fixes, the three benches give the same output hashes. Their times are within noise of §3: from traffic best
111.2 / 114.1 ms; Bruno best 112.7 ms (2 000 files, 6 loads); drift max loop delay 12.6–22.0 ms.

## 6. Budgets and tests

- Bundle: `dist/extension.js` **2 966 730 bytes** (+1 714 over PERF-4's 2 965 016). The budget stays at 2 990 000.
- New tests:
  - `test/unit/mocks.perf5.test.ts`: `memoName` checks each name once, never keeps names over 200 characters, and
    starts over at 4 096 names; `isSecretName` and `isSecretHeaderName` give the same answer on every call.
  - `mocks.core.v16p3.test.ts` "PERF-5 #3": a slow fs where later calls finish first. The same endpoints, the same
    problems in the same order and the same content hash as the plain fs; more than 1 and at most 16 calls in flight.
  - `mocks.review16f3.test.ts` #15g: a read past the shared budget is refused before it reads.
  - `mocks.core.v16p2.test.ts` "PERF-5 #4": a 0 ms slice handles one exchange, then the rest follow on the next turns
    with one event; 60 queued exchanges leave 10 after a sliced tick; a whole tick during a pending resume leaves 19
    of 70; the setting off drops what a slice left.
- The existing Bruno limit tests (2 000 files, depth 32, 20 MB, REVIEW-16 #15g's descriptor checks) and drift tests
  pass unchanged.
- Root `npm run build && npm test`: proxy 637, webview 726, extension 2 834, CLI 144, sidecar 72. All pass.
