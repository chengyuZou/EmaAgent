// 从模型正文中移除角色表现标签, 并把已声明的情绪和动作转成流式事件.
import type { StageStreamEvent } from './events.js';
import { StreamingCharacterTagScanner } from './parser.js';
import type { ParsedCharacterTag } from './types.js';

export interface StageEngineOptions {
  /** 当前角色允许使用的情绪名称, 对应模型输出中的 <emotion> 标签. */
  emotions: readonly string[];
  /** 当前角色允许使用的动作名称, 对应模型输出中的 <motion> 标签. */
  motions: readonly string[];
}

/**
 * 每个 Session 只保存一个跨 delta 的标签扫描器. StageEngine 不保存当前情绪或动作;
 * Desktop 收到事件后决定哪个 Session 可以控制 Live2D.
 */
export class StageEngine {
  private emotions: readonly string[];
  private motions: readonly string[];
  private readonly scanners = new Map<string, StreamingCharacterTagScanner>();

  constructor(opts: StageEngineOptions) {
    this.emotions = opts.emotions;
    this.motions = opts.motions;
  }

  /** 当前激活角色改变后, 替换允许使用的情绪与动作词汇. */
  updateVocabulary(emotions: readonly string[], motions: readonly string[]): void {
    this.emotions = emotions;
    this.motions = motions;
  }

  /** 新 Turn 使用新的扫描器, 防止上一轮未闭合的标签尾部进入下一轮. */
  beginTurn(sessionId: string): void {
    this.scanners.set(sessionId, new StreamingCharacterTagScanner());
  }

  /** 切换共享角色时丢弃全部未闭合标签, 新 Turn 会建立新的扫描器. */
  reset(): void {
    this.scanners.clear();
  }

  /** Session 删除后丢弃它尚未闭合的标签尾部. */
  evictSession(sessionId: string): void {
    this.scanners.delete(sessionId);
  }

  /**
   * 处理一段流式增量，返回去除表现标签后的正文与需要发出的舞台事件
   *（`emotion_changed` / `motion_changed`）。
   */
  processChunk(
    delta:     string,
    turnId:    string,
    sessionId: string,
  ): { cleaned: string; events: StageStreamEvent[] } {
    const scanner = this.scanners.get(sessionId);
    if (!scanner) return { cleaned: delta, events: [] };

    const { cleaned, tags } = scanner.scan(delta);
    return { cleaned, events: this.tagsToEvents(tags, turnId, sessionId) };
  }

  /** 流结束时释放未闭合的标签尾部; flush 不产生新的表现事件. */
  flush(sessionId: string): { cleaned: string; events: StageStreamEvent[] } {
    const scanner = this.scanners.get(sessionId);
    if (!scanner) return { cleaned: '', events: [] };

    const { cleaned } = scanner.flush();
    return { cleaned, events: [] };
  }

  private tagsToEvents(
    tags:      ParsedCharacterTag[],
    turnId:    string,
    sessionId: string,
  ): StageStreamEvent[] {
    const events: StageStreamEvent[] = [];

    for (const tag of tags) {
      switch (tag.kind) {
        case 'emotion': {
          if (!this.emotions.includes(tag.value)) break;
          events.push({
            type: 'emotion_changed',
            sessionId,
            turnId,
            emotion: tag.value,
          });
          break;
        }
        case 'motion': {
          if (!this.motions.includes(tag.value)) break;
          events.push({
            type: 'motion_changed',
            sessionId,
            turnId,
            motion: tag.value,
          });
          break;
        }
      }
    }

    return events;
  }
}
