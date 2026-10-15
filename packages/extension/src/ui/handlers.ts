/**
 * The webview's messages (CONTRACTS §4 ViewMsg), one handler per type (QUALITY-1 Q3: replaces the controller's switch).
 * Each handler validates its message, acts through the controller and answers on `reply`; a throw becomes an `error`
 * message (InterceptController.handle). Host obligations per message are documented on InterceptController.
 */
import type { Rule, SendRequest } from '@flutter-intercept/proxy';
import { ruleFromExchange } from '@flutter-intercept/proxy/rules';
import { SNIPPET_FORMATS } from '../codegen/snippets';
import { scriptFileOf, scriptTemplate } from '../rules/scriptFile';
import type { InterceptController, Sink } from './controller';
import { CLIENT_CERT_UI_MISSING, CERT_TOKEN_EXPIRED, CERT_TOKEN_RE, MAX_CERT_PASSPHRASE_CHARS, MAX_CERT_TOKENS, type ClientCertUi } from './clientCertUi';
import { GRPC_WEB_RESEND, grpcMockRuleFromExchange, grpcResendMessages, resolveGrpcEdit, resolveSendGrpc } from './grpcHost';
import type { ViewMsg } from './protocol';
import { checkBodyFile, checkId, checkRuleId, checkScriptFile, fail, isInt, isObj, MAX_BODY_FILE_BYTES, MAX_SCRIPT_BYTES, onlyKeys, sanitizeGrpcSendHeaders, validateEdit, validateRule, validateSendDraft } from './validate';
import { contractSummary, readOnlyReason, recordingSummary, RULE_KINDS, ruleFromExchangeErrorMessage, snippetFor, tunnelBlockRule } from './views';

const CERT_ROLES = new Set(['pfx', 'cert', 'key']);
/** A host name (or IP literal) as the proxy keys learned passthrough entries (`host:port`). */
const LEARNED_HOST = /^[a-z0-9._\-:[\]]{1,260}$/i;

function certUiOrThrow(c: InterceptController): ClientCertUi {
  if (!c.deps.clientCertUi) throw new Error(CLIENT_CERT_UI_MISSING);
  return c.deps.clientCertUi;
}

function checkCertToken(v: unknown, field: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !CERT_TOKEN_RE.test(v)) fail('addClientCertificate', `${field} must be a file token from chooseClientCertificateFile`);
  return v;
}

/** One handler per ViewMsg type. */
export type ViewHandlers = { [K in ViewMsg['type']]: (msg: Extract<ViewMsg, { type: K }>, reply: Sink) => Promise<void> | void };

export function createViewHandlers(c: InterceptController): ViewHandlers {
  return {
    ready: async (msg, reply) => {
      c.readyCount++;
      c.flush();
      c.send(reply, c.snapshot());
      const current = c.deps.host.getExchanges();
      const results = current.flatMap((e) => {
        const r = c.contractResults.get(e.id);
        return r ? [contractSummary(r)] : [];
      });
      if (results.length) c.send(reply, { type: 'contract', results });
      for (const e of current) c.maybeCheck(e);
      if (c.deps.analyzeAuth) c.send(reply, { type: 'authFlows', flows: c.authFlows() });
      if (c.deps.recordings) {
        try {
          c.send(reply, { type: 'recordings', recordings: (await c.deps.recordings.list()).map(recordingSummary) });
        } catch (e) {
          c.deps.log?.(`listing recordings failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return;
    },
    resume: async (msg, reply) => {
      // CONTRACTS §17.2: a paused gRPC call takes a GrpcEdit
      const gex = c.deps.host.getExchanges().find((e) => e.id === msg.id);
      if (gex?.kind === 'grpc' && gex.grpcPause) {
        c.deps.host.resume(gex.id, resolveGrpcEdit(gex, msg.edit, c.deps.grpc));
        return;
      }
      const id = checkId(msg.id, 'resume');
      const ex = c.deps.host.getExchanges().find((e) => e.id === id);
      const phase = ex?.state === 'paused-request' ? 'request' : ex?.state === 'paused-response' ? 'response' : undefined;
      c.deps.host.resume(id, validateEdit(msg.edit, phase));
      return;
    },
    abort: async (msg, reply) => {
      c.deps.host.abort(checkId(msg.id, 'abort'));
      return;
    },
    setRules: async (msg, reply) => {
      c.applyRules(msg.rules);
      return;
    },
    clear: async (msg, reply) => {
      c.clear();
      return;
    },
    setInterceptEnabled: async (msg, reply) => {
      if (typeof msg.enabled !== 'boolean') fail('setInterceptEnabled', 'enabled must be a boolean');
      await c.deps.setEnabled(msg.enabled);
      c.broadcastStatus();
      return;
    },
    createRuleFromExchange: async (msg, reply) => {
      if (!RULE_KINDS.has(msg.action)) fail('createRuleFromExchange', `unknown rule action ${JSON.stringify(msg.action)}`);
      const id = checkId(msg.id, 'createRuleFromExchange');
      const ex = c.deps.host.getExchanges().find((e) => e.id === id);
      if (!ex) throw new Error('That exchange is no longer available.');
      const ro = readOnlyReason(ex);
      if (ro) throw new Error(`Can't create a rule from this request: ${ro}.`);
      if (ex.kind === 'websocket' && msg.action !== 'block') {
        throw new Error(`Can't create ${msg.action === 'mock' ? 'a mock' : 'a breakpoint'} rule from a WebSocket: WebSocket connections can only be blocked (or failed with a fault rule).`);
      }
      if (ex.kind === 'tunnel' && msg.action !== 'block') {
        throw new Error(
          ex.grpcTunnel
            ? "Can't mock or pause this gRPC connection: it is TLS that isn't decrypted, so it can only be blocked (or failed with a fault rule). Add the host to flutterIntercept.grpc.decryptHosts if the app trusts the Flutter Intercept CA in debug."
            : ex.learnedPassthrough?.reason === 'client-certificate'
              ? `Can't create ${msg.action === 'mock' ? 'a mock' : msg.action === 'grpcMock' ? 'a gRPC mock' : 'a breakpoint'} rule from this connection: the server asks for the app's own client certificate, so it is passed through without decryption and can only be blocked (or failed with a fault rule). Add the certificate (Add client certificate…) to decrypt it.`
              : `Can't create ${msg.action === 'mock' ? 'a mock' : msg.action === 'grpcMock' ? 'a gRPC mock' : 'a breakpoint'} rule from a passed-through TLS connection: it isn't decrypted, so it can only be blocked (or failed with a fault rule). Remove the host from flutterIntercept.tlsPassthrough to mock it.`,
        );
      }
      // CONTRACTS §16.2 / §17.2: gRPC calls get gRPC mocks, blocks and breakpoints; HTTP mocks don't apply to them.
      if (ex.kind === 'grpc' && msg.action === 'mock') {
        throw new Error("Can't create an HTTP mock rule from a gRPC call: use a gRPC mock instead.");
      }
      if (msg.action === 'grpcMock' && ex.kind !== 'grpc') throw new Error("Can't create a gRPC mock from this request: it isn't a gRPC call.");
      let rule: Rule;
      try {
        rule = validateRule(
          ex.kind === 'tunnel'
            ? tunnelBlockRule(ex, c.newRuleId())
            : msg.action === 'grpcMock'
              ? grpcMockRuleFromExchange(ex, c.newRuleId(), c.deps.grpc)
              : ruleFromExchange(ex, msg.action, c.newRuleId()),
        );
      } catch (e) {
        throw new Error(ruleFromExchangeErrorMessage(e, msg.action === 'grpcMock' ? 'gRPC mock' : msg.action));
      }
      c.applyRules([rule, ...c.deps.host.getRules()]);
      return;
    },
    send: async (msg, reply) => {
      let request = validateSendDraft(msg.request);
      if (msg.resentFrom !== undefined) {
        const fromId = checkId(msg.resentFrom, 'send');
        const from = c.deps.host.getExchanges().find((e) => e.id === fromId);
        // REVIEW-12 #4: without its record the LAN check can't be made: refuse
        if (!from) throw new Error("Can't resend this request: its recorded exchange is no longer available (cleared or evicted).");
        const ro = from && readOnlyReason(from);
        if (ro) throw new Error(`Can't resend this request: ${ro}.`);
        if (from?.kind === 'tunnel') throw new Error("Can't resend a passed-through TLS connection: its request was never decrypted.");
        if (from?.grpc?.web) throw new Error(GRPC_WEB_RESEND);
        // CONTRACTS §18.4: resending a gRPC call unchanged sends its recorded request messages
        if (from?.kind === 'grpc' && !request.grpc) {
          try {
            request = { ...request, grpc: { messages: grpcResendMessages(from) }, ...(request.headers ? { headers: sanitizeGrpcSendHeaders(request.headers) } : {}) };
          } catch (e) {
            throw new Error(`Can't resend this gRPC call: ${(e as Error).message}.`);
          }
        }
      }
      if (request.grpc) {
        if (request.body !== undefined) throw new Error('A gRPC call has no body.');
        request = { ...request, grpc: resolveSendGrpc(request.url, request.grpc, c.deps.grpc) };
      }
      if (!c.deps.host.send) throw new Error('This proxy build cannot send requests.');
      const { id } = await c.deps.host.send({ ...(request as SendRequest), initiator: 'editor', ...(msg.resentFrom ? { resentFrom: msg.resentFrom } : {}) });
      c.send(reply, { type: 'sent', id });
      return;
    },
    openSource: async (msg, reply) => {
      const ex = c.exchangeOrThrow(checkId(msg.id, 'openSource'));
      const frames = ex.source?.frames ?? [];
      if (!frames.length) {
        throw new Error(
          ex.initiator
            ? 'No source for this request: it was sent from the editor or an agent, not by the app.'
            : 'No source for this request: its stack trace has not arrived (source capture may be off, or the app was launched before it was turned on).',
        );
      }
      const frame = msg.frame ?? ex.source?.appFrame;
      if (frame === undefined) throw new Error('No app call site was found in this request\'s stack trace. Pick a frame to open.');
      if (!isInt(frame, 0, frames.length - 1)) fail('openSource', `frame must be an index 0–${frames.length - 1}`);
      if (!c.deps.openSource) throw new Error('Opening source is not available in this editor.');
      await c.deps.openSource(ex, frame);
      return;
    },
    copySnippet: async (msg, reply) => {
      if (!SNIPPET_FORMATS.includes(msg.format)) fail('copySnippet', `unknown format ${JSON.stringify(msg.format)}`);
      const ex = c.exchangeOrThrow(checkId(msg.id, 'copySnippet'));
      if (!c.deps.copyToClipboard) throw new Error('Copying is not available in this editor.');
      // The user's own clipboard: unredacted (CONTRACTS §9.3).
      await c.deps.copyToClipboard(snippetFor(ex, msg.format, { grpc: c.deps.grpc, projectRoot: c.deps.projectRoot?.() }));
      return;
    },
    setNetworkProfile: async (msg, reply) => {
      c.setNetworkProfile(msg.profile);
      return;
    },
    pickModel: async (msg, reply) => {
      await c.pickModel(c.exchangeOrThrow(checkId(msg.id, 'pickModel')));
      return;
    },
    openViolation: async (msg, reply) => {
      const id = checkId(msg.id, 'openViolation');
      const r = c.contractResults.get(id);
      if (!r) throw new Error('This request has no contract check result (yet).');
      if (!isInt(msg.index, 0, Math.max(0, r.violations.length - 1)) || !r.violations.length) fail('openViolation', 'index is out of range');
      const v = r.violations[msg.index];
      if (!v.file) throw new Error(`The source file of model ${v.model} is unknown.`);
      if (!c.deps.openLocation) throw new Error('Opening files is not available in this editor.');
      await c.deps.openLocation(v.file, v.line ?? 1);
      return;
    },
    mutateField: async (msg, reply) => {
      c.mutateField(c.exchangeOrThrow(checkId(msg.id, 'mutateField')), msg);
      return;
    },
    generateModel: async (msg, reply) => {
      await c.generateModel(c.exchangeOrThrow(checkId(msg.id, 'generateModel')));
      return;
    },
    // ---- CONTRACTS §12.7
    generateFixture: async (msg, reply) => {
      await c.generateFixture(c.exchangeOrThrow(checkId(msg.id, 'generateFixture')));
      return;
    },
    shareRule: async (msg, reply) => {
      if (typeof msg.shared !== 'boolean') fail('shareRule', 'shared must be a boolean');
      await c.shareRule(checkId(msg.id, 'shareRule'), msg.shared);
      return;
    },
    approveSharedRules: async (msg, reply) => {
      await c.approveSharedRules();
      return;
    },
    openSharedRules: async (msg, reply) => {
      if (!c.deps.openSharedRules) throw new Error('Shared rules need a workspace folder (.vscode/flutter-intercept.json).');
      await c.deps.openSharedRules();
      return;
    },
    openBodyFile: async (msg, reply) => {
      const p = checkBodyFile(msg.path, 'openBodyFile', 'path');
      let create: { content: string } | undefined;
      if (msg.create !== undefined) {
        if (!isObj(msg.create)) fail('openBodyFile', 'create must be an object {content}');
        onlyKeys(msg.create, ['content'], 'openBodyFile.create');
        const content = msg.create.content;
        if (typeof content !== 'string') fail('openBodyFile', 'create.content must be a string');
        if (Buffer.byteLength(content, 'utf8') > MAX_BODY_FILE_BYTES) fail('openBodyFile', 'create.content must be at most 5 MB');
        create = { content };
      }
      const ruleId = checkRuleId(msg.ruleId, 'openBodyFile');
      if (!c.deps.openBodyFile) throw new Error('Opening body files is not available in this editor.');
      await c.deps.openBodyFile(p, create, ruleId);
      return;
    },
    saveRecording: async (msg, reply) => {
      await c.saveRecording(msg);
      return;
    },
    replayRecording: async (msg, reply) => {
      await c.replayRecording(msg.id === undefined ? undefined : checkId(msg.id, 'replayRecording'), msg.fallback);
      return;
    },
    diffRecordings: async (msg, reply) => {
      const { recordings } = c.recordingsOrThrow();
      if (!c.deps.openDiff) throw new Error('Comparing recordings is not available in this editor.');
      const a = checkId(msg.a, 'diffRecordings');
      const b = checkId(msg.b, 'diffRecordings');
      if (a === b) fail('diffRecordings', 'pick two different recordings');
      const [ra, rb] = await Promise.all([recordings.load(a), recordings.load(b)]);
      await c.deps.openDiff(ra, rb);
      return;
    },
    deleteRecording: async (msg, reply) => {
      await c.deleteRecording(checkId(msg.id, 'deleteRecording'));
      return;
    },
    // ---- CONTRACTS §13.7
    expireToken: async (msg, reply) => {
      c.expireToken(msg.url, msg.count);
      return;
    },
    export: async (msg, reply) => {
      const file = await c.exportTraffic(msg.format, msg.ids);
      if (file) c.send(reply, { type: 'exported', format: msg.format, path: file });
      return;
    },
    openScriptFile: async (msg, reply) => {
      const p = checkScriptFile(msg.path, 'openScriptFile', 'path');
      const ruleId = checkRuleId(msg.ruleId, 'openScriptFile');
      let create: { content: string } | undefined;
      if (msg.create !== undefined) {
        if (!isObj(msg.create)) fail('openScriptFile', 'create must be an object {content}');
        onlyKeys(msg.create, ['content'], 'openScriptFile.create');
        const content = msg.create.content;
        if (typeof content !== 'string') fail('openScriptFile', 'create.content must be a string');
        if (Buffer.byteLength(content, 'utf8') > MAX_SCRIPT_BYTES) fail('openScriptFile', 'create.content must be at most 256 KB');
        // Empty content: the starter template, naming the rule that uses this file (if one does).
        const owner = c.deps.host.getRules().find((r) => (ruleId !== undefined ? r.id === ruleId : scriptFileOf(r) === p));
        create = { content: content.trim() ? content : scriptTemplate(owner) };
      }
      if (!c.deps.openScriptFile) throw new Error('Opening script files is not available in this editor.');
      await c.deps.openScriptFile(p, create, ruleId);
      return;
    },
    // ---- CONTRACTS §16.4
    openInNewWindow: async (msg, reply) => {
      if (!c.deps.openInNewWindow) throw new Error('Opening the traffic view in a new window is not available in this editor.');
      await c.deps.openInNewWindow();
      return;
    },
    decodeGrpc: async (msg, reply) => {
      const id = checkId(msg.id, 'decodeGrpc');
      c.send(reply, { type: 'grpcDecoded', id, decoded: c.decodeGrpc(id) });
      return;
    },
    // ---- CONTRACTS §20.3 (never a path or the passphrase in a reply or a log line)
    chooseClientCertificateFile: async (msg, reply) => {
      onlyKeys(msg as unknown as Record<string, unknown>, ['type', 'role'], 'chooseClientCertificateFile');
      if (!CERT_ROLES.has(msg.role)) fail('chooseClientCertificateFile', 'role must be "pfx", "cert" or "key"');
      const ui = certUiOrThrow(c);
      let file: { token: string; name: string } | undefined;
      try {
        file = await ui.choose(msg.role);
      } catch (e) {
        c.send(reply, { type: 'clientCertificateFile', role: msg.role, problem: e instanceof Error ? e.message : String(e) });
        return;
      }
      if (!file) {
        c.send(reply, { type: 'clientCertificateFile', role: msg.role });
        return;
      }
      // The token is bound to this view (CONTRACTS §20.3).
      let mine = c.certTokens.get(reply);
      if (!mine) c.certTokens.set(reply, (mine = new Set()));
      mine.add(file.token);
      while (mine.size > MAX_CERT_TOKENS) mine.delete(mine.values().next().value as string);
      c.send(reply, { type: 'clientCertificateFile', role: msg.role, file: { token: file.token, name: file.name } });
    },
    addClientCertificate: async (msg, reply) => {
      onlyKeys(msg as unknown as Record<string, unknown>, ['type', 'host', 'pfx', 'cert', 'key', 'passphrase'], 'addClientCertificate');
      if (typeof msg.host !== 'string' || msg.host.length > 300) fail('addClientCertificate', 'host must be a host name pattern');
      const pfx = checkCertToken(msg.pfx, 'pfx');
      const cert = checkCertToken(msg.cert, 'cert');
      const key = checkCertToken(msg.key, 'key');
      if (msg.passphrase !== undefined && (typeof msg.passphrase !== 'string' || msg.passphrase.length > MAX_CERT_PASSPHRASE_CHARS)) {
        fail('addClientCertificate', `passphrase must be a string of at most ${MAX_CERT_PASSPHRASE_CHARS} characters`);
      }
      const ui = certUiOrThrow(c);
      const host = msg.host;
      const mine = c.certTokens.get(reply);
      const tokens = [pfx, cert, key].filter((t): t is string => t !== undefined);
      if (tokens.some((t) => !mine?.has(t))) {
        c.send(reply, { type: 'clientCertificateSaved', host, problem: CERT_TOKEN_EXPIRED });
        return;
      }
      let problem: string | undefined;
      try {
        ({ problem } = await ui.add({ host, ...(pfx ? { pfx } : {}), ...(cert ? { cert } : {}), ...(key ? { key } : {}), ...(msg.passphrase ? { passphrase: msg.passphrase } : {}) }));
      } catch (e) {
        problem = e instanceof Error ? e.message : String(e);
      }
      if (!problem) for (const t of tokens) mine?.delete(t);
      c.send(reply, { type: 'clientCertificateSaved', host, ...(problem ? { problem } : {}) });
    },
    removeClientCertificate: async (msg, reply) => {
      onlyKeys(msg as unknown as Record<string, unknown>, ['type', 'host'], 'removeClientCertificate');
      if (typeof msg.host !== 'string' || !msg.host.trim() || msg.host.length > 300) fail('removeClientCertificate', 'host must be a host name pattern');
      await certUiOrThrow(c).remove(msg.host);
    },
    forgetLearnedPassthrough: async (msg, reply) => {
      onlyKeys(msg as unknown as Record<string, unknown>, ['type', 'host', 'port'], 'forgetLearnedPassthrough');
      if (msg.host !== undefined && (typeof msg.host !== 'string' || !LEARNED_HOST.test(msg.host))) fail('forgetLearnedPassthrough', 'host must be a host name');
      if (msg.port !== undefined && !isInt(msg.port, 1, 65535)) fail('forgetLearnedPassthrough', 'port must be 1–65535');
      if (msg.port !== undefined && msg.host === undefined) fail('forgetLearnedPassthrough', 'port needs a host');
      const h = c.deps.host;
      if (!h.forgetLearnedPassthrough) throw new Error("Forgetting learned hosts isn't available here.");
      if (msg.host === undefined) {
        h.forgetLearnedPassthrough();
        return;
      }
      const host = msg.host.toLowerCase();
      if (msg.port !== undefined) {
        h.forgetLearnedPassthrough(`${host}:${msg.port}`);
        return;
      }
      // A host without a port: every learned port of it.
      for (const l of h.learnedPassthrough ?? []) if (l.host.toLowerCase() === host) h.forgetLearnedPassthrough(`${l.host}:${l.port}`);
    },
  };
}
