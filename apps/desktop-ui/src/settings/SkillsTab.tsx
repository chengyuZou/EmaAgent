import { useEffect, useState } from 'react';
import {
  Badge, Button, Callout, Card, Dialog, Field,
  Input, ScrollArea, Spinner, Switch, Textarea, Tooltip,
} from '@ema-agent/ui';
import { useSkillStore } from '../stores/skill-store.js';
import { showToast } from '../lib/toast.js';

type InstallMode = 'text' | 'url' | null;

export function SkillsTab(): JSX.Element {
  const skills  = useSkillStore((s) => s.skills);
  const loading = useSkillStore((s) => s.loading);
  const error   = useSkillStore((s) => s.error);

  const [installMode, setInstallMode]   = useState<InstallMode>(null);
  const [textContent, setTextContent]   = useState('');
  const [urlInput,    setUrlInput]      = useState('');
  const [installing,  setInstalling]    = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  useEffect(() => { void useSkillStore.getState().load(); }, []);

  function closeDialog(): void {
    setInstallMode(null);
    setInstallError(null);
    setTextContent('');
    setUrlInput('');
  }

  async function handleInstallFromText(): Promise<void> {
    if (!textContent.trim()) return;
    setInstalling(true);
    setInstallError(null);
    try {
      const sk = await useSkillStore.getState().installFromText(textContent);
      showToast(`已安装 ${sk.manifest.name}`, { variant: 'success' });
      closeDialog();
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  }

  async function handleInstallFromUrl(): Promise<void> {
    if (!urlInput.trim()) return;
    setInstalling(true);
    setInstallError(null);
    try {
      const sk = await useSkillStore.getState().installFromUrl(urlInput.trim());
      showToast(`已安装 ${sk.manifest.name}`, { variant: 'success' });
      closeDialog();
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  }

  async function handleRemove(name: string): Promise<void> {
    if (!confirm(`确定卸载技能 "${name}"？`)) return;
    try {
      await useSkillStore.getState().remove(name);
      showToast(`已卸载 ${name}`, { variant: 'success' });
    } catch (err) {
      showToast(`卸载失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-start justify-between shrink-0">
        <div>
          <h2 className="text-base font-semibold text-neutral-100">技能管理</h2>
          <p className="text-xs text-neutral-500 mt-0.5">安装并管理自定义技能(Markdown 驱动，含工具权限白名单)</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => setInstallMode('url')} className="active:scale-[0.98] transition-all duration-250">从 URL 安装</Button>
          <Button variant="primary"   size="sm" onClick={() => setInstallMode('text')} className="active:scale-[0.98] transition-all duration-250">从文本安装</Button>
        </div>
      </div>

      {error && <Callout variant="danger" className="shrink-0">{error}</Callout>}

      {/* Loading */}
      {loading && (
        <div className="flex justify-center py-10">
          <Spinner size="md" />
        </div>
      )}

      {/* Empty */}
      {!loading && skills.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-neutral-500 gap-2">
          <span className="i-mdi:puzzle-outline text-4xl opacity-40" />
          <p className="text-sm">暂无已安装技能</p>
          <p className="text-xs">点击"从文本安装"添加第一个技能</p>
        </div>
      )}

      {/* List */}
      {!loading && skills.length > 0 && (
        <ScrollArea className="flex-1" viewportClassName="pb-2">
          <div className="flex flex-col gap-2 pr-2">
            {skills.map((sk) => (
              <Card key={sk.manifest.name} variant="elevated" padding="sm" className="animate-slide-up active:scale-[0.98] transition-all duration-250" style={{ animationDelay: `${Math.min(parseInt(sk.manifest.name.length.toString(), 10) * 30, 300)}ms` }}>
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-neutral-100">{sk.manifest.name}</span>
                      <Badge variant="neutral">v{sk.manifest.version}</Badge>
                    </div>
                    {sk.manifest.description && (
                      <p className="text-xs text-neutral-400 mt-1 line-clamp-2">{sk.manifest.description}</p>
                    )}
                    <p className="text-xs text-neutral-600 mt-1">
                      安装于 {new Date(sk.installedAt).toLocaleDateString('zh-CN')}
                    </p>
                  </div>

                  <div className="flex items-center gap-3 shrink-0 pt-0.5">
                    <Tooltip content={sk.enabled ? '禁用技能' : '启用技能'}>
                      <Switch
                        checked={sk.enabled}
                        label={sk.manifest.name}
                        onCheckedChange={(checked) => {
                          void useSkillStore.getState()
                            .setEnabled(sk.manifest.name, checked)
                            .catch((err: Error) => showToast(`更新失败: ${err.message}`, { variant: 'danger' }));
                        }}
                      />
                    </Tooltip>
                    <Tooltip content="卸载技能">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-neutral-500 hover:text-red-400 px-1.5"
                        onClick={() => void handleRemove(sk.manifest.name)}
                      >
                        <span className="i-mdi:delete-outline text-base" aria-hidden />
                      </Button>
                    </Tooltip>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </ScrollArea>
      )}

      {/* Install from text */}
      <Dialog
        open={installMode === 'text'}
        onOpenChange={(open) => { if (!open) closeDialog(); }}
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

      {/* Install from URL */}
      <Dialog
        open={installMode === 'url'}
        onOpenChange={(open) => { if (!open) closeDialog(); }}
        title="从 URL 安装技能"
        description="输入技能 Markdown 文件的直链（GitHub raw、jsDelivr 等）。"
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
    </div>
  );
}
