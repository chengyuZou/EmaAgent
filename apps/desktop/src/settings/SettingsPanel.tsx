// 组织后端目录驱动的参数导航与 Provider、角色、Memory 等专属管理页面。
import { useEffect, useMemo, useState, type JSX } from 'react';
import { Button, Callout, Input, Select } from '@ema-agent/ui';
import { useShallow } from 'zustand/react/shallow';
import { ErrorBoundary } from '../lib/error-boundary.js';
import { mountSystemEvents } from '../lib/system-sse.js';
import { useCharacterStore } from '../stores/character.js';
import { useKnowledgeStore, selectIngestSummary } from '../stores/knowledge.js';
import { useMcpStore } from '../stores/mcp.js';
import { useProviderStore } from '../stores/provider.js';
import { useSettingsStore } from '../stores/settings.js';
import { useSkillStore } from '../stores/skill.js';
import { useThemeSync } from '../stores/theme.js';
import { SettingCatalogPage, SettingSearchResults } from './catalog/SettingCatalogPage.js';
import { buildSettingDomains, searchSettingItems } from './catalog/settingCatalog.js';
import { useSettingCatalog } from './catalog/useSettingCatalog.js';
import { CharactersTab } from './character/CharactersTab.js';
import { StorageTab } from './data/StorageTab.js';
import { AppearanceTab } from './general/AppearanceTab.js';
import { GeneralTab } from './general/GeneralTab.js';
import { KnowledgeBaseTab } from './knowledge/KnowledgeBaseTab.js';
import { McpTab } from './mcp/McpTab.js';
import { MemoryTab } from './memory/MemoryTab.js';
import { BindingsTab } from './providers/BindingsTab.js';
import { ProvidersTab } from './providers/ProvidersTab.js';
import { SkillsTab } from './skills/SkillsTab.js';

interface ManagementPage {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly fullHeight?: boolean;
}

const MANAGEMENT_PAGES: readonly ManagementPage[] = [
  { id: 'providers', label: '服务来源', icon: 'i-lucide:server' },
  { id: 'bindings', label: '模型绑定', icon: 'i-lucide:link-2' },
  { id: 'characters', label: '角色卡', icon: 'i-lucide:user-round' },
  { id: 'skills', label: '技能库', icon: 'i-lucide:blocks' },
  { id: 'mcp', label: 'MCP 服务器', icon: 'i-lucide:plug' },
  { id: 'memory-files', label: 'Memory 文件', icon: 'i-lucide:library' },
  { id: 'knowledge-base', label: '知识库', icon: 'i-lucide:database' },
  { id: 'storage', label: '存储位置', icon: 'i-lucide:hard-drive', fullHeight: true },
  { id: 'notifications', label: '通知与环境', icon: 'i-lucide:bell' },
  { id: 'appearance', label: '外观', icon: 'i-lucide:palette' },
];

function KbNavIndicator(): JSX.Element | null {
  const summary = useKnowledgeStore(useShallow(selectIngestSummary));
  if (summary.state === 'idle') return null;
  if (summary.state === 'running') {
    return <span className="ema-scale-in shrink-0 font-mono text-[10px] text-[var(--ema-info)]">{summary.done}/{summary.total}</span>;
  }
  const color = summary.state === 'failed' ? 'var(--ema-danger)' : 'var(--ema-info)';
  return <span className="ema-scale-in size-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden />;
}

export function SettingsPanel(): JSX.Element {
  useThemeSync();
  const catalog = useSettingCatalog();
  const domains = useMemo(() => buildSettingDomains(catalog.items), [catalog.items]);
  const [activePage, setActivePage] = useState('catalog:agent');
  const [query, setQuery] = useState('');
  const searchResults = useMemo(() => searchSettingItems(catalog.items, query), [catalog.items, query]);

  useEffect(() => mountSystemEvents({ ownsConnection: false }), []);
  useEffect(() => {
    void useProviderStore.getState().loadAll();
    void useSettingsStore.getState().refreshDesktopSettings().catch(() => {});
    void useCharacterStore.getState().load();
    void useSkillStore.getState().load();
    void useMcpStore.getState().load();
    void useKnowledgeStore.getState().loadIngestTasks();
  }, []);

  useEffect(() => {
    if (domains.length === 0 || domains.some((domain) => `catalog:${domain.id}` === activePage)) return;
    if (activePage.startsWith('catalog:')) setActivePage(`catalog:${domains[0]!.id}`);
  }, [activePage, domains]);

  const activeDomain = activePage.startsWith('catalog:')
    ? domains.find((domain) => `catalog:${domain.id}` === activePage)
    : undefined;
  const activeManagement = MANAGEMENT_PAGES.find((page) => page.id === activePage);
  const needsCatalog = query.trim().length > 0 || activeDomain !== undefined;
  const activeIcon = activeDomain?.icon ?? activeManagement?.icon ?? 'i-lucide:settings';
  const mobileOptions = [
    ...domains.map((domain) => ({ value: `catalog:${domain.id}`, label: domain.label })),
    ...MANAGEMENT_PAGES.map((page) => ({ value: page.id, label: page.label })),
  ];

  return (
    <ErrorBoundary>
      <div className="fixed inset-0 flex bg-[var(--ema-bg)] text-[var(--ema-text-primary)]">
        <nav className="hidden w-56 flex-none flex-col overflow-y-auto border-r border-[var(--ema-border)] px-2 py-4 md:flex" aria-label="设置导航">
          <p className="px-3 pb-3 text-base font-semibold">设置</p>
          <div className="px-2 pb-4">
            <Input inputSize="sm" value={query} placeholder="搜索名称、说明或 key" aria-label="搜索设置" onChange={(event) => setQuery(event.target.value)} />
          </div>

          <NavHeading>参数</NavHeading>
          {domains.map((domain) => (
            <NavButton
              key={domain.id}
              active={!query.trim() && activePage === `catalog:${domain.id}`}
              icon={domain.icon}
              label={domain.label}
              onClick={() => {
                setQuery('');
                setActivePage(`catalog:${domain.id}`);
              }}
            />
          ))}

          <NavHeading className="mt-4">管理</NavHeading>
          {MANAGEMENT_PAGES.map((page) => (
            <NavButton
              key={page.id}
              active={!query.trim() && activePage === page.id}
              icon={page.icon}
              label={page.label}
              trailing={page.id === 'knowledge-base' ? <KbNavIndicator /> : undefined}
              onClick={() => {
                setQuery('');
                setActivePage(page.id);
              }}
            />
          ))}
        </nav>

        <main
          key={query.trim() ? 'search' : activePage}
          className={`relative z-10 min-w-0 flex-1 ema-slide-right ${activeManagement?.fullHeight ? 'overflow-hidden' : 'overflow-y-auto px-5 py-5 md:px-8 md:py-6'}`}
          id="settings-scroll-container"
        >
          <div className="mb-5 space-y-3 md:hidden">
            <Select value={activePage} options={mobileOptions} onChange={(value) => { setQuery(''); setActivePage(value); }} aria-label="设置页面" />
            <Input value={query} placeholder="搜索名称、说明或 key" aria-label="搜索设置" onChange={(event) => setQuery(event.target.value)} />
          </div>

          {needsCatalog && catalog.loading ? (
            <div className="flex h-48 items-center justify-center text-sm text-[var(--ema-text-tertiary)]">
              <span className="i-svg-spinners:ring-resize mr-2" aria-hidden />读取设置…
            </div>
          ) : needsCatalog && catalog.error ? (
            <div className="mx-auto max-w-3xl">
              <Callout variant="danger">设置目录读取失败：{catalog.error}</Callout>
              <Button className="mt-3" variant="ghost" onClick={() => void catalog.reload()}>重新读取</Button>
            </div>
          ) : query.trim() ? (
            <SettingSearchResults query={query.trim()} items={searchResults} values={catalog.values} onSave={catalog.save} onReset={catalog.reset} />
          ) : activeDomain ? (
            <SettingCatalogPage domain={activeDomain} values={catalog.values} onSave={catalog.save} onReset={catalog.reset} />
          ) : (
            <ManagementContent id={activePage} />
          )}
        </main>

        <div className="pointer-events-none fixed bottom-4 right-8 z-0 hidden md:block" aria-hidden>
          <span className={`${activeIcon} text-[12rem] leading-none text-[var(--ema-text-tertiary)] opacity-[0.12]`} />
        </div>
      </div>
    </ErrorBoundary>
  );
}

function NavHeading({ children, className = '' }: { children: string; className?: string }): JSX.Element {
  return <p className={`px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--ema-text-tertiary)] ${className}`}>{children}</p>;
}

function NavButton({
  active,
  icon,
  label,
  trailing,
  onClick,
}: {
  active: boolean;
  icon: string;
  label: string;
  trailing?: JSX.Element;
  onClick(): void;
}): JSX.Element {
  return (
    <Button
      variant="ghost"
      className={`w-full justify-start gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors ${active ? 'ema-active-rail bg-[var(--ema-primary-muted)] text-[var(--ema-primary)]' : 'text-[var(--ema-text-tertiary)] hover:bg-[var(--ema-surface-2)]/50 hover:text-[var(--ema-text-primary)]'}`}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
    >
      <span className={`${icon} shrink-0 text-base`} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {trailing}
    </Button>
  );
}

function ManagementContent({ id }: { id: string }): JSX.Element {
  switch (id) {
    case 'providers': return <ProvidersTab />;
    case 'bindings': return <BindingsTab />;
    case 'characters': return <CharactersTab />;
    case 'skills': return <SkillsTab />;
    case 'mcp': return <McpTab />;
    case 'memory-files': return <MemoryTab />;
    case 'knowledge-base': return <KnowledgeBaseTab />;
    case 'storage': return <StorageTab />;
    case 'notifications': return <GeneralTab />;
    case 'appearance': return <AppearanceTab />;
    default: return <Callout variant="info">没有找到该设置页面。</Callout>;
  }
}
