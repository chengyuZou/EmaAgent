# @ema-agent/knowledge

AgenticRAG 知识库包。用户给的资料经 **解析 → 分块 → embedding → 索引 → 混合检索**，由模型通过检索工具**主动**查询。

区别于另外两个"知识"概念：

- **Memory**（`@ema-agent/memory`）：被动，关于"用户是谁"
- **Narrative**（`@ema-agent/narrative`）：隔离，关于"故事世界"，LightRAG（Python bridge）
- **KB**（本包）：主动，关于"用户给的资料"，纯 TS

## 所有权

本包唯一拥有：知识库注册与激活、文档资产（Asset）与块（Chunk）的事实、嵌入空间冻结、ingest/reembed 两类任务的生命周期、混合检索。

不拥有：embedding/rerank/vision 模型的解析与调用（经 `KbManagerDeps` 注入的选择函数取得，由 `@ema-agent/embed` / `@ema-agent/rerank` 执行）；HTTP DTO 与路由（归 Application Server 接线）；模型可见的检索工具定义（归 builtinTools，只消费本包公共入口）。

## 公共入口

`KbManager` 是唯一对外入口（`index.ts` 导出），宿主按 `KbManagerDeps` 注入模型选择函数后使用：

| 方法组 | 成员 | 说明 |
|---|---|---|
| 库管理 | `listKbs / getKb / getActiveKb / createKb / renameKb / setActiveKb / unregisterKb / ensureDefault` | 多 KB；`unregisterKb` 先 shutdown 两个队列再关库 |
| 检索 | `search` | 当前激活库；无激活库返回空结果而非报错 |
| 摄入 | `enqueueIngest / listIngestTasks / retryIngest / cancelIngest` | 任务持久化，可重试可取消 |
| 重嵌 | `enqueueReembed / listReembedTasks / retryReembed / cancelReembed` | 换 embedding 模型后的整库或单资产重建 |
| 资产 | `listAssets / listInactiveAssets / getAsset / getPreview / getChunks / getAssetUsage / deleteAsset` | 分页、预览、块查看、用量统计；`deleteAsset` 先取消该资产在途任务并等落定再删 |
| 空间失效 | `invalidateEmbeddings / invalidateAllEmbeddings` | 某空间之外的向量全部标 stale，等待 reembed |

事件经 `KbManager.events` 订阅（`KnowledgeEvent`：ingest/reembed 的进度与终态）。

`KnowledgeClient`（单库操作）与 `KnowledgeStore`（单库存储访问）是包内分层，外部不得直接实例化。

## 数据结构

每个 KB 一个独立 `kb.db`（`migrations/kb/`），原件文件复制落盘到 `{kb}/files/<assetId>/`：

```text
document_assets    一个导入文件一行
  status                             indexing → ready | failed（三态，无默认值）
  content_hash                       同内容拒绝二次入库（部分唯一索引）
  embedding_provider_config_id / embedding_model / embedding_dim / embedding_space_id
                                     空间冻结：本资产的向量是谁、哪个模型、多少维嵌的；
                                     空间不同维的向量永不混检

document_chunks    检索的最小单位，asset_id FK 级联
  text / token_count                 块正文（目标 ~256 token）
  parent_id / parent_text            父窗：命中小块，召回返回 ~1024 token 父段
  embedding (BLOB)                   维度 = 所属资产冻结的 embedding_dim

document_previews  摘要 + 缩略图引用，只供 UI 列表，不参与检索

kb_ingest_tasks    一次「文件 → 资产」一行，终态 completed / failed / cancelled
kb_reembed_tasks   一次整库或单资产重建一行，部分失败即任务 failed
                   （失败资产清单写入 error 列，retry 只补跑仍 stale 的）
```

`kb_activations`（使用统计）在 `data.db`，跨库裸引用——SQLite 跨库无法建 FK。

## 摄入流水线

`enqueueIngest` 入队（任务行持久化）→ 队列按并发上限领取，单任务内串行过站：

```text
validate（扩展名/MIME/体积）
  → stage（原件复制进 files/<assetId>/）
  → 去重（content_hash 撞唯一索引 → 回退为既有资产的重复结果，清掉多余 staged 副本）
  → 资产行落库（status=indexing；同路径非 ready 旧资产被接管删除）
  → parse（readers：text / html / docx / pdf / image OCR）
  → chunk（RecursiveChunker 递归分隔；有嵌入模型时 SemanticChunker 句向量边界）
  → embed 分批（每批一次 embedBatch 请求 + 一次事务批量写向量；
                首批响应冻结资产空间，后续批次空间不符即失败）
  → preview（摘要 + wordCount + 缩略图）
  → status=ready，增量挂入内存向量索引
```

阶段边界检查 abort：取消的任务在 parse/chunk/embed 任一阶段被截断，任务行标 cancelled，资产保持 failed 供重试。`retryIngest` 只在"同资产无 pending/running 任务"时放行，防连点产生重复付费与噪音失败。

## 重嵌流水线

换 embedding 模型 → 旧空间失效（`invalidateEmbeddings`）→ `enqueueReembed`：

```text
probe：第一个 stale 资产串行跑完，冻结新空间（拿到真实 dim、验证模型可用）
  → 其余资产 3 路并发池逐资产重建（空间期待值已冻结，不符即该资产失败）
  → 单资产失败不拖垮整库：记入 failedAssetIds，进度照走
  → 收尾：markStaleExcept(新空间) + 内存索引全量重建
  → failedAssetIds 非空 → 任务 failed，可 retry（只补跑仍 stale 的）
```

并发是三层叠加：队列级 2 个任务 × 任务内 3 个资产 × 每资产按批 embed，最坏 6 个批量请求同时在飞。整库重建只允许一个在途（入队与 retry 统一经守卫拒绝第二个 sweep）；单资产重建要求资产 `status='ready'`，indexing/failed 走摄入重试而非重嵌。

## 检索流水线

```text
query 嵌向量（当前注入的 embedding 选择；未配置时向量路返回空，退化为纯全文）
  → FTS5 BM25 全文路 + 向量余弦路，两路 SQL 都只查 status='ready' 的资产
  → weightedRank 按 alpha 混合（alpha<=0 纯全文，>=1 纯向量）
  → 可选 rerank（@ema-agent/rerank，按 rerankBlendWeight 再混）
  → 结果预算（resultMaxChars 截断）
  → 命中块以 parentText 返回：小块定位、父段给上下文
```

内存向量索引（`vector-index/`：usearch 优先、brute-force 兜底）按 EmbeddingSpace 隔离；摄入增量挂载，空间切换才全量重建。取消语义：abort 在 embed/rerank 等待点向上重抛，不吞成空结果。

## 不变量与失败语义

- 只有 `ready` 资产参与检索、列表统计与 reembed 资格；`indexing` 资产对用户不可见，`failed` 可经重试重建。
- 向量空间用身份哈希区分，不同空间的向量绝不进同一索引、同一查询。
- 任务终态只写一次；shutdown 队列先于关闭数据库连接，在途任务以 failed 落定而非悬挂。
- 落盘写失败不截断数据：向量写库失败即任务失败，原件与任务行保留可重试。
- 重启恢复：打开库时把幽灵 running 任务标记 failed（"上次运行被应用退出中断"），可重试；pending 任务留在队里，下一次入队/重试触发领取时自然续跑，不做开机主动排空（V1 拍板）。

## 不做

- 不做 LLM 调用，不解析 Provider（模型经注入的选择函数取得）
- 不做记忆 / 剧情（见顶部边界）
- 不往 Python bridge 搬（纯 TS，bridge 只承载 LightRAG）
- 不做开机急切重建索引：首个检索/摄入请求到来时才建
- 不做任务的崩溃自动恢复（见不变量末条：pending 随下一次队列活动续跑，不主动排空）
