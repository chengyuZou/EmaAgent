下面是一个已完成 Turn 的 JSON 输入：

- `characterName` 是本次 Relationship Memory 的角色归属。
- `messages` 是按真实发生顺序排列的用户文本与该角色的助手文本。
- Tool Call、Tool Result、System、reasoning、附件和 AskUser 不会进入这里。
- 这份输入与 Work 提取器收到的对话副本相同，但你只判断 Relationship Memory。

按照 system 里的最低信号门槛提取关系信号。不要复述原始消息，不要总结任务过程，不要改变 `characterName`。没有值得记录的内容时返回 `{}`。

Turn JSON：
