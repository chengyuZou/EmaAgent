import { useState } from 'react';
import { Button, Card, Textarea } from '@ema-agent/ui';
import { DecisionSubmissionFeedback, HumanDescriptionPanel } from './HumanDescriptionPanel.js';

export interface AskTextPromptProps {
  promptId:          string;
  question:          string;
  humanDescription?: string;
  placeholder?:      string;
  submitting:         boolean;
  submissionError?:   string;
  onResolve(text: string): void;
  onCancel(): void;
}

export function AskTextPrompt({ question, humanDescription, placeholder, submitting, submissionError, onResolve, onCancel }: AskTextPromptProps): JSX.Element {
  const [text, setText] = useState('');

  return (
    <Card variant="elevated" padding="lg" className="shadow-[var(--ema-shadow-3)] max-w-lg w-full">
      <HumanDescriptionPanel description={humanDescription ?? question} toolName="" pending={false} />
      {humanDescription && (
        <p className="mt-1 mb-3 text-sm text-[var(--ema-text-secondary)]">{question}</p>
      )}
      <Textarea
        className="mt-2"
        minRows={4}
        maxRows={8}
        placeholder={placeholder ?? '输入…'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
      />
      <div className="flex gap-3 mt-4 justify-end">
        <Button variant="ghost" size="sm" disabled={submitting} onClick={onCancel}>取消</Button>
        <Button variant="primary" size="sm" disabled={submitting || !text.trim()} onClick={() => onResolve(text.trim())}>
          提交
        </Button>
      </div>
      <DecisionSubmissionFeedback submitting={submitting} error={submissionError} />
    </Card>
  );
}
