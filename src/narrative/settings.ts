// Narrative 的用户设置：检索模式覆盖与 Bridge 进程开关。
import { defineSetting } from '@ema-agent/settings';
import { z } from 'zod';

/** auto = 模型按问题选择；其余值强制覆盖每次 Recall 的检索模式（Turn 开始时冻结）。 */
export const narrativeQueryModeSetting = defineSetting({
  key: 'narrative.queryMode',
  label: '剧情检索模式',
  description: 'auto=模型按问题选择；local/global/hybrid/naive/mix=强制每次剧情检索使用该模式。',
  apply: 'nextTurn',
  defaultValue: 'auto' as const,
  schema: z.enum(['auto', 'local', 'global', 'hybrid', 'naive', 'mix']),
});

/** false 时 Server 令 Bridge 进程退出且不再装配剧情检索；重新开启需重启应用（Bridge 不会被重新拉起）。 */
export const narrativeBridgeEnabledSetting = defineSetting({
  key: 'narrative.bridgeEnabled',
  label: '剧情检索进程',
  description: '关闭后 Narrative Bridge 进程退出且不再装配剧情检索；重新开启需重启应用。',
  apply: 'immediate',
  defaultValue: true,
  schema: z.boolean(),
});
