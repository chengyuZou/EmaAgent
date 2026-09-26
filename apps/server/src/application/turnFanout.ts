// 消费每个 Turn 的唯一事件流，并定向发布给 AgentChannel 与可选语音管线。
import type { TurnHandle, TurnStreamEvent } from '@ema-agent/turn';
import type { TurnSpeechHandle } from '../composition/speech.js';

export interface TurnFanoutDeps {
  readonly publishTurnEvent: (
    sessionId: string,
    turnId: string,
    event: TurnStreamEvent,
  ) => void;
  readonly emitAppEvent: (
    event: Extract<
      TurnStreamEvent,
      { type: 'turn_started' | 'turn_completed' | 'turn_failed' | 'turn_aborted' }
    >,
  ) => void;
  readonly startTurnSpeech: (setup: {
    sessionId: string;
    turnId: string;
    signal: AbortSignal;
  }) => Promise<TurnSpeechHandle | null>;
}

export class TurnFanout {
  constructor(private readonly deps: TurnFanoutDeps) {}

  attach(handle: TurnHandle): void {
    void this.pump(handle);
  }

  private async pump(handle: TurnHandle): Promise<void> {
    const { sessionId, turnId } = handle;
    const speechAbort = new AbortController();
    let speechPromise: Promise<TurnSpeechHandle | null> = Promise.resolve(null);
    let completed = false;
    try {
      for await (const event of handle.events) {
        if (event.type === 'turn_started' && event.ttsEnabled) {
          speechPromise = this.deps.startTurnSpeech({
            sessionId,
            turnId,
            signal: speechAbort.signal,
          }).catch(error => {
            console.warn('[speech] 启动失败，本 Turn 无语音输出:', error);
            return null;
          });
        }
        if (event.type === 'output_text_delta') {
          void speechPromise.then(speech => speech?.acceptTextDelta(event.delta));
        }
        if (event.type === 'turn_completed') {
          completed = true;
          void speechPromise
            .then(speech => speech?.finish())
            .catch(error => console.warn(`[speech] Turn ${turnId} 收口失败:`, error));
        }
        this.deps.publishTurnEvent(sessionId, turnId, event);
        if (event.type === 'turn_failed' || event.type === 'turn_aborted') {
          speechAbort.abort('turn ended without completion');
          void speechPromise.then(speech => speech?.abort());
        }
        if (isTurnActivity(event)) {
          this.deps.emitAppEvent(event);
        }
      }
    } catch (error) {
      console.warn(`[fanout] Turn ${turnId} 事件泵异常:`, error);
    } finally {
      if (!completed) {
        speechAbort.abort('turn event stream ended');
      }
    }
  }
}

function isTurnActivity(
  event: TurnStreamEvent,
): event is Extract<
  TurnStreamEvent,
  { type: 'turn_started' | 'turn_completed' | 'turn_failed' | 'turn_aborted' }
> {
  return (
    event.type === 'turn_started' ||
    event.type === 'turn_completed' ||
    event.type === 'turn_failed' ||
    event.type === 'turn_aborted'
  );
}
