# Context

Context 把已保存的 Message 变成模型消息, Session 与子代理共用这一转换; 再把模型消息,System Prompt 和工具拼成一次调用的输入. 它不读数据库, 也不决定何时压缩.

## 从持久化消息得到模型消息

`projectMessages(messages, resolveGenerationSource, attachmentOptions, resolveCharacter?)` 按传入顺序处理 Message 或其业务扩展, 返回 `ProjectedMessage[]`. 每项都有投影后的 `message` 和原来的 `messageId`. 有些消息或内容块会被丢掉, 因此不能用数组下标反查原消息; 需要对应 SQL 消息时用 `messageId`. 来源回调接收原业务消息: 根 Turn 从该消息所属 Turn 解析, 子代理从 Run 或 fork 保存的父来源解析.

- 空内容和中断的 Assistant 消息不进入模型输入.`tool_use` 与 `tool_result` 必须按 ID 完整配对,且调用在结果之前,才会被保留.
- Assistant 的推理块会保留;若能查到这条消息当时使用的模型,也会附上生成来源.换模型后能否重放推理块,由 LLM 的协议代码判断.
- 可选的 `resolveCharacter` 只接收有可见正文的 `role='assistant', kind='normal'` 消息. 返回名字时, 在投影后的第一个文字块前加 `角色全名:\n`, 不改变原消息,推理块,工具块或消息 ID. 根 Turn 只为不同角色返回名字; 子代理不传这个回调. 手动压缩可为所有已知角色返回名字, 让摘要保留发言归属.
- 附件图片在模型支持时读取原文件; 不支持时可使用传入的 Vision 描述能力. 附件描述仍按真实文件路径缓存, 命中缓存时不用重新读文件. 文件引用,粘贴文本和 Skill 引用也会转成模型能读的内容. 附件处理可能读文件或等待 Vision, 所以这个函数是异步的.

这个函数只处理调用方交给它的消息;它不查 Session,也不为 fork 子代理补假的工具结果.

## 准备一次模型调用

```ts
const prepared = assembleContext({
  systemPrompt,
  toolPool,
  messages,
  contextWindow,
});
```

工具图片在 `projectMessages` 和装配过程中保留原始 `image_data` / `image_url` 与工具调用 ID. Context 不判断工具结果的协议格式, 不自动调用 Vision 描述工具图片. Chat 的工具图片占位由 LLM 的 Chat 转换处理, 只影响 SDK 请求, 不写回原始消息或 SQL. 需要备用描述时由主模型显式调用 DescribeImage 工具, 见 [工具说明](../builtin-tools/tools/DescribeImageTool/README.md).

这里的 `messages` 是已经整理好的模型消息,不包含 system 消息.`assembleContext` 会按顺序放入 System Prompt 和这些消息,再按 `ToolPool` 的顺序生成工具定义.它清掉输入消息上一次调用留下的缓存断点,保留 Prompt 块自带的断点,并给本次请求最后一条非空消息打断点.

返回的 `PreparedContext` 包含:

- `messages`:本次要交给 LLM 的完整消息;
- `tools`:本次模型可见的工具定义;
- `usage`:按上述完整消息和工具估算的输入 Token 数,以及模型的上下文窗口.

System Prompt 为空,或传入的模型消息中夹有 system 消息时,装配会报错.`buildPromptMessages` 也可单独把 Prompt 块转成 system 消息,手动 `/compact` 会用它.

## Token 数怎样更新

`assembleContext` 估算本次完整消息和工具的输入 Token 数. 调用前可用 `estimatedContextUsage` 表示估算值; 模型返回用量后, `providerContextUsage` 改用模型报告的输入 Token 数. 若随后又追加了模型可见消息, `appendEstimatedContextMessages` 把新增部分计入, 并将来源重新标为估算.

Context 不创建模型客户端,不写 Summary,不生成 Reminder, 也不选择压缩方式. 附件图片描述通过调用方提供的入口执行, 原有路径缓存保留; 其他执行顺序由 Turn 和 Compact 处理, 厂商协议格式由 LLM 代码处理.
