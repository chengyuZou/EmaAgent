# STT

[English](README.md)

`@ema-agent/stt` 把一整段音频上传到语音转文字 API, 返回文本和可选的时间分段.

## 使用

调用方提供从文件或录音读出的音频字节.

```ts
import { createSTTCall } from '@ema-agent/stt';

const transcribe = createSTTCall({
  protocol: 'openai-stt',
  baseUrl: 'http://127.0.0.1:8080/v1',
}, 'transcription-model');

const result = await transcribe({
  audio: audioBytes,
  mimeType: 'audio/wav',
  language: 'en',
  signal: AbortSignal.timeout(30_000),
});
// result.text and optional result.segments
```

`createSTTCall(connection, modelId)` 选定协议和模型. 每次调用传入 `audio`, `mimeType`, 可选的 `language` 和 `signal`. 空音频, 空白 MIME 类型和空白模型 ID 会报错.

## 请求与响应

`openai-stt` 表示兼容 OpenAI 的 `POST /audio/transcriptions` 格式, 不限定供应商. 默认地址为 `https://api.openai.com/v1`.

请求使用 multipart 上传 `file`, `model`, 以及非空白的 `language`. 不指定 `response_format`, 读取接口默认返回的 JSON. 如果强制要求 `verbose_json`, 只接受普通 JSON 的兼容模型就会拒绝请求.

成功响应必须包含字符串 `text`. 如果返回 `segments`, 每段都必须包含文本, 时间必须有限且非负, 结束时间不能早于开始时间. 协议把秒换算为四舍五入后的毫秒, 以 `startMs` 和 `endMs` 返回. 没有分段时保持缺失, 不补造分段.

HTTP 失败或响应格式不正确时抛 `STTError`, 带错误码, 可附 HTTP 状态码和原因. HTTP 错误信息最多包含供应商响应正文的 500 个字符. `fetch` 的网络与取消错误原样抛出. 每次调用只发一个请求, 取消和超时由调用方传入的 `signal` 控制.

## 应用调用与验证

Server 的 [composition/speech.ts](../../apps/server/src/composition/speech.ts) 在语音输入时读取 `stt` 绑定, 在设置页测试时使用明确选定的供应商和模型. 它解析连接, 创建 `CallSTT`, 并记录用量. [routes/providers/capabilities.ts](../../apps/server/src/routes/providers/capabilities.ts) 读取上传音频, 或请求转写当前角色的参考录音. 音频进入本包前, Server 已执行上传体积限制.

[speechToText.ts](speechToText.ts) 处理输入和结果检查, [protocols/openAi.ts](protocols/openAi.ts) 处理 multipart 字段与响应转换.

```sh
pnpm --filter @ema-agent/stt test
```

测试替换 `fetch`, 检查 multipart 字段, 可选分段, 时间换算, 无效输入和单次请求失败, 不向付费供应商发送音频.
