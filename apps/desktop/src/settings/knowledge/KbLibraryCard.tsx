// 单个知识库卡:状态点(纯展示)、独立激活按钮、永久删除入口与库概要;点卡身打开详情(不激活)。
import type { JSX } from 'react';
import { Button, IconButton } from '@ema-agent/ui';
import type { KnowledgeLibrary } from '../../api/knowledge.js';

function statusLine(lib: KnowledgeLibrary): { text: string; danger: boolean } {
  if (lib.activeTaskCount > 0) return { text: `${lib.activeTaskCount} 个任务进行中`, danger: false };
  if (!lib.embed) return { text: '未配置嵌入', danger: true };
  if (lib.staleCount > 0) return { text: `${lib.staleCount} 篇待重建`, danger: true };
  if (lib.documentCount > 0) return { text: '已就绪', danger: false };
  return { text: '暂无文档', danger: false };
}

export function KbLibraryCard({ lib, onOpen, onActivate, onDelete }: {
  lib: KnowledgeLibrary;
  onOpen(): void;
  onActivate(): void;
  onDelete(): void;
}): JSX.Element {
  const status = statusLine(lib);
  return (
    <div className="relative group/card h-full">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full h-full flex-col gap-1.5 rounded-xl border border-[var(--ema-border)]
                   bg-[var(--ema-surface-1)] p-4 text-left cursor-pointer outline-none
                   ema-glass-weak ema-card-decorate ema-card-decorate--starfield
                   transition-all duration-[var(--ema-duration-base)]
                   hover:border-[var(--ema-primary)]/40 hover:bg-[var(--ema-surface-2)]
                   hover:shadow-[var(--ema-shadow-2)] hover:-translate-y-0.5 active:scale-[0.98]"
      >
        <span
          className={`absolute left-2.5 top-2.5 z-1 size-2.5 rounded-full ${
            lib.isActive
              ? 'bg-[var(--ema-success)]'
              : 'border-2 border-solid border-[var(--ema-border-strong)] bg-transparent'
          }`}
          title={lib.isActive ? 'Agent 检索目标库' : undefined}
          aria-hidden
        />
        <span className="pl-4 text-sm font-semibold text-[var(--ema-text-primary)] truncate pr-6">
          {lib.name}
        </span>
        <span className="pl-4 text-[11px] font-mono text-[var(--ema-text-tertiary)] truncate" title={lib.path}>
          {lib.path}
        </span>
        <span className="pl-4 text-[11px] text-[var(--ema-text-secondary)] truncate">
          {lib.embed ? `${lib.embed.modelId} · ${lib.documentCount} 篇` : `${lib.documentCount} 篇`}
        </span>
        <span className={`pl-4 text-[11px] ${status.danger ? 'text-[var(--ema-warning-text)]' : 'text-[var(--ema-text-tertiary)]'}`}>
          {status.text}
        </span>
        {!lib.isActive && (
          <span className="pl-4 pt-1">
            <Button
              variant="ghost" size="sm" className="text-xs"
              onClick={(e) => { e.stopPropagation(); onActivate(); }}
            >
              设为检索目标
            </Button>
          </span>
        )}
      </button>
      <IconButton
        label="删除知识库"
        icon="i-lucide:trash-2"
        size="sm"
        className="absolute right-2 top-2 z-1 opacity-0 group-hover/card:opacity-100 transition-opacity duration-[var(--ema-duration-base)]"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
      />
    </div>
  );
}
