# @ema-agent/memory

EmaAgent 通用记忆包。它负责轻量级通用对话记忆：三层召回、会话级提取、维护与观测事件。对话上下文压缩属于 `@ema-agent/context`；Narrative/剧情记忆由 conversation/narrative-client 和 Python LightRAG bridge 负责。

## Architecture

```text
MemoryPlanner
  initialize()
    -> build in-memory vector indexes from storage repos

  applyRecallToMessages()
    -> plan()
    -> inject one memory context message before the latest user message

  afterTurn()
    -> append pending_fragments
    -> enqueue session-scoped extraction when thresholds are reached

  tick()
    -> MemoryTaskRunner drains memory_tasks
```

Storage boundary:

```text
profile.db
  memory_nodes
  memory_edges
  memory_node_lazy_updates
  memory_items

data.db
  sessions
  session_notes
  pending_fragments
  memory_tasks
```

L0/L2 are global profile memories and survive dataDir switches. L1 notes, pending extraction fragments, and memory task queue are session/dataDir scoped.

## Layers

### Layer 0: Graph Recall

`recall/layer0-graph.ts` recalls entity graph nodes and edges.

- Anchor selection uses vector index when available.
- DB scan with cosine similarity is the fallback.
- Graph expansion is bounded by `maxHopDistance`.
- Already-surfaced node ids are skipped for a short TTL window.

### Layer 1: Session Notes

`recall/layer1-notes.ts` reads `session_notes.body`.

Current body format is JSON `SessionNoteEntry[]`. Recall parses the JSON and renders timestamped markdown. Legacy plain text bodies are accepted and rendered as one fallback entry.

### Layer 2: Episodic Items

`recall/layer2-episodic.ts` recalls `memory_items`.

- Vector path ranks by embedding similarity.
- Fallback path ranks by importance and recency.
- Current mode receives most of the slots; cross-mode items receive the remainder.
- Narrative mode can tag items as `narrative`, but LightRAG narrative recall stays outside this package.

## Extraction

Extraction is session-scoped.

`afterTurn()` converts a completed turn into pending fragments:

```ts
{
  turnId: TurnId;
  role: 'user' | 'assistant';
  content: string;
  at: number;
}
```

Fragments are stored in `pending_fragments`, not in `sessions.meta_json`. When token or turn thresholds are reached, `MemoryTaskRunner` enqueues and drains an `extraction` memory task for that session.

The extraction pipeline writes:

- `memory_nodes` and `memory_edges` for Layer 0.
- `memory_items` for Layer 2.
- `session_notes` for Layer 1.
- `memory_node_lazy_updates` when an existing node should be consolidated later.

`memory_tasks` is intended for session-scoped extraction work. Maintenance should not be queued there. Layer-1 Session Note 自身的瘦身仍是记忆数据维护，但对话历史压缩不再由 Memory 执行。

## Maintenance

Maintenance is global memory hygiene and is driven through `MemoryPlanner.runMaintenance()`. It should not be inserted into `memory_tasks`, because L0/L2 live in `profile.db` and must not be bound to the currently active dataDir.

Current maintenance behavior:

- `user_fact`、`preference`、`relationship` 节点和 `user`、`feedback` 条目不会自动衰减。
- 其他条目可以在 `decayItems` 启用时衰减。
- Decay candidates are selected by `last_referenced_at`.
- Decay lowers `importance`.
- Re-reference touch can boost `importance` with a nonlinear age/saturation curve.
- High-importance rows saturate, so repeated recall does not keep pushing them upward.

用户设置由 `src/memory/settings.ts` 定义：

```ts
interface MemoryMaintenanceSettings {
  decayAmount: number;
  decayAfterDays: number;
  coldDeleteAfterDays: number;
}

interface MemoryStorageSettings {
  maxBytes: number;
}

interface MemoryInternalMaintenanceSettings {
  reReferenceBoostMax: number;
  reReferenceHalfLifeDays: number;
  boostSaturationStart: number;
  boostSaturationSlope: number;
}
```

Memory 超出全局逻辑字节预算后先清理过期条目，再删除长期未引用且重要度为
0 的非保护类，最后只驱逐最冷的非保护类向量。正文被保护的条目不会自动删除；
被预算驱逐的向量带显式标记，不会被修复任务立即重新生成。

## Events

Memory recall emits structured `MemoryRecallEvent` objects to the current Turn; background work emits `MemoryBackgroundEvent` to the app channel. No unparsed log strings should be sent to the frontend.

Turn-scoped events:

- `memory_recall_evidence`: emitted per recall layer when the caller provides `emit`.

Pipeline/system events:

- `memory_extraction_started`
- `memory_extraction_completed`
- `memory_extraction_failed`
- `memory_maintenance_completed`
- `memory_maintenance_failed`
- `memory_task_started`
- `memory_task_completed`
- `memory_task_failed`
- `memory_index_rebuilt`

## Facade

`MemoryPlanner` is the only public facade the orchestrator should use.

Important methods:

```ts
initialize(): Promise<{ nodes: number; items: number; backend: string | null }>
applyRecallToMessages(args): Promise<{ messages: ModelMessage[]; recallSummary: unknown; tokenEstimate: number }>
plan(ctx: PlanContext): Promise<RecallBundle>
afterTurn(ctx): Promise<void>
forceExtract(sessionId, mode): Promise<void>
tick(): Promise<void>
drain(): Promise<void>
runMaintenance(opts): MaintenanceReport
getStats(): MemoryStats
listNodes(opts)
listItems(opts)
listEdgesForNodes(nodeIds)
```

## Known Gaps

- `stats.ts`, `inspection.ts`, and hard-delete cleanup still need full storage-repo boundary cleanup if raw SQL remains there.
- `memory_tasks` should stay extraction-only unless a future design explicitly introduces a memory-owned queue kind.
- Bench files are historical evaluation assets and are not yet part of the stable package contract.

## Bench

`bench/` is currently treated as experimental research infrastructure. Do not treat its fixtures, caches, or reported metrics as production contract until the folder is refreshed against the current storage schema and MemoryPlanner facade.

Recommended policy:

- Keep `bench/` out of default package typecheck if it depends on live providers or stale harnesses.
- Move stable, deterministic checks into unit tests.
- Keep live/provider-dependent measurements behind explicit scripts.
- Regenerate benchmark results only after the memory schema and maintenance semantics settle.
