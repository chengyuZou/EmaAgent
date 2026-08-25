// 技能的文本/URL 安装对话框与重命名对话框:状态自包含,主装配只负责开关。
import { useRef, useState, type JSX } from 'react';
import { Button, Callout, Dialog, Field, Input, Textarea } from '@ema-agent/ui';
import { useSkillStore } from '../../stores/skill-store.js';
import { showToast } from '../../lib/toast.js';

// ── Install from text ─────────────────────────────────────────────────────────

export function SkillTextInstallDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}): JSX.Element {
  const [textContent,  setTextContent]  = useState('');
  const [installing,   setInstalling]   = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  function closeDialog(): void {
    onOpenChange(false);
    setInstallError(null);
    setTextContent('');
  }

  async function handleInstallFromText(): Promise<void> {
    if (!textContent.trim()) return;
    setInstalling(true);
    setInstallError(null);
    try {
      const sk = await useSkillStore.getState().installFromText(textContent);
      showToast(`已安装 ${sk.name}`, { variant: 'success' });
      closeDialog();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setInstallError(msg);
      showToast(`安装失败: ${msg}`, { variant: 'danger' });
    } finally {
      setInstalling(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) closeDialog(); }}
      title="从文本安装技能"
      description="粘贴技能的 Markdown 内容。frontmatter 须包含 name / version / description。"
      widthClass="max-w-2xl"
    >
      {installError && <Callout variant="danger" className="mb-3">{installError}</Callout>}
      <Field label="Markdown 内容" required>
        <Textarea
          minRows={10}
          maxRows={20}
          placeholder={'---\nname: my-skill\nversion: 1.0.0\ndescription: ...\n---\n\n# My Skill\n...'}
          value={textContent}
          onChange={(e) => setTextContent(e.target.value)}
        />
      </Field>
      <div className="flex justify-end gap-2 mt-4">
        <Button variant="ghost" size="sm" onClick={closeDialog}>取消</Button>
        <Button
          variant="primary"
          size="sm"
          loading={installing}
          disabled={!textContent.trim() || installing}
          onClick={() => void handleInstallFromText()}
        >安装</Button>
      </div>
    </Dialog>
  );
}

// ── Install from URL ──────────────────────────────────────────────────────────

export function SkillUrlInstallDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}): JSX.Element {
  const [urlInput,     setUrlInput]     = useState('');
  const [installing,   setInstalling]   = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  function closeDialog(): void {
    onOpenChange(false);
    setInstallError(null);
    setUrlInput('');
  }

  async function handleInstallFromUrl(): Promise<void> {
    const target = urlInput.trim();
    if (!target) return;
    setInstalling(true);
    setInstallError(null);
    try {
      const sk = await useSkillStore.getState().installFromUrl(target, undefined, undefined);
      showToast(`已安装 ${sk.name}`, { variant: 'success' });
      closeDialog();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setInstallError(msg);
      showToast(`安装失败: ${msg}`, { variant: 'danger' });
    } finally {
      setInstalling(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) closeDialog(); }}
      title="从 URL 安装技能"
      description="输入技能 Markdown 文件的直链(GitHub raw、jsDelivr 等)。"
    >
      {installError && <Callout variant="danger" className="mb-3">{installError}</Callout>}
      <Field label="技能文件 URL" required>
        <Input
          placeholder="https://raw.githubusercontent.com/..."
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleInstallFromUrl(); }}
          autoFocus
        />
      </Field>
      <div className="flex justify-end gap-2 mt-4">
        <Button variant="ghost" size="sm" onClick={closeDialog}>取消</Button>
        <Button
          variant="primary"
          size="sm"
          loading={installing}
          disabled={!urlInput.trim() || installing}
          onClick={() => void handleInstallFromUrl()}
        >安装</Button>
      </div>
    </Dialog>
  );
}

// ── Rename dialog ─────────────────────────────────────────────────────────────

export function SkillRenameDialog({
  name,
  onOpenChange,
}: {
  /** 重命名目标;null 关闭。父级以 key 区分实例,切换时重挂重置输入。 */
  name: string | null;
  onOpenChange(open: boolean): void;
}): JSX.Element {
  const [renameValue, setRenameValue] = useState(name ?? '');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameSaving, setRenameSaving] = useState(false);
  const renameBusyRef = useRef(false);

  function closeRename(): void {
    if (renameBusyRef.current) return;
    onOpenChange(false);
  }

  async function confirmRename(): Promise<void> {
    if (!name || renameBusyRef.current) return;
    const newName = renameValue.trim();
    if (!newName || newName.length > 128 || /[\\/\u0000-\u001f]/u.test(newName) || newName === name) return;
    renameBusyRef.current = true;
    setRenameSaving(true);
    setRenameError(null);
    try {
      const renamed = await useSkillStore.getState().rename(name, newName);
      showToast(`已重命名为 ${renamed.name}`, { variant: 'success' });
      onOpenChange(false);
    } catch (error: unknown) {
      setRenameError(error instanceof Error ? error.message : '重命名失败');
    } finally {
      renameBusyRef.current = false;
      setRenameSaving(false);
    }
  }

  return (
    <Dialog
      open={name !== null}
      onOpenChange={(next) => { if (!next) closeRename(); }}
      title="重命名技能"
      description="名称会同步写入 SKILL.md frontmatter、目录名与本地索引。"
    >
      {renameError && <Callout variant="danger" className="mb-3">{renameError}</Callout>}
      <Field label="技能名称" required>
        <Input
          value={renameValue}
          maxLength={128}
          autoFocus
          disabled={renameSaving}
          error={renameValue.trim().length === 0}
          onChange={(event) => {
            setRenameValue(event.target.value);
            setRenameError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void confirmRename();
          }}
        />
      </Field>
      {/[\\/\u0000-\u001f]/u.test(renameValue) && (
        <Callout variant="danger" className="mt-3">技能名称不能包含斜杠、反斜杠或控制字符。</Callout>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={renameSaving} onClick={closeRename}>取消</Button>
        <Button
          variant="primary"
          size="sm"
          loading={renameSaving}
          disabled={!renameValue.trim()
            || renameValue.trim() === name
            || renameValue.trim().length > 128
            || /[\\/\u0000-\u001f]/u.test(renameValue)}
          onClick={() => void confirmRename()}
        >
          保存更改
        </Button>
      </div>
    </Dialog>
  );
}
