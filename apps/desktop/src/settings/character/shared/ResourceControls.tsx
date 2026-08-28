// 资源行共享的原子控件:主用徽章与行内操作组（设主用/启停/导出/删除）。
import { useState, type JSX } from 'react';
import { Badge, ConfirmDialog, IconButton } from '@ema-agent/ui';
import { tauriBridge } from '../../../lib/tauri-bridge.js';
import { showToast } from '../../../lib/toast.js';
import { describeResourceError } from './characterResourceErrors.js';

export function PrimaryBadge({ isPrimary }: { isPrimary: boolean }): JSX.Element | null {
  if (!isPrimary) return null;
  return <Badge variant="success" dot>主用</Badge>;
}

export interface ResourceActionsProps {
  isPrimary: boolean;
  enabled: boolean;
  /** 行内忙态（任一操作进行中时禁用全部）。 */
  busy: boolean;
  onSetPrimary(): Promise<void>;
  onToggleEnabled(): Promise<void>;
  /** 参数为目标目录；组件内部完成原生目录选择后才回调。 */
  onExport(destinationDirectory: string): Promise<void>;
  onDelete(): Promise<void>;
  /** 删除确认框文案（如 "删除后不可恢复"）。 */
  deleteConfirmMessage: string;
}

/** 资源行内操作组：设主用/启停/导出（原生选目录）/删除（ConfirmDialog 确认）。 */
export function ResourceActions({
  isPrimary,
  enabled,
  busy,
  onSetPrimary,
  onToggleEnabled,
  onExport,
  onDelete,
  deleteConfirmMessage,
}: ResourceActionsProps): JSX.Element {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const run = (action: () => Promise<void>, fallback: string): void => {
    setPending(true);
    void action()
      .catch((error: unknown) => {
        showToast(describeResourceError(error, fallback).message, { variant: 'danger' });
      })
      .finally(() => setPending(false));
  };

  const disabled = busy || pending;

  return (
    <span className="flex items-center gap-1 shrink-0">
      {!isPrimary && (
        <IconButton
          size="sm"
          icon="i-lucide:star"
          label="设为主用"
          disabled={disabled}
          onClick={() => run(onSetPrimary, '设置失败')}
        />
      )}
      <IconButton
        size="sm"
        icon={enabled ? 'i-lucide:eye-off' : 'i-lucide:eye'}
        label={enabled ? '停用' : '启用'}
        disabled={disabled}
        onClick={() => run(onToggleEnabled, '切换失败')}
      />
      <IconButton
        size="sm"
        icon="i-lucide:download"
        label="导出"
        disabled={disabled}
        onClick={() => {
          void (async () => {
            const directory = await tauriBridge.openFileDialog({ directory: true });
            if (directory) run(() => onExport(directory), '导出失败');
          })();
        }}
      />
      <IconButton
        size="sm"
        variant="danger"
        icon="i-lucide:trash-2"
        label="删除"
        disabled={disabled}
        onClick={() => setConfirmOpen(true)}
      />
      {confirmOpen && (
        <ConfirmDialog
          open
          title="删除资源"
          message={deleteConfirmMessage}
          confirmText="删除"
          onConfirm={() => {
            setConfirmOpen(false);
            run(onDelete, '删除失败');
          }}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </span>
  );
}
