import { describe, expect, it } from 'vitest';
import { mcpTestAccess } from '../../src/agent/testExposure';

describe('test-only MCP token exposure', () => {
  const url = () => 'http://127.0.0.1:47823/mcp';
  const token = async () => 'secret-token';
  it('is absent by default and for any value other than "1"', () => {
    expect(mcpTestAccess({}, url, token)).toBeUndefined();
    for (const v of ['', '0', 'true', 'yes', ' 1']) expect(mcpTestAccess({ FI_TEST_EXPOSE_MCP_TOKEN: v }, url, token)).toBeUndefined();
  });
  it('is present only with FI_TEST_EXPOSE_MCP_TOKEN=1', async () => {
    const a = mcpTestAccess({ FI_TEST_EXPOSE_MCP_TOKEN: '1' }, url, token)!;
    expect(a.url).toBe('http://127.0.0.1:47823/mcp');
    expect(await a.token()).toBe('secret-token');
  });
  it('the real process env of the unit-test run does not expose it', () => {
    expect(mcpTestAccess(process.env, url, token)).toBeUndefined();
  });
});
