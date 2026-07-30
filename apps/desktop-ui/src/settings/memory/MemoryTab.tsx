import { useState, type JSX } from 'react';
import { Tabs } from '@ema-agent/ui';
import { OverviewTab } from './MemoryOverviewTab.js';
import { NodesTab } from './MemoryNodesTab.js';
import { ItemsTab } from './MemoryItemsTab.js';
import { MaintenanceTab } from './MemoryMaintenanceTab.js';

// ── Main export ───────────────────────────────────────────────────────────────

type MemorySection = 'overview' | 'nodes' | 'items' | 'maintenance';

export function MemoryTab(): JSX.Element {
  const [section, setSection] = useState<MemorySection>('overview');

  const tabItems = [
    { value: 'overview',     label: '概览',   icon: 'i-mdi:chart-box-outline',   content: <OverviewTab />     },
    { value: 'nodes',        label: '节点',   icon: 'i-mdi:graph-outline',        content: <NodesTab />        },
    { value: 'items',        label: '条目',   icon: 'i-mdi:note-text-outline',    content: <ItemsTab />        },
    { value: 'maintenance',  label: '维护',   icon: 'i-mdi:wrench-outline',       content: <MaintenanceTab />  },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="shrink-0">
        <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">记忆系统</h2>
        <p className="text-xs font-semibold text-[var(--ema-text-tertiary)] mt-0.5">浏览和管理 Agent 的长期记忆节点与条目</p>
      </div>

      <Tabs
        value={section}
        onChange={(v) => setSection(v as MemorySection)}
        items={tabItems}
        variant="pill"
        orientation="horizontal"
        className="flex-1 min-h-0"
      />
    </div>
  );
}
