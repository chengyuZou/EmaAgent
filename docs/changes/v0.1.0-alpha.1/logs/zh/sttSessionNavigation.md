# 切换 Session 时的 STT 语音输入

[English](../en/sttSessionNavigation.md)

## 状态

2026-10-20, 源码修复和自动化检查通过, 用户随后确认 Dev 验收通过. 统一的安装版验收仍待完成. 自动化测试没有构建安装包, 没有开启真实麦克风, 没有发送模型请求.

## 问题与原因

在 Session A 录音后切到 B, 录音仍继续, B 也显示 A 的录音或转写控件. `ChatInput` 使用一份组件内录音引用和一份语音状态. 已有 Session 页面复用这个组件, 却没有在所选 Session 改变时停止录音. 切到新对话导致输入框重新挂载时, 旧清理逻辑还会取消未完成的操作.

原转写回调已经保存了所属 Session, 并在返回时读取最新草稿. 本次复现的是缺少切换停止处理和组件状态串用, 不是 Server 把转写结果路由到错误的 Session. Server 接收音频, 不接收目标 Session; 由 Desktop 决定将文本写入哪份草稿.

修复前最初 3 个组件测试有 2 项失败, 1 项通过: 切换没有调用 `MediaRecorder.stop()`, B 仍显示 A 的忙碌状态, 手动停止则可以正确追加到最新草稿.

## 修改

- [voiceInput.ts](../../../../../apps/desktop/src/chat/input/voiceInput.ts) 在 `ChatInput` 外持有未完成的语音操作, 按 Session 保存展示状态. 切换时同步停止原录音并释放音轨, 不取消已录音频的转写. 另一个 Session 可以在旧请求结束前开始自己的录音.
- 完成后只更新所属 Session 的最新草稿. 返回该 Session 时恢复进行中状态和取消入口. 已取消操作的迟到响应不能写入文本, 也不能清除后来开始的操作.
- 切换时若还在等待麦克风授权, 则丢弃该请求. 音频流稍后返回时直接关闭, 不创建录音器.
- [NewSessionPage](../../../../../apps/desktop/src/chat/NewSessionPage.tsx) 首发创建 Session 时, 将尚未结束的语音输入随新草稿一起迁移. [会话移除入口](../../../../../apps/desktop/src/chat/session/removeSessionFromChat.ts) 在清理草稿和切换页面前取消该 Session 的语音输入.
- 仅打开 Settings, 没有更换所选 Session 时, 保留原有录音行为. 本次不修改 TTS 生成, 播放, STT 协议适配或数据库存储.

## 验证

[chatInputSTTNavigation.test.tsx](../../../../../apps/desktop/tests/chatInputSTTNavigation.test.tsx) 挂载真实输入框, 语音控件和导航/草稿 Store. 麦克风访问, 原生录音事件和 STT 响应使用模拟对象; 无关输入控件被隔离. 17 项测试覆盖立即释放麦克风, 独立录音与转写, 乱序返回, 追加最新草稿, 延迟授权, 输入框重新挂载, 新草稿归属, 取消, 删除, 失败, 绑定变化和历史导航.

```text
pnpm --filter @ema-agent/desktop exec vitest run tests/chatInputSTTNavigation.test.tsx --maxWorkers=1 --minWorkers=1
Tests 17 passed (17)

pnpm --filter @ema-agent/desktop test -- --maxWorkers=1 --minWorkers=1
Test Files 11 passed (11)
Tests 75 passed (75)
```

Desktop 类型检查通过. 默认 Desktop 配置没有包含测试文件, 另行将新增测试纳入 TypeScript 检查, 结果也通过.

安装版验收时重复检查: 在 A 录一句话, 不手动停止就切到 B, 确认麦克风指示停止, 并在 A 仍转写时开始 B 的录音. A 只能收到 A 的转写, B 只能收到 B 的转写, 等待期间手动输入的文字不能被覆盖. 真实 STT 请求需要配置模型绑定, 可能产生服务商费用.
