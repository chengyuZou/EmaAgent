# Live2D React

[中文](./README-zh.md)

This package loads a Character's Cubism 4 model ZIP into a React/PIXI stage. The host supplies the archive, placement, pointer input and normalized mouth opening, then uses the stage handle to select expressions and play motions.

```tsx
<Live2DStage
  ref={stageRef}
  modelArchive={archiveBlob}
  stageScale={resource.stageScale}
  stageOffsetX={resource.stageOffsetX}
  stageOffsetY={resource.stageOffsetY}
  suspended={windowHidden}
  onReady={handleReady}
  onError={handleLoadFailure}
/>
```

Load the licensed Cubism Core into `window.Live2DCubismCore` before mounting. The desktop host is [CharacterStage.tsx](../../apps/desktop/src/stage/CharacterStage.tsx). Model configuration previews also use `loadLive2DArchive`.

## Loading and lifetime

The component keeps one PIXI application and canvas for its mounted lifetime. `live2dArchive.ts` registers the JSZip callbacks used by the library's ZipLoader. Internal paths become blob URLs, allowing the model settings to load textures, motions and expressions from the archive.

The stage imports `@pixi/unsafe-eval`, which replaces Pixi's generated shader-uniform functions so JavaScript `unsafe-eval` is not needed. Keep this module aligned with the Pixi version. The host's Content Security Policy must allow `blob:` in `connect-src` for archive resources and in `img-src` for textures, as well as WebAssembly compilation for Cubism Core.

A new model loads while the current one remains visible. Only the latest completed load is mounted; stale completions are destroyed. Switching models removes old listeners and lip-sync bindings. Unmounting destroys the application and model resources.

The application's ticker drives model updates. `suspended` stops it; resuming renders a frame and restarts it. Loading and render failures reach `onError`. A render failure stops the ticker until the host remounts the stage; showing the window again does not restart a failed renderer. Individual expression/motion failures are logged without discarding the model. The optional `onDiagnostic` callback reports canvas, loading and ticker events to the host.

## Placement and controls

The default framing uses model bounds to show the upper body. Scale multiplies the base fit. X/Y offsets are fractions of stage width/height applied to the full model; they can move initially cropped content into view.

The ref handle exposes `setExpression(name | null)`, `playMotion(group, index)`, `setPlacement`, `setLipSync` and `setPointerPosition`. Null expression resets to the model's default. Manual motions use the library's FORCE priority; native idle playback is handled by its MotionManager.

`pointerSource` defaults to `window` mouse events. With `host`, the host calls `setPointerPosition` using CSS coordinates relative to the window content, including coordinates outside its bounds. The stage converts through the canvas rectangle without clamping to its edges. Repeated identical coordinates do not count as activity. After 1 second without movement, an independent timer may update the same FocusController target for idle gaze. Suspended or noninteractive stages skip pointer/idle updates.

## Lip sync

`mouthOpen` is a host-supplied value from 0 to 1. Only IDs registered in the model's LipSync group and present in Cubism Core are bound, using each parameter's actual range.

The `beforeModelUpdate` listener smooths values while speaking. After speech stops, it closes and holds the mouth for about 700 ms of frame updates, then stops writing parameters so Motion and Expression can control them again. The host owns audio playback and analysis.

## Checking

`tests/` covers framing, real parameter binding, lip-sync transitions and idle gaze. Run `pnpm --filter @ema-agent/live2d-react test`. The [Desktop browser regression](../../apps/desktop/README.md#verify-changes) also loads the bundled model under the release CSP and checks for a visible frame. Native window interaction and visual motion still need desktop checks.
