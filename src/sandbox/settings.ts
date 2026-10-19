import { z } from 'zod';
import { defineSetting } from '@ema-agent/settings/definition';
import type { SandboxNetwork } from './types.js';

// 状态查询立即读取新值. 已创建的 CommandRunner 保留构造时的网络档位.
export const sandboxNetworkSetting = defineSetting<SandboxNetwork>({
  key: 'sandbox.network',
  apply: 'immediate',
  defaultValue: 'none',
  schema: z.enum(['none', 'full']),
});
