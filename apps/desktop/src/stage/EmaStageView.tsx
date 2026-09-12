// 把桌面事件中的角色语义映射为当前 Live2D 模型的原生命令。

import { useCallback, useEffect, useRef, type JSX } from 'react';
import {
  Live2DStage,
  type Live2DStageHandle,
  type Live2DStageReadyInfo,
} from '@ema-agent/live2d-react';
import type { Live2dRuntimeConfig } from '@ema-agent/characters';
import { tauriBridge } from '../lib/tauri-bridge.js';

export interface EmaStageViewProps {
  modelArchive: Blob;
  runtimeConfig?: Live2dRuntimeConfig;
  stageScale?: number;
  stageOffsetX?: number;
  stageOffsetY?: number;
  suspended?: boolean;
  interactive?: boolean;
  onHandleChanged?: (handle: Live2DStageHandle | null) => void;
  onExpressionChanged?: (expression: string | null) => void;
  onReady?: (info: Live2DStageReadyInfo) => void;
  onError?: (error: Error) => void;
}

export function EmaStageView({
  modelArchive,
  runtimeConfig,
  stageScale,
  stageOffsetX,
  stageOffsetY,
  suspended = false,
  interactive = true,
  onHandleChanged,
  onExpressionChanged,
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
      const expression = target?.expression ?? null;
      stageRef.current?.setExpression(expression);
      onExpressionChanged?.(expression);
    });
    const unlistenMotion = tauriBridge.listenStageMotion((motion) => {
      const target = runtimeConfig?.motionMap?.[motion];
      if (target) stageRef.current?.playMotion(target.group, target.index);
    });
    const unlistenSpeech = tauriBridge.listenStageSpeech((speaking, rms) => {
      stageRef.current?.setLipSync(speaking, rms);
    });

    return () => {
      void unlistenEmotion.then(stop => stop());
      void unlistenMotion.then(stop => stop());
      void unlistenSpeech.then(stop => stop());
    };
  }, [interactive, onExpressionChanged, runtimeConfig]);

  return (
    <Live2DStage
      ref={setStageHandle}
      modelArchive={modelArchive}
      runtimeConfig={runtimeConfig}
      stageScale={stageScale}
      stageOffsetX={stageOffsetX}
      stageOffsetY={stageOffsetY}
      suspended={suspended}
      interactive={interactive}
      onReady={onReady}
      onError={onError}
    />
  );
}
