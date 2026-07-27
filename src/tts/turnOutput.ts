// 把根 Turn 文本事件装饰为带语音事件的输出流，并保证根终态最后发送。

import type { SessionId, TurnId } from '@ema-agent/ids';
import type { FinalizedAudio, AudioArchive } from './archive.js';
import { TtsCoordinator } from './coordinator.js';
import type { TtsEvent } from './events.js';
import type { TtsRuntime } from './ttsRuntime.js';
import type { TtsAudioFormat, TtsVoiceRef } from './types.js';

const TERMINAL_EVENT_TYPES = new Set([
  'turn_completed',
  'turn_failed',
  'turn_aborted',
]);

/**
 * 输出装饰只观察文本增量与根终态，其余领域事件保持原样透传。
 * 可选 delta 让调用方继续使用自己的完整事件联合，不依赖中央事件包。
 */
export interface TurnSpeechSourceEvent {
  readonly type: string;
  readonly delta?: string;
}

export interface TurnSpeechSynthesis {
  readonly voice: TtsVoiceRef;
  readonly providerId: string;
  readonly model: string;
  readonly ttsClient: TtsRuntime;
  readonly archive?: AudioArchive;
  readonly format?: TtsAudioFormat;
  readonly maxBytesPerTurn?: number;
}

export interface TurnSpeechSetupRequest {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly signal: AbortSignal;
}

export interface FinalizedTurnAudio {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly audio: FinalizedAudio;
}

export interface TurnSpeechOutputDependencies {
  /**
   * Composition Root 在这里解析 TTS binding、角色语音和文件路径。
   * 返回 null 表示本轮没有可用语音，不改变根 Turn 的执行结果。
   */
  readonly resolveSynthesis: (
    request: TurnSpeechSetupRequest,
  ) => Promise<TurnSpeechSynthesis | null>;
  /** 最终音频的持久统计是可重建投影，失败只产生 TTS warning。 */
  readonly recordFinalizedAudio?: (
    finalized: FinalizedTurnAudio,
  ) => void | Promise<void>;
}

export interface TurnSpeechOutputRequest<TEvent extends TurnSpeechSourceEvent> {
  readonly enabled: boolean;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly events: AsyncIterable<TEvent>;
}

/**
 * TTS 是根 Turn 的可选输出增强，不参与 AgentLoop，也不拥有根 Turn 终态。
 * 只有成功终态会等待音频合成和归档；失败或取消会丢弃尚未完成的音频。
 */
export class TurnSpeechOutput {
  constructor(private readonly dependencies: TurnSpeechOutputDependencies) {}

  decorate<TEvent extends TurnSpeechSourceEvent>(
    request: TurnSpeechOutputRequest<TEvent>,
  ): AsyncIterable<TEvent | TtsEvent> {
    return this.stream(request);
  }

  private async *stream<TEvent extends TurnSpeechSourceEvent>(
    request: TurnSpeechOutputRequest<TEvent>,
  ): AsyncGenerator<TEvent | TtsEvent, void, void> {
    if (!request.enabled) {
      yield* request.events;
      return;
    }

    const controller = new AbortController();
    const queue = new SpeechEventQueue<TtsEvent>();
    let coordinator: TtsCoordinator | null = null;

    try {
      const synthesis = await this.dependencies.resolveSynthesis({
        sessionId: request.sessionId,
        turnId: request.turnId,
        signal: controller.signal,
      });
      if (!synthesis) {
        try {
          yield* request.events;
        } finally {
          controller.abort('turn speech output disabled after setup');
        }
        return;
      }

      coordinator = new TtsCoordinator({
        turnId: request.turnId,
        sessionId: request.sessionId,
        voice: synthesis.voice,
        providerId: synthesis.providerId,
        model: synthesis.model,
        ttsClient: synthesis.ttsClient,
        emit: (event) => queue.push(event),
        archive: synthesis.archive,
        format: synthesis.format,
        signal: controller.signal,
        maxBytesPerTurn: synthesis.maxBytesPerTurn,
      });
    } catch (error) {
      yield setupWarning(request, error);
      try {
        yield* request.events;
      } finally {
        controller.abort('turn speech output setup failed');
      }
      return;
    }

    let terminal: TEvent | null = null;
    try {
      for await (const event of mergeSpeechEvents(request.events, coordinator, queue)) {
        if (isTerminalEvent(event)) {
          // TtsEvent 不定义根终态；命中终态字符串的成员必然来自源 Turn 流。
          terminal = event as TEvent;
          continue;
        }
        yield event;
      }

      if (terminal?.type === 'turn_completed') {
        const { audio } = await coordinator.finish();
        yield* queue.drain();
        if (audio) {
          const projectionWarning = await this.recordFinalizedAudio(request, audio);
          if (projectionWarning) yield projectionWarning;
        }
      } else {
        await coordinator.abort();
        queue.clear();
      }

      if (terminal) yield terminal;
    } finally {
      controller.abort('turn speech output closed');
      await coordinator.abort();
    }
  }

  private async recordFinalizedAudio<TEvent extends TurnSpeechSourceEvent>(
    request: TurnSpeechOutputRequest<TEvent>,
    audio: FinalizedAudio,
  ): Promise<TtsEvent | null> {
    if (!this.dependencies.recordFinalizedAudio) return null;
    try {
      await this.dependencies.recordFinalizedAudio({
        sessionId: request.sessionId,
        turnId: request.turnId,
        audio,
      });
      return null;
    } catch (error) {
      return {
        type: 'tts_warning',
        sessionId: request.sessionId,
        turnId: request.turnId,
        code: 'tts/audio_projection_failed',
        severity: 'warn',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/**
 * TTS 事件可能在根事件等待期间到达。队列在登记 waiter 前再次检查缓存，
 * 避免旧的“先清队列再换 Promise”实现丢失一次唤醒并永久卡住输出流。
 */
class SpeechEventQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters = new Set<() => void>();

  push(item: T): void {
    this.items.push(item);
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiters) wake();
  }

  drain(): T[] {
    return this.items.splice(0);
  }

  clear(): void {
    this.items.length = 0;
  }

  waitForItem(): { promise: Promise<void>; cancel: () => void } {
    if (this.items.length > 0) {
      return { promise: Promise.resolve(), cancel: () => undefined };
    }

    let wake = (): void => undefined;
    const promise = new Promise<void>((resolve) => {
      wake = resolve;
      this.waiters.add(wake);
      if (this.items.length > 0) {
        this.waiters.delete(wake);
        resolve();
      }
    });
    return {
      promise,
      cancel: () => this.waiters.delete(wake),
    };
  }
}

async function* mergeSpeechEvents<TEvent extends TurnSpeechSourceEvent>(
  events: AsyncIterable<TEvent>,
  coordinator: TtsCoordinator,
  queue: SpeechEventQueue<TtsEvent>,
): AsyncGenerator<TEvent | TtsEvent, void, void> {
  const iterator = events[Symbol.asyncIterator]();
  let nextEvent = iterator.next();

  try {
    while (true) {
      yield* queue.drain();

      const wait = queue.waitForItem();
      const arrived = await Promise.race([
        nextEvent.then((result) => ({ kind: 'source' as const, result })),
        wait.promise.then(() => ({ kind: 'speech' as const })),
      ]).finally(wait.cancel);
      if (arrived.kind === 'speech') continue;
      if (arrived.result.done) break;

      const event = arrived.result.value;
      nextEvent = iterator.next();
      if (event.type === 'output_text_delta' && typeof event.delta === 'string') {
        coordinator.acceptTextDelta(event.delta);
      }
      yield event;
    }

    yield* queue.drain();
  } finally {
    await iterator.return?.();
  }
}

function isTerminalEvent(event: TurnSpeechSourceEvent): boolean {
  return TERMINAL_EVENT_TYPES.has(event.type);
}

function setupWarning<TEvent extends TurnSpeechSourceEvent>(
  request: TurnSpeechOutputRequest<TEvent>,
  error: unknown,
): TtsEvent {
  return {
    type: 'tts_warning',
    sessionId: request.sessionId,
    turnId: request.turnId,
    code: 'tts/setup_failed',
    severity: 'warn',
    message: `TTS 初始化失败，本轮无语音：${error instanceof Error ? error.message : String(error)}`,
  };
}
