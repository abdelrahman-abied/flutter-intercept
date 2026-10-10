// Contract-check results as the panel shows them (CONTRACTS §10.3 / §10.5). Pure.
import type { ContractSummary } from './protocol';

export type ContractStatus = 'error' | 'warning' | 'ok' | 'unchecked';
export const CONTRACT_STATUSES: readonly ContractStatus[] = ['error', 'warning', 'ok', 'unchecked'];

/** Worst severity of a checked result; `unchecked` when there is none or the host couldn't check it. */
export function contractStatus(c: ContractSummary | undefined): ContractStatus {
  if (!c || !c.checked) return 'unchecked';
  let warn = false;
  for (const v of c.violations) {
    if (v.severity === 'error') return 'error';
    warn = true;
  }
  return warn ? 'warning' : 'ok';
}

export function countBySeverity(c: ContractSummary): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const v of c.violations) (v.severity === 'error' ? errors++ : warnings++);
  return { errors, warnings };
}

export const VIA_LABEL: Record<ContractSummary['via'], string> = {
  retrofit: 'matched by its Retrofit declaration',
  chopper: 'matched by its Chopper declaration',
  source: 'from the call site in the stack trace',
  user: 'chosen by you',
  none: 'no model matched',
};

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** "2 errors, 1 warning" / "matches" — for badges and titles. */
export function contractSummaryText(c: ContractSummary): string {
  const { errors, warnings } = countBySeverity(c);
  if (!errors && !warnings) return 'matches the model';
  return [errors && plural(errors, 'error'), warnings && plural(warnings, 'warning')].filter(Boolean).join(', ');
}

/** List-row badge title: model, counts and the first message. */
export function contractBadgeTitle(c: ContractSummary): string {
  const first = c.violations.find((v) => v.severity === 'error') ?? c.violations[0];
  return `Model check${c.model ? ` (${c.model})` : ''}: ${contractSummaryText(c)}${first ? `\n${first.path}: ${first.message}` : ''}`;
}
