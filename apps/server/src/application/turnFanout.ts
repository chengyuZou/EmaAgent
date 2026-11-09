import { logging } from '@ema-agent/logging';
import type { TurnHandle, TurnStreamEvent } from '@ema-agent/turn';
import type { SpeechGeneration, SpeechGenerator } from '@ema-agent/speech';
import type { SpeechComposition } from '../composition/speech.js';

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
  readonly speech: {
    readonly speechGenerator: Pick<SpeechGenerator, 'startTurnSpeech' | 'appendTextDelta' | 'endTextInput'>;
    readonly createTurnSpeechInput: SpeechComposition['createTurnSpeechInput'];
  };
}

export class TurnFanout {
  constructor(private readonly deps: TurnFanoutDeps) {}

  attach(handle: TurnHandle): void {
    void this.pump(handle);
  }

  private async pump(handle: TurnHandle): Promise<void> {
    const { sessionId, turnId } = handle;
    const speechAbort = new AbortController();
    let speechGeneration: SpeechGeneration | null = null;
    let completed = false;
    try {
      for await (const event of handle.events) {
        if (event.type === 'turn_started' && event.ttsEnabled) {
          try {
            const input = this.deps.speech.createTurnSpeechInput(sessionId, turnId, undefined, speechAbort.signal);
            speechGeneration = this.deps.speech.speechGenerator.startTurnSpeech(input);
          } catch (error) {
            logging({
              level: 'warn',
              target: 'speech',
              event: 'speech.start_failed',
              error,
              body: { sessionId, turnId },
            });
          }
        }
        if (event.type === 'output_text_delta') {
          if (speechGeneration) {
            this.deps.speech.speechGenerator.appendTextDelta(speechGeneration.audioId, event.delta, event.tags ?? null);
          }
        }
        if (event.type === 'turn_completed') {
          completed = true;
          // 正常结束只封口, 不阻塞 Turn 事件和下一轮输入.
          if (speechGeneration) this.deps.speech.speechGenerator.endTextInput(speechGeneration.audioId);
        }
        this.deps.publishTurnEvent(sessionId, turnId, event.type === 'turn_started'
          ? { ...event, audioId: speechGeneration?.audioId ?? null, characterName: speechGeneration?.characterName }
          : event);
        if (event.type === 'turn_failed' || event.type === 'turn_aborted') {
          speechAbort.abort('turn ended without completion');
        }
        if (isTurnActivity(event)) {
          this.deps.emitAppEvent(event);
        }
      }
    } catch (error) {
      logging({
        level: 'warn',
        target: 'turn',
        event: 'turn.fanout_failed',
        error,
        body: { turnId },
      });
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
