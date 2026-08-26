/**
 * DecisionLayer — 当前 Session 输入框上方的权限与 Ask User 决策卡路由。
 *
 * Mount this inside ChatInput. It reads `viewedSessionId` from
 * conversation-store and renders that session's queue head. Other sessions'
 * prompts stay queued (surfaced via sidebar badges) without interrupting the
 * session the user is currently viewing。桌宠窗口只显示非阻塞 Toast。
 */
import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useDecisionStore, type DecisionPrompt } from '../stores/decision-store.js';
import { useConversationStore } from '../stores/conversation-store.js';
import { useServerStore } from '../stores/server-store.js';
import { useSettingsStore } from '../stores/settings-store.js';
import { turnsApi } from '../api/turns.js';
import { submitDecision } from './decision-submission.js';
import { PermissionPrompt } from './PermissionPrompt.js';
import { AskUserBatchPrompt } from './AskUserBatchPrompt.js';

import type { PermissionResponse } from '@ema-agent/permission';

// ── Submission state ─────────────────────────────────────────────────────────

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
      setError(await submitDecision(operation, onSuccess));
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  };

  return { submitting, error, run };
}

// ── Prompt router ─────────────────────────────────────────────────────────────

function PromptRouter({
  prompt,
  sessionId,
}: {
  prompt:   DecisionPrompt;
  sessionId: string;
}): JSX.Element {
  const timeoutMs = useSettingsStore((s) => s.permissionTimeoutMs);
  const submission = useDecisionSubmission();

  switch (prompt.kind) {
    case 'permission':
      return (
        <PermissionPrompt
          promptId={prompt.toolCallId}
          prompt={prompt}
          submitting={submission.submitting}
          submissionError={submission.error}
          timeoutMs={timeoutMs ?? undefined}
          onRespond={(response: PermissionResponse) => {
            void submission.run(
              () => turnsApi.respondPermission(prompt.turnId, prompt.toolCallId, response),
              () => useDecisionStore.getState().resolve(sessionId),
            );
          }}
        />
      );

    case 'ask_user':
      return (
        <AskUserBatchPrompt
          questions={prompt.questions}
          humanDescription={prompt.humanDescription}
          submitting={submission.submitting}
          submissionError={submission.error}
          onResolve={(answers) => {
            void submission.run(
              () => turnsApi.respondAskUser(prompt.turnId, prompt.toolCallId, answers),
              () => useDecisionStore.getState().resolve(sessionId),
            );
          }}
          onCancel={() => {
            void submission.run(
              () => turnsApi.cancelAskUser(prompt.turnId, prompt.toolCallId),
              () => useDecisionStore.getState().cancel(sessionId),
            );
          }}
        />
      );

    default:
      return <div>Unknown prompt kind</div>;
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function DecisionLayer(): JSX.Element | null {
  const viewedSessionId = useConversationStore((s) => s.viewedSessionId);
  const serverReady = useServerStore((s) => s.status.kind === 'ok');
  const current = useDecisionStore(
    useShallow((s) => (viewedSessionId ? s.sessions.get(viewedSessionId)?.[0] ?? null : null)),
  );

  useEffect(() => {
    if (!serverReady) return;
    // Permission 与 AskUser 在同一个交互队列里排队；pending 按统一时间线回放，
    // 避免窗口重开后改变同一 Session 的 FIFO 顺序。
    void turnsApi.pendingAskUser()
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
      <PromptRouter key={current.toolCallId} prompt={current} sessionId={viewedSessionId} />
    </div>
  );
}
