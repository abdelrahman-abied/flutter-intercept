/**
 * v0.16.0 part 2 (CONTRACTS §23.2 – §23.4): "out of date" — the real server's answers no longer look like a
 * collection's examples.
 * - OutOfDateDetails: what changed for one endpoint, in plain words, with Update example (the IDE shows the diff and
 *   asks), "Add as a new example" and Ignore.
 * - OutOfDateList: the same for every such endpoint of a collection, under its "Out of date: …" line.
 * Field names and kinds only, never values; plain text only. The panel never changes a file: it only asks the IDE.
 */
import { useMemo } from 'preact/hooks';
import { clipName, statusClassSuffix } from '../collections';
import { useApp } from '../context';
import {
  DRIFT_VIEW_LIMITS, driftChangeLines, driftedEndpoints, driftsOf, endpointLabel, isNewStatus,
} from '../drift';
import type { CollectionEndpointView, CollectionStatus, DriftView } from '../protocol';
import { Button, MenuButton } from './bits';

const UPDATE_TIP = 'Shows the change to the example in the team\'s file, then asks before saving it';
const ADD_TIP = 'Keeps the old example and adds the server\'s answer as a new one (shows the change and asks first)';
const IGNORE_TIP = 'Stop saying so, until the server\'s answers change again';

/** What changed for one endpoint: a block per status, each with its one clear action. */
export function OutOfDateDetails({ col, ep, showEndpoint }: {
  col: Pick<CollectionStatus, 'id'>; ep: CollectionEndpointView; showEndpoint?: boolean;
}) {
  const { post } = useApp();
  const views = useMemo(() => driftsOf(ep), [ep.drift]);
  if (!views.length) return null;
  const label = endpointLabel(ep.key) || clipName(ep.name);
  const updateExample = (v: DriftView, mode?: 'add') =>
    post({ type: 'updateExample', id: col.id, endpoint: ep.key, status: v.status, ...(mode ? { mode } : {}) });
  const ignore = (v: DriftView) => post({ type: 'ignoreDrift', id: col.id, endpoint: ep.key, status: v.status });

  return (
    <div class="ood" role="group" aria-label={`What changed in ${label}`}>
      {showEndpoint && (
        <div class="ood-endpoint">
          <span class="ep-method">{clipName(ep.method, 20)}</span>{' '}
          <code class="ep-url" title={ep.url}>{label.slice(label.indexOf(' ') + 1)}</code>
        </div>
      )}
      {views.map((v) => {
        const { lines, more } = driftChangeLines(v);
        const add = isNewStatus(v);
        return (
          <div key={v.status} class="ood-status">
            <div class="ood-head">
              <span class={`badge mini ep-status sc-${statusClassSuffix(v.status)}`}>{v.status}</span>
              <span class="muted">{add ? 'no example yet' : 'example'}</span>
              <span class="ood-actions">
                {add ? (
                  <Button onClick={() => updateExample(v, 'add')} title={`${ADD_TIP} — ${label}, ${v.status}`}>
                    Add as a new example
                  </Button>
                ) : (
                  <>
                    <Button onClick={() => updateExample(v)} title={`${UPDATE_TIP} — ${label}, ${v.status}`}>
                      Update example
                    </Button>
                    <MenuButton label={`Other ways to update ${label} ${v.status}`}
                      buttonLabel={`Other ways to update the ${v.status} example of ${label}`}
                      title="Other ways to update" class="ood-more"
                      items={[{ label: 'Add as a new example', title: ADD_TIP, onSelect: () => updateExample(v, 'add') }]}>
                      ▾
                    </MenuButton>
                  </>
                )}
                <Button onClick={() => ignore(v)} title={`${IGNORE_TIP} — ${label}, ${v.status}`}>Ignore</Button>
              </span>
            </div>
            <ul class="ood-changes" aria-label={`Changes in ${label}, ${v.status}`}>
              {lines.map((text, i) => <li key={i}>{text}</li>)}
              {more > 0 && <li class="muted ood-more-changes">and {more} more</li>}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/** Under a collection's "Out of date: …" line: every endpoint that is out of date (twenty, then "and N more"). */
export function OutOfDateList({ col, endpoints }: {
  col: CollectionStatus; endpoints: CollectionEndpointView[] | undefined;
}) {
  const { post } = useApp();
  const drifted = useMemo(() => driftedEndpoints(endpoints), [endpoints]);
  const name = clipName(col.name);
  // The details travel with the endpoints: asked for when the line was opened, pushed again when they change.
  if (endpoints === undefined) return <div class="ood-list muted" aria-busy="true">Looking up what changed…</div>;
  if (!drifted.length) return <div class="ood-list muted">The details haven't arrived yet.</div>;
  const shown = drifted.slice(0, DRIFT_VIEW_LIMITS.endpoints);
  const more = drifted.length - shown.length;
  return (
    <div class="ood-list">
      <ul class="ood-items" aria-label={`Out of date in ${name}`}>
        {shown.map((ep) => (
          <li key={ep.key}><OutOfDateDetails col={col} ep={ep} showEndpoint /></li>
        ))}
      </ul>
      <div class="ood-foot">
        {more > 0 && <span class="muted">and {more} more — each is tagged “out of date” under Requests</span>}
        {drifted.length > 1 && (
          <button type="button" class="link" title={`${IGNORE_TIP} — everything in ${name}`}
            onClick={() => post({ type: 'ignoreDrift', id: col.id })}>
            Ignore all
          </button>
        )}
      </div>
    </div>
  );
}
