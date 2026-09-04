// 组织十一个已定稿的设置业务入口, 不再读取后端 UI 目录或生成通用表单.
// 有并列子业务的模块(技能库与 MCP)由一级入口展开或收起二级导航.
import { useEffect, useState, type JSX } from 'react';
import { Button, Callout, Select } from '@ema-agent/ui';
import { ErrorBoundary } from '../lib/error-boundary.js';
import { mountSystemEvents } from '../lib/system-sse.js';
import { useCharacterStore } from '../stores/character.js';
import { useMcpStore } from '../stores/mcp.js';
import { useProviderStore } from '../stores/provider.js';
import { useSettingsStore } from '../stores/settings.js';
import { useSkillStore } from '../stores/skill.js';
import { useThemeSync } from '../stores/theme.js';
import { CharactersTab } from './character/CharactersTab.js';
import { StorageTab } from './data/StorageTab.js';
import { AppearanceTab } from './general/AppearanceTab.js';
import { GeneralTab } from './general/GeneralTab.js';
import { KnowledgeBaseTab } from './knowledge/KnowledgeBaseTab.js';
import { McpMarketPage } from './mcp/McpMarketPage.js';
import { McpEnvironmentPage } from './mcp/McpEnvironmentPage.js';
import { McpServersPage } from './mcp/McpServersPage.js';
import { MemoryTab } from './memory/MemoryTab.js';
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
  | 'memory-files'
  | 'knowledge-base'
  | 'storage'
  | 'notifications'
  | 'parameters'
  | 'appearance';

/** 子页 id: 一级页面 id 加子页后缀。 */
type SettingsSubPageId =
  | 'skills-installed'
  | 'skills-market'
  | 'skills-settings'
  | 'mcp-servers'
  | 'mcp-market'
  | 'mcp-environment';

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

const MCP_SUB_PAGES: readonly SettingsSubPage[] = [
  { id: 'mcp-servers', label: '已配置' },
  { id: 'mcp-market', label: 'MCP 市场' },
  { id: 'mcp-environment', label: '运行环境' },
];

const SETTINGS_PAGES: readonly SettingsPage[] = [
  { id: 'providers', label: '服务来源', icon: 'i-lucide:server' },
  { id: 'bindings', label: '模型绑定', icon: 'i-lucide:link-2' },
  { id: 'characters', label: '角色卡', icon: 'i-lucide:user-round' },
  { id: 'skills', label: '技能库', icon: 'i-lucide:blocks', subPages: SKILLS_SUB_PAGES },
  { id: 'mcp', label: 'MCP 服务器', icon: 'i-lucide:plug', subPages: MCP_SUB_PAGES },
  { id: 'memory-files', label: 'Memory 文件', icon: 'i-lucide:library' },
  { id: 'knowledge-base', label: '知识库', icon: 'i-lucide:database' },
  { id: 'storage', label: '存储位置', icon: 'i-lucide:hard-drive', fullHeight: true },
  { id: 'notifications', label: '通知与环境', icon: 'i-lucide:bell' },
  { id: 'parameters', label: '参数设置', icon: 'i-lucide:sliders-horizontal' },
  { id: 'appearance', label: '外观', icon: 'i-lucide:palette' },
];

/** 当前选中的导航目标:一级页或子页。 */
type ActiveNav = SettingsPageId | SettingsSubPageId;

function pageOf(id: ActiveNav): SettingsPage {
  for (const page of SETTINGS_PAGES) {
    if (page.id === id) return page;
    if (page.subPages?.some(sub => sub.id === id)) return page;
  }
  return SETTINGS_PAGES[0]!;
}

export function SettingsPanel(): JSX.Element {
  useThemeSync();
  const [active, setActive] = useState<ActiveNav>('providers');
  const [expandedPage, setExpandedPage] = useState<SettingsPageId | null>(null);
  const activePage = pageOf(active);

  useEffect(() => mountSystemEvents({ ownsConnection: false }), []);
  useEffect(() => {
    void useProviderStore.getState().loadAll();
    void useSettingsStore.getState().refreshDesktopSettings().catch(() => {});
    void useCharacterStore.getState().load();
    void useSkillStore.getState().load();
    void useMcpStore.getState().load();
  }, []);

  const mobileOptions = SETTINGS_PAGES.flatMap(page =>
    page.subPages
      ? page.subPages.map(sub => ({ value: sub.id as string, label: `${page.label} · ${sub.label}` }))
      : [{ value: page.id as string, label: page.label }],
  );

  return (
    <ErrorBoundary>
      <div className="fixed inset-0 flex bg-[var(--ema-bg)] text-[var(--ema-text-primary)]">
        <nav className="hidden w-56 flex-none flex-col overflow-y-auto border-r border-[var(--ema-border)] px-2 py-4 md:flex" aria-label="设置导航">
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
                    if (!page.subPages.some(sub => sub.id === active)) setActive(page.subPages[0]!.id);
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
          className={`relative z-10 min-w-0 flex-1 ema-slide-right ${activePage.fullHeight ? 'overflow-hidden' : 'overflow-y-auto px-5 py-5 md:px-8 md:py-6'}`}
          id="settings-scroll-container"
        >
          <div className={`mb-5 md:hidden ${activePage.fullHeight ? 'px-5 pt-5' : ''}`}>
            <Select
              value={active}
              options={mobileOptions}
              onChange={value => setActive(value as ActiveNav)}
              aria-label="设置页面"
            />
          </div>
          <SettingsContent id={active} />
        </main>

        <div className="pointer-events-none fixed bottom-4 right-8 z-0 hidden md:block" aria-hidden>
          <span className={`${activePage.icon} text-[12rem] leading-none text-[var(--ema-text-tertiary)] opacity-[0.12]`} />
        </div>
      </div>
    </ErrorBoundary>
  );
}

function NavButton(props: { active: boolean; expandable: boolean; expanded: boolean; icon: string; label: string; onClick(): void }): JSX.Element {
  return (
    <Button
      variant="ghost"
      className={`w-full justify-start gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors ${props.active ? 'ema-active-rail bg-[var(--ema-primary-muted)] text-[var(--ema-primary)]' : 'text-[var(--ema-text-tertiary)] hover:bg-[var(--ema-surface-2)]/50 hover:text-[var(--ema-text-primary)]'}`}
      onClick={props.onClick}
      aria-current={props.active ? 'page' : undefined}
      aria-expanded={props.expandable ? props.expanded : undefined}
    >
      <span className={`${props.icon} shrink-0 text-base`} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-left">{props.label}</span>
      {props.expandable && <span className={`i-lucide:chevron-right shrink-0 text-sm transition-transform duration-200 ${props.expanded ? 'rotate-90' : ''}`} aria-hidden />}
    </Button>
  );
}

/** 二级导航:缩进小字,无图标,激活态与一级同一条左侧 rail。 */
function SubNavButton(props: { active: boolean; expanded: boolean; label: string; onClick(): void }): JSX.Element {
  return (
    <Button
      variant="ghost"
      className={`mt-0.5 w-full justify-start rounded-lg py-1 pl-9 pr-3 text-xs transition-colors ${props.active ? 'ema-active-rail bg-[var(--ema-primary-muted)] text-[var(--ema-primary)]' : 'text-[var(--ema-text-tertiary)] hover:bg-[var(--ema-surface-2)]/50 hover:text-[var(--ema-text-primary)]'}`}
      onClick={props.onClick}
      tabIndex={props.expanded ? 0 : -1}
      aria-current={props.active ? 'page' : undefined}
    >
      <span className="min-w-0 flex-1 truncate text-left">{props.label}</span>
    </Button>
  );
}

function SettingsContent({ id }: { id: ActiveNav }): JSX.Element {
  switch (id) {
    case 'providers': return <ProvidersTab />;
    case 'bindings': return <BindingsTab />;
    case 'characters': return <CharactersTab />;
    case 'skills-installed':
    case 'skills': return <SkillInstalledPage />;
    case 'skills-market': return <SkillMarketPage />;
    case 'skills-settings': return <SkillSettings />;
    case 'mcp-servers':
    case 'mcp': return <McpServersPage />;
    case 'mcp-market': return <McpMarketPage />;
    case 'mcp-environment': return <McpEnvironmentPage />;
    case 'memory-files': return <MemoryTab />;
    case 'knowledge-base': return <KnowledgeBaseTab />;
    case 'storage': return <StorageTab />;
    case 'notifications': return <GeneralTab />;
    case 'parameters': return <ParameterSettings />;
    case 'appearance': return <AppearanceTab />;
    default: return <Callout variant="info">没有找到该设置页面.</Callout>;
  }
}
