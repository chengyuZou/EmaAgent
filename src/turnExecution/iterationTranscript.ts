// 按模型块索引保存一次迭代的文本、思考和工具调用，供流式展示与消息持久化共享。

import type { AssistantBlock } from '@ema-agent/llm';

type ToolUseBlock = Extract<AssistantBlock, { type: 'tool_use' }>;

export class IterationTranscript {
  private committedSegments: AssistantBlock[][] = [];
  private textByIndex = new Map<number, string>();
  private thinkingByIndex = new Map<number, string>();
  private thinkingSignatures = new Map<number, string>();
  private toolCallsByIndex = new Map<number, ToolUseBlock>();

  /** 开始一次模型调用；输出续写会封存上一段，普通工具迭代会开始全新记录。 */
  beginIteration(continuesOutput: boolean): void {
    if (continuesOutput) {
      const segment = this.currentBlocks();
      if (segment.length > 0) this.committedSegments.push(segment);
    } else {
      this.committedSegments = [];
    }

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
    return mergeAdjacentTextBlocks([
      ...this.committedSegments.flat(),
      ...this.currentBlocks(),
    ]);
  }

  private currentBlocks(): AssistantBlock[] {
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

/** 不同 LLM 调用会重新编号 blockIndex，因此只在分段完成后合并相邻文本。 */
function mergeAdjacentTextBlocks(
  blocks: readonly AssistantBlock[],
): AssistantBlock[] {
  const merged: AssistantBlock[] = [];
  for (const block of blocks) {
    const previous = merged.at(-1);
    if (previous?.type === 'text' && block.type === 'text') {
      previous.text += block.text;
      continue;
    }
    merged.push({ ...block });
  }
  return merged;
}
