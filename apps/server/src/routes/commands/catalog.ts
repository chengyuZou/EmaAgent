// Command 目录路由：前端斜杠菜单的确定性命令投影（Skill 条目走 /api/skills，不在这里）。
import { Hono } from 'hono';
import type { CommandDescriptor } from '@ema-agent/commands';

export function commandsCatalogRoute(deps: {
  readonly listCommandDescriptors: () => readonly CommandDescriptor[];
}): Hono {
  const app = new Hono();
  app.get('/', context => context.json({ commands: deps.listCommandDescriptors() }));
  return app;
}
