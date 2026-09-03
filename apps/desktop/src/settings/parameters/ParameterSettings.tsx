import { useState, type CSSProperties, type JSX } from 'react';
import { Button } from '@ema-agent/ui';
import { AgentParameters } from './agent/AgentParameters.js';
import { AttachmentParameters } from './attachments/AttachmentParameters.js';
import { ContextParameters } from './context/ContextParameters.js';
import { NarrativeParameters } from './narrative/NarrativeParameters.js';
import { PermissionSettings } from './permission/PermissionSettings.js';
import { ToolsSettings } from './tools/ToolsSettings.js';
import { WorkspaceParameters } from './workspace/WorkspaceParameters.js';

type ParameterDomain = 'attachments' | 'agent' | 'context' | 'narrative' | 'permission' | 'tools' | 'workspace';

const DOMAINS: readonly {
  id: ParameterDomain;
  title: string;
  description: string;
  icon: string;
}[] = [
  { id: 'attachments', title: '附件', description: 'Vision 描述缓存容量.', icon: 'i-lucide:paperclip' },
  { id: 'agent', title: 'Agent', description: 'Chat, Work 和子代理执行限制.', icon: 'i-lucide:bot' },
  { id: 'context', title: '上下文', description: '自动压缩和手动压缩策略.', icon: 'i-lucide:gauge' },
  { id: 'narrative', title: 'Narrative', description: '剧情检索模式与下次启动行为.', icon: 'i-lucide:book-open' },
  { id: 'permission', title: '权限规则', description: 'Tool 执行模式与规则.', icon: 'i-lucide:shield-check' },
  { id: 'tools', title: 'Tools', description: '内置工具与后台进程参数.', icon: 'i-lucide:wrench' },
  { id: 'workspace', title: '工作区', description: '随 Skills 注入的工作区指令文件.', icon: 'i-lucide:folder-kanban' },
];

export function ParameterSettings(): JSX.Element {
  const [domain, setDomain] = useState<ParameterDomain | null>(null);

  if (domain === null) {
    return (
      <div className="mx-auto w-full max-w-5xl pb-10">
        <header className="mb-6">
          <h1 className="text-xl font-semibold text-[var(--ema-text-primary)]">参数设置</h1>
          <p className="mt-1 text-sm text-[var(--ema-text-tertiary)]">调整基础产品行为.</p>
        </header>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {DOMAINS.map((item, index) => (
            <button
              key={item.id}
              className="ema-glass-weak ema-card-decorate ema-stagger-in group flex min-h-32 flex-col items-start overflow-hidden rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] p-4 text-left transition-ema hover:-translate-y-1 hover:border-[var(--ema-primary)]/40 hover:bg-[var(--ema-surface-2)] hover:shadow-[var(--ema-shadow-soft)] active:scale-[0.98]"
              style={{ '--stagger-i': index } as CSSProperties}
              onClick={() => setDomain(item.id)}
            >
              <span className={`${item.icon} text-2xl text-[var(--ema-text-tertiary)] transition-ema group-hover:scale-110 group-hover:text-[var(--ema-primary)]`} aria-hidden />
              <strong className="mt-4 text-sm text-[var(--ema-text-primary)]">{item.title}</strong>
              <span className="mt-1 text-xs leading-relaxed text-[var(--ema-text-tertiary)]">{item.description}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 pb-10">
      <Button className="self-start" variant="ghost" size="sm" onClick={() => setDomain(null)}>
        <span className="i-lucide:arrow-left" aria-hidden />返回参数设置
      </Button>
      <ParameterDomainPage domain={domain} />
    </div>
  );
}

function ParameterDomainPage({ domain }: { domain: ParameterDomain }): JSX.Element {
  switch (domain) {
    case 'attachments': return <AttachmentParameters />;
    case 'agent': return <AgentParameters />;
    case 'context': return <ContextParameters />;
    case 'narrative': return <NarrativeParameters />;
    case 'permission': return <PermissionSettings />;
    case 'tools': return <ToolsSettings />;
    case 'workspace': return <WorkspaceParameters />;
  }
}
