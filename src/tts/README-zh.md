# TTS

[English](README.md)

`@ema-agent/tts` 根据参考录音准备声音, 再用该声音合成文本. 它通过异步迭代依次交付音频格式, PCM 样本块和完成事件.

## 使用

为同一连接和模型创建声音注册函数与合成函数. 应用提供 `TTSVoiceReference`, 包含音频路径, 参考文本和语言, 资源名称和版本, 云端注册名称.

```ts
import {
  createTTSCall,
  createTTSVoiceRegistrar,
  type TTSVoiceReference,
} from '@ema-agent/tts';

async function synthesize(reference: TTSVoiceReference, text: string) {
  const connection = {
    protocol: 'gpt-sovits-tts',
    baseUrl: 'http://127.0.0.1:9880',
  } as const;
  const register = createTTSVoiceRegistrar(connection, 'local');
  const callTTS = createTTSCall(connection, 'local');
  const voice = await register(reference);

  for await (const event of callTTS({ text, voice })) {
    // Consume format, audio samples, then completion.
    console.log(event.type);
  }
}
```

示例要求 GPT-SoVITS 服务已启动, 并且能读取参考音频路径. 服务使用已经加载的权重, `/tts` 请求不包含模型 ID. 所有创建入口仍要求模型 ID 非空白.

GPT-SoVITS 请求固定使用 `text_lang: "auto"`, 包括混合语言文本, 由服务识别文本语言. `prompt_lang` 独立保留参考录音配置的真实语言. 自动识别不会翻译输入文本.

云端协议上传参考录音, 返回用于目标模型的供应商声音 ID. GPT-SoVITS 直接返回本地参考音频. 每次合成把这个结果作为 `voice`, 连同 `text`, 可选的 `speed` 和 `signal` 传入. 文本不能是空白, 速度必须为有限正数.

## 协议

| 协议 | 声音准备 | 合成 |
| --- | --- | --- |
| `siliconflow-tts` | HTTP 上传, 参考文件不超过 25 MiB | HTTP PCM 流, 明确请求 24 kHz 单声道 |
| `gpt-sovits-tts` | 本地参考音频 | HTTP WAV 流, 读取实际采样率和声道数 |
| `dashscope-tts`, CosyVoice 模型 | HTTP 注册, 参考文件不超过 25 MiB | Task WebSocket, 明确请求 24 kHz 单声道 PCM |
| `dashscope-tts`, Qwen TTS 模型 | HTTP 注册, 参考文件不超过 25 MiB | Realtime WebSocket, 明确请求 24 kHz 单声道 PCM |

DashScope 在创建时选择协议: 模型 ID 以 `cosyvoice` 开头时使用 CosyVoice, 以 `qwen` 开头且包含 `tts` 时使用 Qwen TTS. 其他模型 ID 抛 `tts/unsupported_model`. 这只确定协议格式, 不保证所有型号都接受声音克隆或每个请求参数. 当前 Qwen 路径没有发送速度参数.

默认地址分别是 `https://api.siliconflow.cn/v1`, `http://127.0.0.1:9880` 和 `https://dashscope.aliyuncs.com`. DashScope 也接受 WebSocket 地址, 并推导出注册音频使用的 HTTP 地址.

## 音频流约定

| 事件 | 含义 |
| --- | --- |
| `audio_started` | 实际采样率和声道数, 在样本前交付一次 |
| `audio_chunk` | 非空的 signed PCM16LE 样本, 不含 WAV/MP3/AAC 容器文件头 |
| `done` | 已交付 PCM 总字节数, 以及从请求开始到首个 PCM 字节的毫秒数 |

PCM 为单声道或交错双声道. 每帧包含每声道各一个 16 位采样, 单声道每帧 2 字节, 双声道每帧 4 字节. 每块都包含完整帧, 且不超过 8 KiB. 网络块切在帧中间时与下一块拼接, 最终仍有不足一帧的字节则失败.

公共调用入口检查事件顺序, 格式, 非空音频和最终字节统计. 采样率必须为 8,000 到 192,000 Hz 的整数. 成功流以且仅以一个 `done` 结束.

GPT-SoVITS WAV 读取支持跨网络块的文件头, 扩展 `fmt ` 块, 以及跳过带填充的元数据块. 只接受线性 PCM16LE, 保留文件头声明的采样率和声道数. 其流式响应的 `data` 长度为零时读取到 EOF, 非零时只读取声明的数据段.

`packPcmWav(chunks, format)` 为已经收集的样本加完整 WAV 文件头. 设置页试听在使用它前把 PCM 限制为 16 MiB. `createPcmWavHeader(format, pcmByteSize)` 只创建文件头, 传入 `null` 时写未知长度供持续音频使用. 保存完整归档的调用方负责在结束后更新实际长度.

## 读取, 取消与失败

HTTP 音频随消费方读取逐块交付, Node 流仍可能保留自己的读取缓冲. 失败, 取消或提前退出迭代时关闭输入流. DashScope 回调通过 `SocketEventQueue` 交付样本; 队列尚未关闭时收到失败或取消, 会丢弃未消费的音频, 让下一次读取抛错. 清理时关闭 WebSocket. CosyVoice 等 `task-started` 后再发送文本, Qwen 等 `session.finished` 而非仅收到 `response.done` 就结束输出.

WebSocket 队列没有单独的容量限制. Qwen 对单次接收的 PCM 设置 16 MiB 上限, 这不是整条语音链的内存上限.

`TTSError` 区分无效请求或响应, 不支持的模型或声音, 参考文件缺失, 凭据, 网络失败, 取消, 供应商失败和资源超限. HTTP 状态映射见 [errors.ts](errors.ts). 每次调用尝试一次合成, 调用方通过 `signal` 设置超时并决定是否重试. 部分底层文件, JSON 和取消错误可能原样抛出, 消费方也需要处理普通错误.

## 应用调用与代码入口

Server 的 [composition/speech.ts](../../apps/server/src/composition/speech.ts) 解析 TTS 连接和角色参考音频. [SpeechVoiceCache](../speech/voiceHandleCache.ts) 在进程内复用已注册的云端声音 ID. [SpeechCoordinator](../speech/speechCoordinator.ts) 把清理后的文本逐句提交, 消费 PCM 并写音频归档. [SpeechVoicePreview](../speech/voicePreview.ts) 用相同入口生成有大小限制的试听 WAV.

先看 [textToSpeech.ts](textToSpeech.ts) 中的创建入口和流校验. [protocols](protocols) 处理各供应商请求, [audio/pcm.ts](audio/pcm.ts) 拼接和拆分完整帧, [audio/wav.ts](audio/wav.ts) 读取与写入 WAV 文件头.

```sh
pnpm --filter @ema-agent/tts test
pnpm --filter @ema-agent/speech test
```

TTS 测试使用本地 HTTP/WebSocket 服务和内存音频, 检查请求, 样本保持, WAV 读取和取消, 不验证真实供应商的模型可用性或声音质量.
