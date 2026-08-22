# Rerank

`src/rerank` 是 Ema 的重排执行面：接收已经解析好的协议连接、查询和候选文本，调用远端协议并返回指向原候选下标的相关度结果。

它不拥有 Provider 配置、模型选择、热刷新、重试、Probe、Usage、Session 或 Turn。

```text
Provider / 接线层
  └─ createRerankCall({ protocol, apiKey, baseUrl }, modelId)   // 连接与模型在创建点冻结
       └─ CallRerank({ query, documents, topK, signal })
            └─ { results: [{ index, score }], usage? }
```

`score` 保留 Provider 的原始相关度语义。包内只负责有限值、下标、重复项和结果数量校验，以及降序稳定排列；禁止按每批最小值和最大值重新映射分数，否则同一文档的阈值意义会随同批候选变化。

正常请求只执行一次。批处理、限时、重试、降级和 Usage 记录由 Knowledge、Memory 或接线层拥有。
