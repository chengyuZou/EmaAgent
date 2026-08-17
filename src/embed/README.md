# Embed

`src/embed` 是 Ema 的 Embedding 执行面：接收已经解析好的协议连接与文本批次，调用远端协议，校验响应并返回按输入顺序排列的 L2 归一化向量。

它不拥有 Provider 配置、模型选择、热刷新、重试、Probe、Usage、Session 或 Turn。

```text
Provider / 接线层
  └─ createEmbeddingModel({ protocol, apiKey, baseUrl })
       └─ embed({ model, texts, signal })
            └─ { embeddings, dim }
```

`EmbeddingSpace` 是向量索引的领域事实，不是协议路由。调用方根据已选择的 `providerId`、模型目录维度和 revision 调用 `createEmbeddingSpace()`，防止不同向量空间混写。`embed()` 不接受 Provider ID，也不替调用方选择空间。

正常请求只执行一次。批处理、限时、重试和 Usage 记录由知道具体业务语义的 Knowledge、Memory 或接线层拥有。
