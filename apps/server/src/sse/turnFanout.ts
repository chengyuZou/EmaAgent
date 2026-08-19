// Turn 事件流的唯一消费点：写重放日志、在线扇出、语音合流、应用级回声。
import type { TurnHandle, TurnStreamEvent } from '@ema-agent/turn';
import type { TurnSpeechHandle } from '../composition/speech.js';
import { EventHub, type TurnWireEvent } from './eventHub.js';
import type { TurnEventStore } from './eventStore.js';

export interface TurnFanoutDeps {
  readonly store: TurnEventStore;
  readonly hub: EventHub;
  readonly startTurnSpeech: (setup: {
    sessionId: string;
    turnId: string;
    signal: AbortSignal;
    emit: (event: TurnWireEvent) => void;
  }) => Promise<TurnSpeechHandle | null>;
  /** 重放日志超预算时终止该 Turn（终态事件仍会被写入，客户端可明确结束）。 */
  readonly abortTurn: (sessionId: string, turnId: string) => void;
}

/**
 * TurnHandle.events 是单消费者通道——只有一个 fanout 泵允许读取。
 * 语音事件（tts_chunk 等）由 Speech 异步产生，经同一个 push 进入与 Turn 事件
 * 共享的游标序列；终态到达时先等语音收口（completed）或丢弃（aborted/failed），
 * 再让终态事件过闸，保证客户端看到 turn_completed 时合并音频已就绪。
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
          emit: event => this.push(turnId, event),
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
    const speech = await speechPromise;
    try {
      for await (const event of handle.events) {
        if (event.type === 'output_text_delta') {
          speech?.acceptTextDelta(event.delta);
        }
        if (event.type === 'turn_completed') {
          // 先让语音收口（剩余分句合成 + 合并音频落盘），终态再过闸。
          await speech?.finish();
        }
        this.push(turnId, event);
        if (event.type === 'turn_failed' || event.type === 'turn_aborted') {
          await speech?.abort();
        }
        if (isTurnActivity(event)) {
          this.deps.hub.emitApp(event);
        }
      }
    } catch (error) {
      console.warn(`[fanout] Turn ${turnId} 事件泵异常:`, error);
    } finally {
      speechAbort.abort();
    }
  }

  private push(turnId: string, event: TurnWireEvent): void {
    const result = this.deps.store.push(turnId, event);
    if (result.status === 'stored') {
      this.deps.hub.publishTurn(turnId, result.published);
      return;
    }
    if (result.status === 'overflow') {
      console.warn(`[fanout] Turn ${turnId} 重放日志超预算，终止该 Turn`);
      this.deps.abortTurn(event.sessionId, turnId);
    }
  }
}

/** 四类 Turn 生命周期事件会回声到应用通道；其余 Turn 流事件只属于该 Turn 的订阅者。 */
function isTurnActivity(
  event: TurnWireEvent,
): event is Extract<TurnStreamEvent, { type: 'turn_started' | 'turn_completed' | 'turn_failed' | 'turn_aborted' }> {
  return event.type === 'turn_started'
    || event.type === 'turn_completed'
    || event.type === 'turn_failed'
    || event.type === 'turn_aborted';
}
