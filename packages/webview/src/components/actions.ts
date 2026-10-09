// Exchange actions shared by the detail pane and the traffic list's context menu.
import { useApp } from '../context';
import type { Exchange, RuleAction, SnippetFormat } from '../protocol';
import { canResend, resendRequest, SNIPPET_FORMATS, SNIPPET_LABEL, unsendableBody } from '../state';
import type { MenuItem } from './bits';

export interface ExchangeActions {
  copy: (format: SnippetFormat) => void;
  resend: () => void;
  editAndResend: () => void;
  openSource: (frame?: number) => void;
  createRule: (kind: RuleAction['kind']) => void;
  copyItems: MenuItem[];
  /** Everything, for the list's context menu. */
  menuItems: MenuItem[];
  resendDisabled?: string; // reason when "Resend" can't be used
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
  const copyItems: MenuItem[] = SNIPPET_FORMATS.map((f) => ({ label: `Copy as ${SNIPPET_LABEL[f]}`, onSelect: () => copy(f) }));
  const menuItems: MenuItem[] = [
    ...copyItems,
    { label: 'Resend', onSelect: resend, disabled: !!resendDisabled, title: resendDisabled, separatorBefore: true },
    { label: 'Edit and resend…', onSelect: editAndResend, disabled: !canResend(ex), title: canResend(ex) ? undefined : 'Wait until the exchange has finished' },
    ...(ex.source ? [{ label: 'Open source', onSelect: () => openSource(), separatorBefore: true }] : []),
    { label: 'Mock this', onSelect: () => createRule('mock'), separatorBefore: true },
    { label: 'Block this', onSelect: () => createRule('block') },
    { label: 'Break on this', onSelect: () => createRule('breakpoint') },
  ];
  return { copy, resend, editAndResend, openSource, createRule, copyItems, menuItems, resendDisabled };
}
