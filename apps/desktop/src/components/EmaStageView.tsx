/**
 * EmaStageView — Live2D model wrapper with SSE event bridge.
 *
 * Listens to Tauri events (emitted by system-sse) for emotion/stage cues
 * and dispatches them to the Live2D model via live2d-react.
 */
import { useEffect, useRef, type JSX } from 'react';
import {
  Live2DStage,
  useLive2DStore,
  useSpeechStore,
  type Live2DModelRuntimeConfig,
  type Live2DStageHandle,
} from '@ema-agent/live2d-react';
import { tauriBridge } from '@ema-agent/desktop-ui';

export interface EmaStageViewProps {
  modelPath: string;
  /** Live2D runtime config JSON (emotionMap, motionMap, etc.). */
  runtimeConfig?: Live2DModelRuntimeConfig;
}

export function EmaStageView({ modelPath, runtimeConfig }: EmaStageViewProps): JSX.Element {
  const stageRef = useRef<Live2DStageHandle>(null);


  useEffect(() => {
    const applySpeechState = (payload: { speaking: boolean; rms: number }): void => {
      if (!payload.speaking) {
        useSpeechStore.getState().reset();
        return;
      }
      useSpeechStore.getState().setSpeaking(true);
      useSpeechStore.getState().setRms(payload.rms);
    };

    const applyEmotion = (primary: string): void => {
      const target = runtimeConfig?.emotionMap?.[primary];
      if (target?.expression) {
        stageRef.current?.setExpression(target.expression);
      } else {
        stageRef.current?.setExpression(null);
      }
      if (target?.motion) {
        stageRef.current?.playMotion(target.motion.group, target.motion.index);
      }
    };

    const applyMotion = (motion: string): void => {
      const target = runtimeConfig?.motionMap?.[motion];
      if (!target) return;
      stageRef.current?.playMotion(target.group, target.index);
    };

    // Listen for stage:emotion-changed events from system-sse
    const unlistenEmotion = tauriBridge.listen<{ primary: string }>(
      'stage:emotion-changed',
      (event) => {
        applyEmotion(event.payload.primary);
      },
    );

    // Listen for stage:cue events (motion + expression)
    const unlistenCue = tauriBridge.listen<{ motion?: string; expression?: string }>(
      'stage:cue',
      (event) => {
        if (event.payload.expression) {
          const target = runtimeConfig?.emotionMap?.[event.payload.expression];
          stageRef.current?.setExpression(target?.expression ?? event.payload.expression);
        }
        if (event.payload.motion) {
          applyMotion(event.payload.motion);
        }
      },
    );

    // Speech RMS can originate in another webview (chat.html owns TTS
    // playback), so bridge it into the stage window's own speech store.
    const unlistenSpeech = tauriBridge.listen<{ speaking: boolean; rms: number }>(
      'stage:speech-state',
      (event) => applySpeechState(event.payload),
    );

    const speechChannel = typeof BroadcastChannel === 'undefined'
      ? null
      : new BroadcastChannel('ema-stage-speech');
    if (speechChannel) {
      speechChannel.onmessage = (event: MessageEvent<{ speaking: boolean; rms: number }>) => {
        applySpeechState(event.data);
      };
    }

    // Listen for stage:cycle-expression (from FloatingDock)
    // live2d-react handle doesn't expose cycleExpression — use store directly.
    const unlistenCycle = tauriBridge.listen<{}>(
      'stage:cycle-expression',
      () => {
        const store = useLive2DStore.getState();
        const exps = store.availableExpressions;
        if (exps.length === 0) return;
        // Clear current and pick next in rotation (or random if only one).
        store.clearExpressions();
        if (exps.length === 1) {
          store.addExpression(exps[0]!, { source: 'ui' });
        } else {
          const current = store.activeExpressions[0]?.name;
          const idx = current ? exps.indexOf(current) : -1;
          const next = exps[(idx + 1) % exps.length]!;
          store.addExpression(next, { source: 'ui' });
        }
      },
    );

    return () => {
      void unlistenEmotion.then((fn) => fn());
      void unlistenCue.then((fn) => fn());
      void unlistenSpeech.then((fn) => fn());
      void unlistenCycle.then((fn) => fn());
      speechChannel?.close();
    };
  }, [runtimeConfig]);

  return (
    <Live2DStage
      ref={stageRef}
      modelPath={modelPath}
      runtimeConfig={runtimeConfig ?? undefined}
    />
  );
}
