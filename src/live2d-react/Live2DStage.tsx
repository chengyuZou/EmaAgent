import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type JSX,
  type MutableRefObject,
} from 'react';
import * as PIXI from 'pixi.js';
// 发布版禁止 JavaScript eval. 此模块让 Pixi 同步 Shader uniform 时不再生成函数.
import 'pixi.js/unsafe-eval';
import {
  CubismInternalModel,
  Live2DModel,
  MotionPriority,
} from '@laplace.live/pixijs-live2d';
import {
  calculateLive2DPlacement,
  type Live2DModelBounds,
} from './framing.js';
import { startLive2DIdleGaze } from './idleGaze.js';
import { loadLive2DArchive } from './live2dArchive.js';
import { attachLive2DLipSync, type Live2DLipSync } from './lipSync.js';
import { resolveLive2DLipSyncParameters } from './modelBindings.js';
import type {
  Live2DStageHandle,
  Live2DStageReadyInfo,
} from './types.js';

type CubismModel = Live2DModel<CubismInternalModel>;

/** 鼠标静止超过该时长后允许待机视线移动. */
const POINTER_IDLE_GAZE_MS = 1_000;

export interface Live2DStageProps {
  modelArchive: Blob;
  stageScale?: number;
  stageOffsetX?: number;
  stageOffsetY?: number;
  interactive?: boolean;
  pointerSource?: 'window' | 'host';
  /** 模型挂载并成功绘制首帧后通知宿主, 不表示归档刚下载完成. */
  onReady?: (info: Live2DStageReadyInfo) => void;
  onError?: (error: Error) => void;
  onDiagnostic?: (
    event:
      | 'canvas_created'
      | 'ticker_started'
      | 'ticker_stopped'
      | 'model_loading'
      | 'model_ready'
      | 'first_tick',
    durationS: number | null,
  ) => void;
  className?: string;
}

export const Live2DStage = forwardRef<Live2DStageHandle, Live2DStageProps>(
  function Live2DStage({
    modelArchive,
    stageScale = 1,
    stageOffsetX = 0,
    stageOffsetY = 0,
    interactive = true,
    pointerSource = 'window',
    onReady,
    onError,
    onDiagnostic,
    className,
  }, ref): JSX.Element {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const appRef = useRef<PIXI.Application | null>(null);
    const [application, setApplication] = useState<PIXI.Application | null>(null);
    const renderRef = useRef<() => boolean>(() => false);
    const modelRef = useRef<CubismModel | null>(null);
    const modelCleanupRef = useRef<(() => void) | null>(null);
    const loadGenerationRef = useRef(0);
    const lipSyncRef = useRef<Live2DLipSync | null>(null);
    const expressionsRef = useRef<readonly string[]>([]);
    const stageScaleRef = useRef(stageScale);
    const stageOffsetXRef = useRef(stageOffsetX);
    const stageOffsetYRef = useRef(stageOffsetY);
    const applyFramingRef = useRef<() => void>(() => {});
    const interactiveRef = useRef(interactive);
    const pointerSourceRef = useRef(pointerSource);
    const focusPointerRef = useRef<(clientX: number, clientY: number) => void>(() => {});
    const lastPointerActivityAtRef = useRef(0);
    const callbacksRef = useRef({ onReady, onError, onDiagnostic });

    interactiveRef.current = interactive;
    pointerSourceRef.current = pointerSource;
    callbacksRef.current = { onReady, onError, onDiagnostic };

    useImperativeHandle(ref, () => ({
      setExpression(name) {
        const model = modelRef.current;
        if (!model) return;
        if (name === null) {
          model.internalModel.motionManager.expressionManager?.clearExpressions();
          return;
        }

        const index = expressionsRef.current.indexOf(name);
        if (index < 0) {
          console.warn('[live2d] 未知表情名,已忽略', name);
          return;
        }
        // 表情按钮只保留本次选择, 不使用动作结束后会恢复旧表情的临时 reset.
        model.internalModel.motionManager.expressionManager?.clearExpressions();
        void model.expression(name).catch((error: unknown) => {
          console.warn('[live2d] 表情执行失败', name, error);
        });
      },
      setPlacement(nextScale, nextOffsetX, nextOffsetY) {
        stageScaleRef.current = nextScale;
        stageOffsetXRef.current = nextOffsetX;
        stageOffsetYRef.current = nextOffsetY;
        applyFramingRef.current();
      },
      playMotion(group, index) {
        const model = modelRef.current;
        if (!model) return;
        void model.motion(group, index, MotionPriority.FORCE).catch((error: unknown) => {
          console.warn('[live2d] 动作执行失败', group, index, error);
        });
      },
      setLipSync(nextSpeaking, mouthOpen) {
        lipSyncRef.current?.set(nextSpeaking, mouthOpen);
      },
      setPointerPosition(clientX, clientY) {
        focusPointerRef.current(clientX, clientY);
      },
    }), []);

    // Pixi Application 与组件同生命周期. 模型切换只替换舞台内容,不会反复销毁 Canvas.
    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      if (typeof window.Live2DCubismCore === 'undefined') {
        callbacksRef.current.onError?.(
          new Error('未加载 Live2D Cubism Core, 无法创建模型.'),
        );
        return;
      }

      const app = new PIXI.Application();
      let cancelled = false;
      let initialized = false;
      const initialize = async (): Promise<void> => {
        await app.init({
          resizeTo: host,
          backgroundAlpha: 0,
          antialias: true,
          // 固定 2x 超采样 + autoDensity 把 CSS 尺寸压回宿主: 低分屏不糊, 高分屏不放大.
          resolution: 2,
          autoDensity: true,
          autoStart: false,
          preference: 'webgl',
          preferWebGLVersion: 2,
        });
        initialized = true;
        if (cancelled) {
          app.destroy(true, { children: true, texture: true, textureSource: true });
          return;
        }

        // 渲染失败后停止, 并让宿主展示错误. 恢复窗口不能重新启动已失败的舞台.
        let renderFailed = false;
        const guardedRender = (): boolean => {
          if (renderFailed) return false;
          try {
            app.render();
            return true;
          } catch (error) {
            renderFailed = true;
            app.ticker.stop();
            callbacksRef.current.onDiagnostic?.('ticker_stopped', null);
            callbacksRef.current.onError?.(asError(error));
            return false;
          }
        };
        renderRef.current = guardedRender;
        app.ticker.remove(app.render, app);
        app.ticker.add(guardedRender, undefined, PIXI.UPDATE_PRIORITY.LOW);

        appRef.current = app;
        host.appendChild(app.canvas);
        setApplication(app);
        app.start();
        callbacksRef.current.onDiagnostic?.('canvas_created', null);
        callbacksRef.current.onDiagnostic?.('ticker_started', null);
      };
      void initialize().catch((cause: unknown) => {
        if (!cancelled) callbacksRef.current.onError?.(asError(cause));
      });

      return () => {
        cancelled = true;
        loadGenerationRef.current += 1;
        modelCleanupRef.current?.();
        modelCleanupRef.current = null;
        appRef.current = null;
        renderRef.current = () => false;
        if (initialized) {
          app.destroy(true, { children: true, texture: true, textureSource: true });
        }
      };
    }, []);

    useEffect(() => {
      stageScaleRef.current = stageScale;
      stageOffsetXRef.current = stageOffsetX;
      stageOffsetYRef.current = stageOffsetY;
      applyFramingRef.current();
    }, [stageOffsetX, stageOffsetY, stageScale]);

    useEffect(() => {
      const app = application;
      if (!app) return;
      const generation = ++loadGenerationRef.current;
      const loadStartedAt = performance.now();
      callbacksRef.current.onDiagnostic?.('model_loading', null);

      void loadLive2DArchive(modelArchive, {
        ticker: app.ticker,
        autoHitTest: false,
        autoFocus: false,
        autoUpdate: true,
      }).then((model) => {
        if (generation !== loadGenerationRef.current || appRef.current !== app) {
          model.destroy({ children: true, texture: true, baseTexture: true });
          return;
        }

        // 新模型加载完成后再移除旧模型, 加载期间仍显示原角色.
        modelCleanupRef.current?.();
        const cleanupModel = mountModel(app, model, {
          interactiveRef,
          pointerSourceRef,
          focusPointerRef,
          lastPointerActivityAtRef,
          modelRef,
          lipSyncRef,
          expressionsRef,
          stageScaleRef,
          stageOffsetXRef,
          stageOffsetYRef,
          applyFramingRef,
        });
        const firstTick = (): void => {
          callbacksRef.current.onDiagnostic?.(
            'first_tick',
            (performance.now() - loadStartedAt) / 1000,
          );
        };
        app.ticker.addOnce(firstTick);
        modelCleanupRef.current = () => {
          app.ticker.remove(firstTick);
          cleanupModel();
        };
        callbacksRef.current.onDiagnostic?.(
          'model_ready',
          (performance.now() - loadStartedAt) / 1000,
        );
        // 先绘制首帧再让宿主撤下加载提示. 渲染失败由 guardedRender 报告.
        if (!renderRef.current()) return;
        callbacksRef.current.onReady?.({
          hasExpressions: expressionsRef.current.length > 0,
          expressions: expressionsRef.current,
        });
      }).catch((cause: unknown) => {
        if (generation === loadGenerationRef.current) {
          callbacksRef.current.onError?.(asError(cause));
        }
      });

      return () => {
        if (generation === loadGenerationRef.current) {
          loadGenerationRef.current += 1;
        }
      };
    }, [application, modelArchive]);

    return (
      <div
        ref={hostRef}
        className={className}
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      />
    );
  },
);

interface MountedModelRefs {
  readonly interactiveRef: MutableRefObject<boolean>;
  readonly pointerSourceRef: MutableRefObject<'window' | 'host'>;
  readonly focusPointerRef: MutableRefObject<(clientX: number, clientY: number) => void>;
  readonly lastPointerActivityAtRef: MutableRefObject<number>;
  readonly modelRef: MutableRefObject<CubismModel | null>;
  readonly lipSyncRef: MutableRefObject<Live2DLipSync | null>;
  readonly expressionsRef: MutableRefObject<readonly string[]>;
  readonly stageScaleRef: MutableRefObject<number>;
  readonly stageOffsetXRef: MutableRefObject<number>;
  readonly stageOffsetYRef: MutableRefObject<number>;
  readonly applyFramingRef: MutableRefObject<() => void>;
}

function mountModel(
  app: PIXI.Application,
  model: CubismModel,
  refs: MountedModelRefs,
): () => void {
  const cleanups: Array<() => void> = [];
  refs.modelRef.current = model;
  app.stage.addChild(model);

  refs.lipSyncRef.current = attachLive2DLipSync(
    model.internalModel,
    resolveLive2DLipSyncParameters(model.internalModel),
  );

  refs.lastPointerActivityAtRef.current = performance.now();
  const focusController = model.internalModel.focusController;
  cleanups.push(startLive2DIdleGaze(
    (x, y) => focusController.focus(x, y),
    () => refs.interactiveRef.current
      && performance.now() - refs.lastPointerActivityAtRef.current > POINTER_IDLE_GAZE_MS,
  ));

  const bounds = model.getLocalBounds();
  const modelBounds: Live2DModelBounds = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
  const fit = (): void => applyFraming(
    app,
    model,
    modelBounds,
    refs.stageScaleRef.current,
    refs.stageOffsetXRef.current,
    refs.stageOffsetYRef.current,
  );
  refs.applyFramingRef.current = fit;
  fit();
  // 等 renderer 更新尺寸后再计算构图, 避免使用 resize 前的宽高.
  app.renderer.on('resize', fit);
  cleanups.push(() => app.renderer.off('resize', fit));

  let previousPointerX: number | null = null;
  let previousPointerY: number | null = null;
  refs.focusPointerRef.current = (clientX, clientY): void => {
    if (!refs.interactiveRef.current) return;
    // 系统每帧采样, 静止坐标不算新活动, 保留原有待机视线.
    if (clientX === previousPointerX && clientY === previousPointerY) return;
    const rect = app.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    previousPointerX = clientX;
    previousPointerY = clientY;
    refs.lastPointerActivityAtRef.current = performance.now();
    // 窗口外的鼠标仍决定视线方向, 不再因为离开画布就回到正中间.
    const x = ((clientX - rect.left) / rect.width) * app.screen.width;
    const y = ((clientY - rect.top) / rect.height) * app.screen.height;
    model.focus(x, y);
  };
  const followPointer = (event: MouseEvent): void => {
    if (refs.pointerSourceRef.current !== 'window') return;
    refs.focusPointerRef.current(event.clientX, event.clientY);
  };
  window.addEventListener('mousemove', followPointer);
  cleanups.push(() => window.removeEventListener('mousemove', followPointer));

  refs.expressionsRef.current = extractExpressionNames(model.internalModel);
  return () => {
    refs.focusPointerRef.current = () => {};
    refs.applyFramingRef.current = () => {};
    for (const cleanup of cleanups.reverse()) cleanup();
    refs.lipSyncRef.current?.dispose();
    refs.lipSyncRef.current = null;
    refs.expressionsRef.current = [];
    refs.modelRef.current = null;
    app.stage.removeChild(model);
    model.destroy({ children: true, texture: true, baseTexture: true });
  };
}

function extractExpressionNames(internalModel: CubismInternalModel): string[] {
  return (internalModel.settings.expressions ?? [])
    .map(expression => expression.Name.trim())
    .filter(Boolean);
}

function applyFraming(
  app: PIXI.Application,
  model: CubismModel,
  bounds: Live2DModelBounds,
  stageScale: number,
  stageOffsetX: number,
  stageOffsetY: number,
): void {
  const placement = calculateLive2DPlacement({
    width: app.screen.width,
    height: app.screen.height,
  }, bounds, stageScale, stageOffsetX, stageOffsetY);
  if (!placement) return;
  model.scale.set(placement.scale);
  model.x = placement.x;
  model.y = placement.y;
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
