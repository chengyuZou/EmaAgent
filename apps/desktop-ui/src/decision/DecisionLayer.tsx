/**
 * DecisionLayer — modal router for the active session's permission / ask-user
 * prompts.
 *
 * Mount this in the CHAT sub-window. It reads `viewedSessionId` from
 * conversation-store and renders that session's queue head. Other sessions'
 * prompts stay queued (surfaced via sidebar badges) without interrupting the
 * session the user is currently viewing. The pet window does NOT mount this
 * (it has no viewedSessionId) — it only shows non-blocking toasts via
 * PermissionToastLayer.
 */
import { useShallow } from 'zustand/react/shallow';
import { useDecisionStore, type DecisionPrompt } from '../stores/decision-store.js';
import { useConversationStore } from '../stores/conversation-store.js';
import { useSettingsStore } from '../stores/settings-store.js';
import { turnsApi } from '../api/turns.js';
import { PermissionPrompt } from './PermissionPrompt.js';
import { AskConfirmPrompt } from './AskConfirmPrompt.js';
import { AskTextPrompt } from './AskTextPrompt.js';
import { AskChoicePrompt } from './AskChoicePrompt.js';
import { AskUserBatchPrompt } from './AskUserBatchPrompt.js';
import type { SessionId } from '@ema-agent/contracts';

// ── Prompt router ─────────────────────────────────────────────────────────────

function PromptRouter({
  prompt,
  sessionId,
}: {
  prompt:   DecisionPrompt;
  sessionId: SessionId;
}): JSX.Element {
  const timeoutMs = useSettingsStore((s) => s.permissionTimeoutMs);

  switch (prompt.kind) {
    case 'permission':
      return (
        <PermissionPrompt
          promptId={prompt.promptId}
          toolName={prompt.toolName}
          args={prompt.args}
          hint={prompt.hint}
          humanDescription={prompt.humanDescription}
          humanDescriptionPending={prompt.humanDescriptionPending}
          timeoutMs={timeoutMs}
          onResolve={(decision) => {
            useDecisionStore.getState().resolve(sessionId, { decision });
          }}
        />
      );

    case 'ask_confirm':
      return (
        <AskConfirmPrompt
          promptId={prompt.promptId}
          question={prompt.question}
          humanDescription={prompt.humanDescription}
          onResolve={async (confirmed) => {
            await turnsApi.respondAskUser(prompt.turnId, prompt.promptId, { confirmed: String(confirmed) }).catch(() => {});
            useDecisionStore.getState().resolve(sessionId, { kind: 'confirm', confirmed });
          }}
          onCancel={async () => {
            await turnsApi.respondAskUser(prompt.turnId, prompt.promptId, { confirmed: 'false' }).catch(() => {});
            useDecisionStore.getState().cancel(sessionId);
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
          onResolve={async (text) => {
            await turnsApi.respondAskUser(prompt.turnId, prompt.promptId, { text }).catch(() => {});
            useDecisionStore.getState().resolve(sessionId, { kind: 'text', text });
          }}
          onCancel={async () => {
            await turnsApi.respondAskUser(prompt.turnId, prompt.promptId, { text: '' }).catch(() => {});
            useDecisionStore.getState().cancel(sessionId);
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
          onResolve={async (answers, customText) => {
            await turnsApi.respondAskUser(prompt.turnId, prompt.promptId, {
              selected: answers.join(','),
              ...(customText ? { custom: customText } : {}),
            }).catch(() => {});
            useDecisionStore.getState().resolve(sessionId, { kind: 'choice', answers, customText });
          }}
          onCancel={async () => {
            await turnsApi.respondAskUser(prompt.turnId, prompt.promptId, { selected: '' }).catch(() => {});
            useDecisionStore.getState().cancel(sessionId);
          }}
        />
      );

    case 'ask_user':
      return (
        <AskUserBatchPrompt
          questions={prompt.questions}
          humanDescription={prompt.humanDescription}
          onResolve={async (answers) => {
            // Send answers to the backend so AskUserRegistry resolves — without
            // this the agent tool awaits forever (until 120s timeout) and the
            // turn hangs. Matches ask_confirm/text/choice which all call respond.
            await turnsApi.respondAskUser(prompt.turnId, prompt.promptId, answers).catch(() => {});
            useDecisionStore.getState().resolve(sessionId, { kind: 'ask_user', answers });
          }}
          onCancel={async () => {
            // Send an empty response so the backend resolves immediately
            // instead of waiting 120s for the timeout. Without this the user's
            // cancel intent never reaches the agent.
            await turnsApi.respondAskUser(prompt.turnId, prompt.promptId, {}).catch(() => {});
            useDecisionStore.getState().cancel(sessionId);
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
  const current = useDecisionStore(
    useShallow((s) => (viewedSessionId ? s.sessions.get(viewedSessionId)?.[0] ?? null : null)),
  );

  if (!current || !viewedSessionId) return null;

  // Permission prompts must not be silently dismissed via backdrop — the
  // backend agent is waiting for a response. Clicking away sends an explicit
  // deny so the agent can unblock. The ask_user (batch) prompt likewise needs
  // an explicit empty response — otherwise the AskUserRegistry awaits the
  // 120s timeout and the turn appears frozen.
  const handleBackdrop = (): void => {
    if (current.kind === 'permission') {
      void import('../api/permission.js').then(({ permissionApi }) =>
        permissionApi.respond(current.promptId, { action: 'deny' }).catch(() => {}),
      );
    } else if (current.kind === 'ask_user') {
      void turnsApi.respondAskUser(current.turnId, current.promptId, {}).catch(() => {});
    }
    useDecisionStore.getState().cancel(viewedSessionId);
  };

  return (
    <div className="fixed inset-0 z-9998 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0" style={{ background: 'var(--ema-mask)' }} onClick={handleBackdrop} />
      {/* Modal content — ema-scale-in entrance */}
      <div className="relative z-10 max-w-lg w-full mx-4 ema-scale-in">
        <PromptRouter prompt={current} sessionId={viewedSessionId} />
      </div>
    </div>
  );
}
