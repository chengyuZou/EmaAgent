// 把已完成 Turn 的全部工作事实编码为 Work 提取输入。

import type { MemoryTurnMessage } from '../common/extraction.js';

export interface WorkExtractionInput {
  readonly workspaceRoot?: string;
  readonly messages: readonly MemoryTurnMessage[];
}

export function buildWorkExtractionInput(
  messages: readonly MemoryTurnMessage[],
  workspaceRoot?: string,
): WorkExtractionInput {
  return {
    ...(workspaceRoot ? { workspaceRoot } : {}),
    messages,
  };
}

/** JSON 只用于本次模型输入，不是持久化协议。 */
export function serializeWorkTurn(input: WorkExtractionInput): string {
  return JSON.stringify(input, null, 2);
}
