import type { AgentLoopEvent } from './events.js';

/** 每次 Agent 运行一份. 正文由消息存储保存, 这里只维护模型历史位置对应的 SQL ID. */
export class ModelMessageIds {
  private readonly savedIds: (string | undefined)[];
  // 保存消息和 AgentLoop 追加历史不是同一步. 暂存已保存的 ID, 等追加事件到来后对齐.
  private readonly pendingIds: (string | undefined)[] = [];

  constructor(ids: readonly (string | undefined)[]) {
    this.savedIds = [...ids];
  }

  setInitialHistory(ids: readonly (string | undefined)[]): void {
    this.savedIds.splice(0, this.savedIds.length, ...ids);
    this.pendingIds.length = 0;
  }

  get values(): readonly (string | undefined)[] {
    return this.savedIds;
  }

  queueSavedMessages(ids: readonly (string | undefined)[]): void {
    this.pendingIds.push(...ids);
  }

  record(event: AgentLoopEvent, savedMessageId: string | undefined): void {
    if (event.type === 'assistant_message_completed') {
      // 截断但没有任何内容时, AgentLoop 不把空 Assistant 加入历史.
      if (event.stopReason !== 'max_tokens' || event.content.length > 0) {
        this.pendingIds.push(savedMessageId);
      }
    } else if (event.type === 'tool_result' || event.type === 'output_continuation') {
      this.pendingIds.push(savedMessageId);
    } else if (event.type === 'model_history_appended') {
      for (let index = 0; index < event.messages.length; index += 1) {
        this.savedIds.push(this.pendingIds.shift());
      }
    }
  }

  lastSavedIdInPrefix(messageCount: number): string | undefined {
    for (let index = messageCount - 1; index >= 0; index -= 1) {
      const id = this.savedIds[index];
      if (id !== undefined) return id;
    }
    return undefined;
  }

  replacePrefixWithSummary(messageCount: number, summaryId: string): void {
    this.savedIds.splice(0, messageCount, summaryId);
  }
}
