# Windows 退出时控制台闪现

[English](../en/windowsExitConsole.md)

## 问题

退出 Windows 发布版时, 控制台窗口短暂出现. 开发版没有出现相同闪现.

## 原因与修改

原生宿主启动 Server 时已经使用 `CREATE_NO_WINDOW`, 但退出路径启动 `taskkill` 时没有该标志. 因此, 自身没有控制台的 GUI 应用仍可能为清理命令创建控制台.

[NativeProcessTree.terminate](../../../../../apps/desktop/src-tauri/src/processes/platform/windows.rs) 现在也在启动 `taskkill` 前设置无窗口标志. 进程树终止, 子进程等待和 Job Object 退出兜底保留.

缺少标志已在实现中确认. 仅凭下述针对性检查, 尚不能确认可见闪现已经消失.

后续 Dev/Release 核对在 [Sandbox 进程执行器](../../../../../src/sandbox/process/processRunner.ts) 中找到另一处 `taskkill` 启动. 它已隐藏主命令窗口, 但没有隐藏用于停止进程树的命令. 该终止调用现在也设置 `windowsHide: true`. 这覆盖工具取消和 Server 关闭清理, 不改变被停止的进程树范围.

## 验证

Windows Rust 回归启动真实临时子进程, 将其加入 Job Object, 并确认终止后完成回收. 子进程退出后再次调用终止也能完成. 原生 release 编译通过.

独立原生验收尝试没有确认预期退出日志: 最终断言读取到空日志内容. 这次尝试不计为退出检查通过, 也不能仅凭空内容认定存在新的关闭缺陷.

Sandbox 后续检查通过了临时启动选项测试和已有真实进程测试, 包括停止子进程树, 以及输出存储失败时停止命令. 临时测试文件验证后已删除.

用户随后确认 Windows 安装版完整退出没有额外控制台, 应用后台进程结束. 对于该测试版本, 此前报告的退出闪现问题可以关闭. 关闭主聊天窗口只会隐藏窗口, 不等于完整退出. 准确安装包构建标识未记录, 最终统一发布版回归仍待执行.
