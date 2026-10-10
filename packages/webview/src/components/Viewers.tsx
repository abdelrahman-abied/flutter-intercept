import { createContext, type ComponentChildren } from 'preact';
import { useContext, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Body } from '../protocol';
import type { MutateOp } from '@flutter-intercept/proxy/types';
import { headersToRows } from '../state';
import {
  bodyByteLength, formatBytes, headerValue, isJsonContentType, type Headers,
} from '../util';
import { decodeJsonString, parseJsonLossless, validateJson, type JsonNode } from '../json';
import { childPath, everyItemPath, parsePath } from '../jsonpath';
import { MenuList, type MenuItem } from './bits';
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

/**
 * Field actions on a response body's JSON tree (CONTRACTS §10.5): a context menu on every field / element
 * ("Make null / Remove / Change value… in next responses") and marks on fields the model check flagged.
 */
export interface TreeFieldActions {
  /** For `set`, `valueJson` is the user's literal JSON text (sent byte-exact; `value` is its parsed form). */
  mutate: (path: string, op: MutateOp['op'], value?: unknown, valueJson?: string) => void;
  /** Set when mutating isn't offered for this body: the items are disabled with this as their title. */
  disabled?: string;
  /** Model-check findings by canonical path (see jsonpath.normalizePath). */
  marks?: Map<string, { severity: 'error' | 'warning'; message: string }>;
}

export function BodyView({ body, headers, fields }: { body: Body | undefined; headers: Headers | undefined; fields?: TreeFieldActions }) {
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
  return <TextBody text={body.text} declaredJson={isJsonContentType(ct)} meta={meta} fields={fields} />;
}

function TextBody({ text, declaredJson, meta, fields }: { text: string; declaredJson: boolean; meta: ComponentChildren; fields?: TreeFieldActions }) {
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
      {showTree ? <JsonTree value={tree!} fields={fields} /> : <pre class="code">{text}</pre>}
    </div>
  );
}

// ---------------------------------------------------------------- JSON tree

const PAGE = 100;
const EXPAND_ALL_DEPTH = 8;

/** Compact JSON text of a node, every token as sent (for "Change value…"). */
export function nodeText(node: JsonNode): string {
  if (node.t === 'obj') return `{${node.entries.map((e) => `${e.keyRaw}:${nodeText(e.value)}`).join(',')}}`;
  if (node.t === 'arr') return `[${node.items.map(nodeText).join(',')}]`;
  return node.raw;
}

/** The node at a concrete path (no wildcards) of a lossless tree; for duplicate keys the last one, like JSON.parse. */
export function nodeAt(root: JsonNode, path: string): JsonNode | undefined {
  let cur: JsonNode | undefined = root;
  for (const seg of parsePath(path)) {
    if (!cur) return undefined;
    if ('index' in seg) cur = cur.t === 'arr' ? cur.items[seg.index] : undefined;
    else if ('key' in seg) {
      const entries: { keyRaw: string; value: JsonNode }[] = cur.t === 'obj' ? cur.entries : [];
      let hit: JsonNode | undefined;
      for (const e of entries) if (decodeJsonString(e.keyRaw) === seg.key) hit = e.value;
      cur = hit;
    } else return undefined;
  }
  return cur;
}

interface TreeCtx {
  fields?: TreeFieldActions;
  editing?: { path: string; initial: string };
  closeEditor: () => void;
}
const TreeContext = createContext<TreeCtx>({ closeEditor: () => {} });

const ROW_SEL = '.j-row[data-path]';

export function JsonTree({ value, fields }: { value: JsonNode; fields?: TreeFieldActions }) {
  const [openDepth, setOpenDepth] = useState(2);
  const [gen, setGen] = useState(0);
  const [menu, setMenu] = useState<{ path: string; node: JsonNode; row: HTMLElement; at: { x: number; y: number } } | undefined>();
  const [editing, setEditing] = useState<{ path: string; initial: string } | undefined>();
  const ref = useRef<HTMLDivElement>(null);
  const set = (d: number) => { setOpenDepth(d); setGen(gen + 1); };
  const expandable = value.t === 'obj' || value.t === 'arr';

  const ctx = useMemo<TreeCtx>(() => ({ fields, editing, closeEditor: () => setEditing(undefined) }), [fields, editing]);
  /** Rows only carry their path; the node is looked up when the menu opens (no per-row listeners). */
  const openMenu = (row: HTMLElement, at?: { x: number; y: number }) => {
    const path = row.dataset.path!;
    const node = nodeAt(value, path);
    if (!node) return;
    const r = row.getBoundingClientRect();
    setMenu({ path, node, row, at: at ?? { x: r.left + 24, y: r.bottom } });
  };
  const onContextMenu = (e: MouseEvent) => {
    const row = fields && (e.target as HTMLElement).closest<HTMLElement>(ROW_SEL);
    if (!row) return;
    e.preventDefault();
    openMenu(row, { x: e.clientX, y: e.clientY });
  };

  const rows = () => Array.from(ref.current?.querySelectorAll<HTMLElement>(ROW_SEL) ?? []);
  const onKeyDown = (e: KeyboardEvent) => {
    if (!fields) return;
    const target = e.target as HTMLElement;
    if (target.closest('input,textarea,.menu')) return;
    const list = rows();
    const i = list.indexOf(target);
    let next = -1;
    switch (e.key) {
      case 'ArrowDown': next = i < 0 ? 0 : Math.min(i + 1, list.length - 1); break;
      case 'ArrowUp': next = i < 0 ? 0 : Math.max(i - 1, 0); break;
      case 'Home': next = 0; break;
      case 'End': next = list.length - 1; break;
      case 'ContextMenu':
      case 'F10': {
        if (e.key === 'F10' && !e.shiftKey) return;
        const row = i >= 0 ? list[i] : undefined;
        if (!row) return;
        e.preventDefault();
        openMenu(row);
        return;
      }
      default: return;
    }
    if (i < 0 && target !== ref.current) return;
    e.preventDefault();
    list[next]?.focus();
  };

  const items: MenuItem[] = [];
  if (menu && fields) {
    const off = fields.disabled;
    const every = everyItemPath(menu.path);
    const m = (label: string, run: () => void, extra: Partial<MenuItem> = {}): MenuItem =>
      ({ label, onSelect: run, separatorBefore: extra.separatorBefore, disabled: !!off, title: off ?? extra.title });
    items.push(
      m('Make null in next responses', () => fields.mutate(menu.path, 'null'), { title: `${menu.path} → null` }),
      m('Remove from next responses', () => fields.mutate(menu.path, 'delete'), { title: `Remove ${menu.path}` }),
      m('Change value…', () => setEditing({ path: menu.path, initial: nodeText(menu.node) }), { title: `Set ${menu.path} to a JSON value` }),
    );
    if (every) {
      items.push(
        m('Make null in every item', () => fields.mutate(every, 'null'), { title: `${every} → null`, separatorBefore: true }),
        m('Remove from every item', () => fields.mutate(every, 'delete'), { title: `Remove ${every}` }),
      );
    }
    items.push({ label: 'Copy JSON path', onSelect: () => copyText(menu.path), title: menu.path, separatorBefore: true });
  }

  return (
    <TreeContext.Provider value={ctx}>
      <div ref={ref} class={`json-tree code${fields ? ' with-fields' : ''}`} onKeyDown={onKeyDown} onContextMenu={onContextMenu}
        tabIndex={fields ? 0 : undefined}
        aria-label={fields ? 'Response JSON. Arrow keys move between fields; Shift+F10 opens the field menu.' : undefined}>
        {expandable && (
          <div class="json-tools">
            <button type="button" class="link" onClick={() => set(EXPAND_ALL_DEPTH)}>Expand all</button>
            <button type="button" class="link" onClick={() => set(1)}>Collapse all</button>
            {fields && <span class="j-hint">Right-click a field to change it in the next responses</span>}
          </div>
        )}
        <JsonNodeView key={gen} node={value} depth={0} openDepth={openDepth} last path="$" />
      </div>
      {menu && (
        <MenuList label={`Field ${menu.path}`} items={items} at={menu.at}
          onClose={(restore) => { const row = menu.row; setMenu(undefined); if (restore && row.isConnected) row.focus(); }} />
      )}
    </TreeContext.Provider>
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

/** Props that make a row a field-menu target (only below the root, only when field actions are on). */
function useRowProps(path: string) {
  const t = useContext(TreeContext);
  if (!t.fields || path === '$') return { props: {}, mark: undefined, t };
  const mark = t.fields.marks?.get(path);
  return {
    t,
    mark,
    props: {
      'data-path': path,
      tabIndex: -1,
      title: mark ? `${mark.severity === 'error' ? 'Model check error' : 'Model check warning'}: ${mark.message}` : undefined,
    },
  };
}

function markClass(mark: { severity: string } | undefined): string {
  return mark ? ` j-mark j-mark-${mark.severity}` : '';
}

function JsonNodeView({ k, node, depth, openDepth, last, path }: {
  k?: string | number; node: JsonNode; depth: number; openDepth: number; last: boolean; path: string;
}) {
  const [open, setOpen] = useState(depth < openDepth);
  const [limit, setLimit] = useState(PAGE);
  const { props, mark, t } = useRowProps(path);
  const comma = last ? null : <span class="j-punc">,</span>;
  const editor = t.editing?.path === path && t.fields
    ? <ValueEditor path={path} initial={t.editing.initial} onCancel={t.closeEditor}
        onApply={(v, text) => { t.closeEditor(); t.fields!.mutate(path, 'set', v, text); }} />
    : null;

  if (node.t !== 'obj' && node.t !== 'arr') {
    return (
      <>
        <div class={`j-row${markClass(mark)}`} {...props}><span class="j-tw-space" /><JsonKey k={k} /><Scalar node={node} />{comma}</div>
        {editor}
      </>
    );
  }
  const isArr = node.t === 'arr';
  const count = isArr ? node.items.length : node.entries.length;
  const [o, c] = isArr ? ['[', ']'] : ['{', '}'];
  if (!count) {
    return (
      <>
        <div class={`j-row${markClass(mark)}`} {...props}><span class="j-tw-space" /><JsonKey k={k} /><span class="j-punc">{o}{c}</span>{comma}</div>
        {editor}
      </>
    );
  }
  const shown = Math.min(limit, count);
  const children = [];
  for (let i = 0; i < shown; i++) {
    const child = isArr ? node.items[i] : node.entries[i].value;
    const childPathStr = t.fields ? childPath(path, isArr ? i : decodeJsonString(node.entries[i].keyRaw)) : path;
    children.push(
      <JsonNodeView key={i} k={isArr ? i : node.entries[i].keyRaw} node={child} depth={depth + 1} openDepth={openDepth}
        last={i === count - 1} path={childPathStr} />,
    );
  }
  return (
    <div class="j-node">
      <div class={`j-row j-open${markClass(mark)}`} {...props} onClick={() => setOpen(!open)}>
        <button type="button" class="j-tw" aria-expanded={open} aria-label={open ? 'Collapse' : 'Expand'} tabIndex={t.fields ? -1 : undefined}
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
      {editor}
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

/**
 * Inline "Change value…" input: any JSON value, validated; Enter applies, Escape cancels. The literal text is
 * passed on (valueJson) so `1.0`, `-0` or 12345678901234567890 reach the app exactly as typed.
 */
export function ValueEditor({ path, initial, onApply, onCancel }: {
  path: string; initial: string; onApply: (value: unknown, valueJson: string) => void; onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const check = text.trim() ? validateJson(text) : undefined;
  const error = !text.trim() ? 'Enter a JSON value, e.g. "text", 42, true, null, [] or {}' : check && !check.ok ? `Not valid JSON (column ${check.column}): ${check.message}` : undefined;
  const apply = () => { if (!error) onApply(JSON.parse(text), text.trim()); };
  return (
    <div class="j-edit" role="group" aria-label={`New value for ${path}`}>
      <div class="j-edit-line">
        <code class="j-edit-path">{path} =</code>
        <textarea ref={ref} class="j-edit-input mono" rows={text.length > 60 || text.includes('\n') ? 3 : 1} spellcheck={false}
          aria-label={`JSON value for ${path}`} aria-invalid={!!error} value={text}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); apply(); }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
          }} />
        <button type="button" class="btn btn-primary" disabled={!!error} onClick={apply}>Apply to next responses</button>
        <button type="button" class="btn btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
      {error && text.trim() && <div class="msg error">{error}</div>}
    </div>
  );
}
