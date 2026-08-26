// 加载一个 Cubism 4 模型，并通过窄句柄执行表情、动作和口型命令。

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type JSX,
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
import { startLive2DIdleMotionSchedule } from './idleMotion.js';
import { attachLive2DLipSync, type Live2DLipSync } from './lipSync.js';
import {
  resolveLive2DModelBindings,
  type ResolvedLive2DModelBindings,
} from './modelBindings.js';
import type {
  Live2DModelBindings,
  Live2DMotionReference,
  Live2DStageHandle,
  Live2DStageReadyInfo,
} from './types.js';

type Cubism4Model = Live2DModel<Cubism4InternalModel>;

/** 鼠标静止超过该时长后，视线输入从鼠标切换为待机游移。 */
const POINTER_IDLE_GAZE_MS = 8_000;

export interface Live2DStageProps {
  modelPath: string;
  bindings?: Live2DModelBindings;
  suspended?: boolean;
  interactive?: boolean;
  onReady?: (info: Live2DStageReadyInfo) => void;
  onError?: (error: Error) => void;
  className?: string;
}

export const Live2DStage = forwardRef<Live2DStageHandle, Live2DStageProps>(
  function Live2DStage({
    modelPath,
    bindings,
    suspended = false,
    interactive = true,
    onReady,
    onError,
    className,
  }, ref): JSX.Element {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const appRef = useRef<PIXI.Application | null>(null);
    const modelRef = useRef<Cubism4Model | null>(null);
    const resolvedBindingsRef = useRef<ResolvedLive2DModelBindings | null>(null);
    const lipSyncRef = useRef<Live2DLipSync | null>(null);
    const expressionsRef = useRef<readonly string[]>([]);
    const expressionIndexRef = useRef(-1);
    const bindingsRef = useRef(bindings);
    const suspendedRef = useRef(suspended);
    const interactiveRef = useRef(interactive);
    const speakingRef = useRef(false);
    const lastPointerActivityAtRef = useRef(0);
    const callbacksRef = useRef({ onReady, onError });

    bindingsRef.current = bindings;
    suspendedRef.current = suspended;
    interactiveRef.current = interactive;
    callbacksRef.current = { onReady, onError };

    useImperativeHandle(ref, () => ({
      setExpression(name) {
        const model = modelRef.current;
        if (!model) return;
        if (name === null) {
          model.internalModel.motionManager.expressionManager?.resetExpression();
          expressionIndexRef.current = -1;
          return;
        }

        const index = expressionsRef.current.indexOf(name);
        if (index < 0) {
          console.warn('[live2d] 未知表情名，已忽略', name);
          return;
        }
        expressionIndexRef.current = index;
        void model.expression(name).catch((error: unknown) => {
          console.warn('[live2d] 表情执行失败', name, error);
        });
      },
      cycleExpression() {
        const model = modelRef.current;
        const expressions = expressionsRef.current;
        if (!model || expressions.length === 0) return null;

        expressionIndexRef.current = (expressionIndexRef.current + 1) % expressions.length;
        const name = expressions[expressionIndexRef.current] ?? null;
        if (name) {
          void model.expression(name).catch((error: unknown) => {
            console.warn('[live2d] 表情轮换失败', name, error);
          });
        }
        return name;
      },
      playMotion(group, index) {
        const model = modelRef.current;
        if (!model) return;
        void model.motion(group, index).catch((error: unknown) => {
          console.warn('[live2d] 动作执行失败', group, index, error);
        });
      },
      setLipSync(nextSpeaking, mouthOpen) {
        speakingRef.current = nextSpeaking;
        lipSyncRef.current?.set(nextSpeaking, mouthOpen);
      },
    }), []);

    useEffect(() => {
      const app = appRef.current;
      if (!app) return;
      if (suspended) app.ticker.stop();
      else app.ticker.start();
    }, [suspended]);

    useEffect(() => {
      const model = modelRef.current;
      if (!model) return;
      resolvedBindingsRef.current = resolveLive2DModelBindings(
        model.internalModel,
        bindings,
      );
    }, [bindings]);

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      if (typeof window.Live2DCubismCore === 'undefined') {
        callbacksRef.current.onError?.(
          new Error('未加载 Live2D Cubism Core，无法创建模型。'),
        );
        return;
      }

      let cancelled = false;
      const cleanups: Array<() => void> = [];
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
      if (suspendedRef.current) app.ticker.stop();

      void Live2DModel.from(modelPath, {
        ticker: app.ticker,
        autoInteract: false,
        autoUpdate: true,
        // 原生 MotionManager 会无间隔循环 Idle；Ema 只调度 Character 明确选定的待机 Motion。
        idleMotionGroup: '__ema_idle_disabled__',
      }).then((loadedModel) => {
        const model = loadedModel as Cubism4Model;
        if (cancelled) {
          model.destroy({ children: true });
          return;
        }

        modelRef.current = model;
        app.stage.addChild(model);
        const initialBindings = resolveLive2DModelBindings(
          model.internalModel,
          bindingsRef.current,
        );
        resolvedBindingsRef.current = initialBindings;

        lipSyncRef.current = attachLive2DLipSync(
          model.internalModel,
          () => resolvedBindingsRef.current?.lipSyncParameters ?? [],
        );
        cleanups.push(() => {
          lipSyncRef.current?.dispose();
          lipSyncRef.current = null;
        });

        lastPointerActivityAtRef.current = performance.now();
        const focusController = model.internalModel.focusController;
        cleanups.push(startLive2DIdleGaze(
          (x, y) => focusController.focus(x, y),
          () => interactiveRef.current
            && !suspendedRef.current
            && performance.now() - lastPointerActivityAtRef.current > POINTER_IDLE_GAZE_MS,
        ));

        const bounds = model.getLocalBounds();
        const modelBounds: Live2DModelBounds = {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        };
        const fit = (): void => applyFraming(app, model, modelBounds);
        fit();
        window.addEventListener('resize', fit);
        cleanups.push(() => window.removeEventListener('resize', fit));

        const followPointer = (event: MouseEvent): void => {
          if (!interactiveRef.current) return;
          lastPointerActivityAtRef.current = performance.now();
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

        expressionsRef.current = extractExpressionNames(model.internalModel);
        expressionIndexRef.current = -1;

        const playIdle = (motion: Live2DMotionReference): void => {
          void model.motion(motion.group, motion.index, MotionPriority.IDLE).catch((error: unknown) => {
            console.warn('[live2d] 待机动作执行失败', motion.group, motion.index, error);
          });
        };
        const firstIdle = initialBindings.idleMotions[0];
        if (firstIdle) playIdle(firstIdle);
        cleanups.push(startLive2DIdleMotionSchedule(
          playIdle,
          () => resolvedBindingsRef.current?.idleMotions ?? [],
          () => !suspendedRef.current && !speakingRef.current,
        ));

        callbacksRef.current.onReady?.({
          hasExpressions: expressionsRef.current.length > 0,
        });
      }).catch((cause: unknown) => {
        if (!cancelled) callbacksRef.current.onError?.(asError(cause));
      });

      return () => {
        cancelled = true;
        for (const cleanup of cleanups.splice(0).reverse()) cleanup();
        expressionsRef.current = [];
        expressionIndexRef.current = -1;
        speakingRef.current = false;
        resolvedBindingsRef.current = null;
        modelRef.current = null;
        appRef.current = null;
        app.destroy(true, { children: true, texture: true, baseTexture: true });
      };
    }, [modelPath]);

    return (
      <div
        ref={hostRef}
        className={className}
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      />
    );
  },
);

function extractExpressionNames(internalModel: Cubism4InternalModel): string[] {
  return (internalModel.settings.expressions ?? [])
    .map((expression) => expression.Name.trim())
    .filter(Boolean);
}

function applyFraming(
  app: PIXI.Application,
  model: Cubism4Model,
  bounds: Live2DModelBounds,
): void {
  const placement = calculateLive2DPlacement({
    width: app.screen.width,
    height: app.screen.height,
  }, bounds);
  if (!placement) return;
  model.scale.set(placement.scale);
  model.x = placement.x;
  model.y = placement.y;
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
