// 将 TTS 内部音频事件转换成前端 SSE 事件，是字节编码和句子编号的唯一出口。

import type { TurnId, SessionId } from '@ema-agent/ids';
import type { TtsEvent } from './events.js';
import type { TtsStreamEvent } from './types.js';

// ── TtsStreamEvent -> EmaStreamEvent 桥接 ────────────────────────────────────
//
// `TtsRuntime` 和 Adapter 使用 `TtsStreamEvent`(Uint8Array 字节,数字
// 句子索引)。前端说 `EmaStreamEvent.tts_chunk`(base64 音频字符串,
// 字符串 sentenceId)。本模块是唯一做转换的地方 - 保持纯函数,无副作用。
//
// sentenceId 格式:`<turnId>-<sentenceIndex>` - 在一个 turn 内唯一标识
// 一句话的音频,前端据此分组 chunk。重连后,前端可按 sentenceId 去重,
// 避免重播已播放的音频。
//
// 携带 sessionId,以便前端的 Live2D 路由把 TTS 事件过滤到当前 active
// session。否则多 session 的 TTS 会同时驱动同一个角色。

export interface BridgeContext {
  turnId:    TurnId;
  sessionId: SessionId;
}

/**
 * 把一个 `TtsStreamEvent` 转成 0 或 1 个 `EmaStreamEvent`。部分内部事件
 * (sentence_started、done)没有公共对应,返回 `null` - orchestrator 直接丢弃。
 *
 * 调用方负责跟踪当前句子索引,因为 `audio_chunk` 不带索引(它属于最近一次
 * sentence_started)。从 coordinator 的 per-turn 状态传 `currentSentenceIndex`。
 */
export function ttsEventToEma(
  ev:                    TtsStreamEvent,
  ctx:                   BridgeContext,
  currentSentenceIndex:  number,
): TtsEvent | null {
  switch (ev.type) {
    case 'audio_chunk':
      return {
        type:       'tts_chunk',
        turnId:     ctx.turnId,
        audio:      base64Encode(ev.bytes),
        sentenceId: makeSentenceId(ctx.turnId, currentSentenceIndex),
        sessionId:  ctx.sessionId,
      };

    case 'sentence_done':
      return {
        type:       'tts_sentence_complete',
        turnId:     ctx.turnId,
        sentenceId: makeSentenceId(ctx.turnId, ev.index),
        sessionId:  ctx.sessionId,
      };

    case 'error':
      return {
        type:    'tts_warning',
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        code: ev.code,
        severity: ev.code.startsWith('permanent_') ? 'error' : 'warn',
        message: `tts/${ev.code}: ${ev.message}`,
      };

    case 'sentence_started':
    case 'done':
      // 无 1:1 公共事件。`sentence_started` 由紧随其后的第一个带新 sentenceId
      // 的 `tts_chunk` 隐含;`done` 由 coordinator 在归档完成后单独发。
      return null;
  }
}

export function makeSentenceId(turnId: TurnId, index: number): string {
  return `${turnId as string}-${index}`;
}

export function parseSentenceId(sentenceId: string): { turnId: string; index: number } | null {
  const lastDash = sentenceId.lastIndexOf('-');
  if (lastDash < 0) return null;
  const turnId = sentenceId.slice(0, lastDash);
  const index  = Number.parseInt(sentenceId.slice(lastDash + 1), 10);
  if (!Number.isFinite(index)) return null;
  return { turnId, index };
}

// ── 内部实现 ─────────────────────────────────────────────────────────────────

/**
 * 对 Uint8Array 做 base64 编码。优先用 Node 的 `Buffer`(sidecar 运行时),
 * 测试环境回退到标准 `btoa`。支持任意 buffer 支撑的 Uint8Array
 * (ArrayBuffer 或 SharedArrayBuffer)。
 */
function base64Encode(bytes: Uint8Array<ArrayBufferLike>): string {
  // Node 20+ - 最快路径
  const g = globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } };
  if (g.Buffer) {
    return g.Buffer.from(bytes).toString('base64');
  }
  // 浏览器 / 纯 V8 回退
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}
