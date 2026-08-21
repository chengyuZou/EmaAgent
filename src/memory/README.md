# Memory

Memory 把已完成的根 Turn 提取为 Work 与 Relationship 两轨长期记忆，并把正式记忆保存为用户可见、可编辑的 Markdown 文件。

## 用户记忆目录

正式记忆固定位于 `~/.ema-agent/memories/`：

```text
memories/
├─ work/                                  # 工作方法、项目事实与可复用经验
│  ├─ MEMORY.md                         # Work 主手册，放高频、稳定的工作知识
│  ├─ memory_summary.md                  # Work 薄摘要，每个 Turn 注入 Prompt
│  ├─ topics/<topic>.md                  # 某个主题的细节，例如仓库规则或工具用法
│  ├─ history/<date-or-topic>.md         # 工作决策和演进记录，可按墙钟保留
│  ├─ extensions/notes/*.md             # 用户或 Agent 新建的待整合便签
│  ├─ turn_evidence/*.md                # 由 Session/Turn SQL 重建的证据副本
│  ├─ memory_workspace_diff.md           # 整合期间临时生成的用户改动差异
│  └─ .git/                              # 内部基线，用于识别用户修改和接受整合结果
│
└─ relationship/                           # 用户偏好、角色相处经验与关系演进
   ├─ shared_user_memory.md               # 所有角色共享的用户事实与偏好
   ├─ character_relations.md              # 有对话证据的跨角色关系
   ├─ memory_summary.md                   # Relationship 薄摘要，每个 Turn 注入 Prompt
   ├─ characters/<characterDirectoryName>/
   │  ├─ MEMORY.md                      # 当前角色与用户相处的稳定记忆
   │  ├─ history/<active-date>.md       # 按角色实际活跃日记录的关系演进
   │  └─ extensions/notes/*.md          # 只属于该角色的待整合便签
   ├─ extensions/notes/*.md                # 跨角色共享的待整合便签
   ├─ turn_evidence/*.md                  # 由 Session/Turn SQL 重建的证据副本
   ├─ memory_workspace_diff.md             # 整合期间的临时差异
   └─ .git/                                # Relationship 轨独立基线
```

`MEMORY.md`、`topics/`、`history/`、`shared_user_memory.md` 和 `character_relations.md` 是用户可直接编辑的正式记忆。`extensions/notes/` 是待整合原料；`turn_evidence/`、`memory_workspace_diff.md` 和 `.git/` 是内部证据或工作文件，不是正式记忆。`characterDirectoryName` 是角色创建时冻结的目录名，不是可修改的显示名称。

## 从三层记忆到文件式双轨

早期 Memory 按存储技术分为三层：

```text
L0  图 RAG + 向量检索
    └─ 用节点、边和 embedding 表达用户、角色、事件、情感与关系

L1  Session Notes
    └─ 保留当前 Session 的任务状态、决策和进度摘要

L2  Memory Items
    └─ 保存跨 Session 的长期条目、偏好与工作知识
```

这个方案有明确的技术动机：图适合关系遍历，向量适合模糊召回，Session Notes 适合短期状态，Memory Items 适合长期条目。但它按“怎么存”分层，没有按 Ema 真正要记住的业务分界。

真实使用中出现了几个无法靠继续加字段解决的问题：

1. **同一事实会同时落到多层。** 例如“用户不喜欢行内 import”可以是 preference 节点、L2 item，也可以出现在 Session Note。更新其中一处后，其他副本可能继续召回旧结论。
2. **图节点不等于产品记忆。** 角色名、角色 ID、跨角色关系、事件有效期和冲突事实需要实体消歧、边证据、过时替换与重建规则。这些机制会变成另一个隐藏的业务系统，用户却看不到它为什么得出某条关系。
3. **向量索引增加了与记忆价值无关的运维。** embedding 模型变更会带来重嵌入、空间不一致、陈旧向量和索引修复；“被检索到”也不等于这条记忆应该被强化。
4. **衰减和冲突在隐藏元数据中越来越难解释。** 墙钟衰减会让长时间不上线的用户丢掉角色关系；按召回次数“回血”又会产生越召回越永久的自激。
5. **用户无法直接管理自己的记忆。** Ema 是本地优先的单人产品，用户需要能看到、编辑、删除和纠正记忆。节点、边、向量与多层 SQL 行无法为这种控制感提供清晰界面。

中间方案曾考虑让 Work 使用文件，Relationship 继续使用图 RAG。它能保留角色关系查询，但也会保留两套提取、召回、冲突、衰减、容量与前端编辑模型，而用户偏好又可能同时影响 Work 和 Relationship。因此最终不保留“一轨文件、一轨图”的双存储体系。

当前方案按业务含义分轨：

- **Work** 保存任务结果、仓库事实、工具证据、错误解法和稳定的工作偏好。
- **Relationship** 保存跨角色共享的用户事实、当前角色与用户的相处经验、关系演进和有证据的跨角色关系。
- 同一个已完成 Turn 同时进入两个提取器，由两套 Prompt 按内容独立判断是否有值得记录的东西。不用 Chat/Work 界面模式替记忆分类。
- Markdown 是正式记忆的唯一事实源，SQL 只保存 Job、待整合结果与文件占用，Git 只跟踪用户改动与整合基线。
- 衰减改为可理解的文件生命周期：Work history 按墙钟保留；Relationship history 按角色真实活跃日保留，用户离线期间不衰减；核心正式记忆不自动删除。

这个决策不是否定图 RAG 或向量检索。Knowledge Base 和 Narrative 仍然适合按来源证据建立向量/图检索。如果未来真实记忆规模证明文件搜索不足，向量可以作为从 Markdown 重建的派生索引回归；它不再成为第二份正式记忆。

## 边界

Memory 负责：

- 管理 Memory Job 的入队、认领、取消、心跳、重试与终态。
- 把一个已完成 Turn 的中立事实分别投影为 Work 和 Relationship 提取输入。
- 用 LLM 生成待整合结果，再把本轮真正消费的结果整合进正式文件。
- 维护两轨 Git 基线、文件占用状态、历史保留与物理容量清理。
- 读取摘要，生成每个 Turn 只需装配一次的 Memory Prompt 段。

Memory 不负责：

- 不读 Session/Turn 表，不解析 Session Message 的具体结构。
- 不选择 Provider 或 Model，只调用应用层绑定好的纯文本 LLM 闭包。
- 不注册 Tool，只提供文件读、搜、列举与便签能力。
- 不发 SSE，不管理前端路由，不持久化 UI 状态。
- 不把文件终态复制进 SQL。SQL 保存 Job 与提取结果，Markdown 是正式记忆的事实源。

## 主流程

```text
根 Turn completed
  └─ JobAdmin.enqueueExtraction(turnId)
       ├─ work_extraction
       └─ relationship_extraction

runExtractionJobs()
  └─ loadCompletedTurn(turnId)
       ├─ Work: 对话 + 用户决定 + Tool 过程 + workspaceRoot
       └─ Relationship: 对话 + 用户决定 + characterDirectoryName
            └─ LLM 提取
                 └─ memory_extraction_results

runConsolidationJobs(track)
  ├─ 读本轮有界的未整合结果
  ├─ 读用户改动与现有正式记忆
  ├─ LLM 返回整文件 write/delete 计划
  ├─ 锁定本轮真正修改的文件
  ├─ 应用文件改动并接受 Git 基线
  └─ 同一 SQL 事务:整合 Job completed + 实际消费结果 integrated
```

## Turn 投影契约

应用层实现 `loadCompletedTurn(turnId)`，返回 `CompletedTurnMemoryInput`。投影规则是：

| Turn 事实 | Memory 事实 |
|---|---|
| 用户文本 | `user_message` |
| 根 Agent 可见文本 | `assistant_message` |
| AskUser 的问题与用户答案 | 折叠为一条 `user_decision`，不再重复投影为普通 Tool Result |
| 其他 Tool 调用 | `tool_call` |
| 其他 Tool 结果 | `tool_result` |
| system、summary、thinking | 不投影 |
| Turn 冻结的工作区 | `workspaceRoot` |
| Turn 冻结的角色目录名 | `characterDirectoryName` |

必须保持原始时序。Relationship 轨只从上述事实中保留 `user_message`、`assistant_message`、`user_decision`；不能把所有 Tool Result 当成用户发言。

只有根 Turn 到达 `completed` 才入队。应用启动时还必须扫描“已 completed 但没有有效提取 Job”的 Turn 并重新入队；`MemoryJobsRepo.enqueue()` 对同一 `(turnId, kind)` 幂等，用于关闭 Turn 终态与 Job 入队之间的断电窗口。

## Job 与取消语义

- `pending` 可被认领；`running` 才可心跳、写路径和进入终态。
- 取消先把 SQL 改为 `cancelled`，再向进程内 `AbortController` 发信号。即使取消发生在 claim 与句柄注册之间，注册时也会立即发现已失去运行权。
- 心跳第一次失败就停止计时器并中止业务闭包，不继续空转。
- 进程退出后，下次启动把遗留 `running` 改为 `failed`，由用户决定是否重试，不假装续跑。
- 事件只补充 SQL 不存在的入队失败。事件回调抛错不得改变业务结果。

## 整合与文件编辑

- 整合输入超限时只选取能够完整放入的提取结果。未放入的结果保持未整合，由后续 Job 继续处理。
- 单条提取结果已大于整合输入上限时直接失败，不截断后标记为已整合。
- Work 可新建 `MEMORY.md`、`memory_summary.md`、`topics/*.md`、`history/*.md`。
- Relationship 可新建根文件，以及提取结果明确给出的 `characters/<characterDirectoryName>/MEMORY.md` 与 `history/*.md`。
- 整合器只能处理已存在的便签，不能自行发明便签路径。
- 用户可以编辑正式 Markdown。整合 Job 运行时，`memory_job_paths` 保存正在改动的准确路径，前端据此禁用这些文件的编辑。

## 模板与 Prompt

`templates/work` 和 `templates/relationship` 分别定义两轨的提取与整合规则。`templates/memoryGuidance.md` 是根 Agent 的记忆使用指引。

模板覆盖是真正的替换：传入覆盖时不再读默认文件。Prompt 不得声称能看到下一个 Turn 的用户反馈；它只能使用当前已完成 Turn 内的对话、用户决定、Tool 证据与验证结果。

## 验证要点

- 根目录搜索与列举必须能返回正式记忆，不能因“根不在自己内部”而返回空。
- 大小写与路径归一化必须同时应用于查询和文本。
- `read.truncated` 必须同时反映行数上限与 token 上限。
- 取消必须抛出取消原因，不得返回看似正常的部分成功响应。
