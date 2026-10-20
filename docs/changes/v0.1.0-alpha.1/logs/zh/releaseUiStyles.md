# 发布版界面样式与 Markdown 媒体

[English](../en/releaseUiStyles.md)

## 问题

安装版选择亮色主题后, 文件树面板仍呈暗色. 同一页面在开发版中显示正常. 这影响 Memory 文件页面的外观, 不涉及其存储或维护行为.

## 复现与原因

临时浏览器页面渲染真实 Memory 文件树, Diff 视图和 xterm 终端. 开发版与 Vite 生产构建均能应用其样式. 加入 Tauri 打包时插入的样式 nonce 后, 复现了黑色文件树面板. 其计算背景色由透明变为 `rgb(20, 20, 21)`, 动态插入的 Diff 和终端 style 元素也不再有被接受的样式表.

应用原本允许内联样式, 但 Tauri 为 `style-src` 和打包 HTML 中的样式添加了 nonce. 存在 nonce 时, 浏览器会忽略 `unsafe-inline`. 这些库在运行时创建的额外 style 元素没有该 nonce, 因而被阻止. 文件树覆盖样式未生效后, 露出了库自身的暗色背景.

## 修改

[tauri.conf.json](../../../../../apps/desktop/src-tauri/tauri.conf.json) 仅对 `style-src` 禁用自动资源 CSP 修改. 显式的 `style-src 'self' 'unsafe-inline'` 继续允许渲染器动态样式. 其他指令仍由 Tauri 正常处理.

JavaScript `unsafe-eval` 仍未开启. 已有 Live2D 处理方式和 `wasm-unsafe-eval` 权限保持不变. 这不是全局关闭 CSP, 也没有给文件工具增加权限.

`img-src` 现在允许 Markdown 的 HTTP 和 HTTPS 图片. `media-src` 原本已允许网络音频, 本次保持不变. 本地 Markdown 音频仍通过需要认证且支持字节范围请求的 Server 音频路由提供, 没有改成通用的免认证文件 URL.

## 验证

修正策略后, 临时生产构建浏览器检查通过. 检查覆盖透明文件树背景覆盖, Diff 和终端样式生效, 远程 Markdown 图片, 以及本地和远程 Markdown 音频的播放与定位. 媒体响应使用测试数据, 没有调用外部服务或访问用户配置目录.

临时检查在诊断和验证后已删除, 不是持续保留的发布检查项. 后续扩展到完整 Settings 面板的测试页面未能完成, 因为缺少正常应用 HTML 会加载的 Cubism Core. 该尝试不计为 Settings 页面检查通过.

用户随后确认 Windows 安装版的文件预览/Diff 高亮, Memory 文件页面和独立屏幕捕获侧栏入口正常. 这些结果补充了此前的测试页面检查, 但不代表完整媒体验收. 真实 Markdown 媒体及所有相关发布版样式仍需验证. 准确安装包标识未记录. 后续报告的聊天侧栏文字对比度不足和 HTML 预览原生外观滚动条属于独立问题, 不因这些检查而关闭.
