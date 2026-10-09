import { useEffect, useRef, useState } from 'preact/hooks';
import { useApp } from '../context';
import type { Exchange } from '../protocol';
import {
  computeEdit, currentDraft, isBodyEditable, validateDraft,
  type HeaderRow, type RequestDraft, type ResponseDraft,
} from '../state';
import { formatJson } from '../json';
import { base64ByteLength, type JsonCheck } from '../util';
import { Button } from './bits';
import { Icon } from './Icon';

// ---------------------------------------------------------------- headers editor

export function HeadersEditor({ rows, onChange, disabled }: { rows: HeaderRow[]; onChange: (rows: HeaderRow[]) => void; disabled?: boolean }) {
  const update = (i: number, patch: Partial<HeaderRow>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <div class="headers-editor">
      {rows.map((r, i) => (
        <div class="he-row" key={i}>
          <input class="he-name" aria-label="Header name" placeholder="name" spellcheck={false} value={r.name} disabled={disabled}
            onInput={(e) => update(i, { name: (e.target as HTMLInputElement).value })} />
          <input class="he-value" aria-label={`Value of ${r.name || 'header'}`} placeholder="value" spellcheck={false} value={r.value} disabled={disabled}
            onInput={(e) => update(i, { value: (e.target as HTMLInputElement).value })} />
          <Button kind="icon" title={`Remove ${r.name || 'header'}`} disabled={disabled}
            onClick={() => onChange(rows.filter((_, k) => k !== i))}>
            <Icon name="close" />
          </Button>
        </div>
      ))}
      <button type="button" class="link" disabled={disabled} onClick={() => onChange([...rows, { name: '', value: '' }])}>
        + Add header
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- body editor

export function BodyEditor(props: {
  value: string;
  onInput: (v: string) => void;
  json?: JsonCheck;
  label: string;
  disabled?: boolean;
  rows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const { json } = props;
  const goTo = (offset: number) => {
    const ta = ref.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(offset, Math.min(offset + 1, ta.value.length));
  };
  // Re-indents only: every token (big ints, -0, 1.0, escapes) is kept byte for byte.
  const format = () => {
    const pretty = formatJson(props.value);
    if (pretty !== undefined && pretty !== props.value) props.onInput(pretty);
  };
  return (
    <div class="body-editor">
      <textarea
        ref={ref}
        class={`code-input${json && !json.ok ? ' invalid' : ''}`}
        aria-label={props.label}
        aria-invalid={json ? !json.ok : undefined}
        spellcheck={false}
        wrap="off"
        rows={props.rows ?? 12}
        value={props.value}
        disabled={props.disabled}
        onInput={(e) => props.onInput((e.target as HTMLTextAreaElement).value)}
      />
      {json && (
        json.ok ? (
          <div class="msg ok">
            Valid JSON
            <button type="button" class="link" onClick={format} disabled={props.disabled}>Format</button>
          </div>
        ) : (
          <div class="msg error" role="alert">
            Invalid JSON — line {json.line}, column {json.column}: {json.message}
            <button type="button" class="link" onClick={() => goTo(json.offset)}>Go to error</button>
          </div>
        )
      )}
    </div>
  );
}

// ---------------------------------------------------------------- paused-exchange editor

const METHOD_SUGGESTIONS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export function PauseEditor({ ex }: { ex: Exchange }) {
  const { state, dispatch, post } = useApp();
  const draft = currentDraft(state, ex);
  const [confirming, setConfirming] = useState(false);
  // Any further change to the body invalidates a previous "send anyway?" prompt.
  useEffect(() => setConfirming(false), [draft?.body]);
  if (!draft) return null;

  const set = (patch: Partial<RequestDraft> | Partial<ResponseDraft>) => dispatch({ type: 'patchDraft', id: ex.id, patch });
  const validation = validateDraft(draft);
  const edit = computeEdit(ex, draft);
  const busy = !!state.resolving[ex.id];
  const original = draft.kind === 'request' ? ex.requestBody : ex.responseBody;
  const bodyEditable = isBodyEditable(original);
  const sendsBody = !!edit && 'body' in edit;
  const jsonBad = validation.json && !validation.json.ok ? validation.json : undefined;
  const canSendEdits = !busy && !!edit && validation.errors.length === 0;
  const changed = edit ? Object.keys(edit) : [];

  const sendEdits = (force = false) => {
    if (!canSendEdits) return;
    if (sendsBody && jsonBad && !force) {
      setConfirming(true);
      return;
    }
    post({ type: 'resume', id: ex.id, edit });
    dispatch({ type: 'resolving', id: ex.id });
  };
  const resumeUnchanged = () => {
    post({ type: 'resume', id: ex.id });
    dispatch({ type: 'resolving', id: ex.id });
  };
  const abort = () => {
    post({ type: 'abort', id: ex.id });
    dispatch({ type: 'resolving', id: ex.id });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (canSendEdits) sendEdits();
      else if (!edit && !busy) resumeUnchanged();
    }
  };

  const mod = (field: string) => (changed.includes(field) ? ' modified' : '');

  return (
    <form class="pause-editor" onSubmit={(e) => e.preventDefault()} onKeyDown={onKeyDown}
      aria-label={draft.kind === 'request' ? 'Edit paused request' : 'Edit paused response'}>
      {draft.kind === 'request' ? (
        <div class="pe-line">
          <input class={`pe-method${mod('method')}`} aria-label="Method" list="fi-methods" spellcheck={false}
            value={draft.method} disabled={busy} onInput={(e) => set({ method: (e.target as HTMLInputElement).value })} />
          <datalist id="fi-methods">{METHOD_SUGGESTIONS.map((m) => <option key={m} value={m} />)}</datalist>
          <input class={`pe-url${mod('url')}`} aria-label="URL" spellcheck={false}
            value={draft.url} disabled={busy} onInput={(e) => set({ url: (e.target as HTMLInputElement).value })} />
        </div>
      ) : (
        <div class="pe-line">
          <label class="field-inline">
            Status
            <input class={`pe-status${mod('status')}`} aria-label="Status" inputMode="numeric" spellcheck={false}
              value={draft.status} disabled={busy} onInput={(e) => set({ status: (e.target as HTMLInputElement).value })} />
          </label>
        </div>
      )}

      <h4 class={`section-title${mod('headers')}`}>Headers</h4>
      <HeadersEditor rows={draft.headers} disabled={busy} onChange={(headers) => set({ headers })} />

      <h4 class={`section-title${mod('body')}`}>Body</h4>
      {bodyEditable ? (
        <BodyEditor label={draft.kind === 'request' ? 'Request body' : 'Response body'} value={draft.body}
          json={validation.json} disabled={busy} rows={8} onInput={(body) => set({ body })} />
      ) : (
        <div class="msg info body-readonly" role="note">
          {original?.encoding === 'base64'
            ? `binary (${base64ByteLength(original.text).toLocaleString()} bytes) — read-only. Binary bodies can't be edited as text; it is forwarded unchanged (headers and ${draft.kind === 'request' ? 'method/URL' : 'status'} can still be edited).`
            : 'Body was truncated at 5 MB — read-only, and forwarded unchanged (other fields can still be edited).'}
        </div>
      )}

      {validation.errors.length > 0 && (
        <ul class="msg error errors" role="alert">
          {validation.errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}

      {confirming && jsonBad && (
        <div class="confirm" role="alertdialog" aria-label="Send invalid JSON?">
          <span>
            The body is not valid JSON (line {jsonBad.line}, column {jsonBad.column}). The app will probably fail to parse it.
          </span>
          <Button kind="danger" onClick={() => sendEdits(true)}>Send anyway</Button>
          <Button onClick={() => setConfirming(false)}>Keep editing</Button>
        </div>
      )}

      <div class="pe-actions">
        <Button kind="primary" disabled={!canSendEdits} onClick={() => sendEdits()}
          title={!edit ? 'Nothing changed yet' : jsonBad && sendsBody ? 'Body is not valid JSON — you will be asked to confirm' : 'Send the edited fields (Ctrl/Cmd+Enter)'}>
          <Icon name="play" /> Resume with edits
        </Button>
        <Button onClick={resumeUnchanged} disabled={busy} title="Continue with the original, unmodified message">
          Resume unchanged
        </Button>
        <Button kind="danger" onClick={abort} disabled={busy} title="Reset the connection — the app sees a network error">
          <Icon name="stop" /> Abort
        </Button>
        <span class="pe-summary">
          {busy ? 'Sent — waiting for the proxy…' : changed.length ? `Edited: ${changed.join(', ')}` : 'No changes'}
        </span>
        {state.drafts[ex.id] && !busy && (
          <button type="button" class="link" onClick={() => dispatch({ type: 'discardDraft', id: ex.id })}>Discard edits</button>
        )}
      </div>
    </form>
  );
}
