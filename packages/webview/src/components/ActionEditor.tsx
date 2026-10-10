// The per-kind action editors, shared by the rule editor and each `sequence` step (CONTRACTS §12.3).
import type { FaultKind } from '@flutter-intercept/proxy/types';
import { CORS_DEV_NOTE } from '../coverage';
import type { RuleAction } from '../protocol';
import {
  bodySecretHint, MAX_REPLACEMENTS, MAX_STEPS, mapRemoteWarning, STEP_KIND_LABEL, STEP_KINDS, THEN_LABEL,
  type ReplaceRow, type RewriteForm, type RewriteSideForm, type SequenceThen, type StepKind,
} from '../scenarios';
import {
  FAULT_LABEL, newStep, stepsPreview, type ActionFields, type ActionValidation, type MutateRow, type StepForm, type ThrottleFields,
} from '../state';
import { useState } from 'preact/hooks';
import { Button } from './bits';
import { BodyEditor, HeadersEditor } from './Editors';
import { Icon } from './Icon';

export interface ActionEditorProps {
  kind: RuleAction['kind'] | StepKind;
  f: ActionFields;
  v: ActionValidation;
  set: (patch: Partial<ActionFields>) => void;
  /** Unique per editor instance: radio-group names and labels (several step editors share one form). */
  uid: string;
  /** Step editors: smaller body box, no "body from a file". */
  compact?: boolean;
  /** Rule editor: offers "Body from a file" (CONTRACTS §12.2). `knownContent` = mockBody is the file's content. */
  bodyFile?: {
    suggest: () => string; knownContent: boolean; open: (path: string, createWith?: string) => void;
    /** The host's error for the last "Create file" / "Open file" (e.g. it refused a body with a detected secret). */
    error?: string;
  };
}

export function ActionEditor({ kind, f, v, set, uid, compact, bodyFile }: ActionEditorProps) {
  const radio = <K extends 'blockMode' | 'phase' | 'fault'>(key: K, value: ActionFields[K], label: string) => (
    <label class="radio">
      <input type="radio" name={`${uid}-${key}`} checked={f[key] === value} onChange={() => set({ [key]: value } as Partial<ActionFields>)} />
      {label}
    </label>
  );
  const setThrottle = (patch: Partial<ThrottleFields>) => set({ throttle: { ...f.throttle, ...patch } });
  const throttleField = (key: keyof ThrottleFields, label: string, placeholder: string) => (
    <label class="field small-field">
      <span>{label}</span>
      <input value={f.throttle[key]} inputMode="numeric" placeholder={placeholder} aria-invalid={!!v.errors[key]}
        onInput={(e) => setThrottle({ [key]: (e.target as HTMLInputElement).value })} />
    </label>
  );

  switch (kind) {
    case 'mock':
      return (
        <>
          <div class="field-row">
            <label class="field small-field">
              <span>Status</span>
              <input value={f.mockStatus} inputMode="numeric" aria-invalid={!!v.errors.mockStatus}
                onInput={(e) => set({ mockStatus: (e.target as HTMLInputElement).value })} />
            </label>
            <label class="field small-field">
              <span>Delay (ms)</span>
              <input value={f.mockDelayMs} inputMode="numeric" placeholder="0" aria-invalid={!!v.errors.mockDelayMs}
                onInput={(e) => set({ mockDelayMs: (e.target as HTMLInputElement).value })} />
            </label>
          </div>
          {v.errors.mockStatus && <div class="msg error">Status: {v.errors.mockStatus}</div>}
          {v.errors.mockDelayMs && <div class="msg error">Delay: {v.errors.mockDelayMs}</div>}
          <div class="field-label">Headers</div>
          <HeadersEditor rows={f.mockHeaders} onChange={(mockHeaders) => set({ mockHeaders })} />
          {v.errors.mockHeaders && <div class="msg error">{v.errors.mockHeaders}</div>}
          <div class="field-label">Body</div>
          {bodyFile && (
            <div class="radios" role="radiogroup" aria-label="Body source">
              <label class="radio">
                <input type="radio" name={`${uid}-bodySource`} checked={!f.mockUseFile} onChange={() => set({ mockUseFile: false })} />
                Inline
              </label>
              <label class="radio">
                <input type="radio" name={`${uid}-bodySource`} checked={f.mockUseFile}
                  onChange={() => set({ mockUseFile: true, ...(f.mockBodyFile.trim() ? {} : { mockBodyFile: bodyFile.suggest() }) })} />
                From a file in the workspace
              </label>
            </div>
          )}
          {bodyFile && f.mockUseFile ? (
            <>
              <label class="field">
                <span>File <span class="muted">(workspace-relative)</span></span>
                <input class="mono" value={f.mockBodyFile} spellcheck={false} aria-invalid={!!v.errors.mockBodyFile}
                  placeholder=".vscode/flutter-intercept/mocks/cart.json"
                  onInput={(e) => set({ mockBodyFile: (e.target as HTMLInputElement).value })} />
              </label>
              <BodyFileActions path={f.mockBodyFile.trim()} body={f.mockBody} disabled={!!v.errors.mockBodyFile}
                open={bodyFile.open} error={bodyFile.error} />
              {v.errors.mockBodyFile
                ? <div class="msg error">{v.errors.mockBodyFile}</div>
                : (
                  <div class="hint">
                    The extension reads this file into the mock and re-reads it whenever it changes (up to 5 MB) — edit it
                    in the editor, with JSON highlighting. A missing file skips the rule and shows a problem. Commit it to
                    share the mock with your team.
                  </div>
                )}
              {bodyFile.knownContent && (
                <details class="file-content">
                  <summary>Current content of the file</summary>
                  <pre class="code">{f.mockBody || '(empty)'}</pre>
                </details>
              )}
            </>
          ) : (
            <BodyEditor label={compact ? `Mock body (${uid})` : 'Mock body'} value={f.mockBody} json={v.json} rows={compact ? 4 : 10}
              onInput={(mockBody) => set({ mockBody })} />
          )}
        </>
      );

    case 'block':
      return (
        <>
          <div class="radios">
            {radio('blockMode', 'reset', 'Connection reset (app sees a network error)')}
            {radio('blockMode', 'status', 'Respond with status')}
          </div>
          {f.blockMode === 'status' && (
            <label class="field small-field">
              <span>Status</span>
              <input value={f.blockStatus} inputMode="numeric" aria-invalid={!!v.errors.blockStatus}
                onInput={(e) => set({ blockStatus: (e.target as HTMLInputElement).value })} />
            </label>
          )}
          {v.errors.blockStatus && <div class="msg error">Status: {v.errors.blockStatus}</div>}
        </>
      );

    case 'breakpoint':
      return (
        <div class="radios">
          {radio('phase', 'request', 'Pause request')}
          {radio('phase', 'response', 'Pause response')}
          {radio('phase', 'both', 'Both')}
        </div>
      );

    case 'throttle':
      return (
        <>
          <div class="hint">Forwards to the real server, slowed down. “Fail” resets that share of the requests.</div>
          <div class="field-row">
            {throttleField('latencyMs', 'Latency (ms)', '0')}
            {throttleField('kbps', 'Bandwidth (kbps)', 'unlimited')}
            {throttleField('dropPct', 'Fail (%)', '0')}
          </div>
          {(['latencyMs', 'kbps', 'dropPct', 'throttle'] as const).map((k) => v.errors[k] && <div key={k} class="msg error">{v.errors[k]}</div>)}
        </>
      );

    case 'cors':
      return (
        <>
          <div class="field-row">
            <label class="field grow">
              <span>Allow origin</span>
              <input class="mono" value={f.corsOrigin} placeholder="e.g. http://localhost:5000 (empty = localhost origins only)" spellcheck={false}
                aria-invalid={!!v.errors.cors} onInput={(e) => set({ corsOrigin: (e.target as HTMLInputElement).value })} />
            </label>
          </div>
          <label class="check">
            <input type="checkbox" checked={f.corsCredentials} onChange={() => set({ corsCredentials: !f.corsCredentials })} />
            Allow credentials (cookies) — off by default; only with a named origin
          </label>
          {v.errors.cors && <div class="msg error">{v.errors.cors}</div>}
          <div class="msg warn cors-dev-note">{CORS_DEV_NOTE}</div>
        </>
      );

    case 'fault':
      return (
        <>
          <div class="radios">
            {(Object.keys(FAULT_LABEL) as FaultKind[]).map((k) => radio('fault', k, FAULT_LABEL[k][0].toUpperCase() + FAULT_LABEL[k].slice(1)))}
          </div>
          <div class="hint">
            {f.fault === 'dns' ? 'The app sees a failed host lookup, as when offline.'
              : f.fault === 'timeout' ? 'The request is held unanswered until the app gives up (its own timeout).'
              : f.fault === 'truncate' ? 'Forwards to the server, then cuts the response body mid-way.'
              : 'The connection is reset once it is up — the app sees a network error.'}
          </div>
        </>
      );

    case 'mutate':
      return (
        <>
          <div class="field-label">Changes to the response</div>
          <div class="hint">
            Forwards to the real server, then changes the JSON response before the app gets it — e.g. null a field to
            reproduce “Null is not a subtype of String”. Paths: <code>$.user.avatar_url</code>, <code>$.items[0].id</code>,{' '}
            <code>$.items[*].price</code>, <code>$['odd key']</code>. A non-JSON response is passed through unchanged.
          </div>
          <MutateOpsEditor rows={f.mutateOps} errors={v.opErrors} onChange={(mutateOps) => set({ mutateOps })} />
          {v.errors.mutate && <div class="msg error">{v.errors.mutate}</div>}
        </>
      );

    case 'mapRemote': {
      const warning = v.errors.mapTo ? undefined : mapRemoteWarning(f.mapTo);
      return (
        <>
          <label class="field">
            <span>Forward to</span>
            <input class="mono" value={f.mapTo} spellcheck={false} aria-invalid={!!v.errors.mapTo}
              placeholder="http://localhost:8080  or  https://staging.example.com/api"
              onInput={(e) => set({ mapTo: (e.target as HTMLInputElement).value })} />
          </label>
          {v.errors.mapTo && f.mapTo.trim()
            ? <div class="msg error">{v.errors.mapTo}</div>
            : (
              <div class="hint">
                An origin, or a URL prefix that replaces the matched prefix (the rest of the path and the query are kept).
                The app still sees the original URL; the server's certificate is verified as usual.
              </div>
            )}
          {warning && <div class="msg warn map-warning" role="note">{warning}</div>}
          <label class="check">
            <input type="checkbox" checked={f.mapPreserveHost} onChange={() => set({ mapPreserveHost: !f.mapPreserveHost })} />
            Keep the original Host header (default: the target's host)
          </label>
        </>
      );
    }

    case 'rewrite':
      return <RewriteEditor uid={uid} value={f.rewrite} error={v.errors.rewrite} onChange={(rewrite) => set({ rewrite })} />;

    case 'passthrough':
      return <div class="hint">The request goes to the real server, unchanged.</div>;

    case 'sequence':
      return null; // the steps editor is its own fieldset (SequenceEditor)
  }
}

/**
 * "Open file" / "Create file" for a file-backed mock. Creating writes the current body into the project folder
 * (`.vscode/…` is usually committed), so it asks first — mocks made with "Mock this" carry real responses, tokens
 * included (REVIEW-6 #5). The host refuses bodies with detected secrets; its error is shown right here.
 */
function BodyFileActions({ path, body, disabled, open, error }: {
  path: string; body: string; disabled: boolean; open: (path: string, createWith?: string) => void; error?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const secret = bodySecretHint(body);
  return (
    <>
      <div class="file-actions">
        <Button disabled={disabled} onClick={() => { setConfirming(false); open(path); }} title="Open the file in the editor">Open file</Button>
        <Button disabled={disabled} pressed={confirming} onClick={() => setConfirming(!confirming)}
          title="Create the file with the current body and open it (an existing file is never overwritten)">Create file…</Button>
      </div>
      {secret && !confirming && (
        <div class="msg warn body-secret" role="note">
          The current body contains {secret}. Replace it with a placeholder before writing it to a file in the project.
        </div>
      )}
      {confirming && !disabled && (
        <div class="confirm body-file-confirm" role="alertdialog" aria-label="Create the body file?">
          <span>
            Write the current body to <code>{path}</code> inside the project folder? Files under <code>.vscode/</code> are
            usually committed. A body copied from real traffic (“Mock this”) can contain live tokens, session ids or
            personal data — check it first.
            {secret && <strong> It contains {secret}.</strong>}
          </span>
          <Button kind={secret ? 'danger' : 'primary'} onClick={() => { setConfirming(false); open(path, body); }}>Create file</Button>
          <Button onClick={() => setConfirming(false)}>Cancel</Button>
        </div>
      )}
      {error && <div class="msg error body-file-error" role="alert">{error}</div>}
    </>
  );
}

// ---------------------------------------------------------------- rewrite

export function RewriteEditor({ uid, value, error, onChange }: {
  uid: string; value: RewriteForm; error?: string; onChange: (v: RewriteForm) => void;
}) {
  const side = (key: 'request' | 'response') => (patch: Partial<RewriteSideForm>) => onChange({ ...value, [key]: { ...value[key], ...patch } });
  return (
    <div class="rewrite-editor">
      <div class="hint">
        Passes through to the real server and changes what goes there or comes back. Body replacements are literal
        text (no regex), up to {MAX_REPLACEMENTS} per body; binary bodies are left untouched.
      </div>
      <div class="rw-side" role="group" aria-label="Request changes">
        <div class="field-label rw-title">Request <span class="muted">— before it reaches the server</span></div>
        <RewriteSide uid={`${uid}-req`} label="request" value={value.request} onChange={side('request')} />
      </div>
      <div class="rw-side" role="group" aria-label="Response changes">
        <div class="field-label rw-title">Response <span class="muted">— before the app gets it</span></div>
        <label class="field small-field">
          <span>Status</span>
          <input value={value.status} inputMode="numeric" placeholder="keep" aria-label="Response status"
            onInput={(e) => onChange({ ...value, status: (e.target as HTMLInputElement).value })} />
        </label>
        <RewriteSide uid={`${uid}-res`} label="response" value={value.response} onChange={side('response')} />
      </div>
      {error && <div class="msg error">{error}</div>}
    </div>
  );
}

function RewriteSide({ uid, label, value, onChange }: {
  uid: string; label: 'request' | 'response'; value: RewriteSideForm; onChange: (patch: Partial<RewriteSideForm>) => void;
}) {
  const rows = value.replaceBody;
  const update = (i: number, patch: Partial<ReplaceRow>) => onChange({ replaceBody: rows.map((r, k) => (k === i ? { ...r, ...patch } : r)) });
  return (
    <>
      <div class="field-label">Set headers</div>
      <HeadersEditor rows={value.setHeaders} onChange={(setHeaders) => onChange({ setHeaders })} />
      <label class="field">
        <span>Remove headers <span class="muted">(names, comma separated)</span></span>
        <input class="mono" value={value.removeHeaders} spellcheck={false} aria-label={`Remove ${label} headers`}
          placeholder={label === 'request' ? 'e.g. if-none-match, x-debug' : 'e.g. etag, cache-control'}
          onInput={(e) => onChange({ removeHeaders: (e.target as HTMLInputElement).value })} />
      </label>
      <div class="field-label">Replace in body</div>
      <div class="rw-replace">
        {rows.map((r, i) => (
          <div class="rw-row" key={i}>
            <input class="mono" aria-label={`Find in ${label} body (${i + 1})`} placeholder="find" spellcheck={false} value={r.find}
              onInput={(e) => update(i, { find: (e.target as HTMLInputElement).value })} />
            <span aria-hidden="true">→</span>
            <input class="mono" aria-label={`Replace in ${label} body (${i + 1})`} placeholder="replace with" spellcheck={false} value={r.replace}
              onInput={(e) => update(i, { replace: (e.target as HTMLInputElement).value })} />
            <label class="check" title="Replace every occurrence (default: the first)">
              <input type="checkbox" name={`${uid}-all-${i}`} checked={r.all} onChange={() => update(i, { all: !r.all })} /> all
            </label>
            <Button kind="icon" title={`Remove replacement ${i + 1}`} onClick={() => onChange({ replaceBody: rows.filter((_, k) => k !== i) })}>
              <Icon name="close" />
            </Button>
          </div>
        ))}
        <button type="button" class="link" disabled={rows.length >= MAX_REPLACEMENTS}
          onClick={() => onChange({ replaceBody: [...rows, { find: '', replace: '', all: false }] })}>+ Add replacement</button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- sequence

export function SequenceEditor({ steps, then, checks, error, onChange }: {
  steps: StepForm[]; then: SequenceThen; checks?: ActionValidation[]; error?: string;
  onChange: (patch: { steps?: StepForm[]; seqThen?: SequenceThen }) => void;
}) {
  const setStep = (i: number, patch: Partial<StepForm>) => onChange({ steps: steps.map((s, k) => (k === i ? { ...s, ...patch } : s)) });
  const move = (from: number, to: number) => {
    if (to < 0 || to >= steps.length) return;
    const next = steps.slice();
    const [s] = next.splice(from, 1);
    next.splice(to, 0, s);
    onChange({ steps: next });
  };
  return (
    <fieldset class="sequence">
      <legend>Steps</legend>
      <div class="hint">
        Successive matching requests are answered step by step — e.g. fail once, then succeed. The count restarts when
        the rule is changed.
      </div>
      <ol class="seq-steps" aria-label="Sequence steps">
        {steps.map((s, i) => {
          const v = checks?.[i] ?? { errors: {} };
          return (
            <li key={i} class="seq-step">
              <div class="seq-head">
                <span class="seq-num" aria-hidden="true">{i + 1}</span>
                <select aria-label={`Step ${i + 1} action`} value={s.kind}
                  onChange={(e) => setStep(i, { kind: (e.target as HTMLSelectElement).value as StepKind })}>
                  {STEP_KINDS.map((k) => <option key={k} value={k}>{STEP_KIND_LABEL[k]}</option>)}
                </select>
                <label class="seq-count">
                  <span>×</span>
                  <input value={s.count} inputMode="numeric" aria-label={`Step ${i + 1} count`} aria-invalid={!!v.errors.count}
                    onInput={(e) => setStep(i, { count: (e.target as HTMLInputElement).value })} />
                  <span class="muted">{s.count.trim() === '1' ? 'request' : 'requests'}</span>
                </label>
                <span class="spacer" />
                <Button kind="icon" title={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, i - 1)}><Icon name="up" /></Button>
                <Button kind="icon" title={`Move step ${i + 1} down`} disabled={i === steps.length - 1} onClick={() => move(i, i + 1)}><Icon name="down" /></Button>
                <Button kind="icon" title={`Remove step ${i + 1}`} disabled={steps.length === 1}
                  onClick={() => onChange({ steps: steps.filter((_, k) => k !== i) })}><Icon name="close" /></Button>
              </div>
              {v.errors.count && <div class="msg error">{v.errors.count}</div>}
              {s.kind !== 'passthrough' && (
                <div class="seq-body">
                  <ActionEditor kind={s.kind} f={s} v={v} uid={`step${i + 1}`} compact set={(patch) => setStep(i, patch)} />
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <button type="button" class="link" disabled={steps.length >= MAX_STEPS}
        onClick={() => onChange({ steps: [...steps, newStep('passthrough')] })}>+ Add step</button>
      <div class="field-label">After the last step</div>
      <div class="radios" role="radiogroup" aria-label="After the last step">
        {(Object.keys(THEN_LABEL) as SequenceThen[]).map((t) => (
          <label key={t} class="radio">
            <input type="radio" name="seqThen" checked={then === t} onChange={() => onChange({ seqThen: t })} />
            {THEN_LABEL[t]}
          </label>
        ))}
      </div>
      <div class="seq-preview" aria-label="Sequence preview">
        <span class="muted">Requests get:</span> <code>{stepsPreview(steps, then)}</code>
      </div>
      {error && <div class="msg error">{error}</div>}
    </fieldset>
  );
}

// ---------------------------------------------------------------- mutate

const OP_LABEL: Record<MutateRow['op'], string> = { null: 'make null', delete: 'remove', set: 'set to' };

/** The `mutate` op list: path, op and (for set) a JSON value per row. */
export function MutateOpsEditor({ rows, errors, onChange }: {
  rows: MutateRow[]; errors?: (string | undefined)[]; onChange: (rows: MutateRow[]) => void;
}) {
  const update = (i: number, patch: Partial<MutateRow>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <div class="mutate-ops">
      {rows.map((r, i) => {
        const err = errors?.[i];
        return (
          <div class="mo-row" key={i}>
            <div class="mo-line">
              <input class="mo-path mono" aria-label={`Path of change ${i + 1}`} placeholder="$.user.avatar_url" spellcheck={false}
                value={r.path} aria-invalid={!!err && err.startsWith('Path')}
                onInput={(e) => update(i, { path: (e.target as HTMLInputElement).value })} />
              <select aria-label={`Change ${i + 1}`} value={r.op}
                onChange={(e) => update(i, { op: (e.target as HTMLSelectElement).value as MutateRow['op'] })}>
                {(Object.keys(OP_LABEL) as MutateRow['op'][]).map((op) => <option key={op} value={op}>{OP_LABEL[op]}</option>)}
              </select>
              {r.op === 'set' && (
                <input class="mo-value mono" aria-label={`JSON value of change ${i + 1}`} placeholder='"42"' spellcheck={false}
                  value={r.value} aria-invalid={!!err && err.startsWith('Value')}
                  onInput={(e) => update(i, { value: (e.target as HTMLInputElement).value })} />
              )}
              <Button kind="icon" title={`Remove change ${i + 1}`} disabled={rows.length === 1}
                onClick={() => onChange(rows.filter((_, k) => k !== i))}>
                <Icon name="close" />
              </Button>
            </div>
          </div>
        );
      })}
      <button type="button" class="link" onClick={() => onChange([...rows, { path: '', op: 'null', value: '' }])}>+ Add change</button>
    </div>
  );
}
