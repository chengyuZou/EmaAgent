# EmaAgent Core Types 技术文档

> 本文档根据 `core-type` 目录下的 TypeScript 类型定义整理，目标是说明每个类型、接口、联合类型在业务系统中的职责、字段含义、使用场景以及与其他模块的关系。  
> 该类型系统整体服务于 EmaAgent V1 的前后端通信、会话管理、Turn 执行、LLM 适配、记忆召回、工具调用、Workspace 产物、渲染协议与错误协议。

---

## 1. 总体架构概览

EmaAgent V1 的核心类型可以按业务职责分为以下几组：

| 模块 | 文件 | 核心职责 |
|---|---|---|
| 模式与执行策略 | `modes.ts` | 定义 chat / agent / narrative 三种 turn 执行模式 |
| 会话与消息 | `session.ts` | 定义会话状态、消息结构、工具调用、会话仓储接口 |
| 单轮执行 | `turns.ts` | 定义 turn 请求、响应、状态、步骤、用量、产物记录 |
| 运行时输入 | `runtime-input.ts` | 保证原始用户输入和组装 prompt 强隔离 |
| 模型与 LLM | `model.ts` | 定义 Provider、Model、LLM 请求、流式输出、工具声明 |
| 记忆与召回 | `memory.ts` | 定义四层记忆模型、召回结果、工作记忆、用户画像、视觉记忆 |
| 流式事件 | `events.ts` | 定义前后端 SSE / NDJSON 事件协议 |
| 渲染协议 | `response-markup.ts` | 定义 Markdown、代码、公式、图像、表格等渲染块 |
| Workspace 产物 | `artifacts.ts` | 定义文件、diff、patch、图表、报告等产物协议 |
| 错误协议 | `errors.ts` | 定义前端可理解的统一错误结构 |
| 元数据 | `metadata.ts` | 定义单轮 trace、usage、recall、安全、Live2D 元信息 |
| 统一导出 | `index.ts` | 统一 re-export 所有核心类型 |

整体执行链可以抽象为：

```text
用户输入
  ↓
StartTurnRequest
  ↓
RuntimeInputEnvelope
  ↓
Memory Recall / Context Assembly
  ↓
ChatCompletionRequest
  ↓
EmaStreamEvent 持续推送
  ↓
ChatMessage / TurnRecord / ArtifactSummary 持久化
  ↓
前端渲染 RenderBlock / Workspace / StepTimeline / ContextRadar
```

其中最关键的设计约束有三个：

1. **session 不绑定固定模式**  
   `session` 只负责承载连续上下文；每一轮 `turn` 自己决定使用 `chat`、`agent` 或 `narrative` 模式。

2. **raw query 与 assembled prompt 强隔离**  
   用户原始输入必须原样写入历史；包含召回片段、附件、系统注入的 assembled prompt 只能用于本轮模型推理，不能写入用户消息历史。

3. **所有前后端边界协议结构化**  
   错误、工具调用、权限请求、上下文快照、渲染块、产物、diff 都使用稳定类型，避免前端依赖后端内部异常类或临时字符串协议。

---

# 2. `modes.ts`：执行模式协议

该文件定义 EmaAgent V1 的三种执行模式。这里的 `mode` 是 **每一轮 turn 的执行策略**，不是 session 的固定类型。

---

## 2.1 `EmaMode`

```ts
export type EmaMode = "chat" | "agent" | "narrative";
```

### 业务含义

表示用户当前这一轮请求希望走哪条执行链。

| 值 | 含义 | 典型场景 |
|---|---|---|
| `chat` | 普通对话模式 | 问答、闲聊、解释概念、普通助手 |
| `agent` | 工具增强 Agent 模式 | 需要读写文件、执行工具、生成 artifact、修改代码 |
| `narrative` | 叙事 / 角色 / 世界观模式 | Role-play、剧情记忆、角色世界线召回 |

### 设计重点

同一个 `session` 可以连续提交不同模式的 `turn`。例如：

```text
第 1 轮：chat       普通问答
第 2 轮：agent      让系统修改文件
第 3 轮：narrative  进入角色扮演
第 4 轮：chat       继续普通解释
```

所以不要把 `mode` 理解为“会话类型”。

---

## 2.2 `EMA_MODES`

```ts
export const EMA_MODES = ["chat", "agent", "narrative"] as const;
```

### 业务含义

合法模式枚举数组，供 UI 选择器、运行时校验、表单选项复用。

### 使用场景

- 前端模式下拉框
- 后端校验 mode 是否合法
- 单元测试中遍历所有 mode
- 默认模式初始化

---

## 2.3 `isEmaMode(value: string)`

```ts
export function isEmaMode(value: string): value is EmaMode
```

### 业务含义

运行时类型守卫，用于判断一个未知字符串是不是合法的 `EmaMode`。

### 字段 / 参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `value` | `string` | 外部传入的字符串，例如 URL query、localStorage、API body |

### 返回值

如果 `value` 是 `"chat" | "agent" | "narrative"` 之一，则返回 `true`，并在 TypeScript 中收窄为 `EmaMode`。

---

## 2.4 `ModeSelectionState`

```ts
export interface ModeSelectionState {
  current: EmaMode;
  lastUsed: EmaMode;
  source: "session_default" | "user_selected" | "retry_inherited";
}
```

### 业务含义

描述当前会话输入区的模式选择状态。

它不是后端核心运行记录，而是偏前端状态，用来说明用户当前输入框准备以什么模式提交，以及这个模式是怎么来的。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `current` | `EmaMode` | 当前输入框准备使用的执行模式 |
| `lastUsed` | `EmaMode` | 当前 session 上一次成功提交 turn 使用的模式，用于恢复默认值 |
| `source` | `"session_default" | "user_selected" | "retry_inherited"` | 当前模式选择来源 |

### `source` 取值说明

| 值 | 含义 |
|---|---|
| `session_default` | 根据 session 的默认值或上一次模式恢复 |
| `user_selected` | 用户手动切换了模式 |
| `retry_inherited` | 重试某一轮时继承原 turn 的模式 |

---

# 3. `session.ts`：会话与消息协议

`session.ts` 定义 EmaAgent 的会话持久结构。  
V1 中 `session` 只负责承载连续上下文，不绑定固定执行模式；每一轮实际使用哪种模式由 `turn.mode` 决定。

---

## 3.1 `MessageRole`

```ts
export type MessageRole = "user" | "assistant" | "system" | "tool";
```

### 业务含义

表示一条会话消息的角色来源。

| 值 | 含义 |
|---|---|
| `user` | 用户输入 |
| `assistant` | 模型 / Agent 回复 |
| `system` | 系统注入信息，一般不直接暴露给用户 |
| `tool` | 工具执行结果消息 |

---

## 3.2 `MessageContentBlock`

```ts
export type MessageContentBlock =
  | { type: "text"; text: string }
  | { type: "render_ref"; blockId: string }
  | { type: "artifact_ref"; artifactId: string }
  | { type: "tool_result_ref"; toolCallId: string };
```

### 业务含义

结构化消息正文块。  
它的作用是避免所有内容都塞进一个纯文本 `content` 字段，为附件、渲染块、artifact、工具结果预留可扩展空间。

### 联合类型说明

| 类型 | 字段 | 说明 |
|---|---|---|
| `text` | `text` | 普通文本内容 |
| `render_ref` | `blockId` | 指向一个前端渲染块，例如代码块、公式块、表格 |
| `artifact_ref` | `artifactId` | 指向 Workspace 中的产物，例如文件、图表、报告 |
| `tool_result_ref` | `toolCallId` | 指向某次工具调用的结果 |

---

## 3.3 `ChatMessage`

```ts
export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  contentBlocks?: MessageContentBlock[];
  requestId?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  createdAt: number;
}
```

### 业务含义

统一消息结构，所有交互历史落盘时都使用该类型。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 消息唯一 ID |
| `role` | `MessageRole` | 消息角色 |
| `content` | `string` | 兼容旧代码的纯文本正文 |
| `contentBlocks` | `MessageContentBlock[]` | 新版结构化正文块 |
| `requestId` | `string` | 关联的 turn 请求 ID |
| `toolCallId` | `string` | 如果该消息是工具结果，则关联工具调用 ID |
| `toolCalls` | `ToolCall[]` | assistant 消息中可能携带的工具调用请求 |
| `createdAt` | `number` | 创建时间戳 |

### 设计建议

新代码应该同时写入：

```ts
content: "纯文本回退内容",
contentBlocks: [{ type: "text", text: "结构化内容" }]
```

这样旧 UI 可以继续显示 `content`，新 UI 可以走 `contentBlocks`。

---

## 3.4 `ToolCall`

```ts
export interface ToolCall {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
}
```

### 业务含义

表示模型或 Agent 请求执行某个工具。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 工具调用 ID |
| `toolName` | `string` | 目标工具名称 |
| `arguments` | `Record<string, unknown>` | 工具调用参数，结构化 JSON |

---

## 3.5 `ToolResult`

```ts
export interface ToolResult {
  toolCallId: string;
  toolName: string;
  success: boolean;
  content: string;
  error?: string;
  durationMs: number;
}
```

### 业务含义

表示某次工具调用的执行结果。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `toolCallId` | `string` | 对应 `ToolCall.id` |
| `toolName` | `string` | 工具名称 |
| `success` | `boolean` | 工具是否执行成功 |
| `content` | `string` | 工具执行结果内容 |
| `error` | `string` | 失败时的错误信息 |
| `durationMs` | `number` | 工具执行耗时，单位毫秒 |

---

## 3.6 `SessionTitleStatus`

```ts
export type SessionTitleStatus =
  | "default"
  | "pending"
  | "generated"
  | "fallback"
  | "manual"
  | "failed";
```

### 业务含义

描述会话标题的生成状态。

| 值 | 含义 |
|---|---|
| `default` | 默认标题，还未生成 |
| `pending` | 正在生成标题 |
| `generated` | 模型成功生成标题 |
| `fallback` | 使用兜底标题 |
| `manual` | 用户手动修改标题 |
| `failed` | 标题生成失败 |

---

## 3.7 `SessionState`

```ts
export interface SessionState {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  fullAccess: boolean;
  activeSkills: string[];
  titleStatus: SessionTitleStatus;
  titleUpdatedAt?: number;
  modeLast: EmaMode;
  mode?: EmaMode;
}
```

### 业务含义

会话的完整持久状态。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 会话 ID |
| `title` | `string` | 会话标题，可自动生成 |
| `messages` | `ChatMessage[]` | 会话消息列表 |
| `createdAt` | `number` | 创建时间戳 |
| `updatedAt` | `number` | 最后更新时间戳 |
| `fullAccess` | `boolean` | 当前会话是否启用全权限 |
| `activeSkills` | `string[]` | 当前会话已注入的 skill ID |
| `titleStatus` | `SessionTitleStatus` | 标题状态 |
| `titleUpdatedAt` | `number` | 标题最后更新时间 |
| `modeLast` | `EmaMode` | 上一次成功提交 turn 使用的模式 |
| `mode` | `EmaMode` | 兼容旧代码的别名，不应被当作 session 固定类型 |

### 重要约束

`mode` 字段仅用于兼容旧代码。  
新代码应该使用：

```ts
session.modeLast
turn.mode
```

而不是把 `session.mode` 当成固定会话类型。

---

## 3.8 `SessionSummary`

```ts
export interface SessionSummary {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: number;
  modeLast: EmaMode;
}
```

### 业务含义

会话列表展示用的轻量摘要，避免加载完整消息历史。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 会话 ID |
| `title` | `string` | 会话标题 |
| `messageCount` | `number` | 消息数量 |
| `updatedAt` | `number` | 最近更新时间 |
| `modeLast` | `EmaMode` | 用于恢复列表中的模式选择器默认值 |

---

## 3.9 `ToolCallMeta`

```ts
export interface ToolCallMeta {
  requestId: string;
  toolCallId: string;
  toolName: string;
  status: "pending" | "executing" | "success" | "error" | "denied";
  durationMs?: number;
  errorCode?: string;
}
```

### 业务含义

工具调用元数据，用于 metadata 流、调试面板、审计记录。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `requestId` | `string` | 所属 turn 请求 ID |
| `toolCallId` | `string` | 工具调用 ID |
| `toolName` | `string` | 工具名称 |
| `status` | 联合字面量 | 工具调用状态 |
| `durationMs` | `number` | 执行耗时 |
| `errorCode` | `string` | 错误码 |

---

## 3.10 `ToolConfirmPayload`

```ts
export interface ToolConfirmPayload {
  requestId: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  riskLevel: "low" | "medium" | "high";
  timeoutMs: number;
}
```

### 业务含义

工具权限确认弹窗载荷。  
当 Agent 想执行高风险工具时，前端可以根据该结构弹出确认框。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `requestId` | `string` | 所属 turn 请求 ID |
| `toolCallId` | `string` | 工具调用 ID |
| `toolName` | `string` | 工具名称 |
| `arguments` | `Record<string, unknown>` | 工具参数 |
| `riskLevel` | `"low" | "medium" | "high"` | 风险等级 |
| `timeoutMs` | `number` | 权限确认超时时间 |

---

## 3.11 `SessionRepository`

```ts
export interface SessionRepository {
  getById(sessionId: string): Promise<SessionState | null>;
  save(session: SessionState): Promise<void>;
  list(): Promise<SessionSummary[]>;
  delete(sessionId: string): Promise<void>;
}
```

### 业务含义

会话仓储接口，由具体存储模块实现，例如 `storage-sql`。  
`session-runtime` 只依赖这个接口，不关心底层是 SQLite、IndexedDB、文件还是远程 DB。

### 方法说明

| 方法 | 说明 |
|---|---|
| `getById` | 根据 sessionId 获取完整会话 |
| `save` | 保存或更新会话 |
| `list` | 获取会话摘要列表 |
| `delete` | 删除会话 |

---

## 3.12 `ShouldGenerateTitleRequest`

```ts
export interface ShouldGenerateTitleRequest {
  session: SessionState;
}
```

### 业务含义

判断当前会话是否需要生成标题的请求体。

典型逻辑：

- 标题仍是默认标题
- 消息数量达到阈值
- 当前没有正在生成标题
- 用户没有手动设置标题

---

## 3.13 `GenerateSessionTitleRequest`

```ts
export interface GenerateSessionTitleRequest {
  session: SessionState;
}
```

### 业务含义

请求模型根据会话内容生成标题。

---

## 3.14 `SessionTitleResult`

```ts
export interface SessionTitleResult {
  title: string;
  status: SessionTitleStatus;
}
```

### 业务含义

会话标题生成结果。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `title` | `string` | 生成或兜底得到的标题 |
| `status` | `SessionTitleStatus` | 标题生成状态 |

---

# 4. `turns.ts`：单轮执行协议

`turn` 是 EmaAgent V1 的主执行单位。  
`session` 负责承载上下文；`turn` 负责记录本轮使用的 mode、模型、步骤、产物和用量。

---

## 4.1 `TurnInputBlock`

```ts
export type TurnInputBlock =
  | { type: "text"; text: string }
  | { type: "image_ref"; attachmentId: string }
  | { type: "file_ref"; attachmentId: string };
```

### 业务含义

一轮请求中的输入块。  
支持文本、图片引用、文件引用混合输入。

### 联合类型说明

| 类型 | 字段 | 说明 |
|---|---|---|
| `text` | `text` | 用户输入文本 |
| `image_ref` | `attachmentId` | 引用一个已上传图片附件 |
| `file_ref` | `attachmentId` | 引用一个已上传文件附件 |

---

## 4.2 `StartTurnRequest`

```ts
export interface StartTurnRequest {
  sessionId: string;
  mode: EmaMode;
  input: TurnInputBlock[];
  rawUserQuery?: string;
  attachments?: string[];
  modelOverrides?: Partial<{
    chatModelId: string;
    agentModelId: string;
    narrativeModelId: string;
    titleModelId: string;
  }>;
  client?: {
    locale?: string;
    timezone?: string;
    supportsMermaid?: boolean;
    supportsLatex?: boolean;
  };
}
```

### 业务含义

发起一轮 turn 的 API 请求体。  
前端提交消息时，最终应该转换成这个结构。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `sessionId` | `string` | 所属会话 ID |
| `mode` | `EmaMode` | 本轮执行模式，不代表 session 类型 |
| `input` | `TurnInputBlock[]` | 本轮输入块，可混合文本和附件引用 |
| `rawUserQuery` | `string` | 兼容旧前端的单文本入口 |
| `attachments` | `string[]` | 参与本轮上下文构建的附件 ID |
| `modelOverrides` | `Partial<{...}>` | 本轮临时模型覆盖，不写入全局绑定 |
| `client` | `{...}` | 客户端区域与能力信息 |

### `modelOverrides` 字段说明

| 字段 | 说明 |
|---|---|
| `chatModelId` | 本轮 chat 模式临时使用的模型 |
| `agentModelId` | 本轮 agent 模式临时使用的模型 |
| `narrativeModelId` | 本轮 narrative 模式临时使用的模型 |
| `titleModelId` | 本轮标题生成临时使用的模型 |

### `client` 字段说明

| 字段 | 说明 |
|---|---|
| `locale` | 客户端语言区域，例如 `zh-CN` |
| `timezone` | 客户端时区，例如 `Asia/Shanghai` |
| `supportsMermaid` | 前端是否支持 Mermaid 图渲染 |
| `supportsLatex` | 前端是否支持 LaTeX 渲染 |

---

## 4.3 `StartTurnResponse`

```ts
export interface StartTurnResponse {
  requestId: string;
  sessionId: string;
  acceptedAt: number;
  streamUrl: string;
}
```

### 业务含义

后端接受 turn 请求后返回的响应。  
真正的执行结果通常通过 `streamUrl` 对应的 SSE / NDJSON 流持续推送。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `requestId` | `string` | 本轮请求 ID |
| `sessionId` | `string` | 所属会话 ID |
| `acceptedAt` | `number` | 后端接受请求时间戳 |
| `streamUrl` | `string` | 前端订阅流式事件的 URL |

---

## 4.4 `TurnStatus`

```ts
export type TurnStatus =
  | "queued"
  | "running"
  | "waiting_permission"
  | "completed"
  | "failed"
  | "cancelled";
```

### 业务含义

turn 的持久化状态。

| 状态 | 含义 |
|---|---|
| `queued` | 已进入队列，尚未开始执行 |
| `running` | 正在执行 |
| `waiting_permission` | 等待用户批准工具权限 |
| `completed` | 成功完成 |
| `failed` | 执行失败 |
| `cancelled` | 被用户或系统取消 |

---

## 4.5 `StepStatus`

```ts
export type StepStatus =
  | "pending"
  | "running"
  | "waiting_permission"
  | "completed"
  | "failed"
  | "skipped";
```

### 业务含义

StepTimelinePane 中每个步骤的状态。

| 状态 | 含义 |
|---|---|
| `pending` | 等待开始 |
| `running` | 正在执行 |
| `waiting_permission` | 等待权限确认 |
| `completed` | 已完成 |
| `failed` | 已失败 |
| `skipped` | 被跳过 |

---

## 4.6 `StepView`

```ts
export interface StepView {
  id: string;
  requestId: string;
  type: "context" | "thinking" | "tool" | "diff" | "artifact" | "response" | "narrative_recall";
  status: StepStatus;
  title: string;
  detail?: string;
  startedAt?: number;
  endedAt?: number;
  artifactIds?: string[];
}
```

### 业务含义

结构化步骤视图。  
三种模式都可以发送步骤事件，但 agent 模式使用最频繁。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 步骤 ID |
| `requestId` | `string` | 所属 turn 请求 ID |
| `type` | 联合字面量 | 步骤类型 |
| `status` | `StepStatus` | 步骤状态 |
| `title` | `string` | 前端展示标题 |
| `detail` | `string` | 详细说明 |
| `startedAt` | `number` | 开始时间戳 |
| `endedAt` | `number` | 结束时间戳 |
| `artifactIds` | `string[]` | 该步骤产生或关联的 artifact ID |

### `type` 取值说明

| 类型 | 说明 |
|---|---|
| `context` | 上下文构建 |
| `thinking` | Agent 思考 / 规划 |
| `tool` | 工具调用 |
| `diff` | diff 生成 |
| `artifact` | artifact 生成 |
| `response` | 回复生成 |
| `narrative_recall` | 叙事世界观召回 |

---

## 4.7 `TurnRecord`

```ts
export interface TurnRecord {
  requestId: string;
  sessionId: string;
  mode: EmaMode;
  status: TurnStatus;
  modelId?: string;
  providerId?: string;
  startedAt: number;
  endedAt?: number;
  usage?: UsageView;
  artifacts?: ArtifactSummary[];
  diffs?: DiffSummary[];
}
```

### 业务含义

单轮持久化视图，给调试页、审计页、历史详情页使用。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `requestId` | `string` | turn 请求 ID |
| `sessionId` | `string` | 会话 ID |
| `mode` | `EmaMode` | 本轮执行模式 |
| `status` | `TurnStatus` | 本轮状态 |
| `modelId` | `string` | 使用的模型 ID |
| `providerId` | `string` | 使用的 provider ID |
| `startedAt` | `number` | 开始时间 |
| `endedAt` | `number` | 结束时间 |
| `usage` | `UsageView` | token 与成本统计 |
| `artifacts` | `ArtifactSummary[]` | 本轮产生的产物 |
| `diffs` | `DiffSummary[]` | 本轮产生的 diff |

---

## 4.8 `UsageView`

```ts
export interface UsageView {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
}
```

### 业务含义

统一 token 与成本用量视图。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `inputTokens` | `number` | 输入 token 数 |
| `outputTokens` | `number` | 输出 token 数 |
| `totalTokens` | `number` | 总 token 数 |
| `costUsd` | `number` | 估算成本，单位美元 |

---

# 5. `runtime-input.ts`：运行时输入封套

该文件定义 raw query 与 assembled prompt 的强隔离协议。  
这是整个 EmaAgent 中最重要的不变式之一。

---

## 5.1 `RuntimeInputEnvelope`

```ts
export interface RuntimeInputEnvelope {
  rawUserQuery: string;
  assembledUserPrompt: string;
  runtimeSystemPrompt: string;
  contextBlocks: RuntimeContextBlock[];
  mode?: EmaMode;
}
```

### 业务含义

运行时真正传给模型前的输入封套。

它明确区分：

- 用户原始输入
- 本轮拼装后的 user prompt
- 本轮运行时 system prompt
- 调试用上下文块

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `rawUserQuery` | `string` | 用户原始输入，只能把这个写入会话历史和长期记忆 |
| `assembledUserPrompt` | `string` | 本轮实际发给模型的 user prompt，可包含召回片段、附件提示、runtime 注入 |
| `runtimeSystemPrompt` | `string` | 本轮运行时 system prompt，不写入用户消息历史 |
| `contextBlocks` | `RuntimeContextBlock[]` | 仅用于调试和前端可视化，不用于持久化文本回放 |
| `mode` | `EmaMode` | 本轮执行模式，方便 prompt builder 注入不同策略 |

### 核心不变式

绝对不要把 `assembledUserPrompt` 写回历史。

错误示例：

```ts
session.messages.push({
  role: "user",
  content: envelope.assembledUserPrompt
});
```

正确示例：

```ts
session.messages.push({
  role: "user",
  content: envelope.rawUserQuery
});
```

否则下一轮模型会把召回片段误认为用户原话，产生“你刚才提到过 xxx”的幻觉。

---

## 5.2 `ContextBlockSource`

```ts
export type ContextBlockSource =
  | "attachment"
  | "memory"
  | "narrative"
  | "vision";
```

### 业务含义

运行时上下文块的来源。

| 值 | 含义 |
|---|---|
| `attachment` | 附件内容召回 |
| `memory` | 记忆召回 |
| `narrative` | 叙事世界观召回 |
| `vision` | 图像 / 截图分析结果 |

---

## 5.3 `RuntimeContextBlock`

```ts
export interface RuntimeContextBlock {
  source: ContextBlockSource;
  text: string;
}
```

### 业务含义

本轮参与 prompt 组装的上下文片段。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `source` | `ContextBlockSource` | 上下文来源 |
| `text` | `string` | 上下文文本内容 |

---

# 6. `model.ts`：Provider / Model / LLM Adapter 协议

该文件不绑定具体 SDK，只定义 Provider、模型目录、能力探测、角色绑定、LLM 请求与流式响应之间共享的稳定契约。

---

## 6.1 `ProviderKind`

```ts
export type ProviderKind =
  | "openai-native"
  | "anthropic-native"
  | "gemini-native"
  | "openai-compatible"
  | "anthropic-compatible"
  | "ollama"
  | "local-dev";
```

### 业务含义

Provider 的接入方式。

| 值 | 含义 |
|---|---|
| `openai-native` | OpenAI 官方 SDK / 官方接口 |
| `anthropic-native` | Anthropic Claude 官方接口 |
| `gemini-native` | Google Gemini 官方接口 |
| `openai-compatible` | OpenAI-compatible 接口，例如 vLLM、DeepSeek、OpenRouter 等 |
| `anthropic-compatible` | Anthropic-compatible 接口 |
| `ollama` | 本地 Ollama |
| `local-dev` | 本地开发 mock provider |

---

## 6.2 `ModelCapabilities`

```ts
export interface ModelCapabilities {
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  structuredOutput: boolean;
  promptCache: boolean;
  listModels: boolean;
}
```

### 业务含义

模型能力矩阵。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `streaming` | `boolean` | 是否支持流式输出 |
| `tools` | `boolean` | 是否支持工具调用 |
| `vision` | `boolean` | 是否支持视觉输入 |
| `structuredOutput` | `boolean` | 是否支持结构化输出 |
| `promptCache` | `boolean` | 是否支持 prompt cache |
| `listModels` | `boolean` | 是否支持远程列出模型 |

---

## 6.3 `ModelRole`

```ts
export type ModelRole =
  | "chat"
  | "agent"
  | "narrative"
  | "title"
  | "embedding"
  | "rerank";
```

### 业务含义

模型在系统中的绑定角色。

| 值 | 含义 |
|---|---|
| `chat` | 普通对话模型 |
| `agent` | Agent 推理和工具调用模型 |
| `narrative` | 叙事 / 角色扮演模型 |
| `title` | 会话标题生成模型 |
| `embedding` | 向量化模型 |
| `rerank` | 重排序模型 |

---

## 6.4 `ProviderDescriptor`

```ts
export interface ProviderDescriptor {
  id: string;
  displayName: string;
  kind: ProviderKind | "llm" | "embedding" | "reranker" | "tts" | "stt" | "vision";
  website?: string;
  icon?: string;
  enabled: boolean;
  configured: boolean;
  supportsRemoteModels?: boolean;
  health?: ProviderHealthView;
}
```

### 业务含义

模型提供方描述信息，用于设置页、Provider registry、模型选择器和健康检查。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | Provider 全局唯一 ID |
| `displayName` | `string` | 展示名称 |
| `kind` | 联合类型 | Provider 接入方式或能力类别 |
| `website` | `string` | 官网链接 |
| `icon` | `string` | 图标 URL |
| `enabled` | `boolean` | 是否启用该 Provider |
| `configured` | `boolean` | 是否已经正确配置，例如 API Key 是否存在 |
| `supportsRemoteModels` | `boolean` | 是否支持远端拉取模型列表 |
| `health` | `ProviderHealthView` | 最近一次健康检查结果 |

---

## 6.5 `ProviderHealthView`

```ts
export interface ProviderHealthView {
  status: "unknown" | "ok" | "degraded" | "down";
  checkedAt?: number;
  latencyMs?: number;
  message?: string;
}
```

### 业务含义

Provider 健康状态。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `status` | `"unknown" | "ok" | "degraded" | "down"` | Provider 当前状态 |
| `checkedAt` | `number` | 健康检查时间 |
| `latencyMs` | `number` | 探测延迟 |
| `message` | `string` | 状态说明或错误信息 |

---

## 6.6 `ModelDescriptor`

```ts
export interface ModelDescriptor {
  id: string;
  providerId: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  capabilities?: ModelCapabilities;
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  pricing?: {
    inputPer1M?: number;
    outputPer1M?: number;
  };
  source?: "static" | "remote" | "user";
  updatedAt?: number;
}
```

### 业务含义

模型注册信息，用于模型目录、模型选择器、能力校验、成本计算。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 全局唯一模型标识 |
| `providerId` | `string` | 所属 Provider ID |
| `displayName` | `string` | 展示名称 |
| `contextWindow` | `number` | 最大上下文长度 |
| `maxOutputTokens` | `number` | 最大输出 token 数 |
| `capabilities` | `ModelCapabilities` | 新版统一能力矩阵 |
| `supportsStreaming` | `boolean` | 是否支持流式输出，兼容旧代码 |
| `supportsTools` | `boolean` | 是否支持工具调用，兼容旧代码 |
| `supportsVision` | `boolean` | 是否支持视觉，兼容旧代码 |
| `pricing` | `{ inputPer1M; outputPer1M }` | 每百万 token 定价，单位美元 |
| `source` | `"static" | "remote" | "user"` | 元数据来源 |
| `updatedAt` | `number` | 元数据更新时间 |

---

## 6.7 `ChatCompletionMessageRole`

```ts
export type ChatCompletionMessageRole =
  | "system"
  | "user"
  | "assistant"
  | "tool";
```

### 业务含义

LLM 请求中的消息角色。

---

## 6.8 `ChatCompletionMessage`

```ts
export interface ChatCompletionMessage {
  role: ChatCompletionMessageRole;
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCallChunk[];
}
```

### 业务含义

LLM 请求消息结构，适配不同 provider 的 chat completion 输入。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `role` | `ChatCompletionMessageRole` | 消息角色 |
| `content` | `string` | 消息内容 |
| `toolCallId` | `string` | 如果是 tool 消息，则对应工具调用 ID |
| `toolCalls` | `ToolCallChunk[]` | 如果 assistant 触发工具调用，则携带工具调用信息 |

---

## 6.9 `ChatCompletionCachePolicy`

```ts
export interface ChatCompletionCachePolicy {
  enabled: boolean;
  ttlMs?: number;
  key?: string;
}
```

### 业务含义

非流式 LLM 请求的缓存策略。默认不启用。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `enabled` | `boolean` | 是否启用缓存 |
| `ttlMs` | `number` | 缓存有效期 |
| `key` | `string` | 自定义缓存 key |

---

## 6.10 `ChatCompletionRequest`

```ts
export interface ChatCompletionRequest {
  requestId?: string;
  traceId?: string;
  sessionId: string;
  messages: ChatCompletionMessage[];
  tools?: ToolSpec[];
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
  modelId: string;
  cache?: ChatCompletionCachePolicy;
}
```

### 业务含义

LLM 请求统一结构。  
业务层不应该直接依赖 OpenAI、Anthropic 或 Gemini 的原始 SDK 参数，而应该先转换成该结构，再由 provider adapter 负责适配。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `requestId` | `string` | 请求 ID，用于事件流与日志关联 |
| `traceId` | `string` | Trace ID，用于跨 runtime 追踪 |
| `sessionId` | `string` | 会话 ID，用于日志追踪 |
| `messages` | `ChatCompletionMessage[]` | 消息列表 |
| `tools` | `ToolSpec[]` | 可用工具列表 |
| `stream` | `boolean` | 是否启用流式输出 |
| `temperature` | `number` | 采样温度 |
| `maxTokens` | `number` | 最大输出 token 数 |
| `modelId` | `string` | 模型 ID |
| `cache` | `ChatCompletionCachePolicy` | 可选缓存策略 |

---

## 6.11 `ToolSpec`

```ts
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
```

### 业务含义

工具声明协议，用于告诉 LLM 当前可调用哪些工具。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | `string` | 工具名称 |
| `description` | `string` | 工具描述 |
| `parameters` | `Record<string, unknown>` | JSON Schema 参数定义 |

---

## 6.12 `ToolCallChunk`

```ts
export interface ToolCallChunk {
  id: string;
  toolName: string;
  argumentsDelta: string;
}
```

### 业务含义

流式响应中的工具调用片段。  
很多模型在流式 function calling 时，不会一次性返回完整 JSON 参数，而是分片返回参数字符串。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 工具调用 ID |
| `toolName` | `string` | 工具名称 |
| `argumentsDelta` | `string` | 参数 JSON 字符串的增量片段 |

---

## 6.13 `ChatCompletionChunk`

```ts
export interface ChatCompletionChunk {
  index: number;
  delta: { content?: string };
  token?: string;
  toolCalls?: ToolCallChunk[];
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter" | null;
}
```

### 业务含义

LLM 流式响应统一块。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `index` | `number` | 块索引，从 0 开始 |
| `delta` | `{ content?: string }` | 增量文本内容 |
| `token` | `string` | token 文本增量 |
| `toolCalls` | `ToolCallChunk[]` | 工具调用增量 |
| `usage` | `{...}` | 使用量统计，通常只在最后一块 |
| `finishReason` | 联合字面量 | 结束原因 |

### `finishReason` 说明

| 值 | 含义 |
|---|---|
| `stop` | 正常停止 |
| `length` | 达到最大长度 |
| `tool_calls` | 模型请求调用工具 |
| `content_filter` | 内容被安全策略截断 |
| `null` | 尚未结束 |

---

# 7. `memory.ts`：记忆与召回核心类型

该文件定义 EmaAgent V1 的四层记忆模型。

## 7.1 四层记忆模型

| 层级 | 名称 | 作用 | 是否持久化 |
|---|---|---|---|
| L1 | Working Scratchpad | 当前回合临时工作台 | 不持久化 |
| L2 | Conversation | 当前会话消息与滚动摘要 | JSON 持久化 |
| L3 | Session Identity | 角色卡、任务描述、策略笔记 | JSON 持久化 |
| L4 | User Profile & World Knowledge | 跨会话用户画像、剧情、附件知识 | SQLite / Python Bridge |

核心原则：

1. 所有记忆最终都必须转换成 `ContextBlock`。
2. 原始 user query 永远不被污染。
3. Agent 的 Working Memory 是结构化的，回合结束可丢弃。
4. Narrative 走 Python Bridge，TS 侧只做统一格式转换。
5. GraphRAG 在 V1 中只是占位，不实现检索逻辑。

---

## 7.2 `ContextSource`

```ts
export type ContextSource =
  | "system_prompt"
  | "rolling_summary"
  | "recent_messages"
  | "working_scratchpad"
  | "user_profile"
  | "semantic_fact"
  | "narrative_world"
  | "attachment_chunk"
  | "vision_frame"
  | "vision_gallery";
```

### 业务含义

上下文来源标识。  
它决定某个 `ContextBlock` 在 system prompt 中的语义角色，也决定调试 UI 如何展示来源。

### 取值说明

| 值 | 层级 | 说明 |
|---|---|---|
| `system_prompt` | L3 | 角色设定、系统指令 |
| `rolling_summary` | L2 | 压缩后的会话历史摘要 |
| `recent_messages` | L2 | 最近 N 轮原始消息 |
| `working_scratchpad` | L1 | Agent 当前工具链 / 推理草稿 |
| `user_profile` | L4 | 跨会话用户偏好、技能、习惯 |
| `semantic_fact` | L4 | 外部知识、剧情事实、通用知识 |
| `narrative_world` | L4 | 剧情世界观、时间线、角色关系 |
| `attachment_chunk` | 附件 | 文件附件召回片段 |
| `vision_frame` | 视觉 | 单帧图像分析结果 |
| `vision_gallery` | 视觉 | 图库聚合描述 |

---

## 7.3 `ContextBlock`

```ts
export interface ContextBlock {
  source: ContextSource;
  priority: number;
  content: string;
  tokenEstimate: number;
}
```

### 业务含义

所有记忆的最终形态，直接参与 system prompt 组装。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `source` | `ContextSource` | 上下文来源 |
| `priority` | `number` | 优先级，budget 不足时按 priority 降序截断 |
| `content` | `string` | 文本内容 |
| `tokenEstimate` | `number` | token 估算，用于预算治理 |

---

## 7.4 `RecallRequest`

```ts
export interface RecallRequest {
  mode: "chat" | "agent" | "narrative";
  sessionId: string;
  query: string;
  budgetTokens: number;
}
```

### 业务含义

统一召回请求。  
无论是 chat、agent 还是 narrative，最终都可以走统一的 recall 入口，只是 mode 会影响召回策略。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `mode` | `"chat" | "agent" | "narrative"` | 当前执行模式 |
| `sessionId` | `string` | 会话 ID |
| `query` | `string` | 当前用户原始 query，仅用于召回判定，不直接注入 LLM |
| `budgetTokens` | `number` | 当前上下文预算，单位 token |

---

## 7.5 `RecallResult`

```ts
export interface RecallResult {
  blocks: ContextBlock[];
  meta: RecallMeta;
}
```

### 业务含义

召回统一结果。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `blocks` | `ContextBlock[]` | 召回到的上下文块 |
| `meta` | `RecallMeta` | 召回元信息 |

---

## 7.6 `RecallMeta`

```ts
export interface RecallMeta {
  requestId: string;
  durationMs: number;
  sourceStats: Partial<Record<ContextSource, RecallSourceStat>>;
  totalTokens: number;
  compactionTriggered: boolean;
}
```

### 业务含义

召回元信息，用于 metadata 流与前端调试展示。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `requestId` | `string` | 所属请求 ID |
| `durationMs` | `number` | 召回耗时 |
| `sourceStats` | `Partial<Record<ContextSource, RecallSourceStat>>` | 各来源命中统计 |
| `totalTokens` | `number` | 召回内容总 token 占用 |
| `compactionTriggered` | `boolean` | 是否触发上下文压缩 |

---

## 7.7 `RecallSourceStat`

```ts
export interface RecallSourceStat {
  count: number;
  tokens: number;
}
```

### 业务含义

某个上下文来源的召回统计。

| 字段 | 类型 | 说明 |
|---|---|---|
| `count` | `number` | 命中条数 |
| `tokens` | `number` | 占用 token 数 |

---

## 7.8 `RollingSummary`

```ts
export interface RollingSummary {
  sessionId: string;
  layer: number;
  summaryText: string;
  coversMessageRange: { fromIndex: number; toIndex: number };
  generatedAt: number;
  tokenCount: number;
}
```

### 业务含义

分层滚动摘要。  
用于在长对话中压缩历史消息，同时保留上下文连续性。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `sessionId` | `string` | 所属会话 ID |
| `layer` | `number` | 摘要层级，0 表示最新摘要，越大越老、粒度越粗 |
| `summaryText` | `string` | 压缩后的对话摘要 |
| `coversMessageRange` | `{ fromIndex; toIndex }` | 摘要覆盖的消息范围 |
| `generatedAt` | `number` | 摘要生成时间 |
| `tokenCount` | `number` | 摘要 token 数 |

### 使用策略

组装 context 时按 `layer` 从新到旧拼接。

---

## 7.9 `AgentWorkingMemory`

```ts
export interface AgentWorkingMemory {
  sessionId: string;
  turnIndex: number;
  currentGoal?: string;
  toolTraces: ToolTrace[];
  pendingHypotheses: string[];
  scratchFacts: string[];
}
```

### 业务含义

Agent 工作记忆，也就是 L1 Working Scratchpad。  
它是内存级对象，不持久化。每轮 Agent Loop 在这里读写。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `sessionId` | `string` | 所属会话 ID |
| `turnIndex` | `number` | 当前回合序号 |
| `currentGoal` | `string` | 本轮目标，由 think 步骤设定 |
| `toolTraces` | `ToolTrace[]` | 已执行工具链 |
| `pendingHypotheses` | `string[]` | 待验证假设 |
| `scratchFacts` | `string[]` | 本轮临时召回碎片，回合结束可丢弃 |

---

## 7.10 `ToolTrace`

```ts
export interface ToolTrace {
  toolName: string;
  callId: string;
  input: unknown;
  output: unknown;
  success: boolean;
  errorReason?: string;
  timestamp: number;
}
```

### 业务含义

工具调用痕迹。  
用于 Agent reflect 步骤分析本轮做了什么、哪里失败、是否需要沉淀策略。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `toolName` | `string` | 工具名称 |
| `callId` | `string` | 工具调用 ID |
| `input` | `unknown` | 工具输入 |
| `output` | `unknown` | 工具输出 |
| `success` | `boolean` | 是否成功 |
| `errorReason` | `string` | 失败原因 |
| `timestamp` | `number` | 调用时间戳 |

---

## 7.11 `ReflectionMemo`

```ts
export interface ReflectionMemo {
  sessionId: string;
  turnIndex: number;
  extractedFacts: ExtractedFact[];
  strategyNotes: string[];
  persistedToProfile: boolean;
}
```

### 业务含义

Agent 反思沉淀结果。  
reflect 步骤会从本轮工具调用与对话中提取事实和策略笔记。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `sessionId` | `string` | 所属会话 ID |
| `turnIndex` | `number` | 当前回合序号 |
| `extractedFacts` | `ExtractedFact[]` | 从本轮提取的持久事实 |
| `strategyNotes` | `string[]` | 策略调整建议，仅当前会话有效 |
| `persistedToProfile` | `boolean` | 是否已沉淀到 User Profile |

---

## 7.12 `ExtractedFact`

```ts
export interface ExtractedFact {
  content: string;
  confidence: number;
  factType: "preference" | "skill" | "habit" | "project";
}
```

### 业务含义

从对话或工具结果中抽取出来的事实项。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `content` | `string` | 事实内容 |
| `confidence` | `number` | 置信度，0 到 1，通常 > 0.7 才沉淀到 L4 |
| `factType` | 联合字面量 | 事实类型 |

### `factType` 说明

| 类型 | 含义 |
|---|---|
| `preference` | 用户偏好 |
| `skill` | 用户技能 |
| `habit` | 用户习惯 |
| `project` | 用户项目相关事实 |

---

## 7.13 `AgentSessionIdentity`

```ts
export interface AgentSessionIdentity {
  sessionId: string;
  taskDescription: string;
  relevantFiles: string[];
  strategyNotes: string[];
  lastUpdated: number;
}
```

### 业务含义

Agent 会话级策略档案，属于 L3 Session Identity。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `sessionId` | `string` | 所属会话 ID |
| `taskDescription` | `string` | 当前任务描述 |
| `relevantFiles` | `string[]` | 相关文件或代码上下文 |
| `strategyNotes` | `string[]` | 策略笔记，例如“下次遇到 X 先用 Y 工具” |
| `lastUpdated` | `number` | 最后更新时间 |

---

## 7.14 `WorldState`

```ts
export interface WorldState {
  worldId: string;
  currentTimeline: string;
  activeCharacters: string[];
  plotFlags: string[];
  cachedAt: number;
}
```

### 业务含义

Narrative 世界观状态。  
TS 侧只做轻量缓存，重计算在 Python Bridge / LightRAG 中完成。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `worldId` | `string` | 世界观 ID |
| `currentTimeline` | `string` | 当前时间线位置 |
| `activeCharacters` | `string[]` | 活跃角色列表 |
| `plotFlags` | `string[]` | 关键剧情标记 |
| `cachedAt` | `number` | 缓存时间戳 |

---

## 7.15 `NarrativeBridgeQuery`

```ts
export interface NarrativeBridgeQuery {
  worldId: string;
  sceneContext: string;
  query: string;
  characterIds?: string[];
}
```

### 业务含义

Python Bridge 查询参数。  
用于从剧情世界观、时间线、角色关系中召回相关内容。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `worldId` | `string` | 世界观 ID |
| `sceneContext` | `string` | 当前场景上下文 |
| `query` | `string` | 查询文本 |
| `characterIds` | `string[]` | 可选角色过滤 |

---

## 7.16 `NarrativeBridgeResult`

```ts
export interface NarrativeBridgeResult {
  chunks: Array<{
    text: string;
    relevance: number;
    source: string;
  }>;
  deduped: boolean;
  durationMs: number;
}
```

### 业务含义

Python Bridge 返回结果。  
这是 LightRAG 查询后、TS 侧转换成 `ContextBlock` 前的结果。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `chunks` | `Array<{...}>` | 召回文本块 |
| `chunks.text` | `string` | 召回文本 |
| `chunks.relevance` | `number` | 相关性分数 |
| `chunks.source` | `string` | 来源标识，例如周目、章节 |
| `deduped` | `boolean` | 是否执行过去重 |
| `durationMs` | `number` | 查询耗时 |

---

## 7.17 `UserProfile`

```ts
export interface UserProfile {
  id: string;
  userId: string;
  extractedAt: number;
  factType: "preference" | "skill" | "habit" | "project";
  content: string;
  confidence: number;
  sourceSessionId: string;
  extractionSource: "agent_reflect" | "chat_summary" | "explicit_feedback";
}
```

### 业务含义

跨会话用户画像条目，通常对应 SQLite 表 `user_profiles`。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 条目 ID |
| `userId` | `string` | 用户标识，V1 默认单机单用户 |
| `extractedAt` | `number` | 提取时间 |
| `factType` | 联合字面量 | 事实类型 |
| `content` | `string` | 事实内容 |
| `confidence` | `number` | 置信度 |
| `sourceSessionId` | `string` | 来源会话 ID |
| `extractionSource` | 联合字面量 | 提取来源 |

### `extractionSource` 说明

| 值 | 含义 |
|---|---|
| `agent_reflect` | Agent reflect 步骤沉淀 |
| `chat_summary` | Chat 摘要中提取 |
| `explicit_feedback` | 用户显式反馈 |

---

## 7.18 `VisionMemoryBlock`

```ts
export interface VisionMemoryBlock {
  visionId: string;
  description: string;
  timestamp: number;
  source: "screenshot" | "uploaded_image" | "clipboard";
}
```

### 业务含义

视觉记忆块。  
V1 不做视频，只做单帧分析和图库聚合描述。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `visionId` | `string` | 视觉内容 ID，例如图片 hash 或截图编号 |
| `description` | `string` | 图像分析得到的文本描述 |
| `timestamp` | `number` | 关联时间 |
| `source` | `"screenshot" | "uploaded_image" | "clipboard"` | 来源类型 |

---

## 7.19 `MemoryWriteRequest`

```ts
export interface MemoryWriteRequest {
  targetLayer: "l1_scratchpad" | "l2_conversation" | "l3_identity" | "l4_profile";
  sessionId: string;
  payload: unknown;
  reason?: string;
}
```

### 业务含义

记忆写入请求，供 `MemoryRuntime.write` 使用。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `targetLayer` | 联合字面量 | 目标记忆层级 |
| `sessionId` | `string` | 所属会话 ID |
| `payload` | `unknown` | 写入内容 |
| `reason` | `string` | 写入原因，调试用 |

---

## 7.20 `GraphNodePlaceholder`

```ts
export interface GraphNodePlaceholder {
  key: string;
  id: string;
  name: string;
  entityType: string;
  summary: string;
}
```

### 业务含义

GraphRAG 节点定义，占位类型。  
V1 保留 schema，但不实现 GraphRAG 检索逻辑。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `key` | `string` | 图谱内部 key |
| `id` | `string` | 节点 ID |
| `name` | `string` | 实体名称 |
| `entityType` | `string` | 实体类型 |
| `summary` | `string` | 节点摘要 |

---

## 7.21 `GraphEdgePlaceholder`

```ts
export interface GraphEdgePlaceholder {
  key: string;
  id: string;
  source: string;
  target: string;
  relationType: string;
}
```

### 业务含义

GraphRAG 边定义，占位类型。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `key` | `string` | 图谱内部 key |
| `id` | `string` | 边 ID |
| `source` | `string` | 源节点 ID |
| `target` | `string` | 目标节点 ID |
| `relationType` | `string` | 关系类型 |

---

# 8. `events.ts`：前后端流式事件协议

该文件定义前后端流式事件协议。  
V1 默认使用 SSE 承载这些语义事件；服务端内部可以先用 `AsyncIterable<EmaStreamEvent>` 汇聚，再由 API Gateway 编码成 `text/event-stream` 或开发期 NDJSON。

---

## 8.1 `ContextBudgetView`

```ts
export interface ContextBudgetView {
  maxTokens: number;
  usedTokens: number;
  reservedOutputTokens: number;
  compactionTriggered: boolean;
}
```

### 业务含义

上下文预算快照，用于 `ContextRadarPane` 展示。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `maxTokens` | `number` | 最大上下文 token |
| `usedTokens` | `number` | 已使用 token |
| `reservedOutputTokens` | `number` | 为输出预留的 token |
| `compactionTriggered` | `boolean` | 是否触发压缩 |

---

## 8.2 `ContextSourceView`

```ts
export interface ContextSourceView {
  id: string;
  source: "recent_messages" | "summary" | "memory" | "attachment" | "workspace" | "narrative" | "system";
  title: string;
  tokenEstimate: number;
  included: boolean;
}
```

### 业务含义

单个上下文来源的可视化条目。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 来源条目 ID |
| `source` | 联合字面量 | 来源类别 |
| `title` | `string` | 展示标题 |
| `tokenEstimate` | `number` | token 估算 |
| `included` | `boolean` | 是否被纳入本轮上下文 |

---

## 8.3 `ToolCallView`

```ts
export interface ToolCallView {
  id: string;
  requestId: string;
  toolId: string;
  title: string;
  arguments: Record<string, unknown>;
  status: "requested" | "running" | "completed" | "failed" | "denied";
}
```

### 业务含义

工具调用视图。  
权限弹窗和步骤流都可以复用该结构。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 工具调用 ID |
| `requestId` | `string` | 所属 turn 请求 ID |
| `toolId` | `string` | 工具 ID |
| `title` | `string` | 前端展示标题 |
| `arguments` | `Record<string, unknown>` | 工具参数 |
| `status` | 联合字面量 | 工具执行状态 |

---

## 8.4 `ToolOutputView`

```ts
export interface ToolOutputView {
  callId: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  summary?: string;
  durationMs?: number;
}
```

### 业务含义

工具输出视图。  
用于避免把原始 stdout / stderr 泄漏到 UI 结构之外。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `callId` | `string` | 对应工具调用 ID |
| `exitCode` | `number` | 进程退出码 |
| `stdout` | `string` | 标准输出 |
| `stderr` | `string` | 标准错误 |
| `summary` | `string` | 工具输出摘要 |
| `durationMs` | `number` | 执行耗时 |

---

## 8.5 `PermissionRequestView`

```ts
export interface PermissionRequestView {
  id: string;
  requestId: string;
  scope: "once" | "session" | "always";
  toolId: string;
  title: string;
  riskLevel: "low" | "medium" | "high";
  reason: string;
  expiresAt?: number;
}
```

### 业务含义

权限请求视图。  
当工具操作需要用户授权时，后端通过事件流发送该结构。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 权限请求 ID |
| `requestId` | `string` | 所属 turn 请求 ID |
| `scope` | `"once" | "session" | "always"` | 授权范围 |
| `toolId` | `string` | 请求授权的工具 ID |
| `title` | `string` | 权限弹窗标题 |
| `riskLevel` | `"low" | "medium" | "high"` | 风险等级 |
| `reason` | `string` | 请求授权原因 |
| `expiresAt` | `number` | 过期时间 |

---

## 8.6 `PermissionDecision`

```ts
export interface PermissionDecision {
  requestId: string;
  decision: "allow_once" | "allow_session" | "deny" | "always_deny";
  decidedAt: number;
}
```

### 业务含义

权限决策结果。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `requestId` | `string` | 对应权限请求 ID |
| `decision` | 联合字面量 | 用户决策 |
| `decidedAt` | `number` | 决策时间 |

### `decision` 说明

| 值 | 含义 |
|---|---|
| `allow_once` | 仅本次允许 |
| `allow_session` | 当前 session 内允许 |
| `deny` | 本次拒绝 |
| `always_deny` | 始终拒绝 |

---

## 8.7 `StageCue`

```ts
export interface StageCue {
  expression?: string;
  motion?: string;
  speaking?: boolean;
  mood?: "neutral" | "warm" | "thinking" | "focused" | "concerned" | "excited";
}
```

### 业务含义

Live2D 舞台 cue。  
Live2D 舞台只消费 cue，不直接读取复杂 agent 状态。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `expression` | `string` | 表情 |
| `motion` | `string` | 动作 |
| `speaking` | `boolean` | 是否正在说话 |
| `mood` | 联合字面量 | 当前情绪状态 |

---

## 8.8 `EmaStreamEvent`

```ts
export type EmaStreamEvent =
  | { type: "turn_started"; requestId: string; sessionId: string; mode: EmaMode; at: number }
  | { type: "context_snapshot"; requestId: string; budget: ContextBudgetView; sources: ContextSourceView[] }
  | { type: "output_text_delta"; requestId: string; blockId: string; delta: string; index: number }
  | { type: "render_block"; requestId: string; block: RenderBlock }
  | { type: "step_started"; requestId: string; step: StepView }
  | { type: "step_updated"; requestId: string; stepId: string; patch: Partial<StepView> }
  | { type: "tool_call_requested"; requestId: string; call: ToolCallView; permission?: PermissionRequestView }
  | { type: "tool_call_output"; requestId: string; callId: string; output: ToolOutputView }
  | { type: "artifact_upserted"; requestId: string; artifact: ArtifactSummary }
  | { type: "diff_ready"; requestId: string; artifactId: string; diff: DiffSummary }
  | { type: "permission_required"; requestId: string; request: PermissionRequestView }
  | { type: "permission_resolved"; requestId: string; requestIdResolved: string; decision: PermissionDecision }
  | { type: "stage_cue"; requestId: string; cue: StageCue }
  | { type: "usage_report"; requestId: string; usage: UsageView }
  | { type: "warning"; requestId: string; code: string; message: string }
  | { type: "turn_completed"; requestId: string; assistantMessageId: string; at: number }
  | { type: "turn_failed"; requestId: string; error: UiErrorView; retryable: boolean };
```

### 业务含义

前后端流式事件联合类型。

前端可以根据 `event.type` 做 switch 分发：

```ts
switch (event.type) {
  case "output_text_delta":
    appendDelta(event.blockId, event.delta);
    break;
  case "artifact_upserted":
    updateWorkspace(event.artifact);
    break;
  case "permission_required":
    showPermissionDialog(event.request);
    break;
}
```

### 事件说明

| 事件类型 | 说明 |
|---|---|
| `turn_started` | turn 开始执行 |
| `context_snapshot` | 上下文预算与来源快照 |
| `output_text_delta` | 文本流式增量 |
| `render_block` | 新增一个结构化渲染块 |
| `step_started` | 步骤开始 |
| `step_updated` | 步骤状态更新 |
| `tool_call_requested` | 请求调用工具 |
| `tool_call_output` | 工具输出 |
| `artifact_upserted` | Workspace 产物新增或更新 |
| `diff_ready` | diff 已生成 |
| `permission_required` | 需要用户授权 |
| `permission_resolved` | 权限请求已被处理 |
| `stage_cue` | Live2D 舞台状态提示 |
| `usage_report` | token 与费用用量报告 |
| `warning` | 非致命警告 |
| `turn_completed` | turn 成功完成 |
| `turn_failed` | turn 执行失败 |

---

## 8.9 `StepEvent`

```ts
export type StepEvent = StepView;
```

### 业务含义

兼容旧测试和旧 UI 命名的步骤事件别名。

---

# 9. `response-markup.ts`：前端渲染协议

该文件定义前端如何渲染模型输出中的结构化内容。  
`RenderBlock` 只描述“怎么渲染一段输出”，artifact 相关协议放在 `artifacts.ts`。

---

## 9.1 `RenderBlock`

```ts
export type RenderBlock =
  | { type: "markdown"; text: string }
  | { type: "code"; language?: string; code: string }
  | { type: "math_inline"; latex: string }
  | { type: "math_block"; latex: string }
  | { type: "mermaid"; code: string; theme?: "dark" | "light" }
  | { type: "image"; url: string; alt?: string; width?: number; height?: number }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "file_ref"; path: string; label?: string };
```

### 业务含义

富文本渲染块联合类型。  
前端根据 `type` 选择不同 renderer。

### 类型说明

| 类型 | 字段 | 说明 |
|---|---|---|
| `markdown` | `text` | Markdown 文本 |
| `code` | `language`, `code` | 代码块 |
| `math_inline` | `latex` | 行内公式 |
| `math_block` | `latex` | 块级公式 |
| `mermaid` | `code`, `theme` | Mermaid 图 |
| `image` | `url`, `alt`, `width`, `height` | 图片 |
| `table` | `headers`, `rows` | 表格 |
| `file_ref` | `path`, `label` | 文件引用 |

---

## 9.2 `EmotionName`

```ts
export type EmotionName =
  | "happy"
  | "sad"
  | "angry"
  | "think"
  | "surprised"
  | "awkward"
  | "question"
  | "curious"
  | "neutral";
```

### 业务含义

允许的情绪名称。  
通常用于 ACT 标签、Live2D 表情、角色扮演状态等。

---

## 9.3 `ActState`

```ts
export interface ActState {
  emotion: {
    name: EmotionName;
    intensity: number;
  };
  cognitive: string;
  intent: string;
  motion: string;
}
```

### 业务含义

ACT 标签状态。  
用于描述角色当前的情绪、认知状态、意图和动作。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `emotion.name` | `EmotionName` | 情绪名称 |
| `emotion.intensity` | `number` | 情绪强度 |
| `cognitive` | `string` | 认知状态，例如“思考中”“犹豫” |
| `intent` | `string` | 当前表达意图 |
| `motion` | `string` | 动作提示 |

---

# 10. `artifacts.ts`：Workspace 产物与 Diff 协议

该文件定义 Agent Workspace 的产物与 Diff 协议。  
核心思想是：任何文件、图表、报告、patch 都不应该只塞进聊天正文，而应该作为 artifact 进入 WorkspacePane，由前端决定预览、编辑、diff、apply 或 reject。

---

## 10.1 `ArtifactKind`

```ts
export type ArtifactKind =
  | "file"
  | "patch"
  | "diff"
  | "chart"
  | "image"
  | "html_report"
  | "notebook"
  | "dataset"
  | "log";
```

### 业务含义

Workspace 中可管理的产物类型。

| 值 | 说明 |
|---|---|
| `file` | 普通文件 |
| `patch` | 可应用补丁 |
| `diff` | 差异视图 |
| `chart` | 图表 |
| `image` | 图片 |
| `html_report` | HTML 报告 |
| `notebook` | Notebook |
| `dataset` | 数据集 |
| `log` | 日志 |

---

## 10.2 `ArtifactStatus`

```ts
export type ArtifactStatus =
  | "draft"
  | "ready"
  | "applied"
  | "rejected"
  | "superseded"
  | "failed";
```

### 业务含义

产物当前生命周期状态。

| 状态 | 含义 |
|---|---|
| `draft` | 草稿状态 |
| `ready` | 已准备好，可查看或应用 |
| `applied` | 已应用 |
| `rejected` | 已拒绝 |
| `superseded` | 已被新版本替代 |
| `failed` | 生成或应用失败 |

---

## 10.3 `ArtifactSummary`

```ts
export interface ArtifactSummary {
  id: string;
  requestId: string;
  kind: ArtifactKind;
  title: string;
  mime: string;
  payloadRef: string;
  targetPath?: string;
  status: ArtifactStatus;
  createdAt: number;
  updatedAt: number;
}
```

### 业务含义

Workspace 列表中展示的轻量产物摘要。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 产物 ID |
| `requestId` | `string` | 产物来自哪一轮 turn |
| `kind` | `ArtifactKind` | 产物类型 |
| `title` | `string` | 展示标题 |
| `mime` | `string` | MIME 类型，前端据此选择预览器 |
| `payloadRef` | `string` | 内容懒加载引用，可以是本地路径、blob key 或 DB payload key |
| `targetPath` | `string` | 原始文件路径，patch / diff / file 常用 |
| `status` | `ArtifactStatus` | 当前状态 |
| `createdAt` | `number` | 创建时间戳 |
| `updatedAt` | `number` | 更新时间戳 |

---

## 10.4 `FileDiffSummary`

```ts
export interface FileDiffSummary {
  path: string;
  changeType: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;
  stats: {
    additions: number;
    deletions: number;
  };
}
```

### 业务含义

单个文件的 diff 摘要。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `path` | `string` | 相对工作区路径 |
| `changeType` | 联合字面量 | 变更类型 |
| `oldPath` | `string` | rename 时的旧路径 |
| `stats.additions` | `number` | 新增行数 |
| `stats.deletions` | `number` | 删除行数 |

---

## 10.5 `DiffSummary`

```ts
export interface DiffSummary {
  artifactId: string;
  baseHash?: string;
  headHash?: string;
  files: FileDiffSummary[];
  patchRef?: string;
}
```

### 业务含义

`diff_ready` 事件中传输的结构化 diff 摘要。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `artifactId` | `string` | 对应 artifact ID |
| `baseHash` | `string` | 本次 diff 基于的文件 hash，apply 前必须校验 |
| `headHash` | `string` | 应用后预期 hash |
| `files` | `FileDiffSummary[]` | 涉及文件列表 |
| `patchRef` | `string` | 原始 unified diff 的懒加载引用 |

---

## 10.6 `ArtifactMeta`

```ts
export interface ArtifactMeta {
  kind: "tool_image" | "chart" | "report_file" | "audio" | "video";
  title: string;
  url: string;
  mime?: string;
  sourceTool?: string;
}
```

### 业务含义

兼容旧代码的 ArtifactMeta。  
新代码应优先使用 `ArtifactSummary`，这个类型主要用于早期 UI 与工具返回值迁移。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `kind` | 联合字面量 | 旧版产物类型 |
| `title` | `string` | 标题 |
| `url` | `string` | 资源 URL |
| `mime` | `string` | MIME 类型 |
| `sourceTool` | `string` | 来源工具 |

---

# 11. `errors.ts`：UI 错误协议

该文件定义 UI 可理解的错误协议。  
Runtime 内部可以继续使用业务异常类，但跨 API / SSE 边界时要统一落到 `UiErrorView`，避免前端直接依赖某个包里的 Error 子类。

---

## 11.1 `UiErrorCode`

```ts
export type UiErrorCode =
  | "provider_unavailable"
  | "model_not_found"
  | "model_capability_mismatch"
  | "rate_limited"
  | "context_overflow"
  | "tool_denied"
  | "tool_failed"
  | "sandbox_denied"
  | "permission_required"
  | "bridge_unavailable"
  | "session_not_found"
  | "artifact_not_found"
  | "storage_migration_failed"
  | "bad_request"
  | "internal_error";
```

### 业务含义

稳定错误码集合。

### 错误码说明

| 错误码 | 含义 |
|---|---|
| `provider_unavailable` | 模型提供方不可用 |
| `model_not_found` | 找不到模型 |
| `model_capability_mismatch` | 模型能力不匹配，例如需要 vision 但模型不支持 |
| `rate_limited` | 请求被限流 |
| `context_overflow` | 上下文超出限制 |
| `tool_denied` | 工具调用被拒绝 |
| `tool_failed` | 工具执行失败 |
| `sandbox_denied` | 沙箱拒绝操作 |
| `permission_required` | 需要权限确认 |
| `bridge_unavailable` | Python Bridge 或外部桥接服务不可用 |
| `session_not_found` | 找不到会话 |
| `artifact_not_found` | 找不到产物 |
| `storage_migration_failed` | 存储迁移失败 |
| `bad_request` | 请求参数错误 |
| `internal_error` | 内部错误 |

---

## 11.2 `UiErrorSeverity`

```ts
export type UiErrorSeverity = "info" | "warning" | "error";
```

### 业务含义

前端决定提示样式与是否展示重试按钮时使用的严重级别。

| 值 | 说明 |
|---|---|
| `info` | 信息提示 |
| `warning` | 警告 |
| `error` | 错误 |

---

## 11.3 `UiErrorView`

```ts
export interface UiErrorView {
  code: UiErrorCode;
  message: string;
  retryable: boolean;
  severity: UiErrorSeverity;
  details?: Record<string, unknown>;
}
```

### 业务含义

API 与事件流中统一传输的错误视图。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `code` | `UiErrorCode` | 机器可读错误码 |
| `message` | `string` | 人类可读消息，前端可直接展示 |
| `retryable` | `boolean` | 是否建议前端展示重试入口 |
| `severity` | `UiErrorSeverity` | 错误严重级别 |
| `details` | `Record<string, unknown>` | 可选详情，通常只在 developer inspector 展示 |

---

## 11.4 `toInternalUiError(error: unknown)`

```ts
export function toInternalUiError(error: unknown): UiErrorView
```

### 业务含义

将未知异常压成默认内部错误，供 gateway 兜底使用。

### 返回结构

```ts
{
  code: "internal_error",
  message: error instanceof Error ? error.message : "Unknown internal error.",
  retryable: false,
  severity: "error",
}
```

### 使用场景

- API handler 的兜底 catch
- SSE 事件流失败兜底
- Runtime 未知异常转换
- Provider adapter 未分类错误转换

---

# 12. `metadata.ts`：单轮元数据与 Prompt 组装元数据

该文件定义单轮交互的元数据结构与 Prompt 组装元数据。

---

## 12.1 `EmaTurnMetadata`

```ts
export interface EmaTurnMetadata {
  mode: EmaMode;
  sessionId: string;
  requestId: string;
  traceId: string;
  model: { provider: string; modelId: string };
  usage: UsageView;
  latencyMs: number;
  recalls: {
    sources: Partial<Record<ContextSource, RecallMeta>>;
    totalTokens: number;
    compactionTriggered: boolean;
  };
  toolCalls: ToolCallMeta[];
  safety: {
    sandboxMode: "strict" | "relaxed";
    fullAccessGranted: boolean;
    deniedCount: number;
  };
  live2d?: {
    expression?: string;
    motion?: string;
    mouthSyncMs?: number;
  };
}
```

### 业务含义

单轮 turn 的完整元信息。  
用于调试、日志、审计、前端开发者面板、性能分析。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `mode` | `EmaMode` | 本轮执行模式 |
| `sessionId` | `string` | 会话 ID |
| `requestId` | `string` | turn 请求 ID |
| `traceId` | `string` | 全链路追踪 ID |
| `model.provider` | `string` | 模型提供方 |
| `model.modelId` | `string` | 模型 ID |
| `usage` | `UsageView` | token 与成本使用量 |
| `latencyMs` | `number` | 总延迟 |
| `recalls.sources` | `Partial<Record<ContextSource, RecallMeta>>` | 各来源召回统计 |
| `recalls.totalTokens` | `number` | 召回总 token 占用 |
| `recalls.compactionTriggered` | `boolean` | 是否触发压缩 |
| `toolCalls` | `ToolCallMeta[]` | 工具调用元数据 |
| `safety.sandboxMode` | `"strict" | "relaxed"` | 沙箱模式 |
| `safety.fullAccessGranted` | `boolean` | 是否启用全权限 |
| `safety.deniedCount` | `number` | 被拒绝次数 |
| `live2d.expression` | `string` | Live2D 表情 |
| `live2d.motion` | `string` | Live2D 动作 |
| `live2d.mouthSyncMs` | `number` | 嘴型同步时长 |

---

## 12.2 `PromptAssemblyMeta`

```ts
export interface PromptAssemblyMeta {
  rawHash: string;
  assembledHash: string;
  rawTokenEstimate: number;
  assembledTokenEstimate: number;
  blockBreakdown: Array<{ source: string; charCount: number }>;
}
```

### 业务含义

Prompt 组装元数据，用于调试与前端展示。

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `rawHash` | `string` | 原始用户 query 的 hash |
| `assembledHash` | `string` | 组装后 prompt 的 hash |
| `rawTokenEstimate` | `number` | 组装前 token 估算 |
| `assembledTokenEstimate` | `number` | 组装后 token 估算 |
| `blockBreakdown` | `Array<{ source; charCount }>` | 各上下文块字符占比 |

### 使用场景

- 排查 prompt 过长
- 验证 raw query 是否被污染
- 查看 memory / attachment / narrative 各占多少上下文
- 分析为什么触发 compaction

---

# 13. `index.ts`：统一导出入口

`index.ts` 将所有 core types 统一 re-export，方便业务模块从一个入口导入类型。

---

## 13.1 导出分组

### 模式与 turn

导出：

- `EMA_MODES`
- `isEmaMode`
- `EmaMode`
- `ModeSelectionState`
- `StartTurnRequest`
- `StartTurnResponse`
- `TurnInputBlock`
- `TurnRecord`
- `TurnStatus`
- `StepStatus`
- `StepView`
- `UsageView`

### 会话与消息

导出：

- `MessageRole`
- `MessageContentBlock`
- `ChatMessage`
- `ToolCall`
- `ToolResult`
- `SessionState`
- `SessionSummary`
- `SessionTitleStatus`
- `ToolCallMeta`
- `ToolConfirmPayload`
- `SessionRepository`
- `ShouldGenerateTitleRequest`
- `GenerateSessionTitleRequest`
- `SessionTitleResult`

### 记忆与召回

导出：

- `ContextSource`
- `ContextBlock`
- `RecallRequest`
- `RecallResult`
- `RecallMeta`
- `RecallSourceStat`
- `RollingSummary`
- `AgentWorkingMemory`
- `ToolTrace`
- `ReflectionMemo`
- `ExtractedFact`
- `AgentSessionIdentity`
- `WorldState`
- `NarrativeBridgeQuery`
- `NarrativeBridgeResult`
- `UserProfile`
- `VisionMemoryBlock`
- `MemoryWriteRequest`
- `GraphNodePlaceholder`
- `GraphEdgePlaceholder`

### 模型与 LLM

导出：

- `ProviderKind`
- `ModelCapabilities`
- `ModelRole`
- `ProviderHealthView`
- `ProviderDescriptor`
- `ModelDescriptor`
- `ToolSpec`
- `ChatCompletionMessageRole`
- `ChatCompletionMessage`
- `ChatCompletionCachePolicy`
- `ChatCompletionRequest`
- `ToolCallChunk`
- `ChatCompletionChunk`

### 运行时输入

导出：

- `RuntimeInputEnvelope`
- `ContextBlockSource`
- `RuntimeContextBlock`

### 渲染协议与 Workspace 产物

导出：

- `RenderBlock`
- `EmotionName`
- `ActState`
- `ArtifactKind`
- `ArtifactStatus`
- `ArtifactSummary`
- `FileDiffSummary`
- `DiffSummary`
- `ArtifactMeta`

### 元数据

导出：

- `EmaTurnMetadata`
- `PromptAssemblyMeta`

### 事件

导出：

- `ContextBudgetView`
- `ContextSourceView`
- `ToolCallView`
- `ToolOutputView`
- `PermissionRequestView`
- `PermissionDecision`
- `StageCue`
- `StepEvent`
- `EmaStreamEvent`

### 错误

导出：

- `toInternalUiError`
- `UiErrorCode`
- `UiErrorSeverity`
- `UiErrorView`

---

# 14. 类型之间的业务关系

## 14.1 Session 与 Turn 的关系

```text
SessionState
  ├── messages: ChatMessage[]
  ├── modeLast: EmaMode
  └── titleStatus: SessionTitleStatus

TurnRecord
  ├── requestId
  ├── sessionId
  ├── mode
  ├── usage
  ├── artifacts
  └── diffs
```

业务上：

- `SessionState` 记录长期上下文。
- `TurnRecord` 记录某一轮执行详情。
- 一个 session 可以包含很多 turn。
- 每个 turn 可以使用不同 mode。

---

## 14.2 Turn 与 Event 的关系

```text
StartTurnRequest
  ↓
StartTurnResponse
  ↓
EmaStreamEvent[]
  ↓
TurnRecord
```

业务上：

1. 前端提交 `StartTurnRequest`。
2. 后端返回 `StartTurnResponse`。
3. 前端订阅 `streamUrl`。
4. 后端持续推送 `EmaStreamEvent`。
5. turn 完成后写入 `TurnRecord`。

---

## 14.3 RuntimeInputEnvelope 与 Memory 的关系

```text
rawUserQuery
  ↓
RecallRequest.query
  ↓
RecallResult.blocks
  ↓
RuntimeInputEnvelope.contextBlocks
  ↓
assembledUserPrompt / runtimeSystemPrompt
```

核心点：

- 召回可以使用原始 query。
- 召回结果可以进入 assembled prompt。
- 但只有 raw query 可以写入历史。
- context block 只是本轮运行时材料，不等于用户原话。

---

## 14.4 Model 与 Event 的关系

```text
ChatCompletionRequest
  ↓
ChatCompletionChunk
  ↓
output_text_delta / tool_call_requested / usage_report
```

业务上：

- Provider adapter 把不同模型 SDK 输出转换成统一 `ChatCompletionChunk`。
- Runtime 再把 chunk 转换成 `EmaStreamEvent`。
- 前端不需要知道底层是 OpenAI、Claude、Gemini 还是 vLLM。

---

## 14.5 Artifact 与 Diff 的关系

```text
ArtifactSummary
  ├── kind: "file" | "patch" | "diff" | ...
  └── payloadRef

DiffSummary
  ├── artifactId
  ├── files
  └── patchRef
```

业务上：

- artifact 是 Workspace 中的实体。
- diff 是 artifact 的一种结构化描述。
- patch 原文通过 `patchRef` 懒加载。
- apply 前需要校验 `baseHash`。

---

# 15. 对当前 core-type 设计的评价与改进建议

## 15.1 当前设计比较好的地方

### 1. Session / Turn 分离是正确的

这是生产级 Agent 系统里非常关键的设计。  
如果把模式绑定在 session 上，后面会很难支持同一对话中临时切换 Agent / Narrative / Chat。

### 2. RuntimeInputEnvelope 的 raw / assembled 隔离非常重要

这是避免 RAG / Memory 系统污染历史的关键。  
很多 Agent 项目的“记忆幻觉”都来自把召回材料误写成用户原话。

### 3. Provider / Model 抽象已经具备扩展性

`ProviderDescriptor`、`ModelDescriptor`、`ModelCapabilities`、`ChatCompletionRequest` 能支撑多模型、多 provider、多能力校验。

### 4. Event 协议比较完整

已经覆盖：

- turn 生命周期
- context snapshot
- 文本流
- render block
- step timeline
- 工具调用
- 权限请求
- artifact
- diff
- usage
- warning
- failure

这已经接近一个正经 Agent IDE / Workspace 的事件层。

### 5. Memory 分层清晰

L1 / L2 / L3 / L4 的分层比较适合后续扩展 role-play agent、agent reflect、长期用户画像、narrative world recall。

---

## 15.2 可以继续补强的地方

### 建议 1：统一 ID 命名

现在有：

- `requestId`
- `toolCallId`
- `callId`
- `toolId`
- `id`

建议后续在文档中明确：

| 名称 | 含义 |
|---|---|
| `requestId` | turn 级 ID |
| `sessionId` | 会话 ID |
| `messageId` | 消息 ID |
| `toolCallId` | 工具调用 ID |
| `permissionRequestId` | 权限请求 ID |
| `artifactId` | Workspace 产物 ID |
| `traceId` | 全链路追踪 ID |

特别是 `PermissionDecision.requestId` 字段目前容易和 turn 的 `requestId` 混淆，可以考虑改成：

```ts
permissionRequestId: string;
```

---

### 建议 2：`ContextSourceView.source` 与 `ContextSource` 可以考虑统一

当前：

```ts
ContextSource =
  | "system_prompt"
  | "rolling_summary"
  | "recent_messages"
  ...
```

而 `ContextSourceView.source` 是：

```ts
"recent_messages" | "summary" | "memory" | "attachment" | "workspace" | "narrative" | "system"
```

一个偏精细，一个偏 UI 聚合。  
这是可以接受的，但建议命名上区分：

```ts
ContextSource      // runtime 精细来源
ContextSourceGroup // UI 聚合来源
```

---

### 建议 3：`ProviderDescriptor.kind` 当前混合了接入方式和能力类别

现在：

```ts
kind: ProviderKind | "llm" | "embedding" | "reranker" | "tts" | "stt" | "vision";
```

这里把“接入协议”和“服务类别”混在了一起。

更清晰的设计可以是：

```ts
interface ProviderDescriptor {
  kind: ProviderKind;
  categories: ProviderCategory[];
}

type ProviderCategory =
  | "llm"
  | "embedding"
  | "reranker"
  | "tts"
  | "stt"
  | "vision";
```

这样一个 provider 可以同时支持 LLM + embedding，而不会让 `kind` 语义混乱。

---

### 建议 4：`ModelDescriptor` 的旧字段可以逐步收敛

现在同时有：

```ts
capabilities?: ModelCapabilities;
supportsStreaming: boolean;
supportsTools: boolean;
supportsVision: boolean;
```

这是为了兼容旧代码。后面可以统一成：

```ts
capabilities: ModelCapabilities;
```

旧字段通过 getter 或迁移层处理。

---

### 建议 5：`ToolSpec.parameters` 可以进一步收紧成 JSON Schema 类型

当前：

```ts
parameters: Record<string, unknown>;
```

建议后续定义：

```ts
type JsonSchema = {
  type: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  enum?: string[];
};
```

这样工具声明更强类型，也更适合做工具表单自动渲染。

---

### 建议 6：`RenderBlock.table.rows` 目前只能是字符串二维数组

当前：

```ts
rows: string[][];
```

如果后面要支持复杂单元格，比如链接、代码、badge、状态标签，可以考虑：

```ts
type TableCell = string | RenderBlock;
rows: TableCell[][];
```

不过 V1 保持简单是合理的。

---

### 建议 7：`MemoryWriteRequest.payload: unknown` 需要运行时 schema

`payload` 使用 unknown 是灵活的，但实际写入不同 layer 时应配套 zod schema，例如：

```ts
l1_scratchpad -> AgentWorkingMemory patch
l2_conversation -> ChatMessage / RollingSummary
l3_identity -> AgentSessionIdentity
l4_profile -> UserProfile
```

否则 memory runtime 内部容易出现类型分支膨胀。

---

# 16. 推荐的工程落地分层

基于这些 core types，推荐项目中按下面方式使用：

```text
packages/core-types
  只放类型、schema、轻量工具函数，不依赖业务实现

packages/session-runtime
  消费 SessionState / ChatMessage / SessionRepository

packages/turn-runtime
  消费 StartTurnRequest / TurnRecord / EmaStreamEvent

packages/memory-runtime
  消费 RecallRequest / RecallResult / ContextBlock

packages/model-runtime
  消费 ChatCompletionRequest / ChatCompletionChunk / ProviderDescriptor / ModelDescriptor

packages/artifact-runtime
  消费 ArtifactSummary / DiffSummary

apps/server
  负责 HTTP API、SSE 编码、权限网关、存储接入

apps/web
  负责 UI 渲染：SessionList、ChatPane、WorkspacePane、StepTimelinePane、ContextRadarPane
```

---

# 17. 典型数据流示例

## 17.1 普通 Chat 模式

```text
StartTurnRequest(mode="chat")
  ↓
读取 SessionState.messages
  ↓
RecallRequest(mode="chat")
  ↓
RollingSummary + RecentMessages → ContextBlock[]
  ↓
RuntimeInputEnvelope
  ↓
ChatCompletionRequest
  ↓
ChatCompletionChunk
  ↓
output_text_delta
  ↓
ChatMessage(role="assistant")
  ↓
TurnRecord(status="completed")
```

---

## 17.2 Agent 工具模式

```text
StartTurnRequest(mode="agent")
  ↓
AgentWorkingMemory 初始化
  ↓
context_snapshot
  ↓
step_started(thinking)
  ↓
ChatCompletionRequest(tools=ToolSpec[])
  ↓
tool_call_requested
  ↓
permission_required
  ↓
permission_resolved
  ↓
tool_call_output
  ↓
artifact_upserted / diff_ready
  ↓
usage_report
  ↓
turn_completed
```

---

## 17.3 Narrative 模式

```text
StartTurnRequest(mode="narrative")
  ↓
NarrativeBridgeQuery
  ↓
Python Bridge / LightRAG
  ↓
NarrativeBridgeResult
  ↓
ContextBlock(source="narrative_world")
  ↓
RuntimeInputEnvelope
  ↓
ChatCompletionRequest
  ↓
render_block / output_text_delta / stage_cue
```

---

# 18. 最终总结

这套 core-type 已经不是简单的“类型声明”，而是一套完整的 EmaAgent V1 协议层设计。它覆盖了：

- 多模式 turn 执行
- session 与 turn 分离
- 原始输入与运行时 prompt 隔离
- 多 provider / 多模型适配
- 四层记忆与召回
- Agent 工具调用和权限控制
- Workspace artifact 与 diff
- 前后端 SSE 事件协议
- 结构化渲染协议
- UI 错误协议
- trace / usage / recall / safety 元数据

如果后续要继续写生产级实现，建议优先围绕这几个 runtime 落地：

1. `turn-runtime`：负责 StartTurnRequest → EmaStreamEvent → TurnRecord  
2. `model-runtime`：负责 ChatCompletionRequest → ChatCompletionChunk  
3. `memory-runtime`：负责 RecallRequest → ContextBlock[]  
4. `session-runtime`：负责 SessionState / ChatMessage 持久化  
5. `artifact-runtime`：负责 ArtifactSummary / DiffSummary / payloadRef  
6. `api-gateway`：负责 HTTP、SSE、错误转换、权限流转  

这样 core-types 就能真正成为前后端、runtime、UI、storage、LLM provider 之间的稳定契约。
