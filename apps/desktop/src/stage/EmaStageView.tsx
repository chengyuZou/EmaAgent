// 把桌面事件中的角色语义映射为当前 Live2D 模型的原生命令。

import { useCallback, useEffect, useRef, type JSX } from 'react';
import {
  Live2DStage,
  type Live2DStageHandle,
  type Live2DStageReadyInfo,
} from '@ema-agent/live2d-react';
import type { Live2dRuntimeConfig } from '@ema-agent/characters';
import { showToast } from '../lib/toast.js';
import { tauriBridge } from '../lib/tauri-bridge.js';

export interface EmaStageViewProps {
  modelArchive: Blob;
  runtimeConfig?: Live2dRuntimeConfig;
  suspended?: boolean;
  interactive?: boolean;
  onHandleChanged?: (handle: Live2DStageHandle | null) => void;
  onReady?: (info: Live2DStageReadyInfo) => void;
  onError?: (error: Error) => void;
}

export function EmaStageView({
  modelArchive,
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

    const unlistenEmotion = tauriBridge.listenStageEmotion((emotion) => {
      const target = runtimeConfig?.emotionMap?.[emotion];
      stageRef.current?.setExpression(target?.expression ?? null);
    });
    const unlistenMotion = tauriBridge.listenStageMotion((motion) => {
      const target = runtimeConfig?.motionMap?.[motion];
      if (target) stageRef.current?.playMotion(target.group, target.index);
    });
    const unlistenSpeech = tauriBridge.listenStageSpeech((speaking, rms) => {
      stageRef.current?.setLipSync(speaking, rms);
    });
    const unlistenCycle = tauriBridge.listenStageExpressionCycle(() => {
      const expression = stageRef.current?.cycleExpression();
      if (expression) {
        showToast(`已切换 Live2D 表情：${expression}`, {
          variant: 'info',
          duration: 1800,
        });
      }
    });

    return () => {
      void unlistenEmotion.then(stop => stop());
      void unlistenMotion.then(stop => stop());
      void unlistenSpeech.then(stop => stop());
      void unlistenCycle.then(stop => stop());
    };
  }, [interactive, runtimeConfig]);

  return (
    <Live2DStage
      ref={setStageHandle}
      modelArchive={modelArchive}
      runtimeConfig={runtimeConfig}
      suspended={suspended}
      interactive={interactive}
      onReady={onReady}
      onError={onError}
    />
  );
}
