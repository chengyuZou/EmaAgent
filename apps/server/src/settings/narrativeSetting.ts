import { defineSetting } from '@ema-agent/settings';
import type { NarrativeQueryMode } from '@ema-agent/narrative';
import { z } from 'zod';

export const narrativeQueryModeSetting = defineSetting<'auto' | NarrativeQueryMode>({
  key: 'narrative.queryMode',
  apply: 'nextTurn',
  defaultValue: 'auto',
  schema: z.enum(['auto', 'local', 'global', 'hybrid', 'naive', 'mix']),
});
