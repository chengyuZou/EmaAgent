# 0.1.0-alpha.1

## Problem and reproduction

The character rendered in development but not in the Windows release build, including after restarting. The stage window and its controls were present, while the model was invisible.

Loading the bundled model with the actual `Live2DStage` under the release content security policy reproduced a Pixi initialization error about `unsafe-eval`. Temporarily allowing JavaScript evaluation exposed a second failure: requests for archive resources with `blob:` URLs were rejected by `connect-src`.

## Confirmed cause

Pixi 7's default shader-uniform implementation generates JavaScript functions. The release policy allows WebAssembly compilation for Cubism Core but not JavaScript evaluation. These are different permissions, so allowing WebAssembly did not make Pixi's generated functions work.

The ZIP loader also turns model files into `blob:` URLs. `img-src` already allowed blob textures, but `connect-src` did not allow the model loader's blob requests. Fixing only the Pixi initialization error left model loading blocked.

## Change

- [Live2DStage](../../src/live2d-react/Live2DStage.tsx) imports the matching `@pixi/unsafe-eval` module. Despite its name, this module replaces generated uniform functions with an implementation that works without JavaScript evaluation.
- [Tauri's CSP](../../apps/desktop/src-tauri/tauri.conf.json) allows `blob:` in `connect-src`. JavaScript `unsafe-eval` remains disabled.
- [CharacterStage](../../apps/desktop/src/stage/CharacterStage.tsx) displays archive, initialization, and render failures using the shared Callout and Button. Reloading fetches the archive again and creates a new renderer. Late failures from an old archive request are ignored.
- A render failure stops the ticker and reaches `onError`. Resuming the window does not restart a failed renderer.

## Verification

`pnpm --filter @ema-agent/desktop test:live2d-release` reproduced the original initialization failure before the fix. After the fix it loaded the real model under the release CSP, reached the first tick, and found visible model pixels rather than an empty canvas.

Desktop tests cover visible errors, retry, and stale archive failures. Live2D tests cover ticker and resume-frame failures. Frontend production and native release builds completed. An isolated native check also reached model loading and error/retry without uncaught page errors, but the complete installed-app acceptance check has not passed.

Still to confirm with the rebuilt installer: the model is visible on first launch and a second launch, and reload restores it after a recoverable model-loading failure.
