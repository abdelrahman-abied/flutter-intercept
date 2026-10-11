// v0.10.0 gRPC views (CONTRACTS §16.5): the decode request on open, the status block in the detail header, trailers,
// one message's decoded / raw / hex view, and the status banner for Status.grpc.problem.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { useApp } from '../context';
import type { Exchange, Frame, GrpcDecodedMessage } from '../protocol';
import {
  DECODE_TIMEOUT_MS, GRPC_DECRYPT_SETTING, grpcCodeLabel, grpcCountsText, grpcFacts, grpcPath, grpcVersion, hexTextDump, isGrpc,
  needsDecode,
} from '../grpc';
import { dirArrow, dirLabel, formatRelative, frameSizeText, frameSizeTitle, hexDump } from '../frames';
import { parseJsonLossless } from '../json';
import { formatTime, type Headers } from '../util';
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
  const g = ex.grpc;
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

/** One gRPC message: decoded JSON (schema) or raw fields as a tree, the text, hex, and the payload as base64. */
export function GrpcMessageDetail({ f, n, start, m }: { f: Frame; n: number; start: number; m?: GrpcDecodedMessage }) {
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
      {mode === 'tree' && tree ? <JsonTree value={tree} />
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
      {hosts.length > 0 && (
        <p class="muted">Decrypted now: {hosts.map((h, i) => <span key={h}>{i ? ', ' : ''}<code>{h}</code></span>)}</p>
      )}
    </>
  );
}
