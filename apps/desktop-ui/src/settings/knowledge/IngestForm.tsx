// 文档导入表单:文件选择与入队,后台处理进度由处理队列与 SSE 呈现。
import { useState, type JSX } from 'react';
import { Button, Callout, Input, Spinner } from '@ema-agent/ui';
import { useKbStore } from '../../stores/kb-store.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { showToast } from '../../lib/toast.js';

export function IngestForm({ onDone }: { onDone(): void }): JSX.Element {
  const ingesting   = useKbStore((s) => s.ingesting);
  const ingestError = useKbStore((s) => s.ingestError);
  const [filePath, setFilePath] = useState('');

  async function pickFile(): Promise<void> {
    const path = await tauriBridge.openFileDialog({
      filters: [
        { name: '文档', extensions: ['pdf', 'md', 'txt', 'docx', 'html', 'htm'] },
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (path) setFilePath(path);
  }

  async function handleIngest(): Promise<void> {
    if (!filePath.trim()) {
      showToast('请选择或输入文件路径', { variant: 'warning' });
      return;
    }
    await useKbStore.getState().ingest(filePath.trim());
    if (!useKbStore.getState().ingestError) {
      setFilePath('');
      onDone();
      showToast('已加入处理队列', { variant: 'success' });
    }
  }

  return (
    <div className="flex flex-col gap-3 p-4 rounded-xl
                    bg-[var(--ema-surface-1)] border border-[var(--ema-border)] ema-card-decorate ema-card-decorate--starfield">
      <p className="text-sm font-semibold text-[var(--ema-text-primary)]">导入文档</p>

      <div className="flex gap-2">
        <Input
          className="flex-1 font-mono text-xs"
          placeholder="文件绝对路径，例如 D:\docs\paper.pdf"
          value={filePath}
          onChange={(e) => setFilePath(e.target.value)}
        />
        <Button variant="secondary" size="sm" onClick={() => void pickFile()}>
          浏览…
        </Button>
      </div>

      {ingestError && (
        <Callout variant="danger" className="text-xs">{ingestError}</Callout>
      )}

      <div className="flex justify-end">
        <Button
          variant="primary"
          size="sm"
          disabled={ingesting || !filePath.trim()}
          onClick={() => void handleIngest()}
        >
          {ingesting ? <><Spinner size="sm" className="mr-1.5" />导入中…</> : '开始导入'}
        </Button>
      </div>
    </div>
  );
}
