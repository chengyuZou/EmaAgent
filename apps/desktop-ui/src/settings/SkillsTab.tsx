// 展示已安装与市场 Skill，并提供安装、查看、启停、重命名和卸载操作。
import React, { useEffect, useRef, useState } from 'react';
import {
  Badge, Button, Callout, Card, ConfirmDialog, Dialog, EmptyState, Field, MarketCard,
  Input, ScrollArea, Spinner, Switch, Tabs, Textarea, Tooltip,
} from '@ema-agent/ui';
import { useSkillStore, type MarketSkillEntry } from '../stores/skill-store.js';
import { skillsApi } from '../api/skills.js';
import type { GithubSkillCoords } from '@ema-agent/skills';
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
  onInstall:      (
    url: string,
    name: string,
    coords?: GithubSkillCoords,
    sha256?: string,
  ) => Promise<void>;
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
    if (!entry.sha256) {
      showToast(
        `无法安装 ${entry.name}：该市场源没有发布完整 Bundle SHA-256，请改用带校验清单的源。`,
        { variant: 'danger' },
      );
      return;
    }
    setInstalling((prev) => new Set(prev).add(entry.name));
    try {
      // 摘要只由市场清单提供；UI 不读取资源或自行构造完整性声明。
      await onInstall(entry.url, entry.name, entry.coords, entry.sha256);
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
      <EmptyState icon="i-mdi:store-outline" title="市场暂无技能" className="py-16" />
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
          <MarketCard
            key={entry.name}
            index={i}
            decorate="ema-card-decorate--diamond"
            installed={installed}
            installing={installing.has(entry.name)}
            installLabel="安装"
            installedLabel="已安装"
            onInstall={() => void handleInstall(entry)}
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-[var(--ema-text-primary)]">{entry.name}</span>
              <Badge variant="neutral">v{entry.version}</Badge>
              {!entry.sha256 && <Badge variant="warn">未锁定</Badge>}
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
          </MarketCard>
        );
      })}
    </div>
  );
}

// ── Installed list ────────────────────────────────────────────────────────────

function InstalledList({
  onRemove,
  onRename,
}: {
  onRemove: (name: string) => void;
  onRename: (name: string) => void;
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
      <EmptyState icon="i-mdi:puzzle-outline" title="暂无已安装技能" hint="切换到「浏览市场」或点击右上角安装" className="py-16" />
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
                <Tooltip content={sk.source === 'builtin' ? '内置技能不可重命名' : '重命名技能'}>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={sk.source === 'builtin'}
                    className="text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-primary)] px-1.5"
                    onClick={() => onRename(sk.name)}
                  >
                    <span className="i-mdi:pencil-outline text-base" aria-hidden />
                  </Button>
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
  const [pendingRename, setPendingRename] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameSaving, setRenameSaving] = useState(false);
  const renameBusyRef = useRef(false);

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

  async function handleInstallFromUrl(
    url: string,
    coords?: GithubSkillCoords,
    sha256?: string,
  ): Promise<void> {
    const target = url || urlInput.trim();
    if (!target) return;
    setInstalling(true);
    setInstallError(null);
    try {
      const sk = await useSkillStore.getState().installFromUrl(target, coords, sha256);
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

  function openRename(name: string): void {
    setPendingRename(name);
    setRenameValue(name);
    setRenameError(null);
  }

  function closeRename(): void {
    if (renameBusyRef.current) return;
    setPendingRename(null);
    setRenameValue('');
    setRenameError(null);
  }

  async function confirmRename(): Promise<void> {
    if (!pendingRename || renameBusyRef.current) return;
    const newName = renameValue.trim();
    if (!newName || newName.length > 128 || /[\\/\u0000-\u001f]/u.test(newName) || newName === pendingRename) return;
    renameBusyRef.current = true;
    setRenameSaving(true);
    setRenameError(null);
    try {
      const renamed = await useSkillStore.getState().rename(pendingRename, newName);
      showToast(`已重命名为 ${renamed.name}`, { variant: 'success' });
      setPendingRename(null);
      setRenameValue('');
    } catch (error: unknown) {
      setRenameError(error instanceof Error ? error.message : '重命名失败');
    } finally {
      renameBusyRef.current = false;
      setRenameSaving(false);
    }
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
      content: <InstalledList onRemove={handleRemove} onRename={openRename} />,
    },
    {
      value:   'market',
      label:   '浏览市场',
      content: (
        <MarketView
          active={activeTab === 'market'}
          installedNames={installedNames}
          onInstall={(url, _name, coords, sha256) =>
            handleInstallFromUrl(url, coords, sha256)}
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

      <Dialog
        open={pendingRename !== null}
        onOpenChange={(open) => { if (!open) closeRename(); }}
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
              || renameValue.trim() === pendingRename
              || renameValue.trim().length > 128
              || /[\\/\u0000-\u001f]/u.test(renameValue)}
            onClick={() => void confirmRename()}
          >
            保存更改
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
