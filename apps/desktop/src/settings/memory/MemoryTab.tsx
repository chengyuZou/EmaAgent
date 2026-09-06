import { useState, type JSX } from 'react';
import { Tabs } from '@ema-agent/ui';
import { MemoryFilesTab } from './MemoryFilesTab.js';
import { MemoryJobsTab } from './MemoryJobsTab.js';
import { MemoryOverviewTab } from './MemoryOverviewTab.js';

type MemorySection = 'overview' | 'files' | 'jobs';

export function MemoryTab(): JSX.Element {
  const [section, setSection] = useState<MemorySection>('overview');
  const tabItems = [
    {
      value: 'overview',
      label: '概览',
      icon: 'i-lucide:chart-no-axes-column-increasing',
      content: <MemoryOverviewTab />,
    },
    {
      value: 'files',
      label: '文件',
      icon: 'i-lucide:files',
      content: <MemoryFilesTab />,
    },
    {
      value: 'jobs',
      label: '后台任务',
      icon: 'i-lucide:history',
      content: <MemoryJobsTab />,
    },
  ];

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <div className="shrink-0">
        <h2 className="text-base font-semibold text-[var(--ema-text-primary)]">Memory</h2>
        <p className="mt-0.5 text-xs text-[var(--ema-text-tertiary)]">
          查看自动生成的工作记忆、角色关系记忆和后台任务。
        </p>
      </div>
      <Tabs
        value={section}
        onChange={value => setSection(value as MemorySection)}
        items={tabItems}
        variant="pill"
        orientation="horizontal"
        className="min-h-0 flex-1"
      />
    </div>
  );
}
