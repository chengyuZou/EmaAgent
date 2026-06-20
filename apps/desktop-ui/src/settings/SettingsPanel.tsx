/**
 * SettingsPanel — AIRI-style two-level settings navigation.
 *
 * Level 1 (home): 2-column list of large MenuIconItem cards with staggered
 * slide-up entrance animation and an oversized decorative gear bottom-right.
 * Level 2 (section): slide-right entrance + back-arrow header.
 */
import { useState, useEffect, useRef, type JSX } from 'react';
import { MenuIconItem, Spinner } from '@ema-agent/ui';
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
import { KnowledgeBaseTab } from './KnowledgeBaseTab.js';
import { Live2DTab } from './Live2DTab.js';
import { ShortcutsTab } from './ShortcutsTab.js';
import { AppearanceTab } from './AppearanceTab.js';

// ── Section registry ──────────────────────────────────────────────────────────

type SectionId =
  | 'cards'  | 'providers' | 'bindings'
  | 'memory' | 'skills'    | 'mcp'
  | 'live2d' | 'shortcuts' | 'appearance'
  | 'knowledge-base';

interface SectionDef {
  id:          SectionId;
  title:       string;
  description: string;
  icon:        string;
}

const SECTIONS: SectionDef[] = [
  { id: 'providers',  title: '服务来源',  description: 'LLM、语音合成、语音识别服务来源等',
    icon: 'i-solar:box-minimalistic-bold-duotone' },
  { id: 'bindings',   title: '模型绑定',  description: '各模块使用的模型与音色',
    icon: 'i-solar:link-circle-bold-duotone' },
  { id: 'cards',      title: '角色卡',    description: 'Ema 的人格、问候语与声音',
    icon: 'i-solar:emoji-funny-square-bold-duotone' },
  { id: 'skills',     title: '技能',      description: '安装与管理自定义技能',
    icon: 'i-solar:magic-stick-3-bold-duotone' },
  { id: 'mcp',        title: 'MCP 服务器', description: '连接 MCP 服务器，扩展工具集',
    icon: 'i-solar:server-square-bold-duotone' },
  { id: 'memory',     title: '记忆系统',  description: '浏览和管理记忆节点与条目',
    icon: 'i-solar:leaf-bold-duotone' },
  { id: 'knowledge-base', title: '知识库',  description: '导入文档，AI 主动检索参考资料',
    icon: 'i-solar:database-bold-duotone' },
  { id: 'live2d',     title: 'Live2D',    description: '模型加载与运行时参数',
    icon: 'i-solar:adhesive-plaster-bold-duotone' },
  { id: 'shortcuts',  title: '快捷键',    description: '全局热键与窗口快捷键',
    icon: 'i-solar:keyboard-bold-duotone' },
  { id: 'appearance', title: '外观',      description: '主题色与界面风格',
    icon: 'i-solar:pallete-2-bold-duotone' },
];

function SectionContent({ section }: { section: SectionId }): JSX.Element {
  switch (section) {
    case 'cards':      return <CardsTab />;
    case 'providers':  return <ProvidersTab />;
    case 'bindings':   return <BindingsTab />;
    case 'memory':         return <MemoryTab />;
    case 'knowledge-base': return <KnowledgeBaseTab />;
    case 'skills':         return <SkillsTab />;
    case 'mcp':        return <McpTab />;
    case 'live2d':     return <Live2DTab />;
    case 'shortcuts':  return <ShortcutsTab />;
    case 'appearance': return <AppearanceTab />;
  }
}

// ── SettingsPanel ─────────────────────────────────────────────────────────────

export function SettingsPanel(): JSX.Element {
  useThemeSync();
  const [section, setSection] = useState<SectionId | null>(null);
  // Bump to force home-grid remount (replays stagger) on every return
  const [homeKey, setHomeKey] = useState(0);

  const settingsLoading = useSettingsStore((s) => s.loading);
  const cardsLoading    = useCardStore((s)    => s.loading);

  useEffect(() => {
    void useSettingsStore.getState().loadAll();
    void useCardStore.getState().load();
    void useSkillStore.getState().load();
    void useMcpStore.getState().load();
  }, []);

  const isLoading = settingsLoading || cardsLoading;
  const active = SECTIONS.find((s) => s.id === section);

  function goBack(): void {
    setSection(null);
    setHomeKey((k) => k + 1);
  }

  return (
    <ErrorBoundary>
      <div className="fixed inset-0 flex flex-col bg-neutral-950 text-neutral-200">
        <main className="flex-1 min-h-0 overflow-y-auto px-8 py-6" id="settings-scroll-container">

          {/* ── Header ── */}
          <header className="flex items-center gap-2 mb-6">
            {active && (
              <button
                className="size-8 -ml-1.5 rounded-lg flex items-center justify-center
                           text-neutral-400 hover:text-primary-300 hover:bg-neutral-800/60
                           active:scale-90 transition-all duration-150"
                onClick={goBack}
                aria-label="返回设置"
              >
                <span className="i-solar:alt-arrow-left-line-duotone text-xl" aria-hidden />
              </button>
            )}
            <div>
              <h1 className="text-2xl font-semibold text-neutral-100 transition-all duration-250">
                {active ? active.title : '设置'}
              </h1>
              {active && (
                <p className="text-xs text-neutral-500 animate-fade-in">{active.description}</p>
              )}
            </div>
          </header>

          {/* ── Body ── */}
          {isLoading ? (
            <div className="flex h-64 items-center justify-center">
              <Spinner size="lg" />
            </div>
          ) : active ? (
            /* Section view — keyed so React remounts on every section change,
               replaying the slide-right entrance animation */
            <div key={active.id} className="animate-slide-right">
              <SectionContent section={active.id} />
            </div>
          ) : (
            /* Home grid — keyed (homeKey) so returning from a section replays stagger */
            <div key={homeKey} className="flex flex-col gap-3 pb-12">
              {SECTIONS.map((s, i) => (
                <MenuIconItem
                  key={s.id}
                  title={s.title}
                  description={s.description}
                  icon={s.icon}
                  onClick={() => setSection(s.id)}
                  /* Stagger: each card waits 55 ms × its index before animating in.
                     animation-fill-mode: both (from keyframe) keeps it invisible during delay. */
                  style={{ animationDelay: `${i * 55}ms` }}
                  className="animate-slide-up"
                />
              ))}
            </div>
          )}
        </main>

        {/* ── Decorative gear (home only) — animates in on mount ── */}
        {!active && (
          <div
            aria-hidden
            className="pointer-events-none absolute -right-10 bottom-0 z-0
                       size-60 flex items-center justify-center
                       text-neutral-600/20 animate-scale-in
                       hover:rotate-12 transition-transform duration-1000 ease-in-out"
          >
            <div className="i-solar:settings-bold-duotone text-[15rem]" />
          </div>
        )}
      </div>
    </ErrorBoundary>
  );
}
