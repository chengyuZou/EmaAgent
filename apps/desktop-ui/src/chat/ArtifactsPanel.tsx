// 展示当前 Session 的 Artifact，并根据缓存代次自动加载或刷新权威列表。
import { useEffect, type JSX, type CSSProperties } from 'react';
import { Button, Callout, ScrollArea, Spinner } from '@ema-agent/ui';
import { useArtifactStore } from '../stores/artifact-store.js';
import { useConversationStore } from '../stores/conversation-store.js';
import { ArtifactCard } from './ArtifactCard.js';

// Stable empty reference — a fresh [] from the selector each render makes
// useSyncExternalStore loop once the session has no artifacts entry.
const EMPTY_ARTIFACTS: never[] = [];

export function ArtifactsPanel(): JSX.Element {
  const sessionId = useConversationStore((s) => s.viewedSessionId);

  const artifacts = useArtifactStore((s) =>
    sessionId ? (s.bySession.get(sessionId as string) ?? EMPTY_ARTIFACTS) : EMPTY_ARTIFACTS,
  );
  const loadState = useArtifactStore((state) =>
    sessionId ? state.loadStateBySession.get(sessionId as string) : undefined,
  );

  useEffect(() => {
    const shouldLoad = !loadState
      || loadState.status === 'idle'
      || (loadState.status === 'stale' && loadState.error === null);
    if (!sessionId || !shouldLoad) return;
    void useArtifactStore.getState().loadForSession(sessionId).catch(() => {});
  }, [sessionId, loadState?.generation, loadState?.status]);

  if (!sessionId) {
    return (
      <div className="flex items-center justify-center py-12 text-xs ema-fade-in text-[var(--ema-text-tertiary)]">
        无活跃会话
      </div>
    );
  }

  if (loadState?.status === 'loading' && artifacts.length === 0) {
    return <div className="flex justify-center py-12"><Spinner size="sm" /></div>;
  }

  if (loadState?.status === 'error' && artifacts.length === 0) {
    return (
      <div className="flex flex-col gap-3 p-3">
        <Callout variant="danger">Artifact 加载失败：{loadState.error}</Callout>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => useArtifactStore.getState().invalidateSession(sessionId)}
        >
          重试
        </Button>
      </div>
    );
  }

  if (artifacts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-10 px-4 ema-fade-in">
        <span
          className="i-lucide:files text-3xl opacity-20 text-[var(--ema-primary)]"
          aria-hidden
        />
        <p className="text-xs text-center text-[var(--ema-text-tertiary)]">
          本次会话暂无 Artifact
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {loadState?.status === 'stale' && loadState.error && (
        <Callout variant="warn" className="m-2 text-xs">
          刷新失败，当前显示上一次缓存：{loadState.error}
        </Callout>
      )}
      {/* Toolbar */}
      <div
        className="flex items-center px-3 py-1.5 border-b shrink-0 border-[var(--ema-border)]"
      >
        <span className="text-xs text-[var(--ema-text-tertiary)]">
          {artifacts.length} 个产物
        </span>
      </div>

      <ScrollArea orientation="both" className="flex-1" viewportClassName="p-3">
        <div className="flex flex-col gap-2">
          {[...artifacts].reverse().map((artifact, i) => (
            <div
              key={artifact.id as string}
              className="ema-stagger-in"
              style={{ '--stagger-i': i } as CSSProperties}
            >
              <ArtifactCard artifact={artifact} />
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
