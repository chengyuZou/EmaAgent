# 原生主题权限与 Server 环境

[English](../en/releasePermissionsAndEnvironment.md)

## 发现

前端对主窗口和角色舞台调用 Tauri 原生 `setTheme` 操作, 但两者的 capability 都未授予 `core:window:allow-set-theme`. 桥接层还吞掉了被拒绝的调用, 因而页面 CSS 主题变化时, 原生操作失败没有展示出来.

安装版 Server 继承父进程的 Node 环境. 发布准备流程在测试时设置 `NODE_ENV=production`, 并移除 `NODE_OPTIONS` 和 `NODE_PATH`, 但原生启动器没有应用相同规则. Server 是否拒绝仅供开发使用的 Bash 沙箱覆盖, 取决于 `NODE_ENV`.

这些发现通过调用路径和针对性检查确认, 与已经确认的文件树 CSP 故障分别记录. 不将缺少原生主题权限视为文件树问题的原因.

## 修改

- [main](../../../../../apps/desktop/src-tauri/capabilities/main.json) 和 [stage](../../../../../apps/desktop/src-tauri/capabilities/stage.json) 都授予对应的原生主题操作权限.
- [tauriBridge.ts](../../../../../apps/desktop/src/lib/tauri/tauriBridge.ts) 向调用方传递主题修改失败. 主题 Store 报告错误, 不撤销页面已经应用的 CSS 主题.
- [child.rs](../../../../../apps/desktop/src-tauri/src/processes/child.rs) 按原生构建设置 `NODE_ENV`: debug 为 development, release 为 production. Release 子进程不继承 `NODE_OPTIONS` 和 `NODE_PATH`, 避免开发者的加载器和模块搜索路径影响安装版 Server.

已有 Server 认证, 工具审批和 Bash 沙箱检查保持开启. 本次修改不授予外部浏览器面板访问应用命令的权限.

## 验证

针对性临时检查确认两个 capability 条目, 以及原生主题操作被拒绝后的错误传递. Rust release 模式测试检查构造命令的生产环境, 并确认显式移除两个 Node 变量. Desktop 和 Server 类型检查通过.

临时检查用后已删除. 这次检查没有启动重新构建的原生宿主或安装包. 原生标题栏颜色, 从用户常用环境启动以及安装版行为仍需手动验证. 仅前端 HMR 无法加载这些原生修改.

## 跟随系统主题回归

开启原生主题权限后, 先选明确颜色再选跟随系统, 可能继续保留明确颜色. 例如系统为暗色时, 先选亮色再选系统, 页面仍为亮色. 系统为亮色时也出现相反情况.

主题 Store 通过 `matchMedia('(prefers-color-scheme: dark)')` 将 `system` 解析为亮色或暗色, 再传给 Tauri. 但 Tauri 的 Windows 实现还会将窗口主题应用到 WebView2, 改变 `matchMedia` 读到的偏好. 因此下一次选择系统时, 实际读取的是 Ema 自己的覆盖值, 又将它作为明确覆盖写回. 媒体查询监听器也会重复同一原生写入.

这改变的是应用窗口和 WebView 的外观, 不是 Windows 桌面主题. 新授予的权限暴露了原本存在的错误参数; 此前原生操作被拒绝, 错误又被吞掉.

[主题 Store](../../../../../apps/desktop/src/stores/theme.ts) 现在按 [Tauri 窗口主题 API](https://v2.tauri.app/reference/javascript/api/namespacewindow/#settheme) 的约定, 在系统模式传入 `null`. 调用完成后, 如果仍选择系统模式, 再读取一次媒体查询. 后续媒体查询变化只更新页面, 不保存设置, 不广播设置, 也不再设置原生覆盖. 明确选择亮色或暗色时仍更新原生窗口. 桥接层接受 `null`, 并继续报告原生失败.

临时测试使用真实主题 Store 和 Tauri 桥接层, 模拟原生窗口和媒体查询. 修复前两个系统颜色场景都失败: 本应暗色时保留亮色, 本应亮色时保留暗色. 修复后 4 项检查全部通过, 覆盖从两种明确颜色返回系统模式, 后续系统变化不进行原生写入, 以及明确模式忽略系统变化. 这是模拟边界检查, 不是原生窗口验收. 临时测试文件验证后已删除.

用户随后确认 Windows 安装版从任意明确颜色返回系统模式后匹配系统偏好, Ema 选择主题不改变 Windows 主题. Ema 跟随系统时修改操作系统偏好的场景尚未尝试, 继续保留. 这些检查没有单独确认原生标题栏行为, 两个窗口的完整覆盖或安装版子进程环境. 准确安装包标识未记录. 前端修改仍依赖运行中的宿主包含此前新增的原生主题权限.
