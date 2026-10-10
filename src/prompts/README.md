# @ema-agent/prompts — System Prompt 装配

提供共享静态数组和动态装配函数. 调用方直接拼接为有序 PromptBlock 数组,
顺序即发送顺序, 不再提供完整 System 的转调接口.

## 公共接口

```ts
staticSystemPrompt: readonly PromptBlock[]
getDynamicSystemPrompt(input: DynamicSystemPromptInput): readonly PromptBlock[]
PromptBlock            // { name, content, cacheBreakpoint? }：name 只供分类展示，不进模型请求
DynamicSystemPromptInput
PromptEnvironment
```

根 Turn 与手动 Compact 直接使用:

```ts
const systemPrompt = [
  ...staticSystemPrompt,
  ...getDynamicSystemPrompt(input),
];
```

子代理使用同一静态数组, 动态输入不带角色和 SessionMode, 最后追加委派工作说明.
普通、fork 和继续旧会话只改变工作历史的初始化, 不改变这套 System 装配.

## 规则

- **没有槽位注册表、SlotId 联合、order 数字、stability 枚举、版本字段、revision
  哈希、PromptSnapshot 类型、Turn 中途扩展入口**——这些已拆除,不得重建。
  动态边界哨兵（PROMPT_DYNAMIC_BOUNDARY）也已删除：静态/动态分界由
  `cacheBreakpoint` 标记在最后一个产品静态块上表达，不再有混入数组的哨兵元素。
- 断点之前只放全产品稳定内容(产品环境、执行、安全、工具与沟通规则);之后放随会话/角色/
  Turn 变化的内容(数据级内容、角色、SessionMode、能力引导)。会话级可变内容不得越过断点,
  避免无意破坏 KV Cache 前缀。
- `name` 是 Context Usage 分类与前端展示的稳定键，绝不发送给模型；`content` 与数组
  顺序才是模型可见事实。
- 静态数组在模块加载时生成一次, 固定正文与缓存断点不变. 动态函数只做字符串装配,
  不读取 Store 或文件; 数据读取由调用方负责, 本包不内置 memo.
- **文案归属**:本包只写产品级文案(`productPrompt.ts`/`sessionModePrompt.ts`);
  角色人设归 characters 包、Skill 目录归 skills 包、MCP 指引归 mcp 包、工作区指令归
  工作区模块。本包只摆它们的位置,不替任何业务写文案。
- **产品名不是角色名**:`EmaAgent` 只表示产品和运行环境。当前姓名、身份、人设与
  表达方式全部来自 characters 包产出的 `CharacterPrompt`;产品静态段不得
  再声明“你是 Ema”或任何固定角色。
- 前台根 Agent 始终以当前激活角色行动. Chat/Work 只改变执行方式, 不切换身份.
  子代理不传角色与 SessionMode; Turn 在通用规则之后明确纯工作身份、委派范围和向父交付.
  静态文案原样共用, 不另建子代理版产品规则.
- Narrative 是否可用由模型绑定、工具开关和当轮 ToolPool 决定. 不按角色名称自动开关工具;
  最终 Pool 没有 Narrative Tool 时, Prompt 也不会凭空声明该能力.
- 工作区/Skill/MCP 的信任级由产品静态块末尾统一说明, 不逐段重复, 不设 delivery 标记.
- Tool 的参数、Schema、单工具输入限制与结果语义只住在 `Tool` 契约，Provider 经
  ToolPool 投影；Prompt 不复制参数说明。跨工具的选择顺序、专用工具优先、搜索构造、
  并行策略以及 Task/Skill/Subagent 协作规则属于 Agent 行为，因此由动态能力引导负责。
- 能力引导只读取同一 ToolPool 的稳定工具名，并只展开当轮真实存在的规则。
  `@ema-agent/builtin-tools/identity` 是纯常量子路径,用于避免工具重命名后 Prompt 漂移;
  本包不导入内置 Tool 实现。
- `productPrompt.ts` 以 Claude Code `src/constants/prompts.ts` 的 Intro、System、
  Doing tasks、Actions、Using tools、Communication 与 Tone 为逐项来源。只删除 Ema
  不存在的 ToolSearch/DiscoverSkills、Hook、Plan、Worktree、斜杠命令、产品反馈渠道
  和 Claude/Anthropic 宣传内容；其余适用规则不得再次压缩为几条摘要。
- `sessionModePrompt.ts` 是执行契约，不是语气开关。Chat 定义对话理解、事实核验、
  可执行动作和连续性；Work 定义任务接管、调查、实现、并行、验证、进度和最终交付。
  两种模式都使用同一个 Agent 与当轮 ToolPool，任何模式都不凭空增加或删除能力。

## 输入注入契约(接线方)

- `characterPrompt`:根 Session 必须提供角色包的当前角色段落读取函数,
  子代理明确省略. 可选只服务纯工作调用, 不代表根 Agent 可以静默跳过角色.
- `sessionMode`:根 Session 与手动 Compact 提供 Chat/Work; 子代理省略,
  委派执行要求由末尾的子代理说明表达.
- `toolNames`:当次 Agent 实际 ToolPool 的稳定名称集合,只决定动态能力引导是否出现;
  每个 Tool 的参数 Schema 与详细用法仍由 Provider `tools[]` 提供。
- `permissionMode`:本轮冻结的 Session 权限. 四档权限在 SessionMode 后使用同一个权限说明块,
  分别说明默认批准规则, 工作区自动接受编辑, 中央绕过权限和 Plan 只读限制.
  不替换 Chat/Work, 不新增进入或退出流程; 说明不替代工具池和执行期的实际判定.
- `environment`:本轮平台、工作区和模型事实,由调用方冻结后注入。
- `workspaceInstructions` / `skillCatalog` / `mcpInstructions` / `memorySection`:可选,由调用方
  在根 Turn 装配时注入. PreparedTurn 的 `DynamicSystemPromptInput` 保存这份输入,
  子代理复用已读的数据文本, 替换自己的模型和工具名, 不再次读取父角色.

## 段序(固定)

```text
product-rules               静态单块, 含全部固定规则与外部信任说明, cacheBreakpoint 在这里
workspaceInstructions       ┐
memoryGuidance              │ 调用方注入的数据与指引
skillCatalog                │
mcpInstructions…            ┘
character                   仅根 Session, 角色单块
sessionMode                 仅根 Session, chat/work
permissionMode         四档权限的实际边界, Plan 约束 Chat/Work 中的实施要求
sessionCapabilityGuidance   当轮 ToolPool 派生的完整跨工具规则
runtimeEnvironment          平台/工作区/本次实际模型, 动态部分最末
subagent                    仅子代理, 放在通用规则和动态块之后
```
