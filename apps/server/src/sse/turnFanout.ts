// Turn 事件流的唯一消费点：写重放日志、在线扇出、语音合流、应用级回声。
import type { TurnHandle, TurnStreamEvent } from '@ema-agent/turn';
import type { TurnSpeechHandle } from '../composition/speech.js';
import { EventHub, type TurnSseEvent } from './eventHub.js';
import type { TurnEventStore } from './eventStore.js';

export interface TurnFanoutDeps {
  readonly store: TurnEventStore;
  readonly hub: EventHub;
  readonly startTurnSpeech: (setup: {
    sessionId: string;
    turnId: string;
    signal: AbortSignal;
  }) => Promise<TurnSpeechHandle | null>;
}

/**
 * TurnHandle.events 是单消费者通道——只有一个 fanout 泵允许读取。
 * Speech 只旁听文本增量；声音注册、合成和播放都不能阻塞 Turn SSE。
 */
export class TurnFanout {
  constructor(private readonly deps: TurnFanoutDeps) {}

  attach(handle: TurnHandle, options: { ttsEnabled: boolean }): void {
    const { sessionId, turnId } = handle;
    this.deps.store.open(turnId);

    const speechAbort = new AbortController();
    const speechPromise = options.ttsEnabled
      ? this.deps.startTurnSpeech({
          sessionId,
          turnId,
          signal: speechAbort.signal,
        }).catch(error => {
          // 语音是可选增强：启动失败降级为静默无音频，不影响 Turn。
          console.warn('[speech] 启动失败，本 Turn 无语音输出:', error);
          return null;
        })
      : Promise.resolve(null);

    void this.pump(handle, speechPromise, speechAbort);
  }

  private async pump(
    handle: TurnHandle,
    speechPromise: Promise<TurnSpeechHandle | null>,
    speechAbort: AbortController,
  ): Promise<void> {
    const { sessionId, turnId } = handle;
    let completed = false;
    try {
      for await (const event of handle.events) {
        if (event.type === 'output_text_delta') {
          void speechPromise.then(speech => speech?.acceptTextDelta(event.delta));
        }
        if (event.type === 'turn_completed') {
          completed = true;
          void speechPromise.then(speech => speech?.finish()).catch(error => {
            console.warn(`[speech] Turn ${turnId} 收口失败:`, error);
          });
        }
        this.push(turnId, event);
        if (event.type === 'turn_failed' || event.type === 'turn_aborted') {
          speechAbort.abort('turn ended without completion');
          void speechPromise.then(speech => speech?.abort());
        }
        if (isTurnActivity(event)) {
          this.deps.hub.emitApp(event);
        }
      }
    } catch (error) {
      console.warn(`[fanout] Turn ${turnId} 事件泵异常:`, error);
    } finally {
      if (!completed) speechAbort.abort('turn event stream ended');
    }
  }

  private push(turnId: string, event: TurnSseEvent): void {
    const result = this.deps.store.push(turnId, event);
    if (result.status === 'stored') {
      this.deps.hub.publishTurn(turnId, result.published);
      return;
    }
    if (result.status === 'live_only') {
      this.deps.hub.publishTurn(turnId, result.published);
    }
  }
}

/** 四类 Turn 生命周期事件会回声到应用通道；其余 Turn 流事件只属于该 Turn 的订阅者。 */
function isTurnActivity(
  event: TurnSseEvent,
): event is Extract<TurnStreamEvent, { type: 'turn_started' | 'turn_completed' | 'turn_failed' | 'turn_aborted' }> {
  return event.type === 'turn_started'
    || event.type === 'turn_completed'
    || event.type === 'turn_failed'
    || event.type === 'turn_aborted';
}
