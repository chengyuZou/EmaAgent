# Stage

[English](README.md)

Stage 从模型流式正文中移除情绪和动作标签, 返回相应的角色表现事件. Server 提供当前角色允许的名称, 每段文本先经过 `StageEngine`, 再保存或展示清理后的正文.

## 处理流式文本

```ts
import { StageEngine } from '@ema-agent/stage';

const stage = new StageEngine({ emotions: ['happy'], motions: ['wave'] });
stage.beginTurn(sessionId);
const first = stage.processChunk('Hello <emot', turnId, sessionId);
const second = stage.processChunk('ion>happy</emotion>there', turnId, sessionId);
const tail = stage.flush(sessionId);
```

第一次返回 `Hello `, 第二次返回 `there` 和携带 Session ID, Turn ID 及 `happy` 的 `emotion_changed` 事件. 调用方发布事件并转发清理后的正文. Desktop 根据这些身份判断是否作用于当前显示的角色.

识别的标签为小写 `<emotion>name</emotion>` 和 `<motion>name</motion>`. 名称以 ASCII 小写字母开头, 后面允许小写字母, 数字或下划线, 名称两侧允许空白. 完整但未声明的名称仍从正文移除, 只是不发事件. 相同的已知标签重复出现会重复发事件. 其他文本和无关标签保持原样.

## Turn 与角色变化

`beginTurn` 替换该 Session 的扫描器, 避免上轮未闭合标签影响下一轮. 没有先调用它时, `processChunk` 原样返回正文. 不同 Session 使用不同扫描器.

扫描器暂存可能属于标签的尾部, 等下段文本到达后继续识别. 128 个 UTF-16 码元的限制避免未闭合标签一直扣住后续正文. `flush` 将残留片段作为普通正文返回, 不发角色事件; 它清空尾部, 但保留扫描器.

共享角色切换时, Server 调用 `reset` 和 `updateVocabulary`, 丢弃未闭合标签并替换允许的名称. 删除 Session 时调用 `evictSession`. 当前展示什么情绪和动作由消费方决定, 引擎按识别出的标签返回事件.

## 代码与验证

[engine.ts](engine.ts) 管理 Session 扫描器并检查名称, [parser.ts](parser.ts) 识别跨文本片段的标签. [Turn](../turn/core/turnExecutor.ts) 转发正文和事件, [Desktop 订阅](../../apps/desktop/src/chat/session/sessionSubscriptions.ts) 将角色变化交给当前表现逻辑.

运行 `pnpm --filter @ema-agent/stage test`. 测试覆盖已知及未知名称, 重复标签, 词汇切换, 拆开的标签和无关模型标记.
