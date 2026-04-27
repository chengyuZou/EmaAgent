# @ema-agent/llm-runtime

## 一句话职责

LLM Provider 接入层：统一流式接口、多 provider 路由、原生 provider adapter、token usage 归一化。

## 上游依赖（我可以 import 谁）

- `@ema-agent/core-types` —— ModelDescriptor、ChatCompletionRequest、ChatCompletionChunk
- `@ema-agent/constants-core` —— 统一错误码等常量（当前 adapter 不直接依赖）

## 下游消费者（谁可以 import 我）

- `@ema-agent/orchestrator-runtime` —— 调用 LLM 完成对话
- `@ema-agent/memory-runtime` —— 调用 embedding 做向量召回
- `@ema-agent/narrative-runtime` —— 调用 LLM 生成剧情回复

## 对外接口

- `export interface LlmProvider` —— Provider 统一接口
- `export class OpenAINativeProvider` —— OpenAI Responses API 原生实现
- `export class AnthropicNativeProvider` —— Anthropic Messages API 原生实现
- `export class GeminiNativeProvider` —— Gemini GenerateContent API 原生实现
- `export class OpenAICompatibleProvider` —— `/chat/completions` 兼容基类
- `export class DeepSeekCompatibleProvider / OpenRouterCompatibleProvider / OllamaCompatibleProvider` —— 首发兼容层 provider
- `export { registerLlmProvider, streamComplete, completeText }` —— 多 provider 路由
- `export function estimateTokens()` —— Token 估算（budget 治理用）
- `export class LlmProviderError` —— provider 错误归一化

## 当前 Adapter

| Adapter | API | 支持能力 |
|---|---|---|
| `openai-native` | OpenAI `/responses` | 非流式、SSE 流式、function tools、usage、模型列表健康检查 |
| `anthropic-native` | Anthropic `/messages` | 非流式、SSE 流式、tool_use/tool_result、usage、模型列表健康检查 |
| `gemini-native` | Gemini `generateContent` / `streamGenerateContent` | 非流式、SSE 流式、functionDeclarations、usage、模型列表健康检查 |
| `openai-compatible` | `/chat/completions` | DeepSeek / OpenRouter / Ollama，非流式、SSE 流式、tool_calls、usage、模型列表健康检查 |

API key 只允许通过运行时配置或环境变量注入：

- OpenAI：`OPENAI_API_KEY`，可选 `OPENAI_ORG_ID` / `OPENAI_PROJECT_ID`
- Anthropic：`ANTHROPIC_API_KEY`
- Gemini：`GEMINI_API_KEY`，备用 `GOOGLE_API_KEY`
- DeepSeek：`DEEPSEEK_API_KEY`
- OpenRouter：`OPENROUTER_API_KEY`
- Ollama：本地默认不需要 key，可选 `OLLAMA_API_KEY`

SQLite 只能保存 `secret_handle` 或配置引用，不能写入明文 key。

## 禁止事项

- ❌ 禁止 import `orchestrator-runtime`（防止循环）
- ❌ 禁止包含 Ema 业务逻辑（如角色设定、模式切换）
- ❌ 禁止直接操作会话状态
- ❌ 禁止硬编码 API key（从 config-kernel 读取）
- ❌ 禁止把 vendor 原始 SSE 事件直接泄漏给上层
