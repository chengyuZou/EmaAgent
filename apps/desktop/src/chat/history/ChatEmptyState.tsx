// 会话空态：当前激活角色立绘标 + 标题 + 淡蓝辉光 + 工作区 chip（无工作区为选择触发器）。
import { useEffect, useState, type JSX } from 'react';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { charactersApi } from '../../api/characters.js';
import { useCharacterStore } from '../../stores/character.js';
import { useSessionStore } from '../../stores/session.js';
import { WorkspacePicker } from '../WorkspacePicker.js';

export function ChatEmptyState({ sessionId }: { sessionId?: string | null }): JSX.Element {
  const activeCharacterId = useCharacterStore((s) => s.activeCharacterId);
  const character = useCharacterStore((s) =>
    s.characters.find((item) => item.id === s.activeCharacterId),
  );
  const session = useSessionStore((s) =>
    sessionId ? s.sessions.byId.get(sessionId) : undefined,
  );

  const [illustrationUrl, setIllustrationUrl] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (!activeCharacterId) {
      setIllustrationUrl(null);
      return;
    }
    let disposed = false;
    void charactersApi.getPresentation(activeCharacterId)
      .then((presentation) => {
        if (disposed) return;
        setIllustrationUrl(
          presentation.illustrationFile ? tauriBridge.convertFileSrc(presentation.illustrationFile) : null,
        );
      })
      .catch(() => { if (!disposed) setIllustrationUrl(null); });
    return () => { disposed = true; };
  }, [activeCharacterId]);

  const workspaceName = session?.workspaceRoot
    ? (session.workspaceRoot.split(/[\\/]/).filter(Boolean).pop() ?? session.workspaceRoot)
    : null;

  return (
    <div className="ema-empty-state">
      <div className="ema-empty-state-glow" aria-hidden />

      {illustrationUrl ? (
        <img className="ema-empty-state-avatar" src={illustrationUrl} alt={character?.name ?? '角色'} draggable={false} />
      ) : (
        <div className="ema-empty-state-avatar ema-empty-state-avatar-fallback" aria-hidden>
          <span className="i-lucide:paw-print" />
        </div>
      )}

      <h2 className="ema-empty-state-title">
        {character ? `和 ${character.name} 开始聊天` : '开始聊天吧'}
      </h2>

      {sessionId && session && (
        <div className="relative">
          <button
            type="button"
            className={`ema-empty-state-chip ${workspaceName ? '' : 'ema-empty-state-chip-empty'}`}
            onClick={() => setPickerOpen((open) => !open)}
          >
            <span className="i-lucide:folder" aria-hidden />
            {workspaceName ?? '选择工作区'}
            <span className="i-lucide:chevron-down text-xs opacity-60" aria-hidden />
          </button>
          {pickerOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setPickerOpen(false)} />
              <WorkspacePicker
                session={session}
                positionClassName="top-full left-1/2 -translate-x-1/2 mt-2"
                onClose={() => setPickerOpen(false)}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
