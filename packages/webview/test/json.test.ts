import { describe, expect, it } from 'vitest';
import { formatJson, parseJsonLossless, validateJson, type JsonNode } from '../src/json';
import { computeResponseEdit, draftFromExchange, formToRule, ruleToForm, validateDraft, type ResponseDraft } from '../src/state';
import { pausedResponse } from './fixtures';

/** Strip whitespace outside string tokens: formatting must leave this identical. */
function tokensOnly(text: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += text[++i]; continue; }
      if (c === '"') inStr = false;
    } else if (c === '"') { inStr = true; out += c; }
    else if (!/[ \t\r\n]/.test(c)) out += c;
  }
  return out;
}

const tricky = '{"id":12345678901234567890,"neg":-9223372036854775808,"z":-0,"big":1e400,"tiny":1e-400,'
  + '"f":1.0,"i":1,"e":2.50E+10,"s":"caf\\u00e9 \\ud83d\\ude00 \\"q\\" \\/ \\n","raw":"café 😀",'
  + '"dup":1,"dup":2,"empty":{},"list":[],"nested":[[],{},[{"a":[null,true,false]}]]}';

function scalars(n: JsonNode, out: string[] = []): string[] {
  if (n.t === 'obj') for (const e of n.entries) { out.push(e.keyRaw); scalars(e.value, out); }
  else if (n.t === 'arr') for (const x of n.items) scalars(x, out);
  else out.push(n.raw);
  return out;
}

describe('lossless parse', () => {
  it('keeps every number token exactly (big ints, -0, 1e400, 1.0 vs 1, exponents)', () => {
    const r = parseJsonLossless(tricky);
    expect(r.ok).toBe(true);
    const toks = scalars((r as { value: JsonNode }).value);
    for (const t of ['12345678901234567890', '-9223372036854775808', '-0', '1e400', '1e-400', '1.0', '1', '2.50E+10']) {
      expect(toks).toContain(t);
    }
    // what JSON.parse would have done instead
    expect(String(JSON.parse(tricky).id)).toBe('12345678901234567000');
  });
  it('keeps string escapes byte for byte and duplicate keys', () => {
    const toks = scalars((parseJsonLossless(tricky) as { value: JsonNode }).value);
    expect(toks).toContain('"caf\\u00e9 \\ud83d\\ude00 \\"q\\" \\/ \\n"');
    expect(toks).toContain('"café 😀"');
    expect(toks.filter((t) => t === '"dup"')).toHaveLength(2);
  });
  it('rejects invalid input with the same positions as validateJson', () => {
    for (const bad of ['{"a":1,}', '[1 2]', '{"a" 1}', '"\\x"', '01', '{"a":tru}', '[', '']) {
      const p = parseJsonLossless(bad);
      const v = validateJson(bad);
      expect(p.ok).toBe(false);
      expect(p).toEqual(v);
    }
  });
  it('handles deep nesting without recursion limits', () => {
    const depth = 20_000;
    const deep = '['.repeat(depth) + '12345678901234567890' + ']'.repeat(depth);
    expect(validateJson(deep).ok).toBe(true);
    let node = (parseJsonLossless(deep) as { value: JsonNode }).value;
    for (let d = 0; d < depth; d++) node = (node as { items: JsonNode[] }).items[0];
    expect(node).toEqual({ t: 'num', raw: '12345678901234567890' });
    expect(validateJson('['.repeat(depth) + ']'.repeat(depth - 1))).toMatchObject({ ok: false, message: "Expected ',' or ']', got end of input" });
  });
});

describe('formatJson (re-indent only)', () => {
  it('changes no token: big ints, -0, 1e400, 1.0, escapes, duplicates survive', () => {
    const pretty = formatJson(tricky)!;
    expect(pretty).toContain('"id": 12345678901234567890');
    expect(pretty).toContain('"z": -0');
    expect(pretty).toContain('"big": 1e400');
    expect(pretty).toContain('"f": 1.0');
    expect(pretty).toContain('"s": "caf\\u00e9 \\ud83d\\ude00 \\"q\\" \\/ \\n"');
    expect(pretty).toContain('"dup": 1,\n  "dup": 2');
    expect(tokensOnly(pretty)).toBe(tokensOnly(tricky));
    expect(validateJson(pretty).ok).toBe(true);
  });
  it('produces conventional 2-space layout, keeps empty containers and a trailing newline', () => {
    expect(formatJson('{"a":[1,{"b":null}],"c":{},"d":[]}')).toBe(
      '{\n  "a": [\n    1,\n    {\n      "b": null\n    }\n  ],\n  "c": {},\n  "d": []\n}',
    );
    expect(formatJson('[ ]\n')).toBe('[]\n');
    expect(formatJson('  42  ')).toBe('42');
  });
  it('does not touch whitespace or structure characters inside strings', () => {
    const s = '{"k":"a, b: [c] {d}  \\" e"}';
    expect(formatJson(s)).toBe('{\n  "k": "a, b: [c] {d}  \\" e"\n}');
  });
  it('is idempotent and returns undefined for invalid JSON', () => {
    const once = formatJson(tricky)!;
    expect(formatJson(once)).toBe(once);
    expect(formatJson('{"a":}')).toBeUndefined();
  });
  it('handles deep nesting', () => {
    const deep = '['.repeat(2000) + '-0' + ']'.repeat(2000);
    const pretty = formatJson(deep)!;
    expect(tokensOnly(pretty)).toBe(deep);
  });
});

describe('bodies are never rewritten on their way to the app', () => {
  it('edit diff and validation send the typed text verbatim', () => {
    const p = pausedResponse({ responseBody: { text: '{"id":1}', encoding: 'utf8' } });
    const d = draftFromExchange(p) as ResponseDraft;
    const body = '{"id": 12345678901234567890, "z": -0, "x": 1.0}';
    expect(validateDraft({ ...d, body }).json).toEqual({ ok: true });
    expect(computeResponseEdit(p, { ...d, body })).toEqual({ body });
    // formatting the original then sending: still the same tokens
    const formatted = formatJson(body)!;
    expect(computeResponseEdit(p, { ...d, body: formatted })!.body).toContain('12345678901234567890');
  });
  it('mock rule bodies round-trip through the form unchanged', () => {
    const body = '{"id":12345678901234567890,"price":1.10}';
    const rule = formToRule({ ...ruleToForm(), url: '*', mockBody: body });
    expect(rule.action).toMatchObject({ kind: 'mock', body });
    expect(ruleToForm(rule).mockBody).toBe(body);
  });
});
