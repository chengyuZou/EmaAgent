// 修改一条已创建会话的执行目录；项目成员资格和源文件夹清单不随之变化。
import { useEffect, useState, type JSX } from 'react';
import { Button, Dialog, IconButton, Input } from '@ema-agent/ui';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { showToast } from '../../lib/toast.js';
import { useSessionStore } from '../../stores/session.js';

export function SessionCwdDialog({
  sessionId,
  open,
  onOpenChange,
}: {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const cwd = useSessionStore(state => state.sessions.byId.get(sessionId)?.cwd ?? '');
  const [draft, setDraft] = useState(cwd);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setDraft(cwd);
  }, [open, cwd]);

  async function pickDirectory(): Promise<void> {
    try {
      const selected = await tauriBridge.openFileDialog({ directory: true });
      if (selected) setDraft(selected);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '选择执行目录失败', { variant: 'danger' });
    }
  }

  async function save(): Promise<void> {
    if (!draft.trim() || saving) return;
    setSaving(true);
    try {
      await useSessionStore.getState().setCwd(sessionId, draft.trim());
      onOpenChange(false);
    } catch (error) {
      showToast(error instanceof Error ? `修改执行目录失败: ${error.message}` : '修改执行目录失败', { variant: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="修改会话执行目录" widthClass="max-w-lg">
      <p className="mb-3 text-sm text-[var(--ema-text-secondary)]">
        命令与相对文件路径默认从此目录开始。项目的源文件夹不会因此改变。
      </p>
      <div className="flex gap-2">
        <Input
          aria-label="执行目录"
          value={draft}
          onChange={event => setDraft(event.target.value)}
          autoFocus
        />
        <IconButton size="md" variant="ghost" icon="i-lucide:folder-open" label="选择目录" onClick={() => void pickDirectory()} />
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
        <Button variant="primary" disabled={!draft.trim() || saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存'}
        </Button>
      </div>
    </Dialog>
  );
}
