// 定义 Provider 健康状态变化向产品事件流公开的稳定协议。
import type { ProtocolFamily } from './types.js';

export type ProviderHealthStatus = 'ok' | 'failed' | 'probing' | 'unknown';

export interface ProviderHealthChangedEvent {
  type: 'provider_health_changed';
  /** provider_configs.id，标识用户配置的供应商实例。 */
  providerId: string;
  /** Provider 静态定义标识，如 openai、dashscope。 */
  definitionId: string;
  protocol: ProtocolFamily;
  status: ProviderHealthStatus;
  latencyMs?: number;
  error?: string;
}

export type ProviderStreamEvent = ProviderHealthChangedEvent;
