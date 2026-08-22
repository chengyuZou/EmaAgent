# @ema-agent/speech

Speech 是 Ema 的语音输出业务包。它把根 Turn 的文本增量清理并切句，按顺序调用 `@ema-agent/tts`，把音频投影为前端事件并归档到当前 Session。

```text
Turn output_text_delta
  -> TextFilterStream
  -> SentenceSplitter
  -> SpeechCoordinator
       |- TextToSpeech.synthesize()  单句协议调用
       |- SpeechEvent                sessionId + turnId
       |- UsageRecord                每句字符数和终态
       `- AudioArchive               Session 音频分段与合并
             |- segments/<turnId>/   可逐句使用的持久片段
             `- merged/<turnId>      Turn 完整音频
```

## 定死的边界

- `TurnSpeechOutput` 是根 Turn 流的可选装饰器，保证根终态最后发出。
- `SpeechCoordinator` 每个 Turn 一个实例，顺序执行句子，拥有超时、单句/单 Turn 字节上限和取消。
- `SpeechVoiceCache` 只缓存短期 Provider 声音标识，不写 SQLite；缓存键包含角色、Provider 配置和模型。
- `SpeechVoicePreview` 复用同一个 `TextToSpeech` 与声音准备路径，不建立第二套协议调用。
- `FsAudioArchive` 把结果写到 `{sessionsRoot}/{sessionId}/audio`，因此归档身份属于 Speech 而不是 TTS。
- `speech_segments` 登记成功完成的单句文件；失败半句与中止 Turn 不进入片段库。
- `speech_outputs` 只登记合并后的完整音频。合并成功不会再删除逐句片段。
- `SpeechSegmentLibrary` 在合并结束后按 `speech.segments.maxFiles` 与 `speech.segments.maxBytes` 删除最旧片段；生成途中不清理，避免最终合并缺句。
- 角色选择、Provider binding 与 `TextToSpeech` Map 由 Server 装配；本包不读取角色 Repo 或 Provider Repo。

## 不属于本包

- Provider HTTP/WebSocket 请求和声音注册属于 `@ema-agent/tts`。
- 音频转文字属于 `@ema-agent/stt`。
- Session/Turn 的创建、终态和消息持久化仍属于对应业务包。
