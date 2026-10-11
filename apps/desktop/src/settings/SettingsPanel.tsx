import { useEffect, useState, type JSX } from 'react';
import { Button, Callout } from '@ema-agent/ui';
import { ErrorBoundary } from '../lib/error-boundary.js';
import { useMainNavigationStore } from '../layout/navigation.js';
import { CharactersTab } from './character/CharactersTab.js';
import { StorageTab } from './data/StorageTab.js';
import { ArchivedChatsTab } from './archive/archivedChatsTab.js';
import { ThemeTab } from './appearance/themeTab.js';
import { FontTab } from './appearance/fontTab.js';
import { WallpaperTab } from './appearance/wallpaperTab.js';
import { SecurityTab } from './security/SecurityTab.js';
import { McpMarketPage } from './mcp/McpMarketPage.js';
import { McpEnvironmentPage } from './mcp/McpEnvironmentPage.js';
import { McpServersPage } from './mcp/McpServersPage.js';
import { MemoryFilesTab } from './memory/MemoryFilesTab.js';
import { MemoryJobsTab } from './memory/MemoryJobsTab.js';
import { MemoryOverviewTab } from './memory/MemoryOverviewTab.js';
import { ParameterSettings } from './parameters/ParameterSettings.js';
import { BindingsTab } from './providers/BindingsTab.js';
import { ProvidersTab } from './providers/ProvidersTab.js';
import { SkillInstalledPage } from './skills/SkillInstalledPage.js';
import { SkillMarketPage } from './skills/SkillMarketPage.js';
import { SkillSettings } from './skills/SkillSettings.js';

type SettingsPageId =
  | 'providers'
  | 'bindings'
  | 'characters'
  | 'skills'
  | 'mcp'
  | 'memory'
  | 'storage'
  | 'archive'
  | 'security'
  | 'parameters'
  | 'appearance';

/** 子页 id: 一级页面 id 加子页后缀. */
type SettingsSubPageId =
  | 'memory-overview'
  | 'memory-files'
  | 'memory-jobs'
  | 'skills-installed'
  | 'skills-market'
  | 'skills-settings'
  | 'mcp-servers'
  | 'mcp-market'
  | 'mcp-environment'
  | 'appearance-theme'
  | 'appearance-fonts'
  | 'appearance-wallpapers';

interface SettingsSubPage {
  readonly id: SettingsSubPageId;
  readonly label: string;
}

interface SettingsPage {
  readonly id: SettingsPageId;
  readonly label: string;
  readonly icon: string;
  readonly fullHeight?: boolean;
  readonly subPages?: readonly SettingsSubPage[];
}

const SKILLS_SUB_PAGES: readonly SettingsSubPage[] = [
  { id: 'skills-installed', label: '已安装' },
  { id: 'skills-market', label: '技能市场' },
  { id: 'skills-settings', label: '设置' },
];

const MEMORY_SUB_PAGES: readonly SettingsSubPage[] = [
  { id: 'memory-overview', label: '概览' },
  { id: 'memory-files', label: '文件' },
  { id: 'memory-jobs', label: '后台任务' },
];

const MCP_SUB_PAGES: readonly SettingsSubPage[] = [
  { id: 'mcp-servers', label: '已配置' },
  { id: 'mcp-market', label: 'MCP 市场' },
  { id: 'mcp-environment', label: '运行环境' },
];

const APPEARANCE_SUB_PAGES: readonly SettingsSubPage[] = [
  { id: 'appearance-theme', label: '主题' },
  { id: 'appearance-wallpapers', label: '壁纸' },
  { id: 'appearance-fonts', label: '字体' },
];

const SETTINGS_PAGES: readonly SettingsPage[] = [
  { id: 'providers', label: '服务来源', icon: 'i-lucide:server' },
  { id: 'bindings', label: '模型绑定', icon: 'i-lucide:link-2' },
  { id: 'characters', label: '角色卡', icon: 'i-lucide:user-round' },
  { id: 'skills', label: '技能库', icon: 'i-lucide:blocks', subPages: SKILLS_SUB_PAGES },
  { id: 'mcp', label: 'MCP 服务器', icon: 'i-lucide:plug', subPages: MCP_SUB_PAGES },
  { id: 'memory', label: 'Memory', icon: 'i-lucide:library', subPages: MEMORY_SUB_PAGES },
  { id: 'storage', label: '存储位置', icon: 'i-lucide:hard-drive', fullHeight: true },
  { id: 'archive', label: '归档聊天', icon: 'i-lucide:archive' },
  { id: 'security', label: '安全', icon: 'i-lucide:shield-check' },
  { id: 'parameters', label: '参数设置', icon: 'i-lucide:sliders-horizontal' },
  { id: 'appearance', label: '外观', icon: 'i-lucide:palette', subPages: APPEARANCE_SUB_PAGES },
];



export type SettingsTabId = SettingsPageId | SettingsSubPageId;

function pageOf(id: SettingsTabId): SettingsPage {
  for (const page of SETTINGS_PAGES) {
    if (page.id === id || page.subPages?.some(sub => sub.id === id)) {
      return page;
    }
  }
  return SETTINGS_PAGES[0]!;
}

export function SettingsPanel(): JSX.Element {
  const active = useMainNavigationStore(state => state.settingsTab);
  const setActive = useMainNavigationStore(state => state.setSettingsTab);
  const [expandedPage, setExpandedPage] = useState<SettingsPageId | null>(null);
  const activePage = pageOf(active);
  useEffect(() => {
    // 返回或前进到子页时, 同时展开它所属的导航分组.
    setExpandedPage(activePage.subPages ? activePage.id : null);
  }, [active, activePage]);
  const memoryFilesOpen = active === 'memory-files';
  let contentLayout = 'overflow-y-auto px-5 py-5 md:px-8 md:py-6';
  if (activePage.fullHeight) {
    contentLayout = 'overflow-hidden';
  } else if (memoryFilesOpen) {
    contentLayout = 'flex min-h-0 flex-col overflow-hidden px-5 py-5 md:px-8 md:py-6';
  }

  return (
    <ErrorBoundary>
      <div className="relative flex h-full text-[var(--ema-text-primary)]">
        <nav
          className="ema-settings-sidebar relative z-10 flex w-56 flex-none flex-col overflow-y-auto border-r border-[var(--ema-border)] px-2 py-4"
          aria-label="设置导航"
        >
          <p className="px-3 pb-4 text-base font-semibold">设置</p>
          {SETTINGS_PAGES.map(page => {
            const pageActive = activePage.id === page.id;
            const expandable = page.subPages !== undefined;
            const expanded = expandedPage === page.id;
            return (
              <div key={page.id}>
                <NavButton
                  active={pageActive}
                  expandable={expandable}
                  expanded={expanded}
                  icon={page.icon}
                  label={page.label}
                  onClick={() => {
                    if (!page.subPages) {
                      setActive(page.id);
                      setExpandedPage(null);
                      return;
                    }
                    if (expanded) {
                      setExpandedPage(null);
                      return;
                    }
                    setExpandedPage(page.id);
                    if (!page.subPages.some(sub => sub.id === active)) {
                      setActive(page.subPages[0]!.id);
                    }
                  }}
                />
                {page.subPages && (
                  <div
                    className={`grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-out ${expanded ? 'grid-rows-[1fr] opacity-100' : 'pointer-events-none grid-rows-[0fr] opacity-0'}`}
                    aria-hidden={!expanded}
                  >
                    <div className="min-h-0 overflow-hidden">
                      {page.subPages.map(sub => (
                        <SubNavButton
                          key={sub.id}
                          active={active === sub.id}
                          expanded={expanded}
                          label={sub.label}
                          onClick={() => setActive(sub.id)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <main
          key={active}
          className={`relative z-10 min-w-0 flex-1 ema-slide-right ema-settings-material-page ${contentLayout}`}
          id="settings-scroll-container"
        >
          <SettingsContent id={active} />
        </main>

        <div
          className="pointer-events-none absolute bottom-0 -right-6 z-0 hidden md:block"
          aria-hidden
        >
          <span
            key={active}
            className={`${activePage.icon} ema-watermark-in block text-[15rem] leading-none text-[var(--ema-text-tertiary)]`}
          />
        </div>
      </div>
    </ErrorBoundary>
  );
}

function NavButton(props: {
  active: boolean;
  expandable: boolean;
  expanded: boolean;
  icon: string;
  label: string;
  onClick(): void;
}): JSX.Element {
  return (
    <Button
      variant="ghost"
      data-selected={props.active || undefined}
      className={`w-full justify-start gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors ${props.active ? 'ema-selectable' : 'text-[var(--ema-text-tertiary)] hover:bg-[var(--ema-surface-2)]/50 hover:text-[var(--ema-text-primary)]'}`}
      onClick={props.onClick}
      aria-current={props.active ? 'page' : undefined}
      aria-expanded={props.expandable ? props.expanded : undefined}
    >
      <span className={`${props.icon} shrink-0 text-base`} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-left">{props.label}</span>
      {props.expandable && (
        <span
          className={`i-lucide:chevron-right shrink-0 text-sm transition-transform duration-200 ${props.expanded ? 'rotate-90' : ''}`}
          aria-hidden
        />
      )}
    </Button>
  );
}

function SubNavButton(props: {
  active: boolean;
  expanded: boolean;
  label: string;
  onClick(): void;
}): JSX.Element {
  return (
    <Button
      variant="ghost"
      data-selected={props.active || undefined}
      className={`mt-0.5 w-full justify-start rounded-lg py-1 pl-9 pr-3 text-xs transition-colors ${props.active ? 'ema-selectable' : 'text-[var(--ema-text-tertiary)] hover:bg-[var(--ema-surface-2)]/50 hover:text-[var(--ema-text-primary)]'}`}
      onClick={props.onClick}
      tabIndex={props.expanded ? 0 : -1}
      aria-current={props.active ? 'page' : undefined}
    >
      <span className="min-w-0 flex-1 truncate text-left">{props.label}</span>
    </Button>
  );
}

function SettingsContent({ id }: { id: SettingsTabId }): JSX.Element {
  switch (id) {
    case 'providers':
      return <ProvidersTab />;
    case 'bindings':
      return <BindingsTab />;
    case 'characters':
      return <CharactersTab />;
    case 'skills-installed':
    case 'skills':
      return <SkillInstalledPage />;
    case 'skills-market':
      return <SkillMarketPage />;
    case 'skills-settings':
      return <SkillSettings />;
    case 'mcp-servers':
    case 'mcp':
      return <McpServersPage />;
    case 'mcp-market':
      return <McpMarketPage />;
    case 'mcp-environment':
      return <McpEnvironmentPage />;
    case 'memory':
    case 'memory-overview':
      return <MemoryOverviewTab />;
    case 'memory-files':
      return <MemoryFilesTab />;
    case 'memory-jobs':
      return <MemoryJobsTab />;
    case 'storage':
      return <StorageTab />;
    case 'archive':
      return <ArchivedChatsTab />;
    case 'security':
      return <SecurityTab />;
    case 'parameters':
      return <ParameterSettings />;
    case 'appearance':
    case 'appearance-theme':
      return <ThemeTab />;
    case 'appearance-wallpapers':
      return <WallpaperTab />;
    case 'appearance-fonts':
      return <FontTab />;
    default:
      return <Callout variant="info">没有找到该设置页面.</Callout>;
  }
}
