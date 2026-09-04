import { Hono } from 'hono';
import type { McpLocalCommandEnvironment } from '@ema-agent/mcp';

export interface McpEnvironmentRouteDeps {
  readonly environment: Pick<McpLocalCommandEnvironment, 'inspect'>;
}

export const mcpEnvironmentRoute = (deps: McpEnvironmentRouteDeps) => new Hono()
  .get('/environment', async context => context.json({
    commands: await deps.environment.inspect(),
  }));
