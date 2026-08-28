// Live2D 变体管理:列表、ZIP 导入与行内操作（设主用/启停/导出/删除）。
import { useState, type JSX } from 'react';
import { Badge, Button, EntityRow, EmptyState } from '@ema-agent/ui';
import { useCharacterStore } from '../../../stores/character.js';
import type { Character } from '../../../api/characters.js';
import { showToast } from '../../../lib/toast.js';
import { PrimaryBadge, ResourceActions } from '../shared/ResourceControls.js';
import { Live2DImportDialog } from './Live2DImportDialog.js';

export function Live2DTab({ character }: { character: Character }): JSX.Element {
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const isBuiltin = character.isBuiltin;

  // 展示顺序与服务端降级链一致:主用优先,其余按创建先后。
  const models = [...character.live2dModels].sort((a, b) =>
    Number(b.isPrimary) - Number(a.isPrimary) || a.createdAt - b.createdAt,
  );

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pt-3">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-[var(--ema-text-tertiary)]">
          主窗口按 主用 → 创建先后 依次尝试;全部停用或损坏时降级到立绘。
        </p>
        {!isBuiltin && (
          <Button variant="primary" size="sm" icon="i-mdi:plus" onClick={() => setImportOpen(true)}>
            导入模型
          </Button>
        )}
      </div>

      {models.length === 0 ? (
        <EmptyState
          icon="i-mdi:account-box-outline"
          title="暂无 Live2D 模型"
          hint={isBuiltin ? '内置角色未附带模型' : '点击右上角导入模型包'}
          className="py-12"
        />
      ) : (
        <div className="flex flex-col gap-2">
          {isBuiltin && (
            <p className="text-xs text-[var(--ema-text-tertiary)] mb-1">
              内置角色模型为只读,不可导入 / 改主用。
            </p>
          )}
          {models.map((v) => (
            <EntityRow key={v.id} decorate="ema-card-decorate--mesh" className="p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-semibold text-[var(--ema-text-primary)] truncate">{v.name}</span>
                  <PrimaryBadge isPrimary={v.isPrimary} />
                  {!v.enabled && <Badge variant="warn">已停用</Badge>}
                </div>
                {!isBuiltin && (
                  <ResourceActions
                    isPrimary={v.isPrimary}
                    enabled={v.enabled}
                    busy={busy}
                    onSetPrimary={() => run(() =>
                      useCharacterStore.getState().setPrimaryLive2d(character.id, v.id))}
                    onToggleEnabled={() => run(() =>
                      useCharacterStore.getState().patchLive2d(character.id, v.id, { enabled: !v.enabled }))}
                    onExport={(directory) => run(async () => {
                      const exported = await useCharacterStore.getState().exportLive2d(character.id, v.id, directory);
                      showToast(`已导出到 ${exported}`, { variant: 'success' });
                    })}
                    onDelete={() => run(() =>
                      useCharacterStore.getState().deleteLive2d(character.id, v.id))}
                    deleteConfirmMessage={`删除 Live2D 模型「${v.name}」后不可恢复。`}
                  />
                )}
              </div>
              <p className="text-xs text-[var(--ema-text-tertiary)] mt-1 font-mono truncate">
                {v.directoryName}
              </p>
            </EntityRow>
          ))}
        </div>
      )}

      <Live2DImportDialog
        key={String(importOpen)}
        characterId={character.id}
        open={importOpen}
        onOpenChange={setImportOpen}
      />
    </div>
  );
}
