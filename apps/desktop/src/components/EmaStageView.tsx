// 连接桌面系统事件与 Live2D 舞台，把情绪、动作、语音及暂停状态送入角色实例。
import { useEffect, useRef, type JSX } from 'react';
import {
  defaultLive2DRuntime,
  Live2DStage,
  type Live2DModelRuntimeConfig,
  type Live2DError,
  type Live2DRuntime,
  type Live2DStageHandle,
} from '@ema-agent/live2d-react';
import { tauriBridge } from '@ema-agent/desktop-ui';

export interface EmaStageViewProps {
  modelPath: string;
  runtime?: Live2DRuntime;
  /** Live2D 的情绪与动作映射运行配置。 */
  runtimeConfig?: Live2DModelRuntimeConfig;
  suspended?: boolean;
  interactive?: boolean;
  onReady?: () => void;
  onError?: (error: Live2DError) => void;
}

export function EmaStageView({
  modelPath,
  runtime = defaultLive2DRuntime,
  runtimeConfig,
  suspended = false,
  interactive = true,
  onReady,
  onError,
}: EmaStageViewProps): JSX.Element {
  const stageRef = useRef<Live2DStageHandle>(null);
  const { live2dStore, speechStore } = runtime;

  useEffect(() => {
    if (!interactive) return;

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

    // 接收系统事件流投递的角色情绪变化。
    const unlistenEmotion = tauriBridge.listen<{ primary: string; stageId?: string }>(
      'stage:emotion-changed',
      (event) => {
        if (!isTargetStage(event.payload.stageId)) return;
        applyEmotion(event.payload.primary);
      },
    );

    // 舞台提示可以同时携带动作与表情。
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

    // TTS 播放可能位于聊天 WebView，需要把 RMS 桥接到主窗口自己的语音状态。
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

    // FloatingDock 只发出轮换意图，具体状态仍由舞台 Store 原子更新：
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
  }, [interactive, live2dStore, runtime, runtimeConfig, speechStore]);

  return (
    <Live2DStage
      ref={stageRef}
      modelPath={modelPath}
      runtime={runtime}
      runtimeConfig={runtimeConfig ?? undefined}
      suspended={suspended}
      onReady={onReady}
      onError={onError}
    />
  );
}
