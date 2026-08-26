// 新建角色卡对话框:名称与人设提示词必填(后端硬门),状态自包含。
import { useState, type JSX } from 'react';
import { Button, Callout, Dialog, Field, Input, Textarea } from '@ema-agent/ui';
import { useCharacterStore } from '../../stores/character-store.js';
import { showToast } from '../../lib/toast.js';

export function CreateCharacterDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}): JSX.Element {
  const [name, setName]               = useState('');
  const [description, setDescription] = useState('');
  const [personaPrompt, setPersonaPrompt] = useState('');
  const [busy, setBusy]               = useState(false);
  const [error, setError]             = useState<string | null>(null);

  function reset(): void {
    setName(''); setDescription(''); setPersonaPrompt(''); setError(null);
  }

  async function submit(): Promise<void> {
    if (!name.trim() || !personaPrompt.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await useCharacterStore.getState().create({
        name: name.trim(),
        description: description.trim() || undefined,
        personaPrompt,
      });
      showToast('角色已创建,去编辑器里完善它吧', { variant: 'success' });
      onOpenChange(false);
      reset();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '创建失败,请重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next && !busy) { onOpenChange(false); reset(); } }}
      title="新建角色卡"
      description="先建卡,再进编辑器配置 Live2D、立绘与参考音频。人设提示词不能为空。"
    >
      {error && <Callout variant="danger" className="mb-3">{error}</Callout>}
      <div className="flex flex-col gap-3">
        <Field label="名称" required>
          <Input
            placeholder="角色名称"
            value={name}
            disabled={busy}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="描述">
          <Input
            placeholder="一句话介绍(可选)"
            value={description}
            disabled={busy}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field label="人设提示词" required>
          <Textarea
            minRows={8}
            maxRows={16}
            placeholder="角色的身份、性格与说话方式…"
            value={personaPrompt}
            disabled={busy}
            className="font-mono"
            onChange={(e) => setPersonaPrompt(e.target.value)}
          />
        </Field>
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { onOpenChange(false); reset(); }}>
          取消
        </Button>
        <Button
          variant="primary"
          size="sm"
          loading={busy}
          disabled={!name.trim() || !personaPrompt.trim() || busy}
          onClick={() => void submit()}
        >
          创建
        </Button>
      </div>
    </Dialog>
  );
}
