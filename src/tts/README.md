# @ema-agent/tts

TTS 执行供应商的音色注册和文本合成. 创建调用函数时固定协议连接与模型, 不保存 Session 状态. 合成依次返回音频格式、PCM 块和完成事件.

```text
TtsConnection + modelId
  |- createTtsVoiceRegistrar(connection, modelId)
  |    `- TtsVoiceRegistrar(reference, signal?) -> TtsVoice
  `- createTtsCall(connection, modelId)
       `- CallTts(request) -> audio_started -> audio_chunk* -> done
```

## 使用与职责

- `createTtsVoiceRegistrar()` / `createTtsCall()` 固定连接与模型, 不维护 Provider Map 或配置热更新.
- `TtsVoiceRegistrar` 处理音色准备: GPT-SoVITS 返回本地参考音频, SiliconFlow 和 DashScope 上传注册并返回 Provider 声音标识.
- `CallTts` 只执行一次文本合成, 不切句、不重试、不设超时、不记录 Usage、不归档.
- `voice` 是 registrar 的异步产出, 创建点同步执行时它还不存在, 因此随 `TtsRequest` 传入; 请求只有 `text/voice/speed/signal`, 没有 `model/sessionId/turnId/providerId`.
- DashScope 的模型族 (CosyVoice / Qwen TTS) 在创建点判定, 不支持的模型直接抛 `tts/unsupported_model`.
- 协议错误抛 `TtsError`. 成功流必须以一个 `done` 结束, 公共入口校验音频格式与字节统计.

## 音频契约

所有协议输出 signed PCM16LE, 不要求使用相同的采样率或声道数. `audio_started` 先交付实际格式, 后续 `audio_chunk.bytes` 只含样本, 不携带 WAV、MP3 或 AAC 文件头. `done.totalBytes` 只统计已交付的 PCM 字节.

每个块包含完整采样帧且不超过 8 KiB. 单声道的一帧为 2 字节; 双声道的一帧为 4 字节, 依次保存左、右采样. 网络切在帧中间时保留不足一帧的字节, 与下一块拼接; EOF 时仍有残帧则失败.

| 协议 | 请求与返回格式 |
| --- | --- |
| SiliconFlow | 明确请求 PCM 24 kHz, 按单声道样本处理, 不依赖供应商默认采样率 |
| DashScope CosyVoice | 明确请求 PCM 24 kHz, 按单声道样本处理 |
| DashScope Qwen TTS Realtime | 明确请求 PCM 24 kHz, 按单声道样本处理; 音频 delta 到达后即可交付 |
| GPT-SoVITS | 请求 WAV, 从文件头读取 PCM 格式, 保留实际采样率和声道数 |

GPT-SoVITS 的 WAV 读取支持跨网络块的文件头、扩展 `fmt ` 块和非音频块的跳过. 只接收线性 PCM16LE, 不做重采样、声道混合或压缩格式解码. 其流式响应使用 `data` 长度为 0 表示剩余响应直到 EOF 都是 PCM; 有明确长度时只读取该段样本, 不将尾部元数据当成声音. 零长度规则专用于 GPT-SoVITS 流式响应, 不是任意空 WAV 的读取规则.

`packPcmWav(chunks, format)` 同步给已经完成的 PCM 添加完整 WAV 文件头, 返回可播放的字节. 样本不改变, 不启动外部程序、不创建临时文件. 调用方必须限制音频总量; 当前消费方是 PCM 上限 16 MiB 的设置页试听, 不能用于整轮历史音频的全量下载或播放.

## 取消、失败与读取

HTTP 音频通过异步迭代逐块读取. 调用方暂不取下一块时, 本包不继续主动读取后续网络块, 但 Node 的输入流仍可保留自身的读取缓冲. 取消、格式错误或提前停止迭代时销毁输入, 不再继续下载这次合成结果. 非 16 位线性 PCM 的 WAV、截断文件头或残帧返回 `tts/invalid_response`.

DashScope WebSocket 回调通过 `SocketEventQueue` 交付音频. 队列尚未结束时收到取消或失败, 会丢弃未消费的队列项并通知等待者. 协议结束或调用方退出后结束连接. 该队列目前没有独立容量限制; 本包也不控制浏览器已播放多少, 不能据此声称整条语音链的内存具有固定上限.

## 协议目录

```text
protocols/
|- siliconFlow.ts            SiliconFlow HTTP 音频流和声音上传
|- gptSoVits.ts              本地 GPT-SoVITS HTTP 音频流, 载荷无模型字段
`- dashscope/
   |- index.ts               创建点按模型选择 DashScope 二级协议
   |- cosyVoice.ts           CosyVoice task WebSocket
   |- qwenTts.ts             Qwen TTS Realtime WebSocket
   |- voiceEnrollment.ts     两个二级协议共用的声音注册入口
   `- socketEventQueue.ts    WebSocket 回调到 AsyncIterable 的队列
```

DashScope 是一个 Provider 协议族, 其 CosyVoice 与 Qwen TTS 的消息和结束事件不同, 因此在 `dashscope/` 内分别处理.

## 不属于本包

角色选择、TTS binding、声音进程内缓存、Markdown 清理、流式切句、逐句顺序、单句超时与大小限制、Speech 事件和音频归档属于 `@ema-agent/speech`. Server 到 Desktop 的实时传输不属于 Provider 协议包.

测试入口为 `pnpm --filter @ema-agent/tts test`, 覆盖 HTTP / WebSocket 请求、跨块 WAV 读取、样本保持和取消. 模拟协议测试不能替代真实供应商与软件内试听验收.
