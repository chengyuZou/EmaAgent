# @ema-agent/speech

当前可用语音生成入口是设置页 `SpeechVoicePreview`: 收集有界 PCM 后调用 `packPcmWav` 写入完整 WAV 文件头, 返回 `audio/wav`. 保留 TTS 实际返回的采样率和声道数, 不重新采样, 不启动转换子进程或创建临时文件. 试听 PCM 上限为 16 MiB, 结果不进入 Session storage 或 backup. `SentenceSplitter` 每句最多 200 个 UTF-16 code units, 无空白长文本也会切分, 不拆开代理对.

实时对话输出暂由 Server 的 `REALTIME_PCM_PLAYBACK_AVAILABLE` 条件暂停. 下述实时 Coordinator、分段归档和确认机制仍按 MP3 处理, 不能接收 `CallTts` 的裸 PCM 输出. 连续 WAV 播放、播放进度确认与整轮 WAV 归档接通前, 该路径不会创建实时合成或 MP3 资产.

Speech 是 Ema 的语音输出业务包。它旁路消费根 Turn 的文本增量，清理并切句后按顺序调用 `@ema-agent/tts`，把实时音频交给独立 Speech WebSocket，并把完整结果归档到当前 Session。Speech 的失败、积压与取消不改变文字 Turn 的终态。

```text
Turn output_text_delta
  -> TextFilterStream
  -> SentenceSplitter
  -> SpeechCoordinator
       |- CallTts(request)            单句协议调用（连接与模型在装配层冻结）
       |- SpeechEvent + binary audio 独立 WebSocket 控制帧与二进制帧
       |- UsageRecord                每句字符数和终态
       `- AudioArchive               Session 临时分段与最终归档
             |- segments/<turnId>/   合并前临时文件，完成或取消后删除
             `- merged/<turnId>.mp3  Turn 完整音频
```

`session_audio_changed { sessionId, turnId }` 只在合并音频写入 `speech_outputs`
后发送. Chat 用 `turnId` 只重读这一轮的音频可用状态, 临时分段和实时音频帧不触发
跨窗口统计刷新.

## 定死的边界

- 根 Turn 的语音接线由装配层 `startTurnSpeech` 建立：事件泵只把文字副本喂给 Speech，Turn 终态立即照常发布，不等待合成、播放或归档。
- `SpeechCoordinator` 每个 Turn 一个实例，顺序执行句子，拥有单句超时、单句 16 MiB 基础边界和取消；没有整轮音频上限。逐句 Usage 记账归它（sentenceId 与字符数只有这一层知道）。
- Speech WebSocket 的 `sentence_played` 确认把已生成未播放的完成句限制为 3 条；背压只暂停 Speech 生成，不反压 LLM Turn。
- `SpeechVoiceCache.prepare()` 只缓存当前 Node 进程内的 Provider 声音标识，不写 SQLite；缓存键包含角色、完整资源名与更新时间、Provider 和模型。
- `SpeechVoicePreview` 复用装配层按 providerId + modelId 即时冻结的同一对 TTS 入口，不建立第二套协议调用。
- `FsAudioArchive` 把结果写到 `{sessionsRoot}/{sessionId}/audio`，因此归档身份属于 Speech 而不是 TTS。
- 单句 segment 不进入 SQL、不存 Base64，也不是历史资产；它只用于长 Turn 的流式落盘与最终合并，合并成功或 Speech 取消后删除。
- `speech_outputs` 只登记合并后的完整 MP3，供 Assistant 消息历史重播。
- 实时音频和控制帧不进入 Turn SSE 或 `TurnEventStore`，Speech WebSocket 断线不补播；历史重播读取最终合并文件。
- 角色选择、Provider binding 与 TTS 入口创建由 Server 装配；本包不读取角色 Repo 或 Provider Repo。

## 不属于本包

- Provider HTTP/WebSocket 请求和声音注册属于 `@ema-agent/tts`。
- 音频转文字属于 `@ema-agent/stt`。
- Session/Turn 的创建、终态和消息持久化仍属于对应业务包。
