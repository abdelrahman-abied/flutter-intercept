/**
 * `--assert <file>` (CONTRACTS §13.9): a JSON array of `assert_traffic` inputs (CONTRACTS §10.6), checked against the
 * finished run with the agent API's own implementation (same validation, matching, redaction and failure texts).
 * Each item may carry a `name` (CLI extension, used in the summary and the JUnit report).
 */
import * as fs from 'fs';
import type { Exchange, Rule } from '@flutter-intercept/proxy';
import { AgentApi } from '../../extension/src/agent/api';
import { parseToolInput } from '../../extension/src/agent/schema';

export interface Expectation {
  name: string;
  /** The assert_traffic input (without `name`; `withinMs` forced to 0: the run is over). */
  input: Record<string, unknown>;
}

export interface AssertionResult {
  name: string;
  pass: boolean;
  matched: number;
  failures: string[];
  /** Set when the expectation could not be evaluated (invalid input, internal error). */
  error?: string;
}

export const MAX_EXPECTATIONS = 500;

function defaultName(input: Record<string, unknown>, i: number): string {
  const method = typeof input.method === 'string' ? `${input.method.toUpperCase()} ` : '';
  const url = typeof input.url === 'string' ? input.url : '?';
  return `#${i + 1} ${method}${url}`;
}

/**
 * Parses and validates an expectations file's text. Throws a readable Error naming every bad item, so a typo fails
 * before the (slow) flutter build. `notes` collects adjustments (e.g. `withinMs` ignored).
 */
export function parseExpectations(text: string, label = 'expectations file', notes: string[] = []): Expectation[] {
  let data: unknown;
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    throw new Error(`${label}: not valid JSON (${(e as Error).message})`);
  }
  if (data && typeof data === 'object' && !Array.isArray(data) && Array.isArray((data as { assertions?: unknown }).assertions)) {
    data = (data as { assertions: unknown[] }).assertions;
  }
  if (!Array.isArray(data)) throw new Error(`${label}: expected a JSON array of assert_traffic inputs`);
  if (data.length > MAX_EXPECTATIONS) throw new Error(`${label}: more than ${MAX_EXPECTATIONS} expectations`);
  const out: Expectation[] = [];
  const problems: string[] = [];
  data.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push(`item ${i + 1}: expected an object`);
      return;
    }
    const { name, ...input } = raw as Record<string, unknown>;
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 200)) {
      problems.push(`item ${i + 1}: name must be a non-empty string (at most 200 characters)`);
      return;
    }
    if (input.withinMs !== undefined && input.withinMs !== 0) notes.push(`${label} item ${i + 1}: withinMs ignored (the run is over when assertions are checked)`);
    input.withinMs = 0;
    try {
      parseToolInput('assert_traffic', input);
    } catch (e) {
      problems.push(`item ${i + 1}: ${(e as Error).message.replace(/^invalid input for assert_traffic: /, '')}`);
      return;
    }
    out.push({ name: typeof name === 'string' ? name.trim() : defaultName(input, i), input });
  });
  if (problems.length) throw new Error(`${label}: ${problems.join('; ')}`);
  return out;
}

export function readExpectations(file: string, notes: string[] = []): Expectation[] {
  let text: string;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) throw new Error('not a regular file');
    if (st.size > 5 * 1024 * 1024) throw new Error('larger than 5 MB');
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`expectations file ${file}: ${(e as Error).message}`);
  }
  return parseExpectations(text, file, notes);
}

/** An AgentApi over a fixed list of exchanges: only the read-only tools that need nothing else work. */
function agentOver(exchanges: Exchange[], redact: boolean): AgentApi {
  const noop = () => undefined;
  return new AgentApi({
    host: {
      running: true,
      port: undefined,
      getExchanges: () => exchanges,
      getRules: (): Rule[] => [],
      resume: noop,
      abort: noop,
      on: noop,
      off: noop,
    },
    applyRules: noop,
    clear: noop,
    getSettings: () => ({ access: 'readOnly', redactSecrets: redact, interceptEnabled: true }),
    launcher: {
      launch: () => Promise.reject(new Error('not available headless')),
      stop: () => Promise.resolve({ stopped: 0 }),
      hotRestart: () => Promise.resolve({ restarted: 0 }),
      sessions: () => [],
    },
    projectRoot: () => undefined,
  });
}

/** Evaluates every expectation against `exchanges` (all of them: `sinceMs` defaults to 0). */
export async function evaluateExpectations(expectations: Expectation[], exchanges: Exchange[], opts: { redact: boolean }): Promise<AssertionResult[]> {
  const api = agentOver(exchanges, opts.redact);
  const out: AssertionResult[] = [];
  for (const x of expectations) {
    try {
      const r = (await api.call('assert_traffic', x.input)) as { pass?: unknown; matched?: unknown; failures?: unknown };
      const failures = Array.isArray(r.failures) ? r.failures.filter((f): f is string => typeof f === 'string') : [];
      out.push({ name: x.name, pass: r.pass === true, matched: typeof r.matched === 'number' ? r.matched : 0, failures });
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      out.push({ name: x.name, pass: false, matched: 0, failures: [msg], error: msg });
    }
  }
  return out;
}
