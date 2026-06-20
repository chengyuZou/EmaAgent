/**
 * DecisionLayer — global modal router for permission / ask-user prompts.
 *
 * Mount this at the root of EACH sub-window. It reads from decision-store
 * and renders the matching prompt component. Only one prompt at a time.
 */
import { useDecisionStore, type DecisionPrompt } from '../stores/decision-store.js';
import { useSettingsStore } from '../stores/settings-store.js';
import { PermissionPrompt } from './PermissionPrompt.js';
import { AskConfirmPrompt } from './AskConfirmPrompt.js';
import { AskTextPrompt } from './AskTextPrompt.js';
import { AskChoicePrompt } from './AskChoicePrompt.js';
import { AskUserBatchPrompt } from './AskUserBatchPrompt.js';

// ── Prompt router ─────────────────────────────────────────────────────────────

function PromptRouter({ prompt }: { prompt: DecisionPrompt }): JSX.Element {
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
            useDecisionStore.getState().resolve({ decision });
          }}
        />
      );

    case 'ask_confirm':
      return (
        <AskConfirmPrompt
          promptId={prompt.promptId}
          question={prompt.question}
          humanDescription={prompt.humanDescription}
          onResolve={(confirmed) => {
            useDecisionStore.getState().resolve({ kind: 'confirm', confirmed });
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
          onResolve={(text) => {
            useDecisionStore.getState().resolve({ kind: 'text', text });
          }}
          onCancel={() => {
            useDecisionStore.getState().cancel();
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
          onResolve={(answers, customText) => {
            useDecisionStore.getState().resolve({ kind: 'choice', answers, customText });
          }}
          onCancel={() => {
            useDecisionStore.getState().cancel();
          }}
        />
      );

    case 'ask_user':
      return (
        <AskUserBatchPrompt
          promptId={prompt.promptId}
          turnId={prompt.turnId as string}
          questions={prompt.questions}
          humanDescription={prompt.humanDescription}
          onResolve={(answers) => {
            useDecisionStore.getState().resolve({ kind: 'ask_user', answers });
          }}
          onCancel={() => {
            useDecisionStore.getState().cancel();
          }}
        />
      );

    default:
      return <div>Unknown prompt kind</div>;
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function DecisionLayer(): JSX.Element | null {
  const current = useDecisionStore((s) => s.current);

  if (!current) return null;

  return (
    <div className="fixed inset-0 z-9998 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60"
        onClick={() => useDecisionStore.getState().cancel()}
      />
      {/* Modal content */}
      <div className="relative z-10 max-w-lg w-full mx-4">
        <PromptRouter prompt={current} />
      </div>
    </div>
  );
}
