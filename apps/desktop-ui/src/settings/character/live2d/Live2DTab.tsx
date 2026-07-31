// Live2D 变体管理:列表、导入、导出、启停、设主用与删除,行控件走共享原子件。
import { useState, type JSX } from 'react';
import { Badge, Button, EntityRow, EmptyState } from '@ema-agent/ui';
import { useCardStore } from '../../../stores/card-store.js';
import { showToast } from '../../../lib/toast.js';
import { tauriBridge } from '../../../lib/tauri-bridge.js';
import { describeResourceError } from '../shared/characterResourceErrors.js';
import { EnabledControl, PrimaryBadge, ResourceActions } from '../shared/ResourceControls.js';
import { Live2DImportDialog } from './Live2DImportDialog.js';
import type { CharacterCard, CharacterLive2dVariant } from '../../../api/cards.js';

export function Live2DTab({ card }: { card: CharacterCard }): JSX.Element {
  const [importOpen, setImportOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const isBuiltin = card.isBuiltin;

  const variants = [...card.live2dVariants].sort((a, b) =>
    Number(b.isPrimary) - Number(a.isPrimary) || a.position - b.position,
  );

  async function run(
    resourceId: string,
    action: () => Promise<unknown>,
    okMessage: string,
    fallback: string,
  ): Promise<void> {
    setBusyId(resourceId);
    try {
      await action();
      showToast(okMessage, { variant: 'success' });
    } catch (err: unknown) {
      showToast(describeResourceError(err, fallback).message, { variant: 'danger' });
    } finally {
      setBusyId(null);
    }
  }

  async function handleExport(resource: CharacterLive2dVariant): Promise<void> {
    const dir = await tauriBridge.pickAuthorizedDirectory();
    if (!dir) return;
    await run(resource.id, async () => {
      const destination = await useCardStore.getState().exportLive2d(
        card.id, resource.id, dir.fileHandle,
      );
      showToast(`已导出: ${destination}`, { variant: 'success' });
    }, '', '导出失败');
  }

  return (
    <div className="pt-3">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-[var(--ema-text-tertiary)]">
          主窗口按 主用 → 排序 依次尝试;全部停用或损坏时降级到立绘。
        </p>
        {!isBuiltin && (
          <Button variant="primary" size="sm" icon="i-mdi:plus" onClick={() => setImportOpen(true)}>
            导入模型
          </Button>
        )}
      </div>

      {variants.length === 0 ? (
        <EmptyState
          icon="i-mdi:account-box-outline"
          title="暂无 Live2D 模型"
          hint={isBuiltin ? '内置角色未附带模型' : '点击右上角导入模型目录'}
          className="py-12"
        />
      ) : (
        <div className="flex flex-col gap-2">
          {isBuiltin && (
            <p className="text-xs text-[var(--ema-text-tertiary)] mb-1">
              内置角色模型为只读,不可导入 / 删除 / 改主用;导出不受影响。
            </p>
          )}
          {variants.map((v) => (
            <EntityRow key={v.id} decorate="ema-card-decorate--mesh" className="p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-semibold text-[var(--ema-text-primary)] truncate">{v.label}</span>
                  <PrimaryBadge isPrimary={v.isPrimary} />
                  <Badge variant="neutral">{v.format}</Badge>
                  {!v.enabled && <Badge variant="warn">已停用</Badge>}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <EnabledControl
                    enabled={v.enabled}
                    disabled={isBuiltin || busyId === v.id}
                    label={v.label}
                    onChange={(enabled) => void run(v.id, () =>
                      useCardStore.getState().patchLive2d(card.id, v.id, { enabled }),
                      enabled ? '已启用' : '已停用', '更新失败')}
                  />
                  <ResourceActions
                    isPrimary={v.isPrimary}
                    busy={busyId === v.id}
                    deleteConfirmMessage={`确定删除 Live2D "${v.label}"?模型文件将移入回收区,此操作不可直接撤销。`}
                    onSetPrimary={isBuiltin ? undefined : () => void run(v.id, () =>
                      useCardStore.getState().setPrimaryLive2d(card.id, v.id), '已设为主用', '设置失败')}
                    onExport={() => void handleExport(v)}
                    onDelete={isBuiltin ? undefined : () => void run(v.id, () =>
                      useCardStore.getState().deleteLive2d(card.id, v.id), '已删除', '删除失败')}
                  />
                </div>
              </div>
              <p className="text-xs text-[var(--ema-text-tertiary)] mt-1 font-mono truncate">
                {v.entryPath}
              </p>
            </EntityRow>
          ))}
        </div>
      )}

      <Live2DImportDialog
        key={String(importOpen)}
        cardId={card.id}
        open={importOpen}
        onOpenChange={setImportOpen}
      />
    </div>
  );
}
