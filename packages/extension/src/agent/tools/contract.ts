/**
 * Agent tools: contract (QUALITY-1 Q5: split out of api.ts). Each handler gets the shared AgentViews and its parsed input.
 */
import type { Exchange } from '@flutter-intercept/proxy';
import type { ContractResult } from '../../contract/types';
import { fixtureApi } from '../../ui/controller';
import { contractForAgent, decodeJson, decodeSample, defaultFixtureName, defaultModelName, FINAL_STATES, looksJson, MAX_FIXTURES, modelSamples, redactExchange, redactJsonValue, routeOf, testPackageFor } from '../samples';
import { ToolInput } from '../schema';
import { AgentToolError, ToolResult } from '../types';
import type { AgentViews } from '../views';
import type { ToolHandlers } from './types';

export async function checkContract(ag: AgentViews, i: ToolInput<'check_contract'>): Promise<ToolResult> {
  const svc = ag.deps.contract;
  if (!svc) throw new AgentToolError('contract checking is not available in this build of Flutter Intercept', 'state');
  let targets: Exchange[];
  if (i.id !== undefined) {
    if (i.url !== undefined || i.method !== undefined || i.sinceMs !== undefined) throw new AgentToolError('pass either id, or url/method/sinceMs', 'invalid');
    targets = [ag.find(i.id)];
  } else {
    const keep = ag.filter({ url: i.url, method: i.method, sinceMs: i.sinceMs });
    targets = ag.deps.host
      .getExchanges()
      .filter((e) => FINAL_STATES.has(e.state) && looksJson(e) && keep(e))
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, i.limit);
  }
  const root = ag.deps.projectRoot();
  const results: Record<string, unknown>[] = [];
  for (const e of targets) {
    let r: ContractResult;
    if (!FINAL_STATES.has(e.state)) {
      r = { exchangeId: e.id, checked: false, via: 'none', violations: [], reason: `the response has not arrived yet (state ${e.state})` };
    } else {
      const cached = i.model === undefined ? ag.deps.contractResult?.(e.id) : undefined;
      try {
        r = cached ?? (await svc.check(e, i.model !== undefined ? { model: i.model } : undefined));
      } catch (err) {
        r = { exchangeId: e.id, checked: false, via: 'none', violations: [], reason: `the check failed: ${(err as Error)?.message ?? String(err)}` };
      }
    }
    results.push(contractForAgent(r, { root, exchange: e, redact: ag.redact }));
  }
  const errors = results.reduce((n, r) => n + (r.errors as number), 0);
  return {
    results,
    checked: results.filter((r) => r.checked).length,
    errors,
    ...(targets.length ? {} : { note: 'no finished JSON response matched; make the app call the endpoint first (or check list_requests)' }),
  };
}


export async function generateModel(ag: AgentViews, i: ToolInput<'generate_model'>): Promise<ToolResult> {
  if ((i.id === undefined) === (i.url === undefined)) throw new AgentToolError('pass id or url (exactly one)', 'invalid');
  const cg = ag.codegenOrThrow();
  const template = ag.template();
  const all = ag.deps.host.getExchanges();
  let target: Exchange;
  if (i.id !== undefined) target = ag.find(i.id);
  else {
    const keep = ag.filter({ url: i.url });
    const hit = all
      .filter((e) => FINAL_STATES.has(e.state) && decodeJson(e.responseBody).ok && keep(e))
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    if (!hit) throw new AgentToolError(`no finished JSON response matches ${i.url}; make the app call it first`, 'not_found');
    target = hit;
  }
  // decodeSample keeps `1.0` a double (JsonDouble) so the models get `double`, not `int`.
  const json = decodeSample(target.responseBody);
  if (!json.ok) throw new AgentToolError(`exchange "${target.id}" has no usable JSON response: ${json.reason}`, 'invalid');
  const route = routeOf(target, template);
  const samples = modelSamples(all, target, template).flatMap((s) => {
    const d = decodeSample(s.responseBody);
    return d.ok ? [ag.redact ? redactJsonValue(d.value) : d.value] : [];
  });
  const root = ag.deps.projectRoot();
  const style = i.style ?? (root ? cg.detectModelStyle(root) : 'plain');
  const files = cg.generateModels({
    samples: samples.length ? samples : [ag.redact ? redactJsonValue(json.value) : json.value],
    rootName: i.name ?? defaultModelName(route.template),
    style,
    source: `${target.method.toUpperCase()} ${route.origin}${route.template}`,
  });
  return { files, samples: Math.max(1, samples.length), route: `${target.method.toUpperCase()} ${route.template}`, style };
}


export async function generateFixtureTest(ag: AgentViews, i: ToolInput<'generate_fixture_test'>): Promise<ToolResult> {
  if ((i.ids === undefined) === (i.url === undefined)) throw new AgentToolError('pass ids or url (exactly one)', 'invalid');
  const cg = ag.codegenOrThrow();
  let exchanges: Exchange[];
  if (i.ids) {
    exchanges = [...new Set(i.ids)].map((id) => ag.find(id));
    const unfinished = exchanges.find((e) => !FINAL_STATES.has(e.state) || e.status === undefined);
    if (unfinished) throw new AgentToolError(`exchange "${unfinished.id}" has no finished response (state ${unfinished.state})`, 'invalid');
  } else {
    const keep = ag.filter({ url: i.url });
    exchanges = ag.deps.host
      .getExchanges()
      .filter((e) => FINAL_STATES.has(e.state) && e.status !== undefined && keep(e))
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, MAX_FIXTURES);
    if (!exchanges.length) throw new AgentToolError(`no finished request matches ${i.url}; make the app call it first`, 'not_found');
  }
  const route = routeOf(exchanges[0], ag.template());
  const root = ag.deps.projectRoot();
  const style = i.style ?? (root ? cg.detectFixtureStyle(root) : 'mock_client');
  const pkg = ag.deps.appPackageName?.();
  const api = style === 'mocktail' ? await fixtureApi(ag.deps.contract, exchanges, root, pkg) : undefined;
  const testPackage = testPackageFor(root);
  // Fixtures are meant to be committed: always the redacted view, whatever the setting (CONTRACTS §10.6).
  const files = cg.generateFixtureTest({
    exchanges: exchanges.map(redactExchange),
    style,
    name: i.name ?? defaultFixtureName(exchanges[0].method, route.template),
    ...(pkg ? { packageName: pkg } : {}),
    ...(api ? { api } : {}),
    ...(testPackage ? { testPackage } : {}),
  });
  return { files, exchanges: exchanges.length, style, ...(api ? { mocks: api.className } : {}), redacted: true };
}

export const contractTools: ToolHandlers = {
  check_contract: (ag, i) => checkContract(ag, i),
  generate_model: (ag, i) => generateModel(ag, i),
  generate_fixture_test: (ag, i) => generateFixtureTest(ag, i),
};
