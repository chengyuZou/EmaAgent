# Live2D React

[English](./README.md)

这个包把 Character 的 Cubism 4 模型 ZIP 加载到 React/PIXI 舞台. 宿主提供归档, 构图, 鼠标输入和归一化开口度, 再通过舞台句柄选择表情和播放动作.

```tsx
<Live2DStage
  ref={stageRef}
  modelArchive={archiveBlob}
  stageScale={resource.stageScale}
  stageOffsetX={resource.stageOffsetX}
  stageOffsetY={resource.stageOffsetY}
  suspended={windowHidden}
  onReady={handleReady}
  onError={handleLoadFailure}
/>
```

挂载前需要把已授权的 Cubism Core 加载到 `window.Live2DCubismCore`. 桌面宿主见 [CharacterStage.tsx](../../apps/desktop/src/stage/CharacterStage.tsx). 模型设置预览也使用 `loadLive2DArchive`.

## 加载与生命周期

组件挂载期间保留同一个 PIXI application 和 canvas. `live2dArchive.ts` 为库的 ZipLoader 注册 JSZip 回调, 将包内路径转为 blob URL, 供模型配置加载纹理, 动作和表情.

加载新模型时继续显示当前模型. 只有最后一次加载结果会挂到舞台, 过时结果会销毁. 切换时解除旧模型的事件和口型绑定, 卸载组件时销毁 application 与模型资源.

application 的 ticker 驱动模型更新. `suspended` 会停止更新, 恢复时先画一帧再启动 ticker. 渲染异常会停止 ticker 并记日志. 加载失败调用 `onError`; 单次表情或动作失败只记日志, 不移除已可用模型. 可选 `onDiagnostic` 向宿主报告 canvas, 加载和 ticker 事件.

## 构图与控制

默认按模型边界构造半身画面. 缩放乘在基础比例上, X/Y 偏移分别按舞台宽高计算, 作用于完整模型, 可以把原本裁切的身体部分移入画面.

ref 句柄提供 `setExpression(name | null)`, `playMotion(group, index)`, `setPlacement`, `setLipSync` 和 `setPointerPosition`. 表情传 null 时重置. 手动动作使用库的 FORCE 优先级, 原生待机由 MotionManager 继续播放.

`pointerSource` 默认使用 `window` 的鼠标事件. 设为 `host` 时由宿主调用 `setPointerPosition`, 传入相对窗口内容区的 CSS 坐标, 可以在窗口外. 舞台根据 canvas 位置换算坐标, 不截到边缘. 相同坐标不算新活动. 鼠标静止 1 秒后, 独立定时器可以改变同一个 FocusController 目标, 产生待机视线. 暂停或不可交互时跳过鼠标和待机更新.

## 口型

`mouthOpen` 由宿主提供, 范围为 0 到 1. 只绑定模型 LipSync group 登记且 Cubism Core 实际存在的 ID, 使用参数真实范围.

`beforeModelUpdate` 监听在说话时平滑写入口型. 说完后闭嘴并维持约 700 ms 的帧更新, 然后停止写入, 让 Motion 和 Expression 重新控制嘴部. 音频播放与分析由宿主完成.

## 检查

`tests/` 覆盖构图, 参数绑定, 口型状态变化和待机视线. 运行 `pnpm --filter @ema-agent/live2d-react test`. 这些测试不渲染 WebGL 或加载真实模型; canvas 生命周期, ZIP 加载和动作效果仍需桌面检查.
