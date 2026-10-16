// 运行时展示当前调用用量, 空闲时估算当前配置下的 Prompt, 工具与有效历史.
import { useEffect, useMemo, useState, type JSX } from 'react';
import { Tooltip } from '@ema-agent/ui';
import { sessionsApi, type SessionContextEstimate } from '../../../api/sessions.js';
import { useTurnStore } from '../../../stores/turn.js';
import { useSessionStore } from '../../../stores/session.js';
import { useSessionActivityStore } from '../../../stores/sessionActivity.js';
import { subscribeSystemEvent } from '../../../lib/events/systemEventDispatcher.js';

export function ContextMeter({ sessionId, modelSelectionPending }: {
  sessionId: string | null;
  modelSelectionPending: boolean;
}): JSX.Element {
  const live = useTurnStore(state => sessionId ? state.contextUsageBySession[sessionId] : undefined);
  const estimateVersion = useTurnStore(state => sessionId
    ? state.contextEstimateVersionBySession[sessionId] ?? 0 : 0);
  const session = useSessionStore(state => sessionId ? state.sessions.byId.get(sessionId) : undefined);
  const running = useSessionActivityStore(state => sessionId ? state.bySession.get(sessionId)?.running : undefined);
  const [configurationVersion, setConfigurationVersion] = useState(0);
  useEffect(() => subscribeSystemEvent(event => {
    switch (event.type) {
      case 'settings_changed':
      case 'provider_config_changed':
      case 'provider_models_changed':
      case 'model_bindings_changed':
      case 'character_switched':
      case 'character_presentation_changed':
      case 'character_resources_changed':
      case 'skills_changed':
      case 'mcp_connection_changed':
      case 'mcp_servers_changed':
        setConfigurationVersion(version => version + 1);
    }
  }), []);

  // 这是请求身份, 不是 Token 缓存. 条件一变就不能继续展示旧响应.
  const request = useMemo(() => ({ sessionId }), [
    sessionId, session?.providerId, session?.modelId, session?.permissionMode,
    session?.cwd, session?.projectId, Boolean(session), running,
    modelSelectionPending, estimateVersion, configurationVersion,
  ]);
  const [cold, setCold] = useState<{
    request: typeof request;
    result: SessionContextEstimate;
  } | null>(null);

  useEffect(() => {
    setCold(null);
    if (!sessionId || !session || running || modelSelectionPending) return;
    const controller = new AbortController();
    void sessionsApi.estimateContext(sessionId, controller.signal).then(result => {
      if (!controller.signal.aborted) setCold({ request, result });
    }).catch(() => {
      if (!controller.signal.aborted) setCold(null);
    });
    return () => controller.abort();
  }, [request]);

  let entry: { inputTokens: number; contextWindow: number; estimate: boolean; pendingImageCount: number } | null = null;
  if (!modelSelectionPending && running?.kind === 'turn' && live) {
    entry = {
      inputTokens: live.usage.inputTokens,
      contextWindow: live.usage.contextWindow,
      estimate: live.usage.source === 'estimate',
      pendingImageCount: 0,
    };
  } else if (cold?.request === request) {
    entry = { ...cold.result, estimate: true };
  }
  // 分子与分母必须来自同一次计算, 不能拼接新模型窗口与旧模型用量.
  const windowSize = entry?.contextWindow ?? 0;
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
    <Tooltip
      side="top"
      variant="card"
      content={(
        <div className="min-w-40 text-center text-[12px]">
          <div className="text-[var(--ema-text-secondary)]">上下文窗口</div>
          {entry && windowSize > 0 ? (
            <>
              <div className="mt-1 tabular-nums">{percent}% 已用</div>
              <div className="tabular-nums text-[var(--ema-text-secondary)]">
                已用 {formatTokens(entry.inputTokens)}，共 {formatTokens(windowSize)} tokens
              </div>
              <div className="mt-1 text-[11px] text-[var(--ema-text-tertiary)]">
                {entry.estimate ? '本地估算' : 'Provider 实报'}
                {running?.kind === 'turn' ? ' · 当前调用' : ' · 已保存上下文'}
              </div>
              {entry.pendingImageCount > 0 && (
                <div className="mt-1 text-[11px] text-[var(--ema-text-tertiary)]">
                  {entry.pendingImageCount} 张图片尚无 Vision 描述，这部分未计入
                </div>
              )}
            </>
          ) : <div className="mt-1 text-[var(--ema-text-tertiary)]">尚未统计</div>}
        </div>
      )}
    >
      <button
        type="button"
        className="flex size-7 items-center justify-center rounded-[var(--ema-radius-sm)] text-[var(--ema-text-tertiary)] hover:bg-[var(--ema-surface-2)]"
        aria-label={title}
      >
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
      </button>
    </Tooltip>
  );
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(tokens / 1000)}k`;
}
