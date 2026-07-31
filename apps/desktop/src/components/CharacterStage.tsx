// 管理主窗口 Live2D、立绘与占位之间可抢占且无空白闪烁的切换。

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  createLive2DRuntime,
  type Live2DRuntime,
} from '@ema-agent/live2d-react';
import type {
  CharacterStageCandidate,
  CharacterStageSnapshot,
} from '@ema-agent/desktop-ui';
import type { CharacterCardId } from '@ema-agent/ids';
import { EmaStageView } from './EmaStageView.js';

const EXIT_DURATION_MS = 300;

interface MountedStage {
  readonly requestId: number;
  readonly characterId: CharacterCardId;
  readonly candidate: CharacterStageCandidate;
}

interface PendingPlan {
  requestId: number;
  snapshot: CharacterStageSnapshot;
  nextIndex: number;
}

export interface CharacterStageProps {
  targetCharacterId: CharacterCardId | null;
  snapshot: CharacterStageSnapshot | null;
  suspended: boolean;
  onRuntimeChanged?: (runtime: Live2DRuntime | null) => void;
}

export function CharacterStage({
  targetCharacterId,
  snapshot,
  suspended,
  onRuntimeChanged,
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
  }, [clearExitTimer, onRuntimeChanged]);

  const loadNextCandidate = useCallback((requestId: number): void => {
    const plan = planRef.current;
    if (!plan || plan.requestId !== requestId) return;

    while (plan.nextIndex < plan.snapshot.candidates.length) {
      const candidate = plan.snapshot.candidates[plan.nextIndex]!;
      plan.nextIndex += 1;
      const current = activeRef.current;
      if (
        current
        && current.characterId === plan.snapshot.characterId
        && candidateKey(current.candidate) === candidateKey(candidate)
      ) {
        setPending(null);
        planRef.current = null;
        return;
      }
      setPending({
        requestId,
        characterId: plan.snapshot.characterId,
        candidate,
      });
      return;
    }

    setPending(null);
    planRef.current = null;
    const current = activeRef.current;
    if (current?.characterId === plan.snapshot.characterId) {
      activeRef.current = null;
      clearExitTimer();
      setActive(null);
      setOutgoing(null);
      onRuntimeChanged?.(null);
    }
  }, [clearExitTimer, onRuntimeChanged]);

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
    onRuntimeChanged?.(null);
  }, [clearExitTimer, onRuntimeChanged, targetCharacterId]);

  useEffect(() => {
    if (!snapshot || snapshot.characterId !== targetCharacterId) return;
    const requestId = ++requestSequence.current;
    planRef.current = { requestId, snapshot, nextIndex: 0 };
    setPending(null);
    loadNextCandidate(requestId);
  }, [
    loadNextCandidate,
    snapshot,
    snapshot?.characterId,
    snapshot?.revision,
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
          onRuntimeChanged={state === 'active' ? onRuntimeChanged : undefined}
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
  onRuntimeChanged,
}: {
  mounted: MountedStage;
  suspended: boolean;
  state: 'active' | 'pending' | 'outgoing';
  interactive: boolean;
  onReady(): void;
  onError(): void;
  onRuntimeChanged?: (runtime: Live2DRuntime | null) => void;
}): JSX.Element {
  const [runtime] = useState(() => createLive2DRuntime('main'));
  const sourcePath = runtimeSource(mounted.candidate.sourcePath);

  useEffect(() => {
    if (!interactive) return;
    onRuntimeChanged?.(runtime);
    return () => onRuntimeChanged?.(null);
  }, [interactive, onRuntimeChanged, runtime]);

  return (
    <div className="ema-character-stage-resource" data-state={state}>
      {mounted.candidate.kind === 'live2d' ? (
        <EmaStageView
          modelPath={sourcePath}
          runtime={runtime}
          runtimeConfig={mounted.candidate.runtimeConfig ?? undefined}
          suspended={suspended}
          interactive={interactive}
          onReady={onReady}
          onError={onError}
        />
      ) : (
        <img
          className="ema-character-stage-portrait"
          src={sourcePath}
          alt={mounted.candidate.label}
          draggable={false}
          onLoad={onReady}
          onError={onError}
        />
      )}
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
    || (sourcePath.startsWith('/') && !sourcePath.startsWith('/cards/'))
  ) {
    return convertFileSrc(sourcePath);
  }
  return sourcePath;
}
