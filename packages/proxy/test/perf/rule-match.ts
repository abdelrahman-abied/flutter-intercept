// Not part of CI (vitest only runs test/**/*.test.ts). Reproduces PERF-3 §3.2 (rule matching alone) for CONTRACTS §24.5:
//   cd packages/proxy && npx vite-node test/perf/rule-match.ts            # indexed
//   cd packages/proxy && FI_PROXY_LINEAR=1 npx vite-node test/perf/rule-match.ts   # the linear scan (0.15 behaviour)
// Rules have the shape packages/extension/src/mocks/toRules.ts builds: endpoints /api/res<i>/:id and
// /api/res<i>/:id/items/:item, GET / POST, a query example on every fourth endpoint (rules = 1.25 × endpoints).
import { InterceptProxy } from '../../src/intercept-proxy';
import { compileRules, findRule } from '../../src/rules';
import type { Rule } from '../../src/types';

const ORIGIN = 'https:\\/\\/api\\.shop\\.example(?::443)?';
const PARAM = '[^/?#]{1,100}';
const PATH_END = '\\/?(?:[?#]|$)';
const QUERY_CHARS = "[\\w.~%+=,;:@!$'()*\\/?&-]";

export function collectionRules(endpoints: number): Rule[] {
  const rules: Rule[] = [];
  for (let e = 0; e < endpoints; e++) {
    const i = e >> 2;
    const method = (e >> 1) % 2 ? 'POST' : 'GET';
    const path = e % 2 ? `\\/api\\/res${i}\\/${PARAM}\\/items\\/${PARAM}` : `\\/api\\/res${i}\\/${PARAM}`;
    const base = `^${ORIGIN}${path}`;
    const action = { kind: 'mock', status: 200, body: '{}' } as const;
    if (e % 4 === 0) {
      rules.push({ id: `q${e}`, enabled: true, match: { method, url: `/${base}\\/?\\?(?=(?:${QUERY_CHARS}*&)?page=2(?:[&#]|$))/i` }, action });
    }
    rules.push({ id: `r${e}`, enabled: true, match: { method, url: `/${base}${PATH_END}/i` }, action });
  }
  return rules;
}

const N = 20_000;
const ROUNDS = 5;
/** [name, method, URL]; `` = built from the last endpoints of the rule set. */
const cases: [string, string, (endpoints: number) => string][] = [
  ['other host', 'GET', () => 'https://other.example/api/res1/5'],
  ['same host, no match', 'GET', () => 'https://api.shop.example/nothing/here'],
  ['same host, known prefix, no match', 'GET', (n) => `https://api.shop.example/api/res${Math.max(0, n - 1) >> 2}`],
  ['same host, last GET endpoint', 'GET', (n) => `https://api.shop.example/api/res${Math.max(0, n - 4) >> 2}/7`],
  ['same host, the last rule', 'POST', (n) => `https://api.shop.example/api/res${Math.max(0, n - 1) >> 2}/7/items/3`],
];

function time(fn: () => void): number {
  for (let i = 0; i < 2_000; i++) fn();
  let best = Infinity;
  for (let r = 0; r < ROUNDS; r++) {
    const t = performance.now();
    for (let i = 0; i < N; i++) fn();
    best = Math.min(best, (performance.now() - t) / N);
  }
  return best;
}

const linear = process.env.FI_PROXY_LINEAR === '1';
console.log(`${linear ? 'linear (FI_PROXY_LINEAR=1)' : 'indexed'}; best of ${ROUNDS} × ${N} calls; ms per call`);
console.log('endpoints | rules | compileRules ms, first | again (best of 5) | ' + cases.map(([c]) => `findRule ${c}`).join(' | ') + ' | ' + cases.map(([c]) => `matchRule ${c}`).join(' | '));
for (const endpoints of [0, 100, 500, 2_000]) {
  const rules = collectionRules(endpoints);
  // cold: the first compile of these patterns (regexes built); warm: the URL tests cached where the cache holds them
  const t0 = performance.now();
  let compiled = compileRules(rules);
  const coldMs = performance.now() - t0;
  let warmMs = Infinity;
  for (let r = 0; r < 5; r++) {
    const t1 = performance.now();
    compiled = compileRules(rules);
    warmMs = Math.min(warmMs, performance.now() - t1);
  }
  const px = new InterceptProxy({ port: 0 }) as unknown as { setRules(r: Rule[]): void; matchRule(m: string, u: string, o: object): { rule?: Rule } };
  px.setRules(rules);
  const urls = cases.map(([, , u]) => u(endpoints));
  if (endpoints > 0) {
    // the cases are what they say
    const hit = cases.map(([, m], i) => px.matchRule(m, urls[i], { count: false }).rule?.id);
    const want = [undefined, undefined, undefined, `r${endpoints - 4}`, rules[rules.length - 1].id];
    if (JSON.stringify(hit) !== JSON.stringify(want)) throw new Error(`bench cases are off: ${JSON.stringify(hit)} ≠ ${JSON.stringify(want)}`);
  }
  const cols = cases.map(([, m], i) => time(() => findRule(compiled, m, urls[i])).toFixed(5));
  const pm = cases.map(([, m], i) => time(() => px.matchRule(m, urls[i], { count: false })).toFixed(5));
  console.log(`${endpoints} | ${rules.length} | ${coldMs.toFixed(1)} | ${warmMs.toFixed(1)} | ${cols.join(' | ')} | ${pm.join(' | ')}`);
}
