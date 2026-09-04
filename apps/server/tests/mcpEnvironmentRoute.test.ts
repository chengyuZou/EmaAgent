import { describe, expect, it, vi } from 'vitest';
import type { McpLocalCommandEnvironment } from '@ema-agent/mcp';
import { mcpEnvironmentRoute } from '../src/routes/mcp/environment.js';

describe('MCP environment route', () => {
  it('返回 Node Server 的命令检查结果', async () => {
    const inspect = vi.fn(async () => [{
      command: 'npx' as const,
      selectedPath: 'C:\\nodejs\\npx.cmd',
      candidatePaths: ['C:\\nodejs\\npx.cmd'],
      version: '11.6.2',
    }]);
    const environment: Pick<McpLocalCommandEnvironment, 'inspect'> = { inspect };
    const response = await mcpEnvironmentRoute({ environment }).request('/environment');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ commands: await inspect() });
  });
});
