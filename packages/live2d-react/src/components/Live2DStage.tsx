import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as PIXI from 'pixi.js';
import { Live2DModel as PixiLive2DModel } from 'pixi-live2d-display/cubism4';

import type { Live2DStageHandle, Live2DFraming, Live2DError } from '../types.js';
import { useLive2DStore } from '../stores/live2d-store.js';
import { useExpressionStore } from '../stores/expression-store.js';
import { useSpeechStore } from '../stores/speech-store.js';
import { createMouseEyeTrackPlugin } from '../composables/mouse-track.js';
import { createIdleBeatPlugin } from '../composables/idle-beat.js';
import { createAudioLipSyncPlugin } from '../composables/audio-lipsync.js';
import { startRandomIdleScheduler } from '../composables/random-idle.js';
import { createExpressionController, type CoreModelLike } from '../composables/expression-controller.js';
import {
  createMotionManagerUpdate,
  createAutoEyeBlinkPlugin,
  createExpressionPlugin,
  type InternalModelForPlugins,
} from '../composables/motion-manager.js';
import {
  resolveLive2DModelRuntimeConfig,
  type Live2DModelRuntimeConfig,
} from '../model-config.js';

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
//   5. Subscribes to useLive2DStore for expression / motion intents
//
// Cubism 4 (.moc3) only. Cubism 2 is intentionally not bundled.
//
// PIXI.Application owns a WebGL context. Chrome caps these at ~16 per tab,
// so mount/unmount cycles MUST destroy the app cleanly.

// Register PIXI globally — pixi-live2d-display reads window.PIXI (≥0.5).
(window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI;

export interface Live2DStageProps {
  modelPath: string;
  framing?:  Live2DFraming;
  runtimeConfig?: Live2DModelRuntimeConfig;
  onReady?:  () => void;
  onError?:  (err: Live2DError) => void;
  className?: string;
}

export const Live2DStage = forwardRef<Live2DStageHandle, Live2DStageProps>(
  function Live2DStage(props, ref) {
    const { modelPath, framing = 'halfbody', runtimeConfig, onReady, onError, className } = props;

    const containerRef = useRef<HTMLDivElement | null>(null);
    const appRef       = useRef<PIXI.Application | null>(null);
    const modelRef     = useRef<InstanceType<typeof PixiLive2DModel> | null>(null);
    const callbacksRef = useRef({ onReady, onError, runtimeConfig });
    const [error, setError] = useState<Live2DError | null>(null);

    useEffect(() => {
      callbacksRef.current = { onReady, onError, runtimeConfig };
    }, [onReady, onError, runtimeConfig]);

    useImperativeHandle(ref, () => ({
      setExpression(name) { useLive2DStore.getState().setExpression(name); },
      playMotion(group, index) { useLive2DStore.getState().playMotion(group, index); },
      isReady() { return useLive2DStore.getState().ready; },
    }), []);

    useEffect(() => {
      const host = containerRef.current;
      if (!host) return;
      setError(null);

      if (typeof window.Live2DCubismCore === 'undefined') {
        const err: Live2DError = {
          kind:    'cubism_core_missing',
          message: 'window.Live2DCubismCore not found. Load live2dcubismcore.min.js before React mounts.',
        };
        setError(err);
        callbacksRef.current.onError?.(err);
        return;
      }

      let cancelled = false;
      let app: PIXI.Application | null = null;
      try {
        app = new PIXI.Application({
          resizeTo:        host,
          backgroundAlpha: 0,
          antialias:       true,
        });
      } catch (cause) {
        const err: Live2DError = {
          kind:    'pixi_init_failed',
          message: (cause as Error).message ?? String(cause),
          cause,
        };
        setError(err);
        callbacksRef.current.onError?.(err);
        return;
      }
      appRef.current = app;
      installRenderGuard(app);
      host.appendChild(app.view as HTMLCanvasElement);

      const cleanupTasks: Array<() => void> = [];

      void (async () => {
        try {
          const model = await PixiLive2DModel.from(modelPath, {
            motionPreload: undefined,
            autoInteract:  false,
            autoUpdate:    true,
          });
          if (cancelled || !app) {
            model.destroy({ children: true });
            return;
          }

          app.stage.addChild(model);
          modelRef.current = model;

          // Framing
          const fit = (): void => applyFraming(app!, model, framing);
          fit();
          window.addEventListener('resize', fit);
          cleanupTasks.push(() => window.removeEventListener('resize', fit));

          // ── Wire motion-manager pipeline + plugins ────────────────────
          const internalModel = model.internalModel as unknown as InternalModelForPlugins;
          const coreModel     = internalModel.coreModel as unknown as CoreModelLike;
          const readRuntimeConfig = () =>
            resolveLive2DModelRuntimeConfig(callbacksRef.current.runtimeConfig);
          const runtimeModelId = readRuntimeConfig().modelId;
          const modelIdHint = runtimeModelId === 'unknown' ? deriveModelId(modelPath) : runtimeModelId;

          const expressionController = createExpressionController({
            getCoreModel: () => coreModel,
            modelId:      modelIdHint,
          });
          cleanupTasks.push(() => expressionController.dispose());

          const pipeline = createMotionManagerUpdate({
            internalModel,
            readModelParameters: () => useLive2DStore.getState().modelParameters,
            readFlags: () => {
              const s = useLive2DStore.getState();
              return {
                idleAnimationEnabled:  s.idleAnimationEnabled,
                autoBlinkEnabled:      s.autoBlinkEnabled,
                forceAutoBlinkEnabled: s.forceAutoBlinkEnabled,
              };
            },
          });

          // Pre stage: mouse-track (runs before idle motions, sets eye params)
          const mousePlugin = createMouseEyeTrackPlugin(
            () => appRef.current?.view as HTMLCanvasElement ?? null,
          );
          pipeline.register(mousePlugin, 'pre');
          cleanupTasks.push(() => mousePlugin.dispose());
          // Final stage: idle-beat → auto-blink → expression
          // idle-beat MUST be final-stage — the model's idle.motion3.json
          // already animates ParamBodyAngle + ParamBreath. If we set them in
          // the pre stage, the original motionManager.update overwrites ours.
          // Final stage runs AFTER the original update, so our values win.
          pipeline.register(
            createIdleBeatPlugin(
              () => useLive2DStore.getState().idleBeatEnabled,
              () => readRuntimeConfig().parameters,
              () => readRuntimeConfig().idleBeat,
            ),
            'final',
          );
          pipeline.register(
            createAutoEyeBlinkPlugin({
              readExpressionEnabled: () => useLive2DStore.getState().expressionEnabled,
            }),
            'final',
          );
          pipeline.register(createExpressionPlugin(expressionController), 'final');
          // Audio-lip-sync: reads speech-store RMS, drives ParamMouthOpenY.
          // Runs AFTER expression so mouth shape overlays on top of any
          // active expression (e.g. smile + talking at the same time).
          pipeline.register(createAudioLipSyncPlugin(() => readRuntimeConfig().parameters), 'final');

          // Hook the motionManager.update method. We capture the original so
          // the pipeline can call back into it when no plugin handles the frame.
          const mm = internalModel.motionManager;
          const originalUpdate = mm.update.bind(mm);
          (mm as unknown as { update: typeof mm.update }).update = (m, now) =>
            pipeline.hookUpdate(m, now, originalUpdate);
          cleanupTasks.push(() => {
            (mm as unknown as { update: typeof mm.update }).update = originalUpdate;
          });

          // ── Parse exp3 files + populate expression store ──────────────
          const baseUrl = new URL('.', new URL(modelPath, window.location.href)).href;
          const expressionRefs = extractExpressionRefs(model);
          await expressionController.initialise(
            expressionRefs,
            async (path) => {
              const res = await fetch(path);
              if (!res.ok) throw new Error(`fetch ${path}: ${res.status}`);
              return res.text();
            },
            baseUrl,
          );

          // ── Publish discovered state to store ─────────────────────────
          const store = useLive2DStore;
          store.getState()._setExpressionsAvailable(extractExpressionNames(model));
          store.getState()._setMotionsAvailable(extractMotionGroups(model));
          store.getState()._setReady(true);

          // Subscribe to motion changes (expression now flows through plugin)
          const unsubMotion = store.subscribe((s, prev) => {
            if (s.currentMotion?.requestId !== prev.currentMotion?.requestId && s.currentMotion) {
              void model.motion(s.currentMotion.group, s.currentMotion.index);
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
            const prevByName = new Map(prev.activeExpressions.map((intent) => [intent.name, intent]));
            const nextByName = new Map(s.activeExpressions.map((intent) => [intent.name, intent]));

            const removed = prev.activeExpressions.filter((intent) => !nextByName.has(intent.name));
            const changed = s.activeExpressions.filter((intent) => {
              const before = prevByName.get(intent.name);
              return !before || before.requestId !== intent.requestId;
            });

            if (changed.length === 0 && removed.length === 0) return;

            for (const intent of removed) {
              useExpressionStore.getState().deactivate(intent.name);
            }
            for (const intent of changed) {
              // durationSec is owned by live2dStore timers — do not pass it here.
              useExpressionStore.getState().set(intent.name, intent.value);
            }
          });
          cleanupTasks.push(unsubExpr);

          const runtime = readRuntimeConfig();

          // Best-effort idle motion
          for (const candidate of [runtime.randomIdle.group, 'Idle', 'idle', '']) {
            try { await model.motion(candidate); break; }
            catch { /* try next */ }
          }

          // Start random idle motion scheduler (configurable, skips when speaking)
          const idleMotionCount = (extractMotionGroups(model)[runtime.randomIdle.group] ?? 0) as number;
          const stopIdleScheduler = startRandomIdleScheduler({
            playMotion: (group, index) => { void model.motion(group, index); },
            motionCount: idleMotionCount,
            group: runtime.randomIdle.group,
            minDelayMs: runtime.randomIdle.minDelayMs,
            maxDelayMs: runtime.randomIdle.maxDelayMs,
            readEnabled: () => {
              const live2d = useLive2DStore.getState();
              return live2d.idleAnimationEnabled && !useSpeechStore.getState().speaking;
            },
          });
          cleanupTasks.push(stopIdleScheduler);

          callbacksRef.current.onReady?.();
        } catch (cause) {
          if (cancelled) return;
          const err: Live2DError = {
            kind:    'model_load_failed',
            message: (cause as Error).message ?? String(cause),
            cause,
          };
          setError(err);
          callbacksRef.current.onError?.(err);
        }
      })();

      return () => {
        cancelled = true;
        for (const off of cleanupTasks) {
          try { off(); } catch { /* ignore */ }
        }
        if (modelRef.current) {
          modelRef.current.destroy({ children: true });
          modelRef.current = null;
        }
        if (appRef.current) {
          appRef.current.destroy(true, { children: true, texture: true, baseTexture: true });
          appRef.current = null;
        }
        useLive2DStore.getState().reset();
      };
    }, [modelPath, framing]);

    return (
      <div
        ref={containerRef}
        className={className}
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      >
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

function installRenderGuard(app: PIXI.Application): void {
  const guarded = (): void => {
    try { app.render(); }
    catch (err) {
      // eslint-disable-next-line no-console
      console.error('[Live2D] pixi render error — frame skipped:', err);
    }
  };
  app.ticker.remove(app.render, app);
  app.ticker.add(guarded);
}

function applyFraming(
  app:     PIXI.Application,
  model:   InstanceType<typeof PixiLive2DModel>,
  framing: Live2DFraming,
): void {
  const w = app.renderer.width;
  const h = app.renderer.height;

  if (framing === 'halfbody') {
    const scale = (w / model.width) * 1.55;
    model.scale.set(scale);
    model.x = (w - model.width) / 2;
    model.y = -model.height * 0.05;
  } else {
    const scale = Math.min(w / model.width, h / model.height) * 0.95;
    model.scale.set(scale);
    model.x = (w - model.width) / 2;
    model.y = h - model.height - 12;
  }
}

function extractExpressionNames(model: InstanceType<typeof PixiLive2DModel>): string[] {
  const s = (model.internalModel as unknown as { settings?: { expressions?: Array<{ Name?: string }> } }).settings;
  return (s?.expressions ?? []).map((e) => e.Name ?? '').filter((n) => n.length > 0);
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

// ── No bridge needed — Live2DStage directly calls expressionStore.getState()
//    inside the activeExpressions subscription above. The old
//    useExpressionStoreSet / useExpressionStoreReset helpers are removed.
