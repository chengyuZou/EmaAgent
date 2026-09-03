// Narrative 的用户设置: 检索模式覆盖.
import { defineSetting } from '@ema-agent/settings';
import { z } from 'zod';

/** auto = 模型按问题选择；其余值强制覆盖每次 Recall 的检索模式（Turn 开始时冻结）。 */
export const narrativeQueryModeSetting = defineSetting({
  key: 'narrative.queryMode',
  apply: 'nextTurn',
  defaultValue: 'auto' as const,
  schema: z.enum(['auto', 'local', 'global', 'hybrid', 'naive', 'mix']),
});
