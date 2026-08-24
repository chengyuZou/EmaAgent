// 事件驱动的流式落库：首个 delta 建 block、tool_use 先落库再执行、tool_result 落库再关账。
import type { AgentLoopEvent } from '@ema-agent/agent';
import type { AssistantBlock, LlmThinkingState } from '@ema-agent/llm';
import { createAssistantThinkingBlock } from '@ema-agent/llm';
import type { ToolResult } from '@ema-agent/tools';
import type {
  AppendMessageInput,
  SessionStore,
} from '@ema-agent/session';

type ToolUseBlock = Extract<AssistantBlock, { type: 'tool_use' }>;

type WriterSessions = Pick<
  SessionStore,
  'appendMessage' | 'updateMessageBlocks' | 'markMessageInterrupted'
>;

/**
 * 把一次根 AgentLoop 的事件流转成持久化事实。yield 恢复 = 已保存：
 * tool_use_completed 落库后 AgentLoop 才登记调用、assistant_message_completed 落库后
 * 才允许 executor.start()、tool_result 落库后才关执行状态——顺序就是崩溃正确性。
 */
export class TurnMessageWriter {
  private assistantMessageId: string | undefined;
  private textByIndex = new Map<number, string>();
  private thinkingByIndex = new Map<number, string>();
  private thinkingStates = new Map<number, LlmThinkingState>();
  private toolUseByIndex = new Map<number, ToolUseBlock>();
  /** 已落库但尚未等到 tool_result 的调用；Turn 终态时合成取消结果补配对。 */
  private readonly pendingToolUses = new Map<string, ToolUseBlock>();

  constructor(
    private readonly sessionId: string,
    private readonly turnId: string,
    private readonly sessions: WriterSessions,
  ) {}

  async apply(event: AgentLoopEvent): Promise<void> {
    switch (event.type) {
      case 'iteration_started':
        this.resetIteration();
        return;

      case 'text_delta':
        this.textByIndex.set(
          event.blockIndex,
          (this.textByIndex.get(event.blockIndex) ?? '') + event.delta,
        );
        await this.persistAssistant();
        return;

      case 'thinking_delta':
        this.thinkingByIndex.set(
          event.blockIndex,
          (this.thinkingByIndex.get(event.blockIndex) ?? '') + event.delta,
        );
        await this.persistAssistant();
        return;

      case 'thinking_completed':
        if (event.state !== undefined) {
          this.thinkingStates.set(event.blockIndex, event.state);
        }
        await this.persistAssistant();
        return;

      case 'tool_use_completed': {
        const block: ToolUseBlock = {
          type: 'tool_use',
          id: event.toolCallId,
          name: event.toolName,
          args: event.args,
        };
        this.toolUseByIndex.set(event.blockIndex, block);
        this.pendingToolUses.set(event.toolCallId, block);
        // 先落库，AgentLoop 恢复后才会 executor.addTool——副作用边界之前必有持久事实。
        await this.persistAssistant();
        return;
      }

      case 'assistant_message_completed':
        await this.persistAssistant();
        return;

      case 'assistant_message_discarded':
        if (this.assistantMessageId) {
          this.sessions.markMessageInterrupted(this.assistantMessageId);
        }
        return;

      case 'tool_result':
        this.pendingToolUses.delete(event.result.toolCallId);
        await this.append({
          turnId: this.turnId,
          sessionId: this.sessionId,
          role: 'user',
          kind: 'tool_results',
          blocks: [toToolResultBlock(event.result)],
        });
        return;

      default:
        return;
    }
  }

  /**
   * Turn 终态收口：非 completed 时把未完成的 assistant 标 interrupted；
   * 没有等到 tool_result 的 tool_use 合成取消结果补配对（下一轮 deriveLlmHistory
   * 的配对过滤器需要完整配对才重放）。
   */
  async finish(terminal: 'completed' | 'failed' | 'aborted'): Promise<void> {
    if (this.assistantMessageId && terminal !== 'completed') {
      this.sessions.markMessageInterrupted(this.assistantMessageId);
    }
    if (this.pendingToolUses.size === 0) return;

    const orphans = [...this.pendingToolUses.values()];
    this.pendingToolUses.clear();
    await this.append({
      turnId: this.turnId,
      sessionId: this.sessionId,
      role: 'user',
      kind: 'tool_results',
      blocks: orphans.map(use => ({
        type: 'tool_result' as const,
        toolCallId: use.id,
        content: '[Turn 中断，工具调用未产生结果]',
        isError: true,
        errorCode: 'tool/cancelled',
      })),
    });
  }

  private resetIteration(): void {
    this.assistantMessageId = undefined;
    this.textByIndex = new Map();
    this.thinkingByIndex = new Map();
    this.thinkingStates = new Map();
    this.toolUseByIndex = new Map();
  }

  private async persistAssistant(): Promise<void> {
    const blocks = this.currentBlocks();
    if (blocks.length === 0) return;
    if (!this.assistantMessageId) {
      const message = await this.append({
        turnId: this.turnId,
        sessionId: this.sessionId,
        role: 'assistant',
        blocks,
      });
      this.assistantMessageId = message.id;
      return;
    }
    this.sessions.updateMessageBlocks(this.assistantMessageId, blocks);
  }

  private async append(input: AppendMessageInput) {
    return this.sessions.appendMessage(input);
  }

  private currentBlocks(): AssistantBlock[] {
    const blocks = new Map<number, AssistantBlock>();
    for (const [index, text] of this.textByIndex) {
      if (text.trim()) blocks.set(index, { type: 'text', text });
    }
    const thinkingIndexes = new Set([
      ...this.thinkingByIndex.keys(),
      ...this.thinkingStates.keys(),
    ]);
    for (const index of thinkingIndexes) {
      const block = createAssistantThinkingBlock(
        this.thinkingByIndex.get(index),
        this.thinkingStates.get(index),
      );
      if (block) blocks.set(index, block);
    }
    for (const [index, toolUse] of this.toolUseByIndex) {
      blocks.set(index, toolUse);
    }
    return [...blocks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, block]) => block);
  }
}

function toToolResultBlock(result: ToolResult) {
  return {
    type: 'tool_result' as const,
    toolCallId: result.toolCallId,
    content: result.content,
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
    ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
  };
}
