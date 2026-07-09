import { useState } from 'react';
import { useSessionStore } from '../stores/session-store.js';
import { tauriBridge } from '../lib/tauri-bridge.js';
import { showToast } from '../lib/toast.js';
import { Input } from '@ema-agent/ui';
import type { SessionWire } from '@ema-agent/contracts';
import type { SessionId } from '@ema-agent/contracts';

/**
 * Single-workspace-path editor. Replaces the old multi-root WorkspaceEditor.
 *
 * Shows the current workspace root as an editable text field with a native
 * folder-picker button and a clear button. Saves via `setWorkspaceRoot`.
 * `positionClassName` controls absolute positioning relative to the trigger.
 */
export function WorkspacePicker({
  session, onClose, positionClassName,
}: {
  session: SessionWire;
  onClose(): void;
  positionClassName: string;
}): JSX.Element {
  const [path, setPath] = useState<string>(session.workspaceRoot ?? '');
  const [saving, setSaving] = useState(false);

  async function pick(): Promise<void> {
    const chosen = await tauriBridge.openFileDialog({ directory: true });
    if (chosen) setPath(chosen);
  }

  async function save(): Promise<void> {
    setSaving(true);
    try {
      const trimmed = path.trim();
      await useSessionStore.getState().setWorkspaceRoot(
        session.id as SessionId,
        trimmed === '' ? null : trimmed,
      );
      onClose();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : '工作区设置失败', { variant: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className={`ema-slide-up absolute z-50 rounded-xl p-3 shadow-[var(--ema-shadow-2)] w-72 ${positionClassName} bg-[var(--ema-surface-4)]`}
      style={{ border: '1px solid var(--ema-border)' }}
      onClick={(e) => e.stopPropagation()}
    >
      <p className="text-xs mb-2 font-medium text-[var(--ema-text-secondary)]">工作区目录</p>

      <div className="flex gap-1 mb-3">
        <Input
          inputSize="sm"
          className="font-mono"
          placeholder="D:\path\to\project"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          autoFocus
        />
        <button
          className="px-2 rounded-md text-xs transition-colors text-[var(--ema-text-secondary)] bg-[var(--ema-surface-3)] hover:bg-[var(--ema-surface-2)]"
          onClick={() => void pick()}
          title="浏览…"
        >
          <span className="i-mdi:folder-open-outline text-sm" aria-hidden />
        </button>
      </div>

      <div className="flex gap-2">
        <button
          className="px-3 py-1.5 rounded-lg text-xs transition-colors disabled:opacity-50 bg-[var(--ema-primary-muted)] text-[var(--ema-primary)]"
          disabled={saving}
          onClick={() => void save()}
        >{saving ? '保存中…' : '保存'}</button>
        <button
          className="px-3 py-1.5 rounded-lg text-xs transition-colors text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-primary)]"
          onClick={onClose}
        >取消</button>
      </div>
    </div>
  );
}
