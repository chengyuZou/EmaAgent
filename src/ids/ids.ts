// 提供跨业务边界稳定共享的品牌 ID，防止不同实体的字符串身份互相冒充。
declare const idBrand: unique symbol;
type BrandedId<Name extends string> = string & { readonly [idBrand]: Name };

export type SessionId = BrandedId<'SessionId'>;
export type TurnId = BrandedId<'TurnId'>;
export type MessageId = BrandedId<'MessageId'>;
export type BranchId = BrandedId<'BranchId'>;
export type CharacterCardId = BrandedId<'CharacterCardId'>;
export type CompactionId = BrandedId<'CompactionId'>;
export type ToolCallId = BrandedId<'ToolCallId'>;
export type HookInvocationId = BrandedId<'HookInvocationId'>;

export function asSessionId(value: string): SessionId { return value as SessionId; }
export function asTurnId(value: string): TurnId { return value as TurnId; }
export function asMessageId(value: string): MessageId { return value as MessageId; }
export function asBranchId(value: string): BranchId { return value as BranchId; }
export function asCharacterCardId(value: string): CharacterCardId { return value as CharacterCardId; }
export function asCompactionId(value: string): CompactionId { return value as CompactionId; }
export function asToolCallId(value: string): ToolCallId { return value as ToolCallId; }
export function asHookInvocationId(value: string): HookInvocationId { return value as HookInvocationId; }
