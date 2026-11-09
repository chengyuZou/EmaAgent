import { StreamingCharacterTagScanner } from './parser.js';
import type { StageTextPart } from './types.js';

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
  private readonly scannersBySessionId = new Map<string, StreamingCharacterTagScanner>();

  constructor(vocabulary: StageEngineOptions) {
    this.emotions = vocabulary.emotions;
    this.motions = vocabulary.motions;
  }

  /** 当前激活角色改变后, 替换允许使用的情绪与动作词汇. */
  updateVocabulary(emotions: readonly string[], motions: readonly string[]): void {
    this.emotions = emotions;
    this.motions = motions;
  }

  /** 新 Turn 使用新的扫描器, 防止上一轮未闭合的标签尾部进入下一轮. */
  beginTurn(sessionId: string): void {
    this.scannersBySessionId.set(sessionId, new StreamingCharacterTagScanner());
  }

  /** 切换共享角色时丢弃全部未闭合标签, 新 Turn 会建立新的扫描器. */
  reset(): void {
    this.scannersBySessionId.clear();
  }

  /** Session 删除后丢弃它尚未闭合的标签尾部. */
  evictSession(sessionId: string): void {
    this.scannersBySessionId.delete(sessionId);
  }

  processChunk(delta: string, sessionId: string): StageTextPart[] {
    const scanner = this.scannersBySessionId.get(sessionId);
    if (!scanner) return delta ? [{ text: delta, tags: null }] : [];
    return scanner.scan(delta).map(part => {
      const tags = part.tags?.filter(tag => tag.type === 'emotion'
        ? this.emotions.includes(tag.emotion)
        : this.motions.includes(tag.motion));
      // 未声明的完整标签仍从正文移除, 不触发语音分段或角色动作.
      return { text: part.text, tags: tags?.length ? tags : null };
    }).filter(part => part.text !== null || part.tags !== null);
  }

  /** 未闭合尾部按普通正文交出, 不当作角色标签执行. */
  flush(sessionId: string): string {
    return this.scannersBySessionId.get(sessionId)?.flush() ?? '';
  }
}
