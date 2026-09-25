// 单条原始 Message 详情：展开后读取一次完整 blocksJson，并在当前查看器生命周期内保留。
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { Button, Skeleton } from '@ema-agent/ui';
import { systemApi } from '../../api/system.js';
import { Markdown } from '@ema-agent/ui';

interface MessageDetailProps {
  sessionId: string;
  messageId: string;
}

export function MessageDetail({ sessionId, messageId }: MessageDetailProps): JSX.Element | null {
  const [blocksJson, setBlocksJson] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setFailed(false);
    systemApi.getRawMessageDetail(sessionId, messageId)
      .then(result => setBlocksJson(result.blocksJson))
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, [messageId, sessionId]);

  useEffect(() => {
    load();
  }, [load]);

  const pretty = useMemo(() => {
    if (blocksJson === null) return null;
    try {
      return JSON.stringify(JSON.parse(blocksJson), null, 2);
    } catch {
      return blocksJson;
    }
  }, [blocksJson]);

  if (loading) {
    return (
      <div className="mx-2 mb-2 flex flex-col gap-2">
        <Skeleton className="h-8 rounded-lg" />
        <Skeleton className="h-8 rounded-lg" />
      </div>
    );
  }

  if (failed) {
    return (
      <div className="mx-2 mb-2 flex items-center justify-center gap-2 py-3">
        <span className="text-xs text-[var(--ema-danger)]">消息正文读取失败</span>
        <Button variant="ghost" size="sm" onClick={load}>重试</Button>
      </div>
    );
  }

  if (pretty === null) return null;
  return (
    <div className="ema-raw-json mx-2 mb-2 rounded-lg border border-[var(--ema-border)] bg-[var(--ema-surface-0)]">
      <Markdown source={`\`\`\`json\n${pretty}\n\`\`\``} />
    </div>
  );
}
