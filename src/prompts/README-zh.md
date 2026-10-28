# Prompts

[English](README.md)

Prompts 为对话, 手动历史压缩和子 Agent 生成 System Prompt. 它把共用的产品规则与调用方提供的角色, 权限模式, 工具列表和运行环境组合起来.

## 使用方式

```ts
import {
  staticSystemPrompt,
  getDynamicSystemPrompt,
} from '@ema-agent/prompts';

const systemPrompt = [
  ...staticSystemPrompt,
  ...getDynamicSystemPrompt(input),
];
```

`staticSystemPrompt` 是模块加载时生成的冻结数组, 内含一个产品规则块. `getDynamicSystemPrompt(input)` 返回按顺序排列的动态块. `PromptBlock` 包含 `content` 和可选的 `cacheBreakpoint`.

Context 按原顺序把这些块转成 system 消息, LLM 包再转换为当前 Provider 的请求格式.

`subagentPrompt` 从 [subagentPrompt.ts](subagentPrompt.ts) 提供委派工作的约束, 由 Turn 在准备子代理时追加. 静态规则说明如何续写截断的回答和避免无效重试; 实际发生输出截断时, 续写通知由当前 Agent 的消息消费方保存.

## 输入从哪里来

| 输入 | 当前来源与含义 |
| --- | --- |
| `characterPrompt` | Server 提供的当前角色段落. 对话和手动压缩包含角色, 子 Agent 省略角色. |
| `permissionMode` | 本次请求固定使用的 Session 权限模式. |
| `toolNames` | 与模型工具定义和执行器来自同一个 ToolPool 的工具名. 手动压缩传空数组. |
| `environment` | 本次平台, Session cwd, 项目文件夹与实际使用的 Provider 和模型. cwd 为 null 时生成没有执行目录的说明. |
| `workspaceInstructions` | Server 从工作区读取的指令正文. |
| `skillCatalog` | `renderSkillListing` 为当前 SkillPool 生成的目录文本. |
| `memorySection` | Memory 的使用指引. 实际 Memory 和 Task 事实通过持久化的 Turn reminder 另行提供. |

可选文本和角色段落按调用方提供的原文装配, 保留原有标点. 本包编写的产品正文, 标题和环境标签统一使用英文半角标点.

正式调用路径包括:

- [Turn 准备](../turn/prepare/prepareContextInput.ts) 使用同一份输入生成实际对话 Prompt 和空闲上下文估算.
- [手动压缩](../commands/compact/compactSession.ts) 读取当前角色和 Session 输入, 用空工具列表生成 system 消息.
- [子 Agent 准备](../turn/subagent/prepareSubagent.ts) 复用父 Turn 已读取的工作区, Memory 和 Skill 文本, 替换为子 Agent 的实际模型与工具名, 省略角色, 最后追加委派任务规则.

## 顺序与缓存

最终顺序为:

1. 共用产品规则与外部内容信任说明.
2. 工作区指令, 提供时加入.
3. Memory 使用指引, 提供时加入.
4. Skill 目录, 提供时加入.
5. 角色段落和角色切换 reminder 的简短说明, 提供角色时加入.
6. 权限模式说明.
7. 当前工具池的能力指引.
8. 平台, 执行目录, 项目文件夹和当前模型.

可选块为空白时省略. 工具池为空时, 仍会生成简短的通用能力说明.

角色段落与 TurnReminder 角色切换记录的简短说明保持在同一块中, 当前身份按本 Turn 确定. 切换记录区分历史发言区段, 不把其他角色的姓名和经历转给当前角色. 用户需求和已确认任务事实仍可接续使用. 省略角色时也一起省略这段说明.

本包只给共用静态块标记缓存断点. Context 保留该标记, 并另外给请求最后一条非空消息添加标记. Anthropic 协议把这些提示转换为 Provider 缓存标记, 其他当前协议忽略它们. 较稳定的文本排在前面, 尽量保持相同前缀, 是否复用缓存由 Provider 决定.

## 产品与工具规则

[productPrompt.ts](productPrompt.ts) 保存身份, 任务执行, 安全, 工具选择, 沟通和语气规则. EmaAgent 是产品名, 与当前角色身份分开. 聊天, 讨论, 调查和执行共用这些规则, 具体行动由用户请求和实际权限模式决定.

[systemPrompt.ts](systemPrompt.ts) 装配静态与动态块. Plan 文本说明只读调查和规划要求, 实际限制由包外的工具池筛选与执行期权限检查实施.

详细能力指引使用 `@ema-agent/builtin-tools/identity` 中的真实工具名生成, 说明工具选择与协作方式. 参数和结果约定由各工具提供. 工具名存在表示可以尝试调用, 所需绑定或执行条件仍可能缺失.

产品规则参考了 Claude Code `src/constants/prompts.ts` 的 Intro, System, Doing tasks, Actions, Using tools, Communication 和 Tone 部分, 正文描述本项目的行为.

## 验证

运行:

```sh
pnpm --filter @ema-agent/prompts test
pnpm --filter @ema-agent/prompts typecheck
```

[systemPrompt.test.ts](tests/systemPrompt.test.ts) 检查输出顺序, 可选输入, 静态缓存标记, 角色与权限说明, 按实际工具生成的能力指引, 本包正文的英文半角标点, 以及调用方原文保持不变.
