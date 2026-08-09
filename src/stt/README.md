# STT

`src/stt` 是 Ema 的语音转文字执行面：接收已经解析好的协议连接与一段内存音频，调用远端协议并返回中立文本和可选时间分段。

它不拥有 Provider 配置、模型选择、上传体积策略、热刷新、重试、Probe、Usage、Session 或 Turn。

```text
Provider / 接线层
  └─ createSpeechToText({ protocol, apiKey, baseUrl })
       └─ transcribe({ model, audio, mimeType, language, signal })
            └─ { text, segments? }
```

接收 multipart 上传的 Route 必须在完整读取音频前执行自己的体积限制；STT 包此时拿到的已经是内存字节，再提供一套“最大上传大小”只会形成两个可能漂移的限制源。

正常请求只执行一次。超时由调用方组合进 `signal`，重试、连通性 Probe 和 Usage 记录由 LocalHost 或具体业务调用边界拥有。
