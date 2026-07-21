# @ema-agent/token

Token 估算工具包。纯函数、零运行时依赖,给 memory(压缩触发/上下文预算)和 desktop-ui(流式 "~N tok" 占位显示)提供不调 API、不等 provider usage 的本地快速估算。

估算 ≠ 真实。计费/精确显示用 `afterLlmComplete` payload 的 `usage`,不用本包。本包用于容忍 ±15% 误差的决策。

## 估算公式

- **文本**:`ceil(ascii/4 + cjk/1.5)`--ASCII 4 字符/token,CJK 1.5 字符/token。Anthropic/OpenAI tokenizer 密度接近,一个 provider 无关的启发式覆盖两家
- **消息信封**:+10 / 条(role 标记 + 边界)
- **图片**:`max(85, min(5334, 像素/750))`,未知尺寸取 5334(保守)
- **音频**:`max(1, 秒*32)`,未知时长取 8000
- **文档**:`页*2000`,未知页数取 8000
- **tool_use**:`20 + args JSON 文本`
- **工具定义**:`20 + JSON 序列化文本`

fallback 取保守上限(宁可高估不低估,避免压缩判断漏判)。

## Facade

| Facade | 职责 |
|---|---|
| `estimateTextTokens(text)` | 纯文本估算(最底层,ASCII/CJK 双速) |
| `estimateMessagesTokens(messages)` | 消息数组估算,返回总数 |
| `estimateLlmInputTokens(messages, opts?)` | 完整估算,返回 `TokenEstimate`(含 breakdown + warnings + accuracy) |

`estimateMessagesTokens` 是 `estimateLlmInputTokens(...).totalTokens` 的简写。需要 breakdown/warnings 时直接调 `estimateLlmInputTokens`。

## 类型

- `TokenEstimate`:`{ totalTokens, accuracy, breakdown, warnings }`
- `TokenEstimateAccuracy`:`'heuristic' | 'modelAware' | 'providerExact'`--当前只实现 `heuristic`,另两档预留(精确需求时按 model 选 tokenizer 或调 provider API)
- `TokenEstimateWarningCode`:`imageDimensionsUnknown` / `audioDurationUnknown` / `documentPageCountUnknown` / `toolDefinitionSerializationFailed`--关键字段缺失用 fallback 时记
- `TokenEstimateBreakdown`:按类型细分(text/envelope/toolDef/image/audio/document/other)

## 文件

| 文件 | 职责 |
|---|---|
| `estimate.ts` | 3 个估算函数 + 私有 helper(媒体/工具/序列化估算) |
| `types.ts` | `TokenEstimate` / `Breakdown` / `Accuracy` / `WarningCode` / `Options` |
| `index.ts` | 统一出口(3 函数 + 5 类型) |

## 不做

- 不做精确计数(用 provider `usage`,不用本包)
- 不依赖 tokenizer 库(tiktoken 体积大 + provider 各异 + Anthropic 不开源)
- 不做异步估算(纯同步函数,engine 主循环附近可直接调)
- 不感知 provider(启发式 provider 无关)
