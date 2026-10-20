# 发布版 Live2D 渲染

[English](../en/live2dReleaseRendering.md)

## 问题与复现

角色在开发版中能够渲染, Windows 发布版中则不可见, 重启后仍然如此. 舞台窗口和控件存在, 但模型没有显示.

使用真实 `Live2DStage` 在发布版内容安全策略下加载内置模型, 复现了 Pixi 初始化的 `unsafe-eval` 错误. 临时允许 JavaScript 求值后, 又出现第二个错误: 使用 `blob:` URL 的归档资源请求被 `connect-src` 拒绝.

## 确认的原因

Pixi 7 默认的 shader uniform 实现会生成 JavaScript 函数. 发布版策略允许 Cubism Core 编译 WebAssembly, 但不允许 JavaScript 求值. 两者是不同权限, 允许 WebAssembly 不会让 Pixi 生成的函数获得执行权限.

ZIP 加载器也会将模型文件转换为 `blob:` URL. `img-src` 已允许 blob 纹理, 但 `connect-src` 没有允许模型加载器的 blob 请求. 只修复 Pixi 初始化错误, 仍无法完成模型加载.

## 修改

- [Live2DStage](../../../../../src/live2d-react/Live2DStage.tsx) 导入匹配版本的 `@pixi/unsafe-eval` 模块. 尽管名称如此, 这个模块实际将生成的 uniform 函数替换为无需 JavaScript 求值的实现.
- [Tauri CSP](../../../../../apps/desktop/src-tauri/tauri.conf.json) 在 `connect-src` 中允许 `blob:`. JavaScript `unsafe-eval` 仍未开启.
- [CharacterStage](../../../../../apps/desktop/src/stage/CharacterStage.tsx) 使用共享 Callout 和 Button 展示归档, 初始化及渲染失败. 重新加载会再次获取归档并创建新的渲染器. 旧归档请求迟到的错误会被忽略.
- 渲染失败会停止 ticker 并触发 `onError`. 恢复窗口不会重新启动已经失败的渲染器.

## 验证

修复前, `pnpm --filter @ema-agent/desktop test:live2d-release` 复现了原有初始化失败. 修复后, 该检查在发布版 CSP 下加载真实模型, 执行到第一帧更新, 并检测到可见模型像素, 而不是空白画布.

Desktop 测试覆盖可见错误, 重试和旧归档错误. Live2D 测试覆盖 ticker 与恢复帧错误. 前端生产构建和原生 release 构建完成. 独立原生检查也执行到模型加载及错误/重试流程, 没有未捕获的页面错误, 但单凭该检查不能确认完整安装版验收.

用户随后确认 Windows 安装版的初次显示, 再次启动, 角色/资源重新加载及支持的动画正常. 因此, 测试版本的基础 Live2D 渲染已由用户实测确认, 但准确安装包标识未记录. 故意使用不完整模型后的恢复场景仍未测试. 这些观察不代表所有失败恢复和长时间运行行为已验证.
