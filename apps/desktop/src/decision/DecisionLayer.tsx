// DecisionLayer — 当前 Session 输入框上方的权限请求与 AskUser 决策卡路由。
//
// 挂载在 ChatInput 内。只渲染 viewedSessionId 对应 Session 的队首；其他
// Session 的卡片留在各自队列（侧栏显示待处理数），不打断当前浏览的 Session。
// 桌宠窗口只显示非阻塞 Toast。
import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { PendingInteraction } from '@ema-agent/turn';
import type { PermissionResponse } from '@ema-agent/permission';
import { useDecisionStore } from '../stores/decision.js';
import { useCurrentSession } from '../chat/state/currentSession.js';
import { useServerStore } from '../stores/server.js';
import { useSettingsStore } from '../stores/settings.js';
import { ServerApiError } from '../api/client.js';
import { turnsApi } from '../api/turns.js';
import { PermissionRequestCard } from './PermissionRequestCard.js';
import { AskUserCard } from './AskUserCard.js';

// ── 提交状态 ─────────────────────────────────────────────────────────────────

function useDecisionSubmission(): {
  submitting: boolean;
  error?: string;
  run(operation: () => Promise<unknown>, onSuccess: () => void): Promise<void>;
} {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const busy = useRef(false);

  const run = async (operation: () => Promise<unknown>, onSuccess: () => void): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      await operation();
      onSuccess();
    } catch (cause: unknown) {
      // 另一窗口或 resolved SSE 可能已经完成同一请求；404 表示后端不再等待，
      // 本窗口应清掉过期副本，而不是让用户永远重试。
      if (cause instanceof ServerApiError && cause.status === 404) {
        onSuccess();
      } else {
        setError(cause instanceof Error ? cause.message : '提交失败，请重试');
      }
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  };

  return { submitting, error, run };
}

// ── 队首交互卡 ────────────────────────────────────────────────────────────────

function InteractionCard({
  entry,
  sessionId,
}: {
  entry:     PendingInteraction;
  sessionId: string;
}): JSX.Element {
  const timeoutMs = useSettingsStore((s) => s.permissionTimeoutMs);
  const submission = useDecisionSubmission();

  switch (entry.kind) {
    case 'permission': {
      const request = entry.request;
      return (
        <PermissionRequestCard
          request={request}
          submitting={submission.submitting}
          submissionError={submission.error}
          timeoutMs={timeoutMs ?? undefined}
          onRespond={(response: PermissionResponse) => {
            void submission.run(
              () => turnsApi.respondPermission(request.turnId, request.toolCallId, response),
              () => useDecisionStore.getState().resolve(sessionId),
            );
          }}
        />
      );
    }

    case 'askUser': {
      const request = entry.request;
      return (
        <AskUserCard
          request={request}
          submitting={submission.submitting}
          submissionError={submission.error}
          onResolve={(answers) => {
            void submission.run(
              () => turnsApi.respondAskUser(request.turnId, request.toolCallId, answers),
              () => useDecisionStore.getState().resolve(sessionId),
            );
          }}
          onCancel={() => {
            void submission.run(
              () => turnsApi.cancelAskUser(request.turnId, request.toolCallId),
              () => useDecisionStore.getState().cancel(sessionId),
            );
          }}
        />
      );
    }
  }
}

// ── 组件 ─────────────────────────────────────────────────────────────────────

export function DecisionLayer(): JSX.Element | null {
  const viewedSessionId = useCurrentSession((s) => s.viewedSessionId);
  const serverReady = useServerStore((s) => s.status.kind === 'ok');
  const current = useDecisionStore(
    useShallow((s) => (viewedSessionId ? s.sessions.get(viewedSessionId)?.[0] ?? null : null)),
  );

  useEffect(() => {
    if (!serverReady) return;
    // Permission 与 AskUser 在同一个交互队列里排队；恢复清单按统一时间线回放，
    // 避免窗口重开后改变同一 Session 的 FIFO 顺序。
    void turnsApi.pendingInteractions()
      .then((result) => {
        const pending = [...result.pending].sort((left, right) => left.createdAt - right.createdAt);
        useDecisionStore.getState().restorePending(pending);
      })
      .catch(() => {
        // 服务器健康轮询下一次进入 ok 时会再次尝试。
      });
  }, [serverReady]);

  if (!current || !viewedSessionId) return null;

  return (
    <div className="mb-2 w-full ema-slide-up">
      <InteractionCard key={current.request.toolCallId} entry={current} sessionId={viewedSessionId} />
    </div>
  );
}
