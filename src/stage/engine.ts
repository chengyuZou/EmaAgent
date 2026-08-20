// 解析模型流中的角色表现标签，并维护各 Session 独立的舞台状态。
import type { EmotionState, StageStreamEvent } from './events.js';
import { StreamingCharacterTagScanner } from './parser.js';
import type { ParsedCharacterTag } from './types.js';
import {
  makeInitialState,
  transitionEmotion,
  toPublicState,
  type EmotionStateInternal,
} from './state-machine.js';

interface SessionStageState {
  state:               EmotionStateInternal;
  scanner:             StreamingCharacterTagScanner;
}

export interface StageEngineOptions {
  /** 当前角色允许使用的情绪名称（对应 <emotion> 标签与持续状态）。 */
  emotions: readonly string[];
  /** 当前角色允许使用的动作名称（对应 <motion> 标签与一次性 stage_cue）。 */
  motions: readonly string[];
}

/**
 * StageEngine 把模型输出里的角色表现协议变成舞台指令：情绪标签驱动跨 Turn
 * 持续状态，动作标签产生一次性舞台提示，两类标签都从用户可见正文剥离。
 *
 * 进程内所有 Session 共用一个实例，内部状态按 sessionId 隔离。
 * 未知名称（模型编造的词汇）不发事件，只清洗正文——舞台永远只收到
 * 当前角色声明过的情绪与动作。
 */
export class StageEngine {
  private emotions: readonly string[];
  private motions: readonly string[];
  private readonly sessions = new Map<string, SessionStageState>();

  constructor(opts: StageEngineOptions) {
    this.emotions = opts.emotions;
    this.motions = opts.motions;
  }

  /** 返回 Session 的当前情绪状态；尚未建立状态时返回 null。 */
  current(sessionId: string): EmotionState | null {
    const s = this.sessions.get(sessionId);
    return s ? toPublicState(s.state) : null;
  }

  /** 当前激活角色改变后，替换允许使用的情绪与动作词汇。 */
  updateVocabulary(emotions: readonly string[], motions: readonly string[]): void {
    this.emotions = emotions;
    this.motions = motions;
  }

  /** 新 Turn 重置该 Session 的流式扫描器；情绪状态跨 Turn 保留。 */
  beginTurn(sessionId: string): void {
    const existing = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      state:               existing?.state ?? makeInitialState(),
      scanner:             new StreamingCharacterTagScanner(),
    });
  }

  /** 完整重置所有 Session 的舞台状态；角色由所有 Session 共享，切换角色时调用。 */
  reset(): void {
    this.sessions.clear();
  }

  /** 释放已删除 Session 的状态，仅用于回收内存。 */
  evictSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * 处理一段流式增量，返回去除表现标签后的正文与需要发出的舞台事件
   *（`emotion_changed` / `stage_cue`）。
   */
  processChunk(
    delta:     string,
    turnId:    string,
    sessionId: string,
  ): { cleaned: string; events: StageStreamEvent[] } {
    const s = this.sessions.get(sessionId);
    if (!s) return { cleaned: delta, events: [] };

    const { cleaned, tags } = s.scanner.scan(delta);
    return { cleaned, events: this.tagsToEvents(tags, turnId, sessionId, s) };
  }

  /** 流结束时释放未闭合的缓冲尾部；flush 不产生新的表现事件。 */
  flush(
    turnId:    string,
    sessionId: string,
  ): { cleaned: string; events: StageStreamEvent[] } {
    const s = this.sessions.get(sessionId);
    if (!s) return { cleaned: '', events: [] };

    const { cleaned } = s.scanner.flush();
    void turnId;
    return { cleaned, events: [] };
  }

  private tagsToEvents(
    tags:      ParsedCharacterTag[],
    turnId:    string,
    sessionId: string,
    s:         SessionStageState,
  ): StageStreamEvent[] {
    const events: StageStreamEvent[] = [];

    for (const tag of tags) {
      switch (tag.kind) {
        case 'emotion': {
          const next = transitionEmotion(s.state, tag.value, this.emotions);
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
        case 'motion': {
          // 动作不进入状态机，但同样只放行当前角色声明过的名称。
          if (!this.motions.includes(tag.value)) break;
          events.push({
            type: 'stage_cue',
            sessionId,
            turnId,
            cue: { motion: tag.value, priority: 1 },
          });
          break;
        }
      }
    }

    return events;
  }
}
