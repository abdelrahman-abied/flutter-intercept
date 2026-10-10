// Exchange actions shared by the detail pane and the traffic list's context menu.
import { useApp } from '../context';
import { contentClassOf } from '../filter';
import type { Exchange, RuleAction, SnippetFormat } from '../protocol';
import type { MutateOp } from '@flutter-intercept/proxy/types';
import { canResend, describeMutateOp, resendRequest, SNIPPET_FORMATS, SNIPPET_LABEL, unsendableBody } from '../state';
import { corsRuleFor, isNative, NATIVE_READ_ONLY, routeGlob } from '../coverage';
import { splitUrl } from '../util';
import { isTunnel, TUNNEL_NO_ACTION } from '../connection';
import { expireTokenLabel } from '../scenarios';
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
  off: { mock?: string; block?: string; breakpoint?: string; edit?: string; generate?: string; copy?: string; expire?: string };
  /** CONTRACTS §11.3: insert a dev-only `cors` rule for this route FIRST (undoable); credentials only if asked. */
  addCorsRule: (credentials: boolean) => void;
  /** CONTRACTS §12.3 preset: the next `count` requests to `url` get 401 token_expired, then pass through. */
  expireToken: (url: string, count: number) => void;
}

const WS_NO_MOCK = 'Mock rules don\'t apply to WebSocket upgrades — block it or add a fault instead';
const WS_NO_RESEND = 'A WebSocket connection can\'t be resent';

/** Why "Mock this" / "Block this" / … can't be used for `ex` (native exchanges are read-only). */
export function interceptOff(ex: Exchange): ExchangeActions['off'] {
  if (isNative(ex)) {
    return { mock: NATIVE_READ_ONLY, block: NATIVE_READ_ONLY, breakpoint: NATIVE_READ_ONLY, edit: NATIVE_READ_ONLY, generate: NATIVE_READ_ONLY, expire: NATIVE_READ_ONLY };
  }
  // CONTRACTS §14.2: a TLS passthrough tunnel has no request to mock, pause, copy or resend — only Block applies.
  if (isTunnel(ex)) {
    return { mock: TUNNEL_NO_ACTION, breakpoint: TUNNEL_NO_ACTION, edit: TUNNEL_NO_ACTION, generate: TUNNEL_NO_ACTION, copy: TUNNEL_NO_ACTION, expire: TUNNEL_NO_ACTION };
  }
  const off: ExchangeActions['off'] = {};
  if (ex.kind === 'websocket') {
    off.mock = WS_NO_MOCK;
    off.edit = WS_NO_RESEND;
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
  const createRule = (kind: RuleAction['kind']) => {
    if (isNative(ex) || (kind !== 'block' && isTunnel(ex))) return;
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
  const menuItems: MenuItem[] = [
    ...copyItems,
    { label: 'Resend', onSelect: resend, disabled: !!resendDisabled, title: resendDisabled, separatorBefore: true },
    { label: 'Edit and resend…', onSelect: editAndResend, disabled: !!off.edit, title: off.edit },
    ...(ex.source ? [{ label: 'Open source', onSelect: () => openSource(), separatorBefore: true }] : []),
    { label: 'Mock this', onSelect: () => createRule('mock'), separatorBefore: true, disabled: !!off.mock, title: off.mock },
    { label: 'Block this', onSelect: () => createRule('block'), disabled: !!off.block, title: off.block },
    { label: 'Break on this', onSelect: () => createRule('breakpoint'), disabled: !!off.breakpoint, title: off.breakpoint },
    { ...generateItems[0], separatorBefore: true },
    generateItems[1],
  ];
  return {
    copy, resend, editAndResend, openSource, createRule, mutateField, pickModel, openViolation, generateModel, generateFixture,
    copyItems, generateItems, menuItems, resendDisabled, off, addCorsRule, expireToken,
  };
}
