import React, { useEffect, useRef, useState } from 'react';
import {
  Badge, Button, Callout, Card, ConfirmDialog, Dialog, Field,
  Input, ScrollArea, Spinner, Switch, Tabs, Textarea, Tooltip,
} from '@ema-agent/ui';
import { useSkillStore, type MarketSkillEntry } from '../stores/skill-store.js';
import { skillsApi } from '../api/skills.js';
import type { GithubSkillCoords } from '@ema-agent/skill';
import { showToast } from '../lib/toast.js';
import { Markdown } from '../markdown/renderer.js';
import { MarketSourceManager } from './MarketSourceManager.js';

type InstallMode = 'text' | 'url' | null;

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ── Market view ───────────────────────────────────────────────────────────────

function MarketView({
  active,
  installedNames,
  onInstall,
}: {
  active:         boolean;
  installedNames: Set<string>;
  onInstall:      (url: string, name: string, coords?: GithubSkillCoords) => Promise<void>;
}): JSX.Element {
  const marketSkills  = useSkillStore((s) => s.marketSkills);
  const marketLoading = useSkillStore((s) => s.marketLoading);
  const marketError   = useSkillStore((s) => s.marketError);
  const marketSource  = useSkillStore((s) => s.marketSource);
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const attemptedRef = useRef(false);

  // Fetch once on first activation; ref guard avoids the retry-on-error loop.
  useEffect(() => {
    if (active && !attemptedRef.current) {
      attemptedRef.current = true;
      void useSkillStore.getState().listMarket();
    }
  }, [active]);

  async function handleInstall(entry: MarketSkillEntry): Promise<void> {
    setInstalling((prev) => new Set(prev).add(entry.name));
    try {
      // coords 透传给后端 bundle 安装(不丢 sibling assets)
      await onInstall(entry.url, entry.name, entry.coords);
    } finally {
      setInstalling((prev) => {
        const next = new Set(prev);
        next.delete(entry.name);
        return next;
      });
    }
  }

  if (marketLoading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="md" />
      </div>
    );
  }

  if (marketError) {
    return (
      <div className="flex flex-col gap-3">
        <Callout variant="danger">{marketError}</Callout>
        <Button variant="secondary" size="sm" className="self-start"
          onClick={() => void useSkillStore.getState().listMarket()}>
          重试
        </Button>
      </div>
    );
  }

  if (marketSkills.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-[var(--ema-text-tertiary)] gap-2">
        <span className="i-mdi:store-outline text-4xl opacity-40" aria-hidden />
        <p className="text-sm">市场暂无技能</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <MarketSourceManager kind="skill" />
      {marketSource && (
        <p className="text-xs text-[var(--ema-text-tertiary)] mb-1 font-mono truncate">来源：{marketSource}</p>
      )}
      {marketSkills.map((entry, i) => {
        const installed = installedNames.has(entry.name);
        return (
          <div
            key={entry.name}
            className="bg-[var(--ema-surface-1)] ema-glass-weak border-2 border-solid border-[var(--ema-border)] rounded-xl px-4 py-3 ema-card-decorate ema-card-decorate--diamond hover:border-[var(--ema-primary)]/30 hover:bg-[var(--ema-surface-2)] hover:shadow-[var(--ema-shadow-soft)]
                       ema-stagger-in"
            style={{ '--stagger-i': i } as React.CSSProperties}
          >
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-[var(--ema-text-primary)]">{entry.name}</span>
                  <Badge variant="neutral">v{entry.version}</Badge>
                  {entry.tags?.map((t) => (
                    <Badge key={t} variant="neutral">{t}</Badge>
                  ))}
                </div>
                {entry.description && (
                  <p className="text-xs text-[var(--ema-text-tertiary)] mt-1 line-clamp-2">{entry.description}</p>
                )}
                <p className="text-xs text-[var(--ema-text-tertiary)] mt-1 opacity-60">
                  {entry.author && `${entry.author} · `}
                  {entry.sizeBytes != null && formatBytes(entry.sizeBytes)}
                </p>
              </div>

              <div className="shrink-0 pt-0.5">
                {installed ? (
                  <Badge variant="success">已安装</Badge>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={installing.has(entry.name)}
                    disabled={installing.has(entry.name)}
                    onClick={() => void handleInstall(entry)}
                  >
                    安装
                  </Button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Installed list ────────────────────────────────────────────────────────────

function InstalledList({
  onRemove,
}: {
  onRemove: (name: string) => void;
}): JSX.Element {
  const skills  = useSkillStore((s) => s.skills);
  const loading = useSkillStore((s) => s.loading);

  const [viewing, setViewing]   = useState<string | null>(null);
  const [content, setContent]   = useState<string | null>(null);
  const [viewLoading, setViewLoading] = useState(false);

  async function handleView(name: string): Promise<void> {
    setViewing(name);
    setContent(null);
    setViewLoading(true);
    try {
      const res = await skillsApi.getContent(name);
      setContent(res.content);
    } catch (err) {
      showToast(`读取失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
      setViewing(null);
    } finally {
      setViewLoading(false);
    }
  }

  if (loading) {
    return <div className="flex justify-center py-10"><Spinner size="md" /></div>;
  }

  if (skills.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-[var(--ema-text-tertiary)] gap-2">
        <span className="i-mdi:puzzle-outline text-4xl opacity-40" aria-hidden />
        <p className="text-sm">暂无已安装技能</p>
        <p className="text-xs">切换到「浏览市场」或点击右上角安装</p>
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1" viewportClassName="pb-2">
      <div className="flex flex-col gap-2 pr-2">
        {skills.map((sk, i) => (
          <Card
            key={sk.name}
            variant="elevated"
            padding="sm"
            className="ema-stagger-in active:scale-[0.98] transition-all duration-[var(--ema-duration-base)] ema-card-decorate ema-card-decorate--diamond"
            style={{ '--stagger-i': i } as React.CSSProperties}
          >
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-[var(--ema-text-primary)]">{sk.name}</span>
                  <Badge variant="neutral">v{sk.version}</Badge>
                </div>
                {sk.description && (
                  <p className="text-xs text-[var(--ema-text-tertiary)] mt-1 line-clamp-2">{sk.description}</p>
                )}
                <p className="text-xs text-[var(--ema-text-tertiary)] opacity-60 mt-1">
                  安装于 {new Date(sk.installedAt).toLocaleDateString('zh-CN')} · {formatBytes(sk.sizeBytes)}
                </p>
              </div>

              <div className="flex items-center gap-3 shrink-0 pt-0.5">
                <Tooltip content="查看内容">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-primary)] px-1.5"
                    onClick={() => void handleView(sk.name)}
                  >
                    <span className="i-mdi:eye-outline text-base" aria-hidden />
                  </Button>
                </Tooltip>
                <Tooltip content={sk.enabled ? '禁用技能' : '启用技能'}>
                  <Switch
                    checked={sk.enabled}
                    label={sk.name}
                    onCheckedChange={(checked) => {
                      void useSkillStore.getState()
                        .setEnabled(sk.name, checked)
                        .catch((err: Error) => showToast(`更新失败: ${err.message}`, { variant: 'danger' }));
                    }}
                  />
                </Tooltip>
                <Tooltip content="卸载技能">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-[var(--ema-text-tertiary)] hover:text-[var(--ema-danger)] px-1.5"
                    onClick={() => void onRemove(sk.name)}
                  >
                    <span className="i-mdi:delete-outline text-base" aria-hidden />
                  </Button>
                </Tooltip>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Skill content viewer */}
      <Dialog
        open={viewing !== null}
        onOpenChange={(open) => { if (!open) { setViewing(null); setContent(null); } }}
        title={viewing ? `${viewing} · SKILL.md` : '技能内容'}
        description="技能定义的完整内容（含 frontmatter）"
        widthClass="max-w-3xl"
      >
        {viewLoading ? (
          <div className="flex justify-center py-12"><Spinner size="md" /></div>
        ) : (
          <div className="max-h-[60vh] overflow-auto rounded-lg p-3 selectable
                          bg-[var(--ema-surface-0)] border border-[var(--ema-border)]">
            <Markdown source={content ?? ''} />
          </div>
        )}
      </Dialog>
    </ScrollArea>
  );
}

// ── SkillsTab ─────────────────────────────────────────────────────────────────

export function SkillsTab(): JSX.Element {
  const skills      = useSkillStore((s) => s.skills);
  const error       = useSkillStore((s) => s.error);

  const [installMode,  setInstallMode]  = useState<InstallMode>(null);
  const [textContent,  setTextContent]  = useState('');
  const [urlInput,     setUrlInput]     = useState('');
  const [installing,   setInstalling]   = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [activeTab,    setActiveTab]    = useState<string>('installed');
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);

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

  async function handleInstallFromUrl(url: string, coords?: GithubSkillCoords): Promise<void> {
    const target = url || urlInput.trim();
    if (!target) return;
    setInstalling(true);
    setInstallError(null);
    try {
      const sk = await useSkillStore.getState().installFromUrl(target, coords);
      showToast(`已安装 ${sk.name}`, { variant: 'success' });
      closeDialog();
    } catch (err) {
      // Market installs run with the dialog closed, so installError is invisible
      // there — a toast guarantees the failure is always surfaced.
      const msg = err instanceof Error ? err.message : String(err);
      setInstallError(msg);
      showToast(`安装失败: ${msg}`, { variant: 'danger' });
    } finally {
      setInstalling(false);
    }
  }

  function handleRemove(name: string): void {
    setPendingRemove(name);
  }

  async function confirmRemove(): Promise<void> {
    if (!pendingRemove) return;
    const name = pendingRemove;
    setPendingRemove(null);
    try {
      await useSkillStore.getState().remove(name);
      showToast(`已卸载 ${name}`, { variant: 'success' });
    } catch (err) {
      showToast(`卸载失败: ${err instanceof Error ? err.message : String(err)}`, { variant: 'danger' });
    }
  }

  const installedNames = new Set(skills.map((s) => s.name));

  const tabItems = [
    {
      value:   'installed',
      label:   `已安装 (${skills.length})`,
      content: <InstalledList onRemove={handleRemove} />,
    },
    {
      value:   'market',
      label:   '浏览市场',
      content: (
        <MarketView
          active={activeTab === 'market'}
          installedNames={installedNames}
          onInstall={(url, _name, coords) => handleInstallFromUrl(url, coords)}
        />
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-start justify-between shrink-0">
        <div>
          <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">技能管理</h2>
          <p className="text-xs text-[var(--ema-text-tertiary)] mt-0.5">安装并管理自定义技能(Markdown 驱动，含工具权限白名单)</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => setInstallMode('url')}
            className="active:scale-[0.98] transition-all duration-[var(--ema-duration-base)]">
            从 URL 安装
          </Button>
          <Button variant="primary" size="sm" onClick={() => setInstallMode('text')}
            className="active:scale-[0.98] transition-all duration-[var(--ema-duration-base)]">
            从文本安装
          </Button>
        </div>
      </div>

      {error && <Callout variant="danger" className="shrink-0">{error}</Callout>}

      <Tabs
        value={activeTab}
        onChange={setActiveTab}
        items={tabItems}
        variant="underline"
      />

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
        description="输入技能 Markdown 文件的直链(GitHub raw、jsDelivr 等)。"
      >
        {installError && <Callout variant="danger" className="mb-3">{installError}</Callout>}
        <Field label="技能文件 URL" required>
          <Input
            placeholder="https://raw.githubusercontent.com/..."
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleInstallFromUrl(''); }}
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
            onClick={() => void handleInstallFromUrl('')}
          >安装</Button>
        </div>
      </Dialog>

      <ConfirmDialog
        open={!!pendingRemove}
        message={pendingRemove ? `确定卸载技能 "${pendingRemove}"？` : ''}
        confirmText="卸载"
        onConfirm={() => void confirmRemove()}
        onCancel={() => setPendingRemove(null)}
      />
    </div>
  );
}
