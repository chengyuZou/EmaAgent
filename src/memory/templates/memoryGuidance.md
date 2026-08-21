# 记忆使用指引

EmaAgent 提供文件式记忆：跨会话保存工作事实（Work）与用户关系信号（Relationship）。
它记录先前运行的指导，能帮你保持一致、省时省力。只要可能有助于当前任务，就使用它。

## 决策边界：是否使用记忆

- 仅在请求明确自包含、不需要工作区历史/约定/先前决定时跳过记忆。
- 硬跳过例子：当前时间/日期、简单翻译、简单句子改写、单行 shell 命令、琐碎格式化。
- 以下任一为真时**默认使用记忆**：
  - 请求提到下方记忆摘要中的仓库/模块/路径/文件；
  - 用户询问先前上下文、一致性或之前的决定；
  - 请求模糊，可能依赖早期项目选择；
  - 请求非琐碎且与下方记忆摘要相关。
- 不确定时：做一次快速记忆检索。

## 记忆布局（通用 → 具体）

记忆根目录 `~/.ema-agent/memories/`，Work 与 Relationship 两轨各自独立：

```
memories/
├─ work/                        ← Work 记忆（工作/项目相关）
│  ├─ MEMORY.md                 手册，按任务族组织（可检索）
│  ├─ memory_summary.md         摘要（已注入下方，不要重新读取）
│  ├─ topics/<topic>.md         主题细节（可检索）
│  ├─ history/<date>.md         演进记录（可检索）
│  ├─ extensions/notes/         便签（MemoryNoteTool 写入）
│  ├─ turn_evidence/            内部证据（不作为记忆读取）
│  └─ .git/                     内部 Git 基线（不可读）
└─ relationship/                ← Relationship 记忆（用户个体/角色）
   ├─ shared_user_memory.md     跨角色共享的用户记忆（可检索）
   ├─ memory_summary.md         摘要（已注入下方，不要重新读取）
   ├─ character_relations.md    角色关系记录（可检索）
   ├─ characters/<name>/        每个角色一个目录
   │  ├─ MEMORY.md              角色手册（可检索）
   │  ├─ history/<date>.md      角色演进记录（可检索）
   │  └─ extensions/notes/      角色便签
   ├─ extensions/notes/         共享便签
   ├─ turn_evidence/            内部证据（不作为记忆读取）
   └─ .git/                     内部 Git 基线（不可读）
```

读取规则：
- **可读/可检索**：正式记忆文件（MEMORY.md、topics/、history/、shared_user_memory.md、
  character_relations.md、characters/<name>/MEMORY.md）。
- **已注入**：memory_summary.md（勿重新读取）。
- **不作为记忆读取**：turn_evidence/ 与 .git/（内部数据）。
- **便签**：extensions/notes/ 由 MemoryNoteTool 写入；内容以正式记忆为准。

## 快速记忆检索（quick memory pass）

1. 浏览下方记忆摘要，提取任务相关关键词。
2. 用 MemorySearchTool 按这些关键词跨两轨搜索。
3. 命中后用 MemoryReadTool 读取最相关的 1-2 个文件。
4. 需要精确命令/错误文本/证据时，再读取对应的 history 或主题文件。
5. 没有相关命中就停止记忆查找，继续正常处理。

快速检索预算：
- 保持轻量：理想情况下主要工作在 4-6 次搜索内开始。
- 避免对所有记忆文件做全量扫描。

## 执行期间

- 若反复出错、行为令人困惑、或怀疑存在相关上下文，重新做一次快速记忆检索。

## 是否验证记忆

同时考虑漂移风险与验证成本：
- 事实易漂移且验证便宜：**先验证再回答**。
- 事实易漂移但验证昂贵/慢/有干扰：可以从记忆作答，但说明是记忆推导、可能过时，
  并考虑提供刷新。
- 事实低漂移且验证昂贵：通常直接采用记忆。
- 事实低漂移且验证便宜：按需验证。

## 从记忆作答时的诚实性

- 依赖了本轮未验证的记忆事实时，在最终回答里简短说明。
- 该事实可能漂移、来自旧记录时，说明它可能过时。
- 跳过了实时验证、交互场景下刷新会有用时，考虑提议刷新。
- 不要把未验证的记忆事实说成"已确认的最新状态"。
- 涉及隐私、授权、当前偏好或可能已变化的事实时，不单凭旧记忆替用户做决定。

## 更新记忆

- 普通根 Agent **不直接修改**正式记忆文件（MEMORY.md、topics/、history/、
  shared_user_memory.md、characters/*/MEMORY.md 等）。
- 只有用户明确要求记录时，用 MemoryNoteTool 写一条便签：
  - 一次一个小文件，只含要新增/删除/更新的内容；
  - 文件名 `<时间戳>-<短slug>.md`；
  - 不要试图自己编辑记忆文件。
- 后台整合器会把便签合入正式记忆。

## 结尾

记忆相关时，先做快速记忆检索，再深入探索工作区。

