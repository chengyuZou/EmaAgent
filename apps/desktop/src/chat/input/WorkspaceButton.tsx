// 输入区工具栏的工作区目录按钮:无会话时提示,有会话弹出共享 WorkspacePicker。
import { useState, type JSX } from 'react';
import { IconButton } from '@ema-agent/ui';
import { useSessionStore } from '../../stores/session.js';
import { showToast } from '../../lib/toast.js';
import { WorkspacePicker } from '../WorkspacePicker.js';

export function WorkspaceButton({ sessionId }: { sessionId: string | null }): JSX.Element {
  const [open, setOpen] = useState(false);
  const session = useSessionStore((s) =>
    sessionId ? s.sessions.byId.get(sessionId) : undefined,
  );
  const hasRoot = !!session?.workspaceRoot;

  function handleClick(): void {
    if (!sessionId) {
      showToast('请先发送消息创建会话', { variant: 'warning' });
      return;
    }
    setOpen(!open);
  }

  return (
    <div className="relative">
      <IconButton
        variant={hasRoot ? 'primary' : 'default'}
        size="sm"
        icon="i-lucide:folder"
        label={hasRoot ? '工作区目录' : '未设置工作区目录'}
        toggled={hasRoot}
        onClick={handleClick}
      />

      {open && session && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <WorkspacePicker
            session={session}
            positionClassName="bottom-full left-0 mb-2"
            onClose={() => setOpen(false)}
          />
        </>
      )}
    </div>
  );
}
