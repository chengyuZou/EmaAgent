// 资源行共享的原子控件:主用徽章、启停开关与导出/删除操作,不统一行布局。
import { useState, type JSX } from 'react';
import { Badge, Button, ConfirmDialog, Switch, Tooltip } from '@ema-agent/ui';

export function PrimaryBadge({ isPrimary }: { isPrimary: boolean }): JSX.Element | null {
  if (!isPrimary) return null;
  return <Badge variant="success" dot>主用</Badge>;
}

export function EnabledControl({
  enabled,
  disabled = false,
  label,
  onChange,
}: {
  enabled: boolean;
  disabled?: boolean;
  label: string;
  onChange(enabled: boolean): void;
}): JSX.Element {
  return (
    <Tooltip content={enabled ? '停用后不参与主窗口展示' : '启用后按顺序参与主窗口展示'}>
      <span className="inline-flex">
        <Switch
          checked={enabled}
          disabled={disabled}
          label={label}
          onCheckedChange={(v) => onChange(v === true)}
        />
      </span>
    </Tooltip>
  );
}

export function ResourceActions({
  isPrimary,
  busy = false,
  deleteConfirmMessage,
  onSetPrimary,
  onExport,
  onDelete,
}: {
  isPrimary: boolean;
  busy?: boolean;
  deleteConfirmMessage: string;
  /** undefined 表示该操作不可用(内置角色)。 */
  onSetPrimary?(): void;
  onExport?(): void;
  onDelete?(): void;
}): JSX.Element {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex items-center gap-1.5">
      {!isPrimary && onSetPrimary && (
        <Button variant="secondary" size="sm" disabled={busy} onClick={onSetPrimary}>
          设主用
        </Button>
      )}
      {onExport && (
        <Button variant="ghost" size="sm" disabled={busy} icon="i-mdi:export-variant" onClick={onExport}>
          导出
        </Button>
      )}
      {onDelete && (
        <Button variant="danger" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
          删除
        </Button>
      )}
      <ConfirmDialog
        open={confirming}
        message={deleteConfirmMessage}
        confirmText="删除"
        onConfirm={() => { setConfirming(false); onDelete?.(); }}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
