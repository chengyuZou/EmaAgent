// 两条 Memory 提取轨共享的 LLM 调用和空结果语义。
//
// 只负责"调用提取模型"这一件共享的事:固定 system + user 两段消息,
// 把空输出 / NO_MEMORY 统一成 undefined。投影、模板、闭包组合在各轨与
// extractTurn 中完成。

import type { Message } from '@ema-agent/llm';

/** Turn/Server 从已完成 Turn 投影给 Memory 的稳定事实。 */
export type MemoryTurnMessage =
  | { readonly kind: 'user_message'; readonly text: string }
  | { readonly kind: 'assistant_message'; readonly text: string }
  | {
      readonly kind: 'user_decision';
      readonly prompt: string;
      readonly answer: string;
    }
  | {
      readonly kind: 'tool_call';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: string;
    }
  | {
      readonly kind: 'tool_result';
      readonly toolCallId: string;
      readonly content: string;
      readonly isError: boolean;
    };

export interface CompletedTurnMemoryInput {
  readonly messages: readonly MemoryTurnMessage[];
  readonly workspaceRoot?: string;
  readonly characterDirectoryName?: string;
}

/** Prompt 明确返回该值时,本轮提取不产生待整合内容。 */
export const MEMORY_EXTRACTION_NO_RESULT = 'NO_MEMORY';

/** 应用层提供具体模型与连接;Memory 只决定本次提取要发送的消息。 */
export type CompleteExtraction = (
  messages: readonly Message[],
  signal?: AbortSignal,
) => Promise<string>;

/** 以固定 system + user 两段调用提取模型,并把空结果统一为 undefined。 */
export async function runTurnExtraction(
  systemInstructions: string,
  inputInstructions: string,
  turnFacts: string,
  complete: CompleteExtraction,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const output = await complete(
    [
      { role: 'system', content: systemInstructions.trim() },
      {
        role: 'user',
        content: `${inputInstructions.trim()}\n\n${turnFacts}`,
      },
    ],
    signal,
  );
  const content = output.trim();
  return content === '' || content === MEMORY_EXTRACTION_NO_RESULT
    ? undefined
    : content;
}
