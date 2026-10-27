# 屏幕捕获

[English](README.md)

本包管理当前聊天的可选自动截图, 并协调直接截图请求. Windows 下由 Server 注入随包原生电脑操控程序的截图入口. `captureScreen(signal)` 提供 macOS 和 Linux/X11 的随包 FFmpeg 截图. Windows 必须使用原生入口, 不回退到 FFmpeg.

## 自动截图

Server 创建一个 `VishotCapture`, 注入 `canStartCapture` 和 `shouldSubmitCapture` 两个判断, 以及截图, 保存, 入队和错误出口. 判断同时考虑 Session 是否空闲, 模型是否能读图以及电脑是否被占用. Desktop 通过 `PUT /api/vishot-capture/session` 同步当前查看的 Session, Server 重连后重新同步. 传 null 清除目标.

`setSessionId` 只在目标变化时重新计时. `configure` 重读设置, 取消上次自动操作, 等待一个完整间隔后再尝试. 自动截图默认关闭. `vishotCapture.intervalSeconds` 默认 30 秒, 接受 10 到 86,400 的整数.

```text
定时器 -> canStartCapture -> 捕获 PNG
    -> shouldSubmitCapture -> 比较上次成功提交的画面 -> 保存附件
        -> 队列同步检查空闲并接收 image_reference
```

图片能力包括当前 Session 模型原生支持图片, 或存在可用的 Vision 绑定. 这项检查由 Server 提供. Session 忙碌, 图片处理不可用或已有截图未完成时, 跳过本次定时触发.

自动捕获跳过与上次成功入队图片像素完全相同的画面. 字节相同时直接跳过, 字节不同时再解码比较, PNG 编码或元数据差异不算画面变化. 不使用相似度阈值. 入队被拒绝时不更新基准, 切换 Session 或重新配置时清除基准. 手动 Capture 和电脑观察不去重.

电脑控制存在期间暂停自动提交, 包括用户介入后的暂停状态. 控制状态变化会取消尚未提交的自动结果. 控制结束后重新等待一个完整间隔, 不补发暂停期间的截图.

队列输入只有图片附件, 不附加可见提示文字. 保存期间可能收到用户输入, 所以最后的空闲检查和入队必须在队列内部一起完成. 被拒绝的图片不重试, 已保存但未采用的图片留给附件残留清理.

## 工具, 取消与关闭

即使关闭自动截图或没有当前 Session, `capture(signal)` 仍能返回图片字节. CaptureTool 通过 Server 调用, Server 将图片保存到调用方 Session 并绑定该 Turn. 工具权限仍由工具调用流程检查.

自动和直接截图都等待当前截图请求结束, 再提交下一次. Windows 取消等待原生回应; macOS/Linux 取消 FFmpeg 时请求结束进程, Promise 等进程关闭后才结束.

切换 Session, 修改截图设置及关闭服务都会取消旧的自动结果. 即使 A 切到 B 再回到 A, 第一次 A 的结果也不能提交. `cancelSession` 等待属于该 Session 的自动图片保存结束, 应用才继续删除文件. `close` 取消操作, 清除定时器, 等待自动流程及当前截图请求结束.

自动失败且未取消时调用 `onError`. Server 发布 `system_warning`, 后续定时间隔可以重新尝试. 直接截图失败则拒绝调用方的 Promise.

## 平台行为

| 平台 | 捕获输入 |
| --- | --- |
| Windows | 随包电脑操控程序通过 Windows.Graphics.Capture 捕获主显示器. |
| macOS | AVFoundation 列表中第一个 Capture screen 设备, 不是摄像头设备 0. |
| Linux/X11 | 使用 DISPLAY 的 x11grab. |
| Linux/Wayland | 明确拒绝, 不以 XWayland 代替完整桌面捕获. |

截图不包含音频和鼠标指针. FFmpeg 来自 `ffmpeg-static`, 不搜索 PATH, 不弹出可见终端. 每次 FFmpeg 执行限时 15 秒; macOS 查询设备是截图前的独立执行. 系统屏幕录制权限和所需采集设备仍必须可用.

## 代码与验证

[vishotCapture.ts](vishotCapture.ts) 包含计时, 取消及入队协调, [captureScreen.ts](captureScreen.ts) 选择平台输入并管理 FFmpeg. [Server 装配](../../apps/server/src/composition/vishotCapture.ts) 提供业务回调, [CaptureTool](../builtin-tools/tools/CaptureTool/captureTool.ts) 请求直接截图.

运行 `pnpm --filter @ema-agent/vishot-capture test`. 测试覆盖执行顺序, 取消, Session 切换, 保存竞态, 入队拒绝和不同编码 PNG 的像素比较, 不读取真实屏幕. Windows 原生桌面测试见[电脑操控程序](../../apps/computer-use/README-zh.md), macOS 和 Linux/X11 仍需分别验收.
