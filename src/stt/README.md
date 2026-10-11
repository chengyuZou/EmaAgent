# STT

`src/stt` 接收供应商连接、模型 ID 和音频字节, 调用语音转文字接口, 返回文本和可选的时间分段.

Server 负责读取 Provider 配置和模型绑定, 再创建调用函数. STT 包不保存 Session 或 Turn 状态.

```text
Server
  └─ createSttCall({ protocol, apiKey, baseUrl }, modelId)
       └─ transcribe({ audio, mimeType, language?, signal? })
            └─ { text, segments? }
```

模型 ID 在 `createSttCall` 时确定, 后续调用只传音频及本次请求的语言和取消信号.

目前支持 `openai-stt`, 它表示兼容 `/audio/transcriptions` 的请求格式, 不限定供应商为 OpenAI. 请求使用 multipart 上传 `file`、`model` 和可选的 `language`, 不指定 `response_format`, 读取接口默认返回的 JSON `text`. 部分兼容模型不接受 `verbose_json`, 不能为了取得时间分段而对所有模型强制发送它.

当前转写与试听入口只需要 `text`. 如果供应商还返回 `segments`, 包会检查内容, 并把开始和结束时间从秒换为毫秒; 没有分段时不补造分段数据.

STT 接收的是已经读入内存的音频字节. HTTP 上传的体积限制由接收上传的 Server 处理, 不在此包重复配置.

每次调用只发起一次请求, 不在包内重试. 调用方通过 `signal` 控制取消和超时, 并负责模型测试与 Usage 记录. HTTP 请求失败时保留状态码和最多 500 字符的供应商错误正文; 正文为空时只能返回状态码.
