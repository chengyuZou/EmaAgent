// Branded ID types — zero-runtime cost wrappers
declare const _brand: unique symbol;
type Brand<T, B> = T & { readonly [_brand]: B };

export type SessionId    = Brand<string, 'SessionId'>;
export type TurnId       = Brand<string, 'TurnId'>;
export type MessageId    = Brand<string, 'MessageId'>;
export type CharacterCardId = Brand<string, 'CharacterCardId'>;
export type ArtifactId   = Brand<string, 'ArtifactId'>;
export type ModelId      = Brand<string, 'ModelId'>;   // DB FK only (model_bindings etc.)

export function asSessionId(s: string): SessionId       { return s as SessionId; }
export function asTurnId(s: string): TurnId             { return s as TurnId; }
export function asMessageId(s: string): MessageId       { return s as MessageId; }
export function asCharacterCardId(s: string): CharacterCardId { return s as CharacterCardId; }
export function asArtifactId(s: string): ArtifactId     { return s as ArtifactId; }
export function asModelId(s: string): ModelId           { return s as ModelId; }

export type TurnMode      = 'chat' | 'narrative' | 'agent';
export type AgentSubMode  = 'plan' | 'debug' | 'full';
export type TurnStatus    = 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
export type MessageRole   = 'system' | 'user' | 'assistant';
export type MessageKind   =
  | 'normal'            // ordinary chat or assistant turn
  | 'context'           // injected context (recall bundle, workspace snapshot)
  | 'tool_results'      // user-role message carrying ToolResultBlock[] — merges into agent bubble in UI
  | 'compact_boundary'  // marks the slice point; LLM sees only messages after the last boundary
  | 'summary'           // compaction output; replaces the summarised window in LLM context
  | 'persona_reminder'; // periodic user+assistant pair that re-anchors character voice
