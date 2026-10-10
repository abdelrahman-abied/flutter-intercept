// CONTRACTS §12.4–12.5: save the current traffic, replay a recording, diff two, delete.
import { useMemo, useState } from 'preact/hooks';
import { useApp } from '../context';
import type { RecordingSummary } from '../protocol';
import {
  defaultRecordingName, diffPair, FALLBACK_LABEL, formatDate, isRecordable, isReplaying, MAX_RECORDING_NAME, recordingNameError,
} from '../scenarios';
import { filterExchanges, hasActiveFilters } from '../state';
import { Button } from './bits';
import { Icon } from './Icon';

type Fallback = 'passthrough' | 'fail';

const WHERE =
  'Recordings are saved under .dart_tool/flutter_intercept/recordings/ in the project — a git-ignored folder, so ' +
  'they stay on this machine.';

export function RecordingsView() {
  const { state, dispatch, post } = useApp();
  const { recordings, recordingPicks, status } = state;
  const [saving, setSaving] = useState(false);
  const pair = diffPair(recordings, recordingPicks);

  const diff = () => {
    if (!pair) return;
    post({ type: 'diffRecordings', a: pair.a.id, b: pair.b.id });
    dispatch({ type: 'notice', short: true, text: `Opening the diff “${pair.a.name}” → “${pair.b.name}” in an editor…` });
  };

  return (
    <div class="recordings-view">
      <div class="rules-head">
        <span class="muted">
          Save the traffic of a session, replay it later as mocks (offline demos, flaky backends), or diff two sessions.
        </span>
        <span class="spacer" />
        <Button kind="primary" pressed={saving} onClick={() => setSaving(!saving)}
          title="Save the finished HTTP exchanges listed in Traffic as a recording">
          <Icon name="plus" /> Save current traffic
        </Button>
      </div>
      {saving && <SaveForm onDone={() => setSaving(false)} />}
      {recordings.length === 0 ? (
        <div class="empty small">
          <p>No recordings yet.</p>
          <p class="muted">Run the app, then “Save current traffic”. {WHERE}</p>
        </div>
      ) : (
        <>
          <div class="rec-toolbar">
            <span class="muted">
              {recordingPicks.length === 0 ? 'Tick two recordings to compare them.'
                : recordingPicks.length === 1 ? 'Tick one more recording to compare.'
                : pair ? `Compare “${pair.a.name}” (older) with “${pair.b.name}”.` : ''}
            </span>
            <span class="spacer" />
            <Button disabled={!pair} onClick={diff}
              title={pair ? 'Routes added / removed, status, JSON shape, call count and timing changes — opens in a diff editor' : 'Tick exactly two recordings'}>
              Diff selected
            </Button>
            {recordingPicks.length > 0 && <Button onClick={() => dispatch({ type: 'clearRecordingPicks' })}>Clear selection</Button>}
          </div>
          <ul class="rec-items" aria-label="Recordings">
            {recordings.map((r) => (
              <RecordingRow key={r.id} rec={r} picked={recordingPicks.includes(r.id)} replaying={isReplaying(status, r)}
                otherReplay={!!status.replay && !isReplaying(status, r)} />
            ))}
          </ul>
          <p class="hint rec-where">{WHERE}</p>
        </>
      )}
    </div>
  );
}

function SaveForm({ onDone }: { onDone: () => void }) {
  const { state, dispatch, post } = useApp();
  const [name, setName] = useState(() => defaultRecordingName(Date.now()));
  const [redact, setRedact] = useState(false);
  const filtered = hasActiveFilters(state.filters);
  const [onlyShown, setOnlyShown] = useState(true);
  const all = useMemo(() => state.exchanges.filter(isRecordable), [state.exchanges]);
  const shown = useMemo(
    () => (filtered ? filterExchanges(state.exchanges, state.filters, state.contracts).filter(isRecordable) : all),
    [filtered, state.exchanges, state.filters, state.contracts, all],
  );
  const useShown = filtered && onlyShown;
  const count = useShown ? shown.length : all.length;
  const error = recordingNameError(name);
  const save = () => {
    if (error || !count) return;
    post({ type: 'saveRecording', name: name.trim(), ...(redact ? { redact: true } : {}), ...(useShown ? { ids: shown.map((e) => e.id) } : {}) });
    dispatch({ type: 'notice', short: true, text: `Saving “${name.trim()}” (${count} exchange${count === 1 ? '' : 's'})…` });
    onDone();
  };
  return (
    <form class="rec-save" aria-label="Save current traffic"
      onSubmit={(e) => { e.preventDefault(); save(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onDone(); } }}>
      <div class="field-row">
        <label class="field grow">
          <span>Name</span>
          <input value={name} maxLength={MAX_RECORDING_NAME + 20} aria-invalid={!!error}
            onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
      </div>
      {error && <div class="msg error">{error}</div>}
      {filtered && (
        <label class="check">
          <input type="checkbox" checked={onlyShown} onChange={() => setOnlyShown(!onlyShown)} />
          Only the {shown.length} exchange{shown.length === 1 ? '' : 's'} the Traffic filter shows (of {all.length})
        </label>
      )}
      <label class="check">
        <input type="checkbox" checked={redact} onChange={() => setRedact(!redact)} />
        Redact secrets (Authorization, cookies, tokens)
      </label>
      <div class="hint">
        {redact
          ? 'Secrets are replaced with “[redacted]” — safe to share, but a replay then answers with those placeholders.'
          : 'Saved as recorded, secrets included, so a replay is faithful. The file stays on this machine.'}
        {' '}Finished HTTP exchanges only — WebSocket / SSE streams and native captures are not recorded.
      </div>
      <div class="re-actions">
        <Button kind="primary" type="submit" disabled={!!error || !count}>
          Save {count} exchange{count === 1 ? '' : 's'}
        </Button>
        <Button onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function RecordingRow({ rec, picked, replaying, otherReplay }: {
  rec: RecordingSummary; picked: boolean; replaying: boolean; otherReplay: boolean;
}) {
  const { dispatch, post } = useApp();
  const [mode, setMode] = useState<'idle' | 'replay' | 'delete'>('idle');
  const [fallback, setFallback] = useState<Fallback>('passthrough');
  const start = () => {
    setMode('idle');
    post({ type: 'replayRecording', id: rec.id, fallback });
  };
  return (
    <li class={`rec-item${replaying ? ' replaying' : ''}${picked ? ' picked' : ''}`}>
      <div class="rec-line">
        <input type="checkbox" checked={picked} aria-label={`Select “${rec.name}” to compare`}
          onChange={() => dispatch({ type: 'pickRecording', id: rec.id })} />
        <div class="rec-main">
          <div class="rec-name">
            {replaying && <span class="badge replay-badge">replaying</span>}
            <span class="rec-title">{rec.name}</span>
            {rec.redacted && (
              <span class="badge redacted-badge" title="Saved with secrets redacted: a replay answers with “[redacted]” placeholders">redacted</span>
            )}
          </div>
          <div class="rec-sub">{formatDate(rec.createdAt)} · {rec.exchanges} exchange{rec.exchanges === 1 ? '' : 's'}</div>
        </div>
        <div class="rule-buttons">
          {replaying ? (
            <Button kind="primary" title="Stop replaying" onClick={() => post({ type: 'replayRecording' })}><Icon name="stop" /> Stop</Button>
          ) : (
            <Button pressed={mode === 'replay'} onClick={() => setMode(mode === 'replay' ? 'idle' : 'replay')}
              title={otherReplay ? 'Replay this recording instead of the current one' : 'Answer the app\'s requests from this recording'}>
              <Icon name="play" /> Replay…
            </Button>
          )}
          <Button kind="icon" title={`Delete “${rec.name}”`} onClick={() => setMode(mode === 'delete' ? 'idle' : 'delete')}>
            <Icon name="clear" />
          </Button>
        </div>
      </div>
      {mode === 'replay' && (
        <div class="rec-replay" role="group" aria-label={`Replay “${rec.name}”`}>
          <div class="field-label">Requests not in the recording</div>
          <div class="radios">
            {(['passthrough', 'fail'] as const).map((f) => (
              <label key={f} class="radio">
                <input type="radio" name={`fallback-${rec.id}`} checked={fallback === f} onChange={() => setFallback(f)} />
                {FALLBACK_LABEL[f][0].toUpperCase() + FALLBACK_LABEL[f].slice(1)}
              </label>
            ))}
          </div>
          <div class="hint">
            {fallback === 'fail'
              ? 'Demo mode: anything not recorded fails as if the device were offline — nothing reaches a server.'
              : 'Anything not recorded is sent to the real server as usual.'}
            {' '}Requests are matched by method + URL (and body); repeated calls get the recorded responses in order. Your rules still apply first.
          </div>
          <div class="re-actions">
            <Button kind="primary" onClick={start}><Icon name="play" /> Start replay</Button>
            <Button onClick={() => setMode('idle')}>Cancel</Button>
          </div>
        </div>
      )}
      {mode === 'delete' && (
        <div class="confirm" role="alertdialog" aria-label={`Delete “${rec.name}”?`}>
          <span>Delete “{rec.name}” ({rec.exchanges} exchanges)? The file is removed from disk; this can't be undone.{replaying && ' Replaying it stops.'}</span>
          <Button kind="danger" onClick={() => { setMode('idle'); post({ type: 'deleteRecording', id: rec.id }); }}>Delete</Button>
          <Button onClick={() => setMode('idle')}>Cancel</Button>
        </div>
      )}
    </li>
  );
}
