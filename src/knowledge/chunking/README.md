# chunking

`DocumentBlock[]`（reader 产出，带 sectionPath 面包屑）→ `DocumentChunk[]`（落库分块）。
两个 chunker 互斥选用：有嵌入模型且非图片走 `SemanticChunker`，否则 `RecursiveChunker`
（`ingest/plan.ts` 的唯一判断）。`parentId/parentText` 由 ingest 管线在 chunker 返回后统一盖，
不在本目录产生。

## RecursiveChunker（零模型依赖）

```text
blocks → groupIntoSections（按 sectionPath run-length 归组；同名标题 A B A 不合流）
       → 组内按分隔符优先级贪心装进 maxTokens：
         段落 \n\n → 行 \n → CJK 句。！？；… → 拉丁句点+空白 → 词（空格）
         单段超预算 → 升一档分隔符重切（唯一递归点）
         全部分隔符用尽 → hardCutToFit 字符对半硬切
       → applyOverlap（上一块尾部 overlap token 前置到下一块）
       → normalizeChunkSizes（孤儿合并，见下）
```

## SemanticChunker（有嵌入模型时）

```text
blocks → segmentRuns：原子块（code/table/image）原样成块，不混切
文本段 → 分句（splitSentences）
       → buffer window：每句前后各带 bufferSize 句一起嵌入（相似度反映局部上下文）
       → embedBatches：batchSize=32 一批、concurrency=4 有界 worker 池、
         单次尝试 timeoutMs=30s、maxRetries=2 指数退避；
         失败批填 [] 保长度守恒并记 failedBatches
       → 相邻句余弦相似度
       → NaN 守卫：零向量/维度不齐产出 NaN，占比过半 = 嵌入整体失真 → 降级；
         少量 NaN 用中位数填洞
       → smoothSimilarities 尾随窗口（3）平滑，抑制单点抖动误断
       → 断点 = 平滑相似度 < 阈值：
         固定 breakThreshold(0.5)，或 breakPercentile 按分布自适应；
         另有 maxSentencesPerGroup(50) 硬断点兜底防超长组
       → 组内合并成块；超 maxTokens 的组由 splitByBudget 顺次切（不拆句，
         单句超预算原样成块）
       → 任何一步不可信（abort / 数量对不上 / NaN 过半）→
         onFallback(SemanticFallbackWarning) + RecursiveChunker 整体接管
```

两条路径共用收尾：`normalizeChunkSizes` 把小于 minTokens 的孤儿块并入相邻块
（受 maxTokens 与原子块双重约束，id 重排保持连续）。

注意：overlap 前置只在递归路径；语义路径的上下文在 embed 输入的 buffer window 里，
正文不粘上一块的尾巴。

## 口径与文件

- `maxTokens` 单位是 `estimateTextTokens` 的启发式估算（ASCII÷4 + CJK÷1.5），
  见 `src/token`；不是精确 tokenizer 计数，也不是字符数。
- `base.ts`：ChunkOptions / chunkId / normalizeChunkSizes / assignParents（父子窗口归组）。
- `recursive.ts`：RecursiveChunker + recursiveChunk（给语义降级复用）。
- `semantic.ts`：SemanticChunker + embedBatches（有界并发嵌入池）。
- `utils/sentences.ts`：分句、余弦相似度（NaN 语义见注释）、平滑、分位数纯函数。
