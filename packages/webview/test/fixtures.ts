import type { Exchange, Rule, Status } from '../src/protocol';

let n = 0;

export function ex(over: Partial<Exchange> = {}): Exchange {
  n++;
  return {
    id: `e${n}`,
    startedAt: 1_700_000_000_000 + n,
    method: 'GET',
    url: `https://api.example.com/items/${n}`,
    requestHeaders: { accept: 'application/json' },
    state: 'completed',
    status: 200,
    durationMs: 12,
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: { text: '{"ok":true}', encoding: 'utf8' },
    ...over,
  };
}

export function pausedRequest(over: Partial<Exchange> = {}): Exchange {
  return ex({
    method: 'POST',
    url: 'https://api.example.com/cart',
    requestHeaders: { 'content-type': 'application/json', authorization: 'Bearer x' },
    requestBody: { text: '{"qty":1}', encoding: 'utf8' },
    state: 'paused-request',
    status: undefined,
    responseHeaders: undefined,
    responseBody: undefined,
    durationMs: undefined,
    ...over,
  });
}

export function pausedResponse(over: Partial<Exchange> = {}): Exchange {
  return ex({
    url: 'https://api.example.com/me',
    state: 'paused-response',
    status: 200,
    responseHeaders: { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] },
    responseBody: { text: '{"name":"Ada"}', encoding: 'utf8' },
    ...over,
  });
}

export const status: Status = { proxyRunning: true, port: 8899, interceptEnabled: true, sessions: 1 };

export function rule(over: Partial<Rule> = {}): Rule {
  n++;
  return {
    id: `r${n}`,
    enabled: true,
    match: { url: 'https://api.example.com/*' },
    action: { kind: 'breakpoint', phase: 'both' },
    ...over,
  };
}
