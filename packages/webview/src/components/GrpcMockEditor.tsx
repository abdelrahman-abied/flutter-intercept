// The `grpcMock` action editor (CONTRACTS §16.2 / §16.5), shared by the rule editor and sequence steps.
// Split out of ActionEditor.tsx (QUALITY-1 Q6: no webview file over 700 lines).
import { GRPC_CODES, grpcCodeLabel } from '../grpc';
import type { ActionFields, ActionValidation } from '../state';
import { Button } from './bits';
import { HeadersEditor } from './Editors';
import { Icon } from './Icon';

/** What the gRPC mock editor knows about the matched method (from the host's `grpcDecoded`). */
export interface GrpcHooks {
  /** Example response JSON with every field, when the schema knows the matched method. */
  skeleton?: string;
  /** No skeleton yet, but a matching gRPC call is listed: asking the host to decode it may bring one. */
  canLoad: boolean;
  load: () => void;
  loading: boolean;
  /** The extension has a protobuf schema (Status.grpc.schema): JSON messages can be encoded. */
  schema?: boolean;
}

/**
 * The `grpcMock` action: status code (by name), grpc-message, response messages (JSON objects the extension encodes
 * with the app's schema, or base64 protobuf), delay before the headers, gap between messages, extra headers / trailers.
 */
export function GrpcMockEditor({ uid, f, v, set, compact, grpc }: {
  uid: string; f: ActionFields; v: ActionValidation; set: (patch: Partial<ActionFields>) => void; compact?: boolean; grpc?: GrpcHooks;
}) {
  const msgs = f.grpcMessages;
  const json = f.grpcMessagesMode === 'json';
  const setMsg = (i: number, text: string) => set({ grpcMessages: msgs.map((m, k) => (k === i ? text : m)) });
  const code = f.grpcCode.trim();
  const known = /^\d+$/.test(code) && +code < GRPC_CODES.length;
  const fillSkeleton = () => {
    if (!grpc?.skeleton) return;
    // Fill the first empty (or "{}") entry, else add one.
    const i = msgs.findIndex((m) => !m.trim() || m.trim() === '{}');
    set({ grpcMessages: i >= 0 ? msgs.map((m, k) => (k === i ? grpc.skeleton! : m)) : [...msgs, grpc.skeleton] });
  };
  return (
    <div class="grpc-mock-editor">
      <div class="hint">
        Answers matching gRPC calls locally — the server is not contacted: response headers, then each message, then the
        status in the trailers. A non-OK status with no messages is sent trailers-only, like a real server error.
      </div>
      <div class="field-row">
        <label class="field">
          <span>Status</span>
          <select aria-label="gRPC status" value={code} aria-invalid={!!v.errors.grpcCode}
            onChange={(e) => set({ grpcCode: (e.target as HTMLSelectElement).value })}>
            {GRPC_CODES.map((_, c) => <option key={c} value={String(c)}>{grpcCodeLabel(c)}</option>)}
            {!known && <option value={code}>{code || '?'}</option>}
          </select>
        </label>
        <label class="field grow">
          <span>Message <span class="muted">(grpc-message, optional)</span></span>
          <input value={f.grpcMessage} placeholder={code === '0' ? '' : 'e.g. backend unavailable'} spellcheck={false}
            onInput={(e) => set({ grpcMessage: (e.target as HTMLInputElement).value })} />
        </label>
      </div>
      <div class="field-row">
        <label class="field small-field">
          <span>Delay (ms)</span>
          <input value={f.grpcDelayMs} inputMode="numeric" placeholder="0" aria-invalid={!!v.errors.grpcDelayMs}
            onInput={(e) => set({ grpcDelayMs: (e.target as HTMLInputElement).value })} />
        </label>
        <label class="field small-field">
          <span>Gap (ms)</span>
          <input value={f.grpcGapMs} inputMode="numeric" placeholder="0" aria-invalid={!!v.errors.grpcGapMs}
            title="Time between response messages (streaming)"
            onInput={(e) => set({ grpcGapMs: (e.target as HTMLInputElement).value })} />
        </label>
      </div>
      {v.errors.grpcCode && <div class="msg error">Status: {v.errors.grpcCode}</div>}
      {v.errors.grpcDelayMs && <div class="msg error">{v.errors.grpcDelayMs}</div>}
      {v.errors.grpcGapMs && <div class="msg error">{v.errors.grpcGapMs}</div>}

      <div class="field-label">Response messages</div>
      <div class="radios" role="radiogroup" aria-label="Message format">
        <label class="radio">
          <input type="radio" name={`${uid}-grpcFormat`} checked={json} onChange={() => set({ grpcMessagesMode: 'json' })} />
          JSON (encoded with the app's schema)
        </label>
        <label class="radio">
          <input type="radio" name={`${uid}-grpcFormat`} checked={!json} onChange={() => set({ grpcMessagesMode: 'base64' })} />
          Base64 protobuf
        </label>
      </div>
      {json && grpc?.schema === false && (
        <div class="msg warn grpc-no-schema" role="note">
          No protobuf schema was found in the app's generated code (<code>*.pbgrpc.dart</code>), so JSON messages can't be
          encoded — use base64, or generate the Dart code with protoc.
        </div>
      )}
      <ol class="grpc-messages" aria-label="Response messages">
        {msgs.map((m, i) => (
          <li key={i} class="grpc-msg-row">
            <textarea class="code-input" rows={compact ? 3 : 5} spellcheck={false} value={m}
              aria-label={`Message ${i + 1}${compact ? ` (${uid})` : ''}`} aria-invalid={!!v.grpcErrors?.[i]}
              placeholder={json ? '{"id": "42", "name": "Ada"}' : 'CgJpZBIDQWRh'}
              onInput={(e) => setMsg(i, (e.target as HTMLTextAreaElement).value)} />
            <Button kind="icon" title={`Remove message ${i + 1}`} onClick={() => set({ grpcMessages: msgs.filter((_, k) => k !== i) })}>
              <Icon name="close" />
            </Button>
          </li>
        ))}
      </ol>
      <div class="file-actions">
        <button type="button" class="link" onClick={() => set({ grpcMessages: [...msgs, json ? '{}' : ''] })}>+ Add message</button>
        {json && grpc && (grpc.skeleton || grpc.canLoad) && (
          <Button onClick={grpc.skeleton ? fillSkeleton : grpc.load} disabled={grpc.loading}
            title={grpc.skeleton
              ? 'Fill a message with an example of the response type — every field, from the app\'s schema'
              : 'Decode the last matching call to get an example of the response type from the app\'s schema'}>
            {grpc.loading ? 'Loading skeleton…' : 'Skeleton'}
          </Button>
        )}
      </div>
      {v.errors.grpcMessages && <div class="msg error">{v.errors.grpcMessages}</div>}
      {!msgs.length && <div class="hint">No messages: only the status is sent.</div>}

      <div class="field-label">Extra headers</div>
      <HeadersEditor rows={f.grpcHeaders} onChange={(grpcHeaders) => set({ grpcHeaders })} />
      {v.errors.grpcHeaders && <div class="msg error">{v.errors.grpcHeaders}</div>}
      <div class="field-label">Extra trailers</div>
      <HeadersEditor rows={f.grpcTrailers} onChange={(grpcTrailers) => set({ grpcTrailers })} />
      {v.errors.grpcTrailers && <div class="msg error">{v.errors.grpcTrailers}</div>}
      <div class="hint">content-type, grpc-status and grpc-message are set by the proxy.</div>
    </div>
  );
}
