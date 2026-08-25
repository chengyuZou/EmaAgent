// 立绘管理:图片网格、导入、导出、启停、设主用与删除;缩略图只覆盖启用候选。
import { useEffect, useState, type JSX } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Badge, Button, EmptyState } from '@ema-agent/ui';
import { cardsApi, type CharacterCard, type CharacterPortrait } from '../../../api/cards.js';
import { sidecarClient } from '../../../api/sidecar-client.js';
import { useCardStore } from '../../../stores/card-store.js';
import { showToast } from '../../../lib/toast.js';
import { tauriBridge } from '../../../lib/tauri-bridge.js';
import { describeResourceError } from '../shared/characterResourceErrors.js';
import { EnabledControl, PrimaryBadge, ResourceActions } from '../shared/ResourceControls.js';
import { PortraitImportDialog } from './PortraitImportDialog.js';

export function PortraitsTab({ card }: { card: CharacterCard }): JSX.Element {
  const [importOpen, setImportOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sources, setSources] = useState<Record<string, string>>({});
  const isBuiltin = card.isBuiltin;

  const portraits = [...card.portraits].sort((a, b) =>
    Number(b.isPrimary) - Number(a.isPrimary) || a.position - b.position,
  );

  // 缩略图:presentation 快照只含启用候选的 sourcePath;builtin 走 sidecar 静态路径,
  // 用户卡走 convertFileSrc。停用立绘显示占位图标,不假装有图。
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const [snapshot, base] = await Promise.all([
          cardsApi.getPresentation(card.id),
          sidecarClient.baseUrl(),
        ]);
        if (disposed) return;
        const map: Record<string, string> = {};
        for (const candidate of snapshot.candidates) {
          if (candidate.kind !== 'portrait') continue;
          map[candidate.resourceId] = candidate.sourcePath.startsWith('/cards/')
            ? `${base}${candidate.sourcePath}`
            : convertFileSrc(candidate.sourcePath);
        }
        setSources(map);
      } catch {
        // 快照失败只损失缩略图,不阻断列表。
      }
    })();
    return () => { disposed = true; };
  }, [card]);

  async function run(
    resourceId: string,
    action: () => Promise<unknown>,
    okMessage: string,
    fallback: string,
  ): Promise<void> {
    setBusyId(resourceId);
    try {
      await action();
      if (okMessage) showToast(okMessage, { variant: 'success' });
    } catch (err: unknown) {
      showToast(describeResourceError(err, fallback).message, { variant: 'danger' });
    } finally {
      setBusyId(null);
    }
  }

  async function handleExport(portrait: CharacterPortrait): Promise<void> {
    const dir = await tauriBridge.pickAuthorizedDirectory();
    if (!dir) return;
    await run(portrait.id, async () => {
      const destination = await useCardStore.getState().exportPortrait(
        card.id, portrait.id, dir.fileHandle,
      );
      showToast(`已导出: ${destination}`, { variant: 'success' });
    }, '', '导出失败');
  }

  return (
    <div className="pt-3">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-[var(--ema-text-tertiary)]">
          没有可用 Live2D 时,主窗口按 主用 → 排序 使用立绘。
        </p>
        {!isBuiltin && (
          <Button variant="primary" size="sm" icon="i-mdi:plus" onClick={() => setImportOpen(true)}>
            导入立绘
          </Button>
        )}
      </div>

      {portraits.length === 0 ? (
        <EmptyState
          icon="i-mdi:image-multiple-outline"
          title="暂无立绘"
          hint={isBuiltin ? '内置角色未附带立绘' : '点击右上角导入 PNG / JPEG / WebP'}
          className="py-12"
        />
      ) : (
        <>
          {isBuiltin && (
            <p className="text-xs text-[var(--ema-text-tertiary)] mb-2">
              内置角色立绘为只读,不可导入 / 删除 / 改主用;导出不受影响。
            </p>
          )}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
            {portraits.map((p) => (
              <div
                key={p.id}
                className="rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] overflow-hidden"
              >
                <div className="aspect-[3/4] flex items-center justify-center bg-[var(--ema-surface-0)]">
                  {sources[p.id] ? (
                    <img
                      src={sources[p.id]}
                      alt={p.label}
                      className="w-full h-full object-cover"
                      draggable={false}
                    />
                  ) : (
                    <span className="i-mdi:image-off-outline text-2xl text-[var(--ema-text-tertiary)]" aria-hidden />
                  )}
                </div>
                <div className="p-2.5">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs font-semibold text-[var(--ema-text-primary)] truncate">{p.label}</span>
                    <PrimaryBadge isPrimary={p.isPrimary} />
                    {!p.enabled && <Badge variant="warn">已停用</Badge>}
                  </div>
                  <p className="text-[10px] text-[var(--ema-text-tertiary)] mt-0.5">
                    {p.width}×{p.height}
                  </p>
                  <div className="flex items-center justify-between mt-2">
                    <EnabledControl
                      enabled={p.enabled}
                      disabled={isBuiltin || busyId === p.id}
                      label={p.label}
                      onChange={(enabled) => void run(p.id, () =>
                        useCardStore.getState().patchPortrait(card.id, p.id, { enabled }),
                        enabled ? '已启用' : '已停用', '更新失败')}
                    />
                    <ResourceActions
                      isPrimary={p.isPrimary}
                      busy={busyId === p.id}
                      deleteConfirmMessage={`确定删除立绘 "${p.label}"?图片文件将移入回收区,此操作不可直接撤销。`}
                      onSetPrimary={isBuiltin ? undefined : () => void run(p.id, () =>
                        useCardStore.getState().setPrimaryPortrait(card.id, p.id), '已设为主用', '设置失败')}
                      onExport={() => void handleExport(p)}
                      onDelete={isBuiltin ? undefined : () => void run(p.id, () =>
                        useCardStore.getState().deletePortrait(card.id, p.id), '已删除', '删除失败')}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <PortraitImportDialog
        key={String(importOpen)}
        cardId={card.id}
        open={importOpen}
        onOpenChange={setImportOpen}
      />
    </div>
  );
}
