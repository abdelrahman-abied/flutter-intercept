// Exchange actions shared by the detail pane and the traffic list's context menu.
import { useApp } from '../context';
import { contentClassOf } from '../filter';
import type { Exchange, RuleAction, SnippetFormat } from '../protocol';
import type { MutateOp } from '@flutter-intercept/proxy/types';
import { canResend, describeMutateOp, resendRequest, SNIPPET_FORMATS, SNIPPET_LABEL, unsendableBody } from '../state';
import { splitUrl } from '../util';
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
  const { dispatch, post } = useApp();
  const copy = (format: SnippetFormat) => {
    post({ type: 'copySnippet', id: ex.id, format });
    dispatch({ type: 'notice', text: `Copied as ${SNIPPET_LABEL[format]}`, short: true });
  };
  const resendDisabled = !canResend(ex)
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
  const modelOff = generateModelDisabled(ex);
  const fixtureOff = generateFixtureDisabled(ex);
  const copyItems: MenuItem[] = SNIPPET_FORMATS.map((f) => ({ label: `Copy as ${SNIPPET_LABEL[f]}`, onSelect: () => copy(f) }));
  const generateItems: MenuItem[] = [
    { label: 'Generate Dart model', onSelect: generateModel, disabled: !!modelOff, title: modelOff ?? 'Dart model classes from every recorded response of this route' },
    { label: 'Generate test fixture', onSelect: generateFixture, disabled: !!fixtureOff, title: fixtureOff ?? 'A JSON fixture and a test that mocks this request' },
  ];
  const menuItems: MenuItem[] = [
    ...copyItems,
    { label: 'Resend', onSelect: resend, disabled: !!resendDisabled, title: resendDisabled, separatorBefore: true },
    { label: 'Edit and resend…', onSelect: editAndResend, disabled: !canResend(ex), title: canResend(ex) ? undefined : 'Wait until the exchange has finished' },
    ...(ex.source ? [{ label: 'Open source', onSelect: () => openSource(), separatorBefore: true }] : []),
    { label: 'Mock this', onSelect: () => createRule('mock'), separatorBefore: true },
    { label: 'Block this', onSelect: () => createRule('block') },
    { label: 'Break on this', onSelect: () => createRule('breakpoint') },
    { ...generateItems[0], separatorBefore: true },
    generateItems[1],
  ];
  return {
    copy, resend, editAndResend, openSource, createRule, mutateField, pickModel, openViolation, generateModel, generateFixture,
    copyItems, generateItems, menuItems, resendDisabled,
  };
}
