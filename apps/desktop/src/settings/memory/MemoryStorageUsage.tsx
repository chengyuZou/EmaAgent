import { memo, type JSX } from 'react';
import { Button, Spinner } from '@ema-agent/ui';
import { memoryApi } from '../../api/memory.js';
import { formatMemoryBytes } from './memoryLabels.js';
import { useMemoryQuery } from './useMemoryQuery.js';

export const MemoryStorageUsage = memo(function MemoryStorageUsage({ active }: {
  readonly active: boolean;
}): JSX.Element {
  const stats = useMemoryQuery(active, 30_000, memoryApi.stats);

  return (
    <section className="ema-memory-storage" aria-label="Memory 存储">
      <h2>Memory 存储</h2>
      <div className="ema-memory-storage-value" role="status">
        {stats.value && (
          <>
            <strong>{formatMemoryBytes(stats.value.usedBytes)}</strong>
            <span>已使用</span>
          </>
        )}
        {stats.loading && (
          <span className="ema-memory-storage-loading">
            <Spinner size="sm" />
            <span>{stats.value ? '更新中...' : '正在统计...'}</span>
          </span>
        )}
        {!stats.value && !stats.loading && !stats.error && <span>等待统计</span>}
      </div>
      <p>包含记忆文件与内部 Git 数据.</p>
      {stats.error && (
        <div className="ema-memory-storage-error">
          <span role="alert">
            {stats.value ? '更新失败, 当前为上次统计结果.' : '暂时无法统计.'}
          </span>
          <Button size="sm" variant="ghost" disabled={!active || stats.loading} onClick={stats.refresh}>
            重试
          </Button>
        </div>
      )}
    </section>
  );
});
