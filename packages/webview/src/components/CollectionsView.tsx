/**
 * v0.15.0 (CONTRACTS §21.9): the Collections section — mock requests from Postman collections or OpenAPI 3
 * documents. Personal on/off, unmatched passthrough/fail switch, inline unresolved-variable inputs, endpoint
 * browser grouped by folder, case-insensitive filter, example picker, read-only example viewer, and "Edit as a rule".
 * v0.16.0 parts 2 and 3 (CONTRACTS §23.2 – §23.4, §24.2, §24.4): "Make a fake backend from this session", the
 * "Out of date: …" line and tag, examples that answer by what the request sends, and the source badges.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  activeExampleOf, byBodyHint, byBodyLine, clipName, COLLECTION_LIMITS, collectionCountsText, collectionExampleCacheKey,
  ENDPOINT_INITIAL_CAP, ENDPOINT_PAGE_STEP, exchangeForSeen, FAKE_BACKEND_NOTHING, FAKE_BACKEND_SESSION, FAKE_BACKEND_TIP,
  filterEndpoints, formatExampleBody, formatLabel, groupEndpointsByFolder, hasFinishedRequest,
  knownRequestOrigins, limitedText, overridesText, seenSummaryText, statusClassSuffix, type CollectionExampleView,
} from '../collections';
import { useApp } from '../context';
import { driftCountText, driftLineText, driftsOf } from '../drift';
import type { CollectionEndpointView, CollectionPatch, CollectionStatus, DriftView } from '../protocol';
import { Button, MenuButton } from './bits';
import { Icon } from './Icon';
import { OutOfDateDetails, OutOfDateList } from './OutOfDate';
import { hasStoreData, StoreDataPanel, StoreLine } from './StoreView';
import { copyText, HeadersTable } from './Viewers';

const EXPLAIN_LINE_1 =
  'No collections yet. Point Flutter Intercept at a Postman collection or OpenAPI 3 file to answer requests locally from saved examples — no test server needed.';
const EXPLAIN_LINE_2 =
  'The link lives in .vscode/flutter-intercept.json for your team. What you change here (on or off, which example answers) stays on this computer until you choose Save for the team. Your rules still run first.';
/** CONTRACTS §21.15: one explanation, shown as a tooltip on every "for you" control. */
const FOR_YOU_TIP = 'Only on this computer. Save for the team writes it to .vscode/flutter-intercept.json.';
const NO_DRIFT: DriftView[] = [];

export function CollectionsView() {
  const { state, dispatch, post } = useApp();
  const collections = state.status.collections ?? [];
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());
  // CONTRACTS §23.2: collections whose "Out of date" line is open (it lists endpoints, so it needs them too).
  const [driftIds, setDriftIds] = useState<Set<string>>(() => new Set());
  // CONTRACTS §23.2: a fake backend needs at least one finished request the real server answered.
  const canFake = useMemo(() => hasFinishedRequest(state.exchanges), [state.exchanges]);
  const fakeFromSession = () => {
    dispatch({ type: 'awaitFakeBackend' });
    post({ type: 'mockFromTraffic', source: 'session' });
  };
  const origins = useMemo(() => knownRequestOrigins(state.exchanges), [state.exchanges]);
  const lastSnapshotSeq = useRef(state.snapshotSeq);

  // CONTRACTS §21.8: after a reconnect (`ready` → fresh `snapshot`), re-request endpoints for expanded collections only.
  useEffect(() => {
    if (state.snapshotSeq === lastSnapshotSeq.current) return;
    lastSnapshotSeq.current = state.snapshotSeq;
    if (!openIds.size && !driftIds.size) return;
    const live = new Set(collections.map((c) => c.id));
    for (const id of new Set([...openIds, ...driftIds])) {
      if (live.has(id)) {
        dispatch({ type: 'collectionRequested', id });
        post({ type: 'getCollectionEndpoints', id });
      }
    }
  }, [state.snapshotSeq]);

  // Prune removed ids from openIds / driftIds when collections disappear (or are no longer out of date).
  useEffect(() => {
    if (!openIds.size && !driftIds.size) return;
    const live = new Set(collections.map((c) => c.id));
    const stale = new Set(collections.filter((c) => !c.drift).map((c) => c.id));
    const keep = (ids: Set<string>, ok: (id: string) => boolean) => {
      for (const id of ids) if (!ok(id)) return new Set([...ids].filter(ok));
      return ids;
    };
    const nextOpen = keep(openIds, (id) => live.has(id));
    if (nextOpen !== openIds) setOpenIds(nextOpen);
    const nextDrift = keep(driftIds, (id) => live.has(id) && !stale.has(id));
    if (nextDrift !== driftIds) setDriftIds(nextDrift);
  }, [collections]);

  // CONTRACTS §21.8: request once per collection since the last `ready`; host pushes updates on its own.
  const needEndpoints = (id: string) => {
    if (state.collectionRequested.has(id)) return;
    dispatch({ type: 'collectionRequested', id });
    post({ type: 'getCollectionEndpoints', id });
  };
  const toggleIn = (ids: Set<string>, set: (next: Set<string>) => void, id: string) => {
    const next = new Set(ids);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
      needEndpoints(id);
    }
    set(next);
  };
  const toggleOpen = (id: string) => toggleIn(openIds, setOpenIds, id);
  const toggleDrift = (id: string) => toggleIn(driftIds, setDriftIds, id);

  return (
    <div class="collections-view">
      <div class="rules-head">
        <span class="muted">
          Answer requests from a Postman, OpenAPI, Swagger, Insomnia or Bruno collection — your rules still run first.
        </span>
        <span class="spacer" />
        <Button kind="primary" onClick={() => post({ type: 'importCollection' })}
          title="Import a Postman collection or OpenAPI 3 document">
          <Icon name="plus" /> Mock from a collection…
        </Button>
        {collections.length > 0 && (
          <MenuButton label="More ways to mock" title="More ways to mock" class="collection-more"
            items={[{
              label: FAKE_BACKEND_SESSION, disabled: !canFake, title: canFake ? FAKE_BACKEND_TIP : FAKE_BACKEND_NOTHING,
              onSelect: fakeFromSession,
            }]}>
            More <Icon name="chevronDown" />
          </MenuButton>
        )}
      </div>
      {collections.length === 0 ? (
        <div class="empty small collection-empty">
          <p>{EXPLAIN_LINE_1}</p>
          <p class="muted">{EXPLAIN_LINE_2}</p>
          <div class="collection-empty-actions">
            <Button kind="primary" onClick={() => post({ type: 'importCollection' })}>
              <Icon name="plus" /> Mock from a collection…
            </Button>
            {/* CONTRACTS §23.2: no collection file? The traffic the app already made is enough. */}
            <Button onClick={fakeFromSession} disabled={!canFake} title={canFake ? FAKE_BACKEND_TIP : FAKE_BACKEND_NOTHING}>
              {FAKE_BACKEND_SESSION}
            </Button>
          </div>
        </div>
      ) : (
        <ul class="collection-items" aria-label="Collections">
          {collections.map((col) => (
            <CollectionRow
              key={col.id}
              col={col}
              open={openIds.has(col.id)}
              onToggleOpen={() => toggleOpen(col.id)}
              showDrift={driftIds.has(col.id)}
              onToggleDrift={() => toggleDrift(col.id)}
              endpoints={state.collectionEndpoints.get(col.id)}
              origins={origins}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function CollectionRow({ col, open, onToggleOpen, showDrift, onToggleDrift, endpoints, origins }: {
  col: CollectionStatus;
  open: boolean;
  onToggleOpen: () => void;
  showDrift: boolean;
  onToggleDrift: () => void;
  endpoints: CollectionEndpointView[] | undefined;
  origins: string[];
}) {
  const { post } = useApp();
  const displayName = clipName(col.name);
  const [editingVar, setEditingVar] = useState<string | undefined>();
  const [showSeen, setShowSeen] = useState(false);
  const [saveWhenLoaded, setSaveWhenLoaded] = useState(false);
  // CONTRACTS §22.11: Requests (the endpoints) | Data (what the collection remembers).
  const [side, setSide] = useState<'requests' | 'data'>('requests');
  const store = hasStoreData(col.store) ? col.store : undefined;
  const showData = side === 'data' && !!store;
  const limited = limitedText(col.limited);
  const overrides = overridesText(col.overrides);
  const seen = seenSummaryText(col.seen);
  const outOfDate = driftLineText(col.drift);
  const format = formatLabel(col.format);
  const unresolved = col.unresolved ?? [];
  const problems = col.problems ?? [];
  const colOrigins = col.origins ?? [];

  // Close inline variable form once the host resolves that variable.
  useEffect(() => {
    if (editingVar !== undefined && !unresolved.includes(editingVar)) setEditingVar(undefined);
  }, [editingVar, unresolved]);

  const update = (patch: CollectionPatch) => post({ type: 'updateCollection', id: col.id, patch });

  // CONTRACTS §21.15: "Save for the team" = the same changes with scope 'team', then clear this user's overlay.
  const saveForTeam = (eps: readonly CollectionEndpointView[]) => {
    for (const ep of eps) {
      if (!ep.overridden) continue;
      if (ep.selected !== undefined) update({ example: { endpoint: ep.key, name: ep.selected }, scope: 'team' });
      update({ off: { endpoint: ep.key, off: !!ep.off }, scope: 'team' });
    }
    update({ unmatched: col.unmatched, scope: 'team' });
    update({ reset: true, scope: 'me' });
  };
  const onSaveForTeam = () => {
    if (endpoints) return saveForTeam(endpoints);
    setSaveWhenLoaded(true); // the endpoints say which changes are yours: load them first
    if (!open) onToggleOpen();
  };
  useEffect(() => {
    if (saveWhenLoaded && endpoints) {
      setSaveWhenLoaded(false);
      saveForTeam(endpoints);
    }
  }, [saveWhenLoaded, endpoints]);

  return (
    <li class={`collection-item${col.enabled ? '' : ' disabled'}${problems.length ? ' has-problem' : ''}${open ? ' open' : ''}`}>
      <div class="collection-line">
        <Button kind="icon" class="collection-toggle-open"
          title={open ? `Collapse ${displayName}` : `Expand ${displayName}`}
          expanded={open}
          onClick={onToggleOpen}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} />
        </Button>
        <label class="check collection-enabled" title="On or off for you only (stored locally; never changes the shared file)">
          <input type="checkbox" checked={col.enabled} aria-label={`Enable ${displayName} for me`}
            onChange={() => update({ enabled: !col.enabled })} />
          <span>{col.enabled ? 'On' : 'Off'} <span class="muted">(for me)</span></span>
        </label>
        <div class="collection-main">
          <div class="collection-name">
            <button type="button" class="collection-title-btn" aria-expanded={open} onClick={onToggleOpen}>
              <span class="collection-title" title={col.name}>{displayName}</span>
            </button>
            {format && <span class="badge mini collection-format">{format}</span>}
            {problems.length > 0 && (
              <span class="badge warn collection-problem-badge">{problems.length} problem{problems.length === 1 ? '' : 's'}</span>
            )}
          </div>
          <div class="collection-sub">
            <span class="collection-counts">{collectionCountsText(col)}</span>
            {col.file && <> · <code class="collection-file" title={col.file}>{col.file}</code></>}
            {colOrigins.length > 0 && (
              <> · <span class="collection-origins" title={colOrigins.join('\n')}>{colOrigins.join(', ')}</span></>
            )}
          </div>
        </div>
        <div class="collection-unmatched">
          <span class="muted collection-unmatched-label">Not in the collection:</span>
          <div class="seg small" role="group" aria-label={`Not in the collection for ${displayName}`}>
            <button type="button" class="seg-btn" aria-pressed={col.unmatched === 'passthrough'}
              title="Requests not in the collection go to the real server"
              onClick={() => { if (col.unmatched !== 'passthrough') update({ unmatched: 'passthrough', scope: 'me' }); }}>
              Real server
            </button>
            <button type="button" class="seg-btn" aria-pressed={col.unmatched === 'fail'}
              title="Requests not in the collection fail like offline"
              onClick={() => { if (col.unmatched !== 'fail') update({ unmatched: 'fail', scope: 'me' }); }}>
              Fail
            </button>
          </div>
        </div>
        <div class="collection-actions">
          {/* CONTRACTS §21.6 / §21.9: the IDE asks for confirmation natively, never the panel. */}
          <Button kind="danger" onClick={() => post({ type: 'removeCollection', id: col.id })}
            title={`Remove ${displayName} (asks to confirm; the collection file is kept)`}>
            Remove
          </Button>
        </div>
      </div>

      {outOfDate && (
        // CONTRACTS §23.2: one calm line; what changed (and what to do about it) opens under it.
        <div class="collection-note collection-drift">
          <button type="button" class="link" aria-expanded={showDrift} onClick={onToggleDrift}
            title="The real server's answers no longer look like the saved examples. Show what changed.">
            {outOfDate}
          </button>
          {showDrift && <OutOfDateList col={col} endpoints={endpoints} />}
        </div>
      )}

      {limited && (
        // CONTRACTS §21.16: one calm line; the IDE shows what changes and asks (never the panel).
        <div class="collection-note collection-limited">
          <span>{limited}</span>
          <Button onClick={() => post({ type: 'approveCollection', id: col.id })}
            title="See which answers are limited and approve the full answers">
            Review &amp; approve
          </Button>
        </div>
      )}

      {overrides && (
        <div class="collection-note collection-overrides">
          <span title={FOR_YOU_TIP}>{overrides}</span>
          <Button onClick={() => update({ reset: true, scope: 'me' })} title="Put back the team's settings for this collection">
            Reset
          </Button>
          <Button onClick={onSaveForTeam} disabled={saveWhenLoaded} title={FOR_YOU_TIP}>
            Save for the team
          </Button>
        </div>
      )}

      {seen && (
        <div class="collection-note collection-seen">
          <button type="button" class="link" aria-expanded={showSeen} onClick={() => setShowSeen(!showSeen)}
            title="Requests the app sent to this collection's servers since the proxy started">
            {seen}
          </button>
          {showSeen && <SeenList col={col} />}
        </div>
      )}

      {unresolved.length > 0 && (
        <div class="collection-vars" aria-label={`Unresolved variables in ${displayName}`}>
          {unresolved.map((v) => (
            editingVar === v ? (
              <VariableForm
                key={v}
                collectionId={col.id}
                name={v}
                origins={origins}
                onSubmit={(value) => {
                  update({ variable: { name: v, value } });
                  setEditingVar(undefined);
                }}
                onCancel={() => setEditingVar(undefined)}
              />
            ) : (
              <Button key={v} onClick={() => setEditingVar(v)}
                title={`Set variable ${clipName(v)} used in this collection's URLs`}>
                Set {clipName(v)}…
              </Button>
            )
          ))}
        </div>
      )}

      {problems.length > 0 && (
        <ul class="msg warn collection-problems" aria-label={`Problems in ${displayName}`}>
          {problems.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      )}

      {open && store && <StoreLine col={col} store={store} />}
      {open && store && (
        <div class="collection-note collection-side">
          <div class="seg small" role="group" aria-label={`Show the requests or the data of ${displayName}`}>
            <button type="button" class="seg-btn" aria-pressed={!showData} onClick={() => setSide('requests')}>Requests</button>
            <button type="button" class="seg-btn" aria-pressed={showData} onClick={() => setSide('data')}>Data</button>
          </div>
        </div>
      )}
      {open && (showData && store
        ? <StoreDataPanel col={col} store={store} />
        : <CollectionEndpointsPanel col={col} endpoints={endpoints} />)}
    </li>
  );
}

function VariableForm({ collectionId, name, origins, onSubmit, onCancel }: {
  collectionId: string;
  name: string;
  origins: string[];
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { inputRef.current?.focus(); }, []);
  const trimmed = value.trim();
  const displayVar = clipName(name);
  const listId = `fi-col-origins-${collectionId}`;
  return (
    <form class="collection-var-form" aria-label={`Set ${displayVar}`}
      onSubmit={(e) => { e.preventDefault(); if (trimmed) onSubmit(trimmed); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); } }}>
      <label class="collection-var-label">
        <span>{displayVar}</span>
        <input ref={inputRef} class="mono" value={value} spellcheck={false}
          list={origins.length ? listId : undefined}
          placeholder="https://api.example.com"
          aria-label={`Value for ${displayVar}`}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)} />
      </label>
      {origins.length > 0 && (
        <datalist id={listId}>
          {origins.map((o) => <option key={o} value={o} />)}
        </datalist>
      )}
      <Button kind="primary" type="submit" disabled={!trimmed}>Save</Button>
      <Button onClick={onCancel}>Cancel</Button>
    </form>
  );
}

function CollectionEndpointsPanel({ col, endpoints }: {
  col: CollectionStatus;
  endpoints: CollectionEndpointView[] | undefined;
}) {
  const { state, dispatch, post } = useApp();
  const displayName = clipName(col.name);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(ENDPOINT_INITIAL_CAP);
  const [viewing, setViewing] = useState<{ endpoint: string; name: string } | undefined>();

  const filtered = useMemo(() => (endpoints ? filterEndpoints(endpoints, query) : []), [endpoints, query]);
  const shown = useMemo(() => filtered.slice(0, limit), [filtered, limit]);
  const groups = useMemo(() => groupEndpointsByFolder(shown), [shown]);

  const onFilterInput = (next: string) => {
    setQuery(next);
    setLimit(ENDPOINT_INITIAL_CAP);
  };

  if (endpoints === undefined) {
    return <div class="collection-body muted pad" aria-busy="true">Loading endpoints…</div>;
  }
  if (endpoints.length === 0) {
    return <div class="collection-body muted pad">This collection has no endpoints.</div>;
  }

  const toggleEndpoint = (ep: CollectionEndpointView) => {
    const off = !ep.off;
    dispatch({ type: 'patchCollectionEndpoint', id: col.id, patch: { off: { endpoint: ep.key, off } } });
    post({ type: 'updateCollection', id: col.id, patch: { off: { endpoint: ep.key, off }, scope: 'me' } });
  };

  const selectExample = (epKey: string, name: string) => {
    dispatch({ type: 'patchCollectionEndpoint', id: col.id, patch: { example: { endpoint: epKey, name } } });
    post({ type: 'updateCollection', id: col.id, patch: { example: { endpoint: epKey, name }, scope: 'me' } });
    if (viewing?.endpoint === epKey) {
      setViewing({ endpoint: epKey, name });
      post({ type: 'getCollectionExample', id: col.id, endpoint: epKey, name });
    }
  };

  const toggleViewExample = (epKey: string, exampleName: string) => {
    if (viewing?.endpoint === epKey && viewing.name === exampleName) {
      setViewing(undefined);
      return;
    }
    setViewing({ endpoint: epKey, name: exampleName });
    post({ type: 'getCollectionExample', id: col.id, endpoint: epKey, name: exampleName });
  };

  const resetEndpoint = (epKey: string) => {
    post({ type: 'updateCollection', id: col.id, patch: { reset: true, endpoint: epKey, scope: 'me' } });
  };

  const editAsRule = (epKey: string) => {
    dispatch({ type: 'awaitRule', kind: 'mock' });
    post({ type: 'collectionToRule', id: col.id, endpoint: epKey });
  };

  const showFolderHeaders = !(groups.length === 1 && groups[0].key === '');

  return (
    <div class="collection-body">
      <div class="collection-ep-bar">
        <input type="search" class="collection-ep-filter" value={query} spellcheck={false}
          placeholder="Filter by method, URL, or name"
          aria-label={`Filter endpoints in ${displayName}`}
          onInput={(e) => onFilterInput((e.target as HTMLInputElement).value)} />
        {query.trim() && (
          <Button kind="icon" title="Clear endpoint filter" onClick={() => onFilterInput('')}>
            <Icon name="close" />
          </Button>
        )}
        <span class="muted collection-ep-count">
          {query.trim()
            ? `${filtered.length} of ${endpoints.length} matching`
            : `${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div class="empty small">
          <p>No endpoints match “{query.trim()}”.</p>
          <Button onClick={() => onFilterInput('')}>Clear filter</Button>
        </div>
      ) : (
        <>
          {groups.map((g) => (
            <div key={g.key} class="ep-folder">
              {showFolderHeaders && (
                <div class="ep-folder-head">
                  <span class="ep-folder-name">{g.label}</span>
                  <span class="muted"> ({g.endpoints.length})</span>
                </div>
              )}
              <ul class="ep-items" aria-label={showFolderHeaders ? `Folder ${g.label}` : `Endpoints in ${displayName}`}>
                {g.endpoints.map((ep) => {
                  const active = activeExampleOf(ep);
                  const isViewing = viewing?.endpoint === ep.key;
                  const exData = isViewing
                    ? state.collectionExamples.get(collectionExampleCacheKey(col.id, ep.key, viewing.name))
                    : undefined;
                  return (
                    <EndpointRow
                      key={ep.key}
                      col={col}
                      ep={ep}
                      active={active}
                      viewing={isViewing}
                      viewingName={isViewing ? viewing.name : undefined}
                      exData={exData}
                      onToggle={() => toggleEndpoint(ep)}
                      onSelectExample={(name) => selectExample(ep.key, name)}
                      onView={() => active && toggleViewExample(ep.key, active.name)}
                      onEditAsRule={() => editAsRule(ep.key)}
                      onReset={() => resetEndpoint(ep.key)}
                      onCloseView={() => setViewing(undefined)}
                    />
                  );
                })}
              </ul>
            </div>
          ))}
          {filtered.length > shown.length && (
            <div class="collection-ep-more">
              <Button onClick={() => setLimit(limit + ENDPOINT_PAGE_STEP)}>
                Show more ({filtered.length - shown.length} remaining)
              </Button>
              <Button onClick={() => setLimit(filtered.length)}>
                Show all ({filtered.length})
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function EndpointRow({ col, ep, active, viewing, viewingName, exData, onToggle, onSelectExample, onView, onEditAsRule, onReset, onCloseView }: {
  col: CollectionStatus;
  ep: CollectionEndpointView;
  active: CollectionEndpointView['examples'][number] | undefined;
  viewing: boolean;
  viewingName?: string;
  exData?: CollectionExampleView;
  onToggle: () => void;
  onSelectExample: (name: string) => void;
  onView: () => void;
  onEditAsRule: () => void;
  onReset: () => void;
  onCloseView: () => void;
}) {
  const displayName = clipName(ep.name);
  const examples = (ep.examples ?? []).slice(0, COLLECTION_LIMITS.examplesPerEndpoint);
  const unresolved = ep.unresolved ?? [];
  // CONTRACTS §23.3: the real server's answers no longer look like this endpoint's examples.
  const drifts = useMemo(() => (ep.drift ? driftsOf(ep) : NO_DRIFT), [ep.drift]);
  const [showDrift, setShowDrift] = useState(false);
  // CONTRACTS §24.2: other examples that answer by what the request sends (field names only).
  const bodyLine = useMemo(
    () => (examples.some((e) => e.byBody) ? byBodyLine(ep, active?.name) : undefined),
    [ep.examples, active?.name],
  );
  const activeHint = active?.byBody ? byBodyHint(active.byBody) : undefined;

  return (
    <li class={`ep-item${ep.off ? ' ep-off' : ''}${unresolved.length ? ' ep-unresolved' : ''}`}>
      <div class="ep-line">
        <input type="checkbox" checked={!ep.off}
          aria-label={`Enable ${ep.method} ${clipName(ep.url || ep.name || ep.key)}`}
          title={ep.off ? 'Turn on mocking for this endpoint' : 'Turn off mocking for this endpoint'}
          onChange={onToggle} />
        <span class="ep-method">{ep.method}</span>
        <code class="ep-url" title={ep.url}>{ep.url}</code>
        {ep.name && <span class="ep-name" title={ep.name}>{displayName}</span>}
        {unresolved.length > 0 && (
          <span class="badge warn ep-unresolved-badge" title={`Set ${unresolved.join(', ')} to mock this endpoint`}>
            needs {unresolved.map((u) => clipName(u)).join(', ')}
          </span>
        )}
        {drifts.length > 0 && (
          <button type="button" class="badge mini ep-drift" aria-expanded={showDrift}
            title={`The real server now answers differently (${driftCountText(drifts)}). Show what changed.`}
            onClick={() => setShowDrift(!showDrift)}>
            out of date
          </button>
        )}
        <span class="spacer" />
        {ep.overridden && (
          <span class="ep-overridden">
            <span class="badge mini ep-for-you" title={FOR_YOU_TIP}>changed for you</span>
            <button type="button" class="link" onClick={onReset} title={`Put back the team's setting for ${ep.method} ${displayName}`}>Reset</button>
          </span>
        )}
        <div class="ep-picker">
          {!active ? (
            <span class="badge warn ep-no-example" title="No example saved — answers 501 no-example">no example · 501</span>
          ) : (
            <>
              <span class={`badge mini ep-status sc-${statusClassSuffix(active.status)}`}>{active.status}</span>
              {active.generated && (
                <span class="badge mini ep-generated" title="Generated from the OpenAPI schema">generated</span>
              )}
              {examples.length > 1 ? (
                <select class="ep-example-select"
                  aria-label={`Example for ${ep.method} ${displayName}`}
                  value={active.name}
                  onChange={(e) => onSelectExample((e.target as HTMLSelectElement).value)}>
                  {examples.map((opt) => (
                    <option key={opt.name} value={opt.name}>
                      {clipName(opt.name)} ({opt.status}){opt.generated ? ' · generated' : ''}{opt.byBody ? byBodyOption(opt.byBody) : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <span class="ep-example-name" title={activeHint ? `${clipName(active.name)} — ${activeHint}` : active.name}>{clipName(active.name)}</span>
              )}
              <Button pressed={viewing} onClick={onView} title={`View ${clipName(active.name)} status, headers and body`}>
                View
              </Button>
            </>
          )}
          <Button onClick={onEditAsRule} title="Open an editable personal copy in Rules">
            Edit as a rule
          </Button>
        </div>
      </div>

      {bodyLine && <div class="ep-by-body muted">{bodyLine}</div>}
      {showDrift && drifts.length > 0 && <OutOfDateDetails col={col} ep={ep} />}

      {viewing && (
        exData ? (
          <ExampleViewer data={exData} generated={!!active?.generated} onClose={onCloseView} />
        ) : (
          <div class="collection-example muted pad" aria-busy="true">
            Loading example “{clipName(viewingName ?? '')}”…
          </div>
        )
      )}
    </li>
  );
}

/** " · answers when the request's password matches" for an option of the example picker. */
function byBodyOption(byBody: string[]): string {
  const hint = byBodyHint(byBody);
  return hint ? ` · ${hint}` : '';
}

function ExampleViewer({ data, generated, onClose }: {
  data: CollectionExampleView;
  generated: boolean;
  onClose: () => void;
}) {
  const formatted = useMemo(() => formatExampleBody(data.body), [data.body]);
  const truncated = !!(data.truncated || formatted.truncated);
  const displayName = clipName(data.name);

  return (
    <div class="collection-example" role="region" aria-label={`Example ${displayName}`}>
      <div class="collection-example-head">
        <span class="collection-example-title" title={data.name}>{displayName}</span>
        <span class={`badge mini ep-status sc-${statusClassSuffix(data.status)}`}>{data.status}</span>
        {generated && <span class="badge mini ep-generated">generated</span>}
        {truncated && (
          <span class="badge warn collection-example-truncated" title="Response body truncated to 256 KB">truncated</span>
        )}
        <span class="spacer" />
        {formatted.text && (
          <Button kind="icon" title="Copy example body" onClick={() => copyText(formatted.text)}>
            <Icon name="copy" />
          </Button>
        )}
        <Button kind="icon" title="Close example" onClick={onClose}>
          <Icon name="close" />
        </Button>
      </div>
      {truncated && (
        <div class="hint collection-example-truncated-note">
          Body truncated to 256 KB for display.
        </div>
      )}
      <h4 class="section-title">Headers</h4>
      <HeadersTable headers={data.headers} />
      <h4 class="section-title">Body</h4>
      {formatted.text === '' ? (
        <div class="muted pad">No body</div>
      ) : (
        <pre class="code collection-example-body">{formatted.text}</pre>
      )}
    </div>
  );
}

/** CONTRACTS §21.15 #4: what the app asked for that the collection lacks, each with one way to fix it. */
function SeenList({ col }: { col: CollectionStatus }) {
  const { state, dispatch, post } = useApp();
  const missing = col.seen?.notInCollection ?? [];
  const noExample = col.seen?.noExample ?? [];
  const mockFromRequest = (method: string, path: string) => {
    const ex = exchangeForSeen(state.exchanges, col.origins ?? [], method, path);
    if (!ex) return;
    dispatch({ type: 'awaitRule', kind: 'mock' });
    post({ type: 'createRuleFromExchange', id: ex.id, action: 'mock' });
  };
  const editAsRule = (endpoint: string) => {
    dispatch({ type: 'awaitRule', kind: 'mock' });
    post({ type: 'collectionToRule', id: col.id, endpoint });
  };
  return (
    <ul class="collection-seen-list" aria-label={`Requests ${clipName(col.name)} lacks`}>
      {missing.map((m) => {
        const listed = !!exchangeForSeen(state.exchanges, col.origins ?? [], m.method, m.path);
        return (
          <li key={`n:${m.method} ${m.path}`}>
            <span class="ep-method">{clipName(m.method, 20)}</span> <code>{clipName(m.path)}</code>
            <span class="muted"> ×{m.count}</span>
            <span class="muted"> · not in the collection</span>{' '}
            <button type="button" class="link" disabled={!listed} onClick={() => mockFromRequest(m.method, m.path)}
              title={listed ? 'Create a mock rule from the latest such request' : 'No such request is listed any more: make the app send it again'}>
              Mock it with a rule
            </button>
          </li>
        );
      })}
      {noExample.map((n) => (
        <li key={`e:${n.endpoint}`}>
          <code>{clipName(n.endpoint)}</code>
          <span class="muted"> ×{n.count} · answered 501 (no example)</span>{' '}
          <button type="button" class="link" onClick={() => editAsRule(n.endpoint)} title="Open an editable copy in Rules and give it a body">
            Mock it with a rule
          </button>
        </li>
      ))}
    </ul>
  );
}

