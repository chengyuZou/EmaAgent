// 圆环只展示当前 Session 的根调用用量, 或从有效历史读取的一次本地估算.
import { useEffect, useState, type JSX } from 'react';
import { sessionsApi } from '../../api/sessions.js';
import { useTurnStore } from '../../stores/turn.js';

export function ContextMeter({ sessionId, contextWindow }: {
  sessionId: string | null;
  /** 当前已启用模型的窗口, 切模型后不能继续使用上一模型的分母. */
  contextWindow?: number;
}): JSX.Element {
  const live = useTurnStore(state => sessionId ? state.contextUsageBySession[sessionId] : undefined);
  const estimateVersion = useTurnStore(state => sessionId
    ? state.contextEstimateVersionBySession[sessionId] ?? 0 : 0);
  const [cold, setCold] = useState<{
    sessionId: string;
    inputTokens: number;
    contextWindow: number;
  } | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setCold(null);
      return;
    }
    let cancelled = false;
    setCold(null);
    void sessionsApi.estimateContext(sessionId).then(result => {
      if (!cancelled) setCold({ sessionId, ...result });
    }).catch(() => {
      if (!cancelled) setCold(null);
    });
    return () => { cancelled = true; };
  }, [sessionId, estimateVersion]);

  let entry: { inputTokens: number; contextWindow: number; estimate: boolean } | null = null;
  if (live) {
    entry = {
      inputTokens: live.usage.inputTokens,
      contextWindow: live.usage.contextWindow,
      estimate: live.usage.source === 'estimate',
    };
  } else if (cold?.sessionId === sessionId) {
    entry = { inputTokens: cold.inputTokens, contextWindow: cold.contextWindow, estimate: true };
  }
  const windowSize = contextWindow ?? entry?.contextWindow ?? 0;
  const ratio = entry && windowSize > 0
    ? Math.min(1, Math.max(0, entry.inputTokens / windowSize)) : 0;
  const percent = Math.round(ratio * 100);
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  let title = '上下文用量尚未统计';
  if (entry) {
    const source = entry.estimate ? '本地估算' : 'Provider 实报';
    title = `${source}: ${entry.inputTokens} / ${windowSize} tokens (${percent}%)`;
  }

  return (
    <span className="flex size-7 items-center justify-center text-[var(--ema-text-tertiary)]" title={title} aria-label={title} role="img">
      <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden>
        <circle cx="8" cy="8" r={radius} fill="none" stroke="currentColor" strokeWidth="2" opacity="0.2" />
        {entry && (
          <circle
            cx="8" cy="8" r={radius} fill="none" stroke="var(--ema-primary)"
            strokeWidth="2" strokeLinecap="round" strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - percent / 100)}
          />
        )}
      </svg>
    </span>
  );
}
