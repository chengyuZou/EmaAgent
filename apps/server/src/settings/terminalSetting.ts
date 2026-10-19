import { z } from 'zod';
import { defineSetting } from '@ema-agent/settings/definition';

export const terminalShellExecutableSetting = defineSetting({
  key: 'frontend.terminal.shellExecutable',
  apply: 'immediate',
  defaultValue: '',
  schema: z.string(),
});
