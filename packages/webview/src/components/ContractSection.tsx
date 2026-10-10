// "Model check" in the response tab (CONTRACTS §10.5): the contract-check result of one exchange.
import type { ContractSummary, Exchange } from '../protocol';
import { contractStatus, contractSummaryText, VIA_LABEL } from '../contract';
import { contentClassOf } from '../filter';

/** The checker stops after this many findings (CONTRACTS §10.3). */
export const MAX_VIOLATIONS = 50;

export function ContractSection({ ex, result, onPick, onOpen }: {
  ex: Exchange; result?: ContractSummary; onPick: () => void; onOpen: (index: number) => void;
}) {
  if (!result) {
    // Not checked (yet): only worth a line for JSON responses.
    if (ex.status === undefined || contentClassOf(ex) !== 'json') return null;
    return (
      <div class="contract contract-unchecked" aria-label="Model check">
        <span class="contract-title">Model check</span>
        <span class="muted">Not checked.</span>
        <button type="button" class="link" onClick={onPick}>Check against a model…</button>
      </div>
    );
  }
  if (!result.checked) {
    return (
      <div class="contract contract-unchecked" aria-label="Model check">
        <span class="contract-title">Model check</span>
        <span class="muted">{result.reason ?? 'Not checked.'}</span>
        <button type="button" class="link" onClick={onPick}>Check against a model…</button>
      </div>
    );
  }
  const status = contractStatus(result);
  return (
    <section class={`contract contract-${status}`} aria-label="Model check">
      <div class="contract-head">
        <span class="contract-title">Model check</span>
        <span class={`badge contract-badge cb-${status}`}>{contractSummaryText(result)}</span>
        {result.model && <code class="contract-model">{result.model}</code>}
        <span class="muted">{VIA_LABEL[result.via]}</span>
        <span class="spacer" />
        <button type="button" class="link" onClick={onPick} title="Choose the Dart model this route's responses are checked against">
          Check against a different model…
        </button>
      </div>
      {result.violations.length > 0 && (
        <ul class="violations" aria-label="Problems">
          {result.violations.map((v, i) => (
            <li key={i} class={`viol viol-${v.severity}`}>
              <button type="button" class="viol-btn" onClick={() => onOpen(i)}
                title={`Open ${v.field || 'the field'} in ${result.model ?? 'the model'}`}>
                <span class="viol-sev">{v.severity}</span>
                <code class="viol-path">{v.path}</code>
                <span class="viol-msg">{v.message}</span>
                <span class="viol-exp">expected <code>{v.expected}</code>, got <code>{v.actual}</code></span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {result.violations.length >= MAX_VIOLATIONS && <div class="hint">The check stops after {MAX_VIOLATIONS} problems.</div>}
    </section>
  );
}
