import { describe, expect, it } from 'vitest';
import { toJunitXml, xmlEscape } from '../src/junit';

describe('junit', () => {
  it('escapes XML and drops characters XML cannot carry', () => {
    expect(xmlEscape(`a<b>&"c"'d'\u0001\u0007e`)).toBe('a&lt;b&gt;&amp;&quot;c&quot;&apos;d&apos;e');
  });

  it('writes one testcase per assertion with failures and errors', () => {
    const xml = toJunitXml(
      [
        { name: 'ok <1>', pass: true, matched: 2, failures: [] },
        { name: 'bad', pass: false, matched: 1, failures: ['first & worst', 'second'] },
        { name: 'broken', pass: false, matched: 0, failures: ['invalid input'], error: 'invalid input' },
      ],
      { timestamp: new Date('2026-10-10T12:00:00.123Z'), timeSeconds: 0.5 },
    );
    expect(xml).toContain('<testsuites name="flutter-intercept assertions" tests="3" failures="1" errors="1" time="0.500">');
    expect(xml).toContain('timestamp="2026-10-10T12:00:00"');
    expect(xml).toContain('<testcase classname="flutter-intercept.assert" name="ok &lt;1&gt;" time="0">');
    expect(xml).toContain('<failure message="first &amp; worst" type="AssertionFailed">first &amp; worst\nsecond</failure>');
    expect(xml).toContain('<error message="invalid input" type="InvalidExpectation">invalid input</error>');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(xml.match(/<testcase /g)).toHaveLength(3);
  });

  it('an empty run is a valid suite', () => {
    expect(toJunitXml([])).toContain('tests="0" failures="0" errors="0"');
  });
});
