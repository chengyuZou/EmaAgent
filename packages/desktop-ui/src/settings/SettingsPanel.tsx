import { useState, useEffect, type JSX } from 'react';
import { Spinner } from '@ema-agent/ui';
import { ErrorBoundary } from '../lib/error-boundary.js';
import { useSettingsStore } from '../stores/settings-store.js';
import { useCardStore } from '../stores/card-store.js';
import { useSkillStore } from '../stores/skill-store.js';
import { useMcpStore } from '../stores/mcp-store.js';
import { useThemeSync } from '../stores/theme-store.js';
import { ProvidersTab } from './ProvidersTab.js';
import { BindingsTab } from './BindingsTab.js';
import { CardsTab } from './CardsTab.js';
import { SkillsTab } from './SkillsTab.js';
import { McpTab } from './McpTab.js';
import { MemoryTab } from './MemoryTab.js';
import { Live2DTab } from './Live2DTab.js';
import { ShortcutsTab } from './ShortcutsTab.js';
import { AppearanceTab } from './AppearanceTab.js';

// ── Tab registry ──────────────────────────────────────────────────────────────

type TabId =
  | 'providers' | 'bindings' | 'cards'
  | 'skills'    | 'mcp'      | 'memory'
  | 'live2d'    | 'shortcuts' | 'appearance';

interface TabDef {
  id:    TabId;
  label: string;
  icon:  string;
}

const TABS: TabDef[] = [
  { id: 'providers',  label: '服务来源', icon: 'i-mdi:cloud-outline'               },
  { id: 'bindings',   label: '模型绑定', icon: 'i-mdi:swap-horizontal'             },
  { id: 'cards',      label: '角色卡',   icon: 'i-mdi:card-account-details-outline' },
  { id: 'skills',     label: '技能',     icon: 'i-mdi:puzzle-outline'              },
  { id: 'mcp',        label: 'MCP 服务器', icon: 'i-mdi:server-outline'            },
  { id: 'memory',     label: '记忆系统',  icon: 'i-mdi:brain-outline'              },
  { id: 'live2d',     label: 'Live2D',   icon: 'i-mdi:animation-outline'           },
  { id: 'shortcuts',  label: '快捷键',   icon: 'i-mdi:keyboard-outline'            },
  { id: 'appearance', label: '外观',     icon: 'i-mdi:palette-outline'             },
];

function TabContent({ tab }: { tab: TabId }): JSX.Element {
  switch (tab) {
    case 'providers':  return <ProvidersTab />;
    case 'bindings':   return <BindingsTab />;
    case 'cards':      return <CardsTab />;
    case 'skills':     return <SkillsTab />;
    case 'mcp':        return <McpTab />;
    case 'memory':     return <MemoryTab />;
    case 'live2d':     return <Live2DTab />;
    case 'shortcuts':  return <ShortcutsTab />;
    case 'appearance': return <AppearanceTab />;
  }
}

// ── SettingsPanel ─────────────────────────────────────────────────────────────

export function SettingsPanel(): JSX.Element {
  useThemeSync();
  const [activeTab, setActiveTab] = useState<TabId>('providers');

  const settingsLoading = useSettingsStore((s) => s.loading);
  const cardsLoading    = useCardStore((s)    => s.loading);

  useEffect(() => {
    void useSettingsStore.getState().loadAll();
    void useCardStore.getState().load();
    void useSkillStore.getState().load();
    void useMcpStore.getState().load();
  }, []);

  const isLoading = settingsLoading || cardsLoading;

  return (
    <ErrorBoundary>
      <div className="flex h-screen bg-neutral-950 text-neutral-200">
        {/* Left nav */}
        <nav className="w-48 shrink-0 border-r border-neutral-800 flex flex-col py-4 px-2 gap-0.5 overflow-y-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`flex items-center gap-2 px-3 py-2 rounded-md text-left text-sm transition-colors w-full ${
                activeTab === tab.id
                  ? 'bg-primary-500/15 text-primary-100 font-medium'
                  : 'text-neutral-400 hover:bg-neutral-700/40 hover:text-neutral-100'
              }`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className={`${tab.icon} text-base shrink-0`} aria-hidden />
              {tab.label}
            </button>
          ))}
        </nav>

        {/* Right content */}
        <main className="flex-1 overflow-y-auto p-6">
          {isLoading ? (
            <div className="flex h-full items-center justify-center">
              <Spinner size="lg" />
            </div>
          ) : (
            <TabContent tab={activeTab} />
          )}
        </main>
      </div>
    </ErrorBoundary>
  );
}
