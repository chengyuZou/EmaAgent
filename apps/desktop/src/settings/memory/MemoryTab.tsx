import { useState, type JSX } from 'react';
import { Tabs } from '@ema-agent/ui';
import { OverviewTab } from './MemoryOverviewTab.js';
import { MaintenanceTab } from './MemoryMaintenanceTab.js';

// ── Main export ───────────────────────────────────────────────────────────────

type MemorySection = 'overview' | 'maintenance';

export function MemoryTab(): JSX.Element {
  const [section, setSection] = useState<MemorySection>('overview');

  const tabItems = [
    { value: 'overview',     label: '概览',   icon: 'i-mdi:chart-box-outline',   content: <OverviewTab />     },
    { value: 'maintenance',  label: '维护',   icon: 'i-mdi:wrench-outline',       content: <MaintenanceTab />  },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="shrink-0">
        <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">记忆系统</h2>
        <p className="text-xs font-semibold text-[var(--ema-text-tertiary)] mt-0.5">查看记忆存储占用与后台任务,手动触发整合与清理</p>
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
