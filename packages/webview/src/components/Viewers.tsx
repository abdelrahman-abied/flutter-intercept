import type { ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import type { Body } from '../protocol';
import { headersToRows } from '../state';
import {
  bodyByteLength, formatBytes, headerValue, isJsonContentType, type Headers,
} from '../util';
import { parseJsonLossless, type JsonNode } from '../json';
import { Icon } from './Icon';

export function HeadersTable({ headers }: { headers: Headers | undefined }) {
  const rows = headersToRows(headers);
  if (!rows.length) return <div class="muted pad">No headers</div>;
  return (
    <table class="kv">
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <th scope="row">{r.name}</th>
            <td>{r.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard can be unavailable (e.g. unfocused webview) — nothing useful to do */
  }
}

const IMAGE_PREVIEW = /^image\/(png|jpe?g|gif|webp|bmp|x-icon|vnd\.microsoft\.icon|avif)$/;

export function BodyView({ body, headers }: { body: Body | undefined; headers: Headers | undefined }) {
  const ct = headerValue(headers, 'content-type');
  const ce = headerValue(headers, 'content-encoding');
  if (!body || (body.encoding === 'utf8' && body.text === '')) return <div class="muted pad">No body</div>;

  const size = bodyByteLength(body)!;
  const meta = (
    <>
      {ct && <span class="meta-item">{ct}</span>}
      <span class="meta-item">{formatBytes(size)}</span>
      {ce && ce !== 'identity' && <span class="meta-item" title="The proxy shows the decoded body">decoded from {ce}</span>}
      {body.truncated && <span class="badge warn" title="The proxy keeps at most 5 MB of each body">truncated</span>}
    </>
  );

  if (body.encoding === 'base64') {
    const mime = (ct ?? '').split(';')[0].trim().toLowerCase();
    return (
      <div class="body-view">
        <div class="body-meta">{meta}</div>
        <div class="binary">binary ({size.toLocaleString()} bytes)</div>
        {IMAGE_PREVIEW.test(mime) && !body.truncated && (
          <img class="preview" alt="Image preview" src={`data:${mime};base64,${body.text}`} />
        )}
      </div>
    );
  }
  return <TextBody text={body.text} declaredJson={isJsonContentType(ct)} meta={meta} />;
}

function TextBody({ text, declaredJson, meta }: { text: string; declaredJson: boolean; meta: ComponentChildren }) {
  const looksJson = declaredJson || /^\s*[[{]/.test(text);
  // Lossless parse: the tree shows each number/string exactly as sent (no 2^53 rounding).
  const parsed = useMemo(() => (looksJson ? parseJsonLossless(text) : undefined), [text, looksJson]);
  const invalid = declaredJson && parsed && !parsed.ok ? parsed : undefined;
  const tree = parsed?.ok ? parsed.value : undefined;
  const [mode, setMode] = useState<'tree' | 'raw'>('tree');
  const showTree = !!tree && mode === 'tree';

  return (
    <div class="body-view">
      <div class="body-meta">
        {meta}
        <span class="spacer" />
        {tree && (
          <div class="seg small" role="group" aria-label="Body view">
            <button type="button" class="seg-btn" aria-pressed={mode === 'tree'} onClick={() => setMode('tree')}>Tree</button>
            <button type="button" class="seg-btn" aria-pressed={mode === 'raw'} onClick={() => setMode('raw')}>Raw</button>
          </div>
        )}
        <button type="button" class="btn btn-icon" title="Copy body" aria-label="Copy body" onClick={() => copyText(text)}>
          <Icon name="copy" />
        </button>
      </div>
      {invalid && (
        <div class="msg error">Declared as JSON but invalid at line {invalid.line}, column {invalid.column}: {invalid.message}</div>
      )}
      {showTree ? <JsonTree value={tree!} /> : <pre class="code">{text}</pre>}
    </div>
  );
}

// ---------------------------------------------------------------- JSON tree

const PAGE = 100;
const EXPAND_ALL_DEPTH = 8;

export function JsonTree({ value }: { value: JsonNode }) {
  const [openDepth, setOpenDepth] = useState(2);
  const [gen, setGen] = useState(0);
  const set = (d: number) => { setOpenDepth(d); setGen(gen + 1); };
  const expandable = value.t === 'obj' || value.t === 'arr';
  return (
    <div class="json-tree code">
      {expandable && (
        <div class="json-tools">
          <button type="button" class="link" onClick={() => set(EXPAND_ALL_DEPTH)}>Expand all</button>
          <button type="button" class="link" onClick={() => set(1)}>Collapse all</button>
        </div>
      )}
      <JsonNodeView key={gen} node={value} depth={0} openDepth={openDepth} last />
    </div>
  );
}

/** Object keys are shown as their raw token (quotes and escapes as sent), array items by index. */
function JsonKey({ k }: { k?: string | number }) {
  if (k === undefined) return null;
  return (
    <>
      <span class={typeof k === 'number' ? 'j-idx' : 'j-key'}>{k}</span>
      <span class="j-punc">: </span>
    </>
  );
}

function Scalar({ node }: { node: Extract<JsonNode, { raw: string }> }) {
  const cls = node.t === 'str' ? 'j-str' : node.t === 'num' ? 'j-num' : node.raw === 'null' ? 'j-null' : 'j-bool';
  return <span class={cls}>{node.raw}</span>;
}

function JsonNodeView({ k, node, depth, openDepth, last }: { k?: string | number; node: JsonNode; depth: number; openDepth: number; last: boolean }) {
  const [open, setOpen] = useState(depth < openDepth);
  const [limit, setLimit] = useState(PAGE);
  const comma = last ? null : <span class="j-punc">,</span>;

  if (node.t !== 'obj' && node.t !== 'arr') {
    return <div class="j-row"><span class="j-tw-space" /><JsonKey k={k} /><Scalar node={node} />{comma}</div>;
  }
  const isArr = node.t === 'arr';
  const count = isArr ? node.items.length : node.entries.length;
  const [o, c] = isArr ? ['[', ']'] : ['{', '}'];
  if (!count) {
    return <div class="j-row"><span class="j-tw-space" /><JsonKey k={k} /><span class="j-punc">{o}{c}</span>{comma}</div>;
  }
  const shown = Math.min(limit, count);
  const children = [];
  for (let i = 0; i < shown; i++) {
    const child = isArr ? node.items[i] : node.entries[i].value;
    children.push(
      <JsonNodeView key={i} k={isArr ? i : node.entries[i].keyRaw} node={child} depth={depth + 1} openDepth={openDepth}
        last={i === count - 1} />,
    );
  }
  return (
    <div class="j-node">
      <div class="j-row j-open" onClick={() => setOpen(!open)}>
        <button type="button" class="j-tw" aria-expanded={open} aria-label={open ? 'Collapse' : 'Expand'}
          onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} />
        </button>
        <JsonKey k={k} />
        <span class="j-punc">{o}</span>
        {!open && (
          <>
            <span class="j-sum">{isArr ? `${count} item${count === 1 ? '' : 's'}` : `${count} key${count === 1 ? '' : 's'}`}</span>
            <span class="j-punc">{c}</span>
            {comma}
          </>
        )}
      </div>
      {open && (
        <>
          <div class="j-children">
            {children}
            {count > limit && (
              <button type="button" class="link j-more" onClick={() => setLimit(limit + PAGE * 10)}>
                Show {Math.min(PAGE * 10, count - limit)} more of {count - limit} remaining…
              </button>
            )}
          </div>
          <div class="j-row"><span class="j-tw-space" /><span class="j-punc">{c}</span>{comma}</div>
        </>
      )}
    </div>
  );
}
