# @ema-agent/live2d-react

`live2d-react` 只负责把一个 Cubism 4 模型加载到 PIXI 舞台，并执行模型原生表情、动作、视线和口型。

角色选择、资源降级、emotion/motion 语义、音频播放和跨窗口事件均由宿主负责。本包不读 Character Store，不保存数据，不解压资源，不猜作者的 Parameter 语义。

## 公共契约

```ts
interface Live2DModelBindings {
  idleMotions?: readonly { group: string; index?: number }[];
  lipSyncParameterIds?: readonly string[];
}

interface Live2DStageHandle {
  setExpression(name: string | null): void;
  cycleExpression(): string | null;
  playMotion(group: string, index?: number): void;
  setLipSync(speaking: boolean, mouthOpen: number): void;
}
```

```tsx
<Live2DStage
  ref={stageRef}
  modelPath={modelPath}
  bindings={bindings}
  suspended={windowHidden}
  onReady={({ hasExpressions }) => {}}
  onError={handleLoadFailure}
/>
```

`mouthOpen` 是宿主已换算的 `0..1` 开口度；本包不理解 RMS 或某个 TTS 协议。`lipSyncParameterIds === undefined` 时使用 `.model3.json` 的 `LipSync` group，显式空数组则关闭口型。

待机动作只从 `idleMotions` 选择，不自动把整个 `Idle` group 当成待机。真实模型可能把流泪、特殊剧情等 Motion 也放进该组。

## 播放流水线

```text
.model3.json
  -> pixi-live2d-display/cubism4 加载 moc3/纹理/physics/motion/expression
  -> Live2DModel 加入 PIXI stage
  -> PIXI.Application.ticker 驱动 Cubism 单一帧循环
  -> Motion -> Expression -> EyeBlink/Focus/Breath -> Physics/Pose
  -> beforeModelUpdate 写入已绑定口型（仅说话期间与说完后约 0.7s 内）
  -> Cubism Core update -> PIXI/WebGL 绘制
```

呼吸、摇头、眼睛、表情混合、Physics 和 Motion 优先级均由 Cubism 原生流水线负责。本包不额外生成正弦参数 Effect。

口型实行三态占有：`speaking`（宿主持续传入开口度，EMA 平滑写入）→ `hold`（说完后约 700ms，先平滑闭嘴再按住，防 Motion 残值顶开）→ `handoff`（彻底停笔；Cubism 每帧回滚到 Motion 快照，嘴参数控制权天然交还）。因此带嘴曲线的 Motion/Expression 在无语音时正常生效。

视线有两个输入源：鼠标活动（`model.focus`，世界坐标）与待机游移（`idleGaze.ts`，无鼠标活动 8s 后随机挑选归一化注视点写 `FocusController`）。二者写同一个 FocusController 目标，鼠标一动即覆盖，无需互斥状态。

## 文件责职

- `Live2DStage.tsx`：React/PIXI/Cubism 生命周期和公开句柄。
- `modelBindings.ts`：把资源绑定投影到当前模型真实存在的 Parameter 与 Motion。
- `lipSync.ts`：说话期间在唯一帧更新点平滑写入口型，说完经 hold 交还控制权。
- `idleMotion.ts`：延迟调度 Character 明确允许的待机 Motion。
- `idleGaze.ts`：无鼠标活动时随机游移注视点。
- `framing.ts`：纯函数计算默认半身构图。
- `types.ts`：宿主真正消费的公共类型。

## 边界

- 舞台基础构图固定为半身；角色的 `stageScale/stageOffsetX/stageOffsetY` 由宿主外层叠加。
- `onError` 只报告无法建立舞台的加载错误；单次表情或 Motion 失败不踢出已可用模型。
- 本包直接使用 `Cubism4InternalModel` 与它的 `coreModel` / `motionManager`，不复制第二套内部协议。
- 调用方只从 `index.ts` 进入，内部解析类型不对外暴露。
