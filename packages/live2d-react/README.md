# @ema-agent/live2d-react 全包开发说明

最后更新：2026-05-31

这份文档解释 EmaAgent 的 Live2D 包到底在做什么、为什么这样写、Live2D 每一帧如何更新、模型参数存放在哪里，以及 `apps/desktop/public/live2d/ema` 这套资源如何被代码消费。

本文覆盖：

- `packages/live2d-react`
- `packages/live2d-react/src`
- `apps/desktop/public/live2d/ema`
- 当前桌面接入点：`apps/desktop/src/components/EmaStageView.tsx`

## 1. 一句话理解这个包

`@ema-agent/live2d-react` 是一个“Live2D 舞台运行时包”。

它不是模型资源包，不是 TTS 包，也不是 emotion 包。它的职责是：

1. 用 PIXI 创建透明 WebGL 舞台。
2. 用 `pixi-live2d-display` 加载 Cubism 4 模型。
3. 从 `model3.json` 发现模型有哪些表情、动作、物理和贴图。
4. 解析 `.exp3.json`，把表情变成可运行的参数状态。
5. hook Live2D 原本的 `motionManager.update`，插入自己的逐帧插件。
6. 每一帧把“用户意图、语音音量、鼠标位置、idle 生命感”写成 Cubism 参数。
7. 把最终参数交回 Live2D/Cubism 渲染成画面。

可以把它想成一层“舞台控制器”：

```text
外部事件 / UI / TTS / LLM
        ↓
Zustand runtime stores
        ↓
Live2DStage 装配 PIXI + Live2D model
        ↓
motionManager.update 插件管线
        ↓
coreModel.setParameterValueById(...)
        ↓
Cubism motion / physics / render
        ↓
透明 canvas 上的 Ema
```

## 2. 包边界

### 2.1 它负责什么

| 职责 | 说明 |
|---|---|
| 加载模型 | `Live2DStage` 用 `PixiLive2DModel.from(modelPath)` 加载 `.model3.json` |
| 管理舞台 | 创建/销毁 `PIXI.Application`，把 canvas 挂到 React 容器 |
| 管理高层意图 | `useLive2DStore` 保存 active expressions、current motion、各种开关 |
| 管理表情参数 | `useExpressionStore` 保存 `.exp3.json` 解析后的参数 entry |
| 管理语音驱动 | `useSpeechStore` 保存 `speaking/rms/energy` |
| 每帧写参数 | idle beat、lip sync、blink、expression、mouse tracking 都是插件 |
| 资源能力发现 | 模型加载后填充 `availableExpressions`、`availableMotions` |

### 2.2 它不负责什么

| 不负责 | 实际负责方 |
|---|---|
| LLM 生成文本 | `conversation` / `agent` / `llm` |
| ACT 标签解析 | `packages/emotion` |
| TTS 合成 | `packages/tts` |
| 音频播放和 RMS 分析 | `packages/desktop-ui/src/lib/tts-playback.ts` |
| SSE 连接 | `packages/desktop-ui/src/lib/sse-consumer.ts` 和 `system-sse.ts` |
| Tauri 事件桥接 | `apps/desktop/src/components/EmaStageView.tsx` |
| VTube Studio 运行时 | 不使用 VTS，只把 `ema.vtube.json` 当参数参考 |

## 3. 文件结构

```text
packages/live2d-react/
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts
    ├── types.ts
    ├── components/
    │   └── Live2DStage.tsx
    ├── stores/
    │   ├── live2d-store.ts
    │   ├── expression-store.ts
    │   └── speech-store.ts
    ├── composables/
    │   ├── motion-manager.ts
    │   ├── expression-controller.ts
    │   ├── idle-beat.ts
    │   ├── audio-lipsync.ts
    │   ├── mouse-track.ts
    │   ├── random-idle.ts
    │   └── animation.ts
    ├── tools/
    │   └── expression-tools.ts
    └── utils/
        └── math.ts
```

## 4. package 级配置

### 4.1 `package.json`

包名：`@ema-agent/live2d-react`

关键依赖：

| 依赖 | 作用 |
|---|---|
| `pixi.js` | WebGL 渲染层 |
| `pixi-live2d-display` | 把 Cubism 模型接入 PIXI |
| `zustand` | 轻量状态管理 |
| `react` / `react-dom` | peer dependency，包本身提供 React 组件 |

exports：

| subpath | 说明 |
|---|---|
| `@ema-agent/live2d-react` | 主入口，导出组件、store、类型 |
| `@ema-agent/live2d-react/store` | 只导出 `live2d-store` |
| `@ema-agent/live2d-react/tools` | 导出 expression tools |

### 4.2 `tsconfig.json`

这个包按浏览器环境编译：

- `lib` 包含 `DOM`，因为它直接用 `window`、`localStorage`、`HTMLCanvasElement`。
- `moduleResolution` 是 `Bundler`，适配 Vite/Tauri 前端。
- `strict` 和 `noUncheckedIndexedAccess` 开启。

## 5. 公开 API

入口：`src/index.ts`

导出的运行时对象：

```ts
export { Live2DStage } from './components/Live2DStage.js';
export { useLive2DStore } from './stores/live2d-store.js';
export { useExpressionStore } from './stores/expression-store.js';
export { useSpeechStore } from './stores/speech-store.js';
```

导出的主要类型：

```ts
export type {
  Live2DFraming,
  Live2DErrorKind,
  Live2DError,
  Live2DStageHandle,
} from './types.js';
```

最重要的外部控制接口是 `Live2DStageHandle`：

```ts
export interface Live2DStageHandle {
  setExpression(name: string | null): void;
  playMotion(group: string, index?: number): Promise<void>;
  isReady(): boolean;
}
```

这个 handle 的存在是为了让 Tauri event / SSE bridge 这种非 React 数据源能直接控制舞台，而不用把所有事件都变成 React props。

## 6. Live2DStage 为什么这样写

文件：`src/components/Live2DStage.tsx`

`Live2DStage` 是这个包的装配中心。它不是普通展示组件，而是一个“拥有外部资源生命周期”的组件：WebGL context、Live2D model、PIXI ticker、window event、motion hook 都在这里创建和销毁。

### 6.1 为什么要 `window.PIXI = PIXI`

```ts
(window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI;
```

`pixi-live2d-display` 会从 `window.PIXI` 读取 PIXI。这个库不是完全纯 ESM 依赖注入风格，所以这里必须把 PIXI 注册到全局。

### 6.2 为什么先检查 `window.Live2DCubismCore`

```ts
if (typeof window.Live2DCubismCore === 'undefined') {
  // cubism_core_missing
}
```

Cubism Core 是 Live2D 官方的 wasm/js 运行时核心。没有它，`.moc3` 无法解析。这里早失败比等模型加载时报一堆资源错误更清楚。

### 6.3 为什么用 `forwardRef + useImperativeHandle`

```ts
useImperativeHandle(ref, () => ({
  setExpression(name) { useLive2DStore.getState().setExpression(name); },
  async playMotion(group, index) { useLive2DStore.getState().playMotion(group, index); },
  isReady() { return useLive2DStore.getState().ready; },
}), []);
```

原因是 Ema 的 Live2D 控制源不全是 React 父组件：

- Tauri event：`stage:emotion-changed`
- Tauri event：`stage:cue`
- Floating dock event
- 未来 Agent tool
- Playwright / dev script

这些源头更适合调用一个命令式 handle，而不是一路 props drilling。

### 6.4 为什么要安装 render guard

```ts
app.ticker.remove(app.render, app);
app.ticker.add(guarded);
```

PIXI 渲染如果某一帧抛错，默认可能污染 ticker。这里改成 guarded render：单帧失败只跳过该帧，不把整个舞台拖死。

### 6.5 为什么 cleanup 很重

```ts
model.destroy({ children: true });
app.destroy(true, { children: true, texture: true, baseTexture: true });
```

WebGL context 是浏览器稀缺资源。Chrome 单 tab 可用 context 数有限，Tauri webview 也一样。如果 React 反复 mount/unmount 舞台但不销毁 PIXI app，后面会出现黑屏、贴图加载失败或 WebGL context lost。

## 7. Live2D 每一帧到底怎么更新

这是理解全包的核心。

### 7.1 原始更新链路

`pixi-live2d-display` 加载模型后，模型内部有一个 `internalModel.motionManager.update(model, now)`。正常情况下，每一帧大致会经历：

```text
PIXI ticker
  ↓
Live2DModel autoUpdate
  ↓
internalModel.update(...)
  ↓
motionManager.update(coreModel, now)
  ↓
应用 .motion3.json 曲线
  ↓
Cubism physics / pose / draw
  ↓
PIXI render
```

我们的代码没有重写整个 Live2D 更新系统，而是只 hook 关键的 `motionManager.update`：

```ts
const originalUpdate = mm.update.bind(mm);
mm.update = (m, now) => pipeline.hookUpdate(m, now, originalUpdate);
```

这是一种低侵入设计：不 fork `pixi-live2d-display`，只在它每帧更新参数的关键点前后插插件。

### 7.2 插件管线的三阶段

文件：`src/composables/motion-manager.ts`

```text
pre plugins
  ↓
original motionManager.update
  ↓
post plugins
  ↓
final plugins
```

三阶段语义：

| stage | 何时执行 | 适合做什么 |
|---|---|---|
| `pre` | 原始 motion 更新之前 | 可提前写入输入、可 short-circuit 原始更新 |
| `post` | 原始 motion 更新之后 | 基于 motion 结果做调整 |
| `final` | 最后一定执行 | 表情、口型、眨眼、idle beat 这种需要覆盖 motion 的层 |

当前注册顺序：

```text
pre:
  mouse-track

final:
  idle-beat
  auto-eye-blink
  expression
  audio-lipsync

outside pipeline:
  random-idle scheduler
```

### 7.3 为什么 idle-beat 必须在 final

`idle.motion3.json` 本身会写：

- `ParamBreath`
- `ParamBodyAngleX`
- `ParamBodyAngleY`
- `ParamBodyAngleZ`

如果我们的 idle beat 在原始 motion 之前执行，随后原始 motion 会覆盖这些值。放到 final，才能保证我们的基础生命感在 motion 曲线之后生效。

更关键的是，Ema 的真正“身体输入”不是 `ParamBodyAngleX/Y/Z`，而是 `Param85/86/87`：

```ts
ctx.model.setParameterValueById('Param85', swayX);
ctx.model.setParameterValueById('Param86', swayY);
ctx.model.setParameterValueById('Param87', swayZ);
```

这些参数在 `ema.physics3.json` 里被当作输入，后续会扩散到头、身体、头发、裙子、斗篷、锁链等物理输出。

### 7.4 为什么 expression 在 blink 后面

眨眼会写眼睛开合参数：

- `ParamEyeLOpen`
- `ParamEyeROpen`

表情也可能写眼睛、眉毛、嘴、脸等参数。如果表情放在眨眼前，眨眼可能把表情眼睛状态覆盖掉。当前顺序是：

```text
auto-eye-blink → expression → audio-lipsync
```

这样表情可以叠在眨眼之后，口型又可以叠在表情之后。讲话时即便有笑脸或其他表情，嘴巴仍然能跟随音频张合。

## 8. 参数到底存在哪里

这里要区分四种“参数”。

### 8.1 真实 Live2D 参数：存在 Cubism coreModel 内部

真实会影响画面的参数不在 Zustand 里，而在 Live2D/Cubism 模型内部。

写入方式：

```ts
coreModel.setParameterValueById('ParamMouthOpenY', value);
```

读取方式：

```ts
coreModel.getParameterValueById('ParamMouthOpenY');
```

这些值每一帧都会被 motion、physics、插件反复读写。最终 Cubism 根据这些参数变形网格，再由 PIXI 渲染。

### 8.2 `useLive2DStore`：存“高层意图”

文件：`src/stores/live2d-store.ts`

这里存的不是最终 Cubism 参数，而是外部希望模型做什么：

| 字段 | 含义 |
|---|---|
| `activeExpressions` | 当前希望激活哪些表情组 |
| `currentMotion` | 当前希望播放哪个 motion group/index |
| `modelParameters` | 手动参数覆盖层，目前只有左右眼开合 base |
| `idleAnimationEnabled` | 是否允许 idle motion 运行 |
| `idleBeatEnabled` | 是否启用我们自己的基础晃动插件 |
| `autoBlinkEnabled` | 是否启用自动眨眼 |
| `forceAutoBlinkEnabled` | 是否强制走代码里的眨眼状态机 |
| `expressionEnabled` | 表情 overlay 是否参与 |
| `availableExpressions` | 模型加载后发现的表情名 |
| `availableMotions` | 模型加载后发现的 motion group 和数量 |
| `ready` | 模型是否加载完成 |

这个 store 的关键是：它存“意图”，不直接写模型。真正把意图变成参数的是 `Live2DStage` 的订阅和逐帧插件。

例子：

```ts
useLive2DStore.getState().setExpression('liulei');
```

只会让 `activeExpressions = ['liulei']`。之后 `Live2DStage` 的 subscription 看到变化，才调用 `ExpressionStore.set(...)`。

### 8.3 `useExpressionStore`：存“表情参数状态”

文件：`src/stores/expression-store.ts`

这里存的是 `.exp3.json` 解析后的运行时状态。

两个核心结构：

| 结构 | 含义 |
|---|---|
| `expressionGroups: Map<string, ExpressionGroupDefinition>` | 表情组名到参数列表，例如 `liulei → [Param = 1 Add]` |
| `expressions: Map<string, ExpressionEntry>` | 参数 ID 到运行时 entry，例如 `Param23 → current/default/target/blend` |

注意：当前代码的 `expressions` Map key 实际来自 `entry.name`，而 `expression-controller` 创建 entry 时 `name = parameterId`，所以它本质是按参数 ID 存。group 名不在这个 Map 里，而是在 `expressionGroups` 里。

一个 `ExpressionEntry` 里保存：

| 字段 | 含义 |
|---|---|
| `parameterId` | Live2D 参数 ID |
| `blend` | Add / Multiply / Overwrite |
| `currentValue` | 当前运行时表情值 |
| `defaultValue` | 应用级默认值，可保存到 localStorage |
| `modelDefault` | 模型原始默认值 |
| `targetValue` | 表情激活时的目标值 |
| `resetTimer` | 自动复位 timer |

### 8.4 `useSpeechStore`：存“音频包络”

文件：`src/stores/speech-store.ts`

它不存音频，也不存嘴型曲线，只存音频分析结果：

| 字段 | 含义 |
|---|---|
| `speaking` | 当前是否真的在播放 TTS 音频 |
| `rms` | 当前帧音量，0 到 1 |
| `energy` | 平滑音量，上升快、下降慢，用于身体重音 |

然后 `audio-lipsync.ts` 每帧读取它：

```ts
const { speaking, rms, energy } = useSpeechStore.getState();
```

再写入真实模型参数：

```ts
ParamMouthOpenY = rms * 2.1
Param86 += energy * 3.0
```

### 8.5 插件闭包里也存状态

除了 Zustand，还有一些逐帧状态存在插件闭包里：

| 文件 | 闭包状态 | 用途 |
|---|---|---|
| `idle-beat.ts` | `elapsed` | 计算 sin 波晃动 |
| `audio-lipsync.ts` | `currentMouth` | 嘴型平滑释放 |
| `motion-manager.ts` blink plugin | `phase/progress/delayMs` | 眨眼状态机 |
| `mouse-track.ts` | `targetX/currentX/mouseInBounds` | 鼠标追踪平滑 |
| `random-idle.ts` | `timer` | 定时播放随机 idle motion |
| `expression-controller.ts` | `activeLastFrame` | 表情关闭后恢复模型默认值 |

这些状态不需要进 store，因为它们只服务于单个已挂载的模型实例。

## 9. 表情系统完整链路

以 `liulei.exp3.json` 为例。

### 9.1 资源定义

`ema.model3.json` 中声明：

```json
{
  "Name": "liulei",
  "File": "liulei.exp3.json"
}
```

`liulei.exp3.json` 中声明：

```json
{
  "Type": "Live2D Expression",
  "Parameters": [
    { "Id": "Param", "Value": 1, "Blend": "Add" }
  ]
}
```

### 9.2 加载时解析

`Live2DStage` 从 `model.internalModel.settings.expressions` 取出 expression refs：

```ts
const expressionRefs = extractExpressionRefs(model);
```

然后调用：

```ts
await expressionController.initialise(expressionRefs, readExpFile, baseUrl);
```

`expression-controller` 做三件事：

1. fetch 每个 `.exp3.json`。
2. 把每个表情变成 `ExpressionGroupDefinition`。
3. 把涉及的每个参数变成 `ExpressionEntry`。

最后注入：

```ts
useExpressionStore.getState().registerExpressions(modelId, groups, entries);
```

### 9.3 激活时同步

外部调用：

```ts
useLive2DStore.getState().setExpression('liulei');
```

`Live2DStage` 订阅 `activeExpressions`：

```ts
const added = s.activeExpressions.filter((e) => !prev.activeExpressions.includes(e));
for (const name of added) {
  useExpressionStore.getState().set(name, true);
}
```

`ExpressionStore.set('liulei', true)` 会解析 group，然后把 `Param.currentValue` 设置为该表情定义的值。

### 9.4 每帧应用

每帧 final stage 里执行：

```ts
controller.applyExpressions(ctx.model);
```

它遍历 `useExpressionStore.getState().expressions`：

```ts
for (const entry of expressions.values()) {
  if (isNoopValue(entry)) continue;
  const blended = computeBlendedValue(entry, coreModel);
  coreModel.setParameterValueById(entry.parameterId, blended);
}
```

所以表情不是“激活那一刻写一次参数”就结束，而是每一帧都重新 overlay。这样它才能压住 motion、blink 或其他参数写入。

## 10. Motion 系统完整链路

### 10.1 资源定义

`ema.model3.json` 中：

```json
"Motions": {
  "Idle": [
    { "File": "idle.motion3.json", "FadeInTime": 0.5, "FadeOutTime": 0.5 },
    { "File": "Scene1.motion3.json", "FadeInTime": 0.5, "FadeOutTime": 0.5 }
  ]
}
```

### 10.2 加载时发现

`Live2DStage` 调用：

```ts
store.getState()._setMotionsAvailable(extractMotionGroups(model));
```

当前会得到：

```ts
{ Idle: 2 }
```

### 10.3 播放时触发

外部调用：

```ts
useLive2DStore.getState().playMotion('Idle', 0);
```

store 只设置：

```ts
currentMotion = { group: 'Idle', index: 0 }
```

真正播放发生在 `Live2DStage` 的 subscription：

```ts
if (s.currentMotion !== prev.currentMotion && s.currentMotion) {
  void model.motion(s.currentMotion.group, s.currentMotion.index);
}
```

也就是说，motion 文件由 `pixi-live2d-display` 解析和执行，store 只是保存播放意图。

## 11. Idle 生命感完整链路

当前 Ema 的闲置表现不是单一 motion，而是叠了三层：

```text
Idle motion 文件
  + idle-beat 参数输入
  + random-idle scheduler 定时换 motion
```

### 11.1 原生 idle motion

`idle.motion3.json`：

| 曲线 | 作用 |
|---|---|
| `ParamBreath` | 呼吸 |
| `ParamBodyAngleX` | 身体 X |
| `ParamBodyAngleY` | 身体 Y |
| `ParamBodyAngleZ` | 身体 Z |

`Scene1.motion3.json`：

| 曲线 | 作用 |
|---|---|
| `Param133` | 流泪 L |
| `Param138` | 流泪 R |

### 11.2 idle-beat

文件：`src/composables/idle-beat.ts`

它每帧写：

```ts
Param85 = sin(elapsed * 0.8) * 15
Param86 = sin(elapsed * 0.56) * 7.5
Param87 = sin(elapsed * 0.62) * 4.5
ParamBreath = (sin(elapsed * 0.6) + 1) * 0.5
```

`Param85/86/87` 的价值在于：它们是 VTS 中脸部追踪输入参数，对应 `FaceAngleX/Y/Z`。Ema 的物理文件会把它们扩散到大量物理输出。

### 11.3 random-idle

文件：`src/composables/random-idle.ts`

逻辑：

```text
每 12-35 秒：
  如果 useSpeechStore.speaking === false：
    随机选 Idle 组的一个 index
    model.motion('Idle', index)
```

它不是逐帧插件，而是一个 setTimeout scheduler。原因是“随机播放长动作”不需要每帧计算，只需要定时触发 motion。

## 12. 口型和说话身体动作

文件：`src/composables/audio-lipsync.ts`

Ema 的嘴型不是靠 `.motion3.json`，而是靠 TTS 播放时的实时音量：

```text
desktop-ui TTS playback
  ↓ Web Audio AnalyserNode
RMS 0..1
  ↓ stage:speech-state / BroadcastChannel
useSpeechStore
  ↓ 每帧
audio-lipsync plugin
  ↓
ParamMouthOpenY + Param86
```

关键参数：

| 常量 | 值 | 作用 |
|---|---:|---|
| `MOUTH_MAX` | 2.1 | 对齐 `ema.vtube.json` 的 MouthOpen 输出上限 |
| `NOD_AMPLITUDE` | 3.0 | 说话重音点头幅度 |
| `RELEASE` | 0.12 | 静音时嘴巴回落速度 |

代码：

```ts
if (speaking && rms > 0.01) {
  currentMouth += (rms * MOUTH_MAX - currentMouth) * 0.35;
} else {
  currentMouth += (0 - currentMouth) * RELEASE;
}

ctx.model.setParameterValueById('ParamMouthOpenY', currentMouth);
```

这比“说话时固定张嘴”自然，因为嘴的大小来自真实音频能量。

## 13. 自动眨眼

文件：`src/composables/motion-manager.ts`

`createAutoEyeBlinkPlugin` 维护一个小状态机：

```text
idle
  ↓ delay 到 0
closing 75ms
  ↓
opening 75ms
  ↓
idle，随机等待 3-8 秒
```

它有两条路径：

1. expression 关闭时：可以 absolute 写眼睛参数并 `markHandled()`。
2. expression 开启时：尽量用 multiply 方式调制现有眼睛状态，避免和表情硬冲突。

为什么复杂：眼睛参数同时可能被 motion、expression、blink、手动 `modelParameters` 写。如果简单粗暴每帧 `ParamEyeLOpen = 0/1`，会把闭眼表情、笑眼表情都打坏。

## 14. 鼠标追踪

文件：`src/composables/mouse-track.ts`

它监听全局 `window.mousemove`，而不是 canvas pointer event。

原因：Tauri 桌宠窗口可能有拖拽区域覆盖在 canvas 上，canvas 本身收不到鼠标事件。

逻辑：

```text
鼠标在 canvas bounds 内：
  targetX/Y = 鼠标相对 canvas 中心位置
鼠标离开：
  targetX/Y = 0
每帧：
  currentX/Y 平滑靠近 targetX/Y
  写 ParamEyeBallX/Y
```

当前范围：

| 常量 | 值 |
|---|---:|
| `EYE_RANGE_X` | 0.35 |
| `EYE_RANGE_Y` | 0.3 |
| `SMOOTH` | 0.08 |

## 15. Ema Live2D 资源说明

目录：`apps/desktop/public/live2d/ema`

### 15.1 `ema.model3.json`

这是 Cubism 官方入口清单。当前内容：

| 类别 | 值 |
|---|---|
| Moc | `ema.moc3` |
| Texture | `ema.8192/texture_00.png` |
| Physics | `ema.physics3.json` |
| DisplayInfo | `ema.cdi3.json` |
| Expressions | `taishou`、`liulei`、`monvhua` |
| Motions | `Idle` 组两个 motion |
| EyeBlink | `ParamEyeLOpen`、`ParamEyeROpen` |
| LipSync | 空 |

它是资源索引。`pixi-live2d-display` 会消费 Moc、Texture、Physics、Motions 等。我们的代码额外从中提取 Expressions 和 Motions，填充 store。

### 15.2 `.exp3.json`

当前表情：

| 表情名 | 文件 | 参数 |
|---|---|---|
| `taishou` | `taishou.exp3.json` | `Param23 = 1 Add` |
| `liulei` | `liulei.exp3.json` | `Param = 1 Add` |
| `monvhua` | `monvhua.exp3.json` | `Param2 = 1 Add`，`Param23 = 0 Add` |

这些文件不由 SDK 自动变成我们的 `ExpressionStore`。是 `expression-controller.ts` 自己 fetch 并解析。

### 15.3 `.motion3.json`

| 文件 | Duration | Loop | 曲线 |
|---|---:|---|---|
| `idle.motion3.json` | 4.0s | true | `ParamBreath`、`ParamBodyAngleX/Y/Z` |
| `Scene1.motion3.json` | 1.633s | true | `Param133`、`Param138` |

motion 的解析和播放由 `pixi-live2d-display` 负责。我们的 store 不存 motion 曲线，只存 group/index 意图。

### 15.4 `ema.physics3.json`

这是 Cubism 物理配置。当前：

| 指标 | 值 |
|---|---:|
| PhysicsSettingCount | 31 |
| TotalInputCount | 71 |
| TotalOutputCount | 85 |
| VertexCount | 111 |
| FPS | 60 |

重要输入：

- `Param85`
- `Param86`
- `Param87`

这些输入会输出到：

- `ParamAngleX/Y/Z`
- `ParamBodyAngleX/Y/Z`
- 眼睛物理参数
- 头发、耳朵、手、裙子、斗篷、锁链、花等物理参数

这解释了为什么 `idle-beat` 写 `Param85/86/87` 比直接写身体角度更合适。

### 15.5 `ema.vtube.json`

这是 VTube Studio 私有工程配置，不是 Cubism 官方运行入口。我们的代码当前不解析它。

但它非常有价值，因为它记录了模型作者在 VTS 中设计的参数范围：

| 用途 | VTS Input | Live2D 参数 | 输出范围 |
|---|---|---|---|
| 脸左右转 | `FaceAngleX` | `Param85` | -30..30 |
| 脸上下转 | `FaceAngleY` | `Param86` | -30..30 |
| 歪头 | `FaceAngleZ` | `Param87` | -30..30 |
| 嘴张开 | `MouthOpen` | `ParamMouthOpenY` | 0..2.1 |
| 嘴角 | `MouthSmile` | `ParamMouthForm` | -2..1 |
| 身体 X/Y/Z | `FaceAngleX/Y/Z` | `ParamBodyAngleX/Y/Z` | -10..10 |
| 呼吸 | Auto Breath | `ParamBreath` | 0..1 |

VTS 热键：

| 快捷键 | 文件 |
|---|---|
| Q | `liulei.exp3.json` |
| Tab | `monvhua.exp3.json` |
| E | `taishou.exp3.json` |

这些热键不影响 EmaAgent 运行时。它们只是 VTS 中的绑定记录。

### 15.6 `ema.cdi3.json`

这是参数显示信息，包含参数 ID 的中文名和分组。

它不参与运行时渲染，但适合做开发工具。例如：

- 参数调试面板
- 参数中文名映射
- 模型能力检查

### 15.7 `items_pinned_to_model.json`

这是 VTube Studio pinned items 数据。当前：

```json
"Items": []
```

EmaAgent 当前不使用 VTS 物品系统。

## 16. 你的随笔：批判与修正

你的整体方向是对的：`model3.json` 是资源入口，store 是运行时状态，`.exp3.json` 会被解析成 expression store，`.motion3.json` 和 `.physics3.json` 主要交给 SDK。

但要修正几处关键点。

### 16.1 `DisplayInfo` 不是“画布大小、布局”的主来源

你写：

> DisplayInfo：显示信息（画布大小、布局）

在当前 Ema 资源里，`ema.cdi3.json` 更准确地说是“参数/部件显示信息”。它主要提供参数 ID、中文名称、参数分组、部件清单。当前舞台中的画布布局由 `Live2DStage.applyFraming()` 控制，而不是 cdi3。

### 16.2 `idleBeatEnabled` 不控制物理开关

你写：

> 应用层可能有一个开关（Live2DStore 中的 idleBeatEnabled 或 PhysicsSettings.Use）控制是否启动物理。

当前代码不是这样。`idleBeatEnabled` 只控制我们的 `idle-beat` 插件是否写 `Param85/86/87/ParamBreath`。物理是否加载和运行由 `pixi-live2d-display` 根据 `ema.model3.json -> Physics` 和 Cubism 内部流程处理。

换句话说：

```text
idleBeatEnabled=false
  只是停止我们主动晃 Ema
  不是关闭 Cubism physics
```

### 16.3 `ema.vtube.json` 当前完全不进运行时

你写：

> 如果想支持 VTube Studio 映射逻辑，可以写解析器读这个文件，然后调用 Live2DStore.setModelParameters 或直接设置参数。

这个判断是对的。但当前代码完全不读 `ema.vtube.json`。我们只是人类开发时参考它，尤其参考：

- `ParamMouthOpenY` 上限 2.1
- `Param85/86/87` 的范围 -30..30
- VTS 热键和默认表情

所以文档里应明确：它是“事实参考”，不是运行时依赖。

### 16.4 `Live2DStore.addExpression` 不会直接改 ExpressionStore

你写：

> Live2DStore 中的 addExpression/removeExpression 会最终调用 ExpressionStore.set 来修改参数值。

“最终”这个方向对，但缺了关键中间层。当前不是 store 直接调用 store，而是：

```text
Live2DStore.activeExpressions 变化
  ↓
Live2DStage subscribe
  ↓
ExpressionStore.set/toggle
```

这点很重要。`Live2DStore` 和 `ExpressionStore` 没有直接 import 对方；协调发生在 `Live2DStage`。

### 16.5 ExpressionStore 的 Map 不存 groupName entry

你写：

> Map<parameterId | groupName, entry>

代码注释里有这个倾向，但当前实际实现是：

- `expressionGroups` 存 groupName。
- `expressions` 存参数 entry，目前 key 是参数 ID。

所以更准确是：

```text
expressionGroups: Map<expressionName, group definition>
expressions: Map<parameterId, expression entry>
```

### 16.6 `SpeechAnimationStore` 的概念对，实际导出名是 `useSpeechStore`

代码注释叫 `SpeechAnimationStore`，实际使用导出是：

```ts
export const useSpeechStore = create<SpeechAnimationStore>(...)
```

文档里可以用“speech store”称呼，避免误以为有一个单独的 `SpeechAnimationStore.ts` 文件。

### 16.7 当前 expression tools 和 Live2DStage 订阅存在潜在重复同步问题

这是你的随笔没提到、但读代码时必须注意的点。

`expression-tools.ts` 会直接调用：

```ts
exprStore.set(...)
live2dStore.addExpression(...)
```

而 `Live2DStage` 又订阅 `activeExpressions`，在 add 后再次：

```ts
useExpressionStore.getState().set(name, true);
```

对 `set(true)` 来说通常只是重复写一次，问题不大。但对 `duration` 和 `toggle` 语义有风险：

- `expressionSet(..., duration)` 先设置了 auto-reset timer，随后 stage subscription 再 `set(name, true)` 可能清掉 timer。
- `expressionToggle` 先 toggle ExpressionStore，再改 Live2DStore；stage subscription 对 removed expression 又调用 `toggle(name)`，存在把刚关掉的表情再次打开的风险。

因此未来修正方向应该是：

```text
统一让 activeExpressions 作为唯一高层意图
Live2DStage subscription 对 added 用 set(name, true)
Live2DStage subscription 对 removed 用 set(name, false) 或 reset group
expression tools 不要同时直接写 exprStore 和 live2dStore
```

或者反过来：tools 只写 ExpressionStore，Live2DStore 只作为 UI 状态。但不能两边都当主写源。

## 17. 当前设计优点

1. 没有 fork `pixi-live2d-display`，通过 hook `motionManager.update` 插入能力，维护成本低。
2. store 和插件分层清楚：store 存状态，插件逐帧写参数。
3. speech store 不依赖 TTS 包，避免循环依赖。
4. 表情解析和表情应用分离：加载时解析一次，每帧只做 Map 遍历和 blend 计算。
5. `Param85/86/87` 选得对，尊重模型作者在 VTS 和 physics 文件中的设计。
6. `Live2DStage` 有完整 cleanup，WebGL context 泄漏风险较低。

## 18. 当前设计问题

| 问题 | 影响 | 建议 |
|---|---|---|
| `mouse-track` 绑定 window event 但没有解绑 | 舞台频繁重挂可能留下 listener | 插件 factory 返回 cleanup，或由 pipeline 管理 dispose |
| `expression tools` 和 `Live2DStage` 双写 ExpressionStore | duration/toggle 可能出现语义错误 | 明确唯一写源 |
| `Live2DStore.addExpression(durationSec)` 参数未使用 | 外部以为可自动恢复，但不会 | 删除参数或实现 duration 传递 |
| `types.ts` 中 `MotionUpdatePlugin` 注释过时 | 与实际 `motion-manager.ts` 不完全一致 | 更新类型或删除未使用类型 |
| `idleAnimationEnabled` 当前没有注册 `createIdleDisablePlugin` | 开关名容易让人误解 | 接入插件或改名 |
| `animation.ts` 未接入 | idle 眼神游移能力闲置 | 接到 mouse idle fallback |

## 19. 如果未来要重构，推荐目标

建立一个明确的 Stage Runtime Façade，避免外部直接知道 Zustand 和内部插件。

```ts
export interface Live2DRuntimeFacade {
  setExpression(name: string | null, opts?: { durationSec?: number }): void;
  addExpression(name: string, opts?: { durationSec?: number }): void;
  removeExpression(name: string): void;
  playMotion(group: string, index?: number): Promise<void>;
  setSpeechFrame(frame: { speaking: boolean; rms: number }): void;
  setParameterPatch(patch: Partial<ModelParameters>): void;
  getCapabilities(): {
    ready: boolean;
    expressions: string[];
    motions: Record<string, number>;
  };
}
```

然后让：

- Tauri stage event
- Agent expression tools
- UI dock
- dev panel

全部只调这个 Façade，不直接双写多个 store。

## 20. 阅读顺序

建议一天内过完整包时按这个顺序：

1. `src/components/Live2DStage.tsx`
2. `src/composables/motion-manager.ts`
3. `src/stores/live2d-store.ts`
4. `src/stores/expression-store.ts`
5. `src/composables/expression-controller.ts`
6. `src/stores/speech-store.ts`
7. `src/composables/audio-lipsync.ts`
8. `src/composables/idle-beat.ts`
9. `src/composables/random-idle.ts`
10. `src/composables/mouse-track.ts`
11. `src/composables/animation.ts`
12. `src/tools/expression-tools.ts`
13. `apps/desktop/public/live2d/ema/ema.model3.json`
14. `apps/desktop/public/live2d/ema/ema.vtube.json`
15. `apps/desktop/public/live2d/ema/ema.physics3.json`
16. `apps/desktop/public/live2d/ema/*.exp3.json`
17. `apps/desktop/public/live2d/ema/*.motion3.json`

这个顺序先看运行时，再看资源。不要反过来先啃所有 JSON，否则容易陷入参数海里，看不到代码为什么这么组织。
