import { Hono } from 'hono';
import type { CommandDescriptor } from '@ema-agent/commands';

export const commandsCatalogRoute = (deps: {
  readonly listCommandDescriptors: () => readonly CommandDescriptor[];
}) =>
  new Hono()
    .get('/', context => context.json({ commands: deps.listCommandDescriptors() }));
