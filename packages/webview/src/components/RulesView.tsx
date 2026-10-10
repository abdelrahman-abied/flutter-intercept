import { useMemo, useState } from 'preact/hooks';
import { useApp } from '../context';
import type { Rule } from '../protocol';
import type { FaultKind } from '@flutter-intercept/proxy/types';
import {
  countMatches, deleteRule, describeAction, FAULT_LABEL, formToRule, isAgentRule, moveRule, NEW_RULE, ruleBudget, ruleDisplayName,
  ruleHits, ruleLabel, ruleStats, ruleToForm, toggleRule, upsertRule, validateRuleForm, type MutateRow, type RuleForm, type ThrottleFields,
} from '../state';
import { formatTime } from '../util';
import { AgentBadge, Button, useNow } from './bits';
import { BodyEditor, HeadersEditor } from './Editors';
import { Icon } from './Icon';

export function RulesView() {
  const { state, dispatch, post } = useApp();
  const { rules } = state;
  const stats = useMemo(() => ruleStats(rules, state.exchanges), [rules, state.exchanges]);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const now = useNow(rules.some((r) => r.expiresAt !== undefined));

  const commit = (next: Rule[], notice?: string, undoable = false) => {
    dispatch({ type: 'setRules', rules: next, notice, undoable });
    post({ type: 'setRules', rules: next });
  };
  const move = (from: number, to: number) => commit(moveRule(rules, from, to));

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
              return (
                <li
                  key={r.id}
                  class={`rule-item${r.enabled ? '' : ' disabled'}${state.editingRuleId === r.id ? ' editing' : ''}${dragFrom === i ? ' dragging' : ''}`}
                  draggable
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
                  <span class="rule-grip" title="Drag to reorder (or Alt+↑/↓)"><Icon name="grip" /></span>
                  <span class="rule-order" title={`Evaluated ${ordinal(i + 1)}`}>{i + 1}</span>
                  <input type="checkbox" checked={r.enabled} aria-label={`Enable rule ${ruleLabel(r)}`}
                    onChange={() => commit(toggleRule(rules, r.id))} />
                  <div class="rule-main" onDblClick={() => dispatch({ type: 'editRule', id: r.id })}>
                    <div class="rule-name">
                      <span class={`badge kind kind-${r.action.kind}`}>{r.action.kind}</span>
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
                      <span> → {describeAction(r.action)}</span>
                      <span class={`rule-stat${shadowed ? ' warn' : ''}`}
                        title={shadowed ? 'An earlier enabled rule matches some of these first' : 'Matches among the exchanges currently listed'}>
                        {' · '}matches {s.matches}
                        {shadowed && `, ${s.matches - s.wins} taken by an earlier rule`}
                      </span>
                    </div>
                  </div>
                  <div class="rule-buttons">
                    <Button kind="icon" title="Move up" disabled={i === 0} onClick={() => move(i, i - 1)}><Icon name="up" /></Button>
                    <Button kind="icon" title="Move down" disabled={i === rules.length - 1} onClick={() => move(i, i + 1)}><Icon name="down" /></Button>
                    <Button kind="icon" title="Edit" onClick={() => dispatch({ type: 'editRule', id: r.id })}><Icon name="edit" /></Button>
                    <Button kind="icon" title="Delete" onClick={() => commit(deleteRule(rules, r.id), `Deleted rule “${ruleLabel(r)}”.`, true)}>
                      <Icon name="clear" />
                    </Button>
                  </div>
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

export function RuleEditor({ rule, onSave, onCancel }: { rule?: Rule; onSave: (r: Rule, isNew: boolean) => void; onCancel: () => void }) {
  const { state } = useApp();
  const [form, setForm] = useState<RuleForm>(() => ruleToForm(rule));
  const [confirmJson, setConfirmJson] = useState(false);
  const set = (patch: Partial<RuleForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    if ('mockBody' in patch) setConfirmJson(false);
  };
  const v = validateRuleForm(form);
  const hasErrors = Object.keys(v.errors).length > 0;
  const jsonBad = form.kind === 'mock' && v.json && !v.json.ok ? v.json : undefined;
  const preview = useMemo(() => {
    if (v.errors.url) return undefined;
    return countMatches({ url: form.url.trim(), method: form.method.trim() || undefined }, state.exchanges);
  }, [form.url, form.method, state.exchanges, v.errors.url]);

  const save = (force = false) => {
    if (hasErrors) return;
    if (jsonBad && !force) { setConfirmJson(true); return; }
    onSave(formToRule(form), form.isNew);
  };

  const radio = <K extends 'kind' | 'blockMode' | 'phase' | 'fault'>(key: K, value: RuleForm[K], label: string) => (
    <label class="radio">
      <input type="radio" name={key} checked={form[key] === value} onChange={() => set({ [key]: value } as Partial<RuleForm>)} />
      {label}
    </label>
  );
  const setThrottle = (patch: Partial<ThrottleFields>) => set({ throttle: { ...form.throttle, ...patch } });
  const throttleField = (key: keyof ThrottleFields, label: string, placeholder: string) => (
    <label class="field small-field">
      <span>{label}</span>
      <input value={form.throttle[key]} inputMode="numeric" placeholder={placeholder} aria-invalid={!!v.errors[key]}
        onInput={(e) => setThrottle({ [key]: (e.target as HTMLInputElement).value })} />
    </label>
  );

  return (
    <form class="rule-editor" aria-label={form.isNew ? 'New rule' : 'Edit rule'}
      onSubmit={(e) => { e.preventDefault(); save(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}>
      <div class="re-head">
        <h3>{form.isNew ? 'New rule' : 'Edit rule'}</h3>
        <span class="spacer" />
        <label class="check"><input type="checkbox" checked={form.enabled} onChange={() => set({ enabled: !form.enabled })} /> Enabled</label>
      </div>

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
        {preview !== undefined && (
          <div class="hint">Matches {preview} of the {state.exchanges.length} exchanges currently listed.</div>
        )}
      </fieldset>

      <fieldset>
        <legend>Action</legend>
        <div class="radios">
          {radio('kind', 'mock', 'Mock response')}
          {radio('kind', 'block', 'Block')}
          {radio('kind', 'breakpoint', 'Breakpoint')}
          {radio('kind', 'throttle', 'Throttle')}
          {radio('kind', 'fault', 'Fault')}
          {radio('kind', 'mutate', 'Mutate JSON')}
        </div>

        {form.kind === 'mock' && (
          <>
            <div class="field-row">
              <label class="field small-field">
                <span>Status</span>
                <input value={form.mockStatus} inputMode="numeric" aria-invalid={!!v.errors.mockStatus}
                  onInput={(e) => set({ mockStatus: (e.target as HTMLInputElement).value })} />
              </label>
              <label class="field small-field">
                <span>Delay (ms)</span>
                <input value={form.mockDelayMs} inputMode="numeric" placeholder="0" aria-invalid={!!v.errors.mockDelayMs}
                  onInput={(e) => set({ mockDelayMs: (e.target as HTMLInputElement).value })} />
              </label>
            </div>
            {v.errors.mockStatus && <div class="msg error">Status: {v.errors.mockStatus}</div>}
            {v.errors.mockDelayMs && <div class="msg error">Delay: {v.errors.mockDelayMs}</div>}
            <div class="field-label">Headers</div>
            <HeadersEditor rows={form.mockHeaders} onChange={(mockHeaders) => set({ mockHeaders })} />
            {v.errors.mockHeaders && <div class="msg error">{v.errors.mockHeaders}</div>}
            <div class="field-label">Body</div>
            <BodyEditor label="Mock body" value={form.mockBody} json={v.json} rows={10} onInput={(mockBody) => set({ mockBody })} />
          </>
        )}

        {form.kind === 'block' && (
          <>
            <div class="radios">
              {radio('blockMode', 'reset', 'Connection reset (app sees a network error)')}
              {radio('blockMode', 'status', 'Respond with status')}
            </div>
            {form.blockMode === 'status' && (
              <label class="field small-field">
                <span>Status</span>
                <input value={form.blockStatus} inputMode="numeric" aria-invalid={!!v.errors.blockStatus}
                  onInput={(e) => set({ blockStatus: (e.target as HTMLInputElement).value })} />
              </label>
            )}
            {v.errors.blockStatus && <div class="msg error">Status: {v.errors.blockStatus}</div>}
          </>
        )}

        {form.kind === 'breakpoint' && (
          <div class="radios">
            {radio('phase', 'request', 'Pause request')}
            {radio('phase', 'response', 'Pause response')}
            {radio('phase', 'both', 'Both')}
          </div>
        )}

        {form.kind === 'throttle' && (
          <>
            <div class="hint">Forwards to the real server, slowed down. “Fail” resets that share of the requests.</div>
            <div class="field-row">
              {throttleField('latencyMs', 'Latency (ms)', '0')}
              {throttleField('kbps', 'Bandwidth (kbps)', 'unlimited')}
              {throttleField('dropPct', 'Fail (%)', '0')}
            </div>
            {(['latencyMs', 'kbps', 'dropPct', 'throttle'] as const).map((k) => v.errors[k] && <div key={k} class="msg error">{v.errors[k]}</div>)}
          </>
        )}

        {form.kind === 'fault' && (
          <>
            <div class="radios">
              {(Object.keys(FAULT_LABEL) as FaultKind[]).map((k) => radio('fault', k, FAULT_LABEL[k][0].toUpperCase() + FAULT_LABEL[k].slice(1)))}
            </div>
            <div class="hint">
              {form.fault === 'dns' ? 'The app sees a failed host lookup, as when offline.'
                : form.fault === 'timeout' ? 'The request is held unanswered until the app gives up (its own timeout).'
                : form.fault === 'truncate' ? 'Forwards to the server, then cuts the response body mid-way.'
                : 'The connection is reset once it is up — the app sees a network error.'}
            </div>
          </>
        )}
      </fieldset>

      {form.kind === 'mutate' && (
        <fieldset>
          <legend>Changes to the response</legend>
          <div class="hint">
            Forwards to the real server, then changes the JSON response before the app gets it — e.g. null a field to
            reproduce “Null is not a subtype of String”. Paths: <code>$.user.avatar_url</code>, <code>$.items[0].id</code>,{' '}
            <code>$.items[*].price</code>, <code>$['odd key']</code>. A non-JSON response is passed through unchanged.
          </div>
          <MutateOpsEditor rows={form.mutateOps} errors={v.opErrors} onChange={(mutateOps) => set({ mutateOps })} />
          {v.errors.mutate && <div class="msg error">{v.errors.mutate}</div>}
        </fieldset>
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

      {confirmJson && jsonBad && (
        <div class="confirm" role="alertdialog" aria-label="Save invalid JSON?">
          <span>The mock body is not valid JSON (line {jsonBad.line}, column {jsonBad.column}) but its content-type says JSON.</span>
          <Button kind="danger" onClick={() => save(true)}>Save anyway</Button>
          <Button onClick={() => setConfirmJson(false)}>Keep editing</Button>
        </div>
      )}

      <div class="re-actions">
        <Button kind="primary" type="submit" disabled={hasErrors}>{form.isNew ? 'Add rule' : 'Save'}</Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

const OP_LABEL: Record<MutateRow['op'], string> = { null: 'make null', delete: 'remove', set: 'set to' };

/** The `mutate` op list: path, op and (for set) a JSON value per row. */
export function MutateOpsEditor({ rows, errors, onChange }: {
  rows: MutateRow[]; errors?: (string | undefined)[]; onChange: (rows: MutateRow[]) => void;
}) {
  const update = (i: number, patch: Partial<MutateRow>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <div class="mutate-ops">
      {rows.map((r, i) => {
        const err = errors?.[i];
        return (
          <div class="mo-row" key={i}>
            <div class="mo-line">
              <input class="mo-path mono" aria-label={`Path of change ${i + 1}`} placeholder="$.user.avatar_url" spellcheck={false}
                value={r.path} aria-invalid={!!err && err.startsWith('Path')}
                onInput={(e) => update(i, { path: (e.target as HTMLInputElement).value })} />
              <select aria-label={`Change ${i + 1}`} value={r.op}
                onChange={(e) => update(i, { op: (e.target as HTMLSelectElement).value as MutateRow['op'] })}>
                {(Object.keys(OP_LABEL) as MutateRow['op'][]).map((op) => <option key={op} value={op}>{OP_LABEL[op]}</option>)}
              </select>
              {r.op === 'set' && (
                <input class="mo-value mono" aria-label={`JSON value of change ${i + 1}`} placeholder='"42"' spellcheck={false}
                  value={r.value} aria-invalid={!!err && err.startsWith('Value')}
                  onInput={(e) => update(i, { value: (e.target as HTMLInputElement).value })} />
              )}
              <Button kind="icon" title={`Remove change ${i + 1}`} disabled={rows.length === 1}
                onClick={() => onChange(rows.filter((_, k) => k !== i))}>
                <Icon name="close" />
              </Button>
            </div>
          </div>
        );
      })}
      <button type="button" class="link" onClick={() => onChange([...rows, { path: '', op: 'null', value: '' }])}>+ Add change</button>
    </div>
  );
}
