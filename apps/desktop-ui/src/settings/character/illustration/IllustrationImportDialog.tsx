// 立绘导入对话框:文件句柄 + 业务字段,错误按码翻译显示在框内。
import { useState, type JSX } from 'react';
import { Button, Callout, Checkbox, Dialog, Field, Input } from '@ema-agent/ui';
import { useCardStore } from '../../../stores/card-store.js';
import { showToast } from '../../../lib/toast.js';
import { tauriBridge, type AuthorizedFile } from '../../../lib/tauri-bridge.js';
import { describeResourceError } from '../shared/characterResourceErrors.js';
import { operationStageLabel, useResourceOperation } from '../shared/useResourceOperation.js';
import type { CharacterCardId } from '@ema-agent/ids';

export function PortraitImportDialog({
  cardId,
  open,
  onOpenChange,
}: {
  cardId: CharacterCardId;
  open: boolean;
  onOpenChange(open: boolean): void;
}): JSX.Element {
  const [file, setFile]       = useState<AuthorizedFile | null>(null);
  const [label, setLabel]     = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState<{ message: string; detail?: string } | null>(null);
  const operation = useResourceOperation(cardId, busy);

  function reset(): void {
    setFile(null); setLabel(''); setIsPrimary(false); setError(null);
  }

  async function pickFile(): Promise<void> {
    const picked = await tauriBridge.pickAuthorizedFiles();
    const first = picked[0];
    if (!first) return;
    setFile(first);
    if (!label) setLabel(first.name.replace(/\.[^.]+$/, ''));
  }

  async function submit(): Promise<void> {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await useCardStore.getState().importPortrait(cardId, {
        sourceHandle: file.fileHandle,
        label: label.trim() || file.name,
        isPrimary,
      });
      showToast('立绘导入完成', { variant: 'success' });
      onOpenChange(false);
      reset();
    } catch (err: unknown) {
      setError(describeResourceError(err, '导入失败,请检查图片后重试'));
    } finally {
      setBusy(false);
    }
  }

  const stageText = busy && operation && operation.stage !== 'completed'
    ? operationStageLabel(operation.stage)
    : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next && !busy) { onOpenChange(false); reset(); } }}
      title="导入立绘"
      description="支持 PNG / JPEG / WebP,导入时会自动旋转、重编码并移除元数据。"
    >
      {error && (
        <Callout variant="danger" className="mb-3">
          {error.message}
          {error.detail && <span className="block mt-1 text-[10px] opacity-70">{error.detail}</span>}
        </Callout>
      )}
      <div className="flex flex-col gap-3">
        <Field label="图片文件" required>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" icon="i-mdi:image-outline" disabled={busy} onClick={() => void pickFile()}>
              {file ? file.name : '选择图片'}
            </Button>
            {file && <span className="text-xs text-[var(--ema-text-tertiary)]">{formatBytes(file.size)}</span>}
          </div>
        </Field>
        <Field label="显示名称">
          <Input
            placeholder="立绘名称"
            value={label}
            disabled={busy}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
        <Checkbox
          checked={isPrimary}
          disabled={busy}
          onCheckedChange={(v) => setIsPrimary(v === true)}
          label="导入后设为主用立绘"
          showLabel
        />
      </div>
      <div className="flex items-center justify-end gap-2 mt-4">
        {stageText && <span className="text-xs text-[var(--ema-text-tertiary)] mr-auto">{stageText}</span>}
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { onOpenChange(false); reset(); }}>
          取消
        </Button>
        <Button
          variant="primary"
          size="sm"
          loading={busy}
          disabled={!file || busy}
          onClick={() => void submit()}
        >
          导入
        </Button>
      </div>
    </Dialog>
  );
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
