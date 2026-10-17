# Embedding

[English](README.md)

`@ema-agent/embed` 把一批文本提交给 Embedding API, 按输入顺序返回向量. 它检查向量数量和维度, 对范数为有限非零值的向量执行 L2 归一化. 零向量以及范数无法表示为有限值的向量保持原值.

## 使用

```ts
import { createEmbedCall } from '@ema-agent/embed';

const embed = createEmbedCall({
  protocol: 'openai-embed',
  baseUrl: 'http://127.0.0.1:8080/v1',
}, 'embedding-model');

const result = await embed({ texts: ['First passage', 'Second passage'] });
// result.embeddings[0] belongs to the first text.
// result.dim is the number of components in each vector.
```

创建调用函数时选定模型和协议. 每次调用传入 `texts` 和可选的 `signal`. 空批次直接返回 `{ embeddings: [], dim: 0 }`, 不发请求; 非空批次中出现空文本则报错.

| 协议 | 请求 | 默认地址 |
| --- | --- | --- |
| `openai-embed` | `POST /embeddings`, 请求 float 输出 | `https://api.openai.com/v1` |
| `gemini-embed` | `POST /models/{modelId}:batchEmbedContents` | `https://generativelanguage.googleapis.com/v1beta` |

填写 `baseUrl` 后使用该地址. OpenAI 兼容响应按 `index` 还原输入顺序, Gemini 响应保持返回顺序. 两条路径都会检查每个输入都有一个向量, 数值有限且维度一致, 维度必须为正数.

OpenAI 兼容响应提供有效的 `prompt_tokens` 时返回 `usage.inputTokens`. 当前 Gemini 实现只返回向量, 不返回用量. 供应商未报告用量时, 本包不补估算值.

## 应用中的调用

Server 的 [composition/narrative.ts](../../apps/server/src/composition/narrative.ts) 读取 `narrative-embed` 绑定, 解析供应商连接, 创建 `CallEmbed`, 并记录返回的用量. [Narrative recall](../narrative/pipeline/recall.ts) 提交查询文本, 把返回向量对应到各条文本, 另行检查剧情资产要求的维度. 供应商探活也使用同一入口提交少量测试文本.

每次调用只发一个 HTTP 请求. 调用方用 `signal` 控制取消和超时, 并决定是否重试. HTTP 失败或响应格式不正确时抛 `EmbeddingError`, 带错误码, 可附 HTTP 状态码和原因. `fetch` 的网络与取消错误原样抛出. HTTP 错误信息最多包含供应商响应正文的 500 个字符.

实现从 [embeddingModel.ts](embeddingModel.ts) 看起, [protocols](protocols) 中的两个文件分别组装请求和读取响应.

```sh
pnpm --filter @ema-agent/embed test
```

测试替换 `fetch`, 检查请求地址和请求头, 输入顺序, 响应校验, 归一化和空批次, 不访问付费供应商.
