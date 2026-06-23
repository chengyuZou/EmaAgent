import { useState, type CSSProperties } from 'react';
import { Button, Card, Textarea } from '@ema-agent/ui';
import { turnsApi } from '../api/turns.js';
import { HumanDescriptionPanel } from './HumanDescriptionPanel.js';
import type { AskUserQuestionSpec } from '@ema-agent/contracts';

export interface AskUserBatchPromptProps {
  promptId:          string;
  turnId:            string;
  questions:         AskUserQuestionSpec[];
  humanDescription?: string;
  onResolve(answers: Record<string, string>): void;
  onCancel(): void;
}

export function AskUserBatchPrompt({
  promptId,
  turnId,
  questions,
  humanDescription,
  onResolve,
  onCancel,
}: AskUserBatchPromptProps): JSX.Element {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [choiceSelected, setChoiceSelected] = useState<Set<string>>(new Set());

  const current = questions[step];
  const isLast  = step === questions.length - 1;

  if (!current) return <></>;

  const hasOptions = (current.options?.length ?? 0) > 0;
  const canAdvance = hasOptions
    ? choiceSelected.size > 0
    : (answers[current.id] ?? '').trim().length > 0;

  function handleAnswer(value: string): void {
    setAnswers((prev) => ({ ...prev, [current!.id]: value }));
  }

  function toggleChoice(label: string, multi: boolean): void {
    setChoiceSelected((prev) => {
      const next = new Set(prev);
      if (multi) {
        next.has(label) ? next.delete(label) : next.add(label);
      } else {
        next.clear();
        next.add(label);
      }
      handleAnswer([...next].join(', '));
      return next;
    });
  }

  async function handleNext(): Promise<void> {
    if (isLast) {
      try { await turnsApi.respondAskUser(turnId, promptId, answers); } catch { /* sidecar down */ }
      onResolve(answers);
    } else {
      setStep((s) => s + 1);
      setChoiceSelected(new Set());
    }
  }

  return (
    <Card variant="elevated" padding="lg" className="shadow-2xl max-w-lg w-full">
      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-3">
        {questions.map((_, i) => (
          <div
            key={i}
            className={`h-1.5 rounded-full flex-1 transition-colors ema-stagger-in ${
              i <= step ? 'bg-[var(--ema-primary)]' : 'bg-[var(--ema-surface-3)]'
            }`}
            style={{ '--stagger-i': i } as CSSProperties}
          />
        ))}
      </div>

      <HumanDescriptionPanel
        description={humanDescription ?? `问题 ${step + 1}/${questions.length}`}
        toolName=""
        pending={false}
      />

      <p className="text-xs font-medium mb-1" style={{ color: 'var(--ema-primary)' }}>{current.header}</p>
      <p className="text-base mb-4" style={{ color: 'var(--ema-text-primary)' }}>{current.question}</p>

      {hasOptions ? (
        <div className="flex flex-col gap-2 mb-4">
          {current.options!.map((opt, i) => (
            <button
              key={opt.label}
              className={`px-4 py-2.5 rounded-md text-left transition-colors border ema-stagger-in ${
                choiceSelected.has(opt.label)
                  ? 'bg-[var(--ema-primary-muted)] text-[var(--ema-primary)] border-[var(--ema-primary)]'
                  : 'bg-[var(--ema-surface-2)] text-[var(--ema-text-secondary)] border-[var(--ema-border)] hover:bg-[var(--ema-surface-3)]'
              }`}
              style={{ '--stagger-i': i } as CSSProperties}
              onClick={() => toggleChoice(opt.label, current.multiSelect ?? false)}
            >
              <p className="font-medium text-sm">{opt.label}</p>
              {opt.description && (
                <p className="text-xs mt-0.5" style={{ color: 'var(--ema-text-tertiary)' }}>{opt.description}</p>
              )}
            </button>
          ))}
        </div>
      ) : (
        <Textarea
          className="mb-4"
          minRows={3}
          maxRows={6}
          placeholder="输入你的回答…"
          value={answers[current.id] ?? ''}
          onChange={(e) => handleAnswer(e.target.value)}
        />
      )}

      <div className="flex gap-3 justify-end">
        <Button variant="secondary" size="sm" onClick={onCancel}>取消</Button>
        <Button variant="primary" size="sm" disabled={!canAdvance} onClick={handleNext}>
          {isLast ? '提交' : '下一步'}
        </Button>
      </div>
    </Card>
  );
}
