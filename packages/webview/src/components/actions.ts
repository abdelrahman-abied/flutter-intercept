// Exchange actions shared by the detail pane and the traffic list's context menu.
import { useApp } from '../context';
import { contentClassOf } from '../filter';
import type { Exchange, Rule, RuleAction, SnippetFormat } from '../protocol';
import type { MutateOp } from '@flutter-intercept/proxy/types';
import { canResend, describeMutateOp, grpcUnsendable, resendRequest, SNIPPET_FORMATS, SNIPPET_LABEL, unsendableBody } from '../state';
import { corsRuleFor, isNative, NATIVE_READ_ONLY, routeGlob } from '../coverage';
import { newId, splitUrl } from '../util';
import { isTunnel, TUNNEL_NO_ACTION } from '../connection';
import { expireTokenLabel } from '../scenarios';
import { GRPC_TUNNEL_NO_ACTION, grpcPath, isGrpc, isGrpcTunnel } from '../grpc';
import type { MenuItem } from './bits';

export interface ExchangeActions {
  copy: (format: SnippetFormat) => void;
  resend: () => void;
  editAndResend: () => void;
  openSource: (frame?: number) => void;
  createRule: (kind: RuleAction['kind']) => void;
  /** CONTRACTS §10.5: a mutate rule for this route, inserted first by the host. */
  /** `valueJson` = the user's literal JSON text for `set` (byte-exact on hosts that support it). */
  mutateField: (path: string, op: MutateOp['op'], value?: unknown, valueJson?: string) => void;
  pickModel: () => void;
  openViolation: (index: number) => void;
  generateModel: () => void;
  generateFixture: () => void;
  copyItems: MenuItem[];
  generateItems: MenuItem[];
  /** Everything, for the list's context menu. */
  menuItems: MenuItem[];
  resendDisabled?: string; // reason when "Resend" can't be used
  /** Why each intercept action can't be used for this exchange (absent = it can). */
  off: { mock?: string; block?: string; breakpoint?: string; edit?: string; generate?: string; copy?: string; expire?: string; rules?: string };
  /** CONTRACTS §18: open the rule editor on a new rewrite / script / map remote rule for this route (unsaved). */
  newRule: (kind: TemplateKind) => void;
  /** The "Rewrite / Script / Map remote for this…" menu items. */
  ruleItems: MenuItem[];
  /** CONTRACTS §11.3: insert a dev-only `cors` rule for this route FIRST (undoable); credentials only if asked. */
  addCorsRule: (credentials: boolean) => void;
  /** CONTRACTS §12.3 preset: the next `count` requests to `url` get 401 token_expired, then pass through. */
  expireToken: (url: string, count: number) => void;
}

const WS_NO_MOCK = 'Mock rules don\'t apply to WebSocket upgrades — block it or add a fault instead';
const WS_NO_RESEND = 'A WebSocket connection can\'t be resent';

/** CONTRACTS §16.2 / §16.5 / §18: what doesn't apply to a gRPC call, and why. */
export const GRPC_OFF = {
  generate: 'Dart models and test fixtures are generated from JSON HTTP responses — not gRPC calls',
  copy: 'cURL / Dart http / Dio snippets are for HTTP requests — not gRPC calls',
  expire: 'The Expire token preset answers HTTP 401 — for gRPC, mock the call with UNAUTHENTICATED instead',
} as const;

/** Why "Mock this" / "Block this" / … can't be used for `ex` (native exchanges are read-only). */
export function interceptOff(ex: Exchange): ExchangeActions['off'] {
  if (isNative(ex)) {
    return { mock: NATIVE_READ_ONLY, block: NATIVE_READ_ONLY, breakpoint: NATIVE_READ_ONLY, edit: NATIVE_READ_ONLY, generate: NATIVE_READ_ONLY, expire: NATIVE_READ_ONLY, rules: NATIVE_READ_ONLY };
  }
  // CONTRACTS §16.5: an undecrypted gRPC tunnel, like any tunnel — only Block applies.
  if (isGrpcTunnel(ex)) {
    const t = GRPC_TUNNEL_NO_ACTION;
    return { mock: t, breakpoint: t, edit: t, generate: t, copy: t, expire: t, rules: t };
  }
  // A gRPC call: every rule (mock → grpcMock) and resend apply (§18); snippets, generators and the preset don't.
  if (isGrpc(ex)) return canResend(ex) ? { ...GRPC_OFF } : { ...GRPC_OFF, edit: 'Wait until the call has finished' };
  // CONTRACTS §14.2: a TLS passthrough tunnel has no request to mock, pause, copy or resend — only Block applies.
  if (isTunnel(ex)) {
    return { mock: TUNNEL_NO_ACTION, breakpoint: TUNNEL_NO_ACTION, edit: TUNNEL_NO_ACTION, generate: TUNNEL_NO_ACTION, copy: TUNNEL_NO_ACTION, expire: TUNNEL_NO_ACTION, rules: TUNNEL_NO_ACTION };
  }
  const off: ExchangeActions['off'] = {};
  if (ex.kind === 'websocket') {
    off.mock = WS_NO_MOCK;
    off.edit = WS_NO_RESEND;
    off.rules = 'Rewrite, script and map remote rules are for HTTP requests and gRPC calls — not WebSocket connections';
  } else if (!canResend(ex)) {
    off.edit = 'Wait until the exchange has finished';
  }
  return off;
}

/** Why "Generate Dart model" can't be used for `ex`, if it can't. */
export function generateModelDisabled(ex: Exchange): string | undefined {
  if (ex.status === undefined) return 'No response to generate a model from';
  if (contentClassOf(ex) !== 'json') return 'The response is not JSON';
  return undefined;
}

/** Why "Generate test fixture" can't be used for `ex`, if it can't. */
export function generateFixtureDisabled(ex: Exchange): string | undefined {
  return ex.status === undefined ? 'No response to build a fixture from' : undefined;
}

/** "GET /users/42" (path without the query) for notices. */
export function routeLabel(ex: Pick<Exchange, 'method' | 'url'>): string {
  return `${ex.method} ${splitUrl(ex.url).path.split('?')[0] || '/'}`;
}

export function useExchangeActions(ex: Exchange): ExchangeActions {
  const { state, dispatch, post } = useApp();
  const off = interceptOff(ex);
  const copy = (format: SnippetFormat) => {
    if (off.copy) return;
    post({ type: 'copySnippet', id: ex.id, format });
    dispatch({ type: 'notice', text: `Copied as ${SNIPPET_LABEL[format]}`, short: true });
  };
  const resendDisabled = isNative(ex)
    ? NATIVE_READ_ONLY
    : isGrpcTunnel(ex)
      ? GRPC_TUNNEL_NO_ACTION
    : isGrpc(ex)
      ? (!canResend(ex) ? 'Wait until the call has finished'
        : grpcUnsendable(ex) ? `${grpcUnsendable(ex)} Use “Edit and resend”.` : undefined)
    : isTunnel(ex)
      ? TUNNEL_NO_ACTION
    : ex.kind === 'websocket'
      ? WS_NO_RESEND
      : !canResend(ex)
    ? 'Wait until the exchange has finished'
    : unsendableBody(ex)
      ? 'The original body is binary or truncated — use “Edit and resend”'
      : undefined;
  const resend = () => {
    const request = resendRequest(ex);
    if (request) post({ type: 'send', request, resentFrom: ex.id });
  };
  const editAndResend = () => dispatch({ type: 'openComposer', id: ex.id });
  const openSource = (frame?: number) => {
    const f = frame ?? ex.source?.appFrame;
    post(f === undefined ? { type: 'openSource', id: ex.id } : { type: 'openSource', id: ex.id, frame: f });
  };
  const createRule = (requested: RuleAction['kind']) => {
    if (isNative(ex) || (requested !== 'block' && isTunnel(ex))) return;
    // CONTRACTS §16.4: "Mock this" on a gRPC call makes a gRPC mock answering with this call's messages and status.
    const kind = isGrpc(ex) && requested === 'mock' ? 'grpcMock' : requested;
    dispatch({ type: 'awaitRule', kind });
    post({ type: 'createRuleFromExchange', id: ex.id, action: kind });
  };
  const mutateField = (path: string, op: MutateOp['op'], value?: unknown, valueJson?: string) => {
    const what = describeMutateOp(op === 'set' ? { path, op, value, valueJson } : { path, op });
    dispatch({ type: 'awaitRule', kind: 'mutate', label: `${what} in the next ${routeLabel(ex)} responses.` });
    // `value` stays for hosts that predate `valueJson`.
    post(op === 'set'
      ? { type: 'mutateField', id: ex.id, path, op, value, ...(valueJson !== undefined ? { valueJson } : {}) }
      : { type: 'mutateField', id: ex.id, path, op });
  };
  const pickModel = () => post({ type: 'pickModel', id: ex.id });
  const openViolation = (index: number) => post({ type: 'openViolation', id: ex.id, index });
  const generateModel = () => {
    post({ type: 'generateModel', id: ex.id });
    dispatch({ type: 'notice', text: `Generating a Dart model from the recorded ${routeLabel(ex)} responses — it opens in a new editor.`, short: true });
  };
  const generateFixture = () => {
    post({ type: 'generateFixture', id: ex.id });
    dispatch({ type: 'notice', text: `Generating a test fixture for ${routeLabel(ex)} — the JSON and the test open in new editors.`, short: true });
  };
  const addCorsRule = (credentials: boolean) => {
    const rule = corsRuleFor(ex, { credentials });
    if (!rule) return;
    const rules = [rule, ...state.rules];
    const origin = rule.action.kind === 'cors' ? rule.action.allowOrigin : '';
    dispatch({
      type: 'setRules', rules, undoable: true,
      notice: `CORS rule added first: ${origin} may read ${routeGlob(ex.url)} responses, ` +
        `credentials ${credentials ? 'ON (cookies included)' : 'off'} — development only, the server is not fixed.`,
    });
    post({ type: 'setRules', rules });
  };
  const expireToken = (url: string, count: number) => {
    if (off.expire) return;
    dispatch({ type: 'awaitRule', kind: 'sequence', label: expireTokenLabel(url, count) });
    post({ type: 'expireToken', url, count });
  };
  const modelOff = off.generate ?? generateModelDisabled(ex);
  const fixtureOff = off.generate ?? generateFixtureDisabled(ex);
  const copyItems: MenuItem[] = SNIPPET_FORMATS.map((f) => ({
    label: `Copy as ${SNIPPET_LABEL[f]}`, onSelect: () => copy(f), ...(off.copy ? { disabled: true, title: off.copy } : {}),
  }));
  const generateItems: MenuItem[] = [
    { label: 'Generate Dart model', onSelect: generateModel, disabled: !!modelOff, title: modelOff ?? 'Dart model classes from every recorded response of this route' },
    { label: 'Generate test fixture', onSelect: generateFixture, disabled: !!fixtureOff, title: fixtureOff ?? 'A JSON fixture and a test that mocks this request' },
  ];
  const newRule = (kind: TemplateKind) => {
    if (off.rules) return;
    dispatch({ type: 'newRuleFrom', rule: ruleTemplateFor(ex, kind) });
  };
  const ruleItems: MenuItem[] = (Object.keys(TEMPLATE_LABEL) as TemplateKind[]).map((k) => ({
    label: TEMPLATE_LABEL[k], onSelect: () => newRule(k), ...(off.rules ? { disabled: true, title: off.rules } : { title: TEMPLATE_TITLE[k] }),
  }));
  const menuItems: MenuItem[] = [
    ...copyItems,
    { label: 'Resend', onSelect: resend, disabled: !!resendDisabled, title: resendDisabled, separatorBefore: true },
    { label: 'Edit and resend…', onSelect: editAndResend, disabled: !!off.edit, title: off.edit },
    ...(ex.source ? [{ label: 'Open source', onSelect: () => openSource(), separatorBefore: true }] : []),
    { label: 'Mock this', onSelect: () => createRule('mock'), separatorBefore: true, disabled: !!off.mock, title: off.mock },
    { label: 'Block this', onSelect: () => createRule('block'), disabled: !!off.block, title: off.block },
    { label: 'Break on this', onSelect: () => createRule('breakpoint'), disabled: !!off.breakpoint, title: off.breakpoint },
    ...ruleItems,
    { ...generateItems[0], separatorBefore: true },
    generateItems[1],
  ];
  return {
    copy, resend, editAndResend, openSource, createRule, mutateField, pickModel, openViolation, generateModel, generateFixture,
    copyItems, generateItems, menuItems, resendDisabled, off, addCorsRule, expireToken, newRule, ruleItems,
  };
}

export type TemplateKind = 'rewrite' | 'script' | 'mapRemote';
export const TEMPLATE_LABEL: Record<TemplateKind, string> = {
  rewrite: 'Rewrite this…', script: 'Script for this…', mapRemote: 'Map this to another server…',
};
const TEMPLATE_TITLE: Record<TemplateKind, string> = {
  rewrite: 'A new rewrite rule for this route (headers, trailers, body text) — opens in the rule editor, unsaved',
  script: 'A new script rule for this route — opens in the rule editor, unsaved',
  mapRemote: 'A new Map Remote rule sending this route to another server — opens in the rule editor, unsaved',
};

/** A new rule for `ex`'s route (gRPC: exactly this method) with an empty action of `kind`, for the editor to fill. */
export function ruleTemplateFor(ex: Exchange, kind: TemplateKind): Rule {
  const grpc = isGrpc(ex);
  const url = grpc ? ex.url.split(/[?#]/)[0] : routeGlob(ex.url);
  const action: Rule['action'] = kind === 'rewrite' ? { kind: 'rewrite' } : kind === 'script' ? { kind: 'script', code: '' } : { kind: 'mapRemote', to: '' };
  const what = kind === 'rewrite' ? 'Rewrite' : kind === 'script' ? 'Script' : 'Map';
  return {
    id: newId('rule'), enabled: true, name: `${what} ${grpc ? grpcPath(ex) : routeLabel(ex)}`,
    match: { method: ex.method, url }, action,
  };
}
