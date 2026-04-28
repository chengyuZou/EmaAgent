/**
 * 全局 ID 品牌类型与辅助工具。
 *
 * 所有跨边界传递的标识符都使用 Brand 类型，防止 string 误用。
 * I/O 边界（API 解析、DB 读取）使用 asId 转换。
 */

export type Brand<T, B extends string> = T & { readonly __brand: B }

export type SessionId = Brand<string, "SessionId">
export type TurnId = Brand<string, "TurnId">
export type RequestId = Brand<string, "RequestId">
export type MessageId = Brand<string, "MessageId">
export type ArtifactId = Brand<string, "ArtifactId">
export type AttachmentId = Brand<string, "AttachmentId">
export type ProviderId = Brand<string, "ProviderId">
export type ModelId = Brand<string, "ModelId">
export type ToolCallId = Brand<string, "ToolCallId">
export type StepId = Brand<string, "StepId">
export type CredentialId = Brand<string, "CredentialId">

/** Unix 毫秒时间戳 */
export type UnixMs = number

/** ISO 8601 日期时间字符串 */
export type IsoDateTime = string

/**
 * 将纯 string 提升为品牌类型。
 * 仅应在 I/O 边界使用（JSON parse、DB 反序列化后）。
 * 
 * @example
 * const sid = asId<SessionId>("abc-123")
 */
export function asId<T extends Brand<string, string>>(value: string): T {
  return value as T
}