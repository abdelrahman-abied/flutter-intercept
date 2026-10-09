// Bundle stub for mockttp's UPSTREAM proxy agents: pac-proxy-agent, socks-proxy-agent and
// https-proxy-agent (pac-proxy-agent alone pulls in a QuickJS wasm engine, ~1 MB minified).
//
// Why this is unreachable for Flutter Intercept: mockttp only constructs these agents in
// rules/http-agents.js#getAgent when the passthrough rule's `proxyConfig` yields a setting with a
// `proxyUrl` (i.e. "forward via another proxy"). Every rule InterceptProxy registers passes
// `proxyConfig: pool.proxyConfig`, a callback that always returns undefined
// (packages/proxy/src/upstream-pool.ts), so getAgent never reaches the agent factory map.
// build.mjs also fails the build if anything other than http-agents.js imports these modules.
//
// If that ever changes, fail loudly instead of silently connecting directly.
function unreachable(name) {
  return class {
    constructor() {
      throw new Error(
        `Flutter Intercept: ${name} was stubbed out of the extension bundle (upstream proxies are not supported). ` +
          'See packages/extension/stubs/upstream-proxy-agent.js.',
      );
    }
  };
}

module.exports = {
  PacProxyAgent: unreachable('PacProxyAgent'),
  SocksProxyAgent: unreachable('SocksProxyAgent'),
  HttpsProxyAgent: unreachable('HttpsProxyAgent'),
};
