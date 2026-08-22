# @ema-agent/tts

TTS 是无 Session 状态的协议执行包：在创建点冻结协议连接与模型，分别产出音色注册与逐句合成两个调用函数，合成返回中立音频流。

```text
TtsConnection + modelId
  |- createTtsVoiceRegistrar(connection, modelId)
  |    `- TtsVoiceRegistrar(reference, signal?) -> TtsVoice
  `- createTtsCall(connection, modelId)
       `- CallTts(request) -> audio_chunk* -> done
```

## 定死的边界

- `createTtsVoiceRegistrar()` / `createTtsCall()` 是仅有的创建入口，连接与模型在创建点冻结；不维护 Provider Map 或配置热更新。
- `TtsVoiceRegistrar` 隐藏协议差异：GPT-SoVITS 返回本地参考音频，OpenAI 兼容和 DashScope 上传注册并返回 Provider 声音标识。
- `CallTts` 只执行一次协议调用；不切句、不重试、不设超时、不记录 Usage、不归档。
- `voice` 是 registrar 的异步产出，创建点同步执行时它还不存在，因此随 `TtsRequest` 传入；请求只有 `text/voice/format/sampleRate/speed/signal`，没有 `model/sessionId/turnId/providerId`。
- DashScope 的模型族（CosyVoice / Qwen TTS）在创建点判定，不支持的模型装配期即抛 `tts/unsupported_model`。
- 协议错误统一抛 `TtsError`；音频流必须以唯一 `done` 结束，公共入口校验字节统计。

## 协议目录

```text
protocols/
|- openAi.ts                 OpenAI 兼容 HTTP 音频流和声音上传
|- gptSoVits.ts              本地 GPT-SoVITS HTTP 音频流（载荷无模型字段）
`- dashscope/
   |- index.ts               创建点按模型选择 DashScope 二级协议
   |- cosyVoice.ts           CosyVoice task WebSocket
   |- qwenTts.ts             Qwen TTS Realtime WebSocket
   |- voiceEnrollment.ts     两个二级协议共用的声音注册入口
   `- socketEventQueue.ts    WebSocket 回调到 AsyncIterable 的一次共享桥
```

DashScope 是一个 Provider 协议族，但其 CosyVoice 与 Qwen TTS 的线协议、音频交付和终态完全不同，因此只在 `dashscope/` 内部分流，不提升为全局 Provider protocol。

## 不属于本包

角色选择、TTS binding、声音短期缓存、Markdown 清理、流式切句、逐句顺序、Turn 级字节上限、SSE 事件和音频归档统一属于 `@ema-agent/speech`。
