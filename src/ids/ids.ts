// 提供跨业务边界稳定共享的品牌 ID，防止不同实体的字符串身份互相冒充。
declare const idBrand: unique symbol;
type BrandedId<Name extends string> = string & { readonly [idBrand]: Name };

export type SessionId = BrandedId<'SessionId'>;
export type TurnId = BrandedId<'TurnId'>;
export type AgentRunId = BrandedId<'AgentRunId'>;
export type TaskId = BrandedId<'TaskId'>;
export type MessageId = BrandedId<'MessageId'>;
export type CharacterCardId = BrandedId<'CharacterCardId'>;
export type CharacterLive2dId = BrandedId<'CharacterLive2dId'>;
export type CharacterPortraitId = BrandedId<'CharacterPortraitId'>;
export type CharacterVoiceReferenceId = BrandedId<'CharacterVoiceReferenceId'>;
export type CompactId = BrandedId<'CompactId'>;
export type ToolCallId = BrandedId<'ToolCallId'>;
export type HookInvocationId = BrandedId<'HookInvocationId'>;
export type BackgroundProcessId = BrandedId<'BackgroundProcessId'>;

export function asSessionId(value: string): SessionId { return value as SessionId; }
export function asTurnId(value: string): TurnId { return value as TurnId; }
export function asAgentRunId(value: string): AgentRunId { return value as AgentRunId; }
export function asTaskId(value: string): TaskId { return value as TaskId; }
export function asMessageId(value: string): MessageId { return value as MessageId; }
export function asCharacterCardId(value: string): CharacterCardId { return value as CharacterCardId; }
export function asCharacterLive2dId(value: string): CharacterLive2dId {
  return value as CharacterLive2dId;
}
export function asCharacterPortraitId(value: string): CharacterPortraitId {
  return value as CharacterPortraitId;
}
export function asCharacterVoiceReferenceId(value: string): CharacterVoiceReferenceId {
  return value as CharacterVoiceReferenceId;
}
export function asCompactId(value: string): CompactId { return value as CompactId; }
export function asToolCallId(value: string): ToolCallId { return value as ToolCallId; }
export function asHookInvocationId(value: string): HookInvocationId { return value as HookInvocationId; }
export function asBackgroundProcessId(value: string): BackgroundProcessId {
  return value as BackgroundProcessId;
}
