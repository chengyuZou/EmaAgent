import { logging } from '@ema-agent/logging';
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
            logging({
              level: 'warn',
              target: 'speech',
              event: 'speech.start_failed',
              error,
              body: { sessionId, turnId },
            });
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
            .catch(error => logging({
              level: 'warn',
              target: 'speech',
              event: 'speech.save_failed',
              error,
              body: { turnId },
            }));
        }
        this.deps.publishTurnEvent(sessionId, turnId, event);
        if (event.type === 'turn_failed' || event.type === 'turn_aborted') {
          speechAbort.abort('turn ended without completion');
          void speechPromise
            .then(speech => speech?.cancel())
            .catch(error => logging({
              level: 'warn',
              target: 'speech',
              event: 'speech.cancel_failed',
              error,
              body: { turnId },
            }));
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
