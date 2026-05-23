/**
 * EmaStageView — Live2D model wrapper with SSE event bridge.
 *
 * Listens to Tauri events (emitted by system-sse) for emotion/stage cues
 * and dispatches them to the Live2D model.
 *
 * Lives in apps/desktop because it imports the local Live2DStage component.
 */
import { useEffect, useRef, type JSX } from 'react';
import { Live2DStage, type Live2DStageHandle } from './Live2DStage.js';
import { tauriBridge } from '@ema-agent/desktop-ui';

export interface EmaStageViewProps {
  modelPath?: string;
}

export function EmaStageView({ modelPath = '/live2d/ema/ema.model3.json' }: EmaStageViewProps): JSX.Element {
  const stageRef = useRef<Live2DStageHandle>(null);

  useEffect(() => {
    // Listen for stage:emotion-changed events from system-sse
    const unlistenEmotion = tauriBridge.listen<{ primary: string }>(
      'stage:emotion-changed',
      (event) => {
        stageRef.current?.setExpression(event.payload.primary);
      },
    );

    // Listen for stage:cue events (motion + expression)
    const unlistenCue = tauriBridge.listen<{ motion?: string; expression?: string }>(
      'stage:cue',
      (event) => {
        if (event.payload.expression) {
          stageRef.current?.setExpression(event.payload.expression);
        }
        if (event.payload.motion) {
          stageRef.current?.playMotion(event.payload.motion);
        }
      },
    );

    // Listen for stage:cycle-expression (from FloatingDock)
    const unlistenCycle = tauriBridge.listen<{}>(
      'stage:cycle-expression',
      () => {
        stageRef.current?.cycleExpression();
      },
    );

    return () => {
      void unlistenEmotion.then((fn) => fn());
      void unlistenCue.then((fn) => fn());
      void unlistenCycle.then((fn) => fn());
    };
  }, []);

  return <Live2DStage ref={stageRef} modelPath={modelPath} />;
}
