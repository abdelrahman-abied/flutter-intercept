import { useEffect, useMemo, useState } from 'preact/hooks';
import { useApp } from '../context';
import type { Rule } from '../protocol';
import {
  canMoveRule, isShared, needsApproval, SHARED_FILE, suggestBodyFile,
} from '../scenarios';
import {
  compileExchangeMatcher, countMatches, deleteRule, describeAction, formToRule, isAgentRule, moveRule, NEW_RULE, ruleBudget, ruleDisplayName,
  ruleHits, ruleLabel, ruleStats, ruleToForm, toggleRule, upsertRule, validateRuleForm, type RuleForm,
} from '../state';
import { formatTime } from '../util';
import { ActionEditor, SequenceEditor } from './ActionEditor';
import { suggestScriptFile } from '../scripts';
import { AgentBadge, Button, useNow } from './bits';
import { Icon } from './Icon';

export { MutateOpsEditor } from './ActionEditor';

const SHARED_TITLE =
  `Shared with your team: this rule comes from ${SHARED_FILE}, committed with the project. It runs before your ` +
  'personal rules. Edit the file to change it, or Unshare it to make it a personal rule again.';

export function RulesView() {
  const { state, dispatch, post } = useApp();
  const { rules } = state;
  const stats = useMemo(() => ruleStats(rules, state.exchanges), [rules, state.exchanges]);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [sharing, setSharing] = useState<string | undefined>();
  const now = useNow(rules.some((r) => r.expiresAt !== undefined));
  const sr = state.status.sharedRules;

  // setRules carries the whole list, shared rules unchanged: the host writes the shared file only when they differ
  // (CONTRACTS §12.1) — the panel never changes them in place (read-only; Share / Unshare move them).
  const commit = (next: Rule[], notice?: string, undoable = false) => {
    dispatch({ type: 'setRules', rules: next, notice, undoable });
    post({ type: 'setRules', rules: next });
  };
  const move = (from: number, to: number) => { if (canMoveRule(rules, from, to)) commit(moveRule(rules, from, to)); };
  const share = (r: Rule, shared: boolean) => {
    setSharing(undefined);
    post({ type: 'shareRule', id: r.id, shared });
    dispatch({
      type: 'notice', short: true,
      text: shared ? `Moving “${ruleLabel(r)}” to ${sr?.file ?? SHARED_FILE}…` : `Moving “${ruleLabel(r)}” back to your personal rules…`,
    });
  };

  return (
    <div class={`rules-view${state.editingRuleId ? ' has-editor' : ''}`}>
      <div class="rules-list">
        <div class="rules-head">
          <span class="muted">
            Rules run top to bottom — the <strong>first enabled rule that matches wins</strong>; later matches are ignored.
          </span>
          <span class="spacer" />
          <Button kind="primary" onClick={() => dispatch({ type: 'editRule', id: NEW_RULE })}>
            <Icon name="plus" /> Add rule
          </Button>
        </div>
        {sr && (sr.problems.length > 0 || sr.count > 0) && (
          <div class="shared-info" aria-label="Shared rules file">
            {sr.count > 0 && (
              <div class="hint">
                {sr.count} shared rule{sr.count === 1 ? '' : 's'} from <code>{sr.file ?? SHARED_FILE}</code> run first.
              </div>
            )}
            {sr.problems.length > 0 && (
              <ul class="msg warn shared-problems" aria-label="Problems with the shared rules file">
                {sr.problems.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            )}
          </div>
        )}
        {rules.length === 0 ? (
          <div class="empty small">
            <p>No rules yet.</p>
            <p class="muted">Add one here, or select an exchange in Traffic and use “Mock this”, “Block this” or “Break on this”.</p>
          </div>
        ) : (
          <ol class="rule-items" aria-label="Rules in evaluation order">
            {rules.map((r, i) => {
              const s = stats[i];
              const shadowed = r.enabled && s.matches > s.wins;
              const budget = ruleBudget(r, ruleHits(r, state.exchanges), now);
              const shared = isShared(r);
              const approval = sharing === r.id ? needsApproval(r.action) : undefined;
              return (
                <li
                  key={r.id}
                  class={`rule-item${r.enabled ? '' : ' disabled'}${shared ? ' shared' : ''}${state.editingRuleId === r.id ? ' editing' : ''}${dragFrom === i ? ' dragging' : ''}`}
                  draggable={!shared}
                  onDragStart={(e) => { setDragFrom(i); e.dataTransfer?.setData('text/plain', String(i)); }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => { e.preventDefault(); if (dragFrom !== null) move(dragFrom, i); setDragFrom(null); }}
                  onDragEnd={() => setDragFrom(null)}
                  onKeyDown={(e) => {
                    if (!e.altKey) return;
                    if (e.key === 'ArrowUp') { e.preventDefault(); move(i, i - 1); }
                    if (e.key === 'ArrowDown') { e.preventDefault(); move(i, i + 1); }
                  }}
                >
                  <div class="rule-line">
                    <span class={`rule-grip${shared ? ' locked' : ''}`} title={shared ? 'Shared rules keep the order of the file' : 'Drag to reorder (or Alt+↑/↓)'}>
                      <Icon name="grip" />
                    </span>
                    <span class="rule-order" title={`Evaluated ${ordinal(i + 1)}`}>{i + 1}</span>
                    <input type="checkbox" checked={r.enabled} aria-label={`Enable rule ${ruleLabel(r)}`} disabled={shared}
                      title={shared ? `Shared rule: enable or disable it in ${sr?.file ?? SHARED_FILE}` : undefined}
                      onChange={() => commit(toggleRule(rules, r.id))} />
                    <div class="rule-main" onDblClick={() => dispatch({ type: 'editRule', id: r.id })}>
                      <div class="rule-name">
                        <span class={`badge kind kind-${r.action.kind}`}>{r.action.kind}</span>
                        {shared && <span class="badge shared-badge" title={SHARED_TITLE}>shared</span>}
                        {isAgentRule(r) && <AgentBadge />}
                        <span class="rule-title">{ruleDisplayName(r)}</span>
                        {budget && (
                          <span class={`badge rule-budget${budget.spent ? ' spent' : ''}`}
                            title={[
                              r.times !== undefined ? `Applies to the first ${r.times} matching request${r.times === 1 ? '' : 's'} (counted from the exchanges listed), then is removed.` : '',
                              r.expiresAt !== undefined ? `Removed at ${formatTime(r.expiresAt).slice(0, 8)}.` : '',
                            ].filter(Boolean).join(' ')}>
                            {budget.text}
                          </span>
                        )}
                      </div>
                      <div class="rule-sub">
                        <code>{r.match.method?.toUpperCase() ?? 'ANY'} {r.match.url}</code>
                        {r.match.graphqlOperation && (
                          <span class="badge mini gql-badge" title={`Only the GraphQL operation “${r.match.graphqlOperation}” (exact name)`}>
                            op {r.match.graphqlOperation}
                          </span>
                        )}
                        <span title={describeAction(r.action)}> → {describeAction(r.action)}</span>
                        <span class={`rule-stat${shadowed ? ' warn' : ''}`}
                          title={shadowed ? 'An earlier enabled rule matches some of these first' : 'Matches among the exchanges currently listed'}>
                          {' · '}matches {s.matches}
                          {shadowed && `, ${s.matches - s.wins} taken by an earlier rule`}
                        </span>
                      </div>
                    </div>
                    <div class="rule-buttons">
                      {shared ? (
                        <Button class="share-btn" title="Move this rule out of the shared file into your personal rules" onClick={() => share(r, false)}>
                          Unshare
                        </Button>
                      ) : (
                        <Button class="share-btn" pressed={sharing === r.id}
                          title={`Share with your team: moves this rule into ${sr?.file ?? SHARED_FILE}, committed with the project`}
                          onClick={() => setSharing(sharing === r.id ? undefined : r.id)}>
                          Share
                        </Button>
                      )}
                      <Button kind="icon" title="Move up" disabled={!canMoveRule(rules, i, i - 1)} onClick={() => move(i, i - 1)}><Icon name="up" /></Button>
                      <Button kind="icon" title="Move down" disabled={!canMoveRule(rules, i, i + 1)} onClick={() => move(i, i + 1)}><Icon name="down" /></Button>
                      <Button kind="icon" title={shared ? 'View' : 'Edit'} onClick={() => dispatch({ type: 'editRule', id: r.id })}><Icon name="edit" /></Button>
                      <Button kind="icon" title={shared ? 'Shared rule: Unshare it first, or remove it from the file' : 'Delete'} disabled={shared}
                        onClick={() => commit(deleteRule(rules, r.id), `Deleted rule “${ruleLabel(r)}”.`, true)}>
                        <Icon name="clear" />
                      </Button>
                    </div>
                  </div>
                  {sharing === r.id && (
                    <div class="confirm share-confirm" role="alertdialog" aria-label="Share this rule?">
                      <span>
                        Move “{ruleLabel(r)}” into <code>{sr?.file ?? SHARED_FILE}</code>? The file is committed with your code,
                        so everyone on the project gets this rule — check it holds no tokens or personal data.
                        {approval && ` Teammates will have to approve it before it runs: ${approval}.`}
                      </span>
                      <Button kind="primary" onClick={() => share(r, true)}>Share</Button>
                      <Button onClick={() => setSharing(undefined)}>Cancel</Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
      {state.editingRuleId && (state.editingRuleId === NEW_RULE || rules.some((r) => r.id === state.editingRuleId)) && (
        <RuleEditor
          key={state.editingRuleId}
          rule={state.editingRuleId === NEW_RULE ? undefined : rules.find((r) => r.id === state.editingRuleId)}
          sharedFile={sr?.file}
          onSave={(rule, isNew) => {
            commit(upsertRule(rules, rule), isNew ? `Added rule “${ruleLabel(rule)}” at position ${rules.length + 1}.` : undefined);
            dispatch({ type: 'editRule', id: undefined });
          }}
          onCancel={() => dispatch({ type: 'editRule', id: undefined })}
        />
      )}
    </div>
  );
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}


const KIND_RADIOS: readonly [RuleForm['kind'], string][] = [
  ['mock', 'Mock response'], ['block', 'Block'], ['breakpoint', 'Breakpoint'], ['throttle', 'Throttle'], ['fault', 'Fault'],
  ['mutate', 'Mutate JSON'], ['cors', 'CORS (dev only)'], ['sequence', 'Sequence'], ['mapRemote', 'Map remote'], ['rewrite', 'Rewrite'],
  ['script', 'Script (JS)'],
];

export function RuleEditor({ rule, sharedFile, onSave, onCancel }: {
  rule?: Rule; sharedFile?: string; onSave: (r: Rule, isNew: boolean) => void; onCancel: () => void;
}) {
  const { state, post } = useApp();
  const [form, setForm] = useState<RuleForm>(() => ruleToForm(rule));
  const [confirmJson, setConfirmJson] = useState(false);
  const readOnly = !!rule && isShared(rule);
  const set = (patch: Partial<RuleForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    if ('mockBody' in patch) setConfirmJson(false);
  };
  const v = validateRuleForm(form);
  const hasErrors = Object.keys(v.errors).length > 0;
  const jsonBad = form.kind === 'mock' && !form.mockUseFile && v.json && !v.json.ok ? v.json : undefined;
  const preview = useMemo(() => {
    if (v.errors.url) return undefined;
    return countMatches({
      url: form.url.trim(), method: form.method.trim() || undefined, graphqlOperation: form.graphqlOperation.trim() || undefined,
    }, state.exchanges);
  }, [form.url, form.method, form.graphqlOperation, state.exchanges, v.errors.url]);
  // GraphQL operations seen on the matched route: offered as suggestions, and the reason the field is shown.
  const knownOps = useMemo(() => {
    if (v.errors.url || !form.url.trim()) return [];
    const test = compileExchangeMatcher({ url: form.url.trim(), method: form.method.trim() || undefined });
    const ops = new Set<string>();
    for (const e of state.exchanges) if (e.graphql?.operationName && test(e)) ops.add(e.graphql.operationName);
    return [...ops].sort();
  }, [form.url, form.method, state.exchanges, v.errors.url]);
  const showGql = !!form.graphqlOperation || knownOps.length > 0 || /graphql/i.test(form.url);
  // mockBody is the file's content (resolved by the host) only while the path is the one the rule was saved with.
  const savedFile = rule?.action.kind === 'mock' ? rule.action.bodyFile : undefined;
  const savedScript = rule?.action.kind === 'script' ? rule.action.file : undefined;

  // The host answers a refused / failed openBodyFile with an `error` message: show the next one in the editor too.
  // `create`: the failed request was "Create file" (REVIEW-7 #1: the host refuses an existing file — offer another name).
  const [fileError, setFileError] = useState<{ after: number; message?: string; create?: boolean }>();
  const lastErrorId = state.hostErrors.at(-1)?.id ?? 0;
  useEffect(() => {
    if (!fileError || fileError.message) return;
    const e = state.hostErrors.find((x) => x.id > fileError.after);
    if (e) setFileError({ ...fileError, message: e.message });
  }, [state.hostErrors]);
  useEffect(() => setFileError(undefined), [form.mockBodyFile, form.mockUseFile, form.scriptFile, form.scriptUseFile, form.kind]);
  // REVIEW-7 #6: a saved rule's id goes along, so the host resolves the path in that rule's workspace folder.
  const ruleId = form.isNew ? undefined : form.id;
  const openFile = (type: 'openBodyFile' | 'openScriptFile', path: string, createWith?: string) => {
    setFileError({ after: lastErrorId, create: createWith !== undefined });
    post({
      type, path,
      ...(createWith !== undefined ? { create: { content: createWith } } : {}),
      ...(ruleId ? { ruleId } : {}),
    });
  };
  const openBodyFile = (path: string, createWith?: string) => openFile('openBodyFile', path, createWith);
  const openScriptFile = (path: string, createWith?: string) => openFile('openScriptFile', path, createWith);

  const save = (force = false) => {
    if (hasErrors || readOnly) return;
    if (jsonBad && !force) { setConfirmJson(true); return; }
    onSave(formToRule(form), form.isNew);
  };

  return (
    <form class={`rule-editor${readOnly ? ' read-only' : ''}`} aria-label={form.isNew ? 'New rule' : readOnly ? 'Shared rule' : 'Edit rule'}
      onSubmit={(e) => { e.preventDefault(); save(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}>
      <div class="re-head">
        <h3>{form.isNew ? 'New rule' : readOnly ? 'Shared rule' : 'Edit rule'}</h3>
        <span class="spacer" />
        {!readOnly && (
          <label class="check"><input type="checkbox" checked={form.enabled} onChange={() => set({ enabled: !form.enabled })} /> Enabled</label>
        )}
      </div>
      {readOnly && (
        <div class="msg info shared-note" role="note">
          <span class="badge shared-badge">shared</span> This rule comes from <code>{sharedFile ?? SHARED_FILE}</code>, committed
          with the project — it is read-only here. Edit that file to change it (the panel follows), or Unshare it in the
          list to make it a personal rule.
        </div>
      )}

      <fieldset class="re-body" disabled={readOnly}>
        <label class="field">
          <span>Name <span class="muted">(optional)</span></span>
          <input value={form.name} placeholder="e.g. Empty cart" onInput={(e) => set({ name: (e.target as HTMLInputElement).value })} />
        </label>

        <fieldset>
          <legend>Match</legend>
          <div class="field-row">
            <label class="field method-field">
              <span>Method</span>
              <input list="fi-rule-methods" value={form.method} placeholder="any" spellcheck={false}
                aria-invalid={!!v.errors.method} onInput={(e) => set({ method: (e.target as HTMLInputElement).value })} />
              <datalist id="fi-rule-methods">{['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => <option key={m} value={m} />)}</datalist>
            </label>
            <label class="field grow">
              <span>URL</span>
              <input class="mono" value={form.url} placeholder="https://api.example.com/users/*  or  /\/users\/\d+$/" spellcheck={false}
                aria-invalid={!!v.errors.url} onInput={(e) => set({ url: (e.target as HTMLInputElement).value })} />
            </label>
          </div>
          {v.errors.method && <div class="msg error">{v.errors.method}</div>}
          {v.errors.url && form.url.trim()
            ? <div class="msg error">{v.errors.url}</div>
            : <div class="hint">{v.errors.url ? `${v.errors.url} ${v.urlHint}` : v.urlHint}</div>}
          {showGql && (
            <>
              <label class="field">
                <span>GraphQL operation <span class="muted">(optional)</span></span>
                <input class="mono" list="fi-rule-ops" value={form.graphqlOperation} placeholder="any operation, e.g. getUser" spellcheck={false}
                  aria-invalid={!!v.errors.graphqlOperation} onInput={(e) => set({ graphqlOperation: (e.target as HTMLInputElement).value })} />
                <datalist id="fi-rule-ops">{knownOps.map((o) => <option key={o} value={o} />)}</datalist>
              </label>
              {v.errors.graphqlOperation
                ? <div class="msg error">{v.errors.graphqlOperation}</div>
                : <div class="hint">Exact, case-sensitive operation name. The proxy reads the request body (up to 5 MB) to check it before routing.</div>}
            </>
          )}
          {preview !== undefined && (
            <div class="hint">Matches {preview} of the {state.exchanges.length} exchanges currently listed.</div>
          )}
        </fieldset>

        <fieldset>
          <legend>Action</legend>
          <div class="radios">
            {KIND_RADIOS.map(([kind, label]) => (
              <label key={kind} class="radio">
                <input type="radio" name="kind" checked={form.kind === kind} onChange={() => set({ kind })} />
                {label}
              </label>
            ))}
          </div>
          {form.kind === 'sequence' ? (
            <div class="hint">Different answers for successive requests — set the steps below.</div>
          ) : (
            <ActionEditor kind={form.kind} f={form} v={v} uid="rule" set={set}
              bodyFile={{ suggest: () => suggestBodyFile(form.name, form.url), knownContent: !!savedFile && savedFile === form.mockBodyFile.trim(),
                open: openBodyFile, error: fileError?.message,
              }}
              scriptFile={{ suggest: () => suggestScriptFile(form.name, form.url), knownContent: !!savedScript && savedScript === form.scriptFile.trim(),
                open: openScriptFile, error: fileError?.message, errorOnCreate: !!fileError?.create,
              }} />
          )}
        </fieldset>

        {form.kind === 'sequence' && (
          <SequenceEditor steps={form.steps} then={form.seqThen} checks={v.stepChecks} error={v.errors.sequence} onChange={set} />
        )}

        <fieldset>
          <legend>Lifetime</legend>
          <div class="field-row">
            <label class="field lifetime-field">
              <span>Only first N requests</span>
              <input value={form.times} inputMode="numeric" placeholder="every" aria-invalid={!!v.errors.times}
                onInput={(e) => set({ times: (e.target as HTMLInputElement).value })} />
            </label>
            <label class="field lifetime-field">
              <span>Expires in</span>
              <input value={form.expiresIn} inputMode="decimal" placeholder="never" aria-invalid={!!v.errors.expiresIn}
                onInput={(e) => set({ expiresIn: (e.target as HTMLInputElement).value, keepExpiresAt: undefined })} />
            </label>
            <label class="field">
              <span class="sr-only">Unit</span>
              <select aria-label="Expiry unit" value={form.expiresUnit}
                onChange={(e) => set({ expiresUnit: (e.target as HTMLSelectElement).value as RuleForm['expiresUnit'], keepExpiresAt: undefined })}>
                <option value="s">seconds</option>
                <option value="m">minutes</option>
                <option value="h">hours</option>
              </select>
            </label>
          </div>
          {v.errors.times && <div class="msg error">{v.errors.times}</div>}
          {v.errors.expiresIn && <div class="msg error">{v.errors.expiresIn}</div>}
          <div class="hint">
            {form.keepExpiresAt !== undefined
              ? `Expires at ${formatTime(form.keepExpiresAt).slice(0, 8)} — change the field to reset it.`
              : 'A spent or expired rule is removed automatically, so a temporary mock never lingers.'}
          </div>
        </fieldset>
      </fieldset>

      {confirmJson && jsonBad && (
        <div class="confirm" role="alertdialog" aria-label="Save invalid JSON?">
          <span>The mock body is not valid JSON (line {jsonBad.line}, column {jsonBad.column}) but its content-type says JSON.</span>
          <Button kind="danger" onClick={() => save(true)}>Save anyway</Button>
          <Button onClick={() => setConfirmJson(false)}>Keep editing</Button>
        </div>
      )}

      <div class="re-actions">
        {readOnly ? (
          <Button kind="primary" onClick={onCancel}>Close</Button>
        ) : (
          <>
            <Button kind="primary" type="submit" disabled={hasErrors}>{form.isNew ? 'Add rule' : 'Save'}</Button>
            <Button onClick={onCancel}>Cancel</Button>
          </>
        )}
      </div>
    </form>
  );
}
