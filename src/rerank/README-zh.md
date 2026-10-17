# Rerank

[English](README.md)

`@ema-agent/rerank` 把查询和候选文本交给 Rerank API, 返回文档下标与供应商分数, 按分数从高到低排列.

## 使用

```ts
import { createRerankCall } from '@ema-agent/rerank';

const rerank = createRerankCall({
  protocol: 'cohere-rerank',
  baseUrl: 'http://127.0.0.1:8080/v2',
}, 'rerank-model');

const result = await rerank({
  query: 'How does the story end?',
  documents: ['First candidate', 'Second candidate'],
  topK: 2,
});
// Each result.index points into the original documents array.
```

创建时选定模型和协议. 每次调用传入 `query`, `documents`, 可选的 `topK` 和 `signal`. `topK` 默认最多取 5 条, 超过候选数量时使用候选数量. 空候选集直接返回 `{ results: [] }`, 不发请求, 但查询仍然不能是空白文本.

`cohere-rerank` 向 `POST /rerank` 提交 `model`, `query`, `documents` 和 `top_n`. 默认地址为 `https://api.cohere.com/v2`, 也可填写兼容服务的地址. 有 API Key 时通过 Bearer 请求头传递.

响应接受 `relevance_score` 或 `score`. 下标必须在原候选数组范围内且不重复, 分数必须有限, 结果数量不能超过请求上限. 同分时按原文档下标排列.

分数保留供应商原始范围. 如果每批都按最高分和最低分重新换算, 同一文档能否达到阈值就会受到其他候选的影响.

## 用量, 失败与应用调用

Token 用量读取 `meta.tokens.input_tokens` 和可选的 `output_tokens`. 兼容响应只有 `usage.total_tokens` 时, 把它作为输入处理量. 未报告时保持缺失, `billed_units.search_units` 不当作 Token 数量.

每次调用只发一个请求. 调用方通过 `signal` 控制取消和超时, 并决定是否重试. HTTP 失败或响应格式不正确时抛 `RerankError`, 带错误码, 可附 HTTP 状态码和原因. `fetch` 的网络与取消错误原样抛出. HTTP 错误信息最多包含供应商响应正文的 500 个字符.

Server 的 [composition/narrative.ts](../../apps/server/src/composition/narrative.ts) 根据 `narrative-rerank` 绑定创建调用函数并记录用量. [Narrative recall](../narrative/pipeline/recall.ts) 提交原查询和候选段落正文, 再根据返回下标选取段落. 供应商探活也使用 `createRerankCall`.

[reranker.ts](reranker.ts) 处理输入检查, 排序和结果检查, [protocols/cohere.ts](protocols/cohere.ts) 处理 HTTP 格式.

```sh
pnpm --filter @ema-agent/rerank test
```

测试替换 `fetch`, 检查原始分数, 同分排序, 重复下标拒绝, 空候选集, 以及失败后不会自动重发请求.
