// 管理主窗口 Live2D、立绘与占位之间可抢占且无空白闪烁的切换。

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import { tauriBridge } from '../lib/tauri-bridge.js';
import {
  type Live2DStageHandle,
  type Live2DStageReadyInfo,
} from '@ema-agent/live2d-react';
import type {
  CharacterStageCandidate,
  CharacterStageView,
} from './characterStageLoader.js';

import { EmaStageView } from './EmaStageView.js';

const EXIT_DURATION_MS = 300;

interface MountedStage {
  readonly requestId: number;
  readonly characterId: string;
  readonly candidate: CharacterStageCandidate;
}

interface PendingPlan {
  requestId: number;
  view: CharacterStageView;
  nextIndex: number;
}

export interface CharacterStageProps {
  targetCharacterId: string | null;
  view: CharacterStageView | null;
  suspended: boolean;
  onStageChanged?: (stage: ActiveLive2DStage | null) => void;
}

export interface ActiveLive2DStage {
  handle: Live2DStageHandle;
  hasExpressions: boolean;
}

export function CharacterStage({
  targetCharacterId,
  view,
  suspended,
  onStageChanged,
}: CharacterStageProps): JSX.Element {
  const requestSequence = useRef(0);
  const activeRef = useRef<MountedStage | null>(null);
  const planRef = useRef<PendingPlan | null>(null);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [active, setActive] = useState<MountedStage | null>(null);
  const [pending, setPending] = useState<MountedStage | null>(null);
  const [outgoing, setOutgoing] = useState<MountedStage | null>(null);

  const clearExitTimer = useCallback((): void => {
    if (!exitTimer.current) return;
    clearTimeout(exitTimer.current);
    exitTimer.current = null;
  }, []);

  const commitActive = useCallback((next: MountedStage): void => {
    if (planRef.current?.requestId !== next.requestId) return;
    clearExitTimer();
    const previous = activeRef.current;
    activeRef.current = next;
    setOutgoing(previous);
    setActive(next);
    setPending(null);
    planRef.current = null;

    if (previous) {
      exitTimer.current = setTimeout(() => {
        setOutgoing((current) => current === previous ? null : current);
        exitTimer.current = null;
      }, EXIT_DURATION_MS);
    }
  }, [clearExitTimer]);

  const loadNextCandidate = useCallback((requestId: number): void => {
    const plan = planRef.current;
    if (!plan || plan.requestId !== requestId) return;

    while (plan.nextIndex < plan.view.candidates.length) {
      const candidate = plan.view.candidates[plan.nextIndex]!;
      plan.nextIndex += 1;
      const current = activeRef.current;
      if (
        current
        && current.characterId === plan.view.characterId
        && candidateKey(current.candidate) === candidateKey(candidate)
      ) {
        setPending(null);
        planRef.current = null;
        return;
      }
      setPending({
        requestId,
        characterId: plan.view.characterId,
        candidate,
      });
      return;
    }

    setPending(null);
    planRef.current = null;
    const current = activeRef.current;
    if (current?.characterId === plan.view.characterId) {
      activeRef.current = null;
      clearExitTimer();
      setActive(null);
      setOutgoing(null);
      onStageChanged?.(null);
    }
  }, [clearExitTimer, onStageChanged]);

  useEffect(() => {
    const current = activeRef.current;
    if (
      targetCharacterId
      && current?.characterId === targetCharacterId
    ) {
      return;
    }

    requestSequence.current += 1;
    planRef.current = null;
    activeRef.current = null;
    clearExitTimer();
    setActive(null);
    setPending(null);
    setOutgoing(null);
    onStageChanged?.(null);
  }, [clearExitTimer, onStageChanged, targetCharacterId]);

  useEffect(() => {
    if (!view || view.characterId !== targetCharacterId) return;
    const requestId = ++requestSequence.current;
    planRef.current = { requestId, view, nextIndex: 0 };
    setPending(null);
    loadNextCandidate(requestId);
  }, [
    loadNextCandidate,
    view,
    view?.characterId,
    targetCharacterId,
  ]);

  useEffect(() => () => {
    requestSequence.current += 1;
    planRef.current = null;
    clearExitTimer();
  }, [clearExitTimer]);

  const failPending = useCallback((failed: MountedStage): void => {
    if (planRef.current?.requestId !== failed.requestId) return;
    console.warn(
      '[character-stage] candidate failed, trying next resource',
      failed.characterId,
      failed.candidate.resourceId,
    );
    loadNextCandidate(failed.requestId);
  }, [loadNextCandidate]);

  const mountedResources = [
    outgoing ? { mounted: outgoing, state: 'outgoing' as const } : null,
    active ? { mounted: active, state: 'active' as const } : null,
    pending ? { mounted: pending, state: 'pending' as const } : null,
  ].filter((value): value is {
    mounted: MountedStage;
    state: 'active' | 'pending' | 'outgoing';
  } => value !== null);

  return (
    <div className="ema-character-stage" data-tauri-drag-region={false}>
      {!active && (
        <div className="ema-character-stage-placeholder" aria-label="角色舞台占位">
          <span className="ema-character-stage-placeholder-ring" />
        </div>
      )}

      {mountedResources.map(({ mounted, state }) => (
        <StageResource
          key={`${mounted.characterId}:${candidateKey(mounted.candidate)}`}
          mounted={mounted}
          suspended={suspended}
          state={state}
          interactive={state === 'active'}
          onStageChanged={state === 'active' ? onStageChanged : undefined}
          onReady={state === 'pending' ? () => commitActive(mounted) : () => {}}
          onError={state === 'pending' ? () => failPending(mounted) : () => {}}
        />
      ))}
    </div>
  );
}

function StageResource({
  mounted,
  suspended,
  state,
  interactive,
  onReady,
  onError,
  onStageChanged,
}: {
  mounted: MountedStage;
  suspended: boolean;
  state: 'active' | 'pending' | 'outgoing';
  interactive: boolean;
  onReady(): void;
  onError(): void;
  onStageChanged?: (stage: ActiveLive2DStage | null) => void;
}): JSX.Element {
  const handleRef = useRef<Live2DStageHandle | null>(null);
  const [readyStage, setReadyStage] = useState<ActiveLive2DStage | null>(null);
  const sourcePath = runtimeSource(mounted.candidate.sourcePath);

  const handleChanged = useCallback((handle: Live2DStageHandle | null): void => {
    handleRef.current = handle;
    if (!handle) setReadyStage(null);
  }, []);

  const ready = useCallback((info?: Live2DStageReadyInfo): void => {
    const handle = handleRef.current;
    if (handle && info) {
      setReadyStage({ handle, hasExpressions: info.hasExpressions });
    }
    onReady();
  }, [onReady]);

  useEffect(() => {
    if (!interactive) return;
    onStageChanged?.(mounted.candidate.kind === 'live2d' ? readyStage : null);
    return () => onStageChanged?.(null);
  }, [interactive, mounted.candidate.kind, onStageChanged, readyStage]);

  const transform = {
    transform: `translate(${mounted.candidate.stageOffsetX * 100}%, ${mounted.candidate.stageOffsetY * 100}%) scale(${mounted.candidate.stageScale})`,
  };

  return (
    <div className="ema-character-stage-resource" data-state={state}>
      <div className="ema-character-stage-resource-content" style={transform}>
        {mounted.candidate.kind === 'live2d' ? (
          <EmaStageView
            modelPath={sourcePath}
            runtimeConfig={mounted.candidate.runtimeConfig ?? undefined}
            suspended={suspended}
            interactive={interactive}
            onHandleChanged={handleChanged}
            onReady={ready}
            onError={onError}
          />
        ) : (
          <img
            className="ema-character-stage-portrait"
            src={sourcePath}
            alt={mounted.candidate.name}
            draggable={false}
            onLoad={() => ready()}
            onError={onError}
          />
        )}
      </div>
    </div>
  );
}

function candidateKey(candidate: CharacterStageCandidate): string {
  return [
    candidate.kind,
    candidate.resourceId,
    candidate.resourceRevision,
    candidate.sourcePath,
  ].join(':');
}

function runtimeSource(sourcePath: string): string {
  if (
    /^[A-Za-z]:[\\/]/.test(sourcePath)
    || sourcePath.startsWith('\\\\')
    || (sourcePath.startsWith('/') && !sourcePath.startsWith('/api/characters/'))
  ) {
    return tauriBridge.convertFileSrc(sourcePath);
  }
  return sourcePath;
}
