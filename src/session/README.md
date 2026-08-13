# Session

> 状态：目标接口已冻结，当前 `store.ts/types.ts/protocol.ts` 仍包含待迁出的 Turn 与 Wire 职责。

`src/session` 只拥有持久会话、Session 偏好和消息历史。它不知道一次 Turn 怎么运行，也不提供 HTTP DTO。

## 领域内容

Session 持久事实：

- id、标题、workspace、创建/更新时间；
- 归档、置顶、分组、父 Session；
- 默认 Chat/Work、Narrative 策略和模型偏好；
- lastViewedAt。

`runningTurnCount`、`lastTurnStatus`、`hasUnread` 是列表读模型，不是可修改 Session 实体。需要同时展示 Session 与 Turn 状态时，由 Application Server 查询层联合两个业务结果。

Message 持久事实：

- sessionId、可选 turnId、role、kind；
- text、thinking、tool_use、tool_result、媒体引用等内容块；
- createdAt 与 interrupted。

Session Message 不是 `LlmRequest`。Context 负责把持久消息投影成 Provider 中立 `llm.Message`。

## Store 边界

```ts
class SessionStore {
  createSession(...): Session;
  getSession(...): Session;
  listSessions(...): SessionPage;
  patchSession(...): Session;
  archiveSession(...): void;
  forkSession(...): ForkedSession;
  assertWritable(...): void;
  deleteRows(...): void;
}

class MessageStore {
  append(...): Message;
  appendOrUpdateAssistantBlock(...): Message;
  appendToolResult(...): Message;
  markInterrupted(...): void;
  loadHistory(...): Message[];
  listMessages(...): Message[];
  writeSummaryBoundary(...): void;
}
```

这里列的是职责，不要求为了方法数量再套 Port/Facade。`SessionStore` 不创建 Turn，`MessageStore` 不执行 Context 或 Compact。

## 必须迁出

- Turn 类型、start/complete/fail/abort/recover/rewind、Turn index 和锚点窗口 → `src/turn`；
- `ActiveTurnRegistry` → `src/turn`；
- `SessionOwnershipFacade.assertTurnOwnership` → `TurnStore`；
- `protocol.ts` 全部 Wire DTO → `apps/server/src/routes`；
- `SessionLifecycle` 的 Runtime/Permission/Memory/文件级联 → `apps/server/src/application/deleteSession.ts`；
- `NarrativeContextBlocks` 等已退役历史兼容类型直接删除，不在新 Message 契约里续命。

Session 永久删除确实跨多个业务包，因此 Application Server 的删除用例负责顺序：停止活动 Turn、取消决定、清理 Runtime、调用 Memory 删除钩子、删除数据库聚合、清理受控文件。Session 包只执行自己的数据库动作。

## 目标目录

```text
src/session/
├─ README.md
├─ types.ts
├─ message.ts
├─ errors.ts
├─ sessionStore.ts
├─ messageStore.ts
├─ sessionTitle.ts
└─ tests/
```

Turn 导航属于 TurnQueries，不为现有 `history/sessionHistory.ts` 保留子目录。Session 标题是一个真实 Session 用例，可用注入的单次 completion 函数并带确定性回退；它不需要 Provider Runtime。

## 依赖方向

```text
turn ──> session ──> ids / storage
                    └─ llm、tools 的持久内容类型
```

Session 不导入 Turn、Agent、Context、Compact、Memory、Permission、Speech 或应用 Route。
