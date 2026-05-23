/**
 * AskUserBatchPrompt — multi-question wizard that shows one question at a time.
 *
 * When the LLM calls ask_user with 2-4 questions, this component steps through
 * them sequentially, collecting answers, then resolves once at the end.
 */
import { useState } from 'react';
import { HumanDescriptionPanel } from './HumanDescriptionPanel.js';

export interface AskUserBatchPromptProps {
  promptId:          string;
  questions:         Array<{
    question:    string;
    header:      string;
    options?:    Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
  humanDescription?: string;
  onResolve(answers: Record<string, string>): void;
  onCancel(): void;
}

export function AskUserBatchPrompt({ questions, humanDescription, onResolve, onCancel }: AskUserBatchPromptProps): JSX.Element {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const current = questions[step];
  const isLast = step === questions.length - 1;

  function handleAnswer(value: string): void {
    setAnswers((prev) => ({ ...prev, [current!.header]: value }));
  }

  function handleNext(): void {
    if (isLast) {
      onResolve(answers);
    } else {
      setStep((s) => s + 1);
      setChoiceSelected(new Set());
    }
  }

  // ── Choice state (per step) ──────────────────────────────────────────────
  const [choiceSelected, setChoiceSelected] = useState<Set<string>>(new Set());

  function toggleChoice(label: string, multi: boolean): void {
    setChoiceSelected((prev) => {
      const next = new Set(prev);
      if (multi) {
        next.has(label) ? next.delete(label) : next.add(label);
      } else {
        next.clear();
        next.add(label);
      }
      // Update answers
      const joined = [...next].join(', ');
      handleAnswer(joined);
      return next;
    });
  }

  if (!current) return <></>;

  const hasOptions = current.options && current.options.length > 0;
  const canAdvance = hasOptions
    ? choiceSelected.size > 0
    : (answers[current.header] ?? '').trim().length > 0;

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 shadow-2xl max-w-lg">
      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-3">
        {questions.map((_, i) => (
          <div
            key={i}
            className={`h-1.5 rounded-full flex-1 transition-colors ${
              i < step ? 'bg-pink-400' : i === step ? 'bg-pink-400/60' : 'bg-gray-700'
            }`}
          />
        ))}
      </div>

      <HumanDescriptionPanel
        description={humanDescription ?? `问题 ${step + 1}/${questions.length}`}
        toolName=""
        pending={false}
      />

      {/* Question header */}
      <div className="text-xs text-pink-300 font-medium mb-1">{current.header}</div>
      <p className="text-gray-200 text-base mb-4">{current.question}</p>

      {/* Options (choice) */}
      {hasOptions && (
        <div className="flex flex-col gap-2 mb-4">
          {current.options!.map((opt) => (
            <button
              key={opt.label}
              className={`px-4 py-2.5 rounded-xl text-left transition-colors ${
                choiceSelected.has(opt.label)
                  ? 'bg-pink-400/20 text-pink-300 border border-pink-400/40'
                  : 'bg-gray-800 text-gray-300 border border-gray-600 hover:bg-gray-700'
              }`}
              onClick={() => toggleChoice(opt.label, current.multiSelect ?? false)}
            >
              <div className="font-medium text-sm">{opt.label}</div>
              {opt.description && (
                <div className="text-xs text-gray-500 mt-0.5">{opt.description}</div>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Free text input */}
      {!hasOptions && (
        <textarea
          className="w-full bg-gray-800 border border-gray-600 rounded-xl p-3 text-sm text-gray-200 resize-none focus:outline-none focus:border-pink-400/50 mb-4"
          rows={3}
          placeholder="输入你的回答…"
          value={answers[current.header] ?? ''}
          onChange={(e) => handleAnswer(e.target.value)}
        />
      )}

      {/* Actions */}
      <div className="flex gap-3 justify-end">
        <button
          className="px-4 py-2 rounded-xl bg-gray-700 text-gray-300 text-sm hover:bg-gray-600 transition-colors"
          onClick={onCancel}
        >
          取消
        </button>
        <button
          className="px-4 py-2 rounded-xl bg-pink-400/20 text-pink-300 text-sm hover:bg-pink-400/30 transition-colors disabled:opacity-50"
          disabled={!canAdvance}
          onClick={handleNext}
        >
          {isLast ? '提交' : '下一步'}
        </button>
      </div>
    </div>
  );
}
