// 固定父请求的消息与 ID, 真实 fork 领取后才构建父前缀; 不负责写子代理消息表.
import type { ForkParentMessage, ForkParentMessages } from '@ema-agent/agent';
import type { LlmGenerationSource, Message } from '@ema-agent/llm';
import type { MessageBlocks, SessionStore } from '@ema-agent/session';
import type { ToolResult } from '@ema-agent/tools';

/** 父 Assistant 完整落库后的身份. 领取者据此读取正文, 空回复没有 Message ID. */
interface CompletedAssistant {
  readonly messageId: string | undefined;
  readonly generatedBy: LlmGenerationSource;
}

/** 每根 Turn 一份. read 绑定调用所属请求, 兄弟 fork 共用一次父前缀构建. */
export function createForkParentMessages(sessions: Pick<SessionStore, 'getMessage'>) {
  let readCurrentRequest: () => Promise<ForkParentMessages>;
  let resolveAssistant: ((assistant: CompletedAssistant) => void) | undefined;
  let rejectAssistant: ((reason: unknown) => void) | undefined;

  function beginRequest(messages: readonly Message[], messageIds: readonly (string | undefined)[]): void {
    // 后续历史追加和 Macro 会改写原数组. 固定本次消息与 ID 的对应关系, 此时不回查 SQL.
    const requestMessages = [...messages];
    const requestMessageIds = [...messageIds];
    const assistantReady = new Promise<CompletedAssistant>((resolve, reject) => {
      resolveAssistant = resolve;
      rejectAssistant = reject;
    });
    // 未派发 fork 的父请求也可能失败. 保留拒绝给领取者, 不产生无人观察的拒绝.
    void assistantReady.catch(() => undefined);

    // 缓存只属于这次父请求. 下一次 beginRequest 不改变旧领取者持有的 Promise.
    let parentMessagesReady: Promise<ForkParentMessages> | undefined;
    readCurrentRequest = () => {
      if (!parentMessagesReady) {
        parentMessagesReady = assistantReady.then(assistant =>
          buildParentMessages(requestMessages, requestMessageIds, assistant));
      }
      return parentMessagesReady;
    };
  }

  function read(signal: AbortSignal): Promise<ForkParentMessages> {
    signal.throwIfAborted();
    // 真正领取才安排 SQL 构建, 且必须在等待前绑定当前请求.
    const current = readCurrentRequest();
    return new Promise<ForkParentMessages>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      current.then(
        messages => {
          signal.removeEventListener('abort', onAbort);
          resolve(messages);
        },
        error => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  function completeAssistant(messageId: string | undefined, generatedBy: LlmGenerationSource): void {
    // writer 已保存完整父 Assistant. 这里只交付身份, 没有 fork 时不读取正文.
    resolveAssistant?.({ messageId, generatedBy });
  }

  function fail(reason: unknown): void {
    rejectAssistant?.(reason);
  }

  function buildParentMessages(
    messages: readonly Message[],
    messageIds: readonly (string | undefined)[],
    completed: CompletedAssistant,
  ): ForkParentMessages {
    const parentMessages = messages.flatMap((message, index): ForkParentMessage[] => {
      if (message.role === 'system') return [];
      const id = messageIds[index];
      const persisted = id ? sessions.getMessage(id) : undefined;
      let blocks: MessageBlocks;
      if (persisted) {
        blocks = persisted.blocks;
        if (message.role === 'user' && Array.isArray(message.content)
          && persisted.kind === 'tool_results' && Array.isArray(persisted.blocks)) {
          // Micro 只改模型可见的工具结果正文. fork 保留本次已压短的正文,
          // 同时保留 SQL 信封里的 data/耗时等字段, 不恢复压缩前的大段输出.
          const results = new Map(message.content.flatMap(block =>
            block.type === 'tool_result' ? [[block.toolCallId, block] as const] : []));
          blocks = (persisted.blocks as ToolResult[]).map(block => {
            const result = results.get(block.toolCallId);
            if (!result) return block;
            return { ...block, content: typeof result.content === 'string'
              ? result.content : [...result.content] };
          });
        }
      } else if (message.role === 'assistant') {
        blocks = [...message.content];
      } else {
        // 未入库的 User 消息只来自循环的纯文本引导, 附件和工具结果已有 SQL 行.
        blocks = message.content as string;
      }
      // 模型专用引导没有 SQL 行, 但仍属于此次 fork 的固定前缀.
      return [{
        id: persisted?.id ?? crypto.randomUUID(), role: message.role,
        kind: persisted?.kind ?? 'continuation',
        blocks,
        interrupted: persisted?.interrupted ?? false,
        createdAt: persisted?.createdAt ?? Date.now(),
        summarizedThroughMessageId: persisted?.summarizedThroughMessageId ?? null,
        ...(persisted?.savedTokens !== undefined ? { savedTokens: persisted.savedTokens } : {}),
        ...(message.role === 'assistant' && message.generatedBy ? { generatedBy: message.generatedBy } : {}),
      }];
    });
    const assistant: ForkParentMessage[] = completed.messageId ? [{
      ...sessions.getMessage(completed.messageId),
      generatedBy: completed.generatedBy,
    }] : [];
    return { messages: [...parentMessages, ...assistant] };
  }

  return { beginRequest, read, completeAssistant, fail };
}
