/**
 * 全局品牌 ID 类型与时间戳别名。
 *
 * ## 为什么需要 Brand 类型
 *
 * SessionId / RequestId / MessageId 在运行时都是 string，
 * 但它们在语义上不可互换——把 RequestId 传给需要 SessionId 的函数
 * 应该被编译器拦截。Brand 类型利用 TypeScript 的结构化类型系统，
 * 通过一个虚构的 `__brand` 字段在编译期区分这些 string 变体。
 *
 * ## 使用规则
 *
 * - **构造**：只在 I/O 边界（JSON.parse、DB 反序列化、URL 参数解析）
 *   调用 `asId<T>(raw)` 将原始 string 提升为品牌类型。
 * - **传递**：内部函数签名始终使用品牌类型，禁止回退到 string。
 * - **比较**：两个不同品牌的 ID 不能直接 `===`，需显式转为 string。
 */

// ═══════════════════════════════════════════════════════════════
// 基础设施
// ═══════════════════════════════════════════════════════════════

/** 品牌类型构造器——在编译期为 T 附加唯一的 B 标签。 */
export type Brand<T, B extends string> = T & { readonly __brand: B }

/** Unix 毫秒时间戳。所有持久化和跨边界传输的时间统一使用此类型。 */
export type UnixMs = number

/** ISO 8601 格式的日期时间字符串，如 "2026-05-04T12:00:00.000Z"。 */
export type IsoDateTime = string

// ═══════════════════════════════════════════════════════════════
// 会话域
// ═══════════════════════════════════════════════════════════════

/** 会话全局唯一标识。一个 Session 包含多轮 Turn。 */
export type SessionId = Brand<string, "SessionId">

// ═══════════════════════════════════════════════════════════════
// Turn 域
// ═══════════════════════════════════════════════════════════════

/**
 * API 请求级标识——每次 POST /api/turns 生成一个。
 * 前端用此 ID 连接 SSE 流、重试、追踪完整生命周期。
 */
export type RequestId = Brand<string, "RequestId">

/** Turn 持久化记录标识。一个 Request 可能产生一个 Turn 记录。 */
export type TurnId = Brand<string, "TurnId">

// ═══════════════════════════════════════════════════════════════
// 消息域
// ═══════════════════════════════════════════════════════════════

/** 单条消息（user / assistant / system）的唯一标识。 */
export type MessageId = Brand<string, "MessageId">

// ═══════════════════════════════════════════════════════════════
// Agent 工具调用域
// ═══════════════════════════════════════════════════════════════

/** LLM 发起的单次工具调用标识——在一次 turn 内唯一。 */
export type ToolCallId = Brand<string, "ToolCallId">

/** ReAct think→act 循环中单个步骤的标识。 */
export type StepId = Brand<string, "StepId">

// ═══════════════════════════════════════════════════════════════
// 产物与附件域
// ═══════════════════════════════════════════════════════════════

/** Agent 产出的结构化产物标识。 */
export type ArtifactId = Brand<string, "ArtifactId">

/** 用户上传附件的标识。 */
export type AttachmentId = Brand<string, "AttachmentId">

// ═══════════════════════════════════════════════════════════════
// 模型与 Provider 域
// ═══════════════════════════════════════════════════════════════

/** LLM Provider 实例标识，如 "openai-main"、"anthropic-work"。 */
export type ProviderId = Brand<string, "ProviderId">

/** 模型标识，如 "gpt-4o"、"claude-sonnet-4-6"。 */
export type ModelId = Brand<string, "ModelId">

/** 密钥句柄——指向 Tauri Stronghold 或系统密钥链中的凭证，不存储明文。 */
export type CredentialId = Brand<string, "CredentialId">

// ═══════════════════════════════════════════════════════════════
// 记忆域
// ═══════════════════════════════════════════════════════════════

/** 持久化记忆事实的标识。 */
export type MemoryFactId = Brand<string, "MemoryFactId">

// ═══════════════════════════════════════════════════════════════
// 工厂函数
// ═══════════════════════════════════════════════════════════════

/**
 * 将原始 string 安全提升为品牌 ID 类型。
 *
 * ## 为什么用类型断言而非运行时校验
 *
 * Brand 类型是编译期概念——它的唯一目的是让 TypeScript 在编译时
 * 区分不同语义的 string。运行时它们就是普通字符串，不需要额外装箱。
 * 加运行时校验（如 UUID 正则）会增加零收益的性能开销，
 * 且违背了 Brand 类型"零运行时成本"的设计初衷。
 *
 * ## 调用时机
 *
 * - JSON.parse 反序列化后：`asId<SessionId>(raw.id)`
 * - URL 参数解析后：`asId<RequestId>(req.params.requestId)`
 * - DB 查询结果映射时：`asId<MessageId>(row.id)`
 *
 * ## 反模式
 *
 * ```ts
 * // ❌ 不要在业务逻辑中间随意转型
 * const sid = asId<SessionId>(someString) // 丢失了类型安全的意义
 *
 * // ✅ 只在 I/O 边界使用
 * function parseSession(raw: unknown): SessionState {
 *   const obj = raw as Record<string, string>
 *   return { id: asId<SessionId>(obj.id), ... }
 * }
 * ```
 */
export function asId<T extends Brand<string, string>>(value: string): T {
  return value as T
}
