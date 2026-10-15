# 屏幕捕获

`captureScreen(signal)` 使用随包 FFmpeg 捕获一帧 PNG, 经 stdout 返回 Buffer. 不录音, 不启动可见终端, 不要求用户安装 FFmpeg. Windows 使用 gdigrab, macOS 使用 AVFoundation 的屏幕设备, Linux/X11 使用 DISPLAY. macOS 与 X11 为测试版, 需要在对应桌面环境验证授权和图像; Wayland 明确拒绝, 不使用 XWayland 代替完整桌面.

`VishotCapture` 在 Server 启动时创建一个实例. `setSessionId` 跟随 Desktop 当前聊天, 重复设置同一 ID 不重启计时, 变更时内部调用 `configure`. `configure` 读取启用状态和间隔, 取消旧结果, 等完整间隔后再尝试. Session, 定时器和当前自动捕获的取消控制器初始为 null.

一次自动捕获的顺序:

1. 确认 Session 空闲, 队列无待处理工作, 并且主模型或 Vision 能读取图片.
2. 捕获屏幕, 然后再次确认空闲和图片能力.
3. 通过 ImageStore 保存为普通图片附件, 注册附件记录.
4. 确认操作未取消, 调用队列的 `enqueueIfIdleForVishotCapture`. 队列同步检查并入队, 不在检查与写入之间等待.

入队内容只有 image_reference, 不附加可见提示文字. Session 切换, 设置变更和关闭会取消旧操作; 即使 A -> B -> A, 旧图片也不会重新生效. 已保存但未采用的图片留给附件残留清理, 不立即删除. 会话删除通过 `cancelSession` 等待正在进行的保存结束.

`capture(signal)` 供 CaptureTool 使用, 不受自动开关或当前查看的 Session 约束. 自动捕获与工具调用共用单个截图进程, 取消后等待进程实际关闭才开始下一次. 工具授权由现有工具框架处理; 系统屏幕录制权限仍须系统允许. 工具结果保存到调用方 Session 并由该 Turn 认领, 不进入自动捕获队列.

Settings 的 `vishotCapture.enabled` 默认 false, `vishotCapture.intervalSeconds` 默认 30 秒. 停止生成不修改这两个值. 当前聊天通过 Desktop 的 API 同步, 首次进入和 Server 重连时重新发送; 截图本身不经过前端或 Rust 转发.

发布脚本会从独立部署目录解析 FFmpeg, 检查二进制, 许可证, 构建说明和对应平台的采集设备. 安装包必须包含这些文件, 不能回退到开发机器 PATH. 系统拒绝授权, 缺少采集设备或进程超时都会报告失败, 不把空结果作为图片提交.

测试位于 `tests/`: 覆盖定时, 切换, 取消, 保存期间变忙, 删除会话和工具与自动截图互斥; 平台参数测试不实际读取屏幕. 实际屏幕与系统授权需要各平台另行验收.
