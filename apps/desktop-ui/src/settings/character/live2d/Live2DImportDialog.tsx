// Live2D 导入对话框:目录句柄 + 入口相对路径 + 业务字段,错误按码翻译显示在框内。
import { useState, type JSX } from 'react';
import { Button, Callout, Checkbox, Dialog, Field, Input, Select } from '@ema-agent/ui';
import { useCardStore } from '../../../stores/card-store.js';
import { showToast } from '../../../lib/toast.js';
import { tauriBridge, type AuthorizedDirectory } from '../../../lib/tauri-bridge.js';
import { describeResourceError } from '../shared/characterResourceErrors.js';
import { operationStageLabel, useResourceOperation } from '../shared/useResourceOperation.js';
import type { CharacterCardId } from '@ema-agent/ids';

const FORMAT_OPTIONS = [
  { value: 'live2d', label: 'Live2D (Cubism)' },
  { value: 'vrm',    label: 'VRM' },
];

export function Live2DImportDialog({
  cardId,
  open,
  onOpenChange,
}: {
  cardId: CharacterCardId;
  open: boolean;
  onOpenChange(open: boolean): void;
}): JSX.Element {
  const [dir, setDir]         = useState<AuthorizedDirectory | null>(null);
  const [entry, setEntry]     = useState('');
  const [runtimeConfig, setRuntimeConfig] = useState('');
  const [label, setLabel]     = useState('');
  const [format, setFormat]   = useState('live2d');
  const [isPrimary, setIsPrimary] = useState(false);
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState<{ message: string; detail?: string } | null>(null);
  const operation = useResourceOperation(cardId, busy);

  function reset(): void {
    setDir(null); setEntry(''); setRuntimeConfig(''); setLabel('');
    setFormat('live2d'); setIsPrimary(false); setError(null);
  }

  async function pickDir(): Promise<void> {
    const picked = await tauriBridge.pickAuthorizedDirectory();
    if (!picked) return;
    setDir(picked);
    if (!label) setLabel(picked.name);
  }

  async function submit(): Promise<void> {
    if (!dir || !entry.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await useCardStore.getState().importLive2d(cardId, {
        sourceHandle: dir.fileHandle,
        label: label.trim() || dir.name,
        format: format as 'live2d' | 'vrm',
        entryRelativePath: entry.trim(),
        runtimeConfigRelativePath: runtimeConfig.trim() || null,
        isPrimary,
      });
      showToast('Live2D 导入完成', { variant: 'success' });
      onOpenChange(false);
      reset();
    } catch (err: unknown) {
      setError(describeResourceError(err, '导入失败,请检查目录内容后重试'));
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
      title="导入 Live2D 模型"
      description="选择一个包含模型文件的目录,并填写入口文件在目录内的相对路径。"
    >
      {error && (
        <Callout variant="danger" className="mb-3">
          {error.message}
          {error.detail && <span className="block mt-1 text-[10px] opacity-70">{error.detail}</span>}
        </Callout>
      )}
      <div className="flex flex-col gap-3">
        <Field label="模型目录" required>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" icon="i-mdi:folder-open-outline" disabled={busy} onClick={() => void pickDir()}>
              {dir ? dir.name : '选择目录'}
            </Button>
            {dir && <span className="text-xs text-[var(--ema-text-tertiary)]">已授权访问该目录</span>}
          </div>
        </Field>
        <Field label="入口文件相对路径" required>
          <Input
            placeholder="例如:ema/ema.model3.json"
            value={entry}
            disabled={busy}
            onChange={(e) => setEntry(e.target.value)}
          />
        </Field>
        <Field label="运行配置相对路径(可选)">
          <Input
            placeholder="例如:ema/runtime-config.json"
            value={runtimeConfig}
            disabled={busy}
            onChange={(e) => setRuntimeConfig(e.target.value)}
          />
        </Field>
        <div className="flex gap-3">
          <Field label="显示名称">
            <Input
              placeholder={dir?.name ?? '模型名称'}
              value={label}
              disabled={busy}
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
          <Field label="格式">
            <Select value={format} onChange={setFormat} options={FORMAT_OPTIONS} />
          </Field>
        </div>
        <Checkbox
          checked={isPrimary}
          disabled={busy}
          onCheckedChange={(v) => setIsPrimary(v === true)}
          label="导入后设为主用模型"
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
          disabled={!dir || !entry.trim() || busy}
          onClick={() => void submit()}
        >
          导入
        </Button>
      </div>
    </Dialog>
  );
}
