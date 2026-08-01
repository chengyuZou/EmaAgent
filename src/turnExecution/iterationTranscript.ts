// 按模型块索引保存一次迭代的文本、思考和工具调用，供流式展示与消息持久化共享。

import type { AssistantBlock } from '@ema-agent/llm';

type ToolUseBlock = Extract<AssistantBlock, { type: 'tool_use' }>;

export class IterationTranscript {
  private textByIndex = new Map<number, string>();
  private thinkingByIndex = new Map<number, string>();
  private thinkingSignatures = new Map<number, string>();
  private toolCallsByIndex = new Map<number, ToolUseBlock>();

  reset(): void {
    this.textByIndex = new Map();
    this.thinkingByIndex = new Map();
    this.thinkingSignatures = new Map();
    this.toolCallsByIndex = new Map();
  }

  appendText(blockIndex: number, delta: string): void {
    this.textByIndex.set(
      blockIndex,
      (this.textByIndex.get(blockIndex) ?? '') + delta,
    );
  }

  appendThinking(blockIndex: number, delta: string): void {
    this.thinkingByIndex.set(
      blockIndex,
      (this.thinkingByIndex.get(blockIndex) ?? '') + delta,
    );
  }

  setThinkingSignature(
    blockIndex: number,
    signature: string | undefined,
  ): void {
    if (signature) this.thinkingSignatures.set(blockIndex, signature);
  }

  setToolCall(blockIndex: number, block: ToolUseBlock): void {
    this.toolCallsByIndex.set(blockIndex, block);
  }

  firstTextBlockIndex(): number {
    if (this.textByIndex.size === 0) return 0;
    return Math.min(...this.textByIndex.keys());
  }

  fullText(): string {
    return [...this.textByIndex.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, text]) => text)
      .join('');
  }

  toolCalls(): readonly ToolUseBlock[] {
    return [...this.toolCallsByIndex.values()];
  }

  assistantBlocks(): AssistantBlock[] {
    const blocks = new Map<number, AssistantBlock>();
    for (const [index, text] of this.textByIndex) {
      blocks.set(index, { type: 'text', text });
    }
    for (const [index, thinking] of this.thinkingByIndex) {
      const signature = this.thinkingSignatures.get(index);
      blocks.set(index, {
        type: 'thinking',
        thinking,
        ...(signature ? { signature } : {}),
      });
    }
    for (const [index, toolCall] of this.toolCallsByIndex) {
      blocks.set(index, toolCall);
    }
    return [...blocks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, block]) => block);
  }
}
