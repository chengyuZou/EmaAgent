// Live2D 导入对话框:选择模型目录 ZIP 的本机路径,错误按码翻译显示在框内。
import { useState, type JSX } from 'react';
import { Button, Callout, Checkbox, Dialog, Field } from '@ema-agent/ui';
import { useCharacterStore } from '../../../stores/character.js';
import { showToast } from '../../../lib/toast.js';
import { tauriBridge } from '../../../lib/tauri-bridge.js';
import { describeResourceError } from '../shared/characterResourceErrors.js';

export function Live2DImportDialog({
  characterId,
  open,
  onOpenChange,
}: {
  characterId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
}): JSX.Element {
  const [zipPath, setZipPath] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState<{ message: string; detail?: string } | null>(null);

  function reset(): void {
    setZipPath(''); setIsPrimary(false); setError(null);
  }

  async function pickFile(): Promise<void> {
    const picked = await tauriBridge.openFileDialog({
      filters: [{ name: 'Live2D 模型包', extensions: ['zip'] }],
    });
    if (picked) setZipPath(picked);
  }

  async function submit(): Promise<void> {
    if (!zipPath) return;
    setBusy(true);
    setError(null);
    try {
      await useCharacterStore.getState().importLive2d(characterId, {
        sourceZipFile: zipPath,
        isPrimary,
      });
      showToast('Live2D 导入完成', { variant: 'success' });
      onOpenChange(false);
      reset();
    } catch (err: unknown) {
      setError(describeResourceError(err, '导入失败,请检查模型包后重试'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next && !busy) { onOpenChange(false); reset(); } }}
      title="导入 Live2D 模型"
      description="选择包含完整模型目录的 ZIP 包,导入时校验入口文件与运行配置。"
    >
      {error && (
        <Callout variant="danger" className="mb-3">
          {error.message}
          {error.detail && <span className="block mt-1 text-[10px] opacity-70">{error.detail}</span>}
        </Callout>
      )}
      <div className="flex flex-col gap-3">
        <Field label="模型包" required>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" icon="i-mdi:folder-zip-outline" disabled={busy} onClick={() => void pickFile()}>
              {zipPath ? '重新选择' : '选择 ZIP 文件'}
            </Button>
            {zipPath && (
              <span className="text-xs text-[var(--ema-text-tertiary)] font-mono truncate" title={zipPath}>
                {zipPath}
              </span>
            )}
          </div>
        </Field>
        <Checkbox
          checked={isPrimary}
          disabled={busy}
          onCheckedChange={(v) => setIsPrimary(v === true)}
          label="导入后设为主用模型"
          showLabel
        />
      </div>
      <div className="flex items-center justify-end gap-2 mt-4">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { onOpenChange(false); reset(); }}>
          取消
        </Button>
        <Button
          variant="primary"
          size="sm"
          loading={busy}
          disabled={!zipPath || busy}
          onClick={() => void submit()}
        >
          导入
        </Button>
      </div>
    </Dialog>
  );
}
