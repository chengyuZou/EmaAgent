import { logging } from '@ema-agent/logging';
import type { CharacterEvent } from '@ema-agent/characters';
import type { McpEvent } from '@ema-agent/mcp';
import type { SystemWarningEvent } from '@ema-agent/system';
import type { BackgroundProcessEvent } from '@ema-agent/tools';
import type { TurnEvent } from '@ema-agent/turn';
import type { ProviderEvent } from '@ema-agent/providers';
import type { SessionEvent } from '@ema-agent/session';
import type { AttachmentEvent } from '@ema-agent/attachments';
import type { AudioRecordEvent } from '@ema-agent/speech';
import type { TaskEvent } from '@ema-agent/tasks';
import type { SettingsEvent } from '@ema-agent/settings';
import type { SkillEvent } from '@ema-agent/skills';
import type { GoalEvent } from '@ema-agent/goal';

export type TurnActivityEvent = Extract<
  TurnEvent,
  { type: 'turn_started' | 'turn_completed' | 'turn_failed' | 'turn_aborted' }
>;

export type AppEvent =
  | BackgroundProcessEvent
  | CharacterEvent
  | TurnActivityEvent
  | ProviderEvent
  | SessionEvent
  | AttachmentEvent
  | AudioRecordEvent
  | TaskEvent
  | SettingsEvent
  | SkillEvent
  | GoalEvent
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
        logging({
          level: 'warn',
          target: 'app_events',
          event: 'app_events.listener_failed',
          error,
          body: { kind: event.type },
        });
      }
    }
  }
}
