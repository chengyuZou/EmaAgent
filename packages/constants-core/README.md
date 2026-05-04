# @ema-agent/constants-core

EmaAgent 集中式运行时常量包。所有跨包共用的硬编码值（阈值、超时、限额、枚举全集）集中于此，严禁在业务代码中裸写魔法数字/字符串。

## 原则

- 所有魔法数字和枚举字符串一律引用此包，不在业务代码中硬编码
- 类型由 `@ema-agent/core-types` 定义，本包只负责常量化
- 常量用 `as const satisfies` 确保类型安全和值不变

## 安装

```bash
pnpm add @ema-agent/constants-core
```

## 常量清单

### Agent / ReAct（`src/agent.ts`）

熔断保护、ReAct 状态机、工具分类：

```ts
import {
  REPEATED_ERROR_LIMIT,          // 连续同一错误达 3 次触发熔断
  DEFAULT_REACT_MAX_STEPS,        // ReAct 循环最大步数
  MAX_PARALLEL_READONLY_TOOLS,    // 只读工具最大并发数
  AGENT_RISK_LEVELS,             // ["low", "medium", "high", "critical"]
  REACT_STATUSES,                // ["idle", "thinking", "acting", "finished", "error"]
  REACT_STEP_TYPES,              // ["context", "thinking", "tool", "diff", "artifact", "response", "narrative_recall"]
  READ_ONLY_TOOL_PATTERNS,       // 只读工具名称匹配模式
  DANGEROUS_TOOL_NAMES,          // 危险工具名称集合
  DANGEROUS_FILE_OPERATIONS,     // 危险文件操作（delete/move/copy/rename）
  BUILTIN_TOOL_NAMES,            // 内置工具名称全集
} from "@ema-agent/constants-core"
```

### Model / Provider（`src/model.ts`）

Provider 类型、模型角色、默认上下文窗口和定价：

```ts
import {
  PROVIDER_CATEGORIES,           // ["llm", "vision", "tts", "stt", "embedding", "rerank", "image_gen", "moderation"]
  PROVIDER_KINDS,                // ["openai", "anthropic", "gemini", "openai-compatible", ...]
  PROVIDER_HEALTH_STATUSES,      // ["unknown", "ok", "degraded", "down", "disabled"]
  PROVIDER_PRIORITY,             // Provider 选择优先级（高→低）
  MODEL_ROLES,                   // 全部 11 种 ModelRole
  CHAT_MESSAGE_ROLES,            // ["system", "user", "assistant", "tool"]
  DEFAULT_CONTEXT_WINDOWS,       // 各 provider 默认上下文窗口
  DEFAULT_MAX_OUTPUT_TOKENS,     // 各 provider 默认最大输出 token
  FALLBACK_CONTEXT_WINDOW,       // 未知 provider fallback = 128_000
  FALLBACK_MAX_OUTPUT_TOKENS,    // 未知 provider fallback = 8_192
  DEFAULT_MODEL_IDS,             // 各 provider 默认模型 ID
  DEFAULT_PRICING,               // 默认定价（USD per 1M tokens）
} from "@ema-agent/constants-core"
```

### Multimodal（`src/multimodal.ts`）

音频、语音、图片生成、情感、Live2D、口型同步：

```ts
import {
  AUDIO_CODECS,                  // ["pcm_s16le", "mp3", "ogg_vorbis", "wav", "aac", "opus"]
  AUDIO_SAMPLE_RATES,            // [8000, 16000, 22050, 24000, 44100, 48000]
  AUDIO_CHANNELS,                // [1, 2]
  TTS_RESPONSE_FORMATS,          // ["mp3", "wav", "ogg", "opus", "pcm"]
  VOICE_EMOTIONS,                // 10 种语音情感
  IMAGE_GEN_STYLES,              // 10 种图片生成风格
  IMAGE_GEN_SIZES,               // ["256x256", "512x512", "1024x1024", ...]
  IMAGE_GEN_QUALITIES,           // ["standard", "hd", "ultra"]
  IMAGE_GEN_DEFAULTS,            // DALL-E 默认参数
  EMOTION_LABELS,                // 18 种 VAD 情感标签
  MODERATION_CATEGORIES,         // 9 种内容审核类别
  LIVE2D_EXPRESSIONS,            // 12 种 Live2D 表情
  LIVE2D_MOTIONS,                // 21 种 Live2D 动作
  LIVE2D_MOUTH_MODES,            // ["idle", "speaking", "smile", "open", "pout"]
  BREATH_LEVELS,                 // ["none", "light", "normal", "heavy"]
  PHONEME_SYMBOLS,               // 所有音素符号（日语音素 + ARPABET + 静音）
  PHONEME_DURATION_MS,           // 每个音节的估算时长
  PAUSE_DURATION_MS,             // 标点→静音时长映射
} from "@ema-agent/constants-core"
```

### Limits（`src/limits.ts`）

超时、字节限制、token 预算、分页默认值：

```ts
import {
  SHELL_TIMEOUT_MS,              // 30_000
  PYTHON_TIMEOUT_MS,             // 30_000
  HTTP_REQUEST_TIMEOUT_MS,       // 60_000
  STT_SILENCE_TIMEOUT_MS,        // 2_000
  TURN_LOCK_TIMEOUT_MS,          // 30_000
  PROVIDER_HEALTH_CHECK_TIMEOUT_MS, // 10_000
  COMMAND_MAX_OUTPUT_BYTES,      // 256_000
  FILE_READ_MAX_BYTES,           // 256_000
  MAX_SEARCH_FILES,              // 500
  ERROR_TEXT_TRUNCATE,           // 300
  ERROR_RAW_TRUNCATE,            // 500
  ATTACHMENT_MAX_BYTES,          // 10_000_000
  DEFAULT_CONTEXT_BUDGET,        // 8_000
  OUTPUT_TOKEN_RESERVE_RATIO,    // 0.25
  OUTPUT_TOKEN_RESERVE_CAP,      // 2_048
  CHARS_PER_TOKEN_ESTIMATE,      // 4
  RECENT_MESSAGES_PAGE_SIZE,     // 12
  SESSION_LIST_PAGE_SIZE,        // 20
  MEMORY_RECALL_LIMIT,           // 8
  SESSION_TITLE_MAX_LENGTH,      // 24
  TITLE_TRUNCATION_SUFFIX,       // "..."
  LOCAL_DEV_CHUNK_SIZE,          // 12
  LOCAL_DEV_CHUNK_DELAY_MS,      // 12
  LOCAL_DEV_TITLE_TRUNCATE,      // 18
  DEFAULT_FACT_CONFIDENCE,       // 0.8
  ROLLING_SUMMARY_PRIORITY,      // 80
  USER_PROFILE_PRIORITY,         // 60
  RECENT_MESSAGES_PRIORITY,      // 60
} from "@ema-agent/constants-core"
```

### HTTP（`src/http.ts`）

HTTP 状态码、可重试码、Provider API 错误模式分类、本地端口：

```ts
import {
  HTTP_STATUS,                   // { BAD_REQUEST: 400, UNAUTHORIZED: 401, NOT_FOUND: 404, ... }
  RETRYABLE_HTTP_STATUSES,       // Set<number> — 可自动重试的 HTTP 状态码
  isRetryableStatus,             // (status: number) => boolean
  API_VERSIONS,                  // { anthropic: "2023-06-01" }
  AUTH_ERROR_PATTERNS,           // ["401", "auth", "unauthorized", ...]
  RATE_LIMIT_ERROR_PATTERNS,     // ["429", "rate", "quota", "capacity", "overloaded"]
  MODEL_ERROR_PATTERNS,          // ["model", "not found", "not available", "deployment"]
  BFF_PORT,                      // 3421
  PYTHON_BRIDGE_PORT,            // 3422
  EDGE_TTS_PORT,                 // 3423
} from "@ema-agent/constants-core"
```

### Paths（`src/paths.ts`）

工作区路径、跳过目录、二进制文件识别：

```ts
import {
  WORKSPACE_TMP_DIR,             // ".ema-agent/tmp"
  DEFAULT_PYTHON_COMMAND,        // "python"
  SKIP_DIRECTORIES,              // ["node_modules", ".git", "dist", ...]
  BINARY_FILE_EXTENSIONS,        // Set<string> — 常见二进制文件扩展名
  isBinaryFile,                  // (ext: string) => boolean
} from "@ema-agent/constants-core"
```

## 架构规范

- 唯一依赖：`@ema-agent/core-types`（workspace protocol）
- 零运行时副作用，纯常量导出
- 所有导出均为 `readonly`，不可在运行时修改
- 使用 `NodeNext` module resolution，import 须带 `.js` 扩展名
