// 单个存储位置行:激活/移除动作与当前位置标记。
import { useState, type JSX } from 'react';
import { Badge, Button, EntityRow, IconButton } from '@ema-agent/ui';
import { useStorageStore } from '../../stores/storage-store.js';
import { showToast } from '../../lib/toast.js';
import type { DataDirItem } from '../../api/storage.js';
import { fmtBytes } from './storageFormat.js';

export function DataDirRow({
  dir,
  index,
  onMigrateOpen,
}: {
  dir:           DataDirItem;
  index:         number;
  onMigrateOpen(): void;
}): JSX.Element {
  const [activating, setActivating] = useState(false);
  const [removing,   setRemoving]   = useState(false);
  const store = useStorageStore();

  async function handleActivate(): Promise<void> {
    setActivating(true);
    try {
      const restart = await store.activateDir(dir.name);
      if (restart) showToast('已切换，请重启应用生效', { variant: 'success' });
    } catch (err) {
      showToast(err instanceof Error ? err.message : '切换失败', { variant: 'danger' });
    } finally {
      setActivating(false);
    }
  }

  async function handleRemove(): Promise<void> {
    setRemoving(true);
    try {
      await store.removeDir(dir.name);
      showToast('已移除存储位置（文件未删除）', { variant: 'success' });
    } catch (err) {
      showToast(err instanceof Error ? err.message : '移除失败', { variant: 'danger' });
    } finally {
      setRemoving(false);
    }
  }

  return (
    <EntityRow
      decorate="ema-card-decorate--storage"
      active={dir.isActive}
      index={index}
      className="group flex flex-col gap-1.5 px-3 py-2.5 transition-colors duration-[var(--ema-duration-base)]"
    >
      <div className="flex items-center gap-2">
        <span
          className={`text-xs shrink-0 ${dir.isActive ? 'i-solar:check-circle-bold text-[var(--ema-primary)]' : 'i-solar:check-circle-linear text-[var(--ema-text-tertiary)]'}`}
          aria-hidden
        />
        <span className="text-sm font-semibold text-[var(--ema-text-primary)] truncate flex-1">
          {dir.name}
        </span>
        {dir.isActive && (
          <Badge variant="success" className="ema-scale-in shrink-0">当前</Badge>
        )}
      </div>

      <p className="text-xs text-[var(--ema-text-tertiary)] font-mono truncate pl-5" title={dir.path}>
        {dir.path}
      </p>

      <div className="flex items-center justify-between pl-5">
        <span className="text-xs text-[var(--ema-text-tertiary)]">
          db {fmtBytes(dir.dataDbBytes)}
        </span>
        <div className={`flex items-center gap-1 transition-opacity duration-150
                          ${dir.isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
          {dir.isActive ? (
            <Button
              variant="ghost"
              size="sm"
              icon="i-solar:transfer-horizontal-bold-duotone"
              onClick={onMigrateOpen}
            >
              迁移
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                loading={activating}
                onClick={() => void handleActivate()}
              >
                激活
              </Button>
              <IconButton
                icon="i-solar:trash-bin-trash-bold-duotone"
                label="移除"
                size="sm"
                loading={removing}
                onClick={() => void handleRemove()}
              />
            </>
          )}
        </div>
      </div>
    </EntityRow>
  );
}
