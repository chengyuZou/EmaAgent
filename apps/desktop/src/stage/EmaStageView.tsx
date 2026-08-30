// 把桌面事件中的角色语义映射为当前 Live2D 舞台的原生命令。

import { useCallback, useEffect, useRef, type JSX } from 'react';
import {
  Live2DStage,
  type Live2DStageHandle,
  type Live2DStageReadyInfo,
} from '@ema-agent/live2d-react';
import { showToast } from '../lib/toast.js';
import { tauriBridge } from '../lib/tauri-bridge.js';
import type { StageLive2dRuntimeConfig } from './characterStageLoader.js';

export interface EmaStageViewProps {
  modelPath: string;
  runtimeConfig?: StageLive2dRuntimeConfig;
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
    };
    const applyMotion = (name: string): void => {
      const target = runtimeConfig?.motionMap?.[name];
      if (target) stageRef.current?.playMotion(target.group, target.index);
    };

    const unlistenEmotion = tauriBridge.listenStageEmotion(
      (emotion, stageId) => {
        if (isTargetStage(stageId)) applyEmotion(emotion);
      },
    );
    const unlistenCue = tauriBridge.listenStageMotion((motion, stageId) => {
      if (isTargetStage(stageId)) applyMotion(motion);
    });
    const unlistenSpeech = tauriBridge.listenStageSpeech((speaking, rms, stageId) => {
      if (isTargetStage(stageId)) {
        stageRef.current?.setLipSync(speaking, rms);
      }
    });
    const unlistenCycle = tauriBridge.listenStageExpressionCycle(
      (stageId) => {
        if (!isTargetStage(stageId)) return;
        const expression = stageRef.current?.cycleExpression();
        if (expression) {
          showToast(`已切换 Live2D 表情：${expression}`, {
            variant: 'info',
            duration: 1800,
          });
        }
      },
    );

    return () => {
      void unlistenEmotion.then((stop) => stop());
      void unlistenCue.then((stop) => stop());
      void unlistenSpeech.then((stop) => stop());
      void unlistenCycle.then((stop) => stop());
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
