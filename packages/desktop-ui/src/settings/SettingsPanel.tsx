/**
 * SettingsPanel — left nav + right content layout for settings sub-window.
 */
import { useState, useEffect, type JSX } from 'react';
import { ErrorBoundary } from '../lib/error-boundary.js';
import { useSettingsStore } from '../stores/settings-store.js';
import { useCardStore } from '../stores/card-store.js';
import { ProvidersTab } from './ProvidersTab.js';
import { BindingsTab } from './BindingsTab.js';
import { CardsTab } from './CardsTab.js';
import { Live2DTab } from './Live2DTab.js';
import { ShortcutsTab } from './ShortcutsTab.js';
import { AppearanceTab } from './AppearanceTab.js';

type TabId = 'providers' | 'bindings' | 'cards' | 'live2d' | 'shortcuts' | 'appearance';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'providers',  label: '服务来源' },
  { id: 'bindings',   label: '模型绑定' },
  { id: 'cards',      label: '角色卡' },
  { id: 'live2d',     label: 'Live2D' },
  { id: 'shortcuts',  label: '快捷键' },
  { id: 'appearance', label: '外观' },
];

export function SettingsPanel(): JSX.Element {
  const [activeTab, setActiveTab] = useState<TabId>('providers');
  const settingsLoading = useSettingsStore((s) => s.loading);
  const cardsLoading = useCardStore((s) => s.loading);

  useEffect(() => {
    void useSettingsStore.getState().loadAll();
    void useCardStore.getState().load();
  }, []);

  const isLoading = settingsLoading || cardsLoading;

  return (
    <ErrorBoundary>
      <div className="flex h-screen bg-gray-950 text-gray-200">
        {/* Left nav */}
        <nav className="w-48 flex-shrink-0 border-r border-gray-800 flex flex-col py-4 px-2 gap-1">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`px-4 py-2 rounded-xl text-left text-sm transition-colors ${
                activeTab === tab.id
                  ? 'bg-pink-400/15 text-pink-300 font-medium'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
              }`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {/* Right content */}
        <main className="flex-1 overflow-y-auto p-6">
          {isLoading ? (
            <div className="flex items-center justify-center h-full text-gray-500">
              加载中…
            </div>
          ) : (
            <TabContent tab={activeTab} />
          )}
        </main>
      </div>
    </ErrorBoundary>
  );
}

function TabContent({ tab }: { tab: TabId }): JSX.Element {
  switch (tab) {
    case 'providers':  return <ProvidersTab />;
    case 'bindings':   return <BindingsTab />;
    case 'cards':      return <CardsTab />;
    case 'live2d':     return <Live2DTab />;
    case 'shortcuts':  return <ShortcutsTab />;
    case 'appearance': return <AppearanceTab />;
    default:           return <div>未知标签</div>;
  }
}
