# @ema-agent/tts

句级流式 TTS 管道。LLM 流式输出是带 Markdown 的乱流,TTS 要的是干净完整句子--本包在两者之间搭桥。支持声音克隆(参考音频复刻音色)和系统预设音色,适配器统一接口。

## 架构

```
output_text_delta(emotion 包已剥 ACT)
   │
   ▼
TextFilterStream        块级清洗(代码块/数学块 -> 替换词),跨 chunk 状态机
   │
   ▼
SentenceSplitter        句子边界检测,中英文混合标点,最短 4 字符
   │
   ▼
TtsClient.synthesize -> filterSentenceForTts(行内 markdown 清洗) -> TTS 适配器
   │
   ▼
FsAudioArchive          分段写盘 + Turn 结束按格式合并(不依赖 ffmpeg)
```

三层管道职责分离: 跨 chunk 状态在 TextFilterStream;完整句子上 regex 在 filterSentenceForTts;SentenceSplitter 只切句。ACT 标签由 `@ema-agent/emotion` 上游剥,TTS 不碰。

## 适配器

| 适配器 | protocol | 服务商 | 声音克隆 | 交付 |
|---|---|---|---|---|
| `OpenAiTtsAdapter` | `openai-tts` | 硅基流动 / OpenAI / 任意 OpenAI 兼容 | `uploadVoice()` | http_chunks |
| `GptSoVitsTtsAdapter` | `gpt-sovits-tts` | 本地 GPT-SoVITS | refAudioPath 直传 | http_chunks |
| `DashscopeTtsAdapter` | `dashscope-tts` | 阿里云 DashScope | `uploadVoice()` | 按模型分 |

DashScope 双协议路由(按模型前缀): `cosyvoice-*` 走 `wss://.../inference/` 二进制帧流式;`qwen*-tts*` 走 `wss://.../realtime` base64 PCM 攒完包 WAV 头一次性 emit(16MiB 上限)。V1 不做 WS 连接池(单用户 ~1 QPS)。

## Facade

| Facade | 职责 |
|---|---|
| `TtsClient` | 哑分发器:路由到适配器,热重载配置,`synthesize`/`probe`/`healthCheck`/`capabilitiesFor`。不感知角色卡/voice/路径/缓存 |
| `TtsCoordinator` | per-turn 流式封装:喂 `acceptTextDelta` -> 过滤 -> 分句 -> 串行合成 -> emit 事件 + 归档。`finish()`/`abort()` 幂等 |
| `FsAudioArchive` | 分段写盘 + Turn 结束合并;`findMergedFor` 供回放路由 |
| `TtsAdapter` | 扩展接口:`stream`/`capabilitiesFor`/`uploadVoice?`/`probe?` |

`TtsVoiceRef.refAudioPath` 是**绝对路径**(apps/core 从角色卡相对路径解析)。voice URI 缓存键 `tts.voiceUri.<cardId>.<providerId>.<model>`(DashScope voice ID 与模型绑定,跨模型不可复用)。

## 关键机制

- **并发**: V1 串行合成(`concurrency=1`),SSE 事件顺序与句子顺序一致,无需客户端重排
- **错误隔离**: 单句失败不中断链,作为 `system_warning` 事件推出,下一句照常合成
- **错误分类**: `errors.ts` 三函数(`classifyFetchError`/`classifyHttpStatus`/`classifyCloseCode`)归一到 `TtsErrorCode`(12 码:`permanent_*`/`transient_*`/`aborted`/`resource_exhausted`/`invalid_stream`/`unknown`),三 adapter 共用
- **限制**: `TtsLimits` 默认 `timeoutMsPerSentence=120s`、`maxBytesPerSentence=16MiB`;超限 -> `transient_timeout`/`resource_exhausted`
- **合并**(无 ffmpeg): mp3 剥 ID3 拼帧 / pcm 直拼 / wav 重写 RIFF(超 4GiB 抛错)/ 单段 copyFile / ogg+opus 不拼返回 null。流式复制,内存与音频体积无关

## 文件

| 文件 | 职责 |
|---|---|
| `streaming/text-filter.ts` | `TextFilterStream` 5 状态机(块级清洗)+ `filterSentenceForTts`(行内清洗,无状态) |
| `streaming/sentence-splitter.ts` | 句子边界检测 |
| `service.ts` | `TtsClient` 哑分发 + 合成限制 + 流终态校验 |
| `coordinator.ts` | `TtsCoordinator` per-turn 流式编排 |
| `archive.ts` | `FsAudioArchive` 分段写盘 + 格式合并 |
| `errors.ts` | `TtsErrorCode` + 三分类函数(三 adapter 共用) |
| `utils.ts` | `mimeForFormat`/`mimeFromExt`/`concatBytes`/`safeReadText`(三 adapter 共用) |
| `adapters/openai-tts.ts` / `gpt-sovits-tts.ts` / `dashscope-tts.ts` | 三协议适配器 |

## 不做

- 不做 LLM 调用(只合成;文本来自上游)
- 不剥 ACT 标签(由 `@ema-agent/emotion` 上游剥)
- 不做 WS 连接池(V1 单用户场景)
- 不依赖 ffmpeg(格式合并用字节拼接,ogg/opus 不拼)
- 不做声音管理(角色卡/voice profile/路径解析/URI 缓存都在 apps/core)
