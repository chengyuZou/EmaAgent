// 检索测试面板:输入查询查看混合检索的命中结果与得分。
import { useState, type CSSProperties, type JSX } from 'react';
import { Button, Callout, IconButton, Input, Spinner } from '@ema-agent/ui';
import { useKbStore } from '../../stores/kb-store.js';

export function SearchTest(): JSX.Element {
  const searchResult  = useKbStore((s) => s.searchResult);
  const searchLoading = useKbStore((s) => s.searchLoading);
  const searchError   = useKbStore((s) => s.searchError);
  const [query, setQuery] = useState('');

  async function handleSearch(): Promise<void> {
    if (!query.trim()) return;
    await useKbStore.getState().search(query);
  }

  function handleChange(value: string): void {
    setQuery(value);
    // Clearing the box clears stale results so nothing lingers.
    if (!value.trim() && (searchResult || searchError)) {
      useKbStore.getState().clearSearch();
    }
  }

  function handleClear(): void {
    setQuery('');
    useKbStore.getState().clearSearch();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            className="text-sm pr-8"
            placeholder="输入查询语句测试检索…"
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleSearch(); }}
          />
          {query && (
            <IconButton
              variant="default"
              size="sm"
              label="清空"
              icon="i-solar:close-circle-bold"
              className="absolute right-1 top-1/2 -translate-y-1/2"
              onClick={handleClear}
            />
          )}
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={searchLoading || !query.trim()}
          onClick={() => void handleSearch()}
        >
          {searchLoading ? <Spinner size="sm" /> : '检索'}
        </Button>
      </div>

      {searchError && (
        <Callout variant="danger" className="text-xs">{searchError}</Callout>
      )}

      {searchResult && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-[var(--ema-text-tertiary)]">
            "{searchResult.query}" — {searchResult.hits.length} 条结果
          </p>
          {searchResult.hits.length === 0 ? (
            <p className="text-sm text-[var(--ema-text-tertiary)] py-3 text-center">未找到相关内容</p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {searchResult.hits.map((hit, i) => (
                <div
                  key={hit.chunkId}
                  className="p-3 rounded-xl bg-[var(--ema-surface-1)] border border-[var(--ema-border)] ema-stagger-in ema-card-decorate ema-card-decorate--starfield"
                  style={{ '--stagger-i': i } as CSSProperties}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-xs text-[var(--ema-text-tertiary)] font-mono truncate">{hit.source.fileName}</span>
                    {hit.source.page && (
                      <span className="text-xs text-[var(--ema-text-tertiary)] shrink-0">第 {hit.source.page} 页</span>
                    )}
                    <span className="ml-auto text-xs text-[var(--ema-primary)] font-mono shrink-0">
                      {(hit.score * 100).toFixed(1)}%
                    </span>
                  </div>
                  <p className="text-xs text-[var(--ema-text-secondary)] leading-relaxed line-clamp-4">
                    {hit.text}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
