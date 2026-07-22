// ── IdleBeatPlugin ───────────────────────────────────────────────────────────
//
// Final-stage pipeline plugin. Drives body sway + breathing via the model's
// physics engine input parameters (Param85/86/87), matching the v0.4 system.
//
// Param85/86/87 are VTube Studio input parameters. The model's physics3.json
// maps them to actual bone rotations (ParamAngleX/Y/Z, ParamBodyAngleX/Y/Z)
// every frame during physics.evaluate(). Setting ParamBodyAngle directly
// does NOT work — the physics engine overwrites it.
//
// Ranges match the v0.4 live2d-viewer.html ticker:
//   Param85/86/87: ±30 (clamped)
//   ParamBreath: 0–1

import type { MotionPlugin } from './motion-manager.js';
import type { Live2DIdleBeatRuntimeConfig, Live2DParameterRuntimeConfig } from '../model-config.js';

export function createIdleBeatPlugin(
  readEnabled: () => boolean,
  readParameters: () => Live2DParameterRuntimeConfig,
  readIdleBeat: () => Live2DIdleBeatRuntimeConfig,
): MotionPlugin {
  let activeElapsedMs = 0;

  return (ctx) => {
    if (!readEnabled()) return;

    activeElapsedMs += ctx.timing.deltaMs;
    const elapsedSec = activeElapsedMs / 1_000;

    const params = readParameters();
    const idle = readIdleBeat();
    const swayX = idle.swayAmplitude * Math.sin(elapsedSec * idle.swayFrequencyX);
    const swayY = idle.swayAmplitude * 0.5 * Math.sin(elapsedSec * idle.swayFrequencyY);
    const swayZ = idle.swayAmplitude * 0.3 * Math.sin(elapsedSec * idle.swayFrequencyZ);
    const breath = (Math.sin(elapsedSec * idle.breathFrequency) + 1) * 0.5;

    ctx.model.setParameterValueById(params.headInputX, Math.max(-30, Math.min(30, swayX)));
    ctx.model.setParameterValueById(params.headInputY, Math.max(-30, Math.min(30, swayY)));
    ctx.model.setParameterValueById(params.headInputZ, Math.max(-30, Math.min(30, swayZ)));
    ctx.model.setParameterValueById(params.breathParam, breath);
  };
}
