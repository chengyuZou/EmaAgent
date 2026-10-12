# @ema-agent/prompts

提供产品静态规则与动态 System Prompt 装配. 调用方按数组顺序发送 PromptBlock, 本包不读取 Session, Store 或文件.

## 使用方式

```ts
const systemPrompt = [
  ...staticSystemPrompt,
  ...getDynamicSystemPrompt(input),
];
```

根 Turn 与手动 Compact 使用这两个入口. 子代理复用同一静态规则和父 Turn 已读取的工作区, Memory, Skill 与 MCP 文本, 省略角色, 按自己的模型与工具生成动态说明, 最后由 Turn 追加委派任务边界.

`PromptBlock.name` 供 Context Usage 和前端分类展示, 不发送给模型. 模型看到的是 `content` 和数组顺序. `cacheBreakpoint` 只标在最后一个产品静态块上, Context 在这里设置缓存断点.

## 产品行为

`productPrompt.ts` 维护身份与现实边界, 用户意图判断, 调查, 执行, 工具选择, 权限与安全, 失败处理, 验证和沟通规则.

正文图片与普通音频使用 `![简短说明](地址)`, 地址不包尖括号. 本地地址用绝对路径、正斜杠与必要的百分号编码. 普通文件链接仍用 `[说明](地址)`. 音频引用单独成段, 前端按地址路径的音频后缀选择播放器, 不靠说明文字猜测无后缀资源. 这些规则不改变 Turn 的语音生成与重播入口.

根 Agent 始终使用当前激活角色. 用户当前请求决定是聊天, 共同讨论, 只读调查还是执行; 不需要选择不同的执行模式. 讨论, 审查和诊断不默认授权修改, 明确的执行请求则在实际权限和 ToolPool 内推进. 自然交流与完整任务执行使用同一套规则, 不因使用工具而放弃角色身份.

EmaAgent 是产品与环境名称, 不是角色姓名. 角色姓名, 人设和表达由 characters 包提供. 子代理没有根角色人设, 只执行父 Agent 派发的子任务, 向父 Agent 交付结果, 不接管根 Goal.

产品规则部分参考 Claude Code `src/constants/prompts.ts` 中的 Intro, System, Doing tasks, Actions, Using tools, Communication 与 Tone. 规则以本项目实际能力和任务边界为准.

## 动态输入

- `characterPrompt`: 根 Session 与手动 Compact 提供角色包的当前角色段落读取函数. 子代理省略; 可选类型不代表根 Agent 可以跳过角色.
- `permissionMode`: 本轮冻结的 Session 权限. 默认权限, 自动接受编辑, 绕过权限与 Plan 使用同一说明入口. Plan 只允许只读调查与规划, 即使用户请求实施也必须遵守. Prompt 说明不替代工具池筛选与执行期权限判定.
- `toolNames`: 当次 Provider tools[] 来自同一 ToolPool 的稳定工具名集合, 只决定哪些能力指引出现. Tool 的参数, Schema, 输入限制和结果语义由工具契约与 Provider tools[] 提供.
- `environment`: 调用方冻结的平台, cwd, 项目源文件夹与本次实际模型.
- `workspaceInstructions`, `skillCatalog`, `mcpInstructions`, `memorySection`: 调用方读取的文本. 本包只安排位置; 本 Turn 开始时的记忆与任务事实另存进持久化 reminder.

工作区指令由工作区模块读取, Skill 目录由 skills 包生成, MCP 指引由 mcp 包提供, Memory 指引由 memory 包生成. 外部文本受产品规则末尾的外部内容信任说明约束, 不能通过进入 System Prompt 自行取得系统权限.

## 装配顺序与缓存

```text
product-rules            产品静态规则与外部信任说明, cacheBreakpoint
workspace-instructions   调用方读取的工作区指令
memory-guidance          Memory 使用指引
skill-catalog            可用技能目录
mcp-instructions         每个 server 的指引
character                仅根 Session 与手动 Compact, 角色段落合为一个块
permission-mode          当前实际权限
capability-guidance      本次 ToolPool 中存在的能力
runtime-environment      平台, 工作区与本次实际模型
subagent                 仅子代理, 由 Turn 追加
```

静态数组在模块加载时生成一次, 不按 Session, 模型或子任务重复生成. 动态函数只装配文本, 不内置查询缓存. 可变内容放在静态缓存断点之后; 较稳定的文本在前, 频繁变化的角色, 权限, 能力与环境在后. 模型与环境排最后, 换模型不会改变前面的相同文本.

普通, fork 与继续旧会话只改变工作历史的初始化, 不改变 System 装配规则. `PreparedTurn.DynamicSystemPromptInput` 保存本轮输入, 子代理复用已读取文本, 替换模型与工具名, 不再次读取父角色.

## 能力指引

`sessionCapabilityGuidance` 只按真实 ToolPool 的工具名展开专用工具优先, 搜索, 并行, Task, Skill, Scratchpad, 后台进程与 Subagent 的协作说明. 用户禁用的工具, 未配置的宿主能力与 Plan 排除的工具不能由 Prompt 补造.

`@ema-agent/builtin-tools/identity` 是纯常量子路径, 避免工具重命名后指引使用错误名称. 本包不导入内置工具实现. Narrative 等能力由实际工具池决定, 不按角色名称自动开关.

测试入口为 `tests/systemPrompt.test.ts`, 覆盖段序, 静态断点, 角色与权限边界, 统一行为规则和按工具名展开的能力说明.
