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
import { useSidecarStore } from '../stores/sidecar-store.js';
import { useSettingsStore } from '../stores/settings-store.js';
import { turnsApi } from '../api/turns.js';
import { permissionApi } from '../api/permission.js';
import { submitDecision } from './decision-submission.js';
import { PermissionPrompt } from './PermissionPrompt.js';
import { AskConfirmPrompt } from './AskConfirmPrompt.js';
import { AskTextPrompt } from './AskTextPrompt.js';
import { AskChoicePrompt } from './AskChoicePrompt.js';
import { AskUserBatchPrompt } from './AskUserBatchPrompt.js';
import type { SessionId } from '@ema-agent/ids';
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
  sessionId: SessionId;
}): JSX.Element {
  const timeoutMs = useSettingsStore((s) => s.permissionTimeoutMs);
  const submission = useDecisionSubmission();

  switch (prompt.kind) {
    case 'permission':
      return (
        <PermissionPrompt
          promptId={prompt.promptId}
          prompt={prompt}
          submitting={submission.submitting}
          submissionError={submission.error}
          timeoutMs={timeoutMs}
          onRespond={(response: PermissionResponse) => {
            void submission.run(
              () => permissionApi.respond(prompt.turnId, prompt.promptId, response),
              () => useDecisionStore.getState().resolve(sessionId),
            );
          }}
        />
      );

    case 'ask_confirm':
      return (
        <AskConfirmPrompt
          promptId={prompt.promptId}
          question={prompt.question}
          humanDescription={prompt.humanDescription}
          submitting={submission.submitting}
          submissionError={submission.error}
          onResolve={(confirmed) => {
            void submission.run(
              () => turnsApi.respondAskUser(prompt.turnId, prompt.promptId, { confirmed: String(confirmed) }),
              () => useDecisionStore.getState().resolve(sessionId),
            );
          }}
          onCancel={() => {
            void submission.run(
              () => turnsApi.cancelAskUser(prompt.turnId, prompt.promptId),
              () => useDecisionStore.getState().cancel(sessionId),
            );
          }}
        />
      );

    case 'ask_text':
      return (
        <AskTextPrompt
          promptId={prompt.promptId}
          question={prompt.question}
          humanDescription={prompt.humanDescription}
          placeholder={prompt.placeholder}
          submitting={submission.submitting}
          submissionError={submission.error}
          onResolve={(text) => {
            void submission.run(
              () => turnsApi.respondAskUser(prompt.turnId, prompt.promptId, { text }),
              () => useDecisionStore.getState().resolve(sessionId),
            );
          }}
          onCancel={() => {
            void submission.run(
              () => turnsApi.cancelAskUser(prompt.turnId, prompt.promptId),
              () => useDecisionStore.getState().cancel(sessionId),
            );
          }}
        />
      );

    case 'ask_choice':
      return (
        <AskChoicePrompt
          promptId={prompt.promptId}
          question={prompt.question}
          humanDescription={prompt.humanDescription}
          options={prompt.options}
          multiSelect={prompt.multiSelect}
          allowCustom={prompt.allowCustom}
          submitting={submission.submitting}
          submissionError={submission.error}
          onResolve={(answers, customText) => {
            void submission.run(
              () => turnsApi.respondAskUser(prompt.turnId, prompt.promptId, {
                selected: answers.join(','),
                ...(customText ? { custom: customText } : {}),
              }),
              () => useDecisionStore.getState().resolve(sessionId),
            );
          }}
          onCancel={() => {
            void submission.run(
              () => turnsApi.cancelAskUser(prompt.turnId, prompt.promptId),
              () => useDecisionStore.getState().cancel(sessionId),
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
              () => turnsApi.respondAskUser(prompt.turnId, prompt.promptId, answers),
              () => useDecisionStore.getState().resolve(sessionId),
            );
          }}
          onCancel={() => {
            void submission.run(
              () => turnsApi.cancelAskUser(prompt.turnId, prompt.promptId),
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
  const sidecarReady = useSidecarStore((s) => s.status.kind === 'ok');
  const current = useDecisionStore(
    useShallow((s) => (viewedSessionId ? s.sessions.get(viewedSessionId)?.[0] ?? null : null)),
  );

  useEffect(() => {
    if (!sidecarReady) return;
    void Promise.all([permissionApi.pending(), turnsApi.pendingAskUser()])
      .then(([permissionResult, askUserResult]) => {
        const pending = [
          ...permissionResult.prompts.map((prompt) => ({ kind: 'permission' as const, createdAt: prompt.createdAt, prompt })),
          ...askUserResult.prompts.map((prompt) => ({ kind: 'ask_user' as const, createdAt: prompt.createdAt, prompt })),
        ].sort((left, right) => left.createdAt - right.createdAt);

        // 两类 Registry 的快照按统一时间线回放，避免窗口重开后改变同一 Session 的 FIFO 顺序。
        for (const item of pending) {
          if (item.kind === 'permission') {
            useDecisionStore.getState().restorePermissions([item.prompt]);
          } else {
            useDecisionStore.getState().restoreAskUser([item.prompt]);
          }
        }
      })
      .catch(() => {
        // Sidecar 健康轮询下一次进入 ok 时会再次尝试。
      });
  }, [sidecarReady]);

  if (!current || !viewedSessionId) return null;

  return (
    <div className="mb-2 w-full ema-slide-up">
      <PromptRouter key={current.promptId} prompt={current} sessionId={viewedSessionId} />
    </div>
  );
}
