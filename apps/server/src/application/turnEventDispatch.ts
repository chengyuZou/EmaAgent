import { logging } from '@ema-agent/logging';
import type { TurnHandle, TurnStreamEvent } from '@ema-agent/turn';
import type { SpeechGeneration, SpeechGenerator } from '@ema-agent/speech';
import type { SpeechComposition } from '../composition/speech.js';

/** `dispatchTurnEvents` 消费单个 Turn 事件流时使用的下游分发协作者. */
export interface TurnEventDispatchDeps {
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

/**
 * 后台顺序读取并分发指定 Turn 的事件流, 调用方通过 `void dispatchTurnEvents(...)` 启动且立即继续.
 * 该异步流程负责三件事: 推送 Session 前端事件, 上报应用级 Turn 生命周期事件, 以及驱动可选的自动 TTS 文本输入;
 * 这里不等待 TTS 音频合成结束, 仅保证正常完成时封口或异常退出时取消当前 Turn 语音输入.
 */
export async function dispatchTurnEvents(
  handle: TurnHandle,
  deps: TurnEventDispatchDeps,
): Promise<void> {
  const { sessionId, turnId } = handle;
  const speechAbortController = new AbortController();
  let speechGeneration: SpeechGeneration | null = null;
  // 只表示已经收到 `turn_completed`, 不代表语音合成音频已经生成完成.
  let hasReceivedTurnCompleted = false;
  try {
    for await (const event of handle.events) {
      if (event.type === 'turn_started' && event.ttsEnabled) {
        try {
          const turnSpeechInput = deps.speech.createTurnSpeechInput(
            sessionId,
            turnId,
            undefined,
            speechAbortController.signal,
          );
          speechGeneration = deps.speech.speechGenerator.startTurnSpeech(turnSpeechInput);
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
          deps.speech.speechGenerator.appendTextDelta(
            speechGeneration.audioId,
            event.delta,
            event.tags ?? null,
          );
        }
      }
      if (event.type === 'turn_completed') {
        hasReceivedTurnCompleted = true;
        // Turn 正常结束时只通知 TTS 文本输入完结, 不阻塞事件分发和下一轮调度.
        if (speechGeneration) {
          deps.speech.speechGenerator.endTextInput(speechGeneration.audioId);
        }
      }
      deps.publishTurnEvent(
        sessionId,
        turnId,
        event.type === 'turn_started'
          ? {
              ...event,
              audioId: speechGeneration?.audioId ?? null,
              characterName: speechGeneration?.characterName,
            }
          : event,
      );
      if (event.type === 'turn_failed' || event.type === 'turn_aborted') {
        speechAbortController.abort('turn ended without completion');
      }
      if (isAppLifecycleTurnEvent(event)) {
        deps.emitAppEvent(event);
      }
    }
  } catch (error) {
    logging({
      level: 'warn',
      target: 'turn',
      event: 'turn.event_dispatch_failed',
      error,
      body: { turnId },
    });
  } finally {
    if (!hasReceivedTurnCompleted) {
      speechAbortController.abort('turn event stream ended');
    }
  }
}

function isAppLifecycleTurnEvent(
  event: TurnStreamEvent,
): event is Extract<
  TurnStreamEvent,
  { type: 'turn_started' | 'turn_completed' | 'turn_failed' | 'turn_aborted' }
> {
  return (
    event.type === 'turn_started'
    || event.type === 'turn_completed'
    || event.type === 'turn_failed'
    || event.type === 'turn_aborted'
  );
}
