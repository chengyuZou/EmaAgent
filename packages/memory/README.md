# @ema-agent/memory

Ema 记忆系统 — 三层召回 + LLM 提取 + compaction 压缩 + 后台维护。

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                      MemoryPlanner                          │
│   initialize() → plan() → afterTurn() → compact()          │
├─────────────────────────────────────────────────────────────┤
│ Layer 0 (Graph)    Layer 1 (Notes)     Layer 2 (Episodic)  │
│ entity graph BFS   session summary     mode-weighted ANN   │
│ anchors+neighbours plain text          chat / agent         │
├─────────────────────────────────────────────────────────────┤
│ Extract           Embed              Compaction             │
│ LLM pipeline      BGE-M3 1024d       micro + macro          │
└─────────────────────────────────────────────────────────────┘
```

**三层架构**：
- **L0 图谱** — 实体+关系 BFS 扩展，2 跳以内。适合"跟某个人/事物相关的所有记忆"
- **L1 摘要** — session 的增量总结文本。适合"我们最近在聊什么"
- **L2 片段** — mode-weighted 向量检索，区分当前 mode 和他 mode。适合"用户说过什么偏好/事实"

## Quick Start

```typescript
import { MemoryPlanner } from '@ema-agent/memory';

const planner = new MemoryPlanner({
  db, session, llm, ebd, narrative, modelBindings,
  nodes, edges, lazyUpdates, items, sessionNotes, backgroundTasks, sessions,
});

await planner.initialize();

const bundle = await planner.plan({
  sessionId, turnId, mode: 'chat', userInput: '推荐一道晚餐',
});
// → { layer0: GraphRecallResult | null, layer1: string | null, layer2: EpisodicRecallResult | null }
```

---

## 入口模块

### `planner.ts` — MemoryPlanner 门面

```typescript
export class MemoryPlanner {
  constructor(private readonly deps: MemoryDeps, overrides: Partial<MemorySettings> = {}) {
    this.embed    = new EmbedService(deps.ebd);
    this.settings = { ...DEFAULT_MEMORY_SETTINGS, ...overrides };
    this.queue    = new SessionTaskQueue();
    this.runner   = new BackgroundTaskRunner({ memory: deps, embed: this.embed, queue: this.queue, ... });
  }

  async initialize(): Promise<{ nodes: number; items: number; backend: string | null }> {
    const dim = this.deps.ebd.embedDimFor(providerId);
    this.nodesIndex = await createVectorIndex(dim);
    this.itemsIndex = await createVectorIndex(dim);
    const nodes = rebuildNodesIndex(this.nodesIndex, this.deps.nodes, model);
    const items = rebuildItemsIndex(this.itemsIndex, this.deps.items, model);
    return { nodes, items, backend: this.nodesIndex.backend };
  }

  async plan(ctx: PlanContext): Promise<RecallBundle> {
    const embedded  = await this.safeEmbedQuery(ctx.userInput);
    const layer0 = overrides.layer0
      ? safeCall(() => recallGraph(this.deps, { queryVec: embedded?.queryVec ?? null, ... })) : null;
    const layer1 = overrides.layer1
      ? safeCall(() => recallSessionNote(this.deps, ctx.sessionId)) : null;
    if (ctx.mode === 'narrative') { narrative = await recallNarrative(...); }
    else { layer2 = await recallEpisodic(this.deps, { mode: ctx.mode as 'chat' | 'agent', ... }); }
    return { layer0, layer1, layer2, narrative };
  }
}
```

### `types.ts` — 全部类型

```typescript
export interface PlanContext {
  sessionId: SessionId;  turnId: TurnId;
  mode: TurnMode;        subMode?: AgentSubMode;
  userInput: string;     signal?: AbortSignal;
}
export interface RecallBundle {
  layer0:    GraphRecallResult     | null;
  layer1:    string                | null;   // session_notes.body 全文
  layer2:    EpisodicRecallResult  | null;   // { currentMode, otherModes }
  narrative: NarrativeRecallResult | null;
}
export interface EpisodicRecallResult {
  currentMode: RecalledItem[];  otherModes: RecalledItem[];
}
export interface RecalledItem {
  id: string;  kind: MemoryItemKind;  title: string;  body: string;  importance: number;
}
```

### `deps.ts` — 外部依赖注入

```typescript
export interface MemoryDeps {
  db: Database;          session: SessionStore;
  llm: LlmRouter;        ebd: EbdRouter;
  narrative: NarrativeClient;  modelBindings: ModelBindingsRepo;
  nodes: MemoryNodesRepo;       edges: MemoryEdgesRepo;
  lazyUpdates: MemoryLazyUpdatesRepo;  items: MemoryItemsRepo;
  sessionNotes: SessionNotesRepo;     backgroundTasks: BackgroundTasksRepo;
  sessions: SessionsRepo;
  emit?: (ev: EmaStreamEvent) => void;
}
```

### `hooks.ts` — HookBus 注册

```typescript
export function registerMemoryHooks(bus: HookBus, deps: MemoryHooksDeps): () => void {
  const offBefore = bus.register('beforeLlm', async (ctx) => {
    const result = await deps.planner.applyToBeforeLlm({
      sessionId: ctx.sessionId, turnId: ctx.turnId,
      mode, userInput, messages: ctx.payload.messages, modelContextWindow: window,
    });
    return { kind: 'replace', payload: { ...ctx.payload, messages: result.messages } };
  }, { name: 'memory:beforeLlm', priority: 20 });

  const offEnd = bus.register('onTurnEnd', async (ctx) => {
    await deps.planner.afterTurn(turnId, userMsg, assistantText);
    return { kind: 'continue' };
  }, { name: 'memory:onTurnEnd', priority: 50 });

  return () => { offBefore(); offEnd(); };
}
```

---

## 召回层 (`recall/`)

### `layer0-graph.ts` — 图谱召回

**路由规则**：`queryVec` 为空（无 embed provider）→ 直接返回空。索引 size < `anchorK`（冷启动）→ 回退 DB 扫描 brute-force cosine。否则走 ANN 快速路径。

```typescript
export function recallGraph(deps: MemoryDeps, args: Layer0Args): GraphRecallResult {
  if (!queryVec || !queryEmbed) return { nodes: [], edges: [] };

  // ① 锚点 — ANN 快速路径 vs DB 扫描回退
  const anchorIds = findAnchors(deps, queryVec, queryEmbed, index, alreadySurfaced, anchorK);
  if (anchorIds.length === 0) return { nodes: [], edges: [] };

  // ② BFS 扩展 — 1-hop → 2-hop，边按 log(mention_count) 排序
  for (let hop = 1; hop <= maxHop; hop++) {
    const edges = deps.edges.listForNodes(frontier);
    edges.sort((a, b) => edgeWeight(b) - edgeWeight(a));
    for (const edge of edges) { /* 收集边 + 发现新节点 */ }
  }
  // ③ 只返回端点都在 visited 里的边
  return { nodes: [...visited.values()], edges: finalEdges };
}

function findAnchors(..., index, ...): string[] {
  // 快速路径：向量索引 ANN 检索，overscan = max(K×3, K+10) 留余量过滤 alreadySurfaced
  if (index && index.dim === queryEmbed.dim) {
    const hits = index.search(queryVec, Math.max(k * 3, k + 10));
    for (const hit of hits) { /* 排除 alreadySurfaced + score≤0 → 取 top-K */ }
    return out;
  }
  // 回退：DB 全表扫描 + brute-force cosine sim
  const rows = deps.nodes.listEmbeddable(queryEmbed.model);
  for (const row of rows) { /* unpack + dotProduct + sort + slice(K) */ }
}
```

### `layer1-notes.ts` — Session 摘要

```typescript
export function recallSessionNote(deps: MemoryDeps, sessionId: SessionId): string | null {
  const row = deps.sessionNotes.findBySession(sessionId);
  if (!row || row.body.trim() === '') return null;
  return row.body;
}
```

### `layer2-episodic.ts` — 片段召回

```typescript
export async function recallEpisodic(deps: MemoryDeps, args: RecallLayer2Args): Promise<EpisodicRecallResult> {
  const w       = settings.recall.currentModeWeight;       // default 0.7
  const curSlot = Math.max(1, Math.ceil(K * w));            // ~70% 给当前 mode
  const othSlot = Math.max(0, K - curSlot);                  // ~30% 跨 mode

  // 向量路径：ANN overscan K×4 → 按 mode 标签过滤 → 切片
  const ranked = rankByVector(deps, queryVec, queryEmbed, index, alreadySurfaced, K * 4);
  const currentMode = ranked.filter(r => parseModes(r.modes_json).includes(mode))
    .slice(0, curSlot).map(toRecalledItem);
  const otherModes = ranked.filter(r => parseModes(r.modes_json).includes(otherMode))
    .slice(0, othSlot).map(toRecalledItem);
  return { currentMode, otherModes };

  // 回退：无 embed → importance + recency 启发式
}
```

### `narrative.ts` — Narrative 专用

```typescript
export async function recallNarrative(deps: MemoryDeps, userInput: string, signal?: AbortSignal) {
  try {
    const route = await deps.narrative.route(userInput, signal);
    const resp  = await deps.narrative.query(route.routes, 'hybrid', signal);
    return { sections: ordered };
  } catch (err) {
    if (err instanceof NarrativeUnavailableError) return null;  // bridge 挂了静默降级
    throw err;
  }
}
```

---

## 提取管线 (`extract/`)

### `pipeline.ts` — 提取主管线

```typescript
export async function runExtractionPipeline(deps, sessionId, mode): Promise<PipelineResult> {
  const fragments = readPending(deps.memory.sessions, sessionId);
  const output: ExtractionOutput = await runExtraction(deps.memory.llm, buildExtractionPrompt(mode, fragments));

  for (const node of output.new_nodes) {
    const dup = findDuplicate(deps.nodesIndex, node, 0.85 /* cosine 阈值 */);
    if (dup) { queueLazyUpdate(...); continue; }
    deps.memory.nodes.insert({ id, label: node.label, ... });
    deps.nodesIndex?.upsert(id, embed(node.description));
  }
  for (const item of output.memory_items) { deps.memory.items.insert({ ... }); }
  clearPending(deps.memory.sessions, sessionId);
}
```

### `types.ts` — 提取数据结构

```typescript
export interface ExtractedNode    { label: string; nodeType: MemoryNodeType; description: string; importance: number; }
export interface ExtractedEdge    { fromLabel: string; toLabel: string; relation: string; }
export interface ExtractedItem    { kind: MemoryItemKind; title: string; body: string; importance: number; }
export interface ExtractionOutput { new_nodes: ExtractedNode[]; new_edges: ExtractedEdge[]; memory_items: ExtractedItem[]; session_note_delta: string; }
export interface PendingFragment  { turnId: string; role: 'user' | 'assistant'; content: string; at: number; }
```

### `prompts.ts` — 按 mode 的提取 prompt

Chat 侧重关系/情感，agent 侧重项目/偏好/反馈，narrative 侧重剧情选择。共享 footer schema：

```typescript
const SHARED_FOOTER = `
Respond with a single JSON object:
{ "new_nodes": [...], "new_edges": [...], "memory_items": [...], "session_note_delta": "..." }
Empty arrays are acceptable. Return {} only if nothing is worth extracting.`;
```

### `pending.ts` — Pending fragments 读写

存在 `sessions.pending_fragments_json` 列。达到 `pendingTokenThreshold` (5000) 或 `pendingTurnThreshold` (50) 触发提取。

---

## 嵌入 (`embed/`)

### `service.ts`

```typescript
export class EmbedService {
  constructor(private readonly ebd: EbdRouter) {}
  isAvailable(): boolean { return !!this.ebd.firstEmbedId(); }
  async embedMany(texts: string[]): Promise<EmbeddedText[] | null> {
    const resp = await this.ebd.embed({ providerId, model, texts });
    return resp.embeddings.map(vec => ({
      embedding: packEmbedding(vec), providerId, model, dim: resp.dim,
    }));
  }
}
```

### `similarity.ts`

```typescript
export function normalize(vec: Float32Array): Float32Array { /* L2-normalize */ }
export function dotProduct(a: Float32Array, b: Float32Array): number {
  let sum = 0; for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!; return sum;
}
export function packEmbedding(vec: number[]): Buffer {
  return Buffer.from(normalize(new Float32Array(vec)).buffer);
}
export function unpackEmbedding(buf: Buffer, dim: number): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, dim);
}
```

---

## 压缩 (`compact/`)

### `micro.ts` — 微压缩（无 LLM）

清除超过 `keepRecent` 窗口的旧 tool_result 内容，不调用 LLM。

### `macro.ts` — 宏压缩（LLM 驱动）

```typescript
export async function runMacroCompaction(args: MacroCompactArgs): Promise<MacroCompactResult> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const resp = await args.llm.complete({ providerId, model, messages: [{ role: 'user', content: prompt }] });
    if (estimateTextTokens(resp.content) < budget) return { summary: resp.content, ... };
    messages = messages.slice(Math.floor(messages.length * 0.2));
  }
}
```

### `prompts.ts` — 按 mode 的压缩模板

三种 mode 各自有独立的结构化模板。Agent 模式最复杂（9 个 section）：

```typescript
export function buildCompactionPrompt(args: { mode: TurnMode; history: string }): string {
  const template = args.mode === 'chat'      ? CHAT_TEMPLATE
                 : args.mode === 'narrative' ? NARRATIVE_TEMPLATE
                 :                              AGENT_TEMPLATE;
  return `You are a conversation compaction agent...${template}${SHARED_FOOTER}...`;
}

// Agent 模板包含：Primary Request / Key Technical Concepts / Files & Code Sections /
//   Errors and Fixes / Problem Solving / All User Messages / Pending Tasks /
//   Current Work / Optional Next Step
// Chat 模板包含：Current Emotional State / Topics Discussed / Promises Made /
//   Pending Threads / Relationship Milestones / User's Recent Concerns
// Narrative 模板包含：Active Timeline / Current Scene / Player Choices Made /
//   Pending Plot Threads / Character State
```

### `restore.ts` — 压缩后 Context 重建

按 mode 分别处理——agent 重新注入最近读取的文件内容（token-capped，最多 5 个文件），chat 注入 `Current Emotional State` section，narrative 注入 `Current Scene`。

```typescript
export function buildPostCompactRestore(deps: MemoryDeps, ctx: RestoreContext): LlmMessage[] {
  if (ctx.mode === 'agent') return restoreAgent(ctx);      // 重新注入最近读取的文件
  if (ctx.mode === 'chat')  return restoreChat(deps, ctx);  // 注入情感快照
  return restoreNarrative(deps, ctx);                        // 注入当前场景
}
function restoreAgent(ctx): LlmMessage[] {
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const f of files) { /* 最多 5 个文件，每文件最多 5000 token */ }
  return [{ role: 'user', content: `<post-compact-restore mode="agent">...` }];
}
```

---

## 向量索引 (`index/`)

### `vector-index.ts` — 接口

```typescript
export interface VectorIndex {
  readonly backend: string;  readonly dim: number;
  size(): number;
  search(query: Float32Array, k: number): SearchHit[];
  add(id: string, vec: Float32Array): void;
  remove(id: string): void;
}
export interface SearchHit { id: string; score: number; }
```

### `factory.ts` — 自动选后端

```typescript
export async function createVectorIndex(dim: number): Promise<VectorIndex> {
  const u = await UsearchIndex.create(dim);
  return u ?? new BruteForceIndex(dim);
}
```

### `builder.ts` — 游标翻页全量重建

使用 `listEmbeddablePage` 游标分页（每页 500 行，按 `updated_at` 翻页），避免一次加载全部行到内存。

```typescript
const PAGE_SIZE = 500;

export function rebuildNodesIndex(index: VectorIndex, repo: MemoryNodesRepo, model: string): number {
  let after = 0, added = 0;
  for (;;) {
    const rows = repo.listEmbeddablePage(model, after, PAGE_SIZE);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (!row.embedding || row.embedding_dim !== index.dim) continue;
      const vec = unpackEmbedding(row.embedding, index.dim);
      if (vec.length === 0) continue;
      index.add(row.id, vec);
      added++;
    }
    after = rows.at(-1)!.updated_at;
    if (rows.length < PAGE_SIZE) break;
  }
  return added;
}
// rebuildItemsIndex 逻辑相同
```

---

## 后台任务 (`tasks/`)

### `session-queue.ts` — Session 级别排队

```typescript
export class SessionTaskQueue {
  private queues = new Map<string, Promise<void>>();
  enqueue<T>(sessionId: SessionId, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(sessionId, next.then(() => {}));
    return next;
  }
}
```

### `runner.ts` — 后台轮询消费

```typescript
export class BackgroundTaskRunner {
  async tick(): Promise<number> {
    const rows = this.deps.memory.backgroundTasks.pollPending(10);
    for (const row of rows) {
      await this.deps.queue.enqueue(row.session_id, async () => {
        switch (row.kind) {
          case 'extraction':   await runExtractionPipeline(...); break;
          case 'compaction':   await runMacroCompaction(...);    break;
          case 'maintenance':  await runMaintenance(...);        break;
        }
        this.deps.memory.backgroundTasks.delete(row.id);
      });
    }
    return rows.length;
  }
}
```

### `recovery.ts` — 启动恢复

```typescript
export function runStartupRecovery(deps: MemoryDeps, embed: EmbedService): RecoveryReport {
  return {
    resetTasks:       deps.backgroundTasks.resetStuckRunning(now),  // status='running' → 'pending'
    pendingSessions:  deps.sessions.listSessionsWithPending().length,
    staleNodeEmbeds:  deps.nodes.countStaleEmbeddings(providerId),   // provider 不匹配
    staleItemEmbeds:  deps.items.countStaleEmbeddings(providerId),
    orphanLazyUpdates: deps.lazyUpdates.cleanOrphans(),
  };
}
```

---

## Token 估算 (`tokens/`)

### `estimate.ts` — 中英文混合启发式

```typescript
export function estimateTextTokens(text: string): number {
  let ascii = 0, cjk = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++; else cjk++;
  }
  return Math.ceil(ascii / 4 + cjk / 1.5);  // ASCII ~4 chars/tok, CJK ~1.5 chars/tok
}
export function estimateMessagesTokens(messages: LlmMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += 10;  // per-message envelope
    if (typeof msg.content === 'string') total += estimateTextTokens(msg.content);
    else for (const block of msg.content) if ('text' in block) total += estimateTextTokens(block.text);
  }
  return total;
}
```

---

## 运维 (`maintenance/`)

### `overrides.ts` — Per-session 7 个召回/写入开关

```typescript
export interface MemorySessionOverrides {
  layer0?: boolean;  layer1?: boolean;  layer2?: boolean;  narrative?: boolean;   // 读控制
  extraction?: boolean;  consolidation?: boolean;  compaction?: boolean;          // 写控制
}
export const DEFAULT_OVERRIDES: ResolvedSessionOverrides = {
  layer0: true, layer1: true, layer2: true, narrative: true,
  extraction: true, consolidation: true, compaction: true,
};
// 存在 sessions.meta_json 的 "memory.overrides" key 里
```

### `decay.ts` — 重要性衰减

```typescript
export function runMaintenance(deps: MemoryDeps, opts: MaintenanceOptions): MaintenanceReport {
  const cutoff = Date.now() - opts.decayAfterDays * 86400000;
  const stale = deps.nodes.listStale(cutoff, opts.protectedNodeTypes);
  for (const node of stale) {
    const newImp = Math.max(0, node.importance - opts.decayAmount);
    if (!opts.dryRun) deps.nodes.updateImportance(node.id, newImp);
  }
  if (!opts.dryRun) hardDeleteZeroImportance(...);
}
export const DEFAULT_MAINTENANCE = {
  decayAfterDays: 30, decayAmount: 5,
  protectedNodeTypes: ['user_fact', 'preference', 'relationship'],
  decayItems: true, dryRun: true,
};
```

### `stats.ts` / `inspection.ts`

```typescript
export function collectStats(deps: MemoryDeps): MemoryStats {
  return { totalNodes: deps.nodes.count(), totalEdges: deps.edges.count(), totalItems: deps.items.count() };
}
export function browseNodes(deps: MemoryDeps, opts?: BrowseNodesOptions): BrowseResult<MemoryNodeRow> { ... }
export function browseItems(deps: MemoryDeps, opts?: BrowseItemsOptions): BrowseResult<MemoryItemRow> { ... }
export function browseEdgesForNodes(deps: MemoryDeps, nodeIds: string[]): MemoryEdgeRow[] { ... }
```

---

## Bench 套件 (`bench/`)

```
bench/
├── index.ts                    # 入口：pnpm bench [recall|embedding|extracted|planner|latency|all]
├── vector-perf.ts              # 向量性能基准：HNSW vs brute-force dot product
├── lib/
│   ├── deepseek.ts             # DeepSeek 提取客户端（含磁盘缓存，apiKey 从环境变量读）
│   ├── siliconflow.ts          # SiliconFlow BGE-M3 嵌入 + Reranker 客户端（含缓存）
│   └── bench-deps.ts           # 内存 SQLite + mock HookBus，用于 benchmark 快速装配 MemoryPlanner
├── runners/
│   ├── recall-quality.bench.ts      # BM25 vs Random F1/Recall/MRR 基线
│   ├── embedding-recall.bench.ts    # BGE-M3 vs BM25 原始消息召回对比
│   ├── extracted-recall.bench.ts    # 提取管线评测（含 reranker + K 值对比）
│   ├── planner-recall.bench.ts      # MemoryPlanner 端到端（提取→嵌入→检索→rerank）
│   └── latency.bench.ts             # 时延测量（p50/p95/p99）
├── scripts/
│   ├── convert-oracle.ts            # LongMemEval oracle → bench fixture
│   ├── convert-ema-oracle.ts        # Ema 中文数据集 → bench fixture
│   └── gen-ema-oracle.ts            # DeepSeek 生成 Ema 人设对话数据集
├── fixtures/
│   ├── chat-oracle.json             # 467 cases LongMemEval 通用数据集
│   ├── ema-oracle.json              # 500 cases Ema 人设中文数据集
│   └── ema-chat-oracle.json         # 120 cases Ema chat 子集
├── cache/
│   ├── extractions.json             # DeepSeek 提取缓存（467+500 cases）
│   └── bge-m3.json                  # BGE-M3 嵌入缓存（~10K vectors）
└── bench-results/
    ├── recall-quality.json          # BM25 vs Random 对比
    ├── embedding-recall.json        # BGE-M3 vs BM25
    ├── extracted-recall.json        # 提取管线（含 rerank）
    ├── planner-recall.json          # MemoryPlanner 端到端
    └── latency.json                 # 时延数据
```

### `bench/lib/siliconflow.ts`

```typescript
const API_KEY = process.env['SILICONFLOW_API_KEY'] ?? '';  // 必须设环境变量
const MODEL   = 'Pro/BAAI/bge-m3';   // 1024-dim
const RERANK_MODEL = 'BAAI/bge-reranker-v2-m3';

export class EmbedCache {           // sha256(text).slice(0,24) → number[]
  has(text: string): boolean;       get(text: string): number[] | undefined;
  set(text: string, vec: number[]): void;  save(): void;
}
export async function embedMany(texts, cache, onProgress?): Promise<void> {
  // batch_size=32, delay=120ms, 未缓存 → API 调用 → 写缓存
}
export function topKCosine(queryVec, corpus, k): string[] { /* cosine + sort + slice */ }
export async function rerank(query: string, documents: string[]): Promise<Array<{ index: number; score: number }>> {
  // POST /v1/rerank → BAAI/bge-reranker-v2-m3
}
```

---

## Performance Benchmarks

使用 LongMemEval 数据集 + Ema 中文人设数据集（120 cases）评测。

### 召回质量

| 指标 | 数值 | 目标 |
|---|---|---|
| **Hit Rate** (k=6) | **93.3%** | ≥ 80% |
| **Hit@1** | **89.2%** | — |
| **MRR** | **0.909** | — |
| **Extraction Recall** | **96.7%** | ≥ 85% |

### 按问题类型 (k=6)

| 类型 | Hit Rate | Hit@1 | MRR |
|---|---|---|---|
| single_hop | 95.1% | 95.1% | 0.951 |
| knowledge_update | 94.1% | 94.1% | 0.941 |
| multi_session | 93.9% | 81.8% | 0.874 |
| temporal | 89.7% | 86.2% | 0.869 |

### K 值影响

代码默认 `layer2TopK = 6`。Bench 验证 K=3 在 120 cases 上 Hit Rate 不降（93.3%）、Hit@1 反而最高（90.0%）、token 省一半——如果 token budget 紧张可酌情调低到 3。

| K | Hit Rate | Hit@1 | MRR |
|---|---|---|---|
| 3 | **93.3%** | **90.0%** | **0.915** |
| 6 | 93.3% | 89.2% | 0.909 |
| 10 | 93.3% | 89.2% | 0.906 |
| 20 | 93.3% | 89.2% | 0.906 |

### Reranker 效果 (BGE-Reranker-v2-m3)

| 指标 | 无 Reranker | 有 Reranker | Δ |
|---|---|---|---|
| Hit@1 | 83.3% | **89.2%** | +5.9% |
| MRR | 0.883 | **0.909** | +2.6% |
| temporal Hit@1 | 79.3% | **86.2%** | +6.9% |

### 对比基线

| 方法 | F1 |
|---|---|
| 随机（Random） | 0.129 |
| BM25 关键词 | 0.373 |
| BGE-M3 向量 | 0.383 |
| **MemoryPlanner（完整）** | **0.933** |

---

## 配置

```typescript
const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  enabled: true,
  triggers:          { pendingTokenThreshold: 5000, pendingTurnThreshold: 50 },
  recall: {
    currentModeWeight: 0.7,   layer0AnchorTopK:  5,   layer0TotalBudget: 12,
    layer2TopK:        6,     // 代码默认值；bench 验证 K=3 Hit Rate 不降，可酌情调低
    useReranker:       true,  anchorDetection: 'embedding',  maxHopDistance: 2,
  },
  compaction:        { bufferTokens: 10000 },
};
```

---

## 与 HookBus 交互

```
beforeLlm (priority 20)
  → MemoryPlanner.applyToBeforeLlm()
  → compaction check + plan() → RecallBundle
  → 注入 context message 到 payload.messages[1]

onTurnEnd (priority 50)
  → MemoryPlanner.afterTurn()
  → 追加 pending fragments → 可能触发后台提取队列

BackgroundTaskRunner.tick()
  → runExtractionPipeline()   (LLM 调用)
  → rebuildIndex              (向量索引更新)
  → runMaintenance            (衰减清理)
```

## License

AGPL-3.0
