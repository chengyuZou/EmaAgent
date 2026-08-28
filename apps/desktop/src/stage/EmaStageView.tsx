// 把桌面事件中的角色语义映射为当前 Live2D 舞台的原生命令。

import { useCallback, useEffect, useRef, type JSX } from 'react';
import {
  Live2DStage,
  type Live2DStageHandle,
  type Live2DStageReadyInfo,
} from '@ema-agent/live2d-react';
import { showToast } from '../lib/toast.js';
import { tauriBridge } from '../lib/tauri-bridge.js';
import type { CharacterLive2dRuntimeConfig } from './characterStageLoader.js';

export interface EmaStageViewProps {
  modelPath: string;
  runtimeConfig?: CharacterLive2dRuntimeConfig;
  suspended?: boolean;
  interactive?: boolean;
  onHandleChanged?: (handle: Live2DStageHandle | null) => void;
  onReady?: (info: Live2DStageReadyInfo) => void;
  onError?: (error: Error) => void;
}

export function EmaStageView({
  modelPath,
  runtimeConfig,
  suspended = false,
  interactive = true,
  onHandleChanged,
  onReady,
  onError,
}: EmaStageViewProps): JSX.Element {
  const stageRef = useRef<Live2DStageHandle | null>(null);
  const setStageHandle = useCallback((handle: Live2DStageHandle | null): void => {
    stageRef.current = handle;
    onHandleChanged?.(handle);
  }, [onHandleChanged]);

  useEffect(() => {
    if (!interactive) return;

    const isTargetStage = (stageId?: string): boolean => !stageId || stageId === 'main';
    const applyEmotion = (name: string): void => {
      const target = runtimeConfig?.emotionMap?.[name];
      stageRef.current?.setExpression(target?.expression ?? null);
      if (target?.motion) {
        stageRef.current?.playMotion(target.motion.group, target.motion.index);
      }
    };
    const applyMotion = (name: string): void => {
      const target = runtimeConfig?.motionMap?.[name];
      if (target) stageRef.current?.playMotion(target.group, target.index);
    };

    const unlistenEmotion = tauriBridge.listen<{ primary: string; stageId?: string }>(
      'stage:emotion-changed',
      (event) => {
        if (isTargetStage(event.payload.stageId)) applyEmotion(event.payload.primary);
      },
    );
    const unlistenCue = tauriBridge.listen<{
      motion?: string;
      expression?: string;
      stageId?: string;
    }>('stage:cue', (event) => {
      if (!isTargetStage(event.payload.stageId)) return;
      if (event.payload.expression) {
        // cue 携带的是 emotionMap 语义名；miss 等于幻觉名，不执行
        const target = runtimeConfig?.emotionMap?.[event.payload.expression];
        if (target) stageRef.current?.setExpression(target.expression ?? null);
      }
      if (event.payload.motion) applyMotion(event.payload.motion);
    });
    const unlistenSpeech = tauriBridge.listen<{
      speaking: boolean;
      rms: number;
      stageId?: string;
    }>('stage:speech-state', (event) => {
      if (isTargetStage(event.payload.stageId)) {
        stageRef.current?.setLipSync(event.payload.speaking, event.payload.rms);
      }
    });
    const unlistenCycle = tauriBridge.listen<{ stageId?: string }>(
      'stage:cycle-expression',
      (event) => {
        if (!isTargetStage(event.payload.stageId)) return;
        const expression = stageRef.current?.cycleExpression();
        if (expression) {
          showToast(`已切换 Live2D 表情：${expression}`, {
            variant: 'info',
            duration: 1800,
          });
        }
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
        if (isTargetStage(event.data.stageId)) {
          stageRef.current?.setLipSync(event.data.speaking, event.data.rms);
        }
      };
    }

    return () => {
      void unlistenEmotion.then((stop) => stop());
      void unlistenCue.then((stop) => stop());
      void unlistenSpeech.then((stop) => stop());
      void unlistenCycle.then((stop) => stop());
      speechChannel?.close();
    };
  }, [interactive, runtimeConfig]);

  return (
    <Live2DStage
      ref={setStageHandle}
      modelPath={modelPath}
      bindings={runtimeConfig}
      suspended={suspended}
      interactive={interactive}
      onReady={onReady}
      onError={onError}
    />
  );
}
