// 检索 Tab:覆盖率徽标 + 检索测试 + 检索参数(KB 参数与业务页面聚合)。
import type { JSX } from 'react';
import { Callout } from '@ema-agent/ui';
import type { KnowledgeLibrary } from '../../api/knowledge.js';
import { SearchTest } from './SearchTest.js';
import { KnowledgeSettings } from './KnowledgeSettings.js';

export function KbSearchTab({ lib }: { lib: KnowledgeLibrary }): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-xs text-[var(--ema-text-tertiary)]">
        <span className="i-solar:chart-square-bold" aria-hidden />
        索引覆盖:
        <span className={`font-mono ${lib.staleCount > 0 ? 'text-[var(--ema-warning-text)]' : 'text-[var(--ema-text-secondary)]'}`}>
          {lib.readyCount}/{lib.documentCount} 已就绪
        </span>
        {lib.staleCount > 0 && <span className="text-[var(--ema-warning-text)]">· {lib.staleCount} 待重建</span>}
      </div>

      {!lib.embed ? (
        <Callout variant="warn" className="text-xs">未配置 Embedding 模型，检索不可用。</Callout>
      ) : (
        <SearchTest />
      )}

      <KnowledgeSettings />
    </div>
  );
}
