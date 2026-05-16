# EmaAgent `@ema-agent/llm` 包开发与测试文档

> **最后更新**: 2026-05-16  
> **包路径**: `EmaAgent/packages/llm/`

---

## 一、架构总览

### 1.1 分层架构

```
                                        引擎层 (session / apps)
                                   消费统一 LlmStreamChunk，不关心底层供应商
                                                  │
                                    LlmRouter (router.ts)
                          · 路由：按 request.providerId 找适配器实例
                          · 聚合：complete() = stream() + withRetry()
                          · 热重载：upsertConfig() / removeConfig()
                                                  │
            ┌─────────────┬───────────────┬───────────────┐
       OpenAiAdapter  AnthropicAdapter  GeminiAdapter    (openai-llm 协议
       (openai.ts)    (anthropic.ts)    (gemini.ts)       被 DeepSeek/SF 等复用)
            └─────────────┴───────────────┴───────────────┘
                                                  │
                              统一类型 (types.ts)
                  LlmRequest / LlmMessage / LlmStreamChunk / StopReason
                                                  │
                           contracts 包 (跨包共享类型)
                     LlmProtocol / MessageContentPart / ErrorCode
```

### 1.2 数据流向

```
LlmRequest { providerId: 'ds-001', model: 'deepseek-chat', messages: [...] }
    │
    ▼
LlmRouter.stream(request)
    │  Map<string, LlmAdapter> — key 是 provider instance id
    ├─ adapters.get('ds-001') → OpenAiAdapter
    │
    ▼
adapter.stream(request, 'deepseek-chat')
    ├─ 转换 LlmMessage[] → 供应商 SDK 消息格式
    ├─ 调用供应商 SDK 的 stream API
    ├─ 解析 SSE / 事件流
    │
    ▼
yield LlmStreamChunk (统一格式)
    │
    ▼
引擎消费:
  text_delta / tool_use_delta / tool_use_complete / usage / done
```

### 1.3 核心设计思想

- **适配器模式**：对外统一 `LlmAdapter` 接口，对内处理供应商差异
- **实例路由**：多个同协议 provider 靠 `provider_configs.id` 区分，不存在覆盖
- **流式优先**：所有交互走 `stream()`，`complete()` 是 `stream()` 的聚合
- **类型安全**：`LlmProtocol = Extract<ProtocolFamily, '${string}-llm'>` 自动同步

---

## 二、核心类型

### `ProviderConfig` — 供应商实例配置

```ts
interface ProviderConfig {
  id: string;              // provider_configs.id — 实例唯一标识
  provider: LlmProtocol;   // 线路格式 — 决定 adapter 类型
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}
```

`id` 是路由 key，`provider` 是 adapter 派发 key。

### `LlmRequest` — 统一请求

```ts
interface LlmRequest {
  providerId: string;   // 指向 provider_configs 表主键
  model: string;        // 如 "deepseek-chat"
  messages: LlmMessage[];
  tools?: LlmToolDef[];
  toolChoice?: 'auto' | 'none' | { name: string };
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}
```

### `LlmStreamChunk` — 统一流式输出

顺序：`text_delta* → (tool_use_delta* → tool_use_complete)* → usage → done`

---

## 三、适配器 (`adapters/`)

| 适配器 | 协议 | 支持能力 |
|--------|------|---------|
| `OpenAiAdapter` | `openai-llm` | text / image / audio / function calling |
| `AnthropicAdapter` | `anthropic-llm` | text / image / file / tool use |
| `GeminiAdapter` | `gemini-llm` | text / image / file / function calling |

所有适配器实现 `LlmAdapter` 接口，接收 `ProviderConfig` 在构造时传入。

---

## 四、LlmRouter (`router.ts`)

```ts
class LlmRouter {
  // provider id → adapter，不是 protocol → adapter
  private adapters: Map<string, LlmAdapter>;

  stream(request: LlmRequest): AsyncIterable<LlmStreamChunk>;
  complete(request: LlmRequest): Promise<LlmCompletion>;
  probe(providerId: string, model: string): Promise<ProbeResult>;
  firstProviderId(): string | undefined;       // fallback
  defaultModelFor(id: string): string | undefined;
}
```

多实例天然隔离：DeepSeek (`ds-001`) 和 SiliconFlow (`sf-001`) 同为 `openai-llm`，但 adapter 用不同 id 区分。

---

## 五、测试

```
tests/
├── router.test.ts              ← Mock 路由分发
├── catalog.test.ts             ← 模型目录
├── validate.test.ts            ← 内容兼容性
├── retry.test.ts               ← 重试逻辑
├── live-aliyun-stream.test.ts  ← 集成：流式 + 工具调用
├── live-agent-async.test.ts    ← 集成：并发隔离
└── live-agent-business.test.ts ← 集成：业务链
```

---

## 六、添加新供应商

**同协议品牌**（如 Kimi → `openai-llm`）：
1. `contracts/src/providers/kimi/index.ts` — 注册定义
2. `contracts/src/providers/registry.ts` — 加入 registry
3. **无需写 adapter**

**新协议**（如 Cohere LLM）：
1. `contracts` 加协议类型
2. `packages/llm/src/adapters/cohere.ts` — 实现 adapter
3. `router.ts` 加 switch 分支
4. `catalog.ts` 加模型 + `validate.ts` 加校验

---

## 七、FAQ

**`providerId` vs `LlmProtocol`？** `providerId` 是 DB 实例 id，`LlmProtocol` 是线路格式。同协议多品牌用不同 `providerId` 共存。

**chat 用 DeepSeek，agent 用 SiliconFlow？** 在 `model_bindings` 表绑定：
- `chat` → `ds-001` + `deepseek-chat`
- `agent` → `sf-001` + `Qwen2.5-72B`
