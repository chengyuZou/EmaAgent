// 在一个稳定的 Pixi Canvas 中加载 Character 模型包,并执行表情、动作和口型命令。

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type JSX,
  type MutableRefObject,
} from 'react';
import * as PIXI from 'pixi.js';
import {
  Cubism4InternalModel,
  Live2DModel,
  MotionPriority,
} from 'pixi-live2d-display/cubism4';
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

type Cubism4Model = Live2DModel<Cubism4InternalModel>;

/** 鼠标静止超过该时长后,视线输入从鼠标切换为待机游移。 */
const POINTER_IDLE_GAZE_MS = 1_000;

export interface Live2DStageProps {
  modelArchive: Blob;
  stageScale?: number;
  stageOffsetX?: number;
  stageOffsetY?: number;
  suspended?: boolean;
  interactive?: boolean;
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
    suspended = false,
    interactive = true,
    onReady,
    onError,
    onDiagnostic,
    className,
  }, ref): JSX.Element {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const appRef = useRef<PIXI.Application | null>(null);
    const modelRef = useRef<Cubism4Model | null>(null);
    const modelCleanupRef = useRef<(() => void) | null>(null);
    const loadGenerationRef = useRef(0);
    const lipSyncRef = useRef<Live2DLipSync | null>(null);
    const expressionsRef = useRef<readonly string[]>([]);
    const stageScaleRef = useRef(stageScale);
    const stageOffsetXRef = useRef(stageOffsetX);
    const stageOffsetYRef = useRef(stageOffsetY);
    const applyFramingRef = useRef<() => void>(() => {});
    const suspendedRef = useRef(suspended);
    const interactiveRef = useRef(interactive);
    const lastPointerActivityAtRef = useRef(0);
    const callbacksRef = useRef({ onReady, onError, onDiagnostic });

    suspendedRef.current = suspended;
    interactiveRef.current = interactive;
    callbacksRef.current = { onReady, onError, onDiagnostic };

    useImperativeHandle(ref, () => ({
      setExpression(name) {
        const model = modelRef.current;
        if (!model) return;
        if (name === null) {
          model.internalModel.motionManager.expressionManager?.resetExpression();
          return;
        }

        const index = expressionsRef.current.indexOf(name);
        if (index < 0) {
          console.warn('[live2d] 未知表情名,已忽略', name);
          return;
        }
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
    }), []);

    // Pixi Application 与组件同生命周期. 模型切换只替换舞台内容,不会反复销毁 Canvas.
    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      if (typeof window.Live2DCubismCore === 'undefined') {
        callbacksRef.current.onError?.(
          new Error('未加载 Live2D Cubism Core,无法创建模型。'),
        );
        return;
      }

      let app: PIXI.Application;
      try {
        app = new PIXI.Application({
          resizeTo: host,
          backgroundAlpha: 0,
          antialias: true,
        });
      } catch (cause) {
        callbacksRef.current.onError?.(asError(cause));
        return;
      }

      appRef.current = app;
      host.appendChild(app.view as HTMLCanvasElement);
      callbacksRef.current.onDiagnostic?.('canvas_created', null);
      if (suspendedRef.current) {
        app.ticker.stop();
        callbacksRef.current.onDiagnostic?.('ticker_stopped', null);
      }

      return () => {
        loadGenerationRef.current += 1;
        modelCleanupRef.current?.();
        modelCleanupRef.current = null;
        appRef.current = null;
        app.destroy(true, { children: true, texture: true, baseTexture: true });
      };
    }, []);

    useEffect(() => {
      const app = appRef.current;
      if (!app) return;
      if (suspended) {
        app.ticker.stop();
        callbacksRef.current.onDiagnostic?.('ticker_stopped', null);
      } else {
        // WebView 恢复可见后的首个动画帧可能要等输入事件;先画一帧再重启 ticker。
        app.render();
        app.ticker.start();
        callbacksRef.current.onDiagnostic?.('ticker_started', null);
      }
    }, [suspended]);

    useEffect(() => {
      stageScaleRef.current = stageScale;
      stageOffsetXRef.current = stageOffsetX;
      stageOffsetYRef.current = stageOffsetY;
      applyFramingRef.current();
    }, [stageOffsetX, stageOffsetY, stageScale]);

    useEffect(() => {
      const app = appRef.current;
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
          model.destroy({ children: true });
          return;
        }

        // ZIP 可在旧模型仍显示时完成解析;只有新模型可用后才原子替换舞台内容.
        modelCleanupRef.current?.();
        const cleanupModel = mountModel(app, model, {
          interactiveRef,
          suspendedRef,
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
    }, [modelArchive]);

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
  readonly suspendedRef: MutableRefObject<boolean>;
  readonly lastPointerActivityAtRef: MutableRefObject<number>;
  readonly modelRef: MutableRefObject<Cubism4Model | null>;
  readonly lipSyncRef: MutableRefObject<Live2DLipSync | null>;
  readonly expressionsRef: MutableRefObject<readonly string[]>;
  readonly stageScaleRef: MutableRefObject<number>;
  readonly stageOffsetXRef: MutableRefObject<number>;
  readonly stageOffsetYRef: MutableRefObject<number>;
  readonly applyFramingRef: MutableRefObject<() => void>;
}

function mountModel(
  app: PIXI.Application,
  model: Cubism4Model,
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
      && !refs.suspendedRef.current
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
  // Pixi 的 resizeTo 在窗口 resize 之后才更新 renderer;构图必须等 renderer 的尺寸落定。
  app.renderer.on('resize', fit);
  cleanups.push(() => app.renderer.off('resize', fit));

  const followPointer = (event: MouseEvent): void => {
    if (!refs.interactiveRef.current) return;
    refs.lastPointerActivityAtRef.current = performance.now();
    const rect = (app.view as HTMLCanvasElement).getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const inside = event.clientX >= rect.left
      && event.clientX <= rect.right
      && event.clientY >= rect.top
      && event.clientY <= rect.bottom;
    const x = inside
      ? ((event.clientX - rect.left) / rect.width) * app.screen.width
      : app.screen.width / 2;
    const y = inside
      ? ((event.clientY - rect.top) / rect.height) * app.screen.height
      : app.screen.height / 2;
    model.focus(x, y);
  };
  window.addEventListener('mousemove', followPointer);
  cleanups.push(() => window.removeEventListener('mousemove', followPointer));

  refs.expressionsRef.current = extractExpressionNames(model.internalModel);
  return () => {
    refs.applyFramingRef.current = () => {};
    for (const cleanup of cleanups.reverse()) cleanup();
    refs.lipSyncRef.current?.dispose();
    refs.lipSyncRef.current = null;
    refs.expressionsRef.current = [];
    refs.modelRef.current = null;
    app.stage.removeChild(model);
    model.destroy({ children: true });
  };
}

function extractExpressionNames(internalModel: Cubism4InternalModel): string[] {
  return (internalModel.settings.expressions ?? [])
    .map(expression => expression.Name.trim())
    .filter(Boolean);
}

function applyFraming(
  app: PIXI.Application,
  model: Cubism4Model,
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
