// 广播不属于单个 Turn 的应用级提示事件，查询型状态仍由各自 HTTP Route 提供。
import type { CharacterEvent } from '@ema-agent/characters';
import type { KnowledgeEvent } from '@ema-agent/knowledge';
import type { McpConnection, McpMarketSource } from '@ema-agent/mcp';
import type { SystemWarningEvent } from '@ema-agent/system';
import type { BackgroundProcessEvent } from '@ema-agent/tools';
import type { TurnEvent } from '@ema-agent/turn';

export type TurnActivityEvent = Extract<
  TurnEvent,
  { type: 'turn_started' | 'turn_completed' | 'turn_failed' | 'turn_aborted' }
>;

export type AppEvent =
  | BackgroundProcessEvent
  | KnowledgeEvent
  | CharacterEvent
  | TurnActivityEvent
  | SystemWarningEvent
  | { readonly type: 'session_title_updated'; readonly sessionId: string; readonly title: string }
  | { readonly type: 'settings_changed'; readonly changedKeys: readonly string[] }
  | { readonly type: 'skills_changed' }
  | { readonly type: 'mcp_connection_changed'; readonly connection: McpConnection }
  | { readonly type: 'mcp_market_changed'; readonly source: McpMarketSource };

export class AppEvents {
  private readonly listeners = new Set<(event: AppEvent) => void>();

  subscribe(listener: (event: AppEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  emit(event: AppEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.warn('[app-events] 订阅者异常:', error);
      }
    }
  }
}
