# Prompts

Prompt 模块只定义并装配模型应遵守的 System Prompt 指令。它不拥有 Session 历史、当前用户输入、Memory/Narrative/KB 召回、附件正文、Tool Result、Token 预算或压缩。

```text
Product Rules       Global Active Character        Turn Profile
     │                 │                              │
     └─────────────────┴──────────────┬───────────────┘
                                      ▼
                               PromptBuilder
                                      │
                                      ▼
                               PromptAssembler
                                      │
                     ┌────────────────┴────────────────┐
                     ▼                                 ▼
              System Prompt Blocks             Extension Context Blocks
           product → activeCharacter → turn      Skill Catalog 等非可信目录
                     └────────────────┬────────────────┘
                                      ▼
                               ContextAssembler
```

## 文件职责

- `promptBuilder.ts`：收集产品、角色、Chat/Work、NarrativePolicy 与扩展贡献。
- `promptAssembler.ts`：校验 Slot、按 product/activeCharacter/turn 分层，冻结快照并计算分层 revision。
- `types.ts`：Prompt Slot、Contribution、Snapshot 与 BuildRequest（Slot 身份、顺序、稳定范围、投递方式与信任级别集中声明在 `SLOT_SPECS`）。
- `productPrompt.ts`：Ema 固定行为与通用工具原则。
- `executionProfilePrompt.ts`：Chat/Work 和 NarrativePolicy 的行为说明，不承担真实权限判断。
- `errors.ts`：Prompt 装配错误。

## 装配后的 Message 长什么样

`PromptAssembler.build()` 产出 `PromptSnapshot`，其中 `systemBlocks` / `contextBlocks` 是按 `stabilityScope` 分组合并后的块。下图是一次 Work Turn 实际产出的 System Prompt 文本结构（块顺序固定，缓存断点由稳定范围决定）：

```text
role: system                          stabilityScope    cacheBreakpoint
──────────────────────────────────────────────────────────────────────
┌─ systemBlocks[0] ────────────────────────── product ──── ✅ 断点 ─┐
│ # Ema 基本行为                (product.rules,        order 10)    │
│ # 工具使用通用原则            (product.toolGuidance, order 20)    │
└──────────────────────────────────────────────────────────────────┘
┌─ systemBlocks[1] ───────────────────── activeCharacter ── ✅ 断点 ┐
│ ## 角色身份                  (character.identity,      order 60)  │
│ ## 角色表达控制协议          (character.presentation,  order 70)  │
└──────────────────────────────────────────────────────────────────┘
┌─ systemBlocks[2] ───────────────────────────── turn ──── ❌ 无断点┐
│ ## 当前执行方式：Work        (profile.execution,       order 80)  │
│ ## 剧情资料策略：自动        (profile.execution 内)              │
└──────────────────────────────────────────────────────────────────┘

role: user (context 投递，非 system 指令)
┌─ contextBlocks[0] ──────────────────────── turn ──── ❌ 无断点 ──┐
│ ## 可用技能                 (extension.skillCatalog,  order 40)  │
└──────────────────────────────────────────────────────────────────┘
```

要点：

- 同一 `stabilityScope` + 同一 `delivery` 的 Slot 合并成**一块**，内容用 `\n\n` 拼接。所以 `product.rules` 和 `product.toolGuidance` 同在 `systemBlocks[0]`。
- `cacheBreakpoint = stabilityScope !== 'turn'`：`product` 和 `activeCharacter` 块打断点，`turn` 块不打。切 Chat/Work 只动 `turn` 尾，前两个缓存前缀不破。
- `extension.skillCatalog` 是 `delivery: 'context'`，不进 system，以普通 user 消息投递——拿不到产品 System 指令权限。
- 这些块后续由 `ContextAssembler` 转成 `Message[]`（system 块 → `role:'system'`，context 块 → `role:'user'`），带上 `cacheBreakpoint` 标记，再由 Provider Adapter（如 Anthropic）转成 `cache_control`。

## Chat 与 Work 的差异

只有 `turn` 尾部不同，`product` 与 `activeCharacter` 前缀完全一致：

```text
                product 块      activeCharacter 块     turn 块
                (固定)          (切角色才变)           (每 Turn 可变)
────────────────────────────────────────────────────────────────
Chat + auto     相同            相同                   ## 当前执行方式：Chat
                                                      ## 剧情资料策略：自动
────────────────────────────────────────────────────────────────
Work + off      相同            相同                   ## 当前执行方式：Work
                                                      ## 剧情资料策略：关闭
────────────────────────────────────────────────────────────────
缓存命中        ✅ global       ✅ 同角色复用          ❌ 每 Turn 重算
```

`profile.execution` 的 `version` 字段是 `execution-profile:v1:${executionProfile}:narrative:${narrativePolicy}`，任一变化都会让 `turn` revision 改变，但**不影响** `product` / `activeCharacter` 的 revision 与缓存。

## 边界

- Character 模块拥有角色人设与 ACT 表达协议。全局同时只有一个激活角色，所有 Session 的新 Turn 读取同一角色；Turn 启动后使用冻结快照，不接受中途切卡改写。
- `activeCharacter` 描述全局角色的变化周期，不是 Session 绑定，也不表示角色卡存进 Prompt。
- 产品规则和全局角色分别形成缓存断点；Chat/Work 与 NarrativePolicy 位于 Turn 动态尾部，不再把全部 System Prompt 压成一条字符串。
- Skill Catalog 等扩展目录使用普通 Context Message 投递，不能取得产品 System 指令权限。完整 Skill 仍通过 Tool 按需加载。
- Agent Profile 和根 Turn ToolPool 决定模型实际能调用哪些工具；Prompt 文字不是权限边界。
- ContextAssembler 把 PromptSnapshot、历史、当前 Turn、运行时 Contribution 和 ToolPool 组成单次模型请求。
- 工作区路径等运行时事实不进入 Prompt；由 Context 使用明确来源注入。
- Tool Schema 通过 LLM 请求的 `tools` 字段发送，不复制到 System Prompt。
