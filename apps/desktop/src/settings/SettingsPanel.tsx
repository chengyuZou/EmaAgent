// 组织十一个已定稿的设置业务入口, 不再读取后端 UI 目录或生成通用表单.
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
import { McpTab } from './mcp/McpTab.js';
import { MemoryTab } from './memory/MemoryTab.js';
import { ParameterSettings } from './parameters/ParameterSettings.js';
import { BindingsTab } from './providers/BindingsTab.js';
import { ProvidersTab } from './providers/ProvidersTab.js';
import { SkillsTab } from './skills/SkillsTab.js';

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

interface SettingsPage {
  readonly id: SettingsPageId;
  readonly label: string;
  readonly icon: string;
  readonly fullHeight?: boolean;
}

const SETTINGS_PAGES: readonly SettingsPage[] = [
  { id: 'providers', label: '服务来源', icon: 'i-lucide:server' },
  { id: 'bindings', label: '模型绑定', icon: 'i-lucide:link-2' },
  { id: 'characters', label: '角色卡', icon: 'i-lucide:user-round' },
  { id: 'skills', label: '技能库', icon: 'i-lucide:blocks' },
  { id: 'mcp', label: 'MCP 服务器', icon: 'i-lucide:plug' },
  { id: 'memory-files', label: 'Memory 文件', icon: 'i-lucide:library' },
  { id: 'knowledge-base', label: '知识库', icon: 'i-lucide:database' },
  { id: 'storage', label: '存储位置', icon: 'i-lucide:hard-drive', fullHeight: true },
  { id: 'notifications', label: '通知与环境', icon: 'i-lucide:bell' },
  { id: 'parameters', label: '参数设置', icon: 'i-lucide:sliders-horizontal' },
  { id: 'appearance', label: '外观', icon: 'i-lucide:palette' },
];

export function SettingsPanel(): JSX.Element {
  useThemeSync();
  const [activePage, setActivePage] = useState<SettingsPageId>('providers');
  const active = SETTINGS_PAGES.find(page => page.id === activePage) ?? SETTINGS_PAGES[0]!;

  useEffect(() => mountSystemEvents({ ownsConnection: false }), []);
  useEffect(() => {
    void useProviderStore.getState().loadAll();
    void useSettingsStore.getState().refreshDesktopSettings().catch(() => {});
    void useCharacterStore.getState().load();
    void useSkillStore.getState().load();
    void useMcpStore.getState().load();
  }, []);

  return (
    <ErrorBoundary>
      <div className="fixed inset-0 flex bg-[var(--ema-bg)] text-[var(--ema-text-primary)]">
        <nav className="hidden w-56 flex-none flex-col overflow-y-auto border-r border-[var(--ema-border)] px-2 py-4 md:flex" aria-label="设置导航">
          <p className="px-3 pb-4 text-base font-semibold">设置</p>
          {SETTINGS_PAGES.map(page => (
            <NavButton key={page.id} active={activePage === page.id} icon={page.icon} label={page.label} onClick={() => setActivePage(page.id)} />
          ))}
        </nav>

        <main
          key={activePage}
          className={`relative z-10 min-w-0 flex-1 ema-slide-right ${active.fullHeight ? 'overflow-hidden' : 'overflow-y-auto px-5 py-5 md:px-8 md:py-6'}`}
          id="settings-scroll-container"
        >
          <div className={`mb-5 md:hidden ${active.fullHeight ? 'px-5 pt-5' : ''}`}>
            <Select
              value={activePage}
              options={SETTINGS_PAGES.map(page => ({ value: page.id, label: page.label }))}
              onChange={value => setActivePage(value as SettingsPageId)}
              aria-label="设置页面"
            />
          </div>
          <SettingsContent id={activePage} />
        </main>

        <div className="pointer-events-none fixed bottom-4 right-8 z-0 hidden md:block" aria-hidden>
          <span className={`${active.icon} text-[12rem] leading-none text-[var(--ema-text-tertiary)] opacity-[0.12]`} />
        </div>
      </div>
    </ErrorBoundary>
  );
}

function NavButton(props: { active: boolean; icon: string; label: string; onClick(): void }): JSX.Element {
  return (
    <Button
      variant="ghost"
      className={`w-full justify-start gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors ${props.active ? 'ema-active-rail bg-[var(--ema-primary-muted)] text-[var(--ema-primary)]' : 'text-[var(--ema-text-tertiary)] hover:bg-[var(--ema-surface-2)]/50 hover:text-[var(--ema-text-primary)]'}`}
      onClick={props.onClick}
      aria-current={props.active ? 'page' : undefined}
    >
      <span className={`${props.icon} shrink-0 text-base`} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-left">{props.label}</span>
    </Button>
  );
}

function SettingsContent({ id }: { id: SettingsPageId }): JSX.Element {
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
    case 'parameters': return <ParameterSettings />;
    case 'appearance': return <AppearanceTab />;
    default: return <Callout variant="info">没有找到该设置页面.</Callout>;
  }
}
