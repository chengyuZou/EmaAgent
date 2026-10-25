# Live2D React

[中文](./README-zh.md)

This package loads a Character's Cubism model3 ZIP into a React/Pixi stage. It uses Pixi 8.21, `@laplace.live/pixijs-live2d` and WebGL2, including the MOC 6 drawing paths. The host supplies the archive, placement, pointer input and normalized mouth opening, then uses the stage handle to select expressions and play motions.

```tsx
<Live2DStage
  ref={stageRef}
  modelArchive={archiveBlob}
  stageScale={resource.stageScale}
  stageOffsetX={resource.stageOffsetX}
  stageOffsetY={resource.stageOffsetY}
  onReady={handleReady}
  onError={handleLoadFailure}
/>
```

Load the licensed Cubism Core `06.00.0001` into `window.Live2DCubismCore` before importing this package. The desktop host is [CharacterStage.tsx](../../apps/desktop/src/stage/CharacterStage.tsx). Model configuration previews also use `loadLive2DArchive`.

## Loading and lifetime

The component initializes one Pixi application asynchronously and keeps its canvas for the mounted lifetime. `live2dArchive.ts` extracts ZIP entries with JSZip and preserves their archive paths in `File.webkitRelativePath`. The library's FileLoader resolves model3 references to blob URLs, including nested folders and non-ASCII names.

The stage imports `pixi.js/unsafe-eval`, which replaces Pixi's generated shader-uniform functions so JavaScript `unsafe-eval` is not needed. The host's Content Security Policy must allow `blob:` in `connect-src` for archive resources and in `img-src` for textures, as well as WebAssembly compilation for Cubism Core.

The [renderer dependency patch](../../patches/@laplace.live__pixijs-live2d@0.6.1.patch) selects the image parser for extensionless blob URLs and releases FileLoader resources when setup fails before an internal model exists. Failed archive setup destroys the partial model and reports the original error. Successful teardown releases Pixi textures before revoking archive URLs, and removes model ticker listeners before destroying the application ticker.

A new model loads while the current one remains visible. Only the latest completed load is mounted; stale completions are destroyed. Switching models removes old listeners and lip-sync bindings. Unmounting destroys the application and model resources.

`onReady` runs after the mounted model's first successful render. The host can keep its loading indicator visible until then.

The application's ticker drives model updates. Window visibility and minimization do not stop it in application code. The WebView and operating system may still throttle background frame delivery. Loading and render failures reach `onError`. A render failure stops the ticker until the host remounts the stage; showing the window again does not restart a failed renderer. Individual expression/motion failures are logged without discarding the model. The optional `onDiagnostic` callback reports canvas, loading and ticker events to the host.

## Placement and controls

The default framing uses model bounds to show the upper body. Scale multiplies the base fit. X/Y offsets are fractions of stage width/height applied to the full model; they can move initially cropped content into view.

The ref handle exposes `setExpression(name | null)`, `playMotion(group, index)`, `setPlacement`, `setLipSync` and `setPointerPosition`. Expression selection clears the previous selection; null clears it without saving an expression for later restoration. Manual motions use the library's FORCE priority; native idle playback is handled by its MotionManager.

The renderer dependency patch applies expressions after automatic blinking so expressions that close the eyes retain their values. Model-setting covers render directly to a 3072x4096 PNG before transparent-edge cropping.

`pointerSource` defaults to `window` mouse events. With `host`, the host calls `setPointerPosition` using CSS coordinates relative to the window content, including coordinates outside its bounds. The stage converts through the canvas rectangle without clamping to its edges. Repeated identical coordinates do not count as activity. After 1 second without movement, an independent timer may update the same FocusController target for idle gaze. Noninteractive stages skip pointer/idle updates.

## Lip sync

`mouthOpen` is a host-supplied value from 0 to 1. Only IDs registered in the model's LipSync group and present in Cubism Core are bound, using each parameter's actual range.

The `beforeModelUpdate` listener smooths values while speaking. After speech stops, it closes and holds the mouth for about 700 ms of frame updates, then stops writing parameters so Motion and Expression can control them again. The host owns audio playback and analysis.

## Checking

`tests/` covers framing, real parameter binding, lip-sync transitions and idle gaze. Run `pnpm --filter @ema-agent/live2d-react test`. The [Desktop browser regression](../../apps/desktop/README.md#verify-changes) checks preview pixels, stage rendering, motions, expression replacement, mouth updates and resource cleanup under the release CSP. It can also check the Hiyori, Haru, Wanko and Ren sample folders. Native window interaction still needs desktop checks.
