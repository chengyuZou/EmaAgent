# @ema-agent/llm

Ema 产品源码中的语言模型调用模块。它把 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 与 Gemini generateContent 转成统一的 `LlmRequest` 和 `LlmStreamChunk`，但不负责 Session、Turn 编排、上下文压缩或工具执行。

目录位于根 `src`，因为模型调用策略属于 Ema 产品能力；内部包名 `@ema-agent/llm` 只提供稳定的编译与依赖边界。

## 调用链

```text
Agent / Conversation / Memory
    ↓ LanguageModel
LanguageModelRuntime
    ↓ 获取 ProviderRuntimeEntry 原子快照
LlmRequestPreparer
    ├─ 复制轻量消息结构，不复制附件二进制
    ├─ 通过 Provider 注入的 Resolver 查询模型能力
    ├─ 执行 Adapter 前的最终媒体与协议门禁
    ├─ 保留 Context 已生成的 Tool Manifest 顺序
    └─ 按模型 maxOutput 裁剪调用方给出的输出预算
    ↓
LlmStreamRuntime
    ├─ 首个业务 Chunk 前重试
    ├─ 取消与熔断
    └─ 统一 done 终态校验
    ↓
Protocol Adapter
    ↓
OpenAI / Anthropic / Gemini API
```

`maxOutput` 是模型允许的输出上限，不是默认输出预算。请求未提供 `maxTokens` 时保持未指定；真正的上下文 Token 计算、历史裁剪和压缩由 Context 业务负责。

## 公共边界

| 类型 | 职责 |
|---|---|
| `LanguageModel` | 业务模块可见的调用接口。核心能力是 `stream` 与 `complete` |
| `LanguageModelRuntime` | Core 装配的运行实现，并提供 probe 与 Provider 热重载 |
| `LlmAdapter` | 单一 Provider 协议的流式转换接口 |
| `ModelCapabilityResolver` | Provider 模块注入的模型能力查询边界；LLM 不持有 Catalog |

业务模块依赖 `LanguageModel`，只有 Core 装配和 Provider 生命周期代码持有 `LanguageModelRuntime`。不要重新建立 `LlmRouter` 或强制增加 `LlmFacade`。

## 关键语义

- Provider 配置与 Adapter 保存在同一个 `ProviderRuntimeEntry` 中，热重载以完整 Map 换代；进行中的调用继续持有旧条目。
- 请求快照只复制数组和消息 Block 等结构，图片、音频和文件内容仍共享字符串或稳定引用。
- 历史媒体占位和本轮附件策略由 Context 负责；LLM 只保留 Adapter 前的最终 fail-closed 门禁，禁止 Hook 或 Tool 绕过能力检查。
- OpenAI Chat 只接受 `finish_reason`，Anthropic 只接受 `message_stop`，Gemini 只接受有效 `finishReason` 作为成功终态。自然断流抛出 `LlmStreamProtocolError`。
- Block Index 按 Provider 内容实际出现顺序连续分配，不使用 `1000 + index` 人工改变文本与工具顺序。
- 首个业务 Chunk 出现前可进行有界重试；已经向上游发送内容后不得从头重试，避免重复文本、Tool Call 和计费。
- Provider 明确拒绝 `temperature`、`thinking` 或 `toolChoice` 时，可以在总重试预算内省略对应可选参数。

## 文件

| 文件 | 职责 |
|---|---|
| `languageModel.ts` | 业务调用接口 |
| `languageModelRuntime.ts` | 调用入口、结果聚合、Usage 与运行时管理 |
| `providerRuntimeRegistry.ts` | ProviderConfig 与 Adapter 原子快照 |
| `llmRequestPreparer.ts` | 请求快照、能力和协议门禁、输出上限 |
| `streamRuntime.ts` | 熔断、首包前重试、取消和统一终态校验 |
| `adapters/*` | 四种协议与统一事件之间的转换 |
| `modelInputValidation.ts` | Adapter 前覆盖 Hook/Tool 新增内容的最终模型能力门禁 |
| `compatibilityRecovery.ts` | Provider 拒绝可选参数后的有界恢复 |
| `usage.ts` / `validate.ts` / `retry.ts` | Usage、协议内容校验和重试判断 |

## 不属于 LLM 模块

- Session、Turn、角色和 Narrative 业务；
- 历史 Token 计算、上下文裁剪、Summary 与 Compaction；
- Prompt 前缀策略、Tool Manifest 稳定化和历史媒体降级；
- 模型绑定和“应该选择哪个模型”的产品决策；
- Permission、Sandbox 和 Tool 执行；
- API Key 持久化与普通日志展示。
