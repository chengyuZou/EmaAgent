// 广播不属于单个 Turn 的应用级提示事件，查询型状态仍由各自 HTTP Route 提供。
import type { CharacterEvent } from '@ema-agent/characters';
import type { KnowledgeEvent } from '@ema-agent/knowledge';
import type { McpEvent } from '@ema-agent/mcp';
import type { SystemWarningEvent } from '@ema-agent/system';
import type { BackgroundProcessEvent } from '@ema-agent/tools';
import type { TurnEvent } from '@ema-agent/turn';
import type { ProviderEvent } from '@ema-agent/providers';
import type { SessionEvent } from '@ema-agent/session';
import type { AttachmentEvent } from '@ema-agent/attachments';
import type { UsageEvent } from '@ema-agent/usage';
import type { AgentRunChangedEvent } from '@ema-agent/agent';
import type { SpeechArchiveEvent } from '@ema-agent/speech';
import type { TaskEvent } from '@ema-agent/tasks';
import type { SettingsEvent } from '@ema-agent/settings';
import type { SkillEvent } from '@ema-agent/skills';

export type TurnActivityEvent = Extract<
  TurnEvent,
  { type: 'turn_started' | 'turn_completed' | 'turn_failed' | 'turn_aborted' }
>;

export type AppEvent =
  | BackgroundProcessEvent
  | KnowledgeEvent
  | CharacterEvent
  | TurnActivityEvent
  | ProviderEvent
  | SessionEvent
  | AttachmentEvent
  | UsageEvent
  | AgentRunChangedEvent
  | SpeechArchiveEvent
  | TaskEvent
  | SettingsEvent
  | SkillEvent
  | McpEvent
  | SystemWarningEvent;

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
