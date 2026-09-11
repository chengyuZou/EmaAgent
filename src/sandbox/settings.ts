// 沙箱网络档位设置。两档是域名白名单模型的特例(空名单=none);代理门卫落地前,
// 全有/全全是唯一诚实的粒度。白名单上线后本键被 allowedDomains 取代,语义无缝接住。
import { z } from 'zod';
import { defineSetting } from '@ema-agent/settings';
import type { SandboxStatus } from './types.js';

export type SandboxNetwork = SandboxStatus['sandboxNetwork'];

export const sandboxNetworkSetting = defineSetting<SandboxNetwork>({
  key: 'sandbox.network',
  apply: 'immediate',
  defaultValue: 'none',
  schema: z.enum(['none', 'full']),
});
