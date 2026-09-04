// 新建知识库弹窗:名称 + 存储文件夹选择;创建后由调用方决定激活与跳转。
import { useState, type JSX } from 'react';
import { Button, Callout, Dialog, Input, Spinner } from '@ema-agent/ui';
import { useKnowledgeStore } from '../../stores/knowledge.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { showToast } from '../../lib/toast.js';

export function KbCreateDialog({ open, onOpenChange, onCreated }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** 创建成功回调,携带新库 id(调用方负责激活与进入详情)。 */
  onCreated(id: string): void;
}): JSX.Element {
  const [name,   setName]   = useState('');
  const [kbPath, setKbPath] = useState('');
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState<string | null>(null);

  function handleOpenChange(v: boolean): void {
    onOpenChange(v);
    if (!v) { setName(''); setKbPath(''); setError(null); }
  }

  async function pickFolder(): Promise<void> {
    const picked = await tauriBridge.openFileDialog({ directory: true });
    if (picked) setKbPath(picked);
  }

  async function handleCreate(): Promise<void> {
    const n = name.trim();
    const p = kbPath.trim();
    if (!n) { setError('请输入知识库名称'); return; }
    if (!p) { setError('请选择文件夹'); return; }
    setSaving(true); setError(null);
    const lib = await useKnowledgeStore.getState().createLib(n, p);
    setSaving(false);
    if (!lib) {
      setError(useKnowledgeStore.getState().libsError ?? '创建失败');
      return;
    }
    showToast(`已创建「${lib.name}」`, { variant: 'success' });
    handleOpenChange(false);
    onCreated(lib.id);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange} title="新建知识库">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-[var(--ema-text-tertiary)]">名称</label>
          <Input
            placeholder="我的知识库"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-[var(--ema-text-tertiary)]">存储文件夹</label>
          <div className="flex gap-2">
            <Input
              className="flex-1 font-mono text-xs"
              placeholder="选择一个空文件夹…"
              value={kbPath}
              onChange={(e) => setKbPath(e.target.value)}
            />
            <Button variant="secondary" size="sm" onClick={() => void pickFolder()}>浏览…</Button>
          </div>
          <p className="text-[11px] text-[var(--ema-text-tertiary)]">
            知识库的 SQLite 与受管文档副本将存储在此文件夹内，推荐选择一个新的空文件夹。
          </p>
        </div>

        {error && <Callout variant="danger" className="text-xs">{error}</Callout>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => handleOpenChange(false)}>取消</Button>
          <Button
            variant="primary" size="sm"
            disabled={saving || !name.trim() || !kbPath.trim()}
            onClick={() => void handleCreate()}
          >
            {saving ? <><Spinner size="sm" className="mr-1.5" />创建中…</> : '创建'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
