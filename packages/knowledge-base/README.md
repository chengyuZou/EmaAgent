# @ema-agent/knowledge-base

AgenticRAG 知识库包。用户给的资料(文档)经 **解析 → 分块 → embedding → HNSW 索引 → 混合检索**,由 LLM 通过 `kb_search` 工具**主动**检索。

区别于另外两个"知识"概念:
- **Memory**(`@ema-agent/memory`):被动,关于"用户是谁",graph-based
- **Narrative**(`@ema-agent/narrative-client`):隔离,关于"故事世界",LightRAG(Python bridge)
- **KB**(本包):主动,关于"用户给的资料",AgenticRAG(纯 TS)

## 架构

```
文档 → parse(reader) → chunk(chunker) → embed(EbdRouter) → HNSW index
                                                                  ↓
              LLM kb_search 工具 → hybrid retrieval(FTS5 + vector) → RankedHit
```

## Façade(单一对外入口)

| Façade | 职责 |
|---|---|
| `KbManager` | 多 KB 管理(激活 / 列表 / CRUD),Façade 之上 |
| `KnowledgeClient` | 单 KB 操作(ingest / search / reembed),绑定一个 kb.db |
| `KnowledgeStore` | 单 KB 的资产 / chunk / preview 存储访问 |

模块间禁止跨子目录 import 内部文件,只通过上述 Façade。

## 关键模块

- **parse**:`TextReader` / `HtmlReader` / `DocxReader` / `PdfReader` / image OCR(Vision)。`EXT_TO_MIME` 映射。`wordCount` 用 `Intl.Segmenter` 多语言分词(`words.ts`,B-080:替代 `split(/\s+/)`,中文不再整段算 1 词)
- **chunking**:`RecursiveChunker`(递归分隔)+ `SemanticChunker`(句向量边界)
- **ingest**:`IngestQueue`(并发受限、持久化,包自带 task runner)+ status 状态机(`pending` / `indexing` / `indexed` / `error`)
- **index**:`createVectorIndex`(factory:HNSW/usense 优先,`BruteForceIndex` 兜底)+ `EmbeddingSpaceId` 空间隔离(见 B-049:provider+model+dim+normalization+revision 五元组哈希)
- **retrieval**:`weightedRank`(hybrid:FTS5 + vector 加权)
- **events**:`DocumentProgressEvent`(ingest 进度,推 SSE)
- **preview**:`buildPreview`(摘要 + 缩略图 + wordCount)

## 物理

- 每个 KB 一个独立 `kb.db`(`migrations/kb/`)
- 资产文件存 `{kb}/files/`,原文复制
- `kb_activations`(使用统计)在 `data.db`(跨库裸引用——SQLite 跨库无法建 FK,见 `data/007:461` 注释)

## 不做

- 不做 LLM 调用(只 embed / rerank,经 `@ema-agent/ebd-client`)
- 不做记忆 / 剧情(见上)
- 不往 Python bridge 搬(纯 TS,bridge 只承载 LightRAG)
