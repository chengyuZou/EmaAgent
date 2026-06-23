/**
 * SettingsPanel — two-column accordion layout.
 *
 * Left: fixed sidebar with collapsible groups → sections.
 * Right: content area for the active section (no home grid, no back button).
 * Default: AI 与模型 expanded, 服务来源 selected.
 */
import { useState, useEffect, type JSX } from 'react';
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
import { SessionsTab }   from './SessionsTab.js';

// ── Types ─────────────────────────────────────────────────────────────────────

type SectionId =
  | 'providers' | 'bindings'
  | 'cards'
  | 'skills'    | 'mcp'
  | 'memory'
  | 'knowledge-base'
  | 'sessions'
  | 'live2d'    | 'shortcuts' | 'appearance';

type GroupId = 'ai' | 'character' | 'agent' | 'memory' | 'knowledge' | 'data' | 'desktop';

// Sessions fills the entire content pane (no outer padding / scroll)
const FULL_HEIGHT_SECTIONS = new Set<SectionId>(['sessions']);

interface SectionDef { id: SectionId; label: string }
interface GroupDef   { id: GroupId; label: string; icon: string; sections: SectionDef[] }

// ── Navigation structure ──────────────────────────────────────────────────────

const GROUPS: GroupDef[] = [
  {
    id: 'ai', label: 'AI 与模型', icon: 'i-solar:box-minimalistic-bold-duotone',
    sections: [
      { id: 'providers', label: '服务来源' },
      { id: 'bindings',  label: '模型绑定' },
    ],
  },
  {
    id: 'character', label: '角色', icon: 'i-solar:emoji-funny-square-bold-duotone',
    sections: [
      { id: 'cards', label: '角色卡' },
    ],
  },
  {
    id: 'agent', label: 'Agent 能力', icon: 'i-solar:magic-stick-3-bold-duotone',
    sections: [
      { id: 'skills', label: '技能' },
      { id: 'mcp',    label: 'MCP 服务器' },
    ],
  },
  {
    id: 'memory', label: 'Memory', icon: 'i-solar:leaf-bold-duotone',
    sections: [
      { id: 'memory', label: '记忆系统' },
    ],
  },
  {
    id: 'knowledge', label: 'Knowledge Base', icon: 'i-solar:database-bold-duotone',
    sections: [
      { id: 'knowledge-base', label: '知识库' },
    ],
  },
  {
    id: 'data', label: '数据', icon: 'i-solar:history-bold-duotone',
    sections: [
      { id: 'sessions', label: '历史会话' },
    ],
  },
  {
    id: 'desktop', label: '桌面与外观', icon: 'i-solar:pallete-2-bold-duotone',
    sections: [
      { id: 'live2d',     label: 'Live2D' },
      { id: 'shortcuts',  label: '快捷键' },
      { id: 'appearance', label: '外观' },
    ],
  },
];

// ── Section renderer ──────────────────────────────────────────────────────────

function SectionContent({ id }: { id: SectionId }): JSX.Element {
  switch (id) {
    case 'providers':      return <ProvidersTab />;
    case 'bindings':       return <BindingsTab />;
    case 'cards':          return <CardsTab />;
    case 'skills':         return <SkillsTab />;
    case 'mcp':            return <McpTab />;
    case 'memory':         return <MemoryTab />;
    case 'knowledge-base': return <KnowledgeBaseTab />;
    case 'sessions':       return <SessionsTab />;
    case 'live2d':         return <Live2DTab />;
    case 'shortcuts':      return <ShortcutsTab />;
    case 'appearance':     return <AppearanceTab />;
  }
}

// ── SettingsPanel ─────────────────────────────────────────────────────────────

export function SettingsPanel(): JSX.Element {
  useThemeSync();

  // Default: AI 与模型 expanded, 服务来源 selected.
  const [expandedGroups, setExpandedGroups] = useState<Set<GroupId>>(new Set(['ai']));
  const [activeSection,  setActiveSection]  = useState<SectionId>('providers');

  useEffect(() => {
    void useSettingsStore.getState().loadAll();
    void useCardStore.getState().load();
    void useSkillStore.getState().load();
    void useMcpStore.getState().load();
  }, []);

  function toggleGroup(groupId: GroupId): void {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  return (
    <ErrorBoundary>
      <div className="fixed inset-0 flex bg-[var(--ema-surface-0)] text-[var(--ema-text-primary)]">

        {/* ── Left sidebar ── */}
        <nav
          className="flex-none w-52 flex flex-col gap-0.5 px-2 py-4 border-r border-[var(--ema-border)] overflow-y-auto"
          aria-label="设置导航"
        >
          <p className="px-3 pb-3 text-base font-semibold text-[var(--ema-text-primary)]">设置</p>

          {GROUPS.map((group) => {
            const expanded = expandedGroups.has(group.id);
            return (
              <div key={group.id}>
                {/* Group header */}
                <button
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm
                             text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-primary)]
                             hover:bg-[var(--ema-surface-2)]/50
                             transition-colors duration-[var(--ema-duration-fast)]"
                  onClick={() => toggleGroup(group.id)}
                  aria-expanded={expanded}
                >
                  <span className={`${group.icon} text-base flex-none`} aria-hidden />
                  <span className="flex-1 text-left">{group.label}</span>
                  <span
                    className={`i-solar:alt-arrow-right-line-duotone text-xs flex-none
                                transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
                    aria-hidden
                  />
                </button>

                {/* Section items (visible when expanded) */}
                {expanded && (
                  <div className="ml-4 mt-0.5 mb-1 flex flex-col gap-0.5">
                    {group.sections.map((sec) => {
                      const isActive = activeSection === sec.id;
                      return (
                        <button
                          key={sec.id}
                          className={`w-full text-left px-3 py-1.5 rounded-lg text-sm
                            transition-colors duration-[var(--ema-duration-fast)] ${
                            isActive
                              ? 'text-[var(--ema-primary)] bg-[var(--ema-primary-muted)]'
                              : 'text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-primary)] hover:bg-[var(--ema-surface-2)]/40'
                          }`}
                          onClick={() => setActiveSection(sec.id)}
                          aria-current={isActive ? 'page' : undefined}
                        >
                          {sec.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* ── Right content ── */}
        <main
          key={activeSection}
          className={`flex-1 min-w-0 ema-slide-right ${
            FULL_HEIGHT_SECTIONS.has(activeSection)
              ? 'overflow-hidden'
              : 'overflow-y-auto px-8 py-6'
          }`}
          id="settings-scroll-container"
        >
          <SectionContent id={activeSection} />
        </main>
      </div>
    </ErrorBoundary>
  );
}
