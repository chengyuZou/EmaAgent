下面是一个已完成 Turn 的 JSON 输入：

- `messages` 是按真实发生顺序排列的标准消息。
- 只包含用户文本与助手文本；Tool Call、Tool Result、System、reasoning、附件和 AskUser 不会进入这里。
- 这份输入与 Relationship 提取器收到的对话副本相同，但你只判断 Work Memory。

按照 system 里的最低信号门槛，提取稳定的工作偏好和协作习惯。不要复述原始消息，不要总结任务过程。没有值得记录的内容时返回 `{}`。

Turn JSON：
