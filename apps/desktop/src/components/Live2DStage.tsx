import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as PIXI from 'pixi.js';
import { Live2DModel } from 'pixi-live2d-display/cubism4';

// ── Live2D stage component ─────────────────────────────────────────────────
//
// One PIXI Application per stage instance, transparent background. The model
// is centered and scaled to fit the parent container. Idle motion auto-plays
// after `motionPreload: 'IDLE'`.
//
// Cubism 2 models are NOT supported — we import the cubism4-only build so
// our bundle doesn't pull the Cubism 2 SDK. Ema is Cubism 4 (.moc3).
//
// Cleanup is critical: PIXI.Application owns a WebGL context. Forgetting to
// destroy() on unmount leaks GL contexts (Chrome limits to ~16 per tab).

// Register PIXI globally so pixi-live2d-display can reach Ticker etc.
// Required since v0.5 of the library — they read `window.PIXI`.
(window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI;

export interface Live2DStageHandle {
  /** Trigger an expression by file name (without .exp3.json suffix). */
  setExpression: (name: string) => void;
  /** Play one motion from a group (defaults to random in group). */
  playMotion: (group: string, index?: number) => void;
  /** Cycle to the next expression in the model's expression list. */
  cycleExpression: () => void;
  /** Returns true if the model has finished loading. */
  isReady: () => boolean;
}

export interface Live2DStageProps {
  /** Absolute URL or root-relative path to the .model3.json file. */
  modelPath: string;
  /** Optional callback when the model has loaded + first frame rendered. */
  onReady?: () => void;
  /** Optional callback for load errors. */
  onError?: (err: Error) => void;
}

export const Live2DStage = forwardRef<Live2DStageHandle, Live2DStageProps>(
  function Live2DStage({ modelPath, onReady, onError }, ref) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const appRef       = useRef<PIXI.Application | null>(null);
    const modelRef     = useRef<Live2DModel | null>(null);
    const [error, setError] = useState<string | null>(null);

    useImperativeHandle(ref, () => ({
      setExpression(name) { modelRef.current?.expression(name); },
      playMotion(group, index) { void modelRef.current?.motion(group, index); },
      cycleExpression() {
        const m = modelRef.current;
        if (!m) return;
        const exps = (m as unknown as { expressions?: Map<string, unknown> }).expressions;
        if (!exps || exps.size === 0) return;
        const keys = Array.from(exps.keys());
        const name = keys[Math.floor(Math.random() * keys.length)];
        m.expression(name!);
      },
      isReady() { return modelRef.current !== null; },
    }), []);

    useEffect(() => {
      const host = containerRef.current;
      if (!host) return;

      let cancelled = false;
      const app = new PIXI.Application({
        resizeTo:        host,
        backgroundAlpha: 0,
        antialias:       true,
        // Pixi 7 has autoStart=true default; ticker drives motion playback.
      });
      appRef.current = app;

      // Pixi 7 returns an HTMLCanvasElement on app.view. Append to DOM.
      host.appendChild(app.view as HTMLCanvasElement);

      void (async () => {
        try {
          const model = await Live2DModel.from(modelPath, {
            // motionPreload: load first frame of each motion eagerly so the
            // first user-triggered motion doesn't stutter.
            motionPreload:   undefined,
            autoInteract:    false,   // we manage mouse passthrough ourselves
            autoUpdate:      true,
          });
          if (cancelled) {
            model.destroy({ children: true });
            return;
          }

          app.stage.addChild(model);
          modelRef.current = model;

          // Half-body framing — only the head + shoulders visible. The model
          // is sized so the top of its bounding box lines up with the top of
          // the window, then we let the bottom flow off-screen. This matches
          // AIRI's overlay pet look (not standing on a virtual floor).
          //
          // Scale strategy: fit width × 1.55 — wide enough that hair flows
          // out of the frame, body cut at roughly mid-torso.
          const fit = (): void => {
            const w = app.renderer.width;
            const h = app.renderer.height;
            const scale = (w / model.width) * 1.55;
            model.scale.set(scale);
            model.x = (w - model.width) / 2;
            // Negative offset so head touches the top edge, torso fills middle
            model.y = -model.height * 0.05;
            // Keep position even when window resizes
            void h;
          };
          fit();
          window.addEventListener('resize', fit);

          // Idle motion. Cubism 4 models conventionally have an "Idle" group.
          // Ema's idle.motion3.json doesn't expose a group name — try fallback.
          for (const candidate of ['Idle', 'idle', '']) {
            try { await model.motion(candidate); break; }
            catch { /* try next */ }
          }

          onReady?.();
        } catch (err) {
          if (cancelled) return;
          const message = (err as Error).message ?? String(err);
          setError(message);
          onError?.(err as Error);
        }
      })();

      return () => {
        cancelled = true;
        if (modelRef.current) {
          modelRef.current.destroy({ children: true });
          modelRef.current = null;
        }
        if (appRef.current) {
          appRef.current.destroy(true, { children: true, texture: true, baseTexture: true });
          appRef.current = null;
        }
      };
    }, [modelPath, onReady, onError]);

    return (
      <div ref={containerRef} style={containerStyle}>
        {error && <div style={errorStyle}>Live2D load failed: {error}</div>}
      </div>
    );
  },
);

const containerStyle: React.CSSProperties = {
  position: 'absolute',
  inset:    0,
  // Let the drag region underneath receive mouse events. Pixi canvas itself
  // doesn't need interaction (no click-to-interact yet) and the dock/badge
  // are higher z-index siblings that opt-out of drag.
  pointerEvents: 'none',
  zIndex:        2,
};

const errorStyle: React.CSSProperties = {
  position:   'absolute',
  bottom:     20,
  left:       20,
  right:      20,
  padding:    '8px 12px',
  background: 'rgba(220, 50, 50, 0.85)',
  borderRadius: 6,
  fontSize:    12,
};
