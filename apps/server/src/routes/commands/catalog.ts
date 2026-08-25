// Command 目录路由：前端斜杠菜单的确定性命令投影（Skill 条目走 /api/skills，不在这里）。
import { Hono } from 'hono';
import type { CommandDescriptor } from '@ema-agent/commands';

export const commandsCatalogRoute = (deps: {
  readonly listCommandDescriptors: () => readonly CommandDescriptor[];
}) =>
  new Hono()
    .get('/', context => context.json({ commands: deps.listCommandDescriptors() }));
