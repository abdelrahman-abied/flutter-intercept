import { useEffect, useRef, useState } from 'preact/hooks';
import { useApp } from '../context';
import type { Exchange } from '../protocol';
import {
  composeSend, computeEdit, currentDraft, findExchange, isBodyEditable, validateDraft,
  type DraftValidation, type HeaderRow, type RequestDraft, type ResponseDraft,
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

/** Method + URL inputs of a request draft (paused-request editor and the resend composer). */
export function MethodUrlLine({ draft, disabled, mod, onChange }: {
  draft: RequestDraft; disabled?: boolean; mod?: (field: string) => string; onChange: (patch: Partial<RequestDraft>) => void;
}) {
  const m = mod ?? (() => '');
  return (
    <div class="pe-line">
      <input class={`pe-method${m('method')}`} aria-label="Method" list="fi-methods" spellcheck={false}
        value={draft.method} disabled={disabled} onInput={(e) => onChange({ method: (e.target as HTMLInputElement).value })} />
      <datalist id="fi-methods">{METHOD_SUGGESTIONS.map((x) => <option key={x} value={x} />)}</datalist>
      <input class={`pe-url${m('url')}`} aria-label="URL" spellcheck={false}
        value={draft.url} disabled={disabled} onInput={(e) => onChange({ url: (e.target as HTMLInputElement).value })} />
    </div>
  );
}

function DraftErrors({ validation }: { validation: DraftValidation }) {
  if (!validation.errors.length) return null;
  return (
    <ul class="msg error errors" role="alert">
      {validation.errors.map((e) => <li key={e}>{e}</li>)}
    </ul>
  );
}

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
        <MethodUrlLine draft={draft} disabled={busy} mod={mod} onChange={set} />
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

      <DraftErrors validation={validation} />

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

// ---------------------------------------------------------------- edit & resend composer

/** "Edit and resend": the request-draft editor → `send` (CONTRACTS §9.3). The host replies `sent`. */
export function Composer() {
  const { state, dispatch, post } = useApp();
  const c = state.composer;
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setConfirming(false), [c?.draft.body]);
  if (!c) return null;
  const draft = c.draft;
  const original = c.resentFrom ? findExchange(state, c.resentFrom) : undefined;
  const validation = validateDraft(draft);
  const jsonBad = validation.json && !validation.json.ok ? validation.json : undefined;
  const busy = c.sending;
  const canSend = !busy && validation.errors.length === 0;
  const set = (patch: Partial<RequestDraft>) => dispatch({ type: 'patchComposer', patch });
  const close = () => dispatch({ type: 'closeComposer', discard: true });

  const send = (force = false) => {
    if (!canSend) return;
    if (jsonBad && !force) { setConfirming(true); return; }
    post({ type: 'send', request: composeSend(c), ...(c.resentFrom ? { resentFrom: c.resentFrom } : {}) });
    dispatch({ type: 'composerSending' });
  };

  return (
    <section class="detail composer" aria-label="Edit and resend" tabIndex={-1}>
      <form class="pause-editor composer-form" onSubmit={(e) => { e.preventDefault(); send(); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
          if (e.key === 'Escape' && !busy) { e.preventDefault(); close(); }
        }}>
        <div class="detail-title composer-head">
          <h3>{c.resentFrom ? 'Edit and resend' : 'New request'}</h3>
          {c.resentFrom && (
            original
              ? <button type="button" class="link" onClick={() => dispatch({ type: 'select', id: original.id })}
                  title="Show the original exchange (closes the composer; reopen it with “Edit and resend”)">
                  from {original.method} {original.url}
                </button>
              : <span class="muted">from an exchange that is no longer listed</span>
          )}
          <span class="spacer" />
          <Button kind="icon" title="Close (Esc)" onClick={close}><Icon name="close" /></Button>
        </div>
        <p class="hint">
          Sent through the proxy like app traffic: rules and the network profile apply, and it appears in the list.
        </p>
        <MethodUrlLine draft={draft} disabled={busy} onChange={set} />
        <h4 class="section-title">Headers</h4>
        <HeadersEditor rows={draft.headers} disabled={busy} onChange={(headers) => set({ headers })} />
        <h4 class="section-title">Body</h4>
        {c.bodyNote && <div class="msg info" role="note">{c.bodyNote}</div>}
        <BodyEditor label="Request body" value={draft.body} json={validation.json} disabled={busy} rows={8}
          onInput={(body) => set({ body })} />
        <DraftErrors validation={validation} />
        {confirming && jsonBad && (
          <div class="confirm" role="alertdialog" aria-label="Send invalid JSON?">
            <span>The body is not valid JSON (line {jsonBad.line}, column {jsonBad.column}) but its content-type says JSON.</span>
            <Button kind="danger" onClick={() => send(true)}>Send anyway</Button>
            <Button onClick={() => setConfirming(false)}>Keep editing</Button>
          </div>
        )}
        <div class="pe-actions">
          <Button kind="primary" type="submit" disabled={!canSend} title="Send this request through the proxy (Ctrl/Cmd+Enter)">
            <Icon name="play" /> Send
          </Button>
          <Button onClick={close} disabled={busy}>Cancel</Button>
          <span class="pe-summary">{busy ? 'Sending…' : 'The new exchange is selected once the proxy records it.'}</span>
        </div>
      </form>
    </section>
  );
}
