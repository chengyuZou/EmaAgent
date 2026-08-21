// 从已完成 Turn 中只保留用户与角色的对话文本，构造 Relationship 提取输入。

import type { MemoryTurnMessage } from '../common/extraction.js';

export type RelationshipTurnMessage = Extract<
  MemoryTurnMessage,
  { kind: 'user_message' | 'assistant_message' | 'user_decision' }
>;

export interface RelationshipExtractionInput {
  readonly characterDirectoryName: string;
  readonly messages: readonly RelationshipTurnMessage[];
}

export function buildRelationshipExtractionInput(
  messages: readonly MemoryTurnMessage[],
  characterDirectoryName: string,
): RelationshipExtractionInput {
  return {
    characterDirectoryName,
    messages: messages.filter(
      (message): message is RelationshipTurnMessage =>
        message.kind === 'user_message'
        || message.kind === 'assistant_message'
        || message.kind === 'user_decision',
    ),
  };
}

/** JSON 只用于本次模型输入，不是持久化协议。 */
export function serializeRelationshipTurn(
  input: RelationshipExtractionInput,
): string {
  return JSON.stringify(input, null, 2);
}
