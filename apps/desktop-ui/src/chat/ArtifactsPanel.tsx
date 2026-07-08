/**
 * ArtifactsPanel — shows all artifacts produced in the current session.
 *
 * Lives in the Inspector dock (▣ button). Artifact data comes from
 * useArtifactStore which is already populated by SSE events during
 * generation; this component just loads any pre-existing artifacts
 * on mount and renders ArtifactCard for each one.
 */
import { useEffect, type JSX, type CSSProperties } from 'react';
import { ScrollArea } from '@ema-agent/ui';
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

  useEffect(() => {
    if (sessionId) void useArtifactStore.getState().loadForSession(sessionId);
  }, [sessionId]);

  if (!sessionId) {
    return (
      <div className="flex items-center justify-center py-12 text-xs ema-fade-in"
           style={{ color: 'var(--ema-text-tertiary)' }}>
        无活跃会话
      </div>
    );
  }

  if (artifacts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-10 px-4 ema-fade-in">
        <span
          className="i-mdi:file-document-multiple-outline text-3xl opacity-20"
          style={{ color: 'var(--ema-primary)' }}
          aria-hidden
        />
        <p className="text-xs text-center" style={{ color: 'var(--ema-text-tertiary)' }}>
          本次会话暂无 Artifact
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div
        className="flex items-center px-3 py-1.5 border-b shrink-0"
        style={{ borderColor: 'var(--ema-border)' }}
      >
        <span className="text-xs" style={{ color: 'var(--ema-text-tertiary)' }}>
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
