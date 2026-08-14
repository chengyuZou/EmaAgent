// 本文件解析模型流中的角色表现标签，并维护各 Session 独立的情绪状态。
import type { TurnId, SessionId } from '@ema-agent/ids';
import type { EmotionState, EmotionStreamEvent } from './events.js';
import { StreamingCharacterTagScanner } from './parser.js';
import type { ParsedCharacterTag } from './types.js';
import {
  makeInitialState,
  transitionEmotion,
  toPublicState,
  type EmotionStateInternal,
} from './state-machine.js';

// ── Session 状态 ──────────────────────────────────────────────────────────────

interface SessionEmotionState {
  state:               EmotionStateInternal;
  scanner:             StreamingCharacterTagScanner;
}

// ── 情绪引擎 ──────────────────────────────────────────────────────────────────

export interface EmotionEngineOptions {
  /** 当前角色卡允许使用的情绪名称。 */
  vocabulary: string[];
}

/**
 * EmotionEngine 解析角色表现标签并维护每个 Session 的情绪状态。
 *
 * Server 进程中的所有 Session 共用一个引擎实例。内部状态按 sessionId
 * 隔离，因此不同 Session 中并发执行的 Turn 不会相互污染。
 *
 * ## 每个 Turn 的生命周期
 *
 *   1. `beginTurn(sessionId)`：重置该 Session 的流式标签扫描器。
 *      情绪状态跨 Turn 保留，使角色在连续消息之间保持情绪延续。
 *
 *   2. 每收到一段 LLM `text_delta`：
 *      `processChunk(delta, turnId, sessionId)` → `{ cleaned, events }`
 *
 *   3. LLM 流结束后：
 *      `flush(turnId, sessionId)` → `{ cleaned, events }`
 *
 * ## 切换角色卡
 *
 *   `reset()`：清除所有 Session 的状态和扫描器，使其恢复中性状态。
 *   当前激活角色卡改变时，应与 `updateVocabulary()` 一同调用。
 *
 * ## Session 清理
 *
 *   `evictSession(sessionId)`：删除 Session 时释放对应的内部状态。
 *   它只负责回收内存，不影响执行正确性。
 */
export class EmotionEngine {
  private vocabulary: readonly string[];
  private readonly sessions = new Map<string, SessionEmotionState>();

  constructor(opts: EmotionEngineOptions) {
    this.vocabulary = opts.vocabulary;
  }

  // ── 公共接口 ────────────────────────────────────────────────────────────────

  /** 返回 Session 的当前情绪状态；尚未建立状态时返回 null。 */
  current(sessionId: SessionId): EmotionState | null {
    const s = this.sessions.get(sessionId as string);
    return s ? toPublicState(s.state) : null;
  }

  /** 当前激活角色卡改变后，替换允许使用的情绪词汇。 */
  updateVocabulary(vocabulary: string[]): void {
    this.vocabulary = vocabulary;
  }

  /**
   * 为指定 Session 的新 Turn 做准备。
   * 重置流式扫描器及本轮缓冲区，但保留已有情绪状态。
   */
  beginTurn(sessionId: SessionId): void {
    const existing = this.sessions.get(sessionId as string);
    this.sessions.set(sessionId as string, {
      state:               existing?.state ?? makeInitialState(),
      scanner:             new StreamingCharacterTagScanner(),
    });
  }

  /**
   * 完整重置所有 Session 的情绪状态与扫描器。
   * 角色卡由所有 Session 共享，因此切换角色卡时调用此方法。
   */
  reset(): void {
    this.sessions.clear();
  }

  /**
   * 释放已删除 Session 的状态，仅用于回收内存。
   */
  evictSession(sessionId: SessionId): void {
    this.sessions.delete(sessionId as string);
  }

  /**
   * 处理指定 Session 的一段流式增量。
   * 移除角色表现标签、更新内部状态，并返回：
   *   - `cleaned`：移除标签后的正文增量；
   *   - `events`：需要发出的 SSE 事件（`emotion_changed`、`stage_cue`）。
   */
  processChunk(
    delta:     string,
    turnId:    TurnId,
    sessionId: SessionId,
  ): { cleaned: string; events: EmotionStreamEvent[] } {
    const s = this.sessions.get(sessionId as string);
    if (!s) return { cleaned: delta, events: [] };

    const { cleaned, tags } = s.scanner.scan(delta);
    return { cleaned, events: this.tagsToEvents(tags, turnId, sessionId, s) };
  }

  /**
   * 流结束时释放指定 Session 中尚未处理的缓冲尾部。
   * 未闭合标签作为普通正文释放，flush 不产生新的表现事件。
   */
  flush(
    turnId:    TurnId,
    sessionId: SessionId,
  ): { cleaned: string; events: EmotionStreamEvent[] } {
    const s = this.sessions.get(sessionId as string);
    if (!s) return { cleaned: '', events: [] };

    const { cleaned } = s.scanner.flush();
    void turnId;
    return { cleaned, events: [] };
  }

  // ── 内部实现 ────────────────────────────────────────────────────────────────

  private tagsToEvents(
    tags:      ParsedCharacterTag[],
    turnId:    TurnId,
    sessionId: SessionId,
    s:         SessionEmotionState,
  ): EmotionStreamEvent[] {
    const events: EmotionStreamEvent[] = [];

    for (const tag of tags) {
      switch (tag.kind) {
        case 'emotion': {
          const next = transitionEmotion(s.state, tag.value, this.vocabulary);
          if (next !== null) {
            s.state = next;
            events.push({
              type: 'emotion_changed',
              sessionId,
              turnId,
              state: toPublicState(next),
            });
          }
          break;
        }
        case 'motion':
          events.push({
            type: 'stage_cue',
            sessionId,
            turnId,
            cue: { motion: tag.value, priority: 1 },
          });
          break;
      }
    }

    return events;
  }
}
