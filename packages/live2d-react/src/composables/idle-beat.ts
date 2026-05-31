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

const SWAY_AMP = 15;
const SWAY_FREQ_X = 0.8;
const SWAY_FREQ_Y = 0.56;
const SWAY_FREQ_Z = 0.62;
const BREATH_FREQ = 0.6;

export function createIdleBeatPlugin(
  readEnabled: () => boolean,
): MotionPlugin {
  let elapsed = 0;

  return (ctx) => {
    if (!readEnabled()) { elapsed = 0; return; }

    elapsed += ctx.timeDelta;

    const swayX = SWAY_AMP * Math.sin(elapsed * SWAY_FREQ_X);
    const swayY = SWAY_AMP * 0.5 * Math.sin(elapsed * SWAY_FREQ_Y);
    const swayZ = SWAY_AMP * 0.3 * Math.sin(elapsed * SWAY_FREQ_Z);
    const breath = (Math.sin(elapsed * BREATH_FREQ) + 1) * 0.5;

    ctx.model.setParameterValueById('Param85', Math.max(-30, Math.min(30, swayX)));
    ctx.model.setParameterValueById('Param86', Math.max(-30, Math.min(30, swayY)));
    ctx.model.setParameterValueById('Param87', Math.max(-30, Math.min(30, swayZ)));
    ctx.model.setParameterValueById('ParamBreath', breath);
  };
}
