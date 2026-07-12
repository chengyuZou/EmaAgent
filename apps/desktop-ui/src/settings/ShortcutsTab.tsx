/** ShortcutsTab — keyboard shortcuts reference (V1 read-only). */
import { type CSSProperties } from 'react';
import { EntityRow } from '@ema-agent/ui';

export function ShortcutsTab(): JSX.Element {
  const shortcuts: Array<{ keys: string; action: string }> = [
    { keys: 'Enter',          action: '发送消息' },
    { keys: 'Shift+Enter',    action: '换行' },
    { keys: 'Ctrl+Enter',     action: '发送消息(备用)' },
    { keys: 'Esc',            action: '关闭弹窗 / 取消操作' },
    { keys: 'P',              action: '固定/取消固定会话(在列表内焦点时)' },
    { keys: 'R',              action: '重命名会话(在列表内焦点时)' },
    { keys: 'F',              action: 'Fork 会话(在列表内焦点时)' },
    { keys: 'A',              action: '归档会话(在列表内焦点时)' },
    { keys: 'D',              action: '删除会话(在列表内焦点时)' },
    { keys: 'Ctrl+1~9',       action: '快速切换模型' },
  ];

  return (
    <div>
      <h2 className="text-lg font-semibold text-[var(--ema-text-primary)] mb-3">快捷键</h2>
      <div className="text-xs text-[var(--ema-text-tertiary)] mb-4">V1 不可自定义，V1.5 将支持自定义绑定</div>
      <div className="flex flex-col gap-1 max-w-md">
        {shortcuts.map((s, i) => (
          <EntityRow
            key={s.keys}
            decorate="ema-card-decorate--diamond"
            index={i}
            className="flex items-center justify-between px-4 py-2"
          >
            <span className="text-sm text-[var(--ema-text-secondary)]">{s.action}</span>
            <kbd className="px-2 py-0.5 rounded-lg bg-[var(--ema-surface-2)] text-xs text-[var(--ema-text-tertiary)] font-mono">{s.keys}</kbd>
          </EntityRow>
        ))}
      </div>
    </div>
  );
}
