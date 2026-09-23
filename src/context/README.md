# Context

Context 把已保存的 Session 消息变成模型消息，再把模型消息、System Prompt 和工具拼成一次调用的输入。它不读数据库，也不决定何时压缩。

## 从 Session 消息得到模型消息

`projectSessionMessages(sessionMessages, resolveGenerationSource, attachmentOptions)` 按传入顺序处理消息，返回 `ProjectedSessionMessage[]`。每项都有投影后的 `message` 和原来的 `sessionMessageId`。有些消息或内容块会被丢掉，因此不能用数组下标反查原消息；需要对应 SQL 消息时用 `sessionMessageId`。

- 空内容和中断的 Assistant 消息不进入模型输入。`tool_use` 与 `tool_result` 必须按 ID 完整配对，且调用在结果之前，才会被保留。
- Assistant 的推理块会保留；若能查到这条消息当时使用的模型，也会附上生成来源。换模型后能否重放推理块，由 LLM 的协议代码判断。
- 图片在模型支持时读取原文件；不支持时可使用传入的 Vision 描述能力，没有描述能力就转成文字提示。文件引用、粘贴文本和 Skill 引用也会转成模型能读的内容。附件处理可能读文件或等待 Vision，所以这个函数是异步的。

这个函数只处理调用方交给它的消息；它不查 Session，也不为 fork 子代理补假的工具结果。

## 准备一次模型调用

```ts
const prepared = assembleContext({
  systemPrompt,
  toolPool,
  messages,
  contextWindow,
});
```

这里的 `messages` 是已经整理好的模型消息，不包含 system 消息。`assembleContext` 会按顺序放入 System Prompt 和这些消息，再按 `ToolPool` 的顺序生成工具定义。它清掉输入消息上一次调用留下的缓存断点，保留 Prompt 块自带的断点，并给本次请求最后一条非空消息打断点。

返回的 `PreparedContext` 包含：

- `messages`：本次要交给 LLM 的完整消息；
- `tools`：本次模型可见的工具定义；
- `usage`：按上述完整消息和工具估算的输入 Token 数，以及模型的上下文窗口。

System Prompt 为空，或传入的模型消息中夹有 system 消息时，装配会报错。`buildPromptMessages` 也可单独把 Prompt 块转成 system 消息，手动 `/compact` 会用它。

## Token 数怎样更新

`estimateContextUsage` 只对一次调用的完整消息和工具估算一次。调用前可用 `estimatedContextUsage` 表示估算值；模型返回用量后，`providerContextUsage` 改用模型报告的输入 Token 数。若随后又追加了模型可见消息，`appendEstimatedContextMessages` 把新增部分计入，并将来源重新标为估算。

Context 不调用模型、不写 Summary、不生成 Reminder，也不选择压缩方式。这些由 Turn 和 Compact 按各自的执行顺序处理；厂商协议格式由 LLM 代码处理。
