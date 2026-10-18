# Commands

[English](./README.md)

这个包提供聊天命令目录和 Session 手动压缩. 目录包含 `compact` 和 `goal`. 桌面端自行打开 Goal 编辑界面; 手动压缩经 Session WebSocket 调用 `compactSession(deps, sessionId)`.

## 手动压缩

Server 提供 Session 存储, 运行登记, 模型设置, 当前角色与 Skill 来源, 图片处理入口和 `CompleteLLM` 工厂. 实际组装见 [Server composition](../../apps/server/src/composition/commands.ts).

1. 确认 Session 可以接受工作且已选择模型, 再用生成的 `compactId` 登记可取消的压缩.
2. 读取有效历史, 通过 [Context](../context/README-zh.md) 转成模型消息. 历史回复保留当时的角色名和模型来源.
3. 只估算历史, 检查 `context.compact.manualMinRatio` 手动下限. 历史太短时, 在读取 Skill 目录和 Memory 指引前拒绝. 全部历史都在近期原文保留预算内时也拒绝.
4. 装配当前静态和动态 System Prompt. 调用 [Compact](../compact/README-zh.md), 传入 `force: true`, `micro: false`, 不提供工具.
5. 把被摘要覆盖的消息数量映射到最后一条 SQL Message ID. 以 `turnId: null` 追加摘要, 原始消息仍保存在数据库. Compact 等保存成功后才发送完成事件.
6. 先解除运行登记, 再通过 `onFinished` 通知后续工作的调度入口.

结果为 `completed` 或 `cancelled`. 完成结果包含模型窗口, 压缩前后估算, 减少量和耗时. 其他失败抛出 `CommandsError` 或依赖错误. 取消使用登记时的 `compactId`, 手动压缩不会创建 Turn.

`GET /api/commands` 返回目录. 桌面端经 Session WebSocket 发送 `start_compaction`, 接收 `manual_compact_result`. 见 [WebSocket 路由](../../apps/server/src/routes/ws/session.ts) 和 [输入菜单](../../apps/desktop/src/chat/input/AddInputMenu.tsx).

## 阅读与检查

从 [compactSession.ts](./compact/compactSession.ts) 开始, 再跟进 Context 历史转换和 Compact 保存回调. [catalog.ts](./catalog.ts) 保存菜单条目. Server 请求与错误处理由 [sessionWebSocketRoute.test.ts](../../apps/server/tests/sessionWebSocketRoute.test.ts) 覆盖. 本包目前没有本地测试文件.
