# @ema-agent/live2d-react 全包开发说明

最后更新：2026-05-31

`@ema-agent/live2d-react` 是 EmaAgent 的 Live2D 舞台运行时包。它只负责模型加载、表情和动作执行、TTS 口型、鼠标眼神、idle 生命感；不负责 Agent 主循环、LLM、记忆、TTS 合成或 SSE 连接。

## 1. 设计边界

```text
角色卡 / Emotion / Stage Cue / TTS RMS / UI
        ↓
Live2D runtime config + Zustand intent stores
        ↓
Live2DStage
        ↓
PIXI + pixi-live2d-display
        ↓
motionManager.update pipeline
        ↓
coreModel.setParameterValueById(...)
        ↓
Cubism motion / physics / render
```

这个包的核心原则：

- 角色卡里的 `happy/sad/wave/nod` 是语义标签，不等于 Live2D 资源名。
- Live2D 模型里的 `liulei/taishou/Idle` 是资源名，不应直接污染角色卡 prompt。
- 中间用 `Live2DModelRuntimeConfig` 做映射。
- Zustand store 存的是“意图”，真实会影响画面的参数存在 Cubism `coreModel` 里。

## 2. 文件结构

```text
src/live2d-react/
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts
    ├── types.ts
    ├── model-config.ts
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
    │   └── random-idle.ts
    └── utils/
        └── math.ts
```

`animation.ts` 已删除。Ema 的眼神策略确定为“眼睛跟随鼠标”，不再保留 idle 随机眼神游移，避免两套逻辑同时写 `ParamEyeBallX/Y`。

## 3. 公开 API

入口：`src/index.ts`

主要导出：

```ts
export { Live2DStage } from './components/Live2DStage.js';
export { useLive2DStore } from './stores/live2d-store.js';
export { useExpressionStore } from './stores/expression-store.js';
export { useSpeechStore } from './stores/speech-store.js';
export {
  DEFAULT_LIVE2D_RUNTIME_CONFIG,
  resolveLive2DModelRuntimeConfig,
} from './model-config.js';
```

`Live2DStageHandle`：

```ts
export interface Live2DStageHandle {
  setExpression(name: string | null): void;
  playMotion(group: string, index?: number): void;
  isReady(): boolean;
}
```

注意：`playMotion()` 是 fire-and-forget 命令，语义是“请求播放这个 motion”，不是“等待 motion 播放完成”。

## 4. Runtime Config

文件：`src/model-config.ts`

`Live2DModelRuntimeConfig` 是角色语义和模型资源之间的翻译层：

```ts
export interface Live2DModelRuntimeConfig {
  modelId?: string;
  emotionMap?: Record<string, Live2DStageTarget>;
  motionMap?: Record<string, Live2DMotionTarget>;
  parameters?: Partial<Live2DParameterRuntimeConfig>;
  idleBeat?: Partial<Live2DIdleBeatRuntimeConfig>;
  randomIdle?: Partial<Live2DRandomIdleRuntimeConfig>;
}
```

Ema 的桌面接入点把角色卡中的 emotion/motion 词汇映射到模型能力：

```ts
emotionMap: {
  sad: { expression: 'liulei' },
  scared: { expression: 'liulei' },
  determined: { expression: 'taishou' },
  focused: { expression: 'taishou' },
  surprised: { expression: 'taishou' },
  angry: { expression: 'monvhua' },
}
```

这解决了一个关键问题：角色卡可以继续使用 `happy/sad/shy` 这类自然语义，而 Live2D 包只执行实际存在的 `exp3/motion3` 资源名。

## 5. Store 分工

### 5.1 `useLive2DStore`

文件：`src/stores/live2d-store.ts`

它存高层意图，不直接写模型参数。

| 字段 | 说明 |
|---|---|
| `activeExpressions` | `ActiveExpressionIntent[]`，当前希望激活的表情意图 |
| `currentMotion` | `MotionIntent`，当前希望播放的 motion |
| `modelParameters` | 手动参数覆盖层，目前是左右眼开合 base |
| `idleAnimationEnabled` | 是否允许 random idle motion |
| `idleBeatEnabled` | 是否启用基础晃动 |
| `autoBlinkEnabled` | 是否自动眨眼 |
| `forceAutoBlinkEnabled` | 是否强制使用代码眨眼状态机 |
| `expressionEnabled` | 是否启用表情 overlay |
| `availableExpressions` | 模型加载后发现的表情 |
| `availableMotions` | 模型加载后发现的 motion group |
| `ready` | 模型是否 ready |

`activeExpressions` 已从 `string[]` 升级成 intent：

```ts
export interface ActiveExpressionIntent {
  name: string;
  value: boolean | number;
  source: 'emotion' | 'ui' | 'agent' | 'system';
  requestId: string;
  createdAt: number;
  durationSec?: number;
}
```

这样 `durationSec` 不再是假参数，`Live2DStage` 会把它传给 `ExpressionStore`。

### 5.2 `useExpressionStore`

文件：`src/stores/expression-store.ts`

它存 `.exp3.json` 解析后的参数状态。

| 字段 | 说明 |
|---|---|
| `expressionGroups` | `Map<expressionName, ExpressionGroupDefinition>` |
| `expressions` | `Map<parameterId, ExpressionEntry>` |
| `modelId` | 当前模型 ID，用于 localStorage 默认值 |

它提供确定性 API：

```ts
set(name, value, durationSec?)
activate(name, value?, durationSec?)
deactivate(name)
toggle(name, durationSec?)
resetAll()
```

同步层不再使用 `toggle()` 关闭表情。关闭路径统一使用 `deactivate()`，避免状态不同步时把本来关闭的表情又打开。

### 5.3 `useSpeechStore`

文件：`src/stores/speech-store.ts`

它只存 TTS 播放时的音频包络：

| 字段 | 说明 |
|---|---|
| `speaking` | 当前是否正在播放声音 |
| `rms` | 当前音量，0 到 1 |
| `energy` | 平滑后的能量，上升快、下降慢 |

`audio-lipsync` 每帧读取它，然后写嘴型和说话点头。

## 6. Live2DStage 生命周期

文件：`src/components/Live2DStage.tsx`

启动流程：

1. 注册 `window.PIXI`。
2. 检查 `window.Live2DCubismCore`。
3. 创建透明 `PIXI.Application`。
4. 安装 render guard。
5. `PixiLive2DModel.from(modelPath)` 加载模型。
6. 按 `framing` 做半身或全身构图。
7. 创建 `ExpressionController`，解析 `.exp3.json`。
8. 创建 motion pipeline。
9. 注册 mouse / idle / blink / expression / lip-sync 插件。
10. hook `internalModel.motionManager.update`。
11. 填充 `availableExpressions` 和 `availableMotions`。
12. 订阅 `currentMotion` 和 `activeExpressions`。
13. 播放初始 idle motion。
14. 启动 random idle scheduler。
15. unmount 时恢复原始 update、移除 listener、销毁 model 和 PIXI app。

生命周期修正：

- `onReady/onError/runtimeConfig` 存在 ref 中，不参与主加载 effect 依赖，避免父组件 inline callback 导致模型重建。
- `mouse-track` 现在有 `dispose()`，unmount 时会 `removeEventListener`。
- `playMotion` 不再假装 async。

## 7. 每一帧怎么更新

原始 Live2D 更新：

```text
PIXI ticker
  ↓
Live2DModel autoUpdate
  ↓
internalModel.motionManager.update(coreModel, now)
  ↓
motion3 曲线
  ↓
Cubism physics / render
```

我们 hook 的位置：

```ts
const originalUpdate = mm.update.bind(mm);
mm.update = (m, now) => pipeline.hookUpdate(m, now, originalUpdate);
```

pipeline 顺序：

```text
pre:
  mouse-track

original:
  pixi-live2d-display motionManager.update

final:
  idle-beat
  auto-eye-blink
  expression
  audio-lipsync
```

`final` 一定执行，所以 expression 和 mouth 可以压在原始 motion 之上。

## 8. 插件说明

### 8.1 `mouse-track.ts`

唯一眼球控制源。它监听 `window.mousemove`，根据鼠标相对 canvas 中心的位置写：

- `ParamEyeBallX`
- `ParamEyeBallY`

使用 window listener 是为了兼容 Tauri 拖拽区域覆盖 canvas 的情况。

### 8.2 `idle-beat.ts`

根据 runtime config 写：

- `headInputX`
- `headInputY`
- `headInputZ`
- `breathParam`

Ema 配置中对应：

- `Param85`
- `Param86`
- `Param87`
- `ParamBreath`

这些参数进入 `ema.physics3.json` 的物理链路，会带动头、身体、头发、裙子、斗篷、锁链等。

### 8.3 `audio-lipsync.ts`

根据 runtime config 写：

- `mouthOpenParam`
- `speechNodParam`

Ema 配置中：

- `ParamMouthOpenY`，上限 `2.1`
- `Param86`，说话重音点头

### 8.4 `random-idle.ts`

定时播放随机 idle motion。现在读取：

- configured motion group
- min/max delay
- `idleAnimationEnabled`
- `useSpeechStore.speaking`

讲话时不会触发 random idle。

### 8.5 `motion-manager.ts`

保留 `pre/post/final` 管线和自动眨眼。旧的 idle focus 插件已移除。

## 9. 表情链路

以 `liulei` 为例：

```text
ema.model3.json
  Expressions: [{ Name: "liulei", File: "liulei.exp3.json" }]
        ↓
Live2DStage.extractExpressionRefs()
        ↓
expressionController.initialise()
        ↓
fetch liulei.exp3.json
        ↓
ExpressionGroupDefinition + ExpressionEntry
        ↓
useExpressionStore.registerExpressions()
```

激活时：

```text
useLive2DStore.addExpression("liulei", { source: "emotion" })
        ↓
Live2DStage subscription sees new intent
        ↓
useExpressionStore.set("liulei", true, durationSec)
        ↓
每帧 expression plugin applyExpressions()
        ↓
coreModel.setParameterValueById("Param", value)
```

关闭时：

```text
useLive2DStore.removeExpression("liulei")
        ↓
Live2DStage subscription sees removed intent
        ↓
useExpressionStore.deactivate("liulei")
```

不再使用 `toggle()` 做同步关闭。

## 10. Ema 资源能力

目录：`apps/desktop/public/live2d/ema`

### 10.1 `ema.model3.json`

| 类别 | 当前内容 |
|---|---|
| Moc | `ema.moc3` |
| Texture | `ema.8192/texture_00.png` |
| Physics | `ema.physics3.json` |
| DisplayInfo | `ema.cdi3.json` |
| Expressions | `taishou`、`liulei`、`monvhua` |
| Motions | `Idle` 组，2 个 motion |
| EyeBlink | `ParamEyeLOpen`、`ParamEyeROpen` |
| LipSync | 空 |

### 10.2 表情

| 表情 | 文件 | 参数 |
|---|---|---|
| `taishou` | `taishou.exp3.json` | `Param23 = 1 Add` |
| `liulei` | `liulei.exp3.json` | `Param = 1 Add` |
| `monvhua` | `monvhua.exp3.json` | `Param2 = 1 Add`, `Param23 = 0 Add` |

### 10.3 动作

| 文件 | Duration | Loop | 曲线 |
|---|---:|---|---|
| `idle.motion3.json` | 4.0s | true | `ParamBreath`, `ParamBodyAngleX/Y/Z` |
| `Scene1.motion3.json` | 1.633s | true | `Param133`, `Param138` |

### 10.4 `ema.vtube.json`

VTube Studio 私有配置，不是运行时依赖，但它给了 Ema 参数范围：

| 用途 | 参数 | 范围 |
|---|---|---|
| 脸左右输入 | `Param85` | -30..30 |
| 脸上下输入 | `Param86` | -30..30 |
| 歪头输入 | `Param87` | -30..30 |
| 嘴张开 | `ParamMouthOpenY` | 0..2.1 |
| 嘴角 | `ParamMouthForm` | -2..1 |
| 呼吸 | `ParamBreath` | 0..1 |

## 11. 与角色卡的关系

角色卡里已经有：

```ts
emotionVocabulary: string[];
motionVocabulary: string[];
live2dModelId: string | null;
```

正确关系是：

```text
CharacterCard
  emotionVocabulary: happy/sad/shy
  motionVocabulary: wave/nod/idle
  live2dModelId: ema
        ↓
live2d_models.params_json
  emotionMap: sad -> liulei
  motionMap: idle -> Idle:0
  parameters: Ema 参数名和范围
        ↓
live2d-react
  执行真实 expression/motion/parameter
```

现在 Ema 的 runtime config 暂时写在 `EmaStageView.tsx`，后续应从 `live2d_models.params_json` 读取。

## 12. 当前已修正的问题

| 问题 | 处理 |
|---|---|
| `expression-tools` 前端伪 Agent 工具入口 | 已删除。后端 Agent 工具必须统一走 `@ema-agent/tool` 的 `buildTool` 规范；Live2D 只消费 `emotion_changed` / `stage_cue` / TTS RMS 这类结构化事件 |
| removed expression 用 `toggle()` | 已改为确定性 `deactivate()` |
| `durationSec` 假参数 | 已进入 `ActiveExpressionIntent` 并传到 `ExpressionStore` |
| `playMotion` fake async | 已改为 `void` fire-and-forget |
| `onReady/onError` 触发模型重挂 | 已用 ref 保存 callback |
| idle 随机眼神游移闲置 | 已删除 `animation.ts`，保留 mouse tracking |
| `mouse-track` listener 不释放 | 已增加 `dispose()` 并由 Live2DStage cleanup |
| `types.ts` 旧 MotionUpdate 类型 | 已删除旧类型 |
| Ema 参数硬编码在插件里 | 已迁移到 runtime config |
| random idle 不看 `idleAnimationEnabled` | 已接入开关 |

## 13. 后续建议

1. 把 `EmaStageView.tsx` 里的 `EMA_LIVE2D_RUNTIME_CONFIG` 移到数据库 `live2d_models.params_json`。
2. 让角色卡切换事件触发 stage reload：`stage.loadModel(next.live2dModelId)`。
3. 增加 Live2D 设置页，展示 `availableExpressions`、`availableMotions` 和 emotion/motion 映射。
4. 如果未来要支持更多模型，给每个模型做一次 `vtube/model3/cdi3` 参数导入器，自动生成初始 config。
