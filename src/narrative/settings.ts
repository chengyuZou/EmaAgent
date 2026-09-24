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

/** 只控制下一次桌面启动；运行中手动启停不会改写这个偏好。 */
export const narrativeStartOnLaunchSetting = defineSetting({
  key: 'narrative.startOnLaunch',
  apply: 'restart',
  defaultValue: true,
  schema: z.boolean(),
});
