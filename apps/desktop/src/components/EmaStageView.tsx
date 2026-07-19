/**
 * EmaStageView — Live2D model wrapper with SSE event bridge.
 *
 * Listens to Tauri events (emitted by system-sse) for emotion/stage cues
 * and dispatches them to the Live2D model via live2d-react.
 */
import { useEffect, useRef, type JSX } from 'react';
import {
  defaultLive2DRuntime,
  Live2DStage,
  type Live2DModelRuntimeConfig,
  type Live2DRuntime,
  type Live2DStageHandle,
} from '@ema-agent/live2d-react';
import { tauriBridge } from '@ema-agent/desktop-ui';

export interface EmaStageViewProps {
  modelPath: string;
  runtime?: Live2DRuntime;
  /** Live2D runtime config JSON (emotionMap, motionMap, etc.). */
  runtimeConfig?: Live2DModelRuntimeConfig;
}

export function EmaStageView({
  modelPath,
  runtime = defaultLive2DRuntime,
  runtimeConfig,
}: EmaStageViewProps): JSX.Element {
  const stageRef = useRef<Live2DStageHandle>(null);
  const { live2dStore, speechStore } = runtime;

  useEffect(() => {
    const isTargetStage = (stageId?: string): boolean => {
      if (stageId) return stageId === runtime.stageId;
      return runtime.stageId === defaultLive2DRuntime.stageId;
    };

    const applySpeechState = (payload: { speaking: boolean; rms: number }): void => {
      if (!payload.speaking) {
        speechStore.getState().reset();
        return;
      }
      speechStore.getState().setSpeaking(true);
      speechStore.getState().setRms(payload.rms);
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
    const unlistenEmotion = tauriBridge.listen<{ primary: string; stageId?: string }>(
      'stage:emotion-changed',
      (event) => {
        if (!isTargetStage(event.payload.stageId)) return;
        applyEmotion(event.payload.primary);
      },
    );

    // Listen for stage:cue events (motion + expression)
    const unlistenCue = tauriBridge.listen<{
      motion?: string;
      expression?: string;
      stageId?: string;
    }>(
      'stage:cue',
      (event) => {
        if (!isTargetStage(event.payload.stageId)) return;
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
    const unlistenSpeech = tauriBridge.listen<{
      speaking: boolean;
      rms: number;
      stageId?: string;
    }>(
      'stage:speech-state',
      (event) => {
        if (isTargetStage(event.payload.stageId)) applySpeechState(event.payload);
      },
    );

    const speechChannel = typeof BroadcastChannel === 'undefined'
      ? null
      : new BroadcastChannel('ema-stage-speech');
    if (speechChannel) {
      speechChannel.onmessage = (event: MessageEvent<{
        speaking: boolean;
        rms: number;
        stageId?: string;
      }>) => {
        if (isTargetStage(event.data.stageId)) applySpeechState(event.data);
      };
    }

    // Listen for stage:cycle-expression (from FloatingDock):
    // 轮换语义由 store 的 cycleExpression 原子完成, 此处只做 stage 过滤。
    const unlistenCycle = tauriBridge.listen<{ stageId?: string }>(
      'stage:cycle-expression',
      (event) => {
        if (!isTargetStage(event.payload.stageId)) return;
        live2dStore.getState().cycleExpression();
      },
    );

    return () => {
      void unlistenEmotion.then((fn) => fn());
      void unlistenCue.then((fn) => fn());
      void unlistenSpeech.then((fn) => fn());
      void unlistenCycle.then((fn) => fn());
      speechChannel?.close();
    };
  }, [live2dStore, runtime, runtimeConfig, speechStore]);

  return (
    <Live2DStage
      ref={stageRef}
      modelPath={modelPath}
      runtime={runtime}
      runtimeConfig={runtimeConfig ?? undefined}
    />
  );
}
