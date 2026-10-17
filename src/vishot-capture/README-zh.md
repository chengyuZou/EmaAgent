# 屏幕捕获

[English](README.md)

本包使用随包 FFmpeg 捕获一帧 PNG, 并管理当前聊天的可选自动截图. `captureScreen(signal)` 返回 PNG 字节. `VishotCapture` 协调自动截图和工具请求, 同一时间只运行一个截图进程.

## 自动截图

Server 创建一个 `VishotCapture`, 提供读取设置, 检查 Session 是否空闲及能否处理图片, 保存图片, 加入队列和报告错误的回调. Desktop 通过 `PUT /api/vishot-capture/session` 同步当前查看的 Session, Server 重连后重新同步. 传 null 清除目标.

`setSessionId` 只在目标变化时重新计时. `configure` 重读设置, 取消上次自动操作, 等待一个完整间隔后再尝试. 自动截图默认关闭. `vishotCapture.intervalSeconds` 默认 30 秒, 接受 10 到 86,400 的整数.

```text
定时器 -> 检查 Session 空闲及图片能力 -> 捕获 PNG
    -> 再次检查 -> ImageStore 保存附件
        -> 队列同步检查空闲并接收 image_reference
```

图片能力包括当前 Session 模型原生支持图片, 或存在可用的 Vision 绑定. 这项检查由 Server 提供. Session 忙碌, 图片处理不可用或已有截图未完成时, 跳过本次定时触发.

队列输入只有图片附件, 不附加可见提示文字. 保存期间可能收到用户输入, 所以最后的空闲检查和入队必须在队列内部一起完成. 被拒绝的图片不重试, 已保存但未采用的图片留给附件残留清理.

## 工具, 取消与关闭

即使关闭自动截图或没有当前 Session, `capture(signal)` 仍能返回图片字节. CaptureTool 通过 Server 调用, Server 将图片保存到调用方 Session 并绑定该 Turn. 工具权限仍由工具调用流程检查.

自动和直接截图都等待已有截图进程结束, 再启动下一次. 取消 FFmpeg 时会请求结束进程, 但 Promise 等进程实际关闭后才结束.

切换 Session, 修改截图设置及关闭服务都会取消旧的自动结果. 即使 A 切到 B 再回到 A, 第一次 A 的结果也不能提交. `cancelSession` 等待属于该 Session 的自动图片保存结束, 应用才继续删除文件. `close` 取消操作, 清除定时器, 等待自动流程及当前截图进程结束.

自动失败且未取消时调用 `onError`. Server 发布 `system_warning`, 后续定时间隔可以重新尝试. 直接截图失败则拒绝调用方的 Promise.

## 平台行为

| 平台 | 捕获输入 |
| --- | --- |
| Windows | gdigrab desktop. |
| macOS | AVFoundation 列表中第一个 Capture screen 设备, 不是摄像头设备 0. |
| Linux/X11 | 使用 DISPLAY 的 x11grab. |
| Linux/Wayland | 明确拒绝, 不以 XWayland 代替完整桌面捕获. |

截图不包含音频和鼠标指针. FFmpeg 来自 `ffmpeg-static`, 不搜索 PATH, 不弹出可见终端. 每次 FFmpeg 执行限时 15 秒; macOS 查询设备是截图前的独立执行. 系统屏幕录制权限和所需采集设备仍必须可用.

## 代码与验证

[vishotCapture.ts](vishotCapture.ts) 包含计时, 取消及入队协调, [captureScreen.ts](captureScreen.ts) 选择平台输入并管理 FFmpeg. [Server 装配](../../apps/server/src/composition/vishotCapture.ts) 提供业务回调, [CaptureTool](../builtin-tools/tools/CaptureTool/captureTool.ts) 请求直接截图.

运行 `pnpm --filter @ema-agent/vishot-capture test`. 测试模拟进程和时间, 检查平台参数, 取消, Session 切换, 保存期间的状态变化及截图执行顺序, 不读取真实屏幕. macOS 和 Linux/X11 的权限与画面仍需在对应桌面环境验收.
