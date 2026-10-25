# Live2D React

[English](./README.md)

这个包把 Character 的 Cubism model3 ZIP 加载到 React/Pixi 舞台. 使用 Pixi 8.21, `@laplace.live/pixijs-live2d` 和 WebGL2, 包括 MOC 6 的绘制路径. 宿主提供归档, 构图, 鼠标输入和归一化开口度, 再通过舞台句柄选择表情和播放动作.

```tsx
<Live2DStage
  ref={stageRef}
  modelArchive={archiveBlob}
  stageScale={resource.stageScale}
  stageOffsetX={resource.stageOffsetX}
  stageOffsetY={resource.stageOffsetY}
  onReady={handleReady}
  onError={handleLoadFailure}
/>
```

导入这个包前需要把已授权的 Cubism Core `06.00.0001` 加载到 `window.Live2DCubismCore`. 桌面宿主见 [CharacterStage.tsx](../../apps/desktop/src/stage/CharacterStage.tsx). 模型设置预览也使用 `loadLive2DArchive`.

## 加载与生命周期

组件异步初始化 Pixi application, 挂载期间保留同一个 canvas. `live2dArchive.ts` 使用 JSZip 解包, 在 `File.webkitRelativePath` 中保留归档内路径. 库的 FileLoader 将 model3 引用解析为 blob URL, 支持嵌套目录和非 ASCII 文件名.

舞台导入 `pixi.js/unsafe-eval`, 替换 Pixi 动态生成 Shader uniform 函数的实现, 因此不需要开放 JavaScript `unsafe-eval`. 宿主的内容安全策略必须在 `connect-src` 中允许 `blob:` 模型资源, 在 `img-src` 中允许 `blob:` 纹理, 并允许 Cubism Core 编译 WebAssembly.

[渲染依赖补丁](../../patches/@laplace.live__pixijs-live2d@0.6.1.patch)为没有扩展名的 blob URL 指定图片解析器, 并在内部模型尚未创建就加载失败时释放 FileLoader 资源. 归档加载失败后销毁半成品并报告原始错误. 正常销毁时先释放 Pixi 纹理再撤销归档 URL, 先移除模型 ticker 监听再销毁 application ticker.

加载新模型时继续显示当前模型. 只有最后一次加载结果会挂到舞台, 过时结果会销毁. 切换时解除旧模型的事件和口型绑定, 卸载组件时销毁 application 与模型资源.

`onReady` 在模型挂载并成功绘制首帧后调用, 宿主可以保留加载提示直到这一刻.

application 的 ticker 驱动模型更新. 应用代码不会因为窗口隐藏或最小化而停止 ticker. WebView 和操作系统仍可能限制后台帧回调频率. 加载和渲染失败都会调用 `onError`. 渲染失败后停止 ticker, 直到宿主重新挂载舞台; 再次显示窗口不会重启已失败的渲染器. 单次表情或动作失败只记日志, 不移除已可用模型. 可选 `onDiagnostic` 向宿主报告 canvas, 加载和 ticker 事件.

## 构图与控制

默认按模型边界构造半身画面. 缩放乘在基础比例上, X/Y 偏移分别按舞台宽高计算, 作用于完整模型, 可以把原本裁切的身体部分移入画面.

ref 句柄提供 `setExpression(name | null)`, `playMotion(group, index)`, `setPlacement`, `setLipSync` 和 `setPointerPosition`. 选择表情时清除前一次选择; 传 null 时清除表情, 不保存供之后恢复的旧表情. 手动动作使用库的 FORCE 优先级, 原生待机由 MotionManager 继续播放.

渲染依赖补丁在自动眨眼后应用表情, 让闭眼表情保留指定的参数值. 模型设置的封面直接渲染为 3072x4096 PNG, 再裁掉透明边.

`pointerSource` 默认使用 `window` 的鼠标事件. 设为 `host` 时由宿主调用 `setPointerPosition`, 传入相对窗口内容区的 CSS 坐标, 可以在窗口外. 舞台根据 canvas 位置换算坐标, 不截到边缘. 相同坐标不算新活动. 鼠标静止 1 秒后, 独立定时器可以改变同一个 FocusController 目标, 产生待机视线. 不可交互时跳过鼠标和待机更新.

## 口型

`mouthOpen` 由宿主提供, 范围为 0 到 1. 只绑定模型 LipSync group 登记且 Cubism Core 实际存在的 ID, 使用参数真实范围.

`beforeModelUpdate` 监听在说话时平滑写入口型. 说完后闭嘴并维持约 700 ms 的帧更新, 然后停止写入, 让 Motion 和 Expression 重新控制嘴部. 音频播放与分析由宿主完成.

## 检查

`tests/` 覆盖构图, 参数绑定, 口型状态变化和待机视线. 运行 `pnpm --filter @ema-agent/live2d-react test`. [Desktop 浏览器回归](../../apps/desktop/README-zh.md#验证修改)会在发布版 CSP 下检查预览像素, 舞台画面, 动作, 表情替换, 口型和资源清理, 也可以检查 Hiyori, Haru, Wanko 和 Ren 示例目录. 原生窗口交互仍需桌面检查.
