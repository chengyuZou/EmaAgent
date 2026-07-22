// Branded ID types — zero-runtime cost wrappers
declare const _brand: unique symbol;
type Brand<T, B> = T & { readonly [_brand]: B };

export type SessionId    = Brand<string, 'SessionId'>;
export type TurnId       = Brand<string, 'TurnId'>;
export type MessageId    = Brand<string, 'MessageId'>;
export type BranchId     = Brand<string, 'BranchId'>;
export type CharacterCardId = Brand<string, 'CharacterCardId'>;
export type CompactionId = Brand<string, 'CompactionId'>;
export type ToolCallId   = Brand<string, 'ToolCallId'>;
export type HookInvocationId = Brand<string, 'HookInvocationId'>;

export function asSessionId(s: string): SessionId       { return s as SessionId; }
export function asTurnId(s: string): TurnId             { return s as TurnId; }
export function asMessageId(s: string): MessageId       { return s as MessageId; }
export function asBranchId(s: string): BranchId         { return s as BranchId; }
export function asCharacterCardId(s: string): CharacterCardId { return s as CharacterCardId; }
export function asCompactionId(s: string): CompactionId { return s as CompactionId; }
export function asToolCallId(s: string): ToolCallId     { return s as ToolCallId; }
export function asHookInvocationId(s: string): HookInvocationId { return s as HookInvocationId; }


export type TurnMode      = 'chat' | 'narrative' | 'agent';
export type TurnStatus    = 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
