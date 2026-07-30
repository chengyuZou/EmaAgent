// 存储位置的添加与迁移对话框:注册已有目录,或把当前数据完整复制到新路径。
import { useState, type JSX } from 'react';
import { Button, Callout, Dialog, IconButton, Input } from '@ema-agent/ui';
import { useStorageStore } from '../../stores/storage-store.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { showToast } from '../../lib/toast.js';

export function AddDirDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange(v: boolean): void;
  onAdded(): void;
}): JSX.Element {
  const [name,    setName]    = useState('');
  const [dirPath, setDirPath] = useState('');
  const [saving,  setSaving]  = useState(false);
  const store = useStorageStore();

  async function browsePath(): Promise<void> {
    const p = await tauriBridge.openFileDialog({ directory: true });
    if (p) setDirPath(p);
  }

  async function handleSave(): Promise<void> {
    if (!name.trim() || !dirPath.trim()) return;
    setSaving(true);
    try {
      await store.addDir({ name: name.trim(), path: dirPath.trim() });
      showToast('存储位置已添加', { variant: 'success' });
      setName(''); setDirPath('');
      onOpenChange(false);
      onAdded();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '添加失败', { variant: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="添加存储位置"
      description="注册一个已有或新建的数据目录。切换后需重启应用生效。"
      widthClass="max-w-md"
    >
      <div className="flex flex-col gap-4 pt-1">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-[var(--ema-text-secondary)]">名称</label>
          <Input
            placeholder="例如：工作区、个人"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-[var(--ema-text-secondary)]">路径</label>
          <div className="flex gap-2">
            <Input
              placeholder="/path/to/storage"
              value={dirPath}
              onChange={(e) => setDirPath(e.target.value)}
              className="flex-1"
            />
            <IconButton
              icon="i-solar:folder-open-bold-duotone"
              label="浏览"
              onClick={() => void browsePath()}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={!name.trim() || !dirPath.trim()}
            onClick={() => void handleSave()}
          >
            添加
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function MigrateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(v: boolean): void;
}): JSX.Element {
  const [name,       setName]       = useState('');
  const [targetPath, setTargetPath] = useState('');
  const [migrating,  setMigrating]  = useState(false);
  const store = useStorageStore();

  async function browsePath(): Promise<void> {
    const p = await tauriBridge.openFileDialog({ directory: true });
    if (p) setTargetPath(p);
  }

  async function handleMigrate(): Promise<void> {
    if (!name.trim() || !targetPath.trim()) return;
    setMigrating(true);
    try {
      const restart = await store.migrate({ name: name.trim(), targetPath: targetPath.trim() });
      if (restart) {
        showToast('迁移完成，请重启应用切换到新位置', { variant: 'success' });
      } else {
        showToast('迁移完成', { variant: 'success' });
      }
      setName(''); setTargetPath('');
      onOpenChange(false);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '迁移失败', { variant: 'danger' });
    } finally {
      setMigrating(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="迁移当前存储"
      description="将当前数据库和文件完整复制到新路径，并自动切换。操作完成后需重启应用。"
      widthClass="max-w-md"
    >
      <div className="flex flex-col gap-4 pt-1">
        <Callout variant="warn" className="ema-slide-down">
          迁移过程中请勿退出应用。迁移完成后需手动重启以切换到新位置。
        </Callout>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-[var(--ema-text-secondary)]">新位置名称</label>
          <Input
            placeholder="例如：迁移后"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-[var(--ema-text-secondary)]">目标路径</label>
          <div className="flex gap-2">
            <Input
              placeholder="/path/to/new/location"
              value={targetPath}
              onChange={(e) => setTargetPath(e.target.value)}
              className="flex-1"
            />
            <IconButton
              icon="i-solar:folder-open-bold-duotone"
              label="浏览"
              onClick={() => void browsePath()}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            variant="danger"
            loading={migrating}
            disabled={!name.trim() || !targetPath.trim()}
            onClick={() => void handleMigrate()}
          >
            开始迁移
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
