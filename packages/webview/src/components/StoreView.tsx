/**
 * v0.16.0 (CONTRACTS §22.11): a collection's remembered data, inside its expanded row.
 * - StoreLine: "Remembers what the app sends: users 10 · orders 2" with Reset data and Snapshots ▾.
 * - StoreDataPanel: the "Data" side of the Requests | Data switch — resources (remembers, id field, tags) and a
 *   capped table of the selected one (filter, Show more, JSON view, Edit / Delete / Add as JSON).
 * - Part 3 (CONTRACTS §24.1 / §24.3), also on the Data side: the sign-in row (a switch; when on, how many are signed
 *   in, how long tokens last, which requests need one, Sign everyone out) and the made-up values select.
 * Plain text only: records, names and values are never rendered as HTML. Words: "data", "for you", "for the team".
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { clipName } from '../collections';
import { useApp } from '../context';
import type { CollectionStatus, StoreAuthStatus, StorePatch, StoreResourceView, StoreStatus } from '../protocol';
import {
  AUTH_TTL, authOf, cellOf, DYNAMIC_OPTIONS, dynamicOf, parseRecordText, parseTtl, protectOf, recordId, recordsJsonText,
  recordsText, recordText, sessionsText, SIGN_IN_TIP, STORE_VIEW_LIMITS, storeColumns, storeItemsKey, storeSummaryText,
  teamStorePatch, ttlOf, type StoreItemsView,
} from '../store';
import { Button, MenuButton, type MenuItem } from './bits';

/** CONTRACTS §22.7: one explanation, shown as a tooltip on every "for you" data setting. */
const FOR_YOU_TIP = 'Only on this computer. Save for the team writes it to .vscode/flutter-intercept.json.';
const SNAPSHOT_TIP = 'Saved as a file under .vscode/flutter-intercept/snapshots — commit it to share the scenario with the team.';

function useStorePost(id: string) {
  const { post } = useApp();
  return {
    update: (patch: StorePatch) => post({ type: 'updateStore', id, patch }),
    snapshot: (action: 'save' | 'load' | 'delete', name?: string) =>
      post({ type: 'storeSnapshot', id, action, ...(name !== undefined ? { name } : {}) }),
  };
}

/** True when the expanded row has something to show on the Data side (data, sign-in, or made-up values). */
export function hasStoreData(store: StoreStatus | undefined): store is StoreStatus {
  return !!store && ((store.resources ?? []).length > 0 || (store.problems ?? []).length > 0
    || !!authOf(store) || dynamicOf(store) !== undefined);
}

// ------------------------------------------------------------------ the one line

export function StoreLine({ col, store }: { col: CollectionStatus; store: StoreStatus }) {
  const { update, snapshot } = useStorePost(col.id);
  const [confirmDelete, setConfirmDelete] = useState<string | undefined>();
  const snapshots = useMemo(() => [...new Set((store.snapshots ?? []).filter((n) => typeof n === 'string'))], [store.snapshots]);
  useEffect(() => {
    if (confirmDelete !== undefined && !snapshots.includes(confirmDelete)) setConfirmDelete(undefined);
  }, [snapshots, confirmDelete]);
  if (!(store.resources ?? []).length) return null;
  const summary = storeSummaryText(store);

  const items: MenuItem[] = [
    { label: 'Save…', title: SNAPSHOT_TIP, onSelect: () => snapshot('save') },
    ...snapshots.map((n, i) => ({
      label: `Load › ${clipName(n, 60)}`, separatorBefore: i === 0,
      title: `Replace the data with snapshot “${clipName(n, 60)}”`,
      onSelect: () => snapshot('load', n),
    })),
    ...snapshots.map((n, i) => ({
      label: `Delete › ${clipName(n, 60)}…`, separatorBefore: i === 0,
      title: `Delete the snapshot file “${clipName(n, 60)}” (asks here first)`,
      onSelect: () => setConfirmDelete(n),
    })),
  ];

  return (
    <div class="collection-note store-line">
      {store.enabled ? (
        <span class="store-summary">Remembers what the app sends: {summary ?? 'nothing (every kind of data is off)'}</span>
      ) : (
        <span class="store-summary">Answers come from the examples; what the app sends isn't remembered.</span>
      )}
      {store.startsFrom && (
        <span class="store-starts muted">
          starts from snapshot “{clipName(store.startsFrom, 60)}”{' '}
          <button type="button" class="link" title={FOR_YOU_TIP}
            onClick={() => update({ startsFrom: null, scope: 'me' })}>
            Start from the examples
          </button>
        </span>
      )}
      {store.enabled ? (
        <>
          <Button onClick={() => update({ reset: 'data' })} disabled={!store.changed}
            title={store.changed ? 'Put the data back to how it started' : 'Nothing has changed since it started'}>
            Reset data
          </Button>
          <MenuButton label={`Snapshots of ${clipName(col.name, 60)}`} title={SNAPSHOT_TIP} items={items} class="store-snapshots">
            Snapshots ▾
          </MenuButton>
        </>
      ) : (
        <Button onClick={() => update({ enabled: true, scope: 'me' })} title={FOR_YOU_TIP}>Remember data</Button>
      )}
      {confirmDelete !== undefined && (
        <div class="store-confirm" role="group" aria-label="Confirm deleting a snapshot">
          <span>Delete snapshot “{clipName(confirmDelete, 60)}”? Its file is removed from the project.</span>
          <Button kind="danger" onClick={() => { snapshot('delete', confirmDelete); setConfirmDelete(undefined); }}>Delete</Button>
          <Button onClick={() => setConfirmDelete(undefined)}>Cancel</Button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the Data side

export function StoreDataPanel({ col, store }: { col: CollectionStatus; store: StoreStatus }) {
  const { state } = useApp();
  const { update } = useStorePost(col.id);
  const resources = store.resources ?? [];
  const problems = store.problems ?? [];
  const [selected, setSelected] = useState<string | undefined>();
  const current = selected !== undefined ? resources.find((r) => r.name === selected) : undefined;
  useEffect(() => {
    if (selected !== undefined && !current) setSelected(undefined);
  }, [selected, current]);
  const displayName = clipName(col.name);
  const auth = authOf(store);
  const dynamic = dynamicOf(store);

  // CONTRACTS §21.15 / §22.7: "Save for the team" = the same settings with scope 'team', then clear this user's.
  // Sign-in (on, how long tokens last, which requests) and made-up values travel with it (§24.1 / §24.3).
  const saveForTeam = () => {
    update(teamStorePatch(store));
    for (const r of resources) {
      if (r.overridden) update({ resource: r.name, remembers: r.remembers, idField: r.idField, scope: 'team' });
    }
    update({ reset: 'settings', scope: 'me' });
  };

  return (
    <div class="collection-body store-body">
      <div class="store-head">
        <label class="check" title={FOR_YOU_TIP}>
          <input type="checkbox" checked={store.enabled}
            aria-label={`Remember what the app sends to ${displayName}, for me`}
            onChange={() => update({ enabled: !store.enabled, scope: 'me' })} />
          <span>Remember what the app sends <span class="muted">(for me)</span></span>
        </label>
      </div>
      {store.overridden && (
        <div class="collection-note store-overrides">
          <span title={FOR_YOU_TIP}>Data settings changed for you</span>
          <Button onClick={() => update({ reset: 'settings', scope: 'me' })} title="Put back the team's data settings">Reset</Button>
          <Button onClick={saveForTeam} title={FOR_YOU_TIP}>Save for the team</Button>
        </div>
      )}
      {auth && <SignInRow col={col} auth={auth} />}
      {dynamic && (
        <div class="store-setting store-dynamic">
          <label title={FOR_YOU_TIP}>
            <span>Made-up values (<code>{'{{$random…}}'}</code>):</span>
            <select value={dynamic} aria-label={`Made-up values in ${displayName}, for me`}
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                const opt = DYNAMIC_OPTIONS.find((o) => o.value === v);
                if (opt && opt.value !== dynamic) update({ dynamic: opt.value, scope: 'me' });
              }}>
              {DYNAMIC_OPTIONS.map((o) => <option key={o.value} value={o.value} title={o.title}>{o.label}</option>)}
            </select>
          </label>
        </div>
      )}
      {resources.length > 0 && (
        <ul class="store-resources" aria-label={`Data in ${displayName}`}>
          {resources.map((r) => (
            <ResourceRow key={r.name} col={col} r={r} selected={r.name === selected}
              keys={r.name === selected ? state.storeItems.get(storeItemsKey(col.id, r.name))?.items : undefined}
              onSelect={() => setSelected(r.name === selected ? undefined : r.name)} />
          ))}
        </ul>
      )}
      {problems.map((p, i) => <div key={i} class="store-problem muted">{clipName(p, 300)}</div>)}
      {current && (
        <StoreTable key={current.name} col={col} r={current}
          data={state.storeItems.get(storeItemsKey(col.id, current.name))} />
      )}
    </div>
  );
}

function ResourceRow({ col, r, selected, keys, onSelect }: {
  col: CollectionStatus; r: StoreResourceView; selected: boolean; keys?: unknown[]; onSelect: () => void;
}) {
  const { update } = useStorePost(col.id);
  const name = clipName(r.name);
  const [idDraft, setIdDraft] = useState(r.idField);
  useEffect(() => { setIdDraft(r.idField); }, [r.idField]);
  const fieldOptions = useMemo(() => (keys ? storeColumns(keys, r.idField) : []), [keys, r.idField]);
  const listId = `fi-store-id-${col.id}-${r.name}`.replace(/[^A-Za-z0-9_-]/g, '_');
  const commitId = () => {
    const v = idDraft.trim();
    if (!v || v.length > 100 || v === r.idField) { setIdDraft(r.idField); return; }
    update({ resource: r.name, idField: v, scope: 'me' });
  };
  return (
    <li class={`store-res${selected ? ' selected' : ''}${r.remembers ? '' : ' off'}`}>
      <div class="store-res-line">
        <button type="button" class="link store-res-name" aria-pressed={selected} title={r.name}
          aria-label={`${selected ? 'Hide' : 'Show'} the ${name} records`}
          onClick={onSelect}>
          {name}
        </button>
        <code class="store-res-path" title={r.path}>{clipName(r.path)}</code>
        <span class="store-res-count muted">{recordsText(r.count)}</span>
        <label class="check store-res-remembers" title={FOR_YOU_TIP}>
          <input type="checkbox" checked={r.remembers}
            aria-label={`${name} remembers what the app sends, for me`}
            onChange={() => update({ resource: r.name, remembers: !r.remembers, scope: 'me' })} />
          <span>remembers</span>
        </label>
        <label class="store-res-id" title={`The field that names one ${name} record (${FOR_YOU_TIP})`}>
          <span class="muted">id field</span>
          <input class="mono" value={idDraft} spellcheck={false} maxLength={100}
            list={fieldOptions.length ? listId : undefined}
            aria-label={`Id field of ${name}, for me`}
            onInput={(e) => setIdDraft((e.target as HTMLInputElement).value)}
            onChange={commitId}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitId(); }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setIdDraft(r.idField); }
            }} />
          {fieldOptions.length > 0 && (
            <datalist id={listId}>{fieldOptions.map((k) => <option key={k} value={k} />)}</datalist>
          )}
        </label>
        {r.overridden && <span class="badge mini ep-for-you" title={FOR_YOU_TIP}>changed for you</span>}
        {r.generatedSeed && (
          <span class="store-res-generated muted" title="The collection has no written example for it">made up from the schema</span>
        )}
      </div>
      {r.problem && <div class="store-problem muted">{clipName(r.problem, 300)}</div>}
    </li>
  );
}

// ------------------------------------------------------------------ sign-in (CONTRACTS §24.1)

/**
 * One row: "Sign-in: off — any login is accepted when on" with a switch. When on: how many are signed in, how long
 * tokens last, which requests need a token, and Sign everyone out. Counts only: never a password or a token.
 */
function SignInRow({ col, auth }: { col: CollectionStatus; auth: StoreAuthStatus }) {
  const { update } = useStorePost(col.id);
  const name = clipName(col.name);
  const on = auth.enabled === true;
  const ttl = ttlOf(auth);
  const protect = protectOf(auth);
  const sessions = typeof auth.sessions === 'number' && auth.sessions > 0 ? Math.floor(auth.sessions) : 0;
  const problems = (auth.problems ?? []).filter((p) => typeof p === 'string');
  const [ttlDraft, setTtlDraft] = useState(String(ttl));
  useEffect(() => { setTtlDraft(String(ttl)); }, [ttl]);
  const tipId = `fi-sign-in-tip-${col.id}`.replace(/[^A-Za-z0-9_-]/g, '_');
  const commitTtl = () => {
    const v = parseTtl(ttlDraft);
    if (v === undefined || v === ttl) { setTtlDraft(String(ttl)); return; }
    setTtlDraft(String(v));
    update({ auth: { ttlSeconds: v }, scope: 'me' });
  };
  const setProtect = (p: 'declared' | 'all') => { if (p !== protect) update({ auth: { protect: p }, scope: 'me' }); };
  const where = [auth.login, auth.refresh].filter((x): x is string => typeof x === 'string' && x !== '').map((x) => clipName(x, 120));
  const tip = where.length ? `${SIGN_IN_TIP} Sign-in request: ${where.join(' · refresh: ')}` : SIGN_IN_TIP;

  return (
    <div class={`store-setting store-auth${on ? ' on' : ''}`} role="group" aria-label={`Sign-in for ${name}`}>
      <label class="check store-auth-switch" title={tip}>
        <input type="checkbox" role="switch" checked={on} aria-describedby={tipId}
          aria-label={`Sign-in for ${name}, for me`}
          onChange={() => update({ auth: { enabled: !on }, scope: 'me' })} />
        <span>{on ? 'Sign-in: on — any login is accepted' : 'Sign-in: off — any login is accepted when on'}</span>
      </label>
      <span id={tipId} class="sr-only">{SIGN_IN_TIP}</span>
      {on && (
        <>
          <span class="store-auth-sessions">
            Signed in: {sessionsText(sessions)}
            {' · '}
            <label class="store-auth-ttl" title={`How long a token works before the app must refresh it or sign in again (${AUTH_TTL.min}–${AUTH_TTL.max} seconds). ${FOR_YOU_TIP}`}>
              tokens last{' '}
              <input type="number" class="mono" min={AUTH_TTL.min} max={AUTH_TTL.max} step={1} value={ttlDraft}
                aria-label={`Seconds a token lasts in ${name}, for me`}
                onInput={(e) => setTtlDraft((e.target as HTMLInputElement).value)}
                onChange={commitTtl}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitTtl(); }
                  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setTtlDraft(String(ttl)); }
                }} />
              {' '}s
            </label>
          </span>
          <span class="store-auth-protect">
            <span>Requests that need a token:</span>
            <span class="seg small" role="group" aria-label={`Requests that need a token in ${name}, for me`}>
              <button type="button" class="seg-btn" aria-pressed={protect === 'declared'}
                title={`Only the requests the collection says need signing in. ${FOR_YOU_TIP}`}
                onClick={() => setProtect('declared')}>
                those the collection marks
              </button>
              <button type="button" class="seg-btn" aria-pressed={protect === 'all'}
                title={`Every request except signing in, signing up and the like. ${FOR_YOU_TIP}`}
                onClick={() => setProtect('all')}>
                all
              </button>
            </span>
          </span>
          {/* CONTRACTS §24.1: a data change (no scope) — every token stops working, as if they all ran out. */}
          <Button onClick={() => update({ auth: { expire: 'all' } })}
            title="Every token stops working now, so the app has to refresh it or sign in again">
            Sign everyone out
          </Button>
        </>
      )}
      {problems.slice(0, 5).map((p, i) => <div key={i} class="store-problem muted">{clipName(p, 300)}</div>)}
    </div>
  );
}

// ------------------------------------------------------------------ the table

type Editing = { kind: 'edit'; itemId?: string; text: string } | { kind: 'add'; text: string };

export function StoreTable({ col, r, data }: { col: CollectionStatus; r: StoreResourceView; data: StoreItemsView | undefined }) {
  const { state, post } = useApp();
  const { update } = useStorePost(col.id);
  const name = clipName(r.name);
  const [filter, setFilter] = useState('');
  const [shown, setShown] = useState<number>(STORE_VIEW_LIMITS.rows);
  const [asJson, setAsJson] = useState(false);
  const [editing, setEditing] = useState<Editing | undefined>();
  const [error, setError] = useState<string | undefined>();
  const sentFilter = useRef<string | undefined>(undefined);
  const seq = useRef(state.snapshotSeq);

  const request = (offset: number, f = filter.trim()) => {
    sentFilter.current = f;
    post({ type: 'getStoreItems', id: col.id, resource: r.name, offset, ...(f ? { filter: f } : {}) });
  };

  // First page on open.
  useEffect(() => { request(0); }, []);
  // After a reconnect (fresh snapshot), ask again: the host pushes only for what was asked since `ready`.
  useEffect(() => {
    if (state.snapshotSeq === seq.current) return;
    seq.current = state.snapshotSeq;
    request(0);
  }, [state.snapshotSeq]);
  // The filter is the host's: debounced, from the first page.
  useEffect(() => {
    const f = filter.trim();
    if (f === (sentFilter.current ?? '')) return;
    const t = setTimeout(() => { setShown(STORE_VIEW_LIMITS.rows); request(0, f); }, STORE_VIEW_LIMITS.filterDebounceMs);
    return () => clearTimeout(t);
  }, [filter]);

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const rows = useMemo(() => items.slice(0, shown), [items, shown]);
  const columns = useMemo(() => storeColumns(items, r.idField), [items, r.idField]);
  // Records with no scalar field at all read better as JSON.
  const json = useMemo(() => (asJson || columns.length === 0 ? recordsJsonText(rows) : undefined), [asJson, columns, rows]);
  const remaining = Math.max(0, Math.min(total, STORE_VIEW_LIMITS.items) - rows.length);
  const showMore = () => {
    const next = shown + STORE_VIEW_LIMITS.rowsStep;
    if (next > items.length && items.length < total && items.length < STORE_VIEW_LIMITS.items) request(items.length);
    setShown(next);
  };

  const startEdit = (rec: unknown) => {
    setError(undefined);
    setEditing({ kind: 'edit', itemId: recordId(rec, r.idField), text: recordText(rec) });
  };
  const startAdd = () => {
    setError(undefined);
    setEditing({ kind: 'add', text: '{}' });
  };
  const save = () => {
    if (!editing) return;
    const parsed = parseRecordText(editing.text);
    if (!parsed.ok) { setError(parsed.message); return; }
    update({ resource: r.name, put: { item: parsed.item } });
    setEditing(undefined);
    setError(undefined);
  };
  const remove = (itemId: string) => update({ resource: r.name, remove: { itemId } });

  const filtering = filter.trim() !== '';
  const countText = data === undefined ? '' : filtering ? `${total} matching` : recordsText(total);

  return (
    <div class="store-table-box" role="region" aria-label={`${name} records`}>
      <div class="collection-ep-bar store-bar">
        <input type="search" class="collection-ep-filter store-filter" value={filter} spellcheck={false}
          placeholder={`Filter ${name}`} aria-label={`Filter ${name} records`}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
        <span class="muted store-count" aria-live="polite">{countText}</span>
        <span class="spacer" />
        <div class="seg small" role="group" aria-label={`Show ${name} as`}>
          <button type="button" class="seg-btn" aria-pressed={!asJson} onClick={() => setAsJson(false)}>Table</button>
          <button type="button" class="seg-btn" aria-pressed={asJson} onClick={() => setAsJson(true)}>JSON</button>
        </div>
        <Button onClick={startAdd} title={`Add a ${name} record`}>Add</Button>
      </div>

      {editing && (
        <form class="store-editor" aria-label={editing.kind === 'add' ? `New ${name} record` : `Edit ${name} ${clipName(editing.itemId ?? '', 100)}`}
          onSubmit={(e) => { e.preventDefault(); save(); }}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(undefined); } }}>
          <textarea class="mono store-editor-text" value={editing.text} spellcheck={false} rows={8}
            aria-label={editing.kind === 'add' ? `JSON of the new ${name} record` : `JSON of ${name} ${clipName(editing.itemId ?? '', 100)}`}
            aria-invalid={error ? true : undefined}
            onInput={(e) => { setEditing({ ...editing, text: (e.target as HTMLTextAreaElement).value }); setError(undefined); }} />
          {error && <div class="store-editor-error" role="alert">{error}</div>}
          <div class="store-editor-actions">
            <Button kind="primary" type="submit">{editing.kind === 'add' ? 'Add' : 'Save'}</Button>
            <Button onClick={() => { setEditing(undefined); setError(undefined); }}>Cancel</Button>
            <span class="muted">Changes the data only, never a file.</span>
          </div>
        </form>
      )}

      {data === undefined ? (
        <div class="muted pad" aria-busy="true">Loading {name}…</div>
      ) : items.length === 0 ? (
        <div class="muted pad store-empty">
          {filtering ? `No ${name} records match “${clipName(filter.trim(), 100)}”.` : `No ${name} records yet. What the app creates shows up here.`}
        </div>
      ) : json ? (
        <>
          <pre class="code store-json">{json.text}</pre>
          {json.cut && <div class="hint">Cut at 256 KB for display.</div>}
        </>
      ) : (
        <div class="store-table-scroll">
          <table class="store-table">
            <thead>
              <tr>
                {columns.map((c) => <th key={c} scope="col" title={c}>{clipName(c, 40)}</th>)}
                <th scope="col" class="store-actions-col"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((rec, i) => {
                const itemId = recordId(rec, r.idField);
                const label = itemId !== undefined ? `${name} ${clipName(itemId, 100)}` : `${name} row ${i + 1}`;
                return (
                  <tr key={itemId !== undefined ? `id:${itemId}` : `row:${i}`}>
                    {columns.map((c) => <td key={c}>{cellOf(rec, c)}</td>)}
                    <td class="store-actions">
                      <button type="button" class="link" aria-label={`Edit ${label}`} onClick={() => startEdit(rec)}>Edit</button>
                      <button type="button" class="link" aria-label={`Delete ${label}`} disabled={itemId === undefined}
                        title={itemId === undefined ? `This record has no ${clipName(r.idField, 60)}` : undefined}
                        onClick={() => itemId !== undefined && remove(itemId)}>Delete</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data !== undefined && remaining > 0 && (
        <div class="collection-ep-more">
          <Button onClick={showMore}>Show more ({remaining} more)</Button>
        </div>
      )}
    </div>
  );
}
