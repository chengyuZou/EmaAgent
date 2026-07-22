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
- `productPrompt.ts`：Ema 固定行为与通用工具原则。
- `executionProfilePrompt.ts`：Chat/Work 和 NarrativePolicy 的行为说明，不承担真实权限判断。
- `types.ts`：Prompt Slot、Contribution、Snapshot 与 BuildRequest。
- `errors.ts`：Prompt 装配错误。

## 边界

- Character 模块拥有角色人设与 ACT 表达协议。全局同时只有一个激活角色，所有 Session 的新 Turn 读取同一角色；Turn 启动后使用冻结快照，不接受中途切卡改写。
- `activeCharacter` 描述全局角色的变化周期，不是 Session 绑定，也不表示角色卡存进 Prompt。
- 产品规则和全局角色分别形成缓存断点；Chat/Work 与 NarrativePolicy 位于 Turn 动态尾部，不再把全部 System Prompt 压成一条字符串。
- Skill Catalog 等扩展目录使用普通 Context Message 投递，不能取得产品 System 指令权限。完整 Skill 仍通过 Tool 按需加载。
- Agent Profile 和 Tool Manifest 决定模型实际能调用哪些工具；Prompt 文字不是权限边界。
- ContextAssembler 把 PromptSnapshot、历史、当前 Turn、运行时 Contribution 和 Tool Manifest 组成单次模型请求。
- 工作区路径等运行时事实不进入 Prompt；由 Context 使用明确来源注入。
- Tool Schema 通过 LLM 请求的 `tools` 字段发送，不复制到 System Prompt。
