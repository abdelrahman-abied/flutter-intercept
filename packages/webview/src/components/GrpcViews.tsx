// v0.10.0 gRPC views (CONTRACTS §16.5): the decode request on open, the status block in the detail header, trailers,
// one message's decoded / raw / hex view, and the status banner for Status.grpc.problem.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { useApp } from '../context';
import type { Exchange, Frame, GrpcDecodedMessage, GrpcEdit, GrpcPause } from '../protocol';
import {
  DECODE_TIMEOUT_MS, findPreflight, GRPC_CODES, GRPC_DECRYPT_SETTING, GRPC_WEB_NOTE, SIM_TRUST_SETTING, simTrustFailures, grpcCodeLabel, grpcCountsText, grpcFacts, grpcPath, grpcPauseKey, grpcPauseTitle,
  grpcVersion, hexTextDump, isBase64, isGrpc, needsDecode, pausedDecoded, reservedGrpcHeader,
} from '../grpc';
import { grpcHeaderError, grpcMessageError, headersChanged, headersToRows, rowsToFlatRecord, type HeaderRow } from '../state';
import { HeadersEditor } from './Editors';
import type { TreeFieldActions } from './Viewers';
import { dirArrow, dirLabel, formatRelative, frameSizeText, frameSizeTitle, hexDump } from '../frames';
import { parseJsonLossless } from '../json';
import { formatBytes, formatTime, type Headers } from '../util';
import { Button } from './bits';
import { Icon } from './Icon';
import { copyText, HeadersTable, JsonTree } from './Viewers';

/**
 * Posts `decodeGrpc` once per version of a gRPC call while its details are open (a live stream re-decodes as messages
 * arrive), and re-renders when the answer is overdue so the Messages tab can fall back to raw bytes.
 */
export function useGrpcDecode(ex: Exchange): void {
  const { state, dispatch, post } = useApp();
  const entry = state.grpcDecoded[ex.id];
  const key = isGrpc(ex) ? grpcVersion(ex) : '';
  useEffect(() => {
    if (!needsDecode(ex, entry)) return;
    dispatch({ type: 'grpcRequested', id: ex.id, key, base: ex.framesDropped ?? 0, at: Date.now() });
    post({ type: 'decodeGrpc', id: ex.id });
  }, [ex.id, key]);
}

/** Re-renders once the decode answer is overdue (DECODE_TIMEOUT_MS after the request). */
export function useDecodeDeadline(requestedAt: number | undefined, answered: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (requestedAt === undefined || answered) return;
    const left = requestedAt + DECODE_TIMEOUT_MS - Date.now();
    if (left <= 0) { setNow(Date.now()); return; }
    const t = setTimeout(() => setNow(Date.now()), left + 10);
    return () => clearTimeout(t);
  }, [requestedAt, answered]);
  return Math.max(now, Date.now());
}

/** The gRPC status, prominently: "14 UNAVAILABLE — Flutter Intercept: connect ECONNREFUSED", plus the call's facts. */
export function GrpcStatusSection({ ex }: { ex: Exchange }) {
  const { state, dispatch } = useApp();
  const g = ex.grpc;
  // CONTRACTS §19.1: gRPC-Web is an HTTP/1.1 request — show the HTTP side and its CORS preflight too.
  const preflight = g?.web ? findPreflight(state.exchanges, ex) : undefined;
  const code = g?.statusCode;
  const cls = code === undefined ? (ex.state === 'pending' ? 'pending' : 'none') : code === 0 ? 'ok' : 'err';
  const facts = grpcFacts(ex);
  return (
    <div class={`grpc-status-block gsb-${cls}`} aria-label="gRPC status">
      <span class="grpc-method mono" title={ex.url}>{grpcPath(ex)}</span>
      <span class="grpc-status-line">
        {code !== undefined ? (
          <>
            <strong class={`status grpc-status gs-${cls}`}>{grpcCodeLabel(code)}</strong>
            {g?.statusMessage && <span class="grpc-status-msg"> — {g.statusMessage}</span>}
          </>
        ) : ex.state === 'pending' ? (
          <span class="muted">Open — the status arrives with the trailers</span>
        ) : (
          <span class="warn-text">No gRPC status{ex.state === 'aborted' ? ': cancelled by the app' : ex.error ? `: ${ex.error}` : ''}</span>
        )}
      </span>
      <span class="muted grpc-facts">{[grpcCountsText(ex), ...facts].join(' · ')}</span>
      {g?.web && (
        <span class="grpc-web-http">
          <span class="badge mini grpc-web-badge">gRPC-Web{g.web === 'text' ? ' (text)' : ''}</span>
          {' '}HTTP {ex.status ?? '—'}
          {preflight && (
            <>
              {' · '}
              <button type="button" class="link" onClick={() => dispatch({ type: 'select', id: preflight.id })}
                title="The browser's CORS preflight for this call">preflight OPTIONS {preflight.status ?? '…'}</button>
            </>
          )}
        </span>
      )}
      {g?.web && <div class="hint grpc-web-note">{GRPC_WEB_NOTE}</div>}
    </div>
  );
}

/** HTTP/2 trailers (gRPC: grpc-status, grpc-message, custom metadata); shown for any exchange that has them. */
export function TrailersSection({ trailers }: { trailers: Headers | undefined }) {
  if (!trailers || !Object.keys(trailers).length) return null;
  return (
    <>
      <h4 class="section-title">Trailers</h4>
      <HeadersTable headers={trailers} />
    </>
  );
}

type MsgMode = 'tree' | 'text' | 'hex' | 'base64';

export const DROPPED_TITLE = 'Dropped at a breakpoint — never delivered';
export const EDITED_TITLE = 'Replaced by a breakpoint edit or a Mutate JSON rule — the recorded bytes are what was delivered';

/** One gRPC message: decoded JSON (schema) or raw fields as a tree, the text, hex, and the payload as base64. */
export function GrpcMessageDetail({ f, n, start, m, fields }: {
  f: Frame; n: number; start: number; m?: GrpcDecodedMessage;
  /** CONTRACTS §17.3: "mutate this field" on a response message the schema decodes. */
  fields?: TreeFieldActions;
}) {
  const parsed = useMemo(() => (m?.json ? parseJsonLossless(m.json) : undefined), [m?.json]);
  const tree = parsed?.ok ? parsed.value : undefined;
  const hex = useMemo(() => (m?.hex ? hexTextDump(m.hex) : f.base64 !== undefined ? hexDump(f.base64, 4096) : undefined), [m?.hex, n, f.at, f.size]);
  const modes: MsgMode[] = [];
  if (tree) modes.push('tree');
  if (m?.json) modes.push('text');
  if (hex) modes.push('hex');
  if (f.base64 !== undefined) modes.push('base64');
  const [picked, setPicked] = useState<MsgMode | undefined>();
  const mode = picked && modes.includes(picked) ? picked : modes[0];
  const label: Record<MsgMode, string> = {
    tree: m?.via === 'raw' ? 'Raw fields' : 'JSON', text: 'Text', hex: 'Hex', base64: 'Base64',
  };
  const copy = mode === 'base64' || mode === 'hex' ? f.base64 : m?.json;
  return (
    <div class="frame-detail grpc-message" aria-label={`Message ${n + 1}`}>
      <div class="body-meta">
        <span class="meta-item">{dirArrow(f)} {dirLabel(f)}</span>
        <span class="meta-item" title={formatTime(f.at)}>{formatRelative(f.at, start)}</span>
        <span class="meta-item" title={frameSizeTitle(f)}>{frameSizeText(f)}</span>
        {f.compressed && <span class="meta-item" title="Sent compressed (grpc-encoding); shown decompressed">compressed</span>}
        {f.dropped && <span class="badge mini dropped-badge" title={DROPPED_TITLE}>dropped</span>}
        {f.edited && <span class="badge mini edited-badge" title={EDITED_TITLE}>edited</span>}
        {m && <span class="meta-item">{m.via === 'schema' ? 'decoded with the app\'s schema' : m.via === 'raw' ? 'raw fields (no schema)' : 'not decoded'}</span>}
        {f.truncated && <span class="badge warn" title="The proxy keeps at most 64 KB of each message">truncated</span>}
        {m?.truncated && <span class="badge warn" title="The decoded view was cut">decode truncated</span>}
        <span class="spacer" />
        {modes.length > 1 && (
          <div class="seg small" role="group" aria-label="Message view">
            {modes.map((x) => (
              <button key={x} type="button" class="seg-btn" aria-pressed={mode === x} onClick={() => setPicked(x)}>{label[x]}</button>
            ))}
          </div>
        )}
        {copy !== undefined && (
          <Button kind="icon" title={mode === 'base64' || mode === 'hex' ? 'Copy as base64' : 'Copy message'} onClick={() => copyText(copy)}>
            <Icon name="copy" />
          </Button>
        )}
      </div>
      {m?.error && <div class="msg warn grpc-decode-error">Couldn't decode this message: {m.error}</div>}
      {mode === 'tree' && tree ? <JsonTree value={tree} fields={m?.via === 'schema' && f.dir === 'receive' ? fields : undefined} />
        : mode === 'text' && m?.json ? <pre class="code">{m.json}</pre>
        : mode === 'hex' && hex ? (
          <>
            <div class="binary" title={frameSizeTitle(f)}>protobuf ({f.sizeUnknown ? frameSizeText(f) : `${f.size.toLocaleString()} bytes`}){hex.shown < f.size || f.sizeUnknown ? ` — first ${hex.shown} shown` : ''}</div>
            <pre class="code hexdump">{hex.text}</pre>
          </>
        )
        : mode === 'base64' && f.base64 !== undefined ? <pre class="code grpc-base64">{f.base64 || '(empty message)'}</pre>
        : <div class="muted pad">{f.size === 0 ? 'Empty message (every field has its default value).' : 'No payload kept for this message.'}</div>}
    </div>
  );
}

/**
 * CONTRACTS §16.4 `Status.grpc.problem`: the proxy's self-check failed, so gRPC calls are only seen as undecrypted
 * tunnels. Dismissable for the current problem text.
 */
export function GrpcProblemBanner() {
  const { state } = useApp();
  const g = state.status.grpc;
  const [dismissed, setDismissed] = useState<string | undefined>();
  if (!g?.enabled || !g.problem || dismissed === g.problem) return null;
  return (
    <div class="warning-banner grpc-problem" role="alert" aria-label="gRPC problem">
      <span class="warning-icon" aria-hidden="true">⚠</span>
      <span class="warning-text">
        <strong>gRPC calls can't be decoded:</strong> {g.problem} They show as undecrypted tunnels until this is fixed.
      </span>
      <span class="spacer" />
      <Button kind="icon" title="Dismiss" onClick={() => setDismissed(g.problem)}><Icon name="close" /></Button>
    </div>
  );
}

/** CONTRACTS §16.5: what an undecrypted gRPC tunnel is and how to see its calls. */
export function GrpcTunnelExplanation({ host }: { host: string }) {
  const { state } = useApp();
  const hosts = state.status.grpc?.decryptHosts ?? [];
  return (
    <>
      <h4 class="section-title">Why it isn't decrypted</h4>
      <p>
        The app's gRPC channel uses TLS with its default credentials, which trust only the system's root certificates —
        not the Flutter Intercept CA. So the proxy passed the connection through: only the timing and the encrypted byte
        counts are known, and no rule applies except Block.
      </p>
      <h4 class="section-title">To see these calls</h4>
      <p>
        If the app trusts the Flutter Intercept CA in debug builds (it pins to it, or uses <code>onBadCertificate</code>),
        add <code>{host}</code> to <code>{GRPC_DECRYPT_SETTING}</code>. New connections are then decrypted and each call is
        listed with its messages — restart the app if it keeps an open channel. An insecure (h2c) channel is always shown.
      </p>
      <p>
        On an <strong>iOS simulator</strong>, turn on <code>{SIM_TRUST_SETTING}</code> (user settings) instead: the simulator
        then trusts the Flutter Intercept CA until the session ends, and TLS gRPC is decrypted without changing the app.
      </p>
      {hosts.length > 0 && (
        <p class="muted">Decrypted now: {hosts.map((h, i) => <span key={h}>{i ? ', ' : ''}<code>{h}</code></span>)}</p>
      )}
    </>
  );
}

// ---------------------------------------------------------------- breakpoints (CONTRACTS §17.2)

/** The editor of a paused gRPC call: the held message (JSON / base64), or the end of the call (status + trailers). */
export function GrpcPauseEditor({ ex }: { ex: Exchange }) {
  const p = ex.grpcPause;
  if (!p) {
    return <div class="muted pad">Paused at a breakpoint — waiting for the held message…</div>;
  }
  return p.kind === 'message'
    ? <GrpcMessagePause key={grpcPauseKey(ex)} ex={ex} p={p} />
    : <GrpcStatusPause key={grpcPauseKey(ex)} ex={ex} p={p} />;
}

function usePauseActions(ex: Exchange) {
  const { state, dispatch, post } = useApp();
  const busy = !!state.resolving[ex.id];
  const resume = (edit?: GrpcEdit) => {
    post(edit ? { type: 'resume', id: ex.id, edit } : { type: 'resume', id: ex.id });
    dispatch({ type: 'resolving', id: ex.id });
  };
  const abort = () => {
    post({ type: 'abort', id: ex.id });
    dispatch({ type: 'resolving', id: ex.id });
  };
  return { busy, resume, abort };
}

const ABORT_TITLE = 'Cancel the call both ways (RST_STREAM CANCEL) — the app sees CANCELLED';

function GrpcMessagePause({ ex, p }: { ex: Exchange; p: Extract<GrpcPause, { kind: 'message' }> }) {
  const { state } = useApp();
  const { busy, resume, abort } = usePauseActions(ex);
  const entry = state.grpcDecoded[ex.id];
  const dm = pausedDecoded(ex, entry?.decoded);
  const now = useDecodeDeadline(entry?.requestedAt, !!entry?.decoded);
  const loading = !dm && !!entry && !entry.decoded && now - entry.requestedAt < DECODE_TIMEOUT_MS;
  const canJson = dm?.via === 'schema' && dm.json !== undefined;
  const [picked, setPicked] = useState<'json' | 'base64' | undefined>();
  /** undefined = untouched (shows the original). */
  const [jsonText, setJsonText] = useState<string | undefined>();
  const [b64, setB64] = useState<string | undefined>();
  const mode = picked ?? (b64 !== undefined || !canJson ? 'base64' : 'json');
  const json = jsonText ?? dm?.json ?? '';
  const base64 = b64 ?? p.base64;
  const changed = mode === 'json'
    ? jsonText !== undefined && jsonText.trim() !== (dm?.json ?? '').trim()
    : b64 !== undefined && b64.replace(/\s+/g, '') !== p.base64;
  const error = !changed ? undefined
    : mode === 'json' ? grpcMessageError(json, 'json') ?? (json.trim() ? undefined : 'Enter the message as a JSON object, e.g. {}')
    : isBase64(base64) ? undefined : 'not valid base64 (A–Z, a–z, 0–9, +, /, = padding)';
  const canEdit = !busy && changed && !error;
  const edit = (): GrpcEdit => (mode === 'json'
    ? { messageJson: JSON.parse(json) as unknown }
    : { message: base64.replace(/\s+/g, '') });
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (canEdit) resume(edit());
      else if (!changed && !busy) resume();
    }
  };
  return (
    <form class="pause-editor grpc-pause-editor" aria-label="Edit the held gRPC message" onSubmit={(e) => e.preventDefault()} onKeyDown={onKeyDown}>
      <div class="msg info grpc-pause-what" role="note">
        {grpcPauseTitle(p)} <span class="muted">({formatBytes(p.size)})</span> Messages behind it wait; the other direction keeps flowing.
      </div>
      <div class="radios" role="radiogroup" aria-label="Edit as">
        <label class="radio" title={canJson ? undefined : loading ? 'Decoding the held message…' : 'The app\'s schema doesn\'t decode this message — edit it as base64'}>
          <input type="radio" name="grpc-pause-mode" checked={mode === 'json'} disabled={!canJson || busy} onChange={() => setPicked('json')} />
          JSON (encoded with the app's schema)
        </label>
        <label class="radio">
          <input type="radio" name="grpc-pause-mode" checked={mode === 'base64'} disabled={busy} onChange={() => setPicked('base64')} />
          Base64 protobuf
        </label>
      </div>
      {loading && <div class="hint grpc-pause-loading" aria-busy="true">Decoding the held message…</div>}
      {!loading && !canJson && (
        <div class="hint">
          {dm?.via === 'raw' ? 'No schema for this message: only base64 edits are possible.' : dm?.error ? `Couldn't decode it: ${dm.error}` : 'No decoded view: edit it as base64.'}
        </div>
      )}
      {mode === 'json' ? (
        <textarea class={`code-input grpc-pause-json${changed ? ' modified' : ''}`} rows={12} spellcheck={false} aria-label="Held message (JSON)"
          value={json} disabled={busy} aria-invalid={!!error} onInput={(e) => setJsonText((e.target as HTMLTextAreaElement).value)} />
      ) : (
        <textarea class={`code-input grpc-pause-b64${changed ? ' modified' : ''}`} rows={6} spellcheck={false} aria-label="Held message (base64)"
          value={base64} disabled={busy} aria-invalid={!!error} onInput={(e) => setB64((e.target as HTMLTextAreaElement).value)} />
      )}
      {dm?.via === 'raw' && dm.json && (
        <details class="file-content"><summary>Raw fields (read-only)</summary><pre class="code">{dm.json}</pre></details>
      )}
      {error && <div class="msg error" role="alert">{error}</div>}
      <div class="pe-actions">
        <Button kind="primary" disabled={!canEdit} onClick={() => resume(edit())}
          title={!changed ? 'Nothing changed yet' : 'Send the edited message instead (Ctrl/Cmd+Enter)'}>
          <Icon name="play" /> Resume with edit
        </Button>
        <Button onClick={() => resume()} disabled={busy} title="Forward the held message unchanged">Resume unchanged</Button>
        <Button onClick={() => resume({ drop: true })} disabled={busy}
          title="Drop this message: it is never delivered (recorded as dropped); the call goes on">
          Drop message
        </Button>
        <Button kind="danger" onClick={abort} disabled={busy} title={ABORT_TITLE}><Icon name="stop" /> Abort</Button>
        <span class="pe-summary">{busy ? 'Sent — waiting for the proxy…' : changed ? 'Edited' : 'No changes'}</span>
      </div>
    </form>
  );
}

const visibleTrailers = (t: GrpcPause & { kind: 'status' }): HeaderRow[] =>
  headersToRows(t.trailers).filter((r) => !reservedGrpcHeader(r.name));

function GrpcStatusPause({ ex, p }: { ex: Exchange; p: Extract<GrpcPause, { kind: 'status' }> }) {
  const { busy, resume, abort } = usePauseActions(ex);
  const original = useMemo(() => visibleTrailers(p), [p]);
  const [code, setCode] = useState(String(p.code));
  const [message, setMessage] = useState(p.message ?? '');
  const [rows, setRows] = useState<HeaderRow[]>(original);
  const trailersChanged = headersChanged(rowsToFlatRecord(original), rows);
  const statusChanged = code !== String(p.code) || message !== (p.message ?? '');
  const changed = statusChanged || trailersChanged;
  const error = grpcHeaderError(rows, 'Trailer');
  const canEdit = !busy && changed && !error;
  // REVIEW-11: `status` goes along only when the code or message changed — a trailers-only edit must not resend a
  // server code the proxy would refuse (above 16).
  const edit = (): GrpcEdit => ({
    ...(statusChanged ? { status: { code: Number(code), ...(message.trim() ? { message: message.trim() } : {}) } } : {}),
    ...(trailersChanged ? { trailers: rowsToFlatRecord(rows) } : {}),
  });
  /** The server sent a code outside 0–16: it can't be resent, so the status is read-only (trailers stay editable). */
  const fixed = !(Number.isInteger(p.code) && p.code >= 0 && p.code < GRPC_CODES.length);
  return (
    <form class="pause-editor grpc-pause-editor" aria-label="Edit the end of the gRPC call" onSubmit={(e) => e.preventDefault()}
      onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (canEdit) resume(edit()); else if (!changed && !busy) resume(); } }}>
      <div class="msg info grpc-pause-what" role="note">{grpcPauseTitle(p)}</div>
      <div class="field-row">
        <label class="field">
          <span>Status</span>
          {fixed ? (
            <input class="grpc-status-fixed" aria-label="gRPC status" value={grpcCodeLabel(p.code)} readOnly disabled />
          ) : (
            <select aria-label="gRPC status" value={code} disabled={busy} class={code !== String(p.code) ? 'modified' : undefined}
              onChange={(e) => setCode((e.target as HTMLSelectElement).value)}>
              {GRPC_CODES.map((_, c) => <option key={c} value={String(c)}>{grpcCodeLabel(c)}</option>)}
            </select>
          )}
        </label>
        <label class="field grow">
          <span>Message <span class="muted">(grpc-message)</span></span>
          <input value={message} disabled={busy || fixed} spellcheck={false} class={message !== (p.message ?? '') ? 'modified' : undefined}
            onInput={(e) => setMessage((e.target as HTMLInputElement).value)} />
        </label>
      </div>
      {fixed && (
        <div class="msg info grpc-status-fixed-note" role="note">
          The server sent status code {p.code}, outside the standard 0–16: it is forwarded as is and can't be changed here.
          The trailers can still be edited.
        </div>
      )}
      <h4 class={`section-title${trailersChanged ? ' modified' : ''}`}>Trailers</h4>
      <HeadersEditor rows={rows} disabled={busy} onChange={setRows} />
      <div class="hint">grpc-status and grpc-message come from the fields above; :pseudo headers and content-type can't be set.</div>
      {error && <div class="msg error" role="alert">{error}</div>}
      <div class="pe-actions">
        <Button kind="primary" disabled={!canEdit} onClick={() => resume(edit())}
          title={!changed ? 'Nothing changed yet' : 'End the call with this status and trailers (Ctrl/Cmd+Enter)'}>
          <Icon name="play" /> Resume with edit
        </Button>
        <Button onClick={() => resume()} disabled={busy} title="End the call with the server's status and trailers">Resume unchanged</Button>
        <Button kind="danger" onClick={abort} disabled={busy} title={ABORT_TITLE}><Icon name="stop" /> Abort</Button>
        <span class="pe-summary">{busy ? 'Sent — waiting for the proxy…' : changed ? 'Edited' : 'No changes'}</span>
      </div>
    </form>
  );
}

/** CONTRACTS §19.3: a simulator that couldn't be set to trust the CA — one dismissable warning per device + problem. */
export function SimTrustBanner() {
  const { state } = useApp();
  const failures = simTrustFailures(state.status.grpc?.simulatorTrust);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const shown = failures.filter((f) => !dismissed.includes(f.key));
  if (!shown.length) return null;
  return (
    <div class="warnings" role="status" aria-label="Simulator trust">
      {shown.map((f) => (
        <div key={f.key} class="warning-banner sim-trust-failed" role="alert">
          <span class="warning-icon" aria-hidden="true">⚠</span>
          <span class="warning-text">{f.text}</span>
          <span class="spacer" />
          <Button kind="icon" title="Dismiss" onClick={() => setDismissed([...dismissed, f.key])}><Icon name="close" /></Button>
        </div>
      ))}
    </div>
  );
}
