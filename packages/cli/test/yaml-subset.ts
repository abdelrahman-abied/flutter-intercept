/**
 * A tiny parser for the YAML subset that action.yml and the README workflow examples use (no dependency): block
 * mappings and sequences, plain / single- / double-quoted scalars (kept as strings), `|` / `>` block scalars, full-line
 * and ` #` comments. Anything else (flow collections, anchors, tags, tabs, several documents) throws, so a file that
 * leaves the subset fails the test instead of being misread.
 */
export type Yaml = string | null | Yaml[] | { [key: string]: Yaml };

interface Line {
  indent: number;
  text: string;
  no: number;
}

export function parseYaml(source: string): Yaml {
  const raw = source.replace(/\r\n/g, '\n').split('\n');
  const lines: (Line | { blank: true; no: number; raw: string })[] = raw.map((r, i) => {
    if (/^\s*(#.*)?$/.test(r)) return { blank: true as const, no: i + 1, raw: r };
    if (/^\t| \t/.test(r.match(/^\s*/)![0])) throw new Error(`line ${i + 1}: tabs in indentation`);
    if (/^(---|\.\.\.)\s*$/.test(r)) throw new Error(`line ${i + 1}: document markers are not supported`);
    const indent = r.length - r.trimStart().length;
    return { indent, text: r.trim(), no: i + 1 };
  });
  let pos = 0;
  const isBlank = (l: (typeof lines)[number]): l is { blank: true; no: number; raw: string } => 'blank' in l;
  const skipBlank = () => {
    while (pos < lines.length && isBlank(lines[pos])) pos++;
  };
  const peek = (): Line | undefined => {
    skipBlank();
    return pos < lines.length ? (lines[pos] as Line) : undefined;
  };
  const isSeq = (t: string) => t === '-' || t.startsWith('- ');

  function scalar(text: string, no: number): string | null {
    let t = text;
    if (t.startsWith('"')) {
      const m = /^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/.exec(t);
      if (!m) throw new Error(`line ${no}: bad double-quoted scalar`);
      return m[1].replace(/\\(.)/g, (_s, c: string) => ({ n: '\n', t: '\t', '"': '"', '\\': '\\' })[c] ?? `\\${c}`);
    }
    if (t.startsWith("'")) {
      const m = /^'((?:[^']|'')*)'\s*(#.*)?$/.exec(t);
      if (!m) throw new Error(`line ${no}: bad single-quoted scalar`);
      return m[1].replace(/''/g, "'");
    }
    if (/^[[{&*!%@`|>]/.test(t)) throw new Error(`line ${no}: unsupported YAML (${t.slice(0, 20)})`);
    const hash = t.search(/\s#/);
    if (hash >= 0) t = t.slice(0, hash).trimEnd();
    if (t === '' || t === '~' || t === 'null') return null;
    return t;
  }

  function blockScalar(style: string, parentIndent: number): string {
    const body: string[] = [];
    let indent = -1;
    while (pos < lines.length) {
      const l = lines[pos];
      if (isBlank(l)) {
        body.push('');
        pos++;
        continue;
      }
      if (l.indent <= parentIndent) break;
      if (indent < 0) indent = l.indent;
      if (l.indent < indent) throw new Error(`line ${l.no}: block scalar indentation`);
      body.push(' '.repeat(l.indent - indent) + l.text);
      pos++;
    }
    while (body.length && body[body.length - 1] === '') body.pop();
    const keep = style === '|' || style === '>';
    const text = style.startsWith('>') ? body.join('\n').replace(/([^\n])\n(?=[^\n ])/g, '$1 ') : body.join('\n');
    return keep && text ? `${text}\n` : text;
  }

  function value(rest: string, indent: number, no: number): Yaml {
    if (/^[|>][-+]?$/.test(rest)) {
      pos++;
      return blockScalar(rest, indent);
    }
    pos++;
    if (rest !== '') return scalar(rest, no);
    const next = peek();
    if (!next) return null;
    if (next.indent > indent) return node(next.indent);
    if (next.indent === indent && isSeq(next.text)) return node(indent);
    return null;
  }

  function mapping(indent: number): { [key: string]: Yaml } {
    const out: { [key: string]: Yaml } = {};
    for (let l = peek(); l && l.indent === indent && !isSeq(l.text); l = peek()) {
      const m = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^\s:#'"][^:#]*?)\s*:(?:\s+(.*))?$/.exec(l.text);
      if (!m) throw new Error(`line ${l.no}: expected "key: value", got ${l.text}`);
      const key = scalar(m[1], l.no) ?? '';
      if (key in out) throw new Error(`line ${l.no}: duplicate key ${key}`);
      out[key] = value((m[2] ?? '').trim(), indent, l.no);
    }
    const l = peek();
    if (l && l.indent > indent) throw new Error(`line ${l.no}: unexpected indentation`);
    return out;
  }

  function sequence(indent: number): Yaml[] {
    const out: Yaml[] = [];
    for (let l = peek(); l && l.indent === indent && isSeq(l.text); l = peek()) {
      const content = l.text === '-' ? '' : l.text.slice(2);
      const inner = content.trimStart();
      if (inner === '') {
        pos++;
        const next = peek();
        out.push(next && next.indent > indent ? node(next.indent) : null);
        continue;
      }
      const childIndent = indent + (l.text.length - inner.length);
      if (/^("[^"]*"|'[^']*'|[^\s:#'"][^:#]*?)\s*:(\s|$)/.test(inner)) {
        // "- key: value": the mapping continues on the following lines at the column of "key"
        lines[pos] = { indent: childIndent, text: inner, no: l.no };
        out.push(mapping(childIndent));
      } else if (isSeq(inner)) {
        throw new Error(`line ${l.no}: nested inline sequences are not supported`);
      } else {
        pos++;
        out.push(scalar(inner, l.no));
      }
    }
    return out;
  }

  function node(indent: number): Yaml {
    const l = peek();
    if (!l) return null;
    return isSeq(l.text) ? sequence(indent) : mapping(indent);
  }

  const first = peek();
  if (!first) return null;
  if (first.indent !== 0) throw new Error(`line ${first.no}: the document must start at column 0`);
  const doc = node(0);
  const rest = peek();
  if (rest) throw new Error(`line ${rest.no}: unexpected content`);
  return doc;
}
