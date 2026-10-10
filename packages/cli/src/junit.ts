/** `--junit <file>`: the assertion results as JUnit XML (one testsuite, one testcase per expectation). */
import type { AssertionResult } from './assertions';

/** XML 1.0 text: escaped, characters XML can't carry dropped. */
export function xmlEscape(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x09\x0A\x0D\x20-퟿-�\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface JunitOptions {
  suiteName?: string;
  /** Seconds spent checking (reported as the suite time). */
  timeSeconds?: number;
  timestamp?: Date;
}

export function toJunitXml(results: AssertionResult[], opts: JunitOptions = {}): string {
  const suite = opts.suiteName ?? 'flutter-intercept assertions';
  const failures = results.filter((r) => !r.pass && !r.error).length;
  const errors = results.filter((r) => r.error).length;
  const time = (opts.timeSeconds ?? 0).toFixed(3);
  const ts = (opts.timestamp ?? new Date()).toISOString().replace(/\.\d{3}Z$/, '');
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${xmlEscape(suite)}" tests="${results.length}" failures="${failures}" errors="${errors}" time="${time}">`,
    `  <testsuite name="${xmlEscape(suite)}" tests="${results.length}" failures="${failures}" errors="${errors}" skipped="0" time="${time}" timestamp="${ts}">`,
  ];
  for (const r of results) {
    const open = `    <testcase classname="flutter-intercept.assert" name="${xmlEscape(r.name)}" time="0">`;
    if (r.pass) {
      lines.push(`${open}`, `      <system-out>${xmlEscape(`matched ${r.matched} request(s)`)}</system-out>`, '    </testcase>');
      continue;
    }
    const tag = r.error ? 'error' : 'failure';
    const message = r.error ?? r.failures[0] ?? 'assertion failed';
    const body = r.failures.length ? r.failures.join('\n') : message;
    lines.push(open, `      <${tag} message="${xmlEscape(message)}" type="${tag === 'error' ? 'InvalidExpectation' : 'AssertionFailed'}">${xmlEscape(body)}</${tag}>`, '    </testcase>');
  }
  lines.push('  </testsuite>', '</testsuites>', '');
  return lines.join('\n');
}
