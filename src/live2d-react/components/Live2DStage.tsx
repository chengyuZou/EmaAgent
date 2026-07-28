// 装配 Live2D 模型加载、渲染、动作与表情运行流水线。
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as PIXI from 'pixi.js';
import { DropShadowFilter } from 'pixi-filters';
import { Live2DModel as PixiLive2DModel } from 'pixi-live2d-display/cubism4';

import type { Live2DStageHandle, Live2DFraming, Live2DError } from '../types.js';
import type { Live2DRuntime } from '../runtime.js';
import { createMouseEyeTrackPlugin } from '../composables/mouse-track.js';
import { createHeadPosePlugin } from '../composables/head-pose.js';
import { createIdleEyeSaccadePlugin } from '../composables/idle-eye-saccade.js';
import { createAudioLipSyncPlugin } from '../composables/audio-lipsync.js';
import { startRandomIdleScheduler } from '../composables/random-idle.js';
import { createExpressionController, type CoreModelLike } from '../composables/expression-controller.js';
import { Live2DLoadCoordinator } from '../composables/load-coordinator.js';
import { createLive2DRuntimeFaultBoundary } from '../composables/runtime-fault-boundary.js';
import { useLive2DRuntime } from './Live2DRuntimeProvider.js';
import {
  createMotionManagerUpdate,
  createAutoEyeBlinkPlugin,
  createExpressionPlugin,
  createExpressionResetPlugin,
  createIdleDisablePlugin,
  type InternalModelForPlugins,
  type MotionManagerUpdate,
} from '../composables/motion-manager.js';
import {
  live2DReloadConfigKey,
  resolveLive2DModelRuntimeConfig,
  type Live2DModelRuntimeConfig,
} from '../model-config.js';
import {
  calculateLive2DFraming,
  type Live2DNaturalBounds,
} from '../framing.js';

// pixi-live2d-display's `autoUpdate: true` is a NO-OP unless a Ticker class is
// registered with the library first. Without this the model loads and renders
// frame 0 but never ticks — no breath, no blink, no idle sway, no lip-sync
// (looks "completely frozen"). Register once at module load, before any
// PixiLive2DModel.from().
//
// 注:`registerTicker` 在 0.5.0-beta 标 @deprecated,推荐 `Live2DModelOptions.ticker`
// 传实例。但实测 `ticker: app.ticker` 在 0.5.0-beta 不驱动 update(模型卡第 0 帧),
// 故回退到 registerTicker —— deprecated 但实际有效。新 API 待 0.5.0 正式版再验证迁移。
PixiLive2DModel.registerTicker(PIXI.Ticker);

// ── Live2DStage ─────────────────────────────────────────────────────────────
//
// Single-file orchestrator that:
//   1. Creates a PIXI.Application with transparent background + render guard
//   2. Loads the Live2D model
//   3. Applies half-body / full-body framing
//   4. Wires the motion-manager pipeline:
//        - mouse-track  (pre)
//        - idle-beat    (final)
//        - auto-blink   (final, before expression)
//        - expression   (final, after blink)
//        - audio-sync   (final, after expression)
//   5. Subscribes to this stage runtime for expression / motion intents
//
// Cubism 4 (.moc3) only. Cubism 2 is intentionally not bundled.
//
// PIXI.Application owns a WebGL context. Chrome caps these at ~16 per tab,
// so mount/unmount cycles MUST destroy the app cleanly.

// pixi-live2d-display 在浏览器运行时读取 window.PIXI；Node/SSR 只导入包时不得访问 window。
if (typeof window !== 'undefined') {
  (window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI;
}

export interface Live2DStageProps {
  modelPath: string;
  runtime?: Live2DRuntime;
  framing?:  Live2DFraming;
  runtimeConfig?: Live2DModelRuntimeConfig;
  /** 宿主窗口隐藏时暂停渲染与动作时间轴，不销毁已加载模型。 */
  suspended?: boolean;
  /** 渲染帧率上限；0 或缺省表示不限制。 */
  maxFps?: number;
  /** 渲染分辨率倍率(在设备像素比基础上超采样/降采样);默认 1。 */
  renderScale?: number;
  /** 主题色动态投影;默认 true。 */
  shadowEnabled?: boolean;
  onReady?:  () => void;
  onError?:  (err: Live2DError) => void;
  className?: string;
}

export const Live2DStage = forwardRef<Live2DStageHandle, Live2DStageProps>(
  function Live2DStage(props, ref) {
    const {
      modelPath,
      framing = 'halfbody',
      runtimeConfig,
      suspended = false,
      maxFps = 0,
      renderScale = 1,
      shadowEnabled = true,
      onReady,
      onError,
      className,
    } = props;
    const runtime = useLive2DRuntime(props.runtime);
    const { live2dStore, expressionStore, speechStore } = runtime;

    const containerRef = useRef<HTMLDivElement | null>(null);
    const shadowColorRef = useRef<HTMLDivElement | null>(null);
    const appRef       = useRef<PIXI.Application | null>(null);
    const modelRef     = useRef<InstanceType<typeof PixiLive2DModel> | null>(null);
    const motionPipelineRef = useRef<MotionManagerUpdate | null>(null);
    const callbacksRef = useRef({ onReady, onError, runtimeConfig });
    const loadCoordinatorRef = useRef<Live2DLoadCoordinator | null>(null);
    const renderCircuitOpenRef = useRef(false);
    // PIXI 默认分辨率(设备像素比);renderScale 在此基础上倍乘。
    const baseResolutionRef = useRef(1);
    const [error, setError] = useState<Live2DError | null>(null);
    const [rendererGeneration, setRendererGeneration] = useState(0);
    const [pageHidden, setPageHidden] = useState(
      () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
    );
    const effectiveSuspended = suspended || pageHidden;
    const suspendedRef = useRef(effectiveSuspended);
    const reloadConfigKey = live2DReloadConfigKey(runtimeConfig);

    const loadCoordinator = loadCoordinatorRef.current ?? new Live2DLoadCoordinator();
    loadCoordinatorRef.current = loadCoordinator;

    useEffect(() => {
      callbacksRef.current = { onReady, onError, runtimeConfig };
    }, [onReady, onError, runtimeConfig]);

    // 浏览器标签页隐藏是非 Tauri 宿主的兜底；桌面托盘隐藏由 suspended 显式传入。
    useEffect(() => {
      if (typeof document === 'undefined') return;
      const updateVisibility = (): void => {
        setPageHidden(document.visibilityState === 'hidden');
      };
      document.addEventListener('visibilitychange', updateVisibility);
      updateVisibility();
      return () => document.removeEventListener('visibilitychange', updateVisibility);
    }, []);

    useEffect(() => {
      suspendedRef.current = effectiveSuspended;
      motionPipelineRef.current?.setSuspended(effectiveSuspended);
      const model = modelRef.current;
      if (model) model.automator.autoUpdate = !effectiveSuspended;
      const app = appRef.current;
      if (!app) return;
      if (effectiveSuspended) app.ticker.stop();
      else if (!renderCircuitOpenRef.current) app.ticker.start();
    }, [effectiveSuspended]);

    // maxFps prop 变化时更新渲染帧率上限;0 表示不限制。
    useEffect(() => {
      const app = appRef.current;
      if (app) app.ticker.maxFPS = maxFps;
    }, [maxFps]);

    // renderScale prop 变化时调整渲染分辨率;resizeTo 负责随后重排画布。
    useEffect(() => {
      const app = appRef.current;
      if (!app) return;
      app.renderer.resolution = baseResolutionRef.current * renderScale;
      app.resize();
    }, [renderScale]);

    useImperativeHandle(ref, () => ({
      setExpression(name) { live2dStore.getState().setExpression(name); },
      playMotion(group, index) { live2dStore.getState().playMotion(group, index); },
      isReady() { return live2dStore.getState().ready; },
    }), [live2dStore]);

    useEffect(() => {
      const host = containerRef.current;
      if (!host) return;
      setError(null);
      renderCircuitOpenRef.current = false;

      if (typeof window.Live2DCubismCore === 'undefined') {
        const err: Live2DError = {
          kind:    'cubism_core_missing',
          phase:   'initialization',
          message: 'window.Live2DCubismCore not found. Load live2dcubismcore.min.js before React mounts.',
          recoverable: false,
        };
        setError(err);
        callbacksRef.current.onError?.(err);
        return;
      }

      const load = loadCoordinator.begin();
      let app: PIXI.Application | null = null;
      let ownedModel: InstanceType<typeof PixiLive2DModel> | null = null;
      const cleanupTasks: Array<() => void> = [];
      try {
        app = new PIXI.Application({
          resizeTo:        host,
          backgroundAlpha: 0,
          antialias:       true,
        });
        app.ticker.maxFPS = maxFps;
        baseResolutionRef.current = app.renderer.resolution;
        if (renderScale !== 1) {
          app.renderer.resolution = baseResolutionRef.current * renderScale;
          app.resize();
        }
      } catch (cause) {
        load.cancel();
        const err: Live2DError = {
          kind:    'pixi_init_failed',
          phase:   'initialization',
          message: (cause as Error).message ?? String(cause),
          cause,
          recoverable: false,
        };
        setError(err);
        callbacksRef.current.onError?.(err);
        return;
      }
      appRef.current = app;
      const faultBoundary = createLive2DRuntimeFaultBoundary({
        emit: (fault) => {
          if (!load.isCurrent()) return;
          if (!fault.recoverable) {
            renderCircuitOpenRef.current = true;
            setError(fault);
          }
          callbacksRef.current.onError?.(fault);
          // eslint-disable-next-line no-console
          console.error('[Live2D runtime fault]', fault);
        },
        stopRendering: () => app?.ticker.stop(),
      });
      cleanupTasks.push(installRenderGuard(
        app,
        (cause) => faultBoundary.tripRender(cause),
        () => {
          if (load.isCurrent() && faultBoundary.isRenderCircuitOpen()) {
            setRendererGeneration((generation) => generation + 1);
          }
        },
      ));
      if (suspendedRef.current) app.ticker.stop();
      host.appendChild(app.view as HTMLCanvasElement);

      void (async () => {
        try {
          const model = await PixiLive2DModel.from(modelPath, {
            motionPreload: undefined,
            autoInteract:  false,
            autoUpdate:    true,
          });
          if (!load.isCurrent() || !app) {
            model.destroy({ children: true });
            return;
          }

          ownedModel = model;
          model.automator.autoUpdate = !suspendedRef.current;
          app.stage.addChild(model);
          modelRef.current = model;

          // local bounds 不受 display scale 影响，只在模型加载后读取一次。
          // 后续 resize 始终基于这份自然尺寸计算绝对 scale，杜绝累计漂移。
          const localBounds = model.getLocalBounds();
          const naturalBounds: Live2DNaturalBounds = {
            x: localBounds.x,
            y: localBounds.y,
            width: localBounds.width,
            height: localBounds.height,
          };
          const fit = (): void => applyFraming(app!, model, framing, naturalBounds);
          // 初次定位瞬时完成;后续 resize 用 200ms 缓动,避免跳变。
          fit();

          // 主题色动态投影:DropShadowFilter 颜色从隐藏 div 的 --ema-primary 计算,
          // MutationObserver 监听主题变量变化(暗色/hue 切换)实时更新。
          let dropShadowFilter: DropShadowFilter | null = null;
          if (shadowEnabled) {
            dropShadowFilter = new DropShadowFilter({
              offset: { x: 8, y: 8 },
              distance: 12,
              alpha: 0.25,
              blur: 2,
              color: readThemeShadowColor(shadowColorRef.current),
            });
            model.filters = [dropShadowFilter];
            if (typeof MutationObserver !== 'undefined') {
              const observer = new MutationObserver(() => {
                if (dropShadowFilter) dropShadowFilter.color = readThemeShadowColor(shadowColorRef.current);
              });
              observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme', 'data-mode'] });
              cleanupTasks.push(() => observer.disconnect());
            }
            cleanupTasks.push(() => { if (model.filters) model.filters = []; });
          }
          let framingAnimCancel: (() => void) | null = null;
          const fitAnimated = (): void => {
            framingAnimCancel?.();
            framingAnimCancel = applyFramingAnimated(app!, model, framing, naturalBounds);
          };
          window.addEventListener('resize', fitAnimated);
          cleanupTasks.push(() => {
            window.removeEventListener('resize', fitAnimated);
            framingAnimCancel?.();
          });

          // ── Wire motion-manager pipeline + plugins ────────────────────
          const internalModel = model.internalModel as unknown as InternalModelForPlugins;
          const coreModel     = internalModel.coreModel as unknown as CoreModelLike;
          const readRuntimeConfig = () =>
            resolveLive2DModelRuntimeConfig(callbacksRef.current.runtimeConfig);
          const runtimeModelId = readRuntimeConfig().modelId;
          const modelIdHint = runtimeModelId === 'unknown' ? deriveModelId(modelPath) : runtimeModelId;

          const expressionController = createExpressionController({
            getCoreModel: () => coreModel,
            expressionStore,
            modelId:      modelIdHint,
          });
          cleanupTasks.push(() => expressionController.dispose());

          const pipeline = createMotionManagerUpdate({
            internalModel,
            readModelParameters: () => live2dStore.getState().modelParameters,
            readFlags: () => {
              const s = live2dStore.getState();
              return {
                idleAnimationEnabled:  s.idleAnimationEnabled,
                autoBlinkEnabled:      s.autoBlinkEnabled,
                forceAutoBlinkEnabled: s.forceAutoBlinkEnabled,
              };
            },
            readParamNames: () => {
              const p = readRuntimeConfig().parameters;
              return {
                eyeLOpenParam: p.eyeLOpenParam,
                eyeROpenParam: p.eyeROpenParam,
                eyeBallXParam: p.eyeBallXParam,
                eyeBallYParam: p.eyeBallYParam,
              };
            },
          });
          pipeline.setSuspended(suspendedRef.current);
          motionPipelineRef.current = pipeline;

          // 必须早于 mouse/motion 执行，只清除上一帧 expression 写入；
          // 原生流水线随后重建当前帧的动作、眨眼和视线基值。
          pipeline.register(createExpressionResetPlugin(expressionController), 'pre');

          // Pre stage: mouse-track (runs before idle motions, sets eye params)
          const mousePlugin = createMouseEyeTrackPlugin(
            () => app?.view as HTMLCanvasElement ?? null,
            () => live2dStore.getState().mouseTrackEnabled,
          );
          pipeline.register(mousePlugin, 'pre');
          cleanupTasks.push(() => mousePlugin.dispose());
          // idle-disable 在 mouseTrack 之后注册:idle 动画关闭时 stopAllMotions 并
          // markHandled 短路原生 update(冻结姿态),mouseTrack 已先跑(眼珠仍跟踪鼠标)。
          pipeline.register(createIdleDisablePlugin(), 'pre');
          // Final stage: idle-beat → auto-blink → expression
          // head-pose 是转动输入参数(Param85/86/87)的唯一写入方:idle 摇摆、
          // 姿态滑块与 speechNod 在此合成为一个值纯 SET。必须是 final 级——原生
          // motion 曲线也可能写输入参数,final 在原生 update 之后运行才生效。
          // (idle.motion3.json 的 ParamBodyAngle 曲线与此无关:身体角度是
          // physics 输出,每帧被 physics.evaluate 从输入参数重算覆写。)
          pipeline.register(
            createHeadPosePlugin({
              readIdleBeatEnabled: () => live2dStore.getState().idleBeatEnabled,
              readPose: () => live2dStore.getState().pose,
              readParameters: () => readRuntimeConfig().parameters,
              readIdleBeat: () => readRuntimeConfig().idleBeat,
              speechStore,
              readLipSyncEnabled: () => live2dStore.getState().lipSyncEnabled,
            }),
            'final',
          );
          // 空闲眼动扫视:idle 且鼠标静止时,眼珠随机扫视(覆盖 mouse-track 的回中)。
          const saccadePlugin = createIdleEyeSaccadePlugin();
          pipeline.register(saccadePlugin, 'final');
          cleanupTasks.push(() => saccadePlugin.dispose());
          pipeline.register(
            createAutoEyeBlinkPlugin({
              readExpressionEnabled: () => live2dStore.getState().expressionEnabled,
            }),
            'final',
          );
          pipeline.register(createExpressionPlugin(expressionController), 'final');
          // Audio-lip-sync: reads speech-store RMS, drives ParamMouthOpenY.
          // Runs AFTER expression so mouth shape overlays on top of any
          // active expression (e.g. smile + talking at the same time).
          pipeline.register(
            createAudioLipSyncPlugin(
              speechStore,
              () => readRuntimeConfig().parameters,
              () => live2dStore.getState().lipSyncEnabled,
            ),
            'final',
          );

          // Hook the motionManager.update method. We capture the original so
          // the pipeline can call back into it when no plugin handles the frame.
          const mm = internalModel.motionManager;
          const originalUpdate = mm.update.bind(mm);
          (mm as unknown as { update: typeof mm.update }).update = (m, now) =>
            pipeline.hookUpdate(m, now, originalUpdate);
          cleanupTasks.push(() => {
            (mm as unknown as { update: typeof mm.update }).update = originalUpdate;
            if (motionPipelineRef.current === pipeline) motionPipelineRef.current = null;
          });

          // ── Parse exp3 files + populate expression store ──────────────
          const baseUrl = new URL('.', new URL(modelPath, window.location.href)).href;
          const expressionRefs = extractExpressionRefs(model);
          const availableExpressions = await expressionController.initialise(
            expressionRefs,
            async (path) => {
              const res = await fetch(path, { signal: load.signal });
              if (!res.ok) throw new Error(`fetch ${path}: ${res.status}`);
              return res.text();
            },
            baseUrl,
          );
          if (!load.isCurrent()) return;

          // ── Publish discovered state to store ─────────────────────────
          const store = live2dStore;
          store.getState()._setExpressionsAvailable(availableExpressions);
          store.getState()._setMotionsAvailable(extractMotionGroups(model));
          store.getState()._setReady(true);

          // Subscribe to motion changes (expression now flows through plugin)
          const unsubMotion = store.subscribe((s, prev) => {
            if (!load.isCurrent()) return;
            if (s.currentMotion?.requestId !== prev.currentMotion?.requestId && s.currentMotion) {
              const motion = s.currentMotion;
              faultBoundary.captureMotion(
                () => model.motion(motion.group, motion.index),
                `intent:${motion.group}:${motion.index ?? 'random'}`,
              );
            }
          });
          cleanupTasks.push(unsubMotion);

          // Subscribe to activeExpressions CHANGES — reconcile against
          // the expression-store. Added/changed intents are activated, removed
          // intents are deactivated deterministically.
          //
          // This follows AIRI's design: the expression-store holds
          // per-parameter runtime values; activeExpressions[] is the
          // high-level intent that the stage reconciles.
          const unsubExpr = store.subscribe((s, prev) => {
            if (!load.isCurrent()) return;
            const prevByName = new Map(prev.activeExpressions.map((intent) => [intent.name, intent]));
            const nextByName = new Map(s.activeExpressions.map((intent) => [intent.name, intent]));

            const removed = prev.activeExpressions.filter((intent) => !nextByName.has(intent.name));
            const changed = s.activeExpressions.filter((intent) => {
              const before = prevByName.get(intent.name);
              return !before || before.requestId !== intent.requestId;
            });

            if (changed.length === 0 && removed.length === 0) return;

            for (const intent of removed) {
              expressionStore.getState().deactivate(intent.name);
            }
            for (const intent of changed) {
              // durationSec is owned by live2dStore timers — do not pass it here.
              expressionStore.getState().set(intent.name, intent.value);
            }
          });
          cleanupTasks.push(unsubExpr);

          const runtime = readRuntimeConfig();

          // Best-effort idle motion
          for (const candidate of [runtime.randomIdle.group, 'Idle', 'idle', '']) {
            if (!load.isCurrent()) return;
            try {
              await model.motion(candidate);
              if (!load.isCurrent()) return;
              break;
            } catch {
              if (!load.isCurrent()) return;
            }
          }

          // Start random idle motion scheduler (configurable, skips when speaking)
          const motionGroups = extractMotionGroups(model);
          const stopIdleScheduler = startRandomIdleScheduler({
            playMotion: (group, index) => {
              if (!load.isCurrent()) return;
              faultBoundary.captureMotion(
                () => model.motion(group, index),
                `random-idle:${group}:${index ?? 'random'}`,
              );
            },
            readConfig: () => {
              const current = readRuntimeConfig().randomIdle;
              return {
                group: current.group,
                motionCount: motionGroups[current.group] ?? 0,
                minDelayMs: current.minDelayMs,
                maxDelayMs: current.maxDelayMs,
              };
            },
            readEnabled: () => {
              const live2d = live2dStore.getState();
              return !suspendedRef.current
                && live2d.idleAnimationEnabled
                && !speechStore.getState().speaking;
            },
          });
          cleanupTasks.push(stopIdleScheduler);

          if (!load.isCurrent()) return;
          callbacksRef.current.onReady?.();
        } catch (cause) {
          if (!load.isCurrent()) return;
          const err: Live2DError = {
            kind:    'model_load_failed',
            phase:   'model_loading',
            message: (cause as Error).message ?? String(cause),
            cause,
            recoverable: false,
          };
          setError(err);
          callbacksRef.current.onError?.(err);
        }
      })();

      return () => {
        const ownsPublishedState = load.isCurrent();
        load.cancel();
        for (const off of cleanupTasks) {
          try { off(); } catch { /* ignore */ }
        }
        if (ownedModel) {
          ownedModel.destroy({ children: true });
          if (modelRef.current === ownedModel) modelRef.current = null;
          ownedModel = null;
        }
        if (app) {
          app.destroy(true, { children: true, texture: true, baseTexture: true });
          if (appRef.current === app) appRef.current = null;
          app = null;
        }
        if (ownsPublishedState) {
          renderCircuitOpenRef.current = false;
          runtime.reset();
        }
      };
    }, [
      modelPath,
      framing,
      loadCoordinator,
      live2dStore,
      expressionStore,
      speechStore,
      runtime,
      reloadConfigKey,
      rendererGeneration,
    ]);

    return (
      <div
        ref={containerRef}
        className={className}
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      >
        {/* 隐藏 div,用于从 --ema-primary CSS 变量读取主题色(阴影) */}
        <div
          ref={shadowColorRef}
          aria-hidden
          style={{ position: 'absolute', width: 1, height: 1, visibility: 'hidden', background: 'var(--ema-primary, #000000)' }}
        />
        {error && (
          <div
            role="alert"
            style={{
              position: 'absolute',
              bottom: 20, left: 20, right: 20,
              padding: '8px 12px',
              background: 'rgba(220, 50, 50, 0.85)',
              borderRadius: 6,
              fontSize: 12,
              color: 'white',
              pointerEvents: 'auto',
            }}
          >
            Live2D {error.kind}: {error.message}
          </div>
        )}
      </div>
    );
  },
);

// ── Helpers ─────────────────────────────────────────────────────────────────

function installRenderGuard(
  app: PIXI.Application,
  onFailure: (cause: unknown) => void,
  onContextRestored: () => void,
): () => void {
  const guarded = (): void => {
    try { app.render(); }
    catch (cause) { onFailure(cause); }
  };
  const canvas = app.view as HTMLCanvasElement;
  const onContextLost = (event: Event): void => {
    event.preventDefault();
    onFailure(new Error('WebGL context lost'));
  };

  app.ticker.remove(app.render, app);
  app.ticker.add(guarded);
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  return () => {
    app.ticker.remove(guarded);
    canvas.removeEventListener('webglcontextlost', onContextLost);
    canvas.removeEventListener('webglcontextrestored', onContextRestored);
  };
}

function applyFraming(
  app:     PIXI.Application,
  model:   InstanceType<typeof PixiLive2DModel>,
  framing: Live2DFraming,
  naturalBounds: Live2DNaturalBounds,
): void {
  // 必须用 screen(逻辑尺寸)而非 renderer.width(物理像素):
  // renderScale 改变 resolution 后,物理宽度 = 逻辑 × renderScale,
  // 而 model.scale/x/y 活在逻辑(stage)坐标系,混用会让模型随 renderScale 倍增。
  const placement = calculateLive2DFraming({
    width: app.renderer.screen.width,
    height: app.renderer.screen.height,
  }, naturalBounds, framing);
  if (!placement) return;

  model.scale.set(placement.scale);
  model.x = placement.x;
  model.y = placement.y;
}

/** 从隐藏 div 的 --ema-primary CSS 变量读取主题色,转为 PIXI 数字色。 */
function readThemeShadowColor(el: HTMLDivElement | null): number {
  if (!el || typeof getComputedStyle === 'undefined') return 0x000000;
  const css = getComputedStyle(el).backgroundColor;
  return cssColorToNumber(css);
}

/** 把 CSS 颜色(oklch/rgb/hex)转为 PIXI 数字色;canvas 规范化后解析。 */
function cssColorToNumber(cssColor: string): number {
  if (typeof document === 'undefined') return 0x000000;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (!ctx) return 0x000000;
  ctx.fillStyle = '#000000';
  ctx.fillStyle = cssColor;
  const normalized = ctx.fillStyle;
  if (normalized.startsWith('#')) {
    const n = parseInt(normalized.slice(1), 16);
    return Number.isFinite(n) ? n : 0x000000;
  }
  const m = normalized.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (m) {
    return (parseInt(m[1]!, 10) << 16) | (parseInt(m[2]!, 10) << 8) | parseInt(m[3]!, 10);
  }
  return 0x000000;
}

/**
 * 缓动版 applyFraming:从当前 scale/x/y 用 200ms easeOutQuad 动画到目标。
 * 返回取消函数;调用方负责在新动画前取消上一个,防叠加。
 */
function applyFramingAnimated(
  app:     PIXI.Application,
  model:   InstanceType<typeof PixiLive2DModel>,
  framing: Live2DFraming,
  naturalBounds: Live2DNaturalBounds,
): (() => void) | null {
  // 同 applyFraming:用逻辑尺寸,与 renderScale 解耦。
  const placement = calculateLive2DFraming({
    width: app.renderer.screen.width,
    height: app.renderer.screen.height,
  }, naturalBounds, framing);
  if (!placement) return null;

  const startScale = model.scale.x;
  const startX = model.x;
  const startY = model.y;
  const startTime = performance.now();
  const durationMs = 200;

  let raf: number | null = requestAnimationFrame(function step(now: number) {
    const t = Math.min(1, (now - startTime) / durationMs);
    const eased = 1 - (1 - t) * (1 - t);
    model.scale.set(startScale + (placement.scale - startScale) * eased);
    model.x = startX + (placement.x - startX) * eased;
    model.y = startY + (placement.y - startY) * eased;
    if (t < 1) raf = requestAnimationFrame(step);
    else raf = null;
  });

  return () => {
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
  };
}

function extractExpressionRefs(model: InstanceType<typeof PixiLive2DModel>): Array<{ Name: string; File: string }> {
  const s = (model.internalModel as unknown as { settings?: { expressions?: Array<{ Name?: string; File?: string }> } }).settings;
  return (s?.expressions ?? [])
    .filter((e): e is { Name: string; File: string } => Boolean(e.Name) && Boolean(e.File));
}

function extractMotionGroups(model: InstanceType<typeof PixiLive2DModel>): Record<string, number> {
  const s = (model.internalModel as unknown as { settings?: { motions?: Record<string, unknown[]> } }).settings;
  const motions = s?.motions ?? {};
  const out: Record<string, number> = {};
  for (const [group, list] of Object.entries(motions)) {
    out[group] = Array.isArray(list) ? list.length : 0;
  }
  return out;
}

function deriveModelId(modelPath: string): string {
  try {
    const u = new URL(modelPath, window.location.href);
    // Use last directory segment as the model id (stable per model folder).
    const parts = u.pathname.split('/').filter((p) => p.length > 0);
    // Drop the .model3.json filename
    if (parts.length > 0 && parts[parts.length - 1]!.endsWith('.json')) parts.pop();
    return parts[parts.length - 1] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// ── No bridge needed — Live2DStage directly calls its runtime expression store
//    inside the activeExpressions subscription above.
