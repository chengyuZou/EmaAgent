# Context

[English](./README.md)

Context 把 Session 存储消息转成模型历史, 再用 Prompt 块, 工作消息和 ToolPool 装配模型输入. 它也生成压缩判断和上下文球使用的输入估算.

## 主要入口

`projectMessages(history, resolveGenerationSource, attachmentOptions)` 返回模型消息和存储 Message ID. 空内容, 中断回复, 缺失, 重复或顺序错误的工具配对不会进入模型历史. 推理块保留签名和生成来源, 供 LLM adapter 判断目标模型是否可以重放. 已保存的正文, reminder 和协议角色原样重放, 不添加姓名前缀或历史引用标签. 角色切换由 Turn 写入其持久化 reminder, 不在投影期间重新计算.

`assembleContext({ systemPrompt, toolPool, messages, contextWindow })` 返回 `messages`, `tools` 和 `usage`:

1. 去掉工作消息已有的缓存标记, 拒绝混在其中的 system 消息.
2. 按输入顺序把非空 Prompt 块转成 system 消息, 保留块上的缓存标记. System Prompt 全为空时抛错.
3. 按 ToolPool 顺序转成 LLM 定义. 显式 JSON Schema 优先于从 Zod 转换的结果.
4. 给最后一条非空消息加缓存标记, 估算包含 System Prompt, 历史和工具的完整输入.

执行器使用同一个 ToolPool. [Turn 准备过程](../turn/prepare/prepareAgentIteration.ts) 在压缩前后装配输入. [Commands](../commands/README-zh.md) 使用 `buildPromptMessages` 构造手动摘要请求.

## 附件

`buildAttachmentMessages` 处理已保存引用:

| 引用 | 模型内容 |
| --- | --- |
| `file_reference` | 文件名和原路径, 不读取文件. |
| `pasted_text_reference` | 保存的路径和预览, 不读取文件. |
| 图片, 模型支持图片 | 标签和从磁盘读取的 base64 图片. |
| 图片, 需要 Vision | 标签和 Vision 描述, 提供缓存时按文件路径复用. |

空闲估算可以传 `imageDescriptionPreview`. 此模式只读已有描述. 缺少描述但 Vision 可用时通知调用方, 返回标签, 不调用模型. 未配置 Vision, 文件读取失败或描述失败会转成说明文本. 取消错误继续抛出, 不伪装成图片缺失.

Skill 引用只记录用户当时的选择, 不加载技能指令. 实际调用时由 Skill 工具检查当前目录.

## 上下文用量与检查

`estimatedContextUsage` 标记本地估算. `providerContextUsage` 使用 Provider 对本次调用的输入实报及缓存用量. `appendEstimatedContextMessages` 累加之后新消息的估算, 把来源改回 `estimate`. 这里统计上下文输入, 不是累计计费用量或输出 Token.

[附件测试](./tests/buildAttachmentMessages.test.ts) 检查路径转换, 图片输入, Vision 缓存和预览, 失败及取消. [Turn 测试](../turn/tests/prepareAgentIteration.test.ts) 也会调用历史转换与装配.

```sh
pnpm --filter @ema-agent/context test
```
