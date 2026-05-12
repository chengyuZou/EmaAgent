# EmaAgent `@ema-agent/llm` 包开发与测试文档

> **最后更新**: 2026-05-11  
> **包路径**: `EmaAgent/packages/llm/`

---

## 目录

- [一、架构总览](#一架构总览)
- [二、核心类型系统 (`types.ts`)](#二核心类型系统-typests)
- [三、适配器详解 (`adapters/`)](#三适配器详解-adapters)
  - [3.1 适配器接口 `LlmAdapter` (`base.ts`)](#31-适配器接口-llmadapter-basets)
  - [3.2 OpenAI 适配器 (`openai.ts`)](#32-openai-适配器-openaits)
  - [3.3 Anthropic 适配器 (`anthropic.ts`)](#33-anthropic-适配器-anthropicts)
  - [3.4 Gemini 适配器 (`gemini.ts`)](#34-gemini-适配器-geminits)
  - [3.5 system 消息处理对比（重点）](#35-system-消息处理对比重点)
  - [3.6 多模态 Part 类型支持矩阵](#36-多模态-part-类型支持矩阵)
  - [3.7 工具调用能力对比](#37-工具调用能力对比)
- [四、LlmRouter 总控制器 (`router.ts`)](#四-llmrouter-总控制器-routerts)
- [五、重试机制 (`retry.ts`)](#五重试机制-retryts)
- [六、模型目录 (`catalog.ts`)](#六模型目录-catalogts)
- [七、内容兼容性验证 (`validate.ts`)](#七内容兼容性验证-validatets)
- [八、测试架构](#八测试架构)
- [九、如何添加新供应商适配器](#九如何添加新供应商适配器)
- [十、常见问题 (FAQ)](#十常见问题-faq)

---

## 一、架构总览

### 1.1 分层架构

```
┌──────────────────────────────────────────────────────────────────┐
│                    引擎层 (session / apps)                         │
│    消费统一 LlmStreamChunk，不关心底层是哪个供应商                    │
├──────────────────────────────────────────────────────────────────┤
│                     LlmRouter (router.ts)                         │
│    · 路由分发：按 request.provider 找到对应适配器                    │
│    · 聚合：complete() = stream() + withRetry()                    │
│    · 热重载：upsertConfig() / removeConfig()                      │
├──────────┬──────────────────┬──────────────────┬─────────────────┤
│ OpenAI   │   Anthropic      │     Gemini       │  openai-compat  │
│ Adapter  │   Adapter        │    Adapter       │  (Ollama /      │
│(openai.ts)│ (anthropic.ts)  │   (gemini.ts)    │   DeepSeek..)   │
├──────────┴──────────────────┴──────────────────┴─────────────────┤
│                 统一类型 (types.ts)                                │
│   LlmRequest / LlmMessage / LlmStreamChunk / StopReason            │
├──────────────────────────────────────────────────────────────────┤
│               contracts 包 (跨包共享类型)                           │
│   LlmProvider / MessageContentPart / ErrorCode                     │
└──────────────────────────────────────────────────────────────────┘
```

### 1.2 数据流向

```
用户请求（LlmRequest）
    │
    ▼
LlmRouter.stream(request)
    │
    ├─ 查 adapters Map<LlmProvider, LlmAdapter>
    ├─ 找到对应适配器
    │
    ▼
adapter.stream(request, request.model)
    │
    ├─ 转换 LlmMessage[] → 供应商 SDK 消息格式
    ├─ 调用供应商 SDK 的 stream API
    ├─ 解析 SSE / 事件流
    │
    ▼
yield LlmStreamChunk (统一格式)
    │
    ▼
引擎消费:
  · text_delta         → 打字机输出
  · tool_use_delta     → 工具参数流式展示（可选）
  · tool_use_complete  → 触发工具执行
  · usage              → 记录 token 消耗
  · done               → 判断下一步动作（end_turn/tool_use/max_tokens）
```

### 1.3 核心设计思想

- **适配器模式（Adapter Pattern）**：对外暴露统一接口 `LlmAdapter`，对内各自处理供应商差异
- **类型闭合（Exhaustive Union）**：`LlmProvider` 是 `'openai' | 'openai-compat' | 'anthropic' | 'gemini'`，编译器保证 switch 完备
- **流式优先**：所有交互走 `stream()`，`complete()` 是 `stream()` 的聚合包装
- **不抛错原则**：validate 预检不抛错，返回 `UnsupportedPart[]` 让上层决定是否继续

---

## 二、核心类型系统 (`types.ts`)

### 2.1 `LlmProvider` — 供应商枚举

```typescript
// 定义在 @ema-agent/contracts，llm 包 re-export
type LlmProvider = 'openai' | 'openai-compat' | 'anthropic' | 'gemini';
```

- `'openai'` — 原生 OpenAI API（`https://api.openai.com/v1`）
- `'openai-compat'` — 任何 OpenAI 兼容 API（阿里云百炼、DeepSeek、Ollama、LM Studio 等）
- `'anthropic'` — 原生 Anthropic API
- `'gemini'` — 原生 Gemini API

### 2.2 `ProviderConfig` — 供应商配置

```typescript
interface ProviderConfig {
  provider: LlmProvider;     // 供应商类型标识
  apiKey: string;            // API Key（V1 明文，V2 计划用 Stronghold 加密）
  baseUrl?: string;          // 自定义端点 URL
                             //   · openai-compat: 必填
                             //     e.g. 'https://dashscope.aliyuncs.com/compatible-mode/v1'
                             //   · openai/anthropic/gemini: 可选，覆盖默认地址
  defaultModel?: string;     // 默认模型名
}
```

### 2.3 `LlmMessage` — 统一消息格式

```typescript
type LlmMessage =
  | { role: 'system';    content: string }
  | { role: 'user';      content: string | LlmContentPart[] }
  | { role: 'assistant'; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: 'tool';      toolCallId: string; content: string };
```

**设计要点**：
- 这是所有适配器的**输入格式**，各适配器自行转换为供应商的 wire format
- `system` 角色：OpenAI 当作普通 message 传；Anthropic/Gemini 提取到顶层参数（详见 §3.5）
- `user` 角色：可以是纯文本 string，也可以是多模态 `LlmContentPart[]`
- `assistant` 角色：content 可为 null（纯工具调用），toolCalls 可选
- `tool` 角色：连续的 tool 结果在 Anthropic/Gemini 中会被合并为同一个 turn

### 2.4 `LlmContentPart` — 多模态内容片段

```typescript
// re-export from contracts as MessageContentPart
type LlmContentPart = MessageContentPart =
  | { type: 'text';       text: string }
  | { type: 'image_url';  url: string }
  | { type: 'image_data'; data: string; mimeType: string }
  | { type: 'audio_data'; data: string; mimeType: string }
  | { type: 'file_url';   url: string;  mimeType: string }
  | { type: 'file_data';  data: string; mimeType: string };
```

### 2.5 `LlmRequest` — 统一请求

```typescript
interface LlmRequest {
  provider: LlmProvider;         // 路由到此供应商
  model: string;                 // 供应商原始模型名，e.g. 'gpt-4o', 'claude-opus-4-5'
  messages: LlmMessage[];        // 对话历史（含 system）
  tools?: LlmToolDef[];          // 工具定义列表
  toolChoice?: 'auto' | 'none' | { name: string };  // 工具调用策略
  maxTokens?: number;            // 最大输出 token 数
  temperature?: number;          // 采样温度
  signal?: AbortSignal;          // 用户取消信号（Stop 按钮）
}
```

### 2.6 `LlmStreamChunk` — 统一流式输出

```typescript
type LlmStreamChunk =
  | { type: 'text_delta';        delta: string }
  | { type: 'tool_use_delta';    callId: string; name: string; argsDelta: string }
  | { type: 'tool_use_complete'; callId: string; name: string; args: unknown }
  | { type: 'usage';             inputTokens: number; outputTokens: number }
  | { type: 'done';              stopReason: StopReason };
```

**Chunk 发出顺序保证**：

```
text_delta*                    ← 文本增量（逐 token）
  → (tool_use_delta*           ← 工具参数增量（逐 token）
    → tool_use_complete) *     ← 工具参数收集完毕（JSON 对象）
  → usage                      ← token 用量
  → done                       ← 最终停止原因
```

**注意**：Gemini 适配器**不会发出 `tool_use_delta`**，因为 Gemini SDK 不支持工具参数流式，直接一次性返回完整的 functionCall。

### 2.7 `StopReason` — 停止原因

```typescript
type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
```

| 值 | 含义 | 引擎行为 |
|---|---|---|
| `'end_turn'` | 正常结束 | 写入 DB，结束本轮 |
| `'tool_use'` | 模型请求工具调用 | 执行工具，继续 agent loop |
| `'max_tokens'` | 达到 maxTokens 上限 | 可能需要 compaction 后重试 |
| `'stop_sequence'` | 命中自定义停止词 | 通常等同于 end_turn |

### 2.8 `LlmCompletion` — 非流式聚合结果

```typescript
interface LlmCompletion {
  text: string | null;       // 完整文本回复
  toolCalls: LlmToolCall[];  // 所有工具调用
  stopReason: StopReason;    // 停止原因
  usage: { inputTokens: number; outputTokens: number };
}
```

由 `LlmRouter.complete()` 生成，内部将 `stream()` 的所有 chunk 折叠为一个对象。

---

## 三、适配器详解 (`adapters/`)

### 3.1 适配器接口 `LlmAdapter` (`base.ts`)

```typescript
// base.ts — 完整源码
import type { LlmRequest, LlmStreamChunk } from '../types.js';

export interface LlmAdapter {
  /**
   * @param request   Full request (messages, tools, signal, …)
   * @param modelName The model name, e.g. "gpt-4o"
   */
  stream(request: LlmRequest, modelName: string): AsyncIterable<LlmStreamChunk>;
}
```

**接口契约**：
- 入参：统一的 `LlmRequest` + 单独的 `modelName`（从 request 中拆出，方便显式传参）
- 出参：`AsyncIterable<LlmStreamChunk>` — 生成器函数 `async *stream()`
- 适配器**不处理重试**，重试在 `LlmRouter.complete()` 层统一完成
- 适配器**不处理内容验证**，验证在 `validateContentParts()` 中预先完成

### 3.2 OpenAI 适配器 (`openai.ts`)

**服务范围**：`openai` 和 `openai-compat` 两个 provider 使用同一适配器

#### 3.2.1 构造函数

```typescript
constructor(config: ProviderConfig) {
  this.client = new OpenAI({
    apiKey:  config.apiKey,
    baseURL: config.baseUrl,  // ← openai-compat 的关键：覆盖默认 endpoint
  });
}
```

`openai-compat` 的工作原理：只需传入不同的 `baseURL`，其余完全复用 OpenAI SDK。
例如阿里云百炼：`baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1'`。

#### 3.2.2 消息转换 (`toOpenAiMessages`)

**🔴 system 消息处理**：

```typescript
// system 直接在 messages 数组内，作为普通 message
if (msg.role === 'system') {
  return { role: 'system', content: msg.content };
}
```

**user + string**（纯文本）：
```typescript
// LlmMessage:  { role: 'user', content: '你好' }
// OpenAI SDK:  { role: 'user', content: '你好' }
```

**user + `LlmContentPart[]`**（多模态）：
```typescript
// 遍历 content 数组，逐个转换：
for (const part of msg.content) {
  if (part.type === 'text') {
    content.push({ type: 'text', text: part.text });
  }
  if (part.type === 'image_url') {
    // 注意嵌套结构：image_url 字段包含 { url } 对象
    content.push({ type: 'image_url', image_url: { url: part.url } });
  }
  if (part.type === 'image_data') {
    // base64 数据转为 data URL 格式
    content.push({ type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } });
  }
  if (part.type === 'audio_data') {
    // 仅接受 wav 和 mp3/mpeg
    const fmt = part.mimeType === 'audio/wav' ? 'wav'
              : part.mimeType === 'audio/mpeg' || part.mimeType === 'audio/mp3' ? 'mp3'
              : null;
    if (fmt) {
      content.push({ type: 'input_audio', input_audio: { data: part.data, format: fmt } });
    }
  }
  // file_data / file_url → 跳过（不支持，依赖 validate 预检拦截）
}
```

**assistant**（含工具调用）：
```typescript
if (msg.role === 'assistant') {
  const toolCalls = msg.toolCalls?.map(tc => ({
    id:       tc.id,
    type:     'function',
    function: { name: tc.name, arguments: JSON.stringify(tc.args) },
  }));
  return { role: 'assistant', content: msg.content ?? null, tool_calls: toolCalls };
}
```

**tool**：
```typescript
if (msg.role === 'tool') {
  return { role: 'tool', tool_call_id: msg.toolCallId, content: msg.content };
}
```

#### 3.2.3 工具映射

```typescript
// LlmToolDef → OpenAI tool
function toOpenAiTool(tool: LlmToolDef) {
  return {
    type: 'function',
    function: {
      name:        tool.name,
      description: tool.description,
      parameters:  tool.parameters,  // JSON Schema 直接透传
    },
  };
}

// toolChoice 映射
function toOpenAiToolChoice(tc: LlmRequest['toolChoice']) {
  if (tc === undefined) return undefined;
  if (tc === 'auto')    return 'auto';            // 由模型决定
  if (tc === 'none')    return 'none';            // 强制不调用
  return { type: 'function', function: { name: tc.name } };  // 强制调用指定工具
  // ⚠️ 注意：只有当 tools 数组非空时才会设置 tool_choice
  // 如果 tools 为空或 undefined，tool_choice 保持 undefined
}
```

#### 3.2.4 流式处理 (`stream()`)

核心流程：
```
1. 发送请求（stream: true, stream_options: { include_usage: true }）
       ↓
2. 遍历 SSE chunk
       ↓
3. 按 chunk 类型分发：
   · delta?.content            → yield { type: 'text_delta', delta }
   · delta?.tool_calls         → 写入 toolBufs Map → yield { type: 'tool_use_delta', ... }
   · choice?.finish_reason     → 解析 toolBufs 中的 JSON → yield { type: 'tool_use_complete', ... }
   · chunk.usage               → yield { type: 'usage', inputTokens, outputTokens }
       ↓
4. 循环结束后 yield { type: 'done', stopReason }
```

**工具参数缓冲机制**：
```typescript
// OpenAI 的工具参数是增量式分多次返回的
// 例如：{"lo → cati → on": → "北 → 京" → }
// 适配器用 Map<index, buffer> 追踪每个工具调用的参数拼接状态

const toolBufs = new Map<number, { id: string; name: string; argsJson: string }>();

// 每次收到 delta.tool_calls：
for (const tc of delta.tool_calls) {
  const idx = tc.index;         // 工具调用在列表中的位置
  if (!toolBufs.has(idx)) {
    toolBufs.set(idx, { id: '', name: '', argsJson: '' });
  }
  const buf = toolBufs.get(idx)!;
  if (tc.id)                buf.id   = tc.id;          // 只出现一次
  if (tc.function?.name)    buf.name = tc.function.name;  // 只出现一次
  if (tc.function?.arguments) {
    buf.argsJson += tc.function.arguments;             // 累积拼接
    yield { type: 'tool_use_delta', callId: buf.id, name: buf.name, argsDelta: tc.function.arguments };
  }
}

// finish_reason 到达时：
for (const buf of toolBufs.values()) {
  let args: unknown = {};
  try { args = JSON.parse(buf.argsJson); } catch { /* keep {} */ }
  yield { type: 'tool_use_complete', callId: buf.id, name: buf.name, args };
}
```

**finish_reason 映射**：
```typescript
function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case 'tool_calls':     return 'tool_use';       // 模型请求工具调用
    case 'length':         return 'max_tokens';     // 达到 max_tokens 上限
    case 'content_filter': return 'stop_sequence'; // 内容过滤
    default:               return 'end_turn';       // stop / null
  }
}
```

### 3.3 Anthropic 适配器 (`anthropic.ts`)

#### 3.3.1 构造函数

```typescript
constructor(config: ProviderConfig) {
  this.client = new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,       // 可覆盖，阿里云百炼用 'https://dashscope.aliyuncs.com/apps/anthropic'
    // ⚠️ 不要带 /v1/messages 后缀，SDK 会自动追加
  });
}
```

#### 3.3.2 消息转换

**🔴 system 消息处理（最关键差异）**：

```typescript
// Anthropic SDK 的 system 是顶层参数，不在 messages 数组里！
// 流程：
// 1. 从 LlmRequest.messages 中提取所有 role: 'system' 的消息
// 2. 合并内容（多个 system → 换行拼接为一个字符串）
// 3. 传给 anthropic.messages.stream({ system: mergedSystem, messages: [...] })
// 4. 剩余 messages 不含 system 角色

// 伪代码：
const systemContent = request.messages
  .filter(m => m.role === 'system')
  .map(m => (m as SystemMessage).content)
  .join('\n\n');

const nonSystemMessages = request.messages.filter(m => m.role !== 'system');
```

**user + string / 多模态**：

```typescript
// user + string → { role: 'user', content: string }

// user + LlmContentPart[] → ContentBlock 数组
for (const part of content) {
  if (part.type === 'text')
    blocks.push({ type: 'text', text: part.text });

  if (part.type === 'image_url')
    blocks.push({ type: 'image', source: { type: 'url', url: part.url } });
    // 不含 detail 参数

  if (part.type === 'image_data')
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: part.mimeType,  // e.g. 'image/png'
        data: part.data,            // 不含 'data:...;base64,' 前缀
      }
    });

  if (part.type === 'file_data' || part.type === 'file_url')
    blocks.push({ type: 'document', source: ... });

  if (part.type === 'audio_data')
    // ❌ 不支持，validate 预检拦截
}
```

**assistant（含工具调用）**：

```typescript
// 关键：Anthropic 的 assistant 消息是 ContentBlock 数组
// text 和 tool_use 混在同一个 content 数组里

const content: Anthropic.ContentBlock[] = [];

// 先加文本（如果有）
if (msg.content) {
  content.push({ type: 'text', text: msg.content });
}

// 再加工具调用
for (const tc of msg.toolCalls ?? []) {
  content.push({
    type: 'tool_use',
    id:   tc.id,
    name: tc.name,
    input: tc.args,  // Anthropic 接受 JSON 对象而非字符串
  });
}

return { role: 'assistant', content };
```

**🔴 tool 结果（连续合并）**：

```typescript
// Anthropic 强制要求：连续的 tool_result 必须在同一个 user turn
// 所以适配器把连续的 role: 'tool' 消息合并到一个数组中

// 转换前：
//   { role: 'tool', toolCallId: 'a', content: 'resultA' }
//   { role: 'tool', toolCallId: 'b', content: 'resultB' }

// 转换后（合并为一个 user turn）：
//   { role: 'user', content: [
//     { type: 'tool_result', tool_use_id: 'a', content: 'resultA' },
//     { type: 'tool_result', tool_use_id: 'b', content: 'resultB' },
//   ] }
```

#### 3.3.3 工具映射

```typescript
// LlmToolDef → Anthropic tool
function toAnthropicTool(tool: LlmToolDef) {
  return {
    name:         tool.name,
    description:  tool.description,
    input_schema: tool.parameters,  // JSON Schema 直接透传
  };
}
```

**🔴 toolChoice: 'none' 的特殊处理**：

```typescript
// Anthropic 不支持 tool_choice: { type: 'none' }
// 当 toolChoice === 'none' 时，直接删掉 tools 数组
// 因为 Anthropic 的 'none' 含义是禁止调用工具，最简单的方式是不传 tools

if (request.toolChoice === 'none') {
  // 不传 tools 参数
} else {
  // 正常传 tools + tool_choice
}
```

#### 3.3.4 流式事件处理

Anthropic 使用 Server-Sent Events (SSE)，每个事件类型代表流中的不同阶段：

| 事件 | 含义 | 适配器处理 |
|---|---|---|
| `message_start` | 流开始 | 记录 message 对象（含 usage 初始值） |
| `content_block_start` | 新内容块开始 | 记录 block 类型（text / tool_use）和 index |
| `content_block_delta` | 内容块增量 | → `text_delta` (TextDelta) <br> → 缓冲 `input_json_delta` (InputJsonDelta) |
| `content_block_stop` | 内容块结束 | 如果当前是 tool_use block → 解析累积的 JSON → `tool_use_complete` |
| `message_delta` | 消息级增量 | → 最终 `usage` <br> → `stop_reason` 映射为 `StopReason` |
| `message_stop` | 流结束 | → `done` chunk |

**stop_reason 映射**：

```typescript
function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case 'end_turn':       return 'end_turn';
    case 'tool_use':       return 'tool_use';
    case 'max_tokens':     return 'max_tokens';
    case 'stop_sequence':  return 'stop_sequence';
    default:               return 'end_turn';
  }
}
```

**工具参数缓冲**（与 OpenAI 类似）：

```typescript
// Anthropic 的 JSON 参数也是增量式的
// 用 Map<index, buffer> 累积 input_json_delta
// content_block_stop 时解析完整 JSON

// 注意：Anthropic 的 callId 格式和 OpenAI 不同
// OpenAI: 'call_xxxx'
// Anthropic: 'toolu_xxxx'
```

### 3.4 Gemini 适配器 (`gemini.ts`)

#### 3.4.1 构造函数

```typescript
constructor(config: ProviderConfig) {
  this.client = new GoogleGenAI({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl ? `${config.baseUrl}/v1beta` : undefined,
    // Google 的原生端点或自定义代理
  });
}
```

#### 3.4.2 消息转换

**🔴 system 消息处理**：

```typescript
// Gemini 的 system 作为 systemInstruction 传给 getGenerativeModel()
// 不在 contents 数组里！与 Anthropic 类似但实现方式不同

// 流程：
// 1. 从 LlmRequest.messages 提取 role: 'system'
// 2. 合并所有 system 消息的内容
// 3. 构建 systemInstruction
// 4. 调用 getGenerativeModel({ model, systemInstruction })
// 5. 剩余 messages 进入 contents 数组
```

**role 映射表**：

| LlmMessage.role | Gemini role | 说明 |
|---|---|---|
| `system` | **不进入 contents** | 通过 systemInstruction 传递 |
| `user` | `'user'` | 直接映射 |
| `assistant` | `'model'` | ⚠️ 不是 `'assistant'`，是 `'model'` |
| `tool` | `'tool'` | functionResponse 嵌套 |

**多模态 parts 转换**：

```typescript
// 所有 content part 类型都走 inlineData
for (const part of contentParts) {
  if (part.type === 'text')
    parts.push({ text: part.text });

  if (part.type === 'image_url' || part.type === 'file_url') {
    // 仅接受 gs:// 或 Files API URI，否则 validate 预检拦截
    // 适配器内部不再检查
  }

  if (part.type === 'image_data' || part.type === 'audio_data' || part.type === 'file_data') {
    parts.push({
      inlineData: {
        mimeType: part.mimeType,
        data: part.data,      // base64 编码的数据（不含前缀）
      }
    });
  }
}
```

**🔴 tool 结果合并**（与 Anthropic 相同）：

```typescript
// 连续的 role: 'tool' 消息合并为一个 functionResponse 数组
// {
//   role: 'tool',
//   functionResponses: [
//     { id: 'a', name: 'get_weather', response: { ... } },
//     { id: 'b', name: 'search',      response: { ... } },
//   ]
// }
```

#### 3.4.3 工具映射

```typescript
// LlmToolDef → Gemini functionDeclaration
function toGeminiTool(tool: LlmToolDef) {
  return {
    functionDeclarations: [{
      name:        tool.name,
      description: tool.description,
      parameters:  tool.parameters,  // JSON Schema 直接透传
    }]
  };
}
```

**🔴 无 callId 的 Workaround**：

```typescript
// 问题：Gemini 的 functionCall 对象不包含 API 级别的唯一 callId
// 解决：在发送请求前，从 toolConfig 构建 callIdToName 反向映射表

const callIdToName = new Map<string, string>();

// 为每个 functionDeclaration 生成稳定的 callId
for (const decl of toolConfig.functionDeclarations) {
  // 用 name 的哈希作为 callId（确保同一轮请求中 callId 不变且唯一）
  // 也可以用递增编号 index-based
  const callId = generateCallId(decl.name);  // 实现细节见源码
  callIdToName.set(callId, decl.name);
}

// 收到 functionCall 时：
// 通过 functionCall.name 找到对应的 callId
// 然后 yield { type: 'tool_use_complete', callId, name, args }
```

#### 3.4.4 流式事件处理

```typescript
async *stream(request: LlmRequest, modelName: string) {
  // 1. 构建 model + systemInstruction
  const model = this.client.getGenerativeModel({
    model: modelName,
    systemInstruction: systemContent,
  });

  // 2. 发起流式调用
  const response = await model.generateContentStream({
    contents: convertedContents,
    tools:    geminiTools,
    generationConfig: {
      maxOutputTokens: request.maxTokens,
      temperature:     request.temperature,
    },
  });

  // 3. 遍历流
  for await (const chunk of response.stream) {
    // 手动检查 AbortSignal
    if (request.signal?.aborted) throw new Error('aborted');

    const candidate = chunk.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    for (const part of parts) {
      if (part.text) {
        yield { type: 'text_delta', delta: part.text };
      }
      if (part.functionCall) {
        // ⚠️ Gemini 返回完整 functionCall，不提供流式参数
        // 所以只出 tool_use_complete，没有 tool_use_delta
        const callId = callIdToName 反向查找...
        yield {
          type: 'tool_use_complete',
          callId,
          name: part.functionCall.name,
          args: part.functionCall.args,  // 已经是 JSON 对象
        };
      }
    }

    // usage 在 chunk.usageMetadata 中
    if (chunk.usageMetadata) {
      yield {
        type: 'usage',
        inputTokens:  chunk.usageMetadata.promptTokenCount,
        outputTokens: chunk.usageMetadata.candidatesTokenCount,
      };
    }
  }

  // 4. stopReason 映射
  yield { type: 'done', stopReason: mapGeminiStopReason(finishReason) };
}
```

**🔴 AbortSignal 手动检查**：

```typescript
// Gemini SDK 在构造时无法传入 AbortSignal
// 所以适配器在每个 chunk 循环中手动检查
if (request.signal?.aborted) {
  throw new Error('aborted');
}
```

### 3.5 system 消息处理对比（重点）

这是三供应商适配器的**最大差异点**，也是最容易出错的地方：

| 特性 | OpenAI | Anthropic | Gemini |
|---|---|---|---|
| **system 位置** | messages 数组内 <br> `{ role: 'system', content }` | SDK 顶层参数 <br> `{ system: ... }` | 模型构造参数 <br> `systemInstruction` |
| **提取方式** | 不需要提取 | 从 messages 过滤 + 合并 | 从 messages 过滤 + 合并 |
| **多 system 合并** | 不合并，逐条发送 | 合并为一个字符串/ContentBlock | 合并为一个 Content |
| **是否占用 messages slot** | 是（算一条 message） | 否（独立的字段） | 否（独立的字段） |

**代码对比**：

```typescript
// === OpenAI ===
// system 直接在 messages 里
messages: [
  { role: 'system', content: '你是助手' },
  { role: 'user',   content: '你好' },
]

// === Anthropic ===
// system 是顶层字段
{
  system: '你是助手',    // ← 单独提取出来
  messages: [
    { role: 'user', content: '你好' },  // ← 不含 system
  ]
}

// === Gemini ===
// system 是模型构造参数
const model = client.getGenerativeModel({
  model: 'gemini-2.0-flash',
  systemInstruction: '你是助手',  // ← 单独提取出来
});
// contents 不含 system
```

### 3.6 多模态 Part 类型支持矩阵

| Part 类型 | OpenAI | Anthropic | Gemini |
|---|---|---|---|
| `text` | ✅ | ✅ | ✅ |
| `image_url` | ✅ (https://) | ✅ (https://) | ⚠️ 仅 `gs://` 或 Files API URI |
| `image_data` | ✅ (转为 data URL) | ✅ (base64, jpeg/png/gif/webp) | ✅ (inlineData, 任意格式) |
| `audio_data` | ⚠️ 仅 wav/mp3/mpeg | ❌ | ✅ (inlineData) |
| `file_data` | ❌ (需 Files API) | ✅ (document block) | ✅ (inlineData) |
| `file_url` | ❌ (需 Files API) | ✅ (document block) | ⚠️ 仅 `gs://` 或 Files API URI |

**详细限制**：

**OpenAI**：
- `audio_data`：仅接受 `audio/wav`、`audio/mp3`、`audio/mpeg`
- `file_data` / `file_url`：不支持通过 messages 传输，需要先用 Files API 上传
- `image_data`：包装为 `data:{mimeType};base64,{data}` 格式的 URL

**Anthropic**：
- `image_data`：仅接受 `image/jpeg`、`image/png`、`image/gif`、`image/webp`
- `audio_data`：不支持
- `file_data` / `file_url`：支持，作为 document ContentBlock

**Gemini**：
- `image_url` / `file_url`：只接受 `gs://` 开头的 GCS URI 或 Files API URI，普通的 `https://` URL 会在运行时失败
- `image_data` / `audio_data` / `file_data`：全部通过 `inlineData` 传输

### 3.7 工具调用能力对比

| 特性 | OpenAI | Anthropic | Gemini |
|---|---|---|---|
| **工具参数流式** | ✅ 逐 token 流式 | ✅ 逐 token 流式 | ❌ 仅完整返回 |
| **发出 `tool_use_delta`** | ✅ | ✅ | ❌ |
| **toolChoice: 'none'** | `tool_choice: 'none'` | 不传 tools 数组 | 正常支持 |
| **强制指定工具** | `{ type: 'function', function: { name } }` | `{ type: 'tool', name }` | 正常支持 |
| **callId 格式** | `call_xxxx` | `toolu_xxxx` | **无原生 callId**<br>需手动构建反向映射 |
| **连续 tool 消息合并** | 不需要 | ✅ 合并为一个 user turn | ✅ 合并为一个 functionResponse |
| **AbortSignal 支持** | SDK 原生支持 | SDK 原生支持 | SDK 不支持<br>手动检查 `signal.aborted` |

---

## 四、LlmRouter 总控制器 (`router.ts`)

### 4.1 类设计

```typescript
export class LlmRouter {
  private readonly adapters = new Map<LlmProvider, LlmAdapter>();
  private readonly configs  = new Map<LlmProvider, ProviderConfig>();
  // ...
}
```

**双 Map 设计**：
- `adapters` Map：Provider → Adapter 实例（热路径，O(1) 查找）
- `configs` Map：Provider → ProviderConfig（供 `upsertConfig` / `removeConfig` 用）

### 4.2 构造函数

```typescript
constructor(
  configs: ProviderConfig[],
  adapterOverrides?: ReadonlyMap<LlmProvider, LlmAdapter>,
)
```

**两种初始化方式**：

1. **生产环境**（只传 configs）：
   ```typescript
   const router = new LlmRouter([
     { provider: 'openai',    apiKey: 'sk-...' },
     { provider: 'anthropic', apiKey: 'sk-...' },
     { provider: 'openai-compat', apiKey: 'sk-...', baseUrl: 'https://...' },
   ]);
   // 内部通过 createAdapter() 工厂创建适配器
   ```

2. **测试环境**（传 adapterOverrides）：
   ```typescript
   const mock = new MockAdapter([...testChunks]);
   const router = new LlmRouter(
     [OPENAI_CONFIG],
     new Map([['openai', mock]]),
   );
   // Mock 适配器会替代工厂创建的适配器
   ```

**工厂函数**：

```typescript
function createAdapter(config: ProviderConfig): LlmAdapter {
  switch (config.provider) {
    case 'openai':
    case 'openai-compat':  // ← 共用 OpenAiAdapter
      return new OpenAiAdapter(config);
    case 'anthropic':
      return new AnthropicAdapter(config);
    case 'gemini':
      return new GeminiAdapter(config);
  }
}
```

### 4.3 `stream()` — 流式路由

```typescript
stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
  const adapter = this.adapters.get(request.provider);
  if (!adapter) {
    const err = new Error('provider/not_configured');
    err.cause = request.provider;
    throw err;  // 同步抛错，引擎可 fail-fast
  }
  return adapter.stream(request, request.model);
}
```

**关键行为**：
- **同步抛错**：provider 未注册时立即抛出，不等到异步迭代
- **返回 AsyncIterable**：调用方用 `for await...of` 消费
- **不做重试**：重试在 `complete()` 层处理

### 4.4 `complete()` — 非流式聚合

```typescript
async complete(request: LlmRequest): Promise<LlmCompletion> {
  return withRetry(async () => {
    let text        = '';
    let stopReason  = 'end_turn' as StopReason;
    let inputTokens  = 0;
    let outputTokens = 0;
    const toolCalls: LlmToolCall[] = [];

    for await (const chunk of this.stream(request)) {
      switch (chunk.type) {
        case 'text_delta':         text         += chunk.delta; break;
        case 'tool_use_complete':  toolCalls.push({ id: chunk.callId, name: chunk.name, args: chunk.args }); break;
        case 'usage':              inputTokens   = chunk.inputTokens; outputTokens = chunk.outputTokens; break;
        case 'done':               stopReason    = chunk.stopReason; break;
      }
    }

    return { text: text || null, toolCalls, stopReason, usage: { inputTokens, outputTokens } };
  });
}
```

**用途**：内部调用（compaction / emotion extraction / plan parsing 等不需要流式展示的场景）

### 4.5 `probe()` — 健康检查

```typescript
async probe(provider: LlmProvider, model: string): Promise<ProbeResult> {
  const adapter = this.adapters.get(provider);
  if (!adapter) return { ok: false, error: `provider/not_configured...` };

  const start = Date.now();
  try {
    for await (const chunk of adapter.stream(
      { provider, model, messages: [{ role: 'user', content: 'hi' }], maxTokens: 1 },
      model,
    )) {
      if (chunk.type === 'done') break;
    }
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - start, error: (e as Error).message };
  }
}
```

**用途**：设置页面保存 API Key 时验证连通性

### 4.6 热重载

```typescript
// 更新 API Key 或切换 endpoint
upsertConfig(config: ProviderConfig): void {
  this.configs.set(config.provider, config);
  this.adapters.set(config.provider, createAdapter(config));
}

// 移除供应商
removeConfig(provider: LlmProvider): void {
  this.configs.delete(provider);
  this.adapters.delete(provider);
}
```

**注意**：
- `upsertConfig` 会**重建**适配器实例，旧的流式连接不受影响
- `removeConfig` 后，新的 `stream()` 调用会抛 `provider/not_configured`

---

## 五、重试机制 (`retry.ts`)

### 5.1 算法

```typescript
export interface RetryOptions {
  maxAttempts: number;   // 默认 3
  baseDelayMs: number;   // 默认 1000ms
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = { maxAttempts: 3, baseDelayMs: 1_000 },
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const s = httpStatus(e);

      // 立即抛错（不重试）
      if (s === 401 || s === 403) throw new Error('auth/api_key_invalid');  // 保留 cause
      if (s === 413)              throw new Error('provider/context_too_long');

      // 不可重试的错误 → 立即抛
      if (!isRetryable(e) || attempt === opts.maxAttempts - 1) throw e;

      // 指数退避
      await sleep(opts.baseDelayMs * 2 ** attempt);
    }
  }
  throw lastErr;
}
```

**重试延迟序列**（baseDelayMs = 1000）：

| 尝试次数 | 延迟 |
|---|---|
| 第 1 次失败 | 0ms（立即重试） |
| 第 2 次失败 | 1000ms |
| 第 3 次失败 | 2000ms |
| 第 4 次失败 | 抛出（maxAttempts=3） |

### 5.2 HTTP 状态码分类

| 状态码 | 行为 | 转换后的 ErrorCode |
|---|---|---|
| 401 | **立即抛错** | `auth/api_key_invalid` |
| 403 | **立即抛错** | `auth/api_key_invalid` |
| 413 | **立即抛错** | `provider/context_too_long` |
| 408 | ✅ 重试 | `provider/timeout`（耗尽后） |
| 429 | ✅ 重试 | `provider/rate_limit`（耗尽后） |
| 500-599 | ✅ 重试 | `provider/server_error`（耗尽后） |
| 其他 4xx | **立即抛错** | 原始 error |
| 非 HTTP 错误 | **立即抛错** | 原始 error |

**状态码提取逻辑**：

```typescript
function httpStatus(e: unknown): number {
  // 兼容不同的 HTTP client 库：status vs statusCode
  return (e as { status?: number })?.status
      ?? (e as { statusCode?: number })?.statusCode
      ?? 0;
}
```

### 5.3 使用方式

```typescript
// 在 LlmRouter.complete() 中自动包裹
async complete(request: LlmRequest): Promise<LlmCompletion> {
  return withRetry(async () => {
    // ... stream 聚合逻辑
  });
}

// stream() 调用不受 withRetry 保护
// 原因：流式场景下重试没有意义（用户已经看到部分输出）
```

---

## 六、模型目录 (`catalog.ts`)

### 6.1 数据结构

```typescript
interface ModelCapabilities {
  chat:        boolean;   // 是否支持基础对话
  tools:       boolean;   // 是否支持 Function Calling
  vision:      boolean;   // 是否支持图片输入
  jsonMode:    boolean;   // 是否支持 JSON 模式
  streaming:   boolean;   // 是否支持流式输出
  promptCache: boolean;   // 是否支持 Prompt Caching
}

interface ModelEntry {
  provider:      LlmProvider;
  model:         string;          // 供应商原始模型名，如 'gpt-4o'
  displayName:   string;          // 用户展示名，如 'GPT-4o'
  capabilities:  ModelCapabilities;
  contextWindow: number;          // 上下文窗口大小 (tokens)
  pricing?: {                     // 可选定价信息
    inputUsdPerMillion: number;
    outputUsdPerMillion: number;
  };
  isStatic:      boolean;         // true = 内置预设 / false = 运行时获取
}
```

**Key 设计**：

```typescript
function key(provider: LlmProvider, model: string): string {
  return `${provider}:${model}`;
}
// 例如：'openai:gpt-4o'、'anthropic:claude-sonnet-4-5'
```

### 6.2 ModelCatalog 类

```typescript
class ModelCatalog {
  private readonly entries = new Map<string, ModelEntry>();

  constructor(initial: ModelEntry[] = STATIC_MODELS) { ... }

  list(): ModelEntry[]                         // 列出所有模型
  get(provider, model): ModelEntry | undefined // 按 provider + model 查找
  upsert(entries: ModelEntry[]): void          // 添加或覆盖
  async refresh(provider: LlmProvider): void   // 远程获取（OpenRouter/Ollama）
}
```

### 6.3 内置预设模型

| Provider | Model | Context Window | 特点 |
|---|---|---|---|
| openai | gpt-4o | 128K | vision + jsonMode |
| openai | gpt-4o-mini | 128K | vision + jsonMode |
| openai | o3-mini | 200K | jsonMode |
| anthropic | claude-opus-4-5 | 200K | vision + promptCache |
| anthropic | claude-sonnet-4-5 | 200K | vision + promptCache |
| anthropic | claude-haiku-3-5 | 200K | vision + promptCache |
| gemini | gemini-2.0-flash | 1M | vision + jsonMode |
| gemini | gemini-2.5-pro | 1M | vision + jsonMode |
| openai-compat | deepseek-chat | 64K | jsonMode |
| openai-compat | deepseek-reasoner | 64K | jsonMode |

### 6.4 动态模型列表

```typescript
// ModelCatalog.refresh() 目前是 no-op
// 未来可对接 OpenRouter / Ollama 的模型列表 API
async refresh(_provider: LlmProvider): Promise<void> {
  // 按需实现 per-provider
}
```

---

## 七、内容兼容性验证 (`validate.ts`)

### 7.1 接口

```typescript
function validateContentParts(
  parts: LlmContentPart[],
  provider: LlmProvider,
): UnsupportedPart[]

interface UnsupportedPart {
  index: number;              // 在 parts 数组中的位置
  part: MessageContentPart;   // 原始 part 对象
  reason: string;             // 不兼容原因（中文描述）
}
```

**设计原则**：
- **不抛错**：返回 `UnsupportedPart[]` 让上层决定如何处理（警告用户 / 移除 / 取消）
- **一次性检查**：遍历所有 parts，返回所有不兼容项
- **用于 startTurn() 之前**：在实际 LLM 调用前预检，避免请求发出后失败

### 7.2 各供应商验证规则

**OpenAI / openai-compat**：

```typescript
function checkOpenAi(part: MessageContentPart): string | null {
  if (part.type === 'file_data' || part.type === 'file_url') {
    return 'OpenAI does not support inline file attachments — use the Files API separately';
  }
  if (part.type === 'audio_data') {
    const ok = part.mimeType === 'audio/wav'
            || part.mimeType === 'audio/mp3'
            || part.mimeType === 'audio/mpeg';
    if (!ok) return `OpenAI audio only accepts wav/mp3, got "${part.mimeType}"`;
  }
  return null;  // text, image_url, image_data 全部通过
}
```

**Anthropic**：

```typescript
function checkAnthropic(part: MessageContentPart): string | null {
  if (part.type === 'audio_data') {
    return 'Anthropic does not support audio input';
  }
  if (part.type === 'image_data') {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowed.includes(part.mimeType)) {
      return `Anthropic image only accepts jpeg/png/gif/webp, got "${part.mimeType}"`;
    }
  }
  return null;  // text, image_url, file_data, file_url 全部通过
}
```

**Gemini**：

```typescript
function checkGemini(part: MessageContentPart): string | null {
  if (part.type === 'image_url' || part.type === 'file_url') {
    if (!part.url.startsWith('gs://')) {
      return 'Gemini only accepts gs:// or Files API URIs for URL-based content — download the file and use image_data / file_data instead';
    }
  }
  return null;  // text, image_data, audio_data, file_data 全部通过
}
```

### 7.3 调用示例

```typescript
// 在 startTurn() 之前
const parts: LlmContentPart[] = [
  { type: 'text', text: '分析这张图' },
  { type: 'image_data', data: '...', mimeType: 'image/bmp' },
];

const issues = validateContentParts(parts, 'anthropic');
// issues = [{
//   index: 1,
//   part: { type: 'image_data', data: '...', mimeType: 'image/bmp' },
//   reason: 'Anthropic image only accepts jpeg/png/gif/webp, got "image/bmp"'
// }]

if (issues.length > 0) {
  // 提示用户，不要抛错终止
}
```

---

## 八、测试架构

### 8.1 测试文件概览

| 文件 | 类型 | 覆盖内容 |
|---|---|---|
| `router.test.ts` | 单元测试 | 路由分发、Mock 注入、错误处理、热重载 |
| `retry.test.ts` | 单元测试 | 重试逻辑、HTTP 状态码分类、maxAttempts |
| `catalog.test.ts` | 单元测试 | 模型 CRUD、get/upsert、多 provider 隔离 |
| `validate.test.ts` | 单元测试 | 全供应商 × 全 part 类型兼容性矩阵 |
| `live-aliyun.test.ts` | 集成测试 | 阿里云百炼真实 API 测试 |
| `live-aliyun-stream.test.ts` | 集成测试 | 工具参数流式、Anthropic 兼容测试 |
| `live-agent-async.test.ts` | 集成测试 | Agent 循环、并发流式 |

### 8.2 单元测试详解

#### `router.test.ts`

**Mock 适配器注入**：

```typescript
class MockAdapter implements LlmAdapter {
  readonly calls: { request: LlmRequest; modelName: string }[] = [];

  constructor(private readonly chunks: LlmStreamChunk[] = []) {}

  async *stream(request: LlmRequest, modelName: string): AsyncIterable<LlmStreamChunk> {
    this.calls.push({ request, modelName });  // 记录调用
    for (const chunk of this.chunks) yield chunk;
  }
}

// 使用
const mock = new MockAdapter(TEXT_CHUNKS);
const router = new LlmRouter(
  [OPENAI_CONFIG],
  new Map<LlmProvider, LlmAdapter>([['openai', mock]]),
);
```

**测试场景**：
- ✅ 正确路由到对应适配器并流式输出所有 chunk
- ✅ 传递 modelName 到适配器
- ✅ 传递完整请求（含 AbortSignal）
- ✅ 两个不同 provider 独立路由
- ✅ 未注册 provider 抛出 `unknown_provider`
- ✅ 同步抛错（fail-fast）
- ✅ `removeConfig` 后 provider 不可用
- ✅ tool_use_complete chunk 透传

#### `retry.test.ts`

**测试场景**：
- ✅ 第一次尝试成功（不重试）
- ✅ 429 重试后在第二次成功
- ✅ 500 + 503 重试后在第三次成功
- ✅ 408 超时重试
- ✅ 401 立即抛 `auth/api_key_invalid`（不重试）
- ✅ 403 立即抛 `auth/api_key_invalid`（不重试）
- ✅ 413 立即抛 `provider/context_too_long`（不重试）
- ✅ 原错误保留为 cause
- ✅ 非 HTTP 错误立即抛出
- ✅ 404 立即抛出
- ✅ 400 立即抛出
- ✅ maxAttempts 耗尽后抛出原始错误
- ✅ maxAttempts: 1（不重试）

#### `catalog.test.ts`

**测试场景**：
- ✅ `list()` 返回内置模型（> 5 个）
- ✅ 每项包含所有必填字段
- ✅ `get('openai', 'gpt-4o')` 正确返回
- ✅ Anthropic 模型的 promptCache 能力为 true
- ✅ 未知模型返回 undefined
- ✅ 错误的 provider 返回 undefined
- ✅ `upsert()` 添加新模型
- ✅ `upsert()` 覆盖已有模型
- ✅ 同名模型在不同 provider 下独立存储
- ✅ `list()` 包含 upsert 的条目
- ✅ 构造函数接受空数组
- ✅ 构造函数接受部分列表

#### `validate.test.ts`

**全矩阵测试**（OpenAI × Anthropic × Gemini）：

```
OpenAI / openai-compat:
  ✅ text, image_url, image_data, audio/wav, audio/mpeg
  ❌ file_data, file_url, audio/ogg

Anthropic:
  ✅ text, image_url, image/jpeg, image/png, image/gif, image/webp, file_data, file_url
  ❌ image/bmp, audio_data (所有)

Gemini:
  ✅ text, image_data, file_data, gs://image_url, gs://file_url
  ❌ https://image_url, https://file_url
```

**边缘用例**：
- ✅ 空数组返回无问题
- ✅ 问题对象包含原始 part 引用
- ✅ 返回正确的 index
- ✅ 混合有效 parts 无问题
- ✅ 一次遍历收集所有问题
- ✅ reason 字符串包含具体信息

### 8.3 集成测试详解（Live Tests）

**🔴 注意**：Live Tests 使用 `describe.only` 或 `describe.skip` 控制执行。这些测试需要真实的 API key 和网络连接，不应在 CI 中运行。

#### `live-aliyun.test.ts` — 阿里云百炼基础测试

**Provider 配置**：
```typescript
provider: 'openai-compat'
apiKey: 'sk-44b4x'
baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
```

**测试场景**：
1. **基础流式对话** — qwen-plus 模型，system prompt + 纯文本
   - 验证 `text_delta` 流式输出
   - 验证 `done: { stopReason: 'end_turn' }`
2. **Function Calling** — 工具定义 "get_weather"，参数 "北京"
   - 验证 `stopReason === 'tool_use'`
   - 验证 toolCalls 正确解析
   - 验证 args 为对象 `{ location: '北京' }`
3. **Vision 视觉** — qwen-vl-plus 模型，image_url 输入
   - 验证回复包含 "猫" 字眼

#### `live-aliyun-stream.test.ts` — 高级流式测试

**Provider 配置**：
```typescript
// OpenAI 兼容
{ provider: 'openai-compat', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }

// Anthropic 兼容（阿里云百炼支持）
{ provider: 'anthropic', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic' }
// ⚠️ 不要带 /v1/messages 后缀，SDK 自动追加
```

**测试场景**：
1. **工具参数流式生成** — 观察 `tool_use_delta` 的逐 token 输出
   - 验证最终 args JSON 拼接完整
   - 验证 `tool_use_complete` 的 name 和 args
2. **Anthropic 兼容端点** — qwen3.6-plus 通过 Anthropic 协议
   - 验证 system 单独传递正确
   - 验证 complete() 返回非空文本

#### `live-agent-async.test.ts` — Agent 异步循环测试

**测试场景**：

1. **Agent 工具循环** — 模拟完整的 agent loop：
   ```
   用户提问 → 流式第一轮（模型请求工具） → 
   模拟工具执行 → 流式第二轮（模型总结）
   ```
   - 验证在第一轮流中就拦截 `tool_use_complete`
   - 验证 `tool_use_complete` 不等 `done` 就触发
   - 验证第二轮回复包含工具结果内容

2. **真实并发流式迸发** — 三个任务同时流式：
   ```
   Task1: 文本复读（qwen-plus）
   Task2: 图片识别（qwen-vl-plus）
   Task3: 算术计算（qwen-plus）
   ```
   - ⚠️ 用 `Promise.all()` 等待三个独立流
   - ⚠️ 每个流内部直接 `for await`，不加 `await` 阻塞
   - 验证三个流真正交织执行而非串行
   - 验证视觉识别结果包含 "python"
   - 验证计算结果包含 "2"

### 8.4 运行测试

```bash
# 运行所有单元测试（不含 live tests）
cd EmaAgent
pnpm --filter @ema-agent/llm test

# 运行特定单元测试文件
pnpm --filter @ema-agent/llm test -- router.test.ts

# 运行 live tests（需要确保有网络和有效 API key）
# 临时移除 describe.only → describe，或直接指定文件
pnpm --filter @ema-agent/llm test -- live-aliyun.test.ts
```

**⚠️ 注意**：Live Tests 包含真实的 API key，不应提交到公开仓库。当前 API key 仅供内部测试使用。

---

## 九、如何添加新供应商适配器

假设要添加 `xai`（Grok）供应商。

### Step 1: 更新 contracts 类型

```typescript
// @ema-agent/contracts
type LlmProvider = 'openai' | 'openai-compat' | 'anthropic' | 'gemini' | 'xai';
```

### Step 2: 创建适配器 `adapters/xai.ts`

```typescript
import type { LlmAdapter } from './base.js';
import type { LlmRequest, LlmStreamChunk, ProviderConfig } from '../types.js';

export class XaiAdapter implements LlmAdapter {
  // 如果 xAI API 是 OpenAI 兼容的 → 继承或复用 OpenAiAdapter
  // 如果 xAI API 是自定义的 → 实现自己的转换逻辑

  constructor(config: ProviderConfig) {
    // 初始化 client
  }

  async *stream(request: LlmRequest, modelName: string): AsyncIterable<LlmStreamChunk> {
    // 1. 转换 messages
    // 2. 调用 SDK
    // 3. 解析响应 → yield LlmStreamChunk
  }
}
```

### Step 3: 在 router.ts 中注册

```typescript
// router.ts
import { XaiAdapter } from './adapters/xai.js';

function createAdapter(config: ProviderConfig): LlmAdapter {
  switch (config.provider) {
    case 'openai':
    case 'openai-compat': return new OpenAiAdapter(config);
    case 'anthropic':     return new AnthropicAdapter(config);
    case 'gemini':        return new GeminiAdapter(config);
    case 'xai':           return new XaiAdapter(config);     // ← 新增
  }
}
```

### Step 4: 在 validate.ts 中添加验证

```typescript
// validate.ts
function checkPart(part: MessageContentPart, provider: LlmProvider): string | null {
  switch (provider) {
    case 'openai':
    case 'openai-compat': return checkOpenAi(part);
    case 'anthropic':     return checkAnthropic(part);
    case 'gemini':        return checkGemini(part);
    case 'xai':           return checkXai(part);  // ← 新增
  }
}

function checkXai(part: MessageContentPart): string | null {
  // 定义 xAI 的支持和限制
  return null;
}
```

### Step 5: 在 catalog.ts 中添加模型预设

```typescript
const STATIC_MODELS: ModelEntry[] = [
  // ... 现有模型
  {
    provider: 'xai', model: 'grok-2', displayName: 'Grok 2',
    capabilities: cap({ vision: true }),
    contextWindow: 128_000, isStatic: true,
  },
];
```

### Step 6: 编写测试

```typescript
// tests/xai.test.ts
// tests/live-xai.test.ts (如果有真实 API key)
```

---

## 十、常见问题 (FAQ)

### Q1: 为什么 `openai-compat` 和 `openai` 共用同一个适配器？

因为它们使用相同的 wire protocol（OpenAI Chat Completions API），唯一区别是 endpoint URL。通过 `ProviderConfig.baseUrl` 覆盖即可，Ollama、LM Studio、DeepSeek、阿里云百炼等都兼容此协议。

### Q2: 为什么 Anthropic 的 system 消息不在 messages 里？

这是 Anthropic API 的设计决策。在 Anthropic 看来，system prompt 是"指令"而非"对话"，所以单独放在顶层 `system` 字段。适配器在转换时从 messages 中提取并移动到顶层。

**常见错误**：如果忘记提取 system，直接把 system 放在 messages 数组里传给 Anthropic SDK，API 会返回错误（`role "system" is not supported in messages`）。

### Q3: 为什么 Gemini 没有 `tool_use_delta`？

Gemini SDK 目前不支持工具参数的增量流式。它会一次性返回完整的 `functionCall` 对象，所以适配器只能发出 `tool_use_complete`。这是 Gemini API 的限制，不是适配器的设计缺陷。

### Q4: 什么时候用 `stream()` 什么时候用 `complete()`？

| 场景 | 使用 |
|---|---|
| 对话展示（打字机效果） | `stream()` |
| 工具调用的实时拦截 | `stream()` |
| Compaction（对话压缩） | `complete()` |
| Emotion extraction（情感提取） | `complete()` |
| Plan parsing（计划解析） | `complete()` |
| 不需要流式展示的内部调用 | `complete()` |

`complete()` 内部调用 `stream()` 并聚合结果，同时自动获得重试能力。

### Q5: 为什么 `LlmRouter.stream()` 不做重试？

重试对已经流式输出给用户的场景没有意义（用户已经看到部分内容）。重试仅在 `complete()` 层统一处理，用于非用户可见的内部调用。

### Q6: 如何注入 Mock 适配器进行测试？

```typescript
const mock = new MockAdapter([...testChunks]);
const router = new LlmRouter(
  [realConfig],
  new Map([['openai', mock]]),  // ← adapterOverrides 参数
);
// 现在 router.stream() 对 'openai' 调用会走 mock
```

### Q7: 工具调用的 callId 在各供应商中是什么格式？

| 供应商 | callId 格式 | 示例 |
|---|---|---|
| OpenAI | `call_` + 随机字符 | `call_abc123def` |
| Anthropic | `toolu_` + 随机字符 | `toolu_01XYZ...` |
| Gemini | **无原生 callId** | 适配器自行生成 |

Gemini 是特殊情况，因为其 `functionCall` 对象不含唯一 ID。适配器通过构建 `callIdToName` 反向映射来解决。

### Q8: 如何让阿里云百炼同时走 Anthropic 协议？

```typescript
const config: ProviderConfig = {
  provider: 'anthropic',
  apiKey: 'sk-...',
  baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
  // ⚠️ 不要加 /v1/messages，Anthropic SDK 会自动追加
};
```

阿里云百炼提供了 Anthropic 兼容的端点，可以直接用 `AnthropicAdapter` 连接。

---

## 附录：文件索引

| 文件 | 说明 |
|---|---|
| `src/index.ts` | 包的公共导出（barrel export） |
| `src/types.ts` | 所有核心类型定义 + 从 contracts re-export |
| `src/adapters/base.ts` | `LlmAdapter` 接口定义 |
| `src/adapters/openai.ts` | OpenAI / openai-compat 适配器 |
| `src/adapters/anthropic.ts` | Anthropic 适配器 |
| `src/adapters/gemini.ts` | Gemini 适配器 |
| `src/router.ts` | `LlmRouter` 总控制器 |
| `src/retry.ts` | `withRetry` 指数退避重试 |
| `src/catalog.ts` | `ModelCatalog` 模型目录 |
| `src/validate.ts` | `validateContentParts` 内容兼容性预检 |
| `tests/router.test.ts` | Router 单元测试 |
| `tests/retry.test.ts` | Retry 单元测试 |
| `tests/catalog.test.ts` | Catalog 单元测试 |
| `tests/validate.test.ts` | Validate 全矩阵测试 |
| `tests/live-aliyun.test.ts` | 阿里云百炼集成测试 |
| `tests/live-aliyun-stream.test.ts` | 阿里云流式+Anthropic 集成测试 |
| `tests/live-agent-async.test.ts` | Agent 异步循环+并发集成测试 |
