/**
 * TEST-ONLY access to the MCP endpoint + token for the integration suite (FI_SUITE=agent).
 * Present on the activate() API object only when FI_TEST_EXPOSE_MCP_TOKEN === '1' (set by
 * test/integration/runTest.ts for that suite); never otherwise.
 */
export interface McpTestAccess {
  readonly url: string | undefined;
  token(): Thenable<string | undefined>;
}

export const EXPOSE_MCP_TOKEN_ENV = 'FI_TEST_EXPOSE_MCP_TOKEN';

export function mcpTestAccess(
  env: Record<string, string | undefined>,
  getUrl: () => string | undefined,
  getToken: () => Thenable<string | undefined>,
): McpTestAccess | undefined {
  if (env[EXPOSE_MCP_TOKEN_ENV] !== '1') return undefined;
  return {
    get url() {
      return getUrl();
    },
    token: getToken,
  };
}
